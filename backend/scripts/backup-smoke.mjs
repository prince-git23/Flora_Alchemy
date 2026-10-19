/**
 * Backup & integrity smoke suite — the failure modes that matter.
 *
 * A backup system is only worth what it proves under failure. This suite
 * exercises, against disposable databases and temporary directories only:
 *
 *   · a good export/checksum/manifest round trip (and Extended JSON fidelity),
 *   · a tampered payload, a missing payload and an interrupted export,
 *   · AES-256-GCM: wrong key, missing key, and decryption for recovery,
 *   · freshness: fresh, stale, very stale and undated,
 *   · integrity: owner/catalogue/collection/index/drift/baseline logic,
 *   · a REAL restore drill (counts, indexes, owner, catalogue, API sign-in),
 *     repeated drill into an existing target with --reset-drill,
 *   · refusal of production, protected, foreign and same-as-source targets,
 *   · alert delivery, deduplication and delivery failure,
 *   · retention (dry run + apply) and off-host upload command construction,
 *   · upload refusal for an unencrypted artifact.
 *
 * It never touches production: every database name comes from `testMongoUri`
 * and every drill is disposed through `db-footprint.mjs --only=<exact name>`.
 * No credentials, hashes or document contents are printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoClient, ObjectId, BSON } from 'mongodb';
import { loadBackendEnv, testMongoUri } from './lib/testServer.mjs';
import {
  encryptBuffer,
  decryptBuffer,
  evaluateFreshness,
  evaluateIntegrity,
  selectPrunable,
  listArtifacts,
  verifyArtifact,
  sha256,
} from './lib/backupArchive.mjs';

loadBackendEnv();

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE_DB = 'Flora-Alchemy-Test-Backup';
const DRILL_DB = 'Flora-Alchemy-Test-Backup-Drill';
const KEY = 'drill-only-backup-key-0123456789';
const WRONG_KEY = 'wrong-drill-only-key-0123456789';

let passed = 0;
let failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-backup-suite-'));
const backups = path.join(root, 'backups');
const state = path.join(root, 'state');
const encRoot = path.join(root, 'enc-root');
const scratch = path.join(root, 'scratch');
fs.mkdirSync(backups, { recursive: true });
fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(encRoot, { recursive: true });
fs.mkdirSync(scratch, { recursive: true });

const sourceUri = testMongoUri(process.env.MONGO_URI, SOURCE_DB);
const drillUri = testMongoUri(process.env.MONGO_URI, DRILL_DB);

/** A clean CLI environment: never inherit production backup settings. */
function cliEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('BACKUP_') || k.startsWith('ALERT_') || k === 'MONGO_URI') continue;
    env[k] = v;
  }
  return {
    ...env,
    MONGO_URI: sourceUri,
    BACKUP_ROOT: backups,
    BACKUP_STATE_ROOT: state,
    BACKUP_ENCRYPTION_KEY: '',
    NODE_ENV: 'development',
    ...extra,
  };
}

function run(args, extra = {}) {
  const r = spawnSync(process.execPath, ['scripts/backup.mjs', ...args], {
    cwd: BACKEND_DIR,
    env: cliEnv(extra),
    encoding: 'utf8',
    timeout: 240_000,
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * Async variant, required when THIS process must keep serving a webhook while
 * the CLI runs: spawnSync blocks the event loop, so a loopback alert in the
 * parent could never be answered and would look like a delivery failure.
 */
function runAsync(args, extra = {}) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, ['scripts/backup.mjs', ...args], {
      cwd: BACKEND_DIR,
      env: cliEnv(extra),
    });
    let out = '';
    cp.stdout.on('data', (d) => {
      out += d;
    });
    cp.stderr.on('data', (d) => {
      out += d;
    });
    cp.on('close', (status) => resolve({ status, out }));
    cp.on('error', (err) => resolve({ status: 1, out: `${out}\n${err.message}` }));
  });
}

async function connect(uri) {
  const c = new MongoClient(uri, { serverSelectionTimeoutMS: 20_000 });
  await c.connect();
  return c;
}

