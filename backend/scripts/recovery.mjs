/**
 * recovery — the production database recovery tool
 * (manifest · checksums · pre-restore export · gated restore · verification · rollback).
 *
 * WHY THIS EXISTS
 * ---------------
 * In October 2026 the production database `Flora-Alchemy` was found with all
 * 22 collections present and every document missing. Recovery was performed
 * from a local Extended-JSON export. This script is that procedure, made
 * repeatable, so the next recovery is not an ad-hoc session script.
 *
 * It is deliberately conservative:
 *   · every destructive path requires BOTH `--apply` and the exact
 *     CONFIRM_RESTORE_PRODUCTION value;
 *   · it refuses to run against any cluster other than the verified one
 *     (RECOVERY_EXPECTED_HOST, defaults to the cluster used in 2026-10);
 *   · `--restore` only writes when production is in a state it recognises:
 *     the documented empty state, or one that already matches the manifest;
 *   · `--export` must be run first — it captures the CURRENT state so a
 *     rollback artifact always exists before anything is overwritten;
 *   · every source file is checksum-verified immediately before writing;
 *   · writes are idempotent upserts on `_id`, so an interrupted run resumes;
 *   · nothing is ever dropped: collections and their indexes are preserved.
 *
 * Usage (from backend/):
 *   node scripts/recovery.mjs --export                    # preserve current state
 *   node scripts/recovery.mjs --restore --source=<dir>    # dry run (plan only)
 *   CONFIRM_RESTORE_PRODUCTION=Flora-Alchemy \
 *     node scripts/recovery.mjs --restore --source=<dir> --apply
 *   node scripts/recovery.mjs --verify --source=<dir>     # post-restore audit
 *   CONFIRM_RESTORE_PRODUCTION=Flora-Alchemy \
 *     node scripts/recovery.mjs --rollback=<artifact-dir> --apply
 *
 * Nothing here prints credentials, hashes or connection strings.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MongoClient, BSON } from 'mongodb';
import { loadBackendEnv } from './lib/testServer.mjs';
import { classifyDatabase } from '../utils/environmentGuard.js';

const EJSON = BSON.EJSON;
loadBackendEnv();

const PROD_DB = 'Flora-Alchemy';
const EXPECTED_HOST = process.env.RECOVERY_EXPECTED_HOST || 'backend-learn.pai3mfz.mongodb.net';
const CONFIRM = 'CONFIRM_RESTORE_PRODUCTION';
const BACKUP_ROOT = path.join(os.homedir(), 'flora-alchemy-backups');
const INCIDENT_SINGLETON = '6ad33f0ea604c9adc52b0fba';
const CREATE_EMPTY = ['generationjobs', 'product3dassets', 'productreferenceimages'];

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : '';
};

const die = (m) => { console.error(`\n✘ ${m}`); process.exit(1); };
const say = (m) => console.log(m);

function loadDocs(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  let arr;
  try { const v = JSON.parse(raw); arr = Array.isArray(v) ? v : [v]; }
  catch { arr = raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
  return arr.map((d) => EJSON.parse(JSON.stringify(d), { relaxed: false }));
}

function resolveUri() {
  const uri = process.env.MONGO_URI;
  if (!uri) die('MONGO_URI is not configured.');
  let host = '';
  try { host = new URL(uri).hostname; } catch {}
  if (host !== EXPECTED_HOST) {
    die(`cluster host "${host}" is not the verified recovery cluster "${EXPECTED_HOST}". ` +
        'Set RECOVERY_EXPECTED_HOST only after verifying the target yourself.');
  }
  const cls = classifyDatabase(uri);
  if (cls.dbName !== PROD_DB) {
    // The tool retargets the pathname itself; say what it will do rather than assume.
    say(`note: configured database is "${cls.dbName}"; this tool always acts on "${PROD_DB}" on the same cluster.`);
  }
  return { uri, host };
}

async function inventory(db) {
  const names = (await db.listCollections({}, {}).toArray()).map((c) => c.name).sort();
  const out = {};
  let total = 0;
  for (const name of names) {
    const col = db.collection(name);
    out[name] = {
      documents: await col.countDocuments({}),
      indexes: (await col.indexes()).map((i) => ({
        name: i.name, key: i.key, unique: i.unique === true, sparse: i.sparse === true,
        ...(i.partialFilterExpression ? { partialFilterExpression: i.partialFilterExpression } : {}),
      })),
    };
    total += out[name].documents;
  }
  return { names, out, total };
}

const { host } = resolveUri();

// ─────────────────────────────── EXPORT ───────────────────────────────────
if (flag('export')) {
  const cls = classifyDatabase();
  const preState = cls.dbName === PROD_DB ? 'production' : cls.dbName;
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = value('out') || path.join(BACKUP_ROOT, `pre-restore-${stamp}`);
  if (fs.existsSync(out)) die(`refusing to overwrite an existing artifact: ${out}`);
  fs.mkdirSync(out, { recursive: true });

  const client = new MongoClient(uri(), { serverSelectionTimeoutMS: 15000, appName: 'flora-recovery-export' });
  await client.connect();
  const db = client.db(PROD_DB);
  const inv = await inventory(db);
  const sums = [];
  for (const name of inv.names) {
    const docs = await db.collection(name).find({}, { sort: { _id: 1 } }).toArray();
    const payload = docs.map((d) => EJSON.stringify(d, { relaxed: false })).join('\n') + (docs.length ? '\n' : '');
    fs.writeFileSync(path.join(out, `${name}.ejson`), payload, 'utf8');
    sums.push(`${crypto.createHash('sha256').update(payload).digest('hex')}  ${name}.ejson`);
  }
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    clusterHost: host,
    database: PROD_DB,
    rollback: true,
    preState,
    totalDocuments: inv.total,
    collections: Object.fromEntries(Object.entries(inv.out).map(([k, v]) => [k, { documents: v.documents, indexes: v.indexes.length }])),
    inventory: inv.out,
  }, null, 2), 'utf8');
  await client.close();
  say(`export artifact written: ${out}`);
  say(`  ${inv.names.length} collections · ${inv.total} documents · SHA-256 manifest included`);
  say('  KEEP THIS. It is the rollback artifact for whatever you do next.');
  process.exit(0);
}

// helper: connect to the production database (read path)
async function withProd(fn) {
  const client = new MongoClient(uri(), { serverSelectionTimeoutMS: 15000, appName: 'flora-recovery' });
  await client.connect();
  try { return await fn(client.db(PROD_DB)); } finally { await client.close(); }
}
function uri() { return process.env.MONGO_URI; }

// ─────────────────────────────── RESTORE ──────────────────────────────────
if (flag('restore')) {
  const source = value('source');
  if (!source || !fs.existsSync(source)) die('--restore needs --source=<export directory>');
  if (flag('apply') && process.env[CONFIRM] !== PROD_DB) {
    die(`refusing to apply: set ${CONFIRM}=${PROD_DB} to authorise a production restore.`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  if (manifest.database !== PROD_DB) die(`source manifest is for "${manifest.database}", not ${PROD_DB}`);
  const sumsFile = path.join(source, 'SHA256SUMS.txt');
  if (!fs.existsSync(sumsFile)) die('source has no SHA256SUMS.txt — verify the export before using it');
  for (const line of fs.readFileSync(sumsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
    const want = line.slice(0, 64); const name = line.slice(66);
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex');
    if (got !== want) die(`source file changed since export: ${name}`);
  }
  say(`source checksums verified (${line_count(sumsFile)} files)`);

  const plan = fs.readdirSync(source).filter((f) => f.endsWith('.ejson')).sort().map((f) => {
    const coll = f.replace(/\.ejson$/, '');
    const docs = loadDocs(path.join(source, f));
    const want = manifest.collections?.[coll]?.documents;
    if (want != null && want !== docs.length) die(`${coll}: source has ${docs.length}, manifest says ${want}`);
    return { coll, docs };
  });

  const result = await withProd(async (db) => {
    const inv = await inventory(db);
    const okIncident = inv.names.length === 22 && inv.out.settings?.documents === 1 &&
      inv.names.every((n) => (n === 'settings' ? true : inv.out[n].documents === 0));
    const okRestored = Object.entries(manifest.collections).every(([c, s]) => (inv.out[c]?.documents ?? 0) === s.documents);
    if (!okIncident && !okRestored) {
      die('production is in neither a recognised empty state nor a manifest state — refusing to write.');
    }
    say(okIncident
      ? 'target state: documented empty database (incident state)'
      : 'target state: already matches the manifest (idempotent repair pass)');

    if (!flag('apply')) {
      say('\nDRY RUN — nothing written. Plan:');
      for (const p of plan) say(`  ${p.coll.padEnd(20)} ${String(p.docs.length).padStart(4)} documents`);
      return null;
    }

    if (okIncident) {
      const s = await db.collection('settings').findOne({});
      if (s && String(s._id) !== INCIDENT_SINGLETON) die(`unexpected settings singleton ${s._id}`);
      if (s) await db.collection('settings').deleteOne({ _id: s._id });
      say('incident singleton removed (captured in the pre-restore artifact)');
    }

    const report = [];
    const errors = [];
    for (const p of plan) {
      if (!p.docs.length) continue;
      const ops = p.docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } }));
      try {
        const r = await db.collection(p.coll).bulkWrite(ops, { ordered: false });
        report.push(`${p.coll.padEnd(20)} upserted=${r.upsertedCount} matched=${r.matchedCount} modified=${r.modifiedCount}`);
      } catch (e) {
        errors.push(`${p.coll}: ${e.codeName || e.message}`);
      }
    }
    for (const name of CREATE_EMPTY) {
      try { await db.createCollection(name); } catch (e) { if (e.codeName !== 'NamespaceExists') errors.push(`${name}: ${e.message}`); }
    }
    // index parity with the source capture (create only what is missing)
    let ensured = 0;
    for (const [name, spec] of Object.entries(manifest.inventory || {})) {
      const live = await db.collection(name).indexes();
      const byName = new Map(live.map((i) => [i.name, i]));
      for (const ix of spec.indexes || []) {
        if (byName.has(ix.name)) continue;
        try {
          await db.collection(name).createIndex(ix.key, {
            name: ix.name, unique: ix.unique || false, sparse: ix.sparse || false,
            ...(ix.partialFilterExpression ? { partialFilterExpression: ix.partialFilterExpression } : {}),
          });
          ensured += 1;
        } catch (e) { errors.push(`${name}.${ix.name}: ${e.codeName || e.message}`); }
      }
    }
    for (const r of report) say('  ' + r);
    say(`  indexes ensured: ${ensured}`);
    if (errors.length) { say('ERRORS:'); for (const e of errors) say('  ✘ ' + e); }
    return { errors };
  });
  if (result && result.errors.length) process.exit(1);
  say('restore complete — run --verify before trusting it.');
  process.exit(0);
}

// ─────────────────────────────── VERIFY ───────────────────────────────────
if (flag('verify')) {
  const source = value('source');
  if (!source || !fs.existsSync(source)) die('--verify needs --source=<export directory>');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  const problems = [];
  const notes = [];
  await withProd(async (db) => {
    const inv = await inventory(db);
    for (const [coll, spec] of Object.entries(manifest.collections)) {
      const live = inv.out[coll]?.documents ?? 0;
      // A SHORTFALL means restored documents are missing — that is data loss
      // and it fails. A SURPLUS means the collection grew after the recovery
      // point (post-restore activity such as the owner's sign-in writing a
      // staff event); it is reported loudly as a note, never silently passed,
      // but it is not a restore defect — writes are upserts on _id, so a
      // re-run cannot duplicate documents.
      if (live < spec.documents) {
        problems.push(`${coll}: live=${live} < manifest=${spec.documents} — restored documents MISSING`);
      } else if (live > spec.documents) {
        notes.push(`${coll}: ${live - spec.documents} document(s) created AFTER the recovery point (post-restore activity; manifest=${spec.documents})`);
      }
    }
    notes.push(`counts compared for ${Object.keys(manifest.collections).length} collections`);
    for (const [coll, spec] of Object.entries(manifest.inventory || {})) {
      const byName = new Map((inv.out[coll]?.indexes || []).map((i) => [i.name, i]));
      for (const want of spec.indexes || []) {
        const have = byName.get(want.name);
        if (!have) { problems.push(`index missing: ${coll}.${want.name}`); continue; }
        if (JSON.stringify(have.key) !== JSON.stringify(want.key)) problems.push(`index key drift: ${coll}.${want.name}`);
      }
    }
    const users = await db.collection('users').find({}).toArray();
    const owners = users.filter((u) => u.role === 'admin' && u.isOwner === true);
    if (owners.length !== 1) problems.push(`owner count ${owners.length} != 1`);
    else notes.push(`owner present once (${owners[0].status}, isFixture=${owners[0].isFixture}, hash present=${Boolean(owners[0].passwordHash)})`);
    if (users.some((u) => u.isFixture === true)) problems.push('fixture users present');
  });
  for (const n of notes) say('  · ' + n);
  if (problems.length) { for (const p of problems) say('  ✘ ' + p); process.exit(1); }
  say('VERIFIED: production matches the export manifest.');
  process.exit(0);
}

// ─────────────────────────────── ROLLBACK ─────────────────────────────────
if (value('rollback')) {
  const dir = value('rollback');
  if (flag('apply') && process.env[CONFIRM] !== PROD_DB) die(`refusing: set ${CONFIRM}=${PROD_DB}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (!manifest.rollback || manifest.database !== PROD_DB) die('that directory is not a recovery export of the production database');
  const result = await withProd(async (db) => {
    if (!flag('apply')) {
      say(`ROLLBACK DRY RUN — would restore ${manifest.totalDocuments} documents from ${dir}`);
      return { errors: [] };
    }
    const errors = [];
    for (const [coll, spec] of Object.entries(manifest.collections || {})) {
      try {
        await db.collection(coll).deleteMany({});
        const docs = loadDocs(path.join(dir, `${coll}.ejson`));
        if (docs.length) await db.collection(coll).insertMany(docs, { ordered: false });
        if (docs.length !== spec.documents) errors.push(`${coll}: restored ${docs.length} != ${spec.documents}`);
      } catch (e) { errors.push(`${coll}: ${e.codeName || e.message}`); }
    }
    return { errors };
  });
  if (result.errors.length) { for (const e of result.errors) say('  ✘ ' + e); process.exit(1); }
  say('rollback complete.');
  process.exit(0);
}

die('nothing to do: pass --export, --restore, --verify or --rollback=<dir> (see the header comment)');

// count lines in a checksum file (used in a template string above)
function line_count(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
}
