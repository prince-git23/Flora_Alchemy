/**
 * recovery-sources — READ-ONLY investigation of every recovery artifact, and
 * the dry-run diff that must exist before any incremental production merge.
 *
 * WHY THIS EXISTS
 * ---------------
 * After the October 2026 restore we knew what the October 5 export contained,
 * but not whether anything newer existed: a settings-only export, a pre-reset
 * bundle in %TEMP%, the inspection copy `Flora-Alchemy-Recovery-Scratch`, and
 * whatever else a machine happened to hold. Answering "is there anything from
 * the gap?" by hand invites two mistakes — comparing counts only (a changed
 * document is invisible) and treating a stale copy as authoritative.
 *
 * This tool answers it the safe way and NEVER WRITES:
 *
 *   · it verifies a source's own manifest and SHA-256 checksums;
 *   · it dates the source from the manifest, the bundle header and the newest
 *     document timestamp — the three can disagree, and that disagreement is
 *     itself evidence;
 *   · it compares by `_id`, not by count, and classifies every difference as
 *     INSERT (source-only), CONFLICT (both, source newer), STALE (both, live
 *     newer — must never be applied) or LIVE-ONLY;
 *   · it reports fixture and credential-bearing documents explicitly, because
 *     both disqualify a source from being restored into production.
 *
 * Usage (from backend/):
 *   node scripts/recovery-sources.mjs                       # inventory only
 *   node scripts/recovery-sources.mjs --compare=<dir>       # dry-run diff vs production
 *   node scripts/recovery-sources.mjs --bundle=<file.json>  # %TEMP% pre-reset bundle
 *   node scripts/recovery-sources.mjs --db=Flora-Alchemy-Recovery-Scratch --compare=<dir>
 *
 * Exit codes: 0 = report produced, 1 = a source failed its own checksums.
 * It never prints e-mail addresses, password hashes or connection strings.
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
const BACKUP_ROOT = path.join(os.homedir(), 'flora-alchemy-backups');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : '';
};
const targetDb = argOf('db') || PROD_DB;
const compareDir = argOf('compare');
const bundleFile = argOf('bundle');

const say = (m = '') => console.log(m);
const mask = (v) => (v ? `${String(v).slice(0, 2)}…@…` : '<none>');
const day = (v) => (v ? String(v).slice(0, 10) : '?');

/**
 * Read a collection file in any of the shapes this project has produced:
 *   · a JSON array of documents (the recovery export),
 *   · one document per line (extended JSON),
 *   · a pretty-printed array/object, with or without `#` comment lines
 *     (the hand-made settings-only export of 2026-10-06 starts with one).
 * Comments are stripped first, then top-level JSON values are split by
 * bracket depth so a pretty-printed document is not mistaken for several.
 */
function readDocs(file) {
  const text = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .trim();
  if (!text) return [];

  const values = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        values.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const arr = [];
  for (const chunk of values) {
    try {
      const v = JSON.parse(chunk);
      if (Array.isArray(v)) arr.push(...v);
      else arr.push(v);
    } catch {
      // Not valid JSON on its own (e.g. a comment-split fragment): skip rather
      // than abort the whole investigation over one unreadable file.
    }
  }
  return arr.map((d) => EJSON.parse(JSON.stringify(d), { relaxed: false }));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Verify an export directory against its checksum file. Two layouts exist in
 * this project: `SHA256SUMS.txt` inside the artifact (written by the recovery
 * tool) and `SHA256SUMS-<stamp>.txt` beside it (the original October 5 export).
 */
function verifyChecksums(dir) {
  const inside = path.join(dir, 'SHA256SUMS.txt');
  const beside = fs
    .readdirSync(path.dirname(dir))
    .filter((f) => f.startsWith(`SHA256SUMS-${path.basename(dir)}`))
    .map((f) => path.join(path.dirname(dir), f));
  const file = fs.existsSync(inside) ? inside : beside[0];
  if (!file) return { status: 'no checksum file', checked: 0, failed: [] };
  const failed = [];
  let checked = 0;
  for (const line of fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
    const want = line.slice(0, 64);
    const name = line.slice(66);
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) {
      failed.push(`${name}: missing`);
      continue;
    }
    checked += 1;
    if (sha256(fs.readFileSync(target)) !== want) failed.push(`${name}: checksum mismatch`);
  }
  return { status: failed.length ? 'FAILED' : 'verified', checked, failed };
}

