/**
 * backupArchive — the format and the pure decisions behind `scripts/backup.mjs`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The October 2026 incident had two failures, and only one of them was the
 * deletion: no scheduled recovery point existed, and nothing noticed the shop
 * had become empty. This module holds the parts of the answer that can be
 * checked without a database or a clock:
 *
 *   · the artifact format (Extended-JSON collections + manifest + SHA-256),
 *   · AES-256-GCM encryption for anything that leaves the host,
 *   · "is this backup fresh enough?" as a pure function of timestamps,
 *   · "has the database lost data?" as a pure function of counts + a VERIFIED
 *     baseline (never yesterday's numbers hard-coded as truth),
 *   · and the rule for which artifacts retention may delete.
 *
 * Keeping these pure is deliberate: `scripts/backup-smoke.mjs` can then exercise
 * checksum tampering, staleness, drift and pruning deterministically, while the
 * CLI keeps the I/O (Mongo, filesystem, notifications).
 *
 * AN ARTIFACT LOOKS LIKE THIS
 * ---------------------------
 *   <root>/flora-backup-2026-10-19T02-17-00-000Z/
 *     manifest.json          counts, indexes, per-file SHA-256, recovery point
 *     SHA256SUMS.txt         checksums of the payload files
 *     <collection>.ejson     one extended-JSON document per line, OR
 *     archive.fb1            the same payload, gzipped and AES-256-GCM sealed
 *     .complete.json         written LAST; absence means "interrupted export"
 *
 * Nothing here ever writes to MongoDB, and nothing here prints credentials,
 * hashes or document contents.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { BSON } from 'mongodb';

const EJSON = BSON.EJSON;

export const BACKUP_FORMAT = 'flora-backup/1';
export const MANIFEST_FILE = 'manifest.json';
export const CHECKSUMS_FILE = 'SHA256SUMS.txt';
export const ARCHIVE_FILE = 'archive.fb1';
export const COMPLETE_FILE = '.complete.json';
export const ENCRYPTION_MAGIC = Buffer.from('FLORABK1', 'utf8');
export const ENCRYPTION_MODE = 'aes-256-gcm';
export const MIN_PASSPHRASE_LENGTH = 16;

/** Collections the storefront cannot function without (present, any size). */
export const REQUIRED_COLLECTIONS = [
  'users',
  'products',
  'settings',
  'collections',
  'customers',
  'orders',
  'inventories',
];

/**
 * Baseline drift in one of these is CRITICAL: these are the records whose loss
 * describes the October incident (identities, catalogue, customers, orders).
 * A drop in any other collection is reported as a WARNING.
 */
export const CRITICAL_COLLECTIONS = new Set(['users', 'products', 'customers', 'orders']);

/**
 * Indexes the application relies on. Missing unique indexes are a correctness
 * risk (duplicate identities/slugs/order ids), so they are reported on every
 * integrity run rather than assumed from the model files.
 */
export const REQUIRED_INDEXES = [
  { collection: 'users', name: 'email_1', key: { email: 1 }, unique: true },
  { collection: 'products', name: 'slug_1', key: { slug: 1 }, unique: true },
  { collection: 'orders', name: 'orderId_1', key: { orderId: 1 }, unique: true },
  { collection: 'settings', name: 'key_1', key: { key: 1 }, unique: true },
  { collection: 'collections', name: 'slug_1', key: { slug: 1 }, unique: true },
  { collection: 'inventories', name: 'productSlug_1', key: { productSlug: 1 }, unique: true },
];

export const DEFAULT_MAX_BACKUP_AGE_HOURS = 30;
export const DEFAULT_MAX_DROP_PCT = 25;
export const DEFAULT_MIN_DROP_DOCS = 3;
export const DEFAULT_RETENTION_COUNT = 14;
export const DEFAULT_DRILL_MAX_AGE_DAYS = 30;

// ── hashing / encryption ───────────────────────────────────────────────────

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Derive a 32-byte key. scrypt with a 16-byte random salt per archive, so the
 * same passphrase never produces the same key twice.
 */
