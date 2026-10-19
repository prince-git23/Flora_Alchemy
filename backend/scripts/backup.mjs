/**
 * backup — scheduled recovery points, verification and restore drills.
 *
 * WHY THIS EXISTS
 * ---------------
 * October 2026 had exactly one recoverable export, five days older than the
 * incident, and nothing that would have noticed production had emptied. The
 * recovery tool (`scripts/recovery.mjs`) makes a restore repeatable, but a
 * restore is only possible if a recent, verified, OFF-HOST backup exists.
 *
 * This tool supplies that missing half and deliberately does NOT replace the
 * recovery tool: production restores still go through `recovery.mjs` with its
 * confirmation gate. Here, writes are limited to
 *
 *   · a NEW artifact directory (never an existing one),
 *   · a DISPOSABLE drill database, verified by name and dropped afterwards,
 *   · retention deletion of artifacts this tool created.
 *
 * Usage (from backend/):
 *   node scripts/backup.mjs --export [--source-db=Flora-Alchemy] [--encrypt]
 *   node scripts/backup.mjs --verify [--artifact=<dir>]
 *   node scripts/backup.mjs --status [--source-db=Flora-Alchemy] [--json] [--notify]
 *   node scripts/backup.mjs --accept-baseline [--source-db=Flora-Alchemy]
 *   node scripts/backup.mjs --restore-drill --target=Flora-Alchemy-Test-Drill [--reset-drill]
 *   node scripts/backup.mjs --decrypt --artifact=<dir> --out=<dir>
 *   node scripts/backup.mjs --prune [--keep=14] [--apply]
 *   node scripts/backup.mjs --upload [--artifact=<dir>] [--dry-run]
 *   node scripts/backup.mjs --export --encrypt --upload [--dry-run]
 *
 * Exit codes: 0 healthy/success, 2 warning, 1 critical/failure, 3 unknown
 * (a check could not run — never reported as success).
 *
 * Nothing here prints credentials, password hashes or document contents.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import {
  loadBackendEnv,
  testMongoUri,
  bootTestServer,
  stopTestServer,
  portInUse,
} from './lib/testServer.mjs';
import { dbNameFromUri, isDisposableDbName, protectedDbNames } from '../utils/environmentGuard.js';
import {
  BACKUP_FORMAT,
  MANIFEST_FILE,
  CHECKSUMS_FILE,
  ARCHIVE_FILE,
  COMPLETE_FILE,
  ENCRYPTION_MODE,
  encodeCollection,
  decodeCollection,
  sha256,
  encryptBuffer,
  newestDocumentTimestamp,
  verifyArtifact,
  listArtifacts,
  selectPrunable,
  evaluateIntegrity,
  evaluateFreshness,
  summarize,
  EXIT_FOR_STATUS,
  DEFAULT_MAX_BACKUP_AGE_HOURS,
  DEFAULT_MAX_DROP_PCT,
  DEFAULT_MIN_DROP_DOCS,
  DEFAULT_RETENTION_COUNT,
  DEFAULT_DRILL_MAX_AGE_DAYS,
} from './lib/backupArchive.mjs';

loadBackendEnv();

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROD_DB = 'Flora-Alchemy';
const BACKUP_ROOT = path.resolve(process.env.BACKUP_ROOT || path.join(os.homedir(), 'flora-alchemy-backups'));
const STATE_ROOT = path.resolve(process.env.BACKUP_STATE_ROOT || path.join(BACKUP_ROOT, 'state'));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

const say = (m = '') => console.log(m);
const die = (message, code = 1) => {
  console.error(`\n✘ ${message}`);
  process.exit(code);
};

const passphrase = () => process.env.BACKUP_ENCRYPTION_KEY || '';
const thresholds = {
  maxAgeHours: Number(process.env.BACKUP_MAX_AGE_HOURS || DEFAULT_MAX_BACKUP_AGE_HOURS),
  maxDropPct: Number(process.env.BACKUP_MAX_DROP_PCT || DEFAULT_MAX_DROP_PCT),
  minDropDocs: Number(process.env.BACKUP_MIN_DROP_DOCS || DEFAULT_MIN_DROP_DOCS),
  drillMaxAgeDays: Number(process.env.BACKUP_DRILL_MAX_AGE_DAYS || DEFAULT_DRILL_MAX_AGE_DAYS),
  runIntervalHours: Number(process.env.BACKUP_RUN_INTERVAL_HOURS || 26),
};

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function sourceTarget() {
  const uri = process.env.MONGO_URI;
  if (!uri) die('MONGO_URI is not configured (backend/.env or the environment).');
  const configured = dbNameFromUri(uri);
  const dbName = value('source-db') || configured;
  if (!dbName) die('the source database could not be determined; pass --source-db=<name>');
  return { uri, configured, dbName };
}

async function connect(uri, appName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20_000, appName });
  await client.connect();
  return client;
}

function latestDrillReceipt() {
  const dir = path.join(STATE_ROOT, 'drills');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;
  return readJson(path.join(dir, files[files.length - 1]), null);
}

/** Directory mtime, used to compare an incomplete attempt with a verified one. */
function mtimeOf(dir) {
  try {
    return fs.statSync(dir).mtime.toISOString();
  } catch {
    return null;
  }
}