/** The newest createdAt/updatedAt anywhere in a document set. */
function newestTimestamp(docs) {
  let newest = null;
  for (const d of docs) {
    for (const k of ['updatedAt', 'createdAt', 'timestamp', 'sentAt', 'at']) {
      const v = d?.[k];
      if (!v) continue;
      const t = new Date(v);
      if (Number.isNaN(t.getTime())) continue;
      if (!newest || t > newest) newest = t;
    }
  }
  return newest;
}

function describeDir(dir) {
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ejson'));
  const perColl = {};
  let docsTotal = 0;
  let newest = null;
  let fixtures = 0;
  let withHashes = 0;
  const fixtureByCollection = {};
  const credentialByCollection = {};
  for (const f of files) {
    const coll = f.replace(/\.ejson$/, '');
    const docs = readDocs(path.join(dir, f));
    perColl[coll] = docs.length;
    docsTotal += docs.length;
    const fx = docs.filter((d) => d?.isFixture === true).length;
    const cr = docs.filter((d) => d?.passwordHash || d?.password).length;
    if (fx) fixtureByCollection[coll] = fx;
    if (cr) credentialByCollection[coll] = cr;
    fixtures += fx;
    withHashes += cr;
    const t = newestTimestamp(docs);
    if (t && (!newest || t > newest)) newest = t;
  }
  const checks = verifyChecksums(dir);
  return {
    kind: 'export-directory',
    path: dir,
    database: manifest?.database || '(no manifest)',
    declaredRecoveryPoint: manifest?.createdAt || null,
    manifestCollections: manifest ? Object.keys(manifest.collections || {}).length : 0,
    manifestDocuments: manifest?.totalDocuments ?? null,
    files: files.length,
    documents: docsTotal,
    newestDocumentTimestamp: newest,
    fixtureDocuments: fixtures,
    fixtureByCollection,
    documentsWithCredentials: withHashes,
    credentialByCollection,
    checksum: checks,
    perCollection: perColl,
    manifest,
  };
}

function describeBundle(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const colls = raw.collections || {};
  const perColl = {};
  let docsTotal = 0;
  let newest = null;
  let fixtures = 0;
  let withHashes = 0;
  const fixtureByCollection = {};
  const credentialByCollection = {};
  for (const [coll, arr] of Object.entries(colls)) {
    const docs = Array.isArray(arr) ? arr : [];
    perColl[coll] = docs.length;
    docsTotal += docs.length;
    const fx = docs.filter((d) => d?.isFixture === true).length;
    const cr = docs.filter((d) => d?.passwordHash || d?.password).length;
    if (fx) fixtureByCollection[coll] = fx;
    if (cr) credentialByCollection[coll] = cr;
    fixtures += fx;
    withHashes += cr;
    const t = newestTimestamp(docs);
    if (t && (!newest || t > newest)) newest = t;
  }
  return {
    kind: 'pre-reset-bundle',
    path: file,
    database: raw.database || '(none)',
    declaredRecoveryPoint: raw.createdAt || null,
    files: Object.keys(perColl).length,
    documents: docsTotal,
    newestDocumentTimestamp: newest,
    fixtureDocuments: fixtures,
    fixtureByCollection,
    documentsWithCredentials: withHashes,
    credentialByCollection,
    checksum: { status: 'not applicable (single JSON bundle)', checked: 0, failed: [] },
    perCollection: perColl,
  };
}

