/**
 * migrate-private-media — move PRIVATE media between two roots, safely.
 *
 * WHY THIS EXISTS
 * ---------------
 * The reference and 3D media roots are configurable (`REFERENCE_MEDIA_DIR`,
 * `THREE_MEDIA_ROOT`). Changing the path of a store that already contains files
 * is a data migration, not a config edit: point the variable at a new directory
 * without moving the bytes and every row keeps a `storageKey` that resolves to
 * nothing — which is exactly how rows came to outlive their files.
 *
 * WHAT IT GUARANTEES
 * ------------------
 *   · DRY RUN BY DEFAULT. Without `--apply` it copies nothing and deletes
 *     nothing; it prints the inventory, the conflicts and the totals.
 *   · THE INVENTORY COMES FROM THE DATABASE. Every file it moves is one a row
 *     actually references, so it cannot "helpfully" migrate an unrelated tree.
 *     It also reports files present in the source that NO row references — those
 *     are the previous migration's leftovers or a failed cleanup, and they are
 *     reported, never silently copied or deleted.
 *   · NO OVERWRITE. If the destination already holds a different file at a key,
 *     that is a CONFLICT and the run reports it (nothing is clobbered). If it
 *     holds the SAME bytes, the file is skipped — which is what makes the tool
 *     retry-safe: re-running after an interruption resumes instead of failing.
 *   · VERIFIED. Each copy is sized and SHA-256 hashed on both sides; a mismatch
 *     is a failure that names the file.
 *   · A MANIFEST. Every action is written to a JSON manifest (default:
 *     `audit/private-media-migration-<timestamp>.json`) so what moved, what was
 *     skipped and what was missing is a record, not a memory.
 *
 * ROLLBACK
 * --------
 * Copy-only: the source is never modified or deleted, so "rollback" is leaving
 * the environment variables pointing at the OLD root — the files are still
 * there. Use `--delete-source` only after the new root has been serving
 * successfully for a full deploy cycle.
 *
 * USAGE
 * -----
 *   # preview a migration from the app-directory default into a mounted disk
 *   node scripts/migrate-private-media.mjs \
 *     --kind=reference --from=./reference-media --to=/var/data/flora-alchemy/references
 *
 *   # perform it
 *   node scripts/migrate-private-media.mjs --kind=reference \
 *     --from=./reference-media --to=/var/data/flora-alchemy/references --apply
 *
 * Exit codes: 0 success (or a clean dry run) · 1 verification failure · 2 usage
 * or environment refusal.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { classifyDatabase, describeDatabase } from '../utils/environmentGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(BACKEND_DIR, '.env'), override: false });

const args = process.argv.slice(2);
const arg = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};
const flag = (name) => args.includes(`--${name}`);

const KIND = arg('kind') || 'reference';
const FROM = arg('from') ? path.resolve(arg('from')) : '';
const TO = arg('to') ? path.resolve(arg('to')) : '';
const APPLY = flag('apply');
const DELETE_SOURCE = flag('delete-source');
const MANIFEST =
  arg('manifest') ||
  path.resolve(BACKEND_DIR, '..', 'audit', `private-media-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const log = (...parts) => console.log(...parts);
const fail = (message) => {
  console.error(`\n✘ ${message}`);
  process.exit(2);
};

// ── Argument / environment validation ────────────────────────────────────
if (!['reference', '3d'].includes(KIND)) fail('--kind must be "reference" or "3d".');
if (!FROM || !TO) fail('--from=<dir> and --to=<dir> are both required (absolute paths recommended).');
if (FROM === TO) fail('--from and --to are the same directory; there is nothing to migrate.');
if (DELETE_SOURCE && !APPLY) fail('--delete-source requires --apply (a dry run never deletes).');
if (!process.env.MONGO_URI) fail('MONGO_URI is not set (backend/.env). The inventory comes from the database.');

const dbClass = classifyDatabase();
log('Flora Alchemy — private media migration');
log('────────────────────────────────────────');
log(`  kind            : ${KIND}`);
log(`  from            : ${FROM}`);
log(`  to              : ${TO}`);
log(`  mode            : ${APPLY ? (DELETE_SOURCE ? 'APPLY (+ delete source)' : 'APPLY') : 'DRY RUN (nothing is written)'}`);
let databaseIdentity = '';
try {
  databaseIdentity = describeDatabase();
} catch (err) {
  fail(`Could not describe the target database: ${err.message}`);
}
log(`  database        : ${databaseIdentity}`);
if (!dbClass.disposable) {
  log('  ⚠ this is a NON-disposable database. This tool only ever COPIES media files');
  log('    between directories; it never writes to Mongo and never deletes the source');
  log('    unless you pass --delete-source.');
}

await mongoose
  .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
  .catch((err) => fail(`Could not connect to MongoDB: ${err.message}`));

// ── Inventory: every storage key a ROW points at ─────────────────────────
const keys = new Set();

if (KIND === 'reference') {
  const ProductReferenceImage = (await import('../models/ProductReferenceImage.js')).default;
  const rows = await ProductReferenceImage.find({}).select('original cutout neutral').lean();
  for (const row of rows) {
    for (const kind of ['original', 'cutout', 'neutral']) {
      const key = row?.[kind]?.storageKey;
      if (key) keys.add(key.replace(/\\/g, '/'));
    }
  }
  log(`\n  reference rows  : ${rows.length}`);
} else {
  const Product3DAsset = (await import('../models/Product3DAsset.js')).default;
  const rows = await Product3DAsset.find({}).select('storage').lean();
  for (const row of rows) {
    const glb = row?.storage?.glb?.storageKey;
    const thumbnail = row?.storage?.thumbnail?.storageKey;
    if (glb) keys.add(String(glb).replace(/\\/g, '/'));
    if (thumbnail) keys.add(String(thumbnail).replace(/\\/g, '/'));
  }
  log(`\n  3D asset rows   : ${rows.length}`);
}
log(`  storage keys    : ${keys.size}`);

// ── What is on disk in the source ────────────────────────────────────────
async function walk(dir, base = '') {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return out;
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
    else if (!entry.name.startsWith('.write-probe')) out.push(rel);
  }
  return out;
}

const sourceExists = await fs
  .stat(FROM)
  .then((s) => s.isDirectory())
  .catch(() => false);
if (!sourceExists) {
  log(`\n✘ The source directory does not exist: ${FROM}`);
  log('  Nothing to migrate. If the media is already gone, do NOT re-create empty files —');
  log('  those rows are reported as missing by the API (asset.available === false).');
  process.exit(1);
}

const onDisk = new Set(await walk(FROM));
const missing = [...keys].filter((key) => !onDisk.has(key));
const orphans = [...onDisk].filter((rel) => !keys.has(rel));

log(`  files on disk   : ${onDisk.size}`);
log(`  missing (row points at a file that is NOT in the source): ${missing.length}`);
if (orphans.length) log(`  unreferenced files in the source: ${orphans.length} (reported, never copied)`);

// ── Copy plan ────────────────────────────────────────────────────────────
async function sha256(file) {
  const buf = await fs.readFile(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const manifest = {
  startedAt: new Date().toISOString(),
  kind: KIND,
  from: FROM,
  to: TO,
  apply: APPLY,
  databaseIdentity,
  files: [],
  missing,
  orphans,
  summary: {},
};

let copied = 0;
let skipped = 0;
let conflicts = 0;
let unreadable = 0;

if (APPLY) await fs.mkdir(TO, { recursive: true });

for (const key of keys) {
  const source = path.join(FROM, key);
  const destination = path.join(TO, key);
  const record = { key, action: 'pending' };

  if (!onDisk.has(key)) {
    record.action = 'missing-source';
    manifest.files.push(record);
    continue;
  }

  let sourceStat;
  try {
    sourceStat = await fs.stat(source);
  } catch (err) {
    record.action = 'unreadable';
    record.error = err.code || err.message;
    unreadable += 1;
    manifest.files.push(record);
    continue;
  }

  const sourceHash = await sha256(source).catch(() => null);
  record.bytes = sourceStat.size;
  record.sha256 = sourceHash;

  const destinationStat = await fs.stat(destination).catch(() => null);
  if (destinationStat) {
    const destinationHash = await sha256(destination).catch(() => null);
    if (destinationHash && sourceHash && destinationHash === sourceHash) {
      record.action = 'already-present';
      skipped += 1;
      manifest.files.push(record);
      continue; // retry-safe: a complete file is never re-copied
    }
    record.action = 'conflict';
    record.destinationSha256 = destinationHash;
    conflicts += 1;
    manifest.files.push(record);
    continue; // never overwrite
  }

  if (!APPLY) {
    record.action = 'would-copy';
    copied += 1;
    manifest.files.push(record);
    continue;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  const destinationStat2 = await fs.stat(destination);
  const destinationHash = await sha256(destination);
  if (destinationStat2.size !== sourceStat.size || destinationHash !== sourceHash) {
    record.action = 'verify-failed';
    record.destinationBytes = destinationStat2.size;
    record.destinationSha256 = destinationHash;
    manifest.files.push(record);
    console.error(`✘ verification failed for ${key} — the copy does NOT match the source.`);
    await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2)).catch(() => {});
    await mongoose.connection.close(false).catch(() => {});
    process.exit(1);
  }
  record.action = 'copied';
  copied += 1;
  manifest.files.push(record);
}

manifest.summary = {
  keys: keys.size,
  copied: APPLY ? copied : 0,
  wouldCopy: APPLY ? 0 : copied,
  alreadyPresent: skipped,
  conflicts,
  unreadable,
  missingSource: missing.length,
  unreferencedInSource: orphans.length,
  finishedAt: new Date().toISOString(),
};

await fs.mkdir(path.dirname(MANIFEST), { recursive: true }).catch(() => {});
await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2)).catch(() => {});

log('\n  summary');
for (const [k, v] of Object.entries(manifest.summary)) log(`    ${k.padEnd(22)} ${v}`);
log(`\n  manifest: ${MANIFEST}`);

if (conflicts) {
  log('\n  ⚠ CONFLICTS: the destination already holds different bytes at those keys.');
  log('    Nothing was overwritten. Resolve them deliberately (they are listed with both hashes');
  log('    in the manifest) before switching the root.');
}

// ── Source deletion: opt-in, and only for files that verified ────────────
if (APPLY && DELETE_SOURCE) {
  let removed = 0;
  for (const record of manifest.files) {
    if (record.action !== 'already-present' && record.action !== 'copied') continue;
    const destination = path.join(TO, record.key);
    const destinationHash = await sha256(destination).catch(() => null);
    if (!destinationHash || destinationHash !== record.sha256) continue; // verify AGAIN before deleting
    await fs.rm(path.join(FROM, record.key), { force: true }).catch(() => {});
    removed += 1;
  }
  log(`\n  deleted ${removed} verified source file(s). The source directories were left in place.`);
}

await mongoose.connection.close(false).catch(() => {});

if (conflicts || unreadable) {
  log('\n  NOT a clean migration — see the manifest. Nothing was overwritten.');
  process.exit(1);
}
log(APPLY ? '\n✔ migration complete and verified.' : '\n✔ dry run complete — nothing was written. Add --apply to perform it.');
process.exit(0);