function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `backup encryption requires a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters ` +
        '(set BACKUP_ENCRYPTION_KEY).'
    );
  }
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

/**
 * Seal a buffer: magic(8) || salt(16) || iv(12) || tag(16) || ciphertext.
 * GCM authenticates the ciphertext, so a tampered archive fails to open rather
 * than decrypting to garbage that a restore would happily insert.
 */
export function encryptBuffer(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    buffer: Buffer.concat([ENCRYPTION_MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]),
    algorithm: ENCRYPTION_MODE,
    kdf: 'scrypt',
  };
}

export function decryptBuffer(sealed, passphrase) {
  const headerLength = ENCRYPTION_MAGIC.length + 16 + 12 + 16;
  if (!Buffer.isBuffer(sealed) || sealed.length <= headerLength) {
    throw new Error('archive is too short to be a sealed Flora backup');
  }
  if (!sealed.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) {
    throw new Error('archive is not a sealed Flora backup (bad magic)');
  }
  let offset = ENCRYPTION_MAGIC.length;
  const salt = sealed.subarray(offset, (offset += 16));
  const iv = sealed.subarray(offset, (offset += 12));
  const tag = sealed.subarray(offset, (offset += 16));
  const ciphertext = sealed.subarray(offset);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Never echo the underlying OpenSSL message: it is the same for every
    // wrong key, and the only useful statement is that authentication failed.
    throw new Error('could not open the archive: wrong BACKUP_ENCRYPTION_KEY or corrupt file');
  }
}

// ── extended-JSON payloads ─────────────────────────────────────────────────

/** One extended-JSON document per line (the format the recovery tool restores). */
export function encodeCollection(docs) {
  return docs.map((d) => EJSON.stringify(d, { relaxed: false })).join('\n') + (docs.length ? '\n' : '');
}

export function decodeCollection(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const docs = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    docs.push(EJSON.parse(line, { relaxed: false }));
  }
  return docs;
}

/** The newest createdAt/updatedAt-style timestamp in a document set. */
export function newestDocumentTimestamp(docs) {
  let newest = null;
  for (const d of docs) {
    for (const key of ['updatedAt', 'createdAt', 'timestamp', 'sentAt', 'at']) {
      const value = d?.[key];
      if (!value) continue;
      const t = new Date(value);
      if (Number.isNaN(t.getTime())) continue;
      if (!newest || t > newest) newest = t;
    }
  }
  return newest;
}

// ── freshness ──────────────────────────────────────────────────────────────

/**
 * Age of the recovery point, and what it means.
 *
 * healthy  ≤ maxAgeHours
 * warning  > maxAgeHours          (a human must look; one missed run)
 * critical > 2 × maxAgeHours      (the RPO is not being met)
 *
 * An unparseable timestamp is critical: an undated backup cannot be trusted as
 * a recovery point.
 */
export function evaluateFreshness(createdAt, { now = new Date(), maxAgeHours = DEFAULT_MAX_BACKUP_AGE_HOURS } = {}) {
  const t = createdAt ? new Date(createdAt) : null;
  if (!t || Number.isNaN(t.getTime())) {
    return { status: 'critical', ageHours: null, createdAt: null, maxAgeHours, detail: 'no valid recovery-point timestamp' };
  }
  const ageHours = Math.max(0, (now.getTime() - t.getTime()) / 3_600_000);
  let status = 'healthy';
  if (ageHours > maxAgeHours * 2) status = 'critical';
  else if (ageHours > maxAgeHours) status = 'warning';
  return {
    status,
    ageHours: Number(ageHours.toFixed(1)),
    createdAt: t.toISOString(),
    maxAgeHours,
    detail: `recovery point ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h)`,
  };
}

// ── integrity ──────────────────────────────────────────────────────────────

const check = (id, status, detail) => ({ id, status, detail });