function printSource(s) {
  say(`\n  ${s.kind === 'export-directory' ? 'DIRECTORY' : 'BUNDLE'}  ${s.path}`);
  say(`    database              ${s.database}`);
  say(`    declared recovery pt  ${s.declaredRecoveryPoint || '?'}`);
  say(`    newest document       ${s.newestDocumentTimestamp ? s.newestDocumentTimestamp.toISOString() : '?'}`);
  say(`    collections / docs    ${s.files} / ${s.documents}${s.manifestDocuments != null ? ` (manifest says ${s.manifestDocuments})` : ''}`);
  say(`    checksums             ${s.checksum.status}${s.checksum.checked ? ` (${s.checksum.checked} files)` : ''}`);
  const byColl = (o) => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  say(`    fixture documents     ${s.fixtureDocuments}${s.fixtureDocuments ? ` (${byColl(s.fixtureByCollection)})` : ''}`);
  say(`    docs with credentials ${s.documentsWithCredentials}${s.documentsWithCredentials ? ` (${byColl(s.credentialByCollection)}) — sensitive` : ''}`);
  if (s.manifestDocuments != null && s.manifestDocuments !== s.documents) {
    say(`    ✘ manifest/document mismatch: manifest ${s.manifestDocuments}, files ${s.documents}`);
  }
  for (const f of s.checksum.failed) say(`    ✘ ${f}`);
}

/** Dry-run diff of a source against the live target database. Never writes. */
async function compare(source, client) {
  const db = client.db(targetDb);
  const collections = Object.keys(source.perCollection);
  const rows = [];
  let inserts = 0;
  let conflicts = 0;
  let stale = 0;
  let liveOnly = 0;
  let missingCollections = 0;

  for (const coll of collections) {
    const sourceDocs = source.docsByCollection[coll] || [];
    if (!sourceDocs.length) continue;
    const known = await db.listCollections({ name: coll }).toArray();
    if (!known.length) missingCollections += 1;
    const liveDocs = known.length
      ? await db.collection(coll).find({}, { projection: { _id: 1, updatedAt: 1, createdAt: 1 } }).toArray()
      : [];
    const liveById = new Map(liveDocs.map((d) => [String(d._id), d]));
    const sourceIds = new Set(sourceDocs.map((d) => String(d._id)));
    let collInserts = 0;
    let collConflicts = 0;
    let collStale = 0;
    for (const d of sourceDocs) {
      const id = String(d._id);
      const live = liveById.get(id);
      if (!live) {
        // `settings` is never merged document-by-document: it is a workspace
        // singleton addressed by `key`, and a stray insert would create a
        // second settings document that no endpoint reads. Reported, never
        // counted as a merge candidate.
        if (coll !== 'settings') collInserts += 1;
        continue;
      }
      const st = d.updatedAt ? new Date(d.updatedAt) : d.createdAt ? new Date(d.createdAt) : null;
      const lt = live.updatedAt ? new Date(live.updatedAt) : live.createdAt ? new Date(live.createdAt) : null;
      if (st && lt && st > lt) collConflicts += 1;
      else collStale += 1;
    }
    const collLiveOnly = liveDocs.filter((d) => !sourceIds.has(String(d._id))).length;
    inserts += collInserts;
    conflicts += collConflicts;
    stale += collStale;
    liveOnly += collLiveOnly;
    rows.push({ coll, source: sourceDocs.length, live: liveDocs.length, collInserts, collConflicts, collStale, collLiveOnly });
  }

  say(`\nDRY RUN — source vs live "${targetDb}" (nothing is written)`);
  say('  collection            source   live   insert  conflict  stale  live-only');
  for (const r of rows) {
    say(
      `  ${r.coll.padEnd(20)} ${String(r.source).padStart(6)} ${String(r.live).padStart(6)} ` +
        `${String(r.collInserts).padStart(7)} ${String(r.collConflicts).padStart(9)} ` +
        `${String(r.collStale).padStart(6)} ${String(r.collLiveOnly).padStart(10)}`
    );
  }
  say('  ——————————————————————————————————————————————————————————————————————');
  say(
    `  INSERT candidates ${inserts} · CONFLICTS (source newer) ${conflicts} · ` +
      `STALE (live newer — never apply) ${stale} · live-only ${liveOnly}`
  );
  if (rows.some((r) => r.coll === 'settings' && r.source !== r.live)) {
    say('  note: settings is merged by `key`, never by _id — settings rows above are informational');
  }
  if (missingCollections) say(`  note: ${missingCollections} source collection(s) do not exist live`);

  const verdict = [];
  if (!source.docsByCollection || !Object.keys(source.docsByCollection).length) verdict.push('source is empty');
  // The settings singleton is written by the seed and legitimately carries
  // `isFixture: true`; that is normal state, not demo business data.
  const businessFixtures = Object.entries(source.fixtureByCollection || {})
    .filter(([coll]) => coll !== 'settings')
    .reduce((n, [, c]) => n + c, 0);
  if (businessFixtures > 0) {
    verdict.push(`contains ${businessFixtures} fixture business document(s) — a restore would reintroduce demo data`);
  }
  if (source.documentsWithCredentials > 0) verdict.push('contains credential fields — plaintext-sensitive artifact');
  if (source.newestDocumentTimestamp && source.newestDocumentTimestamp < new Date('2026-10-05T00:00:00Z')) {
    verdict.push('newest document predates the October 5 recovery point — it cannot fill the gap');
  }
  const newerThanLive = rows.some((r) => r.collConflicts > 0);
  if (newerThanLive) verdict.push('some documents are NEWER than live — review field-by-field before any merge');
  // No shared _id at all means this is not a delta: importing it would create a
  // parallel population (duplicate customers, orders, inventory) rather than
  // recover the missing rows of the live one.
  if (inserts > 0 && conflicts + stale === 0) {
    verdict.push('shares no document _id with live — it is a parallel dataset, not an incremental delta');
  }

  say('\n  VERDICT');
  if (!verdict.length) say('    no incremental value detected: every source document is already live (or older).');
  else for (const v of verdict) say(`    · ${v}`);
  return { inserts, conflicts, stale, verdict };
}

