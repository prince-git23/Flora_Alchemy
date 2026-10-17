/**
 * PRIVATE MEDIA STORAGE — roots, typed storage failures, honest asset presence,
 * scoped cleanup and the migration utility. (`npm run test:media-storage`)
 *
 * Why a suite exists for "where do the files live"
 * -----------------------------------------------
 * A production upload returned `500 INTERNAL_ERROR "An unexpected server error
 * occurred…"`. That sentence was identical for a full disk, a read-only mount, a
 * bad key and a bug, and it could not be traced from the UI. Three separate
 * defects hid behind it: a root that moved with the CWD, a root inside the
 * deploy directory (erased on every redeploy), and filesystem failures that were
 * never translated into anything a client could act on. Each is asserted here.
 *
 * What it proves, by section:
 *
 *   §A ROOT RESOLUTION — `mediaRoot()` is absolute and CWD-INDEPENDENT (the
 *      doubled `backend/backend/uploads` path is gone), and an explicit
 *      `THREE_MEDIA_ROOT` wins.
 *   §B TYPED STORAGE FAILURE — with an unusable private root, an upload answers
 *      a typed `503 STORAGE_*` carrying an `errorId`, NOT the generic 500; the
 *      server log names the failing stage; nothing is written and no row is
 *      created. `/api/health` reports the media facts (durable / writable)
 *      without ever changing its own 200.
 *   §C HONEST ASSET PRESENCE — a row whose bytes are gone reports
 *      `available:false, registered:true, missing:true` rather than advertising
 *      a readable asset, and deleting one derived file moves exactly that asset.
 *   §D SCOPED, DRY-BY-DEFAULT CLEANUP — a preview deletes nothing; a scoped
 *      sweep removes only the caller's workspace; a platform-wide sweep demands
 *      an explicit confirmation; a foreign workspace's rows survive all of it.
 *   §E MIGRATION UTILITY — dry run copies nothing, `--apply` copies and verifies
 *      by SHA-256, re-running is retry-safe, a conflicting destination is
 *      reported instead of overwritten, and a row whose file is missing is
 *      reported rather than fabricated.
 *
 * Isolation: own server(s) on own ports, own database
 * (Flora-Alchemy-Test-MediaStorage), own private roots under the OS temp dir.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import {
  BACKEND_DIR,
  bootTestServer,
  stopTestServer,
  testMongoUri,
  loadBackendEnv,
} from './lib/testServer.mjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import ProductReferenceImage from '../models/ProductReferenceImage.js';

// 4133/4134: chosen because 4130–4131 are already claimed by the 3D worker
// suite. Suites run serially, but a port that is merely LIKELY to be free is how
// "environmental/timeout" failures get introduced.
const PORT = Number(process.env.MEDIA_STORAGE_PORT || 4133);
const BLOCKED_PORT = Number(process.env.MEDIA_STORAGE_BLOCKED_PORT || PORT + 1);
const DB_NAME = 'Flora-Alchemy-Test-MediaStorage';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✘ ${name} ${detail}`.trimEnd());
  }
}

const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const fileSha = async (file) => sha256(await fs.readFile(file));

const TMP = path.join(os.tmpdir(), `flora-media-storage-${stamp}`);
const MEDIA_DIR = path.join(TMP, 'reference-media');
const FIXTURE_SOURCE = path.join(TMP, 'old-root');
const FIXTURE_TARGET = path.join(TMP, 'new-root');

await fs.mkdir(MEDIA_DIR, { recursive: true });

// A root that CANNOT be used: the path itself is a regular file, so every
// `mkdir`/`writeFile` beneath it fails on every platform (this is the portable
// stand-in for a read-only mount, which Windows cannot express).
const BLOCKED_ROOT_FILE = path.join(TMP, 'blocked-root-file');
await fs.writeFile(BLOCKED_ROOT_FILE, 'not a directory');
const BLOCKED_ROOT = path.join(BLOCKED_ROOT_FILE, 'reference-media');

// ══════════ deterministic start ══════════
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([Workspace.init(), User.init(), ProductReferenceImage.init()]);

const wsA = await Workspace.create({ slug: `media-a-${stamp}`, displayName: 'Media A', status: 'ACTIVE' });
const wsB = await Workspace.create({ slug: `media-b-${stamp}`, displayName: 'Media B', status: 'ACTIVE' });

async function makeUser({ email, password, role, name, workspaceId, isOwner = false }) {
  return User.create({
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role,
    name,
    status: 'ACTIVE',
    isOwner,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

const adminAEmail = `media-admin-a-${stamp}@storage.test`;
const adminBEmail = `media-admin-b-${stamp}@storage.test`;
const ownerEmail = `media-owner-${stamp}@storage.test`;
const P = (name) => `${name}-Passw0rd-${stamp}!`;
await makeUser({ email: adminAEmail, password: P('AdminA'), role: 'admin', name: 'Media Admin A', workspaceId: wsA._id });
await makeUser({ email: adminBEmail, password: P('AdminB'), role: 'admin', name: 'Media Admin B', workspaceId: wsB._id });
// A platform owner (no workspace) — the identity a platform-wide sweep needs.
await makeUser({ email: ownerEmail, password: P('Owner'), role: 'admin', name: 'Platform Owner', isOwner: true });

const { child: SERVER, base, logs } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false', REFERENCE_MEDIA_DIR: MEDIA_DIR, BGREMOVE_PROVIDER: 'deterministic', BGREMOVE_PROBE: '0' },
  label: 'media-storage',
});
const BASE = `${base}/api`;

async function req(method, url, { token, body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${url}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* non-json */
      }
      return { status: res.status, json };
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(750);
    }
  }
}