/** A key comparison that tolerates order (Mongo reports `{a:1,b:-1}` as given). */
function keysMatch(a, b) {
  const norm = (obj) => JSON.stringify(Object.entries(obj || {}).sort(([x], [y]) => (x < y ? -1 : 1)));
  return norm(a) === norm(b);
}

/**
 * Assess live integrity from data the caller read. Pure: no Mongo client here.
 *
 * Inputs:
 *   counts            {collection: documentCount}
 *   owner             {count, active, hashPresent, fixtureUsers}
 *   visibleProducts   number of storefront-visible products
 *   indexes           {collection: [{name,key,unique}]} for the required collections
 *   baseline          accepted baseline (or null)
 *   backup            {createdAt, verified, verifiedArtifact, incompleteNewer} or null
 *   lastDrill         {completedAt, ok} or null
 *   lastRunAt         previous monitoring run timestamp (or null)
 *   thresholds        {maxAgeHours, maxDropPct, minDropDocs, drillMaxAgeDays, runIntervalHours}
 *   now               Date
 *
 * Returns { status, checks }. Severity is explicit per check; the CLI maps the
 * overall status to an exit code (0/2/1/3) and only ever alerts on non-healthy.
 */
export function evaluateIntegrity({
  counts = {},
  owner = {},
  visibleProducts = 0,
  indexes = {},
  baseline = null,
  backup = null,
  lastDrill = null,
  lastRunAt = null,
  thresholds = {},
  now = new Date(),
} = {}) {
  const maxAgeHours = thresholds.maxAgeHours ?? DEFAULT_MAX_BACKUP_AGE_HOURS;
  const maxDropPct = thresholds.maxDropPct ?? DEFAULT_MAX_DROP_PCT;
  const minDropDocs = thresholds.minDropDocs ?? DEFAULT_MIN_DROP_DOCS;
  const drillMaxAgeDays = thresholds.drillMaxAgeDays ?? DEFAULT_DRILL_MAX_AGE_DAYS;
  const runIntervalHours = thresholds.runIntervalHours ?? 26;
  const checks = [];

  // 1. Essential collections. Presence is not size: an empty `collections`
  //    collection is legitimate (production has one, with zero documents).
  const missing = REQUIRED_COLLECTIONS.filter((c) => !(c in counts));
  checks.push(
    missing.length
      ? check('collections.essential', 'critical', `missing essential collection(s): ${missing.join(', ')}`)
      : check('collections.essential', 'pass', `${REQUIRED_COLLECTIONS.length} essential collections present`)
  );

  // 2. Owner identity. Exactly one, ACTIVE, with a hash — never print the hash.
  if (owner.count !== 1) {
    checks.push(check('identity.owner', 'critical', `owner records: ${owner.count ?? 'unknown'} (expected exactly 1)`));
  } else if (!owner.active) {
    checks.push(check('identity.owner', 'critical', 'the owner record is not ACTIVE'));
  } else if (!owner.hashPresent) {
    checks.push(check('identity.owner', 'critical', 'the owner record has no password hash'));
  } else {
    checks.push(check('identity.owner', 'pass', 'owner present once, ACTIVE, hash present'));
  }
  if ((owner.fixtureUsers ?? 0) > 0) {
    checks.push(check('identity.fixtures', 'warning', `${owner.fixtureUsers} fixture user account(s) present`));
  }

  // 3. Catalogue. A shop with no visible product cannot trade, whatever the
  //    collection count says.
  checks.push(
    visibleProducts > 0
      ? check('catalogue.visible', 'pass', `${visibleProducts} visible product(s)`)
      : check('catalogue.visible', 'critical', 'no storefront-visible products')
  );

  // 4. Indexes. A missing unique index is not data loss, but it lets a duplicate
  //    identity/slug/order id be written, so it is always reported.
  const missingIndexes = [];
  for (const want of REQUIRED_INDEXES) {
    const have = (indexes[want.collection] || []).find((i) => i.name === want.name && keysMatch(i.key, want.key));
    if (!have) missingIndexes.push(`${want.collection}.${want.name}`);
  }
  checks.push(
    missingIndexes.length
      ? check('indexes.required', 'warning', `missing required index(es): ${missingIndexes.join(', ')}`)
      : check('indexes.required', 'pass', `${REQUIRED_INDEXES.length} required indexes present`)
  );

  // 5. Drift against the last OPERATOR-VERIFIED baseline. Growth is normal and
  //    never alerts; a drop is only meaningful relative to the accepted state.
  if (!baseline || !baseline.collections) {
    checks.push(
      check('baseline', 'warning', 'no verified baseline recorded — recorded counts are not being compared')
    );
  } else {
    const drops = [];
    for (const [coll, before] of Object.entries(baseline.collections)) {
      const live = counts[coll] ?? 0;
      const drop = Number(before) - Number(live);
      if (!Number.isFinite(drop) || drop <= 0) continue;
      const pct = Number(before) > 0 ? (drop / Number(before)) * 100 : 100;
      if (drop >= minDropDocs && pct >= maxDropPct) {
        drops.push({
          coll,
          detail: `${coll}: ${before} → ${live} (-${drop}, ${pct.toFixed(0)}%)`,
          severity: CRITICAL_COLLECTIONS.has(coll) ? 'critical' : 'warning',
        });
      }
    }
    const critical = drops.filter((d) => d.severity === 'critical');
    const warning = drops.filter((d) => d.severity === 'warning');
    if (critical.length) {
      checks.push(check('baseline.drop', 'critical', `major reduction in critical collection(s): ${critical.map((d) => d.detail).join('; ')}`));
    } else if (warning.length) {
      checks.push(check('baseline.drop', 'warning', `large reduction(s): ${warning.map((d) => d.detail).join('; ')}`));
    } else {
      checks.push(check('baseline.drop', 'pass', `no collection fell more than ${maxDropPct}% below the ${baseline.acceptedAt} baseline`));
    }
  }

  // 6. Backup freshness. "No verified backup" is critical: that is exactly the
  //    state that made October unrecoverable.
  if (!backup || !backup.verified) {
    checks.push(check('backup.freshness', 'critical', 'no verified backup artifact is available'));
  } else {
    const f = evaluateFreshness(backup.createdAt, { now, maxAgeHours });
    checks.push(check('backup.freshness', f.status, f.detail));
    if (backup.incompleteNewer) {
      checks.push(check('backup.completion', 'warning', 'a newer backup attempt is incomplete (interrupted export)'));
    }
  }

  // 7. Restore drills. A backup nobody has restored is a hypothesis.
  if (!lastDrill) {
    checks.push(check('drill', 'warning', 'no recorded restore drill — the backup has not been proven restorable'));
  } else {
    const t = new Date(lastDrill.completedAt);
    const ageDays = Number.isNaN(t.getTime()) ? Infinity : (now.getTime() - t.getTime()) / 86_400_000;
    if (!lastDrill.ok) {
      checks.push(check('drill', 'critical', `the most recent restore drill FAILED (${lastDrill.completedAt})`));
    } else if (ageDays > drillMaxAgeDays) {
      checks.push(check('drill', 'warning', `last successful restore drill is ${ageDays.toFixed(0)} days old (limit ${drillMaxAgeDays})`));
    } else {
      checks.push(check('drill', 'pass', `last successful restore drill ${ageDays.toFixed(1)} days ago`));
    }
  }

  // 8. Dead-man's switch: if the scheduler stopped, the first run after the gap
  //    must not report healthy as if nothing happened.
  if (lastRunAt) {
    const t = new Date(lastRunAt);
    if (!Number.isNaN(t.getTime())) {
      const gapHours = (now.getTime() - t.getTime()) / 3_600_000;
      if (gapHours > runIntervalHours * 2) {
        checks.push(check('monitor.schedule', 'warning', `previous monitoring run was ${gapHours.toFixed(0)}h ago — the schedule may have stopped`));
      }
    }
  }

  return { status: summarize(checks), checks };
}