function loadSourceDir(dir) {
  const s = describeDir(dir);
  s.docsByCollection = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ejson'))) {
    s.docsByCollection[f.replace(/\.ejson$/, '')] = readDocs(path.join(dir, f));
  }
  return s;
}

function loadBundle(file) {
  const s = describeBundle(file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.docsByCollection = Object.fromEntries(
    Object.entries(raw.collections || {}).map(([k, v]) => [k, Array.isArray(v) ? v : []])
  );
  return s;
}

// ─────────────────────────────── inventory ────────────────────────────────
say('RECOVERY SOURCES — READ-ONLY INVENTORY');
say(`live target for comparisons: "${targetDb}" on the configured cluster`);
say('no credentials, hashes or connection strings are printed; e-mail addresses are masked');

const sources = [];
if (fs.existsSync(BACKUP_ROOT)) {
  for (const name of fs.readdirSync(BACKUP_ROOT).sort()) {
    const dir = path.join(BACKUP_ROOT, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!fs.readdirSync(dir).some((f) => f.endsWith('.ejson') || f === 'manifest.json')) continue;
    sources.push(loadSourceDir(dir));
  }
} else {
  say(`\n  (no ${BACKUP_ROOT})`);
}

if (bundleFile) sources.push(loadBundle(bundleFile));
for (const s of sources) printSource(s);

let exitCode = 0;
for (const s of sources) if (s.checksum.failed?.length) exitCode = 1;

if (!sources.length && !compareDir && !bundleFile) {
  say('\nNo artifacts found. Nothing to compare.');
  process.exit(exitCode);
}

// ─────────────────────────────── comparison ───────────────────────────────
if (compareDir || bundleFile) {
  const cls = classifyDatabase(process.env.MONGO_URI);
  if (/prod|Flora-Alchemy$/i.test(targetDb) && cls.host && !cls.localHost) {
    say(`\n  read-only comparison against "${targetDb}" (remote host; no writes are possible in this tool)`);
  }
  const client = new MongoClient(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
    appName: 'flora-recovery-sources',
  });
  await client.connect();
  try {
    // Only compare what the operator asked about: the named directory, or the
    // named bundle. Falling back to "every artifact" would bury the one answer
    // that matters under three unrelated ones.
    const selected = compareDir
      ? sources.filter((s) => path.resolve(s.path) === path.resolve(compareDir))
      : bundleFile
        ? sources.filter((s) => s.kind === 'pre-reset-bundle')
        : sources;
    if (!selected.length) say(`\n  (no source matching ${compareDir || bundleFile})`);
    for (const s of selected) {
      say(`\n════════ ${path.basename(s.path)} ════════`);
      await compare(s, client);
    }
  } finally {
    await client.close();
  }
}