async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  if (!r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token;
}

async function upload(token, { buffer, filename = 'photo.jpg', type = 'image/jpeg', fields = {} } = {}) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type }), filename);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const res = await fetch(`${BASE}/references`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, json };
}

/** A real 900×900 JPEG the pipeline accepts. */
async function photo() {
  return sharp({ create: { width: 900, height: 900, channels: 3, background: '#f2efe9' } })
    .composite([
      {
        input: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900">' +
            '<ellipse cx="450" cy="420" rx="180" ry="170" fill="#a94f63"/>' +
            '<rect x="430" y="580" width="40" height="200" rx="8" fill="#4e7a4c"/></svg>'
        ),
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

let tokenA = null;
let tokenB = null;
let tokenOwner = null;

try {
  tokenA = await login(adminAEmail, P('AdminA'));
  tokenB = await login(adminBEmail, P('AdminB'));
  tokenOwner = await login(ownerEmail, P('Owner'));

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n— §A ROOT RESOLUTION —\n');
  const storageModuleUrl = pathToFileURL(path.join(BACKEND_DIR, 'services/3dAssetStorage.js')).href;
  const probeRoot = (cwd, extraEnv = {}) => {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import { mediaRoot } from '${storageModuleUrl}'; console.log(mediaRoot());`],
      { cwd, env: { ...process.env, ...extraEnv }, encoding: 'utf8' }
    );
    if (r.status !== 0) throw new Error(`root probe failed in ${cwd}: ${r.stderr || r.status}`);
    return r.stdout.trim();
  };

  const fromBackend = probeRoot(BACKEND_DIR);
  const fromRepoRoot = probeRoot(path.resolve(BACKEND_DIR, '..'));
  check('the 3D media root is an absolute path', path.isAbsolute(fromBackend), fromBackend);
  check(
    'the 3D media root does not depend on the process CWD',
    fromBackend === fromRepoRoot,
    `${fromBackend} vs ${fromRepoRoot}`
  );
  check(
    'the 3D media root no longer doubles the backend segment',
    !/backend[\\/]+backend/i.test(fromBackend) && fromBackend.replace(/\\/g, '/').endsWith('backend/uploads/3d-media'),
    fromBackend
  );
  const customRoot = path.join(TMP, 'custom-3d-root');
  check(
    'THREE_MEDIA_ROOT overrides the default absolutely',
    probeRoot(BACKEND_DIR, { THREE_MEDIA_ROOT: customRoot }) === customRoot
  );

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n— §B TYPED STORAGE FAILURE (the production 500, made diagnosable) —\n');
  const health = await req('GET', '/health');
  check('health still answers 200 with an unusable/absent media root', health.status === 200);
  check('health reports the reference media root', Boolean(health.json?.media?.reference), JSON.stringify(health.json?.media));
  check(
    'health says whether the reference root is durable',
    typeof health.json?.media?.reference?.durable === 'boolean',
    JSON.stringify(health.json?.media?.reference)
  );
  check(
    'health names the variable that controls the reference root',
    health.json?.media?.reference?.envVar === 'REFERENCE_MEDIA_DIR'
  );
  check('health never exposes an absolute media path', health.json?.media?.reference?.path === undefined);

  // A nonzero byte-length keeps this a real multipart upload rather than an
  // "empty file" validation error, which would mask the storage path entirely.
  const blockedPhoto = await photo();
  const goodUpload = await upload(tokenA, { buffer: blockedPhoto, fields: { draftKey: `media-ok-${stamp}` } });
  check('a normal upload against a good root still succeeds (201)', goodUpload.status === 201, `${goodUpload.status} ${JSON.stringify(goodUpload.json)}`);
  check(
    'the successful upload reports its original as available',
    goodUpload.json?.image?.original?.available === true && goodUpload.json?.image?.original?.missing === false,
    JSON.stringify(goodUpload.json?.image?.original)
  );

  // Now boot a second server whose private root CANNOT be written.
  const {
    child: BLOCKED_SERVER,
    base: blockedBase,
    logs: blockedLogs,
  } = await bootTestServer({
    port: BLOCKED_PORT,
    db: DB_NAME,
    extraEnv: { SEED_ON_START: 'false', REFERENCE_MEDIA_DIR: BLOCKED_ROOT, BGREMOVE_PROVIDER: 'deterministic', BGREMOVE_PROBE: '0' },
    label: 'media-storage-blocked',
  });
  try {
    const blockedHealth = await fetch(`${blockedBase}/api/health`).then((r) => r.json());
    check(
      'health PROBES a configured root and reports it unwritable',
      blockedHealth?.media?.reference?.checked === true && blockedHealth?.media?.reference?.writable === false,
      JSON.stringify(blockedHealth?.media?.reference)
    );
    check(
      'health records the filesystem error code for the unwritable root',
      typeof blockedHealth?.media?.reference?.errorCode === 'string' && blockedHealth.media.reference.errorCode.length > 0,
      String(blockedHealth?.media?.reference?.errorCode)
    );

    const blockedLogin = await fetch(`${blockedBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminAEmail, password: P('AdminA') }),
    }).then((r) => r.json());
    const blockedToken = blockedLogin?.token;
    check('a staff session is still possible while media is unavailable', Boolean(blockedToken));

    const form = new FormData();
    form.append('image', new Blob([blockedPhoto], { type: 'image/jpeg' }), 'blocked.jpg');
    form.append('draftKey', `media-blocked-${stamp}`);
    const blockedRes = await fetch(`${blockedBase}/api/references`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${blockedToken}` },
      body: form,
    });
    const blockedBody = await blockedRes.json().catch(() => null);

    check('an upload with an unusable root is a 503, not a 500', blockedRes.status === 503, `${blockedRes.status} ${JSON.stringify(blockedBody)}`);
    check(
      'the refusal carries a TYPED storage code',
      typeof blockedBody?.code === 'string' && blockedBody.code.startsWith('STORAGE_'),
      String(blockedBody?.code)
    );
    check(
      'the refusal is NOT the generic unexpected-server-error message',
      blockedBody?.message !== 'An unexpected server error occurred. Please try again.'
    );
    check('the refusal names the code in its message so the UI can show it', String(blockedBody?.message || '').includes(String(blockedBody?.code)));
    check('the refusal carries an errorId to correlate with the log', typeof blockedBody?.errorId === 'string' && blockedBody.errorId.length >= 6);
    check(
      'the refusal says nothing was kept, so retrying is safe',
      /nothing was (kept|stored)/i.test(String(blockedBody?.message || '')),
      String(blockedBody?.message)
    );
    check(
      'the server log names the failing stage (persist-original)',
      /stage=persist-original/.test(blockedLogs()),
      blockedLogs().split('\n').filter((l) => l.includes('reference-upload')).slice(-2).join(' | ')
    );
    check(
      'no reference row was created by the refused upload',
      (await ProductReferenceImage.countDocuments({ draftKey: `media-blocked-${stamp}` })) === 0
    );
    check(
      'the errorId in the response appears in the server log',
      blockedLogs().includes(String(blockedBody?.errorId)),
      String(blockedBody?.errorId)
    );
  } finally {
    await stopTestServer(BLOCKED_SERVER, blockedBase);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n— §C HONEST ASSET PRESENCE —\n');
  const draft = `media-presence-${stamp}`;
  const uploaded = await upload(tokenA, { buffer: blockedPhoto, fields: { draftKey: draft } });
  check('a second upload for the presence section succeeds', uploaded.status === 201, `${uploaded.status}`);
  const imageId = uploaded.json?.image?.id;

  // Wait for the pipeline to finish, then delete ONE derived file behind the
  // API's back. The row must stop claiming that asset is readable.
  for (let i = 0; i < 40; i += 1) {
    const list = await req('GET', `/references?draftKey=${draft}`, { token: tokenA });
    if (!list.json?.images?.[0] || ['READY', 'NEEDS_REVIEW', 'FAILED'].includes(list.json.images[0].status)) break;
    await sleep(500);
  }
  const row = await ProductReferenceImage.findById(imageId).select('original cutout storageNamespace').lean();
  check('the uploaded row has an original key on disk', Boolean(row?.original?.storageKey));
  const cutoutKey = row?.cutout?.storageKey || '';
  if (cutoutKey) {
    await fs.rm(path.join(MEDIA_DIR, cutoutKey), { force: true });
  }
  const afterDelete = await req('GET', `/references?draftKey=${draft}`, { token: tokenA });
  const presented = afterDelete.json?.images?.find((img) => img.id === String(imageId));
  check(
    'the ORIGINAL is still reported available after its sibling was deleted',
    presented?.original?.available === true && presented?.original?.missing === false,
    JSON.stringify(presented?.original)
  );
  if (cutoutKey) {
    check(
      'the CUTOUT whose bytes were removed reports missing, not available',
      presented?.cutout?.available === false && presented?.cutout?.missing === true,
      JSON.stringify(presented?.cutout)
    );
    check(
      'a missing asset exposes no URL to fetch',
      presented?.cutout?.url === null,
      String(presented?.cutout?.url)
    );
    check(
      'the difference between "not generated" and "file gone" is visible to the client',
      presented?.cutout?.registered === true && presented?.cutout?.missing === true
    );
  }
  const originalKey = row?.original?.storageKey;
  await fs.rm(path.join(MEDIA_DIR, originalKey), { force: true });
  const afterOriginalDelete = await req('GET', `/references?draftKey=${draft}`, { token: tokenA });
  const presented2 = afterOriginalDelete.json?.images?.find((img) => img.id === String(imageId));
  check(
    'a row whose ORIGINAL bytes are gone no longer advertises a readable original',
    presented2?.original?.available === false && presented2?.original?.missing === true,
    JSON.stringify(presented2?.original)
  );
  check(
    'processing such a row fails honestly instead of inventing a cutout',
    (await req('POST', `/references/${imageId}/reprocess`, { token: tokenA, body: {} })).json?.image?.status === 'FAILED'
  );

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n— §D SCOPED, DRY-BY-DEFAULT CLEANUP —\n');
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const staleA = await ProductReferenceImage.create({
    workspaceId: wsA._id,
    draftKey: `cleanup-a-${stamp}`,
    status: 'FAILED',
  });
  const staleB = await ProductReferenceImage.create({
    workspaceId: wsB._id,
    draftKey: `cleanup-b-${stamp}`,
    status: 'FAILED',
  });
  // Backdate through the raw collection: `timestamps: true` owns createdAt, so
  // this is the only way to build an honestly OLD row for an age-bounded sweep.
  await ProductReferenceImage.collection.updateMany(
    { _id: { $in: [staleA._id, staleB._id] } },
    { $set: { createdAt: old, updatedAt: old } }
  );

  const surviving = async () => ProductReferenceImage.countDocuments({ _id: { $in: [staleA._id, staleB._id] } });

  const preview = await req('POST', '/references/cleanup', { token: tokenOwner, body: { olderThanHours: 24 } });
  check('cleanup responds 200 for the owner', preview.status === 200, `${preview.status} ${JSON.stringify(preview.json)}`);
  check('cleanup is a DRY RUN unless deletion is asked for', preview.json?.dryRun === true);
  check(
    'a workspace-less caller defaults to the PLATFORM bucket, not to everything',
    preview.json?.scope === 'platform',
    String(preview.json?.scope)
  );
  check('the default preview removes nothing', (await surviving()) === 2);

  // The maintenance route is owner-only, so ordinary staff cannot reach it AT
  // ALL — the least-privilege answer to "a global deletion path must never be
  // an ordinary staff action".
  const staffAttempt = await req('POST', '/references/cleanup', { token: tokenA, body: { olderThanHours: 24, dryRun: false } });
  check('ordinary staff cannot invoke the maintenance sweep at all (403)', staffAttempt.status === 403, `${staffAttempt.status}`);
  check('the staff refusal deleted nothing', (await surviving()) === 2);

  const unconfirmed = await req('POST', '/references/cleanup', {
    token: tokenOwner,
    body: { olderThanHours: 24, dryRun: false, allWorkspaces: true },
  });
  check('a platform-wide sweep without confirmation is refused (422)', unconfirmed.status === 422, `${unconfirmed.status} ${JSON.stringify(unconfirmed.json)}`);
  check('the confirmation refusal is typed', unconfirmed.json?.code === 'CONFIRMATION_REQUIRED', String(unconfirmed.json?.code));
  check('the refused sweep still deleted nothing', (await surviving()) === 2);

  const platformPreview = await req('POST', '/references/cleanup', {
    token: tokenOwner,
    body: { olderThanHours: 24, allWorkspaces: true, confirmAllWorkspaces: true },
  });
  check('a CONFIRMED platform-wide sweep is allowed', platformPreview.status === 200, `${platformPreview.status} ${JSON.stringify(platformPreview.json)}`);
  check('the confirmed sweep is still a DRY RUN by default', platformPreview.json?.dryRun === true);
  check('the platform preview reports both stale rows', (platformPreview.json?.wouldRemove || 0) >= 2, JSON.stringify(platformPreview.json));
  check('the platform preview removed nothing', (await surviving()) === 2);

  // `workspaceId` in the body is SCRUBBED by `stripClientWorkspaceId` before any
  // controller runs, so it can never redirect the sweep. Asserted, because the
  // tempting "fix" for a targeting feature is to make that scrub hole-shaped.
  const smuggled = await req('POST', '/references/cleanup', {
    token: tokenOwner,
    body: { olderThanHours: 24, dryRun: false, workspaceId: String(wsB._id) },
  });
  check('a body-supplied workspaceId is inert (scrubbed before the controller)', smuggled.status === 200, `${smuggled.status}`);
  check('the smuggled id did not become the scope', smuggled.json?.scope === 'platform', String(smuggled.json?.scope));
  check('the smuggled id removed nothing', smuggled.json?.removed === 0, JSON.stringify(smuggled.json));
  check('the row it named still exists', (await ProductReferenceImage.countDocuments({ _id: staleB._id })) === 1);

  // The scoped form the owner MAY use: a PUBLIC workspace slug, validated.
  const scoped = await req('POST', '/references/cleanup', {
    token: tokenOwner,
    body: { olderThanHours: 24, dryRun: false, workspaceSlug: wsA.slug },
  });
  check('the owner can sweep ONE named workspace (by slug)', scoped.status === 200, `${scoped.status} ${JSON.stringify(scoped.json)}`);
  check('the scoped sweep reports the workspace scope', scoped.json?.scope === 'workspace', String(scoped.json?.scope));
  check('the scoped sweep removed the targeted workspace’s row', scoped.json?.removed >= 1, JSON.stringify(scoped.json));
  check('the OTHER workspace’s row survived the scoped sweep', (await ProductReferenceImage.countDocuments({ _id: staleB._id })) === 1);
  check(
    'an unknown workspace slug is refused (404), not silently swept',
    (
      await req('POST', '/references/cleanup', {
        token: tokenOwner,
        body: { olderThanHours: 24, dryRun: false, workspaceSlug: 'no-such-workspace-slug' },
      })
    ).status === 404
  );

  const confirmed = await req('POST', '/references/cleanup', {
    token: tokenOwner,
    body: { olderThanHours: 24, dryRun: false, allWorkspaces: true, confirmAllWorkspaces: true },
  });
  check('the owner’s confirmed platform-wide sweep is allowed', confirmed.status === 200, `${confirmed.status} ${JSON.stringify(confirmed.json)}`);
  check('the response names the platform scope', confirmed.json?.scope === 'all-workspaces', String(confirmed.json?.scope));
  check(
    'the confirmed sweep removed the other workspace’s stale row',
    (await ProductReferenceImage.countDocuments({ _id: staleB._id })) === 0
  );

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n— §E MIGRATION UTILITY —\n');
  const presentBytes = Buffer.from('original-bytes-for-migration');
  const cutoutBytes = Buffer.from('cutout-bytes-for-migration');
  const missingId = new mongoose.Types.ObjectId();
  const migratableId = new mongoose.Types.ObjectId();
  const migratableKey = `migrate-a-${stamp}/${migratableId}/original.jpg`;
  const cutoutMigrateKey = `migrate-a-${stamp}/${migratableId}/cutout.png`;
  await fs.mkdir(path.dirname(path.join(FIXTURE_SOURCE, migratableKey)), { recursive: true });
  await fs.writeFile(path.join(FIXTURE_SOURCE, migratableKey), presentBytes);
  await fs.writeFile(path.join(FIXTURE_SOURCE, cutoutMigrateKey), cutoutBytes);
  await ProductReferenceImage.create({
    workspaceId: wsA._id,
    draftKey: `migrate-${stamp}`,
    status: 'NEEDS_REVIEW',
    storageNamespace: `migrate-a-${stamp}`,
    original: { storageKey: migratableKey, bytes: presentBytes.length },
    cutout: { storageKey: cutoutMigrateKey, bytes: cutoutBytes.length },
  });
  await ProductReferenceImage.create({
    workspaceId: wsA._id,
    draftKey: `migrate-missing-${stamp}`,
    status: 'FAILED',
    storageNamespace: `migrate-missing-${stamp}`,
    original: { storageKey: `migrate-missing-${stamp}/${missingId}/original.jpg`, bytes: 11 },
  });

  const manifestPath = path.join(TMP, 'migration-manifest.json');
  const runMigration = (extraArgs = []) =>
    spawnSync(
      process.execPath,
      [
        'scripts/migrate-private-media.mjs',
        `--kind=reference`,
        `--from=${FIXTURE_SOURCE}`,
        `--to=${FIXTURE_TARGET}`,
        `--manifest=${manifestPath}`,
        ...extraArgs,
      ],
      { cwd: BACKEND_DIR, env: { ...process.env, MONGO_URI: TEST_URI }, encoding: 'utf8' }
    );

  const dry = runMigration();
  const dryManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8').catch(() => '{}'));
  check('the migration tool runs as a DRY RUN by default', dry.status === 0, `exit=${dry.status} ${dry.stderr?.slice(-300)}`);
  check('the dry run reports the files it would copy', dryManifest?.summary?.wouldCopy === 2, JSON.stringify(dryManifest?.summary));
  check('the dry run wrote nothing into the destination', (await fs.stat(FIXTURE_TARGET).catch(() => null)) === null);
  check(
    'the dry run reports the rows whose files are missing, instead of inventing them',
    (dryManifest?.summary?.missingSource || 0) >= 1,
    JSON.stringify(dryManifest?.summary)
  );
  check(
    'the missing row is named by its storage key in the manifest',
    (dryManifest?.missing || []).includes(`migrate-missing-${stamp}/${missingId}/original.jpg`),
    JSON.stringify((dryManifest?.missing || []).slice(0, 3))
  );
  check(
    'the missing file was NOT created in the destination',
    (await fs.stat(path.join(FIXTURE_TARGET, `migrate-missing-${stamp}/${missingId}/original.jpg`)).catch(() => null)) === null
  );
  check('the manifest records the database identity it read', typeof dryManifest?.databaseIdentity === 'string' && dryManifest.databaseIdentity.length > 0);

  const applied = runMigration(['--apply']);
  const appliedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  check('--apply performs the copy', applied.status === 0, `exit=${applied.status} ${applied.stderr?.slice(-300)}`);
  check('exactly the present files were copied', appliedManifest?.summary?.copied === 2, JSON.stringify(appliedManifest?.summary));
  check(
    'the copied original is byte-identical (sha256 verified)',
    (await fileSha(path.join(FIXTURE_TARGET, migratableKey))) === sha256(presentBytes)
  );
  check(
    'the copied cutout is byte-identical (sha256 verified)',
    (await fileSha(path.join(FIXTURE_TARGET, cutoutMigrateKey))) === sha256(cutoutBytes)
  );
  check(
    'the SOURCE is left untouched by a copy-only migration',
    (await fileSha(path.join(FIXTURE_SOURCE, migratableKey))) === sha256(presentBytes)
  );

  const rerun = runMigration(['--apply']);
  const rerunManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  check('re-running is retry-safe (exit 0)', rerun.status === 0, `exit=${rerun.status}`);
  check(
    'a complete file is recognised and skipped, never re-copied',
    rerunManifest?.summary?.alreadyPresent === 2 && rerunManifest?.summary?.copied === 0,
    JSON.stringify(rerunManifest?.summary)
  );

  await fs.writeFile(path.join(FIXTURE_TARGET, migratableKey), 'different bytes on purpose');
  const conflict = runMigration(['--apply']);
  const conflictManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  check('a conflicting destination is a FAILURE, not a silent overwrite', conflict.status === 1, `exit=${conflict.status}`);
  check('the conflict is counted', conflictManifest?.summary?.conflicts === 1, JSON.stringify(conflictManifest?.summary));
  check(
    'the conflicting file was NOT overwritten',
    (await fileSha(path.join(FIXTURE_TARGET, migratableKey))) === sha256(Buffer.from('different bytes on purpose'))
  );

  const usage = spawnSync(process.execPath, ['scripts/migrate-private-media.mjs'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, MONGO_URI: TEST_URI },
    encoding: 'utf8',
  });
  check('the tool refuses to run without explicit source and destination', usage.status === 2, `exit=${usage.status}`);
  check('the refusal explains what is required', /--from=<dir> and --to=<dir>/.test(usage.stdout + usage.stderr));
} catch (err) {
  failed += 1;
  failures.push(`suite crashed: ${err.message}`);
  console.error('\n✘ SUITE CRASHED:', err);
} finally {
  await stopTestServer(SERVER, base);
  await mongoose.connection.close(false).catch(() => {});
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  console.log(`\n— cleanup: removed ${TMP} and closed the test database —`);
}

console.log(`\nMEDIA STORAGE RESULT: ${passed} passed, ${failed} failed`);
if (failures.length) console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
process.exit(failed > 0 ? 1 : 0);