/** Overall status: critical > unknown > warning > healthy. */
export function summarize(checks) {
  if (checks.some((c) => c.status === 'critical')) return 'critical';
  if (checks.some((c) => c.status === 'unknown')) return 'unknown';
  if (checks.some((c) => c.status === 'warning')) return 'warning';
  return 'healthy';
}

export const EXIT_FOR_STATUS = { healthy: 0, warning: 2, critical: 1, unknown: 3 };

// ── verification ───────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Verify an artifact directory. Never writes, never connects anywhere.
 *
 * Checks, in the order a restore failure would surface:
 *   1. manifest exists, is ours, and names a database;
 *   2. the completion marker exists (an interrupted export has none);
 *   3. the checksum file matches every payload file that exists;
 *   4. every collection in the manifest has payload (decrypted if sealed);
 *   5. each payload's document count and SHA-256 match the manifest.
 *
 * `files` returns the decoded payloads so a caller can restore or inspect them
 * without reading the artifact twice.
 */
export function verifyArtifact(dir, { passphrase = '', requireEncryption = false } = {}) {
  const problems = [];
  const notes = [];
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, problems: [`${dir}: no ${MANIFEST_FILE} — not a backup artifact`], notes, manifest: null, files: {}, encrypted: false };
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (err) {
    return { ok: false, problems: [`${dir}: manifest is not valid JSON (${err.message})`], notes, manifest: null, files: {}, encrypted: false };
  }
  if (!String(manifest.format || '').startsWith('flora-backup/')) {
    problems.push(`${dir}: manifest format "${manifest.format || '(none)'}" is not a Flora backup`);
  }
  if (!manifest.database) problems.push('manifest does not name its source database');
  const collections = manifest.collections || {};
  if (!Object.keys(collections).length) problems.push('manifest lists no collections');
  if (manifest.documents != null && manifest.documents !== Object.values(collections).reduce((n, c) => n + Number(c.documents || 0), 0)) {
    problems.push('manifest document total does not match its per-collection counts');
  }

  const encrypted = manifest.encryption?.mode === ENCRYPTION_MODE;
  if (requireEncryption && !encrypted) problems.push('artifact is NOT encrypted');
  if (encrypted && !/^aes-256-gcm$/i.test(manifest.encryption?.mode || '')) {
    problems.push(`unsupported encryption mode "${manifest.encryption?.mode}"`);
  }

  if (!fs.existsSync(path.join(dir, COMPLETE_FILE))) {
    problems.push('artifact is INCOMPLETE (no .complete.json — the export did not finish)');
  }

  // 3. checksum file
  const sumsPath = path.join(dir, CHECKSUMS_FILE);
  const sums = new Map();
  if (!fs.existsSync(sumsPath)) {
    problems.push(`missing ${CHECKSUMS_FILE}`);
  } else {
    for (const line of fs.readFileSync(sumsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
      const want = line.slice(0, 64);
      const name = line.slice(66);
      if (!name) continue;
      sums.set(name, want);
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        problems.push(`checksum file lists a missing file: ${name}`);
        continue;
      }
      const got = sha256(fs.readFileSync(file));
      if (got !== want) problems.push(`checksum mismatch: ${name}`);
    }
    if (!sums.size) problems.push('checksum file is empty');
  }

  // 4/5. payload
  const files = {};
  let archive = null;
  if (encrypted) {
    const archivePath = path.join(dir, ARCHIVE_FILE);
    if (!fs.existsSync(archivePath)) {
      problems.push(`missing sealed archive ${ARCHIVE_FILE}`);
    } else {
      const sealed = fs.readFileSync(archivePath);
      if (manifest.archiveSha256 && sha256(sealed) !== manifest.archiveSha256) {
        // Already covered by SHA256SUMS when present; kept as an independent check.
        problems.push('sealed archive does not match manifest.archiveSha256');
      }
      if (!passphrase) {
        problems.push('encrypted artifact: no BACKUP_ENCRYPTION_KEY supplied, so its contents cannot be verified');
      } else {
        try {
          archive = JSON.parse(zlib.gunzipSync(decryptBuffer(sealed, passphrase)).toString('utf8'));
        } catch (err) {
          problems.push(`cannot open encrypted payload: ${err.message}`);
        }
      }
    }
    if (archive?.files) {
      for (const [name, text] of Object.entries(archive.files)) files[name] = text;
      for (const name of Object.keys(collections)) {
        if (!(`${name}.ejson` in files)) problems.push(`sealed archive is missing collection payload ${name}.ejson`);
      }
    }
  } else {
    for (const name of Object.keys(collections)) {
      const file = path.join(dir, `${name}.ejson`);
      if (!fs.existsSync(file)) {
        problems.push(`missing collection payload ${name}.ejson`);
        continue;
      }
      files[`${name}.ejson`] = fs.readFileSync(file, 'utf8');
    }
  }

  for (const [name, spec] of Object.entries(collections)) {
    const text = files[`${name}.ejson`];
    if (text == null) continue;
    const buf = Buffer.from(text, 'utf8');
    if (spec.sha256 && sha256(buf) !== spec.sha256) problems.push(`payload changed since export: ${name}.ejson`);
    if (spec.documents != null) {
      let docs;
      try {
        docs = decodeCollection(text);
      } catch (err) {
        problems.push(`${name}.ejson is not valid extended JSON (${err.message})`);
        continue;
      }
      if (docs.length !== spec.documents) {
        problems.push(`${name}: ${docs.length} document(s) in payload, manifest says ${spec.documents}`);
      }
    }
  }

  if (!problems.length) notes.push(`${Object.keys(collections).length} collections · ${manifest.documents ?? '?'} documents verified`);
  return { ok: problems.length === 0, problems, notes, manifest, files, encrypted };
}