async function seedSource() {
  const c = await connect(sourceUri);
  const db = c.db();
  await db.dropDatabase().catch(() => {});
  const now = new Date('2026-10-01T10:00:00Z');
  const owner = await db.collection('users').insertOne({
    email: 'owner@backup.invalid',
    passwordHash: 'suite-placeholder-hash',
    role: 'admin',
    isOwner: true,
    status: 'ACTIVE',
    isFixture: false,
    createdAt: now,
    updatedAt: now,
  });
  void owner;
  const customer = await db.collection('customers').insertOne({
    name: 'Suite Customer',
    email: 'customer@backup.invalid',
    status: 'Active',
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('products').insertOne({
    slug: 'suite-rose',
    name: 'Suite Rose',
    price: 500,
    visibility: 'Visible',
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('orders').insertOne({
    orderId: 'FA-9001',
    customerId: customer.insertedId,
    items: [],
    total: 500,
    orderStatus: 'new',
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('inventories').insertOne({
    productSlug: 'suite-rose',
    currentStock: 7,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('settings').insertOne({ key: 'default', shopName: 'Suite', createdAt: now, updatedAt: now });
  await db.collection('collections').insertOne({ slug: 'suite', name: 'Suite', createdAt: now, updatedAt: now });
  await db.collection('reviews').insertMany(
    [1, 2, 3, 4, 5].map((n) => ({ rating: 5, title: `Review ${n}`, createdAt: now, updatedAt: now }))
  );
  for (const [coll, spec] of [
    ['users', { email: 1 }],
    ['products', { slug: 1 }],
    ['orders', { orderId: 1 }],
    ['settings', { key: 1 }],
    ['collections', { slug: 1 }],
    ['inventories', { productSlug: 1 }],
  ]) {
    await db.collection(coll).createIndex(spec, { unique: true });
  }
  await c.close();
}

function latestArtifact(rootDir = backups) {
  const complete = listArtifacts(rootDir).filter((a) => a.complete);
  return complete[0] || null;
}

function editManifest(dir, mutate) {
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
}

function copyArtifact(from, to) {
  fs.cpSync(from, to, { recursive: true });
  return to;
}

// ── units: encryption, freshness, integrity, retention ─────────────────────

function unitTests() {
  console.log('\n▶ unit: encryption / freshness / integrity / retention');
  const plaintext = Buffer.from('{"hello":"world"}'.repeat(50), 'utf8');
  const sealed = encryptBuffer(plaintext, KEY);
  assert('encryption round trip', decryptBuffer(sealed.buffer, KEY).equals(plaintext));
  assert('sealed archive does not contain the plaintext', !sealed.buffer.includes(Buffer.from('hello')));
  let wrong = null;
  try {
    decryptBuffer(sealed.buffer, WRONG_KEY);
  } catch (err) {
    wrong = err;
  }
  assert('wrong key is refused', Boolean(wrong) && /wrong BACKUP_ENCRYPTION_KEY/.test(wrong.message));
  let short = null;
  try {
    encryptBuffer(plaintext, 'short');
  } catch (err) {
    short = err;
  }
  assert('short passphrase is refused', Boolean(short) && /at least 16/.test(short.message));
  const tampered = Buffer.from(sealed.buffer);
  tampered[tampered.length - 1] ^= 0xff;
  let tamperErr = null;
  try {
    decryptBuffer(tampered, KEY);
  } catch (err) {
    tamperErr = err;
  }
  assert('tampered ciphertext is refused (GCM authentication)', Boolean(tamperErr));

  const now = new Date('2026-10-19T12:00:00Z');
  const fresh = evaluateFreshness('2026-10-19T10:00:00Z', { now, maxAgeHours: 30 });
  assert('freshness: 2h old is healthy', fresh.status === 'healthy' && fresh.ageHours === 2);
  const stale = evaluateFreshness('2026-10-17T20:00:00Z', { now, maxAgeHours: 30 });
  assert('freshness: 40h old is a warning', stale.status === 'warning', stale.status);
  const old = evaluateFreshness('2026-10-16T10:00:00Z', { now, maxAgeHours: 30 });
  assert('freshness: 50h old is critical', old.status === 'critical', old.status);
  const undated = evaluateFreshness(null, { now });
  assert('freshness: undated is critical', undated.status === 'critical');

  const baseInputs = {
    counts: { users: 4, products: 3, settings: 1, collections: 2, customers: 2, orders: 2, inventories: 2, reviews: 5 },
    owner: { count: 1, active: true, hashPresent: true, fixtureUsers: 0 },
    visibleProducts: 3,
    indexes: {
      users: [{ name: 'email_1', key: { email: 1 }, unique: true }],
      products: [{ name: 'slug_1', key: { slug: 1 }, unique: true }],
      orders: [{ name: 'orderId_1', key: { orderId: 1 }, unique: true }],
      settings: [{ name: 'key_1', key: { key: 1 }, unique: true }],
      collections: [{ name: 'slug_1', key: { slug: 1 }, unique: true }],
      inventories: [{ name: 'productSlug_1', key: { productSlug: 1 }, unique: true }],
    },
    baseline: { acceptedAt: '2026-10-18T00:00:00Z', collections: { users: 4, products: 3, customers: 2, orders: 2, reviews: 5 } },
    backup: { verified: true, createdAt: '2026-10-19T10:00:00Z' },
    lastDrill: { completedAt: '2026-10-18T00:00:00Z', ok: true },
    thresholds: { maxAgeHours: 30, drillMaxAgeDays: 30 },
    now,
  };
  const good = evaluateIntegrity(baseInputs);
  assert('integrity: complete inputs are healthy', good.status === 'healthy', good.checks.map((c) => `${c.id}=${c.status}`).join(','));
  const noBackup = evaluateIntegrity({ ...baseInputs, backup: null });
  assert('integrity: no verified backup is critical', noBackup.status === 'critical');
  const noOwner = evaluateIntegrity({ ...baseInputs, owner: { count: 0, active: false, hashPresent: false } });
  assert('integrity: missing owner is critical', noOwner.status === 'critical');
  const inactive = evaluateIntegrity({ ...baseInputs, owner: { count: 1, active: false, hashPresent: true } });
  assert('integrity: inactive owner is critical', inactive.status === 'critical');
  const noCatalogue = evaluateIntegrity({ ...baseInputs, visibleProducts: 0 });
  assert('integrity: no visible product is critical', noCatalogue.status === 'critical');
  const countsMissingOrders = { ...baseInputs.counts };
  delete countsMissingOrders.orders;
  const missingCollection = evaluateIntegrity({ ...baseInputs, counts: countsMissingOrders });
  assert('integrity: a missing essential collection is critical', missingCollection.status === 'critical');
  const noIndex = evaluateIntegrity({
    ...baseInputs,
    indexes: { ...baseInputs.indexes, users: [] },
  });
  assert('integrity: a missing unique index is a warning', noIndex.status === 'warning');
  const drift = evaluateIntegrity({ ...baseInputs, counts: { ...baseInputs.counts, reviews: 1 } });
  assert('integrity: a 80% drop in a non-critical collection is a warning', drift.status === 'warning');
  const criticalDrift = evaluateIntegrity({ ...baseInputs, counts: { ...baseInputs.counts, users: 1 } });
  assert('integrity: a 75% drop in users is critical', criticalDrift.status === 'critical');
  const growth = evaluateIntegrity({ ...baseInputs, counts: { ...baseInputs.counts, orders: 40, users: 9 } });
  assert('integrity: growth never alerts', growth.status === 'healthy');
  const noBaseline = evaluateIntegrity({ ...baseInputs, baseline: null });
  assert('integrity: absent baseline is a warning, not a pass', noBaseline.status === 'warning');
  const noDrill = evaluateIntegrity({ ...baseInputs, lastDrill: null });
  assert('integrity: absent drill is a warning', noDrill.status === 'warning');
  const staleDrill = evaluateIntegrity({ ...baseInputs, lastDrill: { completedAt: '2026-08-01T00:00:00Z', ok: true } });
  assert('integrity: an old drill is a warning', staleDrill.status === 'warning');
  const failedDrill = evaluateIntegrity({ ...baseInputs, lastDrill: { completedAt: '2026-10-18T00:00:00Z', ok: false } });
  assert('integrity: a failed drill is critical', failedDrill.status === 'critical');
  const gap = evaluateIntegrity({ ...baseInputs, lastRunAt: '2026-10-10T00:00:00Z' });
  assert('integrity: a stopped schedule is a warning', gap.status === 'warning');

  const artifacts = [
    { name: 'flora-backup-2026-10-19', complete: true, format: 'flora-backup/1', createdAt: '2026-10-19T00:00:00Z', path: '/a' },
    { name: 'flora-backup-2026-10-18', complete: true, format: 'flora-backup/1', createdAt: '2026-10-18T00:00:00Z', path: '/b' },
    { name: 'flora-backup-2026-10-17', complete: true, format: 'flora-backup/1', createdAt: '2026-10-17T00:00:00Z', path: '/c' },
    { name: 'pre-restore-2026-10-18', complete: true, format: 'flora-backup/1', createdAt: '2026-10-01T00:00:00Z', path: '/d' },
    { name: 'not-ours', complete: true, format: 'other/1', createdAt: '2026-09-01T00:00:00Z', path: '/e' },
  ];
  const prunable = selectPrunable(artifacts, 2);
  assert('retention: keeps the newest N', prunable.length === 1 && prunable[0].name === 'flora-backup-2026-10-17');
  assert('retention: never prunes a pre-restore artifact', !prunable.some((a) => a.name.startsWith('pre-restore')));
  assert('retention: never prunes a foreign artifact', !prunable.some((a) => a.name === 'not-ours'));
}

// ── export / verify / tamper ───────────────────────────────────────────────

async function exportTests() {
  console.log('\n▶ export, checksums and tamper detection');
  const r = run(['--export']);
  assert('export succeeds', r.status === 0, r.out.slice(-400));
  const artifact = latestArtifact();
  assert('export produced a completed artifact', Boolean(artifact?.complete), artifact?.path || 'none');
  assert('export marked the artifact plaintext', artifact && !artifact.encrypted);
  const dir = artifact.path;
  assert('manifest names the source database', JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).database === SOURCE_DB);
  assert('completion marker is written last', fs.existsSync(path.join(dir, '.complete.json')));
  assert('checksum file exists', fs.existsSync(path.join(dir, 'SHA256SUMS.txt')));

  const verified = verifyArtifact(dir);
  assert('fresh artifact verifies', verified.ok, verified.problems.join('; '));
  const manifest = verified.manifest;
  assert(
    'manifest counts match the source',
    manifest.inventory.users.documents === 1 &&
      manifest.inventory.products.documents === 1 &&
      manifest.inventory.orders.documents === 1 &&
      manifest.inventory.reviews.documents === 5,
    JSON.stringify(Object.fromEntries(Object.entries(manifest.inventory).map(([k, v]) => [k, v.documents])))
  );
  assert('index definitions were captured', (manifest.inventory.users.indexes || []).some((i) => i.name === 'email_1'));

  // Extended JSON fidelity: an ObjectId must stay an ObjectId and a Date a Date.
  const orderLine = fs.readFileSync(path.join(dir, 'orders.ejson'), 'utf8').trim();
  const orderDoc = BSON.EJSON.parse(orderLine, { relaxed: false });
  assert('exported _id survives as an ObjectId', orderDoc._id instanceof ObjectId);
  assert('exported dates survive as Dates', orderDoc.createdAt instanceof Date);

  const v = run(['--verify']);
  assert('verify command exits 0 for a good artifact', v.status === 0, v.out.slice(-300));

  // Tampered payload: change one byte of one collection file.
  const tampered = copyArtifact(dir, path.join(scratch, 'tampered'));
  fs.appendFileSync(path.join(tampered, 'users.ejson'), '\n');
  const tv = run(['--verify', `--artifact=${tampered}`]);
  assert('verify fails on a changed payload', tv.status === 1, tv.out.slice(-300));
  assert('verify names the changed file', /users\.ejson/.test(tv.out));

  // Missing payload.
  const missing = copyArtifact(dir, path.join(scratch, 'missing'));
  fs.rmSync(path.join(missing, 'products.ejson'));
  const mv = run(['--verify', `--artifact=${missing}`]);
  assert('verify fails when a collection file is missing', mv.status === 1, mv.out.slice(-300));

  // Interrupted export: no completion marker.
  const interrupted = copyArtifact(dir, path.join(scratch, 'flora-backup-interrupted.partial-1'));
  fs.rmSync(path.join(interrupted, '.complete.json'));
  const iv = run(['--verify', `--artifact=${interrupted}`]);
  assert('verify fails an interrupted export', iv.status === 1 && /INCOMPLETE/.test(iv.out), iv.out.slice(-300));
  const listed = listArtifacts(scratch).find((a) => a.name.includes('interrupted'));
  assert('an interrupted export is not treated as complete', listed && listed.complete === false);

  return dir;
}

// ── encryption + decrypt ───────────────────────────────────────────────────

function encryptionTests(plainDir) {
  console.log('\n▶ encrypted artifacts');
  const r = run(['--export', '--encrypt'], {
    BACKUP_ROOT: encRoot,
    BACKUP_STATE_ROOT: path.join(root, 'enc-state'),
    BACKUP_ENCRYPTION_KEY: KEY,
  });
  assert('encrypted export succeeds', r.status === 0, r.out.slice(-400));
  const enc = latestArtifact(encRoot);
  assert('encrypted artifact is marked encrypted', enc?.encrypted === true);
  assert('no plaintext collection files in the encrypted artifact', !fs.readdirSync(enc.path).some((f) => f.endsWith('.ejson')));
  assert('a sealed archive exists', fs.existsSync(path.join(enc.path, 'archive.fb1')));

  const ok = run(['--verify', `--artifact=${enc.path}`], { BACKUP_ENCRYPTION_KEY: KEY });
  assert('encrypted artifact verifies with the key', ok.status === 0, ok.out.slice(-400));
  const wrong = run(['--verify', `--artifact=${enc.path}`], { BACKUP_ENCRYPTION_KEY: WRONG_KEY });
  assert('encrypted artifact fails with the wrong key', wrong.status === 1, wrong.out.slice(-300));
  const none = run(['--verify', `--artifact=${enc.path}`], { BACKUP_ENCRYPTION_KEY: '' });
  assert('encrypted artifact fails without a key', none.status === 1, none.out.slice(-300));
  const require = run(['--verify', `--artifact=${plainDir}`, '--require-encryption']);
  assert('--require-encryption refuses a plaintext artifact', require.status === 1);

  const out = path.join(scratch, 'decrypted');
  const dec = run(['--decrypt', `--artifact=${enc.path}`, `--out=${out}`], { BACKUP_ENCRYPTION_KEY: KEY });
  assert('decrypt succeeds', dec.status === 0, dec.out.slice(-300));
  assert('decrypt writes collection payloads', fs.existsSync(path.join(out, 'users.ejson')));
  const decVerify = run(['--verify', `--artifact=${out}`]);
  assert('the decrypted directory verifies as plaintext', decVerify.status === 0, decVerify.out.slice(-300));
  assert('decrypt refuses to write into a non-empty directory', run(['--decrypt', `--artifact=${enc.path}`, `--out=${out}`], { BACKUP_ENCRYPTION_KEY: KEY }).status === 1);
}

// ── status, baseline, drift, staleness ─────────────────────────────────────

async function statusTests(plainDir) {
  console.log('\n▶ status / baseline / drift / freshness');

  const beforeBaseline = run(['--status']);
  assert('status without a baseline is a warning, not a pass', beforeBaseline.status === 2, `exit ${beforeBaseline.status}`);
  assert('status names the missing baseline', /no verified baseline/i.test(beforeBaseline.out));

  const b = run(['--accept-baseline']);
  assert('baseline acceptance succeeds', b.status === 0, b.out.slice(-300));
  assert('baseline file is written', fs.existsSync(path.join(state, 'baseline.json')));

  const noDrill = run(['--status']);
  assert('status without a drill is still a warning', noDrill.status === 2, `exit ${noDrill.status}`);

  const json = run(['--status', '--json']);
  let parsed = null;
  try {
    parsed = JSON.parse(json.out);
  } catch {
    /* asserted below */
  }
  assert('--json emits parseable status', Boolean(parsed?.checks?.length), json.out.slice(0, 200));
  assert('--json reports the same exit code', json.status === 2);

  // A stale recovery point: rewrite the manifest's declared time (payload
  // checksums are unaffected, so this isolates freshness from integrity).
  const original = JSON.parse(fs.readFileSync(path.join(plainDir, 'manifest.json'), 'utf8'));
  editManifest(plainDir, (m) => {
    m.createdAt = new Date(Date.now() - 40 * 3_600_000).toISOString();
  });
  const stale = run(['--status']);
  assert('a 40h-old recovery point is a warning', stale.status === 2, `exit ${stale.status}`);
  editManifest(plainDir, (m) => {
    m.createdAt = new Date(Date.now() - 100 * 3_600_000).toISOString();
  });
  const veryStale = run(['--status']);
  assert('a 100h-old recovery point is critical', veryStale.status === 1, `exit ${veryStale.status}`);
  editManifest(plainDir, (m) => {
    m.createdAt = original.createdAt;
  });

  // A newer artifact that fails its checksums must fail the run even though an
  // older artifact still verifies.
  const broken = copyArtifact(plainDir, path.join(backups, 'flora-backup-9999-01-01T00-00-00-000Z'));
  editManifest(broken, (m) => {
    m.createdAt = new Date().toISOString();
  });
  fs.appendFileSync(path.join(broken, 'orders.ejson'), '\n');
  const newestBroken = run(['--status']);
  assert('a newer unverifiable artifact is critical', newestBroken.status === 1, `exit ${newestBroken.status}`);
  assert('status explains the verification failure', /FAILED verification/i.test(newestBroken.out), newestBroken.out.slice(-400));
  fs.rmSync(broken, { recursive: true, force: true });

  // Drift: delete documents below the accepted baseline.
  const c = await connect(sourceUri);
  const db = c.db();
  const reviews = await db.collection('reviews').find({}).limit(4).toArray();
  await db.collection('reviews').deleteMany({ _id: { $in: reviews.map((d) => d._id) } });
  const drift = run(['--status']);
  assert('a large drop in a non-critical collection is a warning', drift.status === 2, `exit ${drift.status}`);
  assert('status names the reduced collection', /reviews/.test(drift.out));
  await db.collection('reviews').insertMany(reviews);

  const owner = await db.collection('users').findOne({ role: 'admin', isOwner: true });
  await db.collection('users').deleteOne({ _id: owner._id });
  const ownerGone = run(['--status']);
  assert('a missing owner is critical', ownerGone.status === 1, `exit ${ownerGone.status}`);
  await db.collection('users').insertOne(owner);

  const visible = await db.collection('products').findOne({ slug: 'suite-rose' });
  await db.collection('products').deleteOne({ _id: visible._id });
  const catalogueGone = run(['--status']);
  assert('an empty visible catalogue is critical', catalogueGone.status === 1, `exit ${catalogueGone.status}`);
  await db.collection('products').insertOne(visible);
  await c.close();

  // No artifact at all = no recoverable point.
  const emptyRoot = path.join(root, 'empty-root');
  fs.mkdirSync(emptyRoot, { recursive: true });
  const none = run(['--status'], { BACKUP_ROOT: emptyRoot });
  assert('no backup at all is critical', none.status === 1, `exit ${none.status}`);

  // Unreadable database = unknown (never reported as success).
  const unknown = run(['--status', '--source-db=Flora-Alchemy-Test-Backup-Missing']);
  assert('an unreadable database is UNKNOWN (exit 3)', unknown.status === 3, `exit ${unknown.status}`);
  assert('unknown is printed as such', /OVERALL: UNKNOWN/.test(unknown.out), unknown.out.slice(-300));

  // Restoring the data must return the database to a non-alerting state. The
  // full healthy check (fresh + verified + baseline + drill) runs after the
  // drill below.
  const recovered = run(['--status']);
  assert('after restoring the data, critical checks are gone', recovered.status === 2, `exit ${recovered.status}`);
  assert('the only remaining warnings are the absent drill', /no recorded restore drill/.test(recovered.out));
}

// ── restore drill ──────────────────────────────────────────────────────────

async function drillTests(plainDir) {
  console.log('\n▶ restore drill (real API sign-in)');

  // Make the target non-empty first to prove --reset-drill replacement works.
  const pre = await connect(drillUri);
  await pre.db().collection('junk').insertOne({ note: 'must be replaced by the drill' });
  await pre.close();

  const noReset = run(['--restore-drill', `--target=${DRILL_DB}`]);
  assert('a drill into a non-empty target is refused without --reset-drill', noReset.status === 1, noReset.out.slice(-300));

  for (const [label, target] of [
    ['production', 'Flora-Alchemy'],
    ['the shared development database', 'flora_alchemy_dev'],
    ['an unmarked/foreign database', 'SomeOtherDatabase'],
    ['the configured source database', SOURCE_DB],
  ]) {
    const r = run(['--restore-drill', `--target=${target}`]);
    assert(`drill refuses ${label}`, r.status === 1, r.out.slice(-200));
  }

  const started = Date.now();
  const drill = run(['--restore-drill', `--target=${DRILL_DB}`, '--reset-drill']);
  const elapsed = Date.now() - started;
  assert('drill succeeds', drill.status === 0, drill.out.slice(-800));
  assert('drill verifies the restored authentication contract', /sign-in accepted, wrong password refused/.test(drill.out), drill.out.slice(-500));
  assert('drill restores every collection', /8 collections/.test(drill.out), drill.out.slice(-500));
  assert('drill restores every document', /restored +12 documents/.test(drill.out), drill.out.slice(-500));
  assert(`drill completes in a bounded time (${(elapsed / 1000).toFixed(1)}s)`, elapsed < 180_000);

  const after = await connect(process.env.MONGO_URI);
  const collections = await after.db(DRILL_DB).listCollections({}, { nameOnly: true }).toArray();
  await after.close();
  assert('drill database is disposed afterwards', collections.length === 0, collections.map((c) => c.name).join(','));

  const receipt = /drill stored|DRILL PASSED/.test(drill.out);
  assert('drill records a passing receipt', receipt);
  const receiptFiles = fs.existsSync(path.join(state, 'drills')) ? fs.readdirSync(path.join(state, 'drills')) : [];
  assert('drill receipt file exists', receiptFiles.some((f) => f.endsWith('.json')));

  // A second drill proves the workflow is repeatable (and resumable from a
  // dropped target).
  const again = run(['--restore-drill', `--target=${DRILL_DB}`]);
  assert('a repeat drill succeeds', again.status === 0, again.out.slice(-400));

  const healthy = run(['--status']);
  assert('with a fresh verified backup, baseline and passing drill, status is HEALTHY', healthy.status === 0, healthy.out.slice(-800));
  assert('healthy output says so explicitly', /OVERALL: HEALTHY/.test(healthy.out));
}

// ── alerting ───────────────────────────────────────────────────────────────

async function alertTests(plainDir) {
  console.log('\n▶ alert delivery, dedup and failure');
  const received = [];
  let respond = (res) => {
    res.statusCode = 204;
    res.end();
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        received.push({ url: req.url, auth: req.headers.authorization || '', body: JSON.parse(body) });
      } catch {
        received.push({ url: req.url, auth: req.headers.authorization || '', body: null });
      }
      respond(res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/alert`;

  const original = JSON.parse(fs.readFileSync(path.join(plainDir, 'manifest.json'), 'utf8'));
  editManifest(plainDir, (m) => {
    m.createdAt = new Date(Date.now() - 40 * 3_600_000).toISOString();
  });
  const first = await runAsync(['--status', '--notify'], { ALERT_WEBHOOK_URL: url, ALERT_WEBHOOK_TOKEN: 'suite-token' });
  assert('a warning status is delivered to the webhook', first.status === 2 && received.length === 1, `exit ${first.status}, requests ${received.length}`);
  assert('the alert contains status and recovery-point age only', received[0]?.body?.status === 'warning' && !JSON.stringify(received[0]?.body).includes('customer@'));
  assert('the alert carries the bearer token', received[0]?.auth === 'Bearer suite-token');

  const second = await runAsync(['--status', '--notify'], { ALERT_WEBHOOK_URL: url });
  assert('a duplicate alert inside the cooldown is suppressed', second.status === 2 && received.length === 1, `requests ${received.length}`);
  assert('the suppression is reported', /deduplicated/i.test(second.out));

  fs.rmSync(path.join(state, 'alerts.json'), { force: true });
  respond = (res) => {
    res.statusCode = 500;
    res.end('nope');
  };
  const failing = await runAsync(['--status', '--notify'], { ALERT_WEBHOOK_URL: url });
  assert('a webhook failure is exit 3, never success', failing.status === 3, `exit ${failing.status}`);
  assert('the delivery failure is reported', /alert delivery failed/.test(failing.out));

  await new Promise((resolve) => server.close(resolve));
  editManifest(plainDir, (m) => {
    m.createdAt = original.createdAt;
  });
}

// ── retention ──────────────────────────────────────────────────────────────

function pruneTests(sourceDir) {
  console.log('\n▶ retention');
  const pruneRoot = path.join(root, 'prune-root');
  fs.mkdirSync(pruneRoot, { recursive: true });
  for (let i = 0; i < 3; i += 1) {
    const dest = path.join(pruneRoot, `flora-backup-2026-10-0${i + 1}T00-00-00-000Z`);
    copyArtifact(sourceDir, dest);
    editManifest(dest, (m) => {
      m.createdAt = `2026-10-0${i + 1}T00:00:00.000Z`;
    });
  }
  copyArtifact(sourceDir, path.join(pruneRoot, 'pre-restore-2026-01-01T00-00-00-000Z'));
  copyArtifact(sourceDir, path.join(pruneRoot, 'not-ours'));

  const dry = run(['--prune', '--keep=2'], { BACKUP_ROOT: pruneRoot });
  assert('prune dry run reports the oldest artifact', dry.status === 0 && /would remove flora-backup-2026-10-01/.test(dry.out), dry.out.slice(-300));
  assert('prune dry run deletes nothing', fs.existsSync(path.join(pruneRoot, 'flora-backup-2026-10-01T00-00-00-000Z')));
  assert('prune never targets a pre-restore artifact', !/would remove pre-restore/.test(dry.out));
  assert('prune never targets a foreign artifact', !/would remove not-ours/.test(dry.out));

  const apply = run(['--prune', '--keep=2', '--apply'], { BACKUP_ROOT: pruneRoot });
  assert('prune applies', apply.status === 0, apply.out.slice(-300));
  assert('prune removed only the oldest scheduled artifact', !fs.existsSync(path.join(pruneRoot, 'flora-backup-2026-10-01T00-00-00-000Z')));
  assert('prune kept the newest two', fs.existsSync(path.join(pruneRoot, 'flora-backup-2026-10-03T00-00-00-000Z')) && fs.existsSync(path.join(pruneRoot, 'flora-backup-2026-10-02T00-00-00-000Z')));
  assert('prune kept the pre-restore artifact', fs.existsSync(path.join(pruneRoot, 'pre-restore-2026-01-01T00-00-00-000Z')));
}

// ── upload (AWS CLI command construction) ──────────────────────────────────

function uploadTests() {
  console.log('\n▶ off-host upload (AWS CLI, fake binary)');
  const log = path.join(scratch, 'aws-calls.jsonl');
  fs.writeFileSync(log, '', 'utf8');
  const fakeAws = path.join(scratch, 'fake-aws.mjs');
  fs.writeFileSync(
    fakeAws,
    `import fs from 'node:fs';\n` +
      `const args = process.argv.slice(2);\n` +
      `fs.appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\\n');\n` +
      `process.exit(0);\n`,
    'utf8'
  );
  const uploadRoot = path.join(root, 'upload-root');
  const uploadState = path.join(root, 'upload-state');
  fs.mkdirSync(uploadRoot, { recursive: true });
  const extra = {
    BACKUP_ROOT: uploadRoot,
    BACKUP_STATE_ROOT: uploadState,
    BACKUP_ENCRYPTION_KEY: KEY,
    BACKUP_S3_BUCKET: 'suite-bucket',
    BACKUP_S3_PREFIX: 'flora',
    BACKUP_S3_ENDPOINT: 'https://example.invalid',
    BACKUP_S3_REGION: 'auto',
    BACKUP_AWS_BIN: fakeAws,
    FAKE_AWS_LOG: log,
  };

  const plainRoot = path.join(root, 'upload-plain');
  fs.mkdirSync(plainRoot, { recursive: true });
  const refused = run(['--export', '--upload'], {
    ...extra,
    BACKUP_ROOT: plainRoot,
    BACKUP_ENCRYPTION_KEY: '',
  });
  assert('upload refuses an unencrypted artifact', refused.status === 1 && /unencrypted/.test(refused.out), refused.out.slice(-300));

  const dry = run(['--export', '--encrypt', '--upload', '--dry-run'], extra);
  assert('upload dry run exits 0', dry.status === 0, dry.out.slice(-300));
  assert('dry run makes no aws calls', fs.readFileSync(log, 'utf8').trim() === '');
  assert('dry run names the bucket, prefix and sealed archive', /s3:\/\/suite-bucket\/flora\/flora-backup-/.test(dry.out) && /archive\.fb1/.test(dry.out));

  const real = run(['--export', '--encrypt', '--upload'], extra);
  assert('upload succeeds', real.status === 0, real.out.slice(-500));
  const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assert('upload copies manifest, checksums, archive, completion and a receipt', calls.length === 5, `calls ${calls.length}`);
  assert('upload targets the configured bucket/prefix', calls.every((a) => a.join(' ').includes('s3://suite-bucket/flora/')));
  assert('upload uses the configured endpoint', calls.every((a) => a.includes('--endpoint-url') && a.includes('https://example.invalid')));
  assert('no encryption key or credential is passed on the aws command line', !calls.flat().join(' ').includes(KEY) && !/aws_secret|password/i.test(calls.flat().join(' ')));
  const receiptCall = calls.find((a) => a.join(' ').includes('state/last-backup.json'));
  assert('a latest-backup receipt is uploaded', Boolean(receiptCall));
}

// ── main ───────────────────────────────────────────────────────────────────

async function teardown() {
  // Drop ONLY the two databases this suite named, through the approved cleanup
  // tool (its protected-name, connected-db and pattern guards still apply).
  const baseUri = process.env.MONGO_URI;
  for (const dbName of [SOURCE_DB, DRILL_DB]) {
    const r = spawnSync(
      process.execPath,
      ['scripts/db-footprint.mjs', '--drop-leftovers', `--only=${dbName}`],
      { cwd: BACKEND_DIR, env: { ...process.env, MONGO_URI: baseUri }, encoding: 'utf8', timeout: 120_000 }
    );
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0 && !/Dropped 0 disposable/.test(out)) {
      console.error(`  ⚠ teardown of ${dbName} reported: ${out.trim().slice(-300)}`);
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('BACKUP & INTEGRITY SMOKE');
console.log(`  temporary area: ${root}`);
console.log(`  source database: ${SOURCE_DB} · drill database: ${DRILL_DB}`);

try {
  await seedSource();
  unitTests();
  const plainDir = await exportTests();
  encryptionTests(plainDir);
  await statusTests(plainDir);
  await drillTests(plainDir);
  await alertTests(plainDir);
  pruneTests(plainDir);
  uploadTests();
} catch (err) {
  failed += 1;
  failures.push('suite crashed');
  console.error(`\n✘ suite crashed: ${err.stack || err.message}`);
} finally {
  await teardown();
}

console.log('\n══════════════════════════════════════');
console.log(`BACKUP RESULT: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`failed: ${failures.join(' | ')}`);
  process.exit(1);
}
process.exit(0);