// ── export ─────────────────────────────────────────────────────────────────

async function exportArtifact() {
  const { uri, dbName } = sourceTarget();
  const encrypted = flag('encrypt') || Boolean(passphrase());
  if (flag('encrypt') && !passphrase()) {
    die('--encrypt needs BACKUP_ENCRYPTION_KEY (at least 16 characters). Never put the key in the artifact or the repository.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = value('out')
    ? path.resolve(value('out'))
    : path.join(BACKUP_ROOT, `flora-backup-${stamp}`);
  if (fs.existsSync(dest)) die(`refusing to overwrite an existing artifact: ${dest}`);
  const partial = `${dest}.partial-${process.pid}`;
  fs.mkdirSync(partial, { recursive: true });

  const startedAt = new Date().toISOString();
  let client;
  try {
    client = await connect(uri, 'flora-backup-export');
    const db = client.db(dbName);
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.'))
      .sort();
    if (!names.length) throw new Error(`source database "${dbName}" has no collections — refusing to write an empty recovery point`);

    const collections = {};
    const inventory = {};
    const files = {};
    let total = 0;
    let newest = null;
    for (const name of names) {
      const col = db.collection(name);
      const docs = await col.find({}).sort({ _id: 1 }).toArray();
      const payload = encodeCollection(docs);
      const buf = Buffer.from(payload, 'utf8');
      files[`${name}.ejson`] = payload;
      const indexes = (await col.indexes()).map((i) => ({
        name: i.name,
        key: i.key,
        unique: i.unique === true,
        sparse: i.sparse === true,
        ...(i.partialFilterExpression ? { partialFilterExpression: i.partialFilterExpression } : {}),
        ...(i.weights ? { textFields: Object.keys(i.weights) } : {}),
      }));
      collections[name] = { documents: docs.length, bytes: buf.length, sha256: sha256(buf) };
      inventory[name] = { documents: docs.length, indexes };
      total += docs.length;
      const t = newestDocumentTimestamp(docs);
      if (t && (!newest || t > newest)) newest = t;
    }

    const manifest = {
      format: BACKUP_FORMAT,
      tool: 'scripts/backup.mjs',
      schemaVersion: 1,
      createdAt: startedAt,
      database: dbName,
      clusterHost: (() => {
        try {
          return new URL(uri).hostname;
        } catch {
          return '';
        }
      })(),
      totalDocuments: total,
      documents: total,
      newestDocumentAt: newest ? newest.toISOString() : null,
      collections,
      inventory,
      encryption: { mode: 'none' },
    };

    const sums = [];
    if (encrypted) {
      const archivePayload = Buffer.from(
        JSON.stringify({ format: BACKUP_FORMAT, database: dbName, createdAt: startedAt, files }),
        'utf8'
      );
      const sealed = encryptBuffer(zlib.gzipSync(archivePayload), passphrase());
      const archiveBuf = sealed.buffer;
      fs.writeFileSync(path.join(partial, ARCHIVE_FILE), archiveBuf);
      manifest.encryption = { mode: sealed.algorithm, kdf: sealed.kdf };
      manifest.archiveSha256 = sha256(archiveBuf);
      sums.push(`${manifest.archiveSha256}  ${ARCHIVE_FILE}`);
    } else {
      for (const [name, payload] of Object.entries(files)) {
        fs.writeFileSync(path.join(partial, name), payload, 'utf8');
        sums.push(`${collections[name.replace(/\.ejson$/, '')].sha256}  ${name}`);
      }
    }

    fs.writeFileSync(path.join(partial, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(partial, CHECKSUMS_FILE), sums.join('\n') + '\n', 'utf8');
    fs.writeFileSync(
      path.join(partial, COMPLETE_FILE),
      JSON.stringify(
        { completedAt: new Date().toISOString(), mode: encrypted ? ENCRYPTION_MODE : 'none', files: sums.length },
        null,
        2
      ),
      'utf8'
    );

    fs.renameSync(partial, dest);
    writeJsonAtomic(path.join(STATE_ROOT, 'last-export.json'), {
      artifact: dest,
      name: path.basename(dest),
      createdAt: startedAt,
      completedAt: new Date().toISOString(),
      database: dbName,
      documents: total,
      collections: names.length,
      encrypted,
      archiveSha256: manifest.archiveSha256 || null,
    });
    say(`backup written: ${dest}`);
    say(`  ${names.length} collections · ${total} documents · ${encrypted ? 'AES-256-GCM encrypted' : 'PLAINTEXT (local only)'}`);
    say('  verify it before trusting it: node scripts/backup.mjs --verify --artifact=<dir>');

    if (flag('upload')) uploadArtifact(dest, manifest);
    process.exit(0);
  } catch (err) {
    // Only the directory this run created is removed; an existing artifact is
    // never touched. A leftover partial is still ignored by --status.
    fs.rmSync(partial, { recursive: true, force: true });
    die(`export failed: ${err.codeName || err.name || 'error'}: ${err.message}`);
  } finally {
    await client?.close().catch(() => {});
  }
}

// ── upload (off-host durability) ───────────────────────────────────────────

function awsRun(args, { dryRun = false, quiet = false } = {}) {
  const fake = process.env.BACKUP_AWS_BIN;
  const cmd = fake ? process.execPath : 'aws';
  const prefix = fake ? [fake] : [];
  if (dryRun) {
    say(`  [dry-run] ${cmd} ${[...prefix, ...args].join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const env = { ...process.env };
  if (!env.AWS_DEFAULT_REGION && process.env.BACKUP_S3_REGION) env.AWS_DEFAULT_REGION = process.env.BACKUP_S3_REGION;
  const r = spawnSync(cmd, [...prefix, ...args], {
    cwd: BACKEND_DIR,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (!quiet && r.status !== 0) say(`  ✘ aws exited ${r.status}: ${(r.stderr || '').trim().slice(0, 800)}`);
  return r;
}

/**
 * Upload an ENCRYPTED artifact with the AWS CLI (works with S3 and R2's
 * S3-compatible API). No npm SDK: the CLI is a documented prerequisite, and it
 * reads credentials from its own environment, so nothing secret is ever passed
 * on the command line or printed.
 */
function uploadArtifact(dir, manifest) {
  if (!manifest || manifest.encryption?.mode !== ENCRYPTION_MODE) {
    die('refusing to upload an unencrypted backup — re-run --export --encrypt');
  }
  const bucket = process.env.BACKUP_S3_BUCKET;
  if (!bucket) die('BACKUP_S3_BUCKET is not configured; set it (and the BUCKET_* credentials) before --upload');
  const prefix = (process.env.BACKUP_S3_PREFIX || 'flora-alchemy').replace(/^\/+|\/+$/g, '');
  const endpoint = process.env.BACKUP_S3_ENDPOINT || '';
  const base = [`s3://${bucket}/${prefix}/${path.basename(dir)}`];
  const files = [MANIFEST_FILE, CHECKSUMS_FILE, ARCHIVE_FILE, COMPLETE_FILE];
  const common = endpoint ? ['--endpoint-url', endpoint] : [];
  const dryRun = flag('dry-run');

  for (const file of files) {
    const local = path.join(dir, file);
    if (!fs.existsSync(local)) die(`artifact is missing ${file}`);
    const r = awsRun(['s3', 'cp', local, `${base[0]}/${file}`, '--only-show-errors', ...common], { dryRun });
    if (r.status !== 0) die(`upload failed for ${file}`);
  }

  const receipt = {
    format: BACKUP_FORMAT,
    artifact: path.basename(dir),
    createdAt: manifest.createdAt,
    uploadedAt: new Date().toISOString(),
    database: manifest.database,
    documents: manifest.documents,
    archiveSha256: manifest.archiveSha256,
    encryption: manifest.encryption.mode,
  };
  const receiptFile = path.join(STATE_ROOT, 'last-upload.json');
  if (!dryRun) writeJsonAtomic(receiptFile, receipt);
  const r = awsRun(
    ['s3', 'cp', receiptFile, `s3://${bucket}/${prefix}/state/last-backup.json`, '--only-show-errors', ...common],
    { dryRun }
  );
  if (r.status !== 0) die('upload failed for the latest-backup receipt');
  if (dryRun) say('  [dry-run] nothing was uploaded and no remote receipt changed.');
  else say(`  uploaded to s3://${bucket}/${prefix}/${path.basename(dir)}/ (encrypted at rest)`);
}

// ── verify ─────────────────────────────────────────────────────────────────

function chooseArtifact(explicit) {
  if (explicit) return path.resolve(explicit);
  const artifacts = listArtifacts(BACKUP_ROOT);
  const complete = artifacts.find((a) => a.complete);
  if (!complete) die(`no completed artifact under ${BACKUP_ROOT} — create one with --export`);
  return complete.path;
}

function verifyCommand() {
  const dir = chooseArtifact(value('artifact'));
  const result = verifyArtifact(dir, {
    passphrase: passphrase(),
    requireEncryption: flag('require-encryption'),
  });
  const m = result.manifest;
  say(`artifact: ${dir}`);
  if (m) {
    say(`  database          ${m.database}`);
    say(`  recovery point    ${m.createdAt}`);
    say(
      `  contents          ${Object.keys(m.collections || {}).length} collections · ` +
        `${m.documents ?? '?'} documents · ${result.encrypted ? 'encrypted' : 'plaintext'}`
    );
  }
  for (const n of result.notes) say(`  · ${n}`);
  for (const p of result.problems) say(`  ✘ ${p}`);
  if (!result.ok) {
    say('\nNOT VERIFIED — this artifact must not be trusted as a recovery point.');
    process.exit(1);
  }
  say('\nVERIFIED: checksums, completion marker and per-collection counts match.');
  process.exit(0);
}

// ── status / integrity monitoring ──────────────────────────────────────────

async function readLiveState(uri, dbName) {
  const client = await connect(uri, 'flora-backup-status');
  try {
    const db = client.db(dbName);
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.'));
    if (!names.length) throw new Error(`database "${dbName}" has no collections`);
    const counts = {};
    for (const name of names) counts[name] = await db.collection(name).countDocuments({});
    const ownerDocs = await db
      .collection('users')
      .find({ role: 'admin', isOwner: true }, { projection: { status: 1, passwordHash: 1 } })
      .toArray();
    const owner = {
      count: ownerDocs.length,
      active: ownerDocs.length === 1 && ownerDocs[0].status === 'ACTIVE',
      hashPresent: ownerDocs.length === 1 && Boolean(ownerDocs[0].passwordHash),
      fixtureUsers: await db.collection('users').countDocuments({ isFixture: true }),
    };
    const visibleProducts =
      counts.products > 0
        ? await db.collection('products').countDocuments({ visibility: { $ne: 'Hidden' } })
        : 0;
    const indexes = {};
    for (const coll of ['users', 'products', 'orders', 'settings', 'collections', 'inventories']) {
      if (!names.includes(coll)) continue;
      indexes[coll] = (await db.collection(coll).indexes()).map((i) => ({
        name: i.name,
        key: i.key,
        unique: i.unique === true,
      }));
    }

    // Referential integrity on the two relationships whose breakage would be
    // silent: an order whose customer no longer exists, and stock/inventory
    // rows pointing at a product that no longer exists.
    const referenceChecks = [];
    if (counts.orders != null && counts.customers != null) {
      const [orderCustomerIds, customerIds] = await Promise.all([
        db.collection('orders').distinct('customerId'),
        db.collection('customers').distinct('_id'),
      ]);
      const known = new Set(customerIds.map(String));
      const dangling = orderCustomerIds.filter((id) => id && !known.has(String(id))).length;
      referenceChecks.push(
        dangling
          ? { id: 'references.orders', status: 'warning', detail: `${dangling} order(s) reference a missing customer` }
          : { id: 'references.orders', status: 'pass', detail: 'every order references an existing customer' }
      );
    }
    if (counts.inventories != null && counts.products != null) {
      const [stockSlugs, productSlugs] = await Promise.all([
        db.collection('inventories').distinct('productSlug'),
        db.collection('products').distinct('slug'),
      ]);
      const known = new Set(productSlugs.map(String));
      const orphans = stockSlugs.filter((s) => s && !known.has(String(s))).length;
      referenceChecks.push(
        orphans
          ? { id: 'references.inventory', status: 'warning', detail: `${orphans} inventory row(s) reference a missing product` }
          : { id: 'references.inventory', status: 'pass', detail: 'every inventory row references an existing product' }
      );
    }
    return { counts, owner, visibleProducts, indexes, referenceChecks, collections: names.length };
  } finally {
    await client.close().catch(() => {});
  }
}

async function notify(status, checks, { recoveryPoint = null } = {}) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return { ok: true, skipped: true, reason: 'ALERT_WEBHOOK_URL is not configured' };
  const failing = checks.filter((c) => c.status === 'critical' || c.status === 'warning' || c.status === 'unknown');
  const fingerprint = sha256(`${status}|${failing.map((c) => `${c.id}:${c.status}`).sort().join(',')}`).slice(0, 16);
  const stateFile = path.join(STATE_ROOT, 'alerts.json');
  const state = readJson(stateFile, {}) || {};
  const cooldownHours = Number(process.env.ALERT_COOLDOWN_HOURS || 6);
  const last = state[fingerprint] ? new Date(state[fingerprint]) : null;
  if (last && Date.now() - last.getTime() < cooldownHours * 3_600_000) {
    return { ok: true, deduped: true, reason: `same failure alerted ${Math.round((Date.now() - last.getTime()) / 60_000)}m ago` };
  }
  const payload = {
    source: 'flora-alchemy',
    status,
    at: new Date().toISOString(),
    runbook:
      process.env.ALERT_RUNBOOK_URL ||
      'https://github.com/prince-git23/Flora_Alchemy/blob/main/docs/BACKUP_AND_INTEGRITY.md',
    failures: failing.map(({ id, status: s, detail }) => ({ id, status: s, detail })),
    backup: { recoveryPoint },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.ALERT_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.ALERT_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: `webhook answered HTTP ${res.status}` };
    state[fingerprint] = new Date().toISOString();
    writeJsonAtomic(stateFile, state);
    return { ok: true, sent: true };
  } catch (err) {
    return { ok: false, reason: `webhook delivery failed: ${err.name || 'error'}` };
  }
}

async function statusCommand() {
  const { uri, dbName } = sourceTarget();
  const artifacts = listArtifacts(BACKUP_ROOT);
  const complete = artifacts.filter((a) => a.complete && String(a.format || '').startsWith('flora-backup/'));

  let latestVerified = null;
  const verificationFailures = [];
  for (const artifact of complete.slice(0, 3)) {
    const result = verifyArtifact(artifact.path, { passphrase: passphrase() });
    if (result.ok) {
      latestVerified = { ...artifact, manifest: result.manifest };
      break;
    }
    verificationFailures.push({ name: artifact.name, problems: result.problems });
  }
  const newestComplete = complete[0] || null;
  const incomplete = artifacts.filter((a) => !a.complete);
  const incompleteNewer = incomplete.some((a) => {
    const t = a.createdAt || mtimeOf(a.path);
    return t && (!latestVerified || String(t) > String(latestVerified.createdAt));
  });

  const baseline = readJson(path.join(STATE_ROOT, 'baseline.json'), null);
  const drill = latestDrillReceipt();
  const previousRun = readJson(path.join(STATE_ROOT, 'last-run.json'), null);

  let live = null;
  let liveError = null;
  try {
    live = await readLiveState(uri, dbName);
  } catch (err) {
    liveError = `${err.codeName || err.name || 'error'}: ${err.message}`;
  }

  const backup = {
    createdAt: latestVerified?.createdAt || null,
    verified: Boolean(latestVerified),
    artifact: latestVerified?.path || null,
    incompleteNewer,
  };

  let checks;
  if (live) {
    ({ checks } = evaluateIntegrity({
      counts: live.counts,
      owner: live.owner,
      visibleProducts: live.visibleProducts,
      indexes: live.indexes,
      baseline,
      backup,
      lastDrill: drill ? { completedAt: drill.completedAt, ok: drill.ok === true } : null,
      lastRunAt: previousRun?.at || null,
      thresholds,
    }));
    checks.push(...live.referenceChecks);
  } else {
    checks = [
      { id: 'database', status: 'unknown', detail: `could not read "${dbName}": ${liveError}` },
      {
        id: 'backup.freshness',
        status: backup.verified ? evaluateFreshness(backup.createdAt, { maxAgeHours: thresholds.maxAgeHours }).status : 'critical',
        detail: backup.verified ? `recovery point ${backup.createdAt}` : 'no verified backup artifact is available',
      },
    ];
  }
  // A newer artifact that fails its own checksums must fail the run even if an
  // older one still verifies — that is a broken backup pipeline, not history.
  if (verificationFailures.length && (!latestVerified || verificationFailures[0].name === newestComplete?.name)) {
    checks.push({
      id: 'backup.verification',
      status: 'critical',
      detail: `newest backup artifact FAILED verification: ${verificationFailures[0].problems[0] || 'unknown reason'}`,
    });
  }
  const status = summarize(checks);
  const freshness = backup.verified
    ? evaluateFreshness(backup.createdAt, { maxAgeHours: thresholds.maxAgeHours })
    : { ageHours: null, status: 'critical' };

  const report = {
    status,
    at: new Date().toISOString(),
    database: dbName,
    backup: {
      verified: backup.verified,
      artifact: backup.artifact ? path.basename(backup.artifact) : null,
      recoveryPoint: backup.createdAt,
      ageHours: freshness.ageHours,
      incompleteNewer,
    },
    artifacts: {
      complete: complete.length,
      incomplete: incomplete.length,
      verificationFailures: verificationFailures.map((f) => f.name),
    },
    baseline: baseline ? { acceptedAt: baseline.acceptedAt, collections: Object.keys(baseline.collections || {}).length } : null,
    checks,
    exitCode: EXIT_FOR_STATUS[status],
  };

  if (flag('json')) {
    say(JSON.stringify(report, null, 2));
  } else {
    say('\nFLORA ALCHEMY — BACKUP & INTEGRITY STATUS');
    say('───────────────────────────────────────────────────────────────');
    say(`  target database   ${dbName} (read-only)`);
    if (latestVerified) {
      say(`  latest verified   ${path.basename(latestVerified.path)}`);
      say(`  recovery point    ${latestVerified.createdAt}`);
      say(
        `  verified contents ${Object.keys(latestVerified.manifest.collections || {}).length} collections · ` +
          `${latestVerified.manifest.documents ?? '?'} documents`
      );
    } else {
      say('  latest verified   NONE');
    }
    const f = checks.find((c) => c.id === 'backup.freshness');
    if (f) say(`  freshness         ${f.detail}`);
    say(`  artifacts         ${complete.length} complete · ${incomplete.length} incomplete`);
    say(`  baseline          ${baseline ? `${baseline.acceptedAt} (${Object.keys(baseline.collections || {}).length} collections)` : 'NONE — drift detection inactive'}`);
    say(`  last drill        ${drill ? `${drill.completedAt} (${drill.ok ? 'ok' : 'FAILED'})` : 'none recorded'}`);
    say('  ─────────────────────────────────────────────────────────────');
    for (const c of checks) {
      const glyph =
        c.status === 'pass' || c.status === 'healthy'
          ? '✔'
          : c.status === 'critical'
            ? '✘'
            : c.status === 'warning'
              ? '⚠'
              : '?';
      say(`  ${glyph} ${c.id.padEnd(24)} ${c.detail}`);
    }
    say('  ─────────────────────────────────────────────────────────────');
    say(`  OVERALL: ${status.toUpperCase()}`);
    say('  runbook: docs/BACKUP_AND_INTEGRITY.md');
  }

  writeJsonAtomic(path.join(STATE_ROOT, 'last-run.json'), {
    at: report.at,
    status,
    database: dbName,
    artifact: report.backup.artifact,
    recoveryPoint: backup.createdAt,
    failing: checks.filter((c) => c.status !== 'pass').map((c) => c.id),
  });

  let exitCode = EXIT_FOR_STATUS[status];
  if (flag('notify') && status !== 'healthy') {
    const sent = await notify(status, checks, { recoveryPoint: backup.createdAt });
    if (!sent.ok) {
      say(`\n✘ alert delivery failed: ${sent.reason}`);
      exitCode = 3;
    } else if (sent.sent) {
      say('\n  alert delivered');
    } else if (sent.deduped) {
      say(`\n  alert suppressed (deduplicated): ${sent.reason}`);
    } else {
      say(`\n  no alert sent: ${sent.reason}`);
    }
  }
  process.exit(exitCode);
}

// ── baseline ───────────────────────────────────────────────────────────────

async function acceptBaseline() {
  const { uri, dbName } = sourceTarget();
  const live = await readLiveState(uri, dbName);
  if (live.owner.count !== 1 || !live.owner.active) {
    die('refusing to record a baseline: the database does not have exactly one ACTIVE owner record.');
  }
  if (live.visibleProducts < 1) die('refusing to record a baseline: there are no storefront-visible products.');
  const artifacts = listArtifacts(BACKUP_ROOT);
  let recoveryPoint = null;
  for (const a of artifacts.filter((x) => x.complete).slice(0, 3)) {
    const v = verifyArtifact(a.path, { passphrase: passphrase() });
    if (v.ok) {
      recoveryPoint = v.manifest.createdAt;
      break;
    }
  }
  const baseline = {
    version: 1,
    acceptedAt: new Date().toISOString(),
    database: dbName,
    recoveryPoint,
    collections: live.counts,
    visibleProducts: live.visibleProducts,
    ownerCount: live.owner.count,
    note: 'Operator-verified healthy state. Drift is measured from these counts; growth never alerts.',
  };
  writeJsonAtomic(path.join(STATE_ROOT, 'baseline.json'), baseline);
  say(`baseline recorded for "${dbName}": ${Object.keys(live.counts).length} collections · ${live.visibleProducts} visible product(s)`);
  say(`  accepted at: ${baseline.acceptedAt}`);
  say('  delete the file to disable drift comparison; never accept a baseline from a knowingly damaged state.');
  process.exit(0);
}

// ── restore drill ──────────────────────────────────────────────────────────

async function freePort(start = 4711) {
  for (let p = start; p < start + 60; p += 1) {
    if (!(await portInUse(p))) return p;
  }
  die('no free port for the drill API');
}

async function disposeDrillDatabase(target) {
  // Delegate to the approved cleanup tool, restricted to this exact name. Its
  // own guards still apply: a protected or unmarked name is never dropped.
  const r = spawnSync(
    process.execPath,
    ['scripts/db-footprint.mjs', '--drop-leftovers', `--only=${target}`],
    { cwd: BACKEND_DIR, encoding: 'utf8', timeout: 120_000 }
  );
  const ok = r.status === 0 && /Dropped 1 disposable database/.test(r.stdout || '');
  return { ok, output: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-600) };
}

async function restoreDrill() {
  const target = value('target');
  if (!target) die('--restore-drill needs --target=<disposable database name>');
  const protectedNames = new Set([PROD_DB, 'flora_alchemy_dev', ...protectedDbNames()].map((n) => n.toLowerCase()));
  if (protectedNames.has(target.toLowerCase())) die(`refusing: "${target}" is a protected database`);
  if (!isDisposableDbName(target)) {
    die(`refusing: "${target}" is not unmistakably disposable (needs a test/qa/dev/smoke/sandbox marker).`);
  }
  const { uri, dbName: sourceDb } = sourceTarget();
  if (target.toLowerCase() === String(sourceDb).toLowerCase()) die('refusing: the drill target is the configured source database');
  let drillUri;
  try {
    drillUri = testMongoUri(uri, target);
  } catch (err) {
    die(`refusing the drill target: ${err.message}`);
  }
  if (!drillUri) die('could not derive a drill URI from MONGO_URI');

  const dir = chooseArtifact(value('artifact'));
  const artifact = verifyArtifact(dir, { passphrase: passphrase() });
  if (!artifact.ok) {
    for (const p of artifact.problems) say(`  ✘ ${p}`);
    die('the selected artifact is not verified; a drill on an unverified backup proves nothing');
  }
  const manifest = artifact.manifest;
  const started = Date.now();
  const problems = [];

  let client = await connect(drillUri, 'flora-backup-restore-drill');
  try {
    const db = client.db(target);
    const existing = await db.listCollections({}, { nameOnly: true }).toArray();
    if (existing.length) {
      if (!flag('reset-drill')) {
        die(`drill target "${target}" already has ${existing.length} collection(s); pass --reset-drill to replace it (disposable target only)`);
      }
      await db.dropDatabase();
    }
    // Re-read after a possible drop and restore every collection, including
    // empty ones (a collection existing with zero documents is meaningful).
    let restoredDocuments = 0;
    const decoded = Object.fromEntries(
      Object.keys(manifest.collections).map((name) => [name, decodeCollection(artifact.files[`${name}.ejson`])])
    );
    for (const [name, docs] of Object.entries(decoded)) {
      await db.createCollection(name).catch((e) => {
        if (e.codeName !== 'NamespaceExists') throw e;
      });
      if (docs.length) {
        await db.collection(name).insertMany(docs, { ordered: true });
        restoredDocuments += docs.length;
      }
    }
    // Recreate the source's indexes (a restore that loses unique indexes can
    // later accept duplicate slugs/emails/order ids).
    let indexesCreated = 0;
    for (const [name, spec] of Object.entries(manifest.inventory || {})) {
      for (const ix of spec.indexes || []) {
        if (ix.name === '_id_') continue;
        const key = ix.textFields && ix.textFields.length
          ? Object.fromEntries(ix.textFields.map((f) => [f, 'text']))
          : ix.key;
        try {
          await db.collection(name).createIndex(key, {
            name: ix.name,
            unique: ix.unique === true,
            sparse: ix.sparse === true,
            ...(ix.partialFilterExpression ? { partialFilterExpression: ix.partialFilterExpression } : {}),
          });
          indexesCreated += 1;
        } catch (err) {
          problems.push(`index ${name}.${ix.name}: ${err.codeName || err.message}`);
        }
      }
    }

    // Counts, indexes and identity must survive the round trip.
    for (const [name, spec] of Object.entries(manifest.collections)) {
      const live = await db.collection(name).countDocuments({});
      if (live !== spec.documents) problems.push(`${name}: restored ${live} != manifest ${spec.documents}`);
    }
    const ownerDocs = await db
      .collection('users')
      .find({ role: 'admin', isOwner: true }, { projection: { status: 1, passwordHash: 1 } })
      .toArray();
    if (ownerDocs.length !== 1) problems.push(`restored owner records: ${ownerDocs.length} (expected 1)`);
    else {
      if (ownerDocs[0].status !== 'ACTIVE') problems.push('restored owner is not ACTIVE');
      if (!ownerDocs[0].passwordHash) problems.push('restored owner has no password hash');
    }
    const visible = await db
      .collection('products')
      .countDocuments({ visibility: { $ne: 'Hidden' } })
      .catch(() => 0);
    if (visible < 1) problems.push('restored catalogue has no storefront-visible product');
    const checkIndexes = (manifest.inventory?.users?.indexes || []).some((i) => i.name === 'email_1');
    if (checkIndexes) {
      const have = (await db.collection('users').indexes()).some((i) => i.name === 'email_1');
      if (!have) problems.push('restored users.email_1 index is missing');
    }

    // AUTHENTICATION CONTRACT: create a drill-only fixture identity (never in
    // production data), boot the real API against the drill database and prove
    // a correct password signs in and a wrong one is refused. The fixture is
    // removed with the database immediately afterwards.
    const email = `drill-${Date.now()}@flora-alchemy.invalid`;
    const password = crypto.randomBytes(18).toString('base64url');
    await db.collection('users').insertOne({
      email,
      passwordHash: bcrypt.hashSync(password, 10),
      role: 'customer',
      name: 'Restore Drill Probe',
      status: 'ACTIVE',
      isFixture: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const port = await freePort();
    let server = null;
    try {
      server = await bootTestServer({
        port,
        db: target,
        label: 'restore-drill',
        healthTimeoutMs: 60_000,
        extraEnv: { SEED_ON_START: 'false' },
      });
      const good = await fetch(`${server.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const goodBody = await good.json().catch(() => ({}));
      if (good.status !== 200 || !goodBody.token) problems.push(`drill login failed (HTTP ${good.status})`);
      const bad = await fetch(`${server.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'definitely-not-the-password' }),
      });
      if (bad.status !== 401) problems.push(`a wrong drill password was not refused (HTTP ${bad.status})`);
    } catch (err) {
      problems.push(`API authentication contract could not run: ${err.message}`);
    } finally {
      if (server) await stopTestServer(server.child, server.base).catch(() => {});
    }

    const durationMs = Date.now() - started;
    const receipt = {
      completedAt: new Date().toISOString(),
      ok: problems.length === 0,
      artifact: path.basename(dir),
      recoveryPoint: manifest.createdAt,
      target,
      durationMs,
      documents: restoredDocuments,
      collections: Object.keys(manifest.collections).length,
      indexesCreated,
      problems,
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeJsonAtomic(path.join(STATE_ROOT, 'drills', `${stamp}.json`), receipt);
    // A stable pointer the scheduled workflow can fetch from object storage
    // without knowing the filename this run chose.
    writeJsonAtomic(path.join(STATE_ROOT, 'drills', 'latest.json'), receipt);

    say(`\nRESTORE DRILL — ${path.basename(dir)} → ${target}`);
    say(`  recovery point    ${manifest.createdAt}`);
    say(`  restored          ${restoredDocuments} documents · ${Object.keys(manifest.collections).length} collections · ${indexesCreated} indexes`);
    say(`  duration          ${(durationMs / 1000).toFixed(1)}s`);
    say(`  authentication    ${problems.some((p) => p.startsWith('drill login') || p.startsWith('a wrong') || p.startsWith('API authentication')) ? '✘ failed' : '✔ sign-in accepted, wrong password refused'}`);
    for (const p of problems) say(`  ✘ ${p}`);
    say(problems.length ? '\nDRILL FAILED' : '\nDRILL PASSED — the backup was restored and read successfully.');
  } finally {
    await client.close().catch(() => {});
    const disposal = await disposeDrillDatabase(target);
    if (!disposal.ok) {
      say(`  ⚠ could not dispose of the drill database "${target}" — run: node scripts/db-footprint.mjs --drop-leftovers --only=${target}`);
      say(disposal.output);
    }
  }
  let exitCode = problems.length ? 1 : 0;
  if (problems.length && flag('notify')) {
    const sent = await notify(
      'critical',
      [{ id: 'drill', status: 'critical', detail: problems[0] }],
      { recoveryPoint: manifest.createdAt }
    );
    if (!sent.ok) {
      say(`  ✘ alert delivery failed: ${sent.reason}`);
      exitCode = 3;
    }
  }
  process.exit(exitCode);
}

// ── upload an already-verified artifact ────────────────────────────────────

function uploadCommand() {
  const dir = chooseArtifact(value('artifact'));
  const result = verifyArtifact(dir, { passphrase: passphrase() });
  if (!result.ok) {
    for (const p of result.problems) say(`  ✘ ${p}`);
    die('refusing to upload an artifact that does not verify');
  }
  uploadArtifact(dir, result.manifest);
  process.exit(0);
}

// ── decrypt an artifact into a recovery-compatible directory ───────────────

function decryptCommand() {
  const dir = chooseArtifact(value('artifact'));
  const out = value('out');
  if (!out) die('--decrypt needs --out=<directory>');
  if (fs.existsSync(out) && fs.readdirSync(out).length) die(`refusing to write into a non-empty directory: ${out}`);
  const result = verifyArtifact(dir, { passphrase: passphrase() });
  if (!result.ok) {
    for (const p of result.problems) say(`  ✘ ${p}`);
    die('cannot decrypt an artifact that does not verify');
  }
  fs.mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(result.files)) fs.writeFileSync(path.join(out, name), text, 'utf8');
  const manifest = { ...result.manifest, encryption: { mode: 'none' } };
  delete manifest.archiveSha256;
  fs.writeFileSync(path.join(out, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
  const sums = Object.entries(result.files).map(([name, text]) => `${sha256(Buffer.from(text, 'utf8'))}  ${name}`);
  fs.writeFileSync(path.join(out, CHECKSUMS_FILE), sums.join('\n') + '\n', 'utf8');
  fs.writeFileSync(
    path.join(out, COMPLETE_FILE),
    JSON.stringify({ completedAt: new Date().toISOString(), mode: 'none', decryptedFrom: path.basename(dir) }, null, 2),
    'utf8'
  );
  say(`decrypted to ${out}`);
  say('  this directory is PLAINTEXT and can be restored with scripts/recovery.mjs --restore --source=<dir>');
  say('  delete it when the restore is finished.');
  process.exit(0);
}

// ── retention ──────────────────────────────────────────────────────────────

function pruneCommand() {
  const keep = Number(value('keep') || process.env.BACKUP_RETENTION_COUNT || DEFAULT_RETENTION_COUNT);
  const artifacts = listArtifacts(BACKUP_ROOT);
  const removable = selectPrunable(artifacts, keep);
  const incomplete = artifacts.filter((a) => !a.complete && a.name.includes('.partial-'));
  say(`retention: keep ${keep} completed artifacts; ${artifacts.filter((a) => a.complete).length} present`);
  if (incomplete.length) {
    say(`  ${incomplete.length} interrupted export director(ies) left in place (inspect before removing):`);
    for (const a of incomplete) say(`    ${a.name}`);
  }
  if (!removable.length) {
    say('  nothing to prune.');
    process.exit(0);
  }
  for (const a of removable) {
    say(`  ${flag('apply') ? 'removing' : 'would remove'} ${a.name} (recovery point ${a.createdAt || '?'})`);
    if (!flag('apply')) continue;
    const rel = path.relative(BACKUP_ROOT, a.path);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) die(`refusing to delete outside the backup root: ${a.path}`);
    fs.rmSync(a.path, { recursive: true, force: true });
  }
  if (!flag('apply')) say('\nDRY RUN — pass --apply to remove the artifacts listed above.');
  else say(`\nremoved ${removable.length} artifact(s); the newest ${keep} were kept.`);
  process.exit(0);
}

// ── dispatch ───────────────────────────────────────────────────────────────

// `--upload` is a MODIFIER of `--export` when both are present (create then
// publish), and a standalone mode otherwise. It must not count as a second mode.
const modes = ['export', 'verify', 'status', 'accept-baseline', 'restore-drill', 'decrypt', 'prune', 'upload'].filter(
  (m) => flag(m) && !(m === 'upload' && flag('export'))
);
if (modes.length !== 1) {
  die(
    'pass exactly one mode: --export, --verify, --status, --accept-baseline, --restore-drill, --decrypt, --prune or --upload\n' +
      '  see the header of scripts/backup.mjs and docs/BACKUP_AND_INTEGRITY.md'
  );
}

const mode = modes[0];
if (mode === 'export') await exportArtifact();
else if (mode === 'verify') verifyCommand();
else if (mode === 'status') await statusCommand();
else if (mode === 'accept-baseline') await acceptBaseline();
else if (mode === 'restore-drill') await restoreDrill();
else if (mode === 'decrypt') decryptCommand();
else if (mode === 'prune') pruneCommand();
else if (mode === 'upload') uploadCommand();