// ── retention ──────────────────────────────────────────────────────────────

/**
 * Which artifacts retention may remove. Only directories this tool created
 * (manifest format + a completed export), never the newest one, never a
 * pre-restore/recovery export, and only beyond `keep`.
 *
 * Returned newest-last so the caller removes the oldest first.
 */
export function selectPrunable(artifacts, keep = DEFAULT_RETENTION_COUNT) {
  const ours = artifacts
    .filter(
      (a) =>
        a.complete &&
        a.format &&
        String(a.format).startsWith('flora-backup/') &&
        // Scheduled artifacts only. A recovery/rollback export (including the
        // pre-restore artifact) is evidence and is never removed by retention,
        // however old it is.
        /^flora-backup-/.test(a.name || '') &&
        !/^pre-restore/i.test(a.name || '')
    )
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (keep < 1) keep = 1;
  const removable = ours.slice(keep);
  // Never remove the newest artifact even if timestamps are malformed.
  if (ours.length) {
    const newest = ours[0];
    return removable.filter((a) => a.path !== newest.path);
  }
  return removable;
}

/** Read every artifact directory under `root`, without trusting its contents. */
export function listArtifacts(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      // An interrupted export leaves `.partial-*`; anything else with payload
      // files but no manifest is reported as unreadable, not silently ignored.
      const hasPayload = fs.readdirSync(dir).some((f) => f.endsWith('.ejson'));
      out.push({
        path: dir,
        name: entry.name,
        partial: entry.name.includes('.partial-') || hasPayload,
        complete: false,
        format: null,
        createdAt: null,
        documents: 0,
        encrypted: false,
        error: hasPayload ? 'directory has payload but no manifest' : null,
      });
      continue;
    }
    let manifest = null;
    try {
      manifest = readJson(manifestPath);
    } catch {
      /* reported below */
    }
    out.push({
      path: dir,
      name: entry.name,
      partial: entry.name.includes('.partial-'),
      complete: fs.existsSync(path.join(dir, COMPLETE_FILE)),
      format: manifest?.format || null,
      createdAt: manifest?.createdAt || null,
      documents: manifest?.documents ?? 0,
      database: manifest?.database || null,
      encrypted: manifest?.encryption?.mode === ENCRYPTION_MODE,
      error: manifest ? null : 'manifest is not valid JSON',
    });
  }
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