// ───────────────────── database copies (e.g. the scratch copy) ────────────
// A database on the same cluster can be a recovery source too (`--from-db`).
// Only ids and timestamps are read out of it: enough to answer "is this a
// delta of the live data?", without copying documents around.
const fromDb = argOf('from-db');
if (fromDb) {
  const client = new MongoClient(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
    appName: 'flora-recovery-sources',
  });
  await client.connect();
  try {
    const db = client.db(fromDb);
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
    const perCollection = {};
    const docsByCollection = {};
    const indexCounts = {};
    let newest = null;
    let fixtures = 0;
    const fixtureByCollection = {};
    for (const coll of names) {
      const docs = await db
        .collection(coll)
        .find({}, { projection: { _id: 1, updatedAt: 1, createdAt: 1, isFixture: 1 } })
        .toArray();
      perCollection[coll] = docs.length;
      docsByCollection[coll] = docs;
      indexCounts[coll] = (await db.collection(coll).indexes()).length;
      const fx = docs.filter((d) => d.isFixture === true && coll !== 'settings').length;
      if (fx) fixtureByCollection[coll] = fx;
      fixtures += fx;
      const t = newestTimestamp(docs);
      if (t && (!newest || t > newest)) newest = t;
    }
    const owners = await db.collection('users').countDocuments({ role: 'admin', isOwner: true });
    const users = await db.collection('users').countDocuments({});

    const source = {
      kind: 'database-copy',
      path: `${fromDb} (same cluster)`,
      database: fromDb,
      declaredRecoveryPoint: null,
      files: names.length,
      documents: Object.values(perCollection).reduce((a, b) => a + b, 0),
      newestDocumentTimestamp: newest,
      fixtureDocuments: fixtures,
      fixtureByCollection,
      documentsWithCredentials: 0,
      credentialByCollection: {},
      checksum: { status: 'n/a (live database copy, not a file artifact)', checked: 0, failed: [] },
      perCollection,
      docsByCollection,
      indexCounts,
      ownerRecords: owners,
      userRecords: users,
    };
    printSource(source);
    say(`    index counts          ${Object.entries(indexCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    say(`    owner records         ${owners} of ${users} user(s)`);

    say(`\n════════ ${fromDb} vs "${targetDb}" ════════`);
    const result = await compare(source, client);
    if (owners !== 1) {
      say(`    · owner records: ${owners} (production expects exactly 1) — this copy is not a cutover candidate`);
    }
    if (result.inserts === 0) {
      say('    · no document in this copy is absent from production — it is a subset, not a source of newer data');
    }
  } finally {
    await client.close();
  }
}

say('\nReminder: this tool cannot create a recovery point. A merge still requires the');
say('pre-restore export from `npm run recovery -- --export` and explicit owner approval.');
process.exit(exitCode);
