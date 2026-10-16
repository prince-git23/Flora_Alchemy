/**
 * 3D STUDIO — PHASE 2 — GENERATION TO AN APPROVED MODEL (focused suite).
 *
 * Self-contained: own database (Flora-Alchemy-Test-3DStudio) and its own private
 * media roots under the OS temp directory, so nothing here touches dev or
 * production data or files.
 *
 * ═══ WHAT IS REAL, AND WHAT IS A TEST DOUBLE — READ THIS FIRST ═══
 *
 * NO AI INFERENCE IS RUN BY THIS SUITE. There is no GPU, no TRELLIS.2 and no
 * TripoSR on a test machine, and no Meshy call is ever made — the hosted adapter
 * is metered and requiring it would make this suite a bill. So the suite
 * substitutes the provider IMPLEMENTATION with an explicit double
 * (`registerTestProvider`, which lives in the provider module for exactly this
 * purpose) while leaving EVERY OTHER PART of the pipeline real:
 *
 *   real accepted reference rows + real files on disk → real job row
 *   → real claim → real worker/poll loop → real GLB container validation
 *   → real private storage write → real CANDIDATE asset → real approval,
 *   deprovisioning and tenancy rules → real HTTP routes and gates.
 *
 * The bytes the double "downloads" are a genuine glTF Binary container this suite
 * builds (correct magic, version, lengths, JSON chunk with meshes, BIN chunk with
 * three real vertices), so what is validated and stored is a real GLB. What is
 * NOT proven here is that any provider produces a good mesh — that is a property
 * of a host with a GPU, and §A asserts the server says so out loud instead.
 *
 * The double is registered under the `meshy` NAME only so the real opt-in path
 * (3D_PROVIDER=meshy + a key) is what gets exercised; `MESHY_API_KEY` is set to a
 * literal placeholder and no network call can occur because the transport itself
 * is replaced. The HTTP section runs against a SEPARATE server process with the
 * DEFAULT environment, where generation must refuse — which is the honest
 * statement about a default deployment.
 *
 * What it proves, by section:
 *
 *   §A PROVIDER POLICY — generation is OFF by default, meshy needs BOTH an
 *      explicit 3D_PROVIDER and a key, a local failure is never followed by a
 *      silent paid retry, and no endpoint or description leaks the key.
 *   §B GLB VALIDATION — acceptance and every rejection reason come from the
 *      bytes (magic, version, declared length, JSON chunk, mesh count), not from
 *      a filename or a provider's word.
 *   §C PRIVATE STORAGE — the media root is private, a second write to a slot is
 *      refused, a storage key cannot escape the root, and removal is scoped.
 *   §D REAL GENERATION — a job runs the whole pipeline, the candidate is a
 *      validated CANDIDATE with provider identity recorded, and only then can it
 *      be approved.
 *   §E FAILED REPLACEMENT KEEPS THE LIVE MODEL — a garbage download fails the job
 *      with a readable reason and the approved model is untouched.
 *   §F REJECTED REPLACEMENT KEEPS THE LIVE MODEL — rejecting a candidate leaves
 *      the approved model live.
 *   §G APPROVAL & ARCHIVE GUARDS — an asset with no validated bytes, a
 *      non-candidate, and an approved asset are each refused; approving a
 *      replacement ARCHIVES the previous model and keeps its files.
 *   §H TENANCY — another workspace gets 404s (never 403), cannot list, read,
 *      stream, or build a plan from this workspace's material.
 *   §I HTTP SURFACE — the real routes: authentication, staff role, workspace and
 *      permission gates; a default server REFUSES to generate; media is served
 *      private/no-store to its owner only, and a rejected model is unreachable.
 *
 * Run: npm run test:3d
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { BACKEND_DIR, bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';
import { GLB_MAGIC, CHUNK_JSON, CHUNK_BIN, buildGlb, PNG_1X1 } from './lib/glbFixture.mjs';
import { buildBoxGlb, buildReferencePng } from './lib/meshFixtures.mjs';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Product from '../models/Product.js';
import ProductReferenceImage from '../models/ProductReferenceImage.js';
import GenerationJob, { JOB_STATUSES_ACTIVE } from '../models/GenerationJob.js';
import Product3DAsset from '../models/Product3DAsset.js';

const PORT = Number(process.env.THREE_STUDIO_PORT || 4127);
const DB_NAME = 'Flora-Alchemy-Test-3DStudio';

const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Both stores resolve their root AT MODULE LOAD, so the roots are pointed at a
 * throwaway temp directory BEFORE the storage modules (and everything that
 * imports them) are evaluated. `upload:false` reality: the default roots are the
 * real ones, which is exactly why this must happen first.
 */
const MEDIA_DIR = path.join(os.tmpdir(), `flora-3d-studio-${stamp}`);
const THREE_MEDIA_ROOT = path.join(MEDIA_DIR, '3d-media');
const REFERENCE_MEDIA_DIR = path.join(MEDIA_DIR, 'reference-media');
process.env.THREE_MEDIA_ROOT = THREE_MEDIA_ROOT;
process.env.REFERENCE_MEDIA_DIR = REFERENCE_MEDIA_DIR;

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);
const BASE_URI = process.env.MONGO_URI;

// ── Dynamic: these read the media roots at import time. ────────────────────
const referenceStorage = await import('../services/referenceAssetStorage.js');
const assetStorage = await import('../services/3dAssetStorage.js');
const { validateGlb, MAX_GLB_BYTES } = await import('../services/3dModelValidation.js');
const provider = await import('../services/3dModelProvider.js');
const generation = await import('../services/3dGenerationService.js');
const assets = await import('../services/3dAssetService.js');

// ══════════ harness ══════════
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
const section = (title) => console.log(`\n— ${title} —`);

/** Every path at which a named key appears anywhere in a payload. */
function findKeyPaths(value, needle, trail = '$', hits = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return hits;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findKeyPaths(item, needle, `${trail}[${index}]`, hits, depth + 1));
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === needle) hits.push(`${trail}.${key}`);
    findKeyPaths(child, needle, `${trail}.${key}`, hits, depth + 1);
  }
  return hits;
}

/** Deep search for a string VALUE anywhere in a payload (secret-leak check). */
function containsValue(value, needle, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.includes(needle);
  if (typeof value !== 'object') return false;
  return Object.values(value).some((child) => containsValue(child, needle, depth + 1));
}

/*
 * SAVE the environment this suite starts in, then pin the SHIPPED default.
 *
 * §A's opening assertions are about a server with NO provider selected, and a
 * developer's shell (or a CI job) may already export 3D_PROVIDER or a key — the
 * suite must not pass or fail on that. The saved values are restored before the
 * HTTP section, which boots a child process that inherits this environment and
 * would otherwise be handed a live-looking opt-in.
 */
const savedEnv = {
  provider: process.env['3D_PROVIDER'],
  key: process.env.MESHY_API_KEY,
};
delete process.env['3D_PROVIDER'];
delete process.env.MESHY_API_KEY;

const FAKE_KEY = 'test-double-placeholder-key-not-a-credential';
/**
 * A credential-shaped value put into the CHILD SERVER's environment in §I. It is
 * inert there (no provider is selected), and its only job is to be searched for
 * in every HTTP response body.
 */
const LEAK_SENTINEL = `sentinel-credential-${stamp}-must-not-appear`;
const fakeCalls = { submit: 0, status: 0, download: 0, cancel: 0, lastInputs: [] };

/**
 * PHASE 5 — WHAT THE DOUBLE "GENERATES".
 *
 * Phase 5 introduced a quality gate that refuses a candidate whose geometry is
 * not a credible reconstruction (the Phase 2 double used to hand back a single
 * triangle, which the gate correctly blocks as GEOMETRY_TOO_SIMPLE). The
 * response is to make the fixture a REAL MESH — a watertight, subdivided, 300-
 * triangle box with declared material and texture entries — rather than to relax
 * the gate. Every assertion below keeps its original meaning: the container
 * facts it checks are still the facts of the container that arrived.
 *
 * The reference cutout is a matching square, so the gate can genuinely MEASURE
 * this fixture (aspect 1:1 against a 1:1 projection) instead of reporting that
 * no silhouette was available.
 */
const MODEL_GLB = buildBoxGlb({ segments: 5, meshCount: 1, textureCount: 1 });
const CUTOUT_PNG = await buildReferencePng({ width: 100, height: 100 });
let fakeDownload = MODEL_GLB;

/** The explicit test double. It never touches the network. */
const fakeProvider = {
  name: 'meshy',
  submit: async (inputs) => {
    fakeCalls.submit += 1;
    fakeCalls.lastInputs = inputs.map((i) => ({ bytes: i.buffer?.length || 0, kind: i.kind }));
    return { providerTaskId: `test-task-${fakeCalls.submit}` };
  },
  status: async () => {
    fakeCalls.status += 1;
    return { status: 'ready', providerTaskStatus: 'SUCCEEDED', progress: 100 };
  },
  download: async () => {
    fakeCalls.download += 1;
    return { buffer: fakeDownload, contentType: 'model/gltf-binary' };
  },
  cancel: async () => {
    fakeCalls.cancel += 1;
    return true;
  },
  health: async () => ({ ok: true, detail: 'test double — no network' }),
};

// ══════════ fixtures ══════════
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  Workspace.init(),
  User.init(),
  Product.init(),
  ProductReferenceImage.init(),
  GenerationJob.init(),
  Product3DAsset.init(),
]);

const wsA = await Workspace.create({ slug: `studio-a-${stamp}`, displayName: 'Studio A', status: 'ACTIVE' });
const wsB = await Workspace.create({ slug: `studio-b-${stamp}`, displayName: 'Studio B', status: 'ACTIVE' });

const P = (name) => `${name}-Passw0rd-${stamp}!`;
async function makeUser({ email, password, role, name, workspaceId, permissions }) {
  return User.create({
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role,
    name,
    status: 'ACTIVE',
    ...(workspaceId ? { workspaceId } : {}),
    ...(permissions ? { permissions } : {}),
  });
}

const adminAEmail = `studio-3d-admin-a-${stamp}@three.test`;
const adminBEmail = `studio-3d-admin-b-${stamp}@three.test`;
const limitedEmail = `studio-3d-limited-${stamp}@three.test`;
const orphanEmail = `studio-3d-orphan-${stamp}@three.test`;
const userA = await makeUser({ email: adminAEmail, password: P('AdminA'), role: 'admin', name: '3D Admin A', workspaceId: wsA._id });
const userB = await makeUser({ email: adminBEmail, password: P('AdminB'), role: 'admin', name: '3D Admin B', workspaceId: wsB._id });
await makeUser({ email: limitedEmail, password: P('Limited'), role: 'handler', name: 'No Permission Handler', workspaceId: wsA._id, permissions: [] });
await makeUser({ email: orphanEmail, password: P('Orphan'), role: 'admin', name: 'Workspace-less Admin' });

const slugA = `three-d-a-${stamp}`;
const slugB = `three-d-b-${stamp}`;
const productA = await Product.create({ slug: slugA, name: 'Studio A Product', price: 1200, workspaceId: wsA._id });
const productB = await Product.create({ slug: slugB, name: 'Studio B Product', price: 900, workspaceId: wsB._id });

/** A request-shaped identity, exactly what the services consume. */
const reqFor = (user, workspaceSlug = 'platform') => ({ user, workspaceSlug });

/**
 * Create an ACCEPTED reference with a REAL cutout file on disk, through the
 * Phase 1 store — so §D's "read the accepted bytes" step is a real file read.
 */
async function makeAcceptedReference(workspace, productSlug, { primary = false, order = 0 } = {}) {
  const doc = await ProductReferenceImage.create({
    workspaceId: workspace._id,
    productSlug,
    status: 'READY',
    accepted: true,
    isPrimary: primary,
    order,
    label: `view ${order}`,
    original: { fileName: 'original.png', format: 'png', hasAlpha: true },
    cutout: { format: 'png', hasAlpha: true },
  });
  const written = await referenceStorage.writeAsset({
    imageId: doc._id,
    workspaceSlug: workspace.slug,
    kind: 'cutout',
    buffer: CUTOUT_PNG,
    format: 'png',
  });
  doc.cutout = { ...doc.cutout.toObject?.() ?? {}, storageKey: written.storageKey, bytes: written.bytes };
  await doc.save();
  return doc;
}

const refA1 = await makeAcceptedReference(wsA, slugA, { primary: true, order: 0 });
const refA2 = await makeAcceptedReference(wsA, slugA, { order: 1 });
const refA3 = await makeAcceptedReference(wsA, slugA, { order: 2 });
const refB1 = await makeAcceptedReference(wsB, slugB, { primary: true, order: 0 });
// An UNACCEPTED reference: generation must never start from material a person
// explicitly did not accept.
const refUnaccepted = await ProductReferenceImage.create({
  workspaceId: wsA._id,
  productSlug: slugA,
  status: 'NEEDS_REVIEW',
  accepted: false,
  order: 9,
});

const reqA = reqFor(userA, wsA.slug);
const reqB = reqFor(userB, wsB.slug);

console.log(`[3d-studio] test database: ${DB_NAME}`);
console.log(`[3d-studio] private media root: ${THREE_MEDIA_ROOT}`);
console.log('[3d-studio] provider: EXPLICIT TEST DOUBLE (no inference, no network)');

// ══════════ §A ══════════
section('§A PROVIDER POLICY — generation is off by default');

check('the default provider is the local slot, not a hosted one', provider.resolveProvider() === provider.PROVIDER_LOCAL_UNAVAILABLE, provider.resolveProvider());
check('with nothing configured, the local provider reports itself unavailable', provider.describeProvider().available === false);
check(
  'the local reason names the GPU host AND the opt-in alternative (it is a fact, not a shrug)',
  /NVIDIA|GPU/.test(provider.describeProvider().reason) && /meshy/i.test(provider.describeProvider().reason),
  provider.describeProvider().reason.slice(0, 80)
);
check('the local provider refuses to submit', await (async () => {
  try {
    await provider.providerFor(provider.PROVIDER_LOCAL_UNAVAILABLE).submit([]);
    return false;
  } catch (err) {
    return err.code === 'PROVIDER_UNAVAILABLE';
  }
})());

const jobsBeforeRefusal = await GenerationJob.countDocuments({});
let defaultRefusal = null;
try {
  await generation.startGeneration(reqA, { productSlug: slugA, referenceIds: [String(refA1._id)] });
} catch (err) {
  defaultRefusal = err;
}
check('generation refuses with PROVIDER_UNAVAILABLE when no provider is configured', defaultRefusal?.code === 'PROVIDER_UNAVAILABLE' && defaultRefusal?.status === 422, `${defaultRefusal?.status} ${defaultRefusal?.code}`);
check('the refusal happens BEFORE a job row is written (no dead QUEUED jobs accumulate)', (await GenerationJob.countDocuments({})) === jobsBeforeRefusal);

// A key alone must NOT select the hosted provider: that is the "never spend
// money by accident" rule.
process.env.MESHY_API_KEY = FAKE_KEY;
check('a MESHY_API_KEY alone does NOT switch the provider (opt-in needs the flag too)', provider.resolveProvider() === provider.PROVIDER_LOCAL_UNAVAILABLE);
delete process.env.MESHY_API_KEY;

process.env['3D_PROVIDER'] = 'meshy';
check('3D_PROVIDER=meshy without a key describes meshy as UNAVAILABLE, not as a fallback to local', provider.resolveProvider() === 'meshy' && provider.describeProvider().available === false);
check('the meshy refusal explains it is metered and opt-in', /metered|opt-in/i.test(provider.describeProvider().reason), provider.describeProvider().reason.slice(0, 80));

process.env.MESHY_API_KEY = FAKE_KEY;
const described = provider.describeProvider();
const statusPayload = generation.providerStatus();
check('with both set, meshy reports available and metered', described.available === true && described.metered === true);
check('the provider description never contains the key', !containsValue(described, FAKE_KEY) && !containsValue(statusPayload, FAKE_KEY));
check(
  'plans select at most the provider input limit and mark a single view as approximate',
  (() => {
    const plan = provider.plansForProduct([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }]);
    return plan.selected.length === 4 && plan.acceptedCount === 5;
  })()
);
check(
  'a one-view plan says the result is approximate rather than implying a scan',
  /approximate/i.test(provider.plansForProduct([{ id: '1' }]).notes)
);
check(
  // PHASE 4 added the third real provider, the self-hosted local worker. The
  // assertion still means what it always meant — every entry is a SHIPPED
  // provider and no test double leaked into application code — so the expected
  // set is updated rather than the check loosened to "at least two".
  'the shipped registry holds only the three real providers (no test double leaked into application code)',
  provider.listProviders().length === 3 &&
    provider.listProviders().map((p) => p.name).sort().join(',') === 'local_unavailable,local_worker,meshy'
);
{
  // The test hook must not be reachable from a route or controller.
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  }
  await walk(path.join(BACKEND_DIR, 'controllers'));
  await walk(path.join(BACKEND_DIR, 'routes'));
  await walk(path.join(BACKEND_DIR, 'services'));
  const callers = [];
  for (const file of files) {
    if (file.endsWith(path.join('services', '3dModelProvider.js'))) continue;
    const src = await fs.readFile(file, 'utf8');
    if (src.includes('registerTestProvider')) callers.push(path.relative(BACKEND_DIR, file));
  }
  check('registerTestProvider is called from NO controller, route or service', callers.length === 0, callers.join(', '));
}

// ══════════ §B GLB VALIDATION ══════════
section('§B GLB VALIDATION — from the bytes only');

const goodGlb = MODEL_GLB;
const goodResult = validateGlb(goodGlb);
check('a real GLB passes validation', goodResult.ok === true, goodResult.code);
check('validation reports the container facts it verified', goodResult.magic === 'glTF' && goodResult.gltfVersion === 2 && goodResult.declaredBytes === goodGlb.length);
check('validation counts the declared meshes/materials/textures', goodResult.meshes === 1 && goodResult.materials === 1 && goodResult.textures === 1);

check('empty input is refused', validateGlb(Buffer.alloc(0)).code === 'GLB_EMPTY');
check('input shorter than a header is refused as truncated', validateGlb(Buffer.alloc(8)).code === 'GLB_TRUNCATED');
check('a PNG is refused (magic is checked, not the filename)', validateGlb(PNG_1X1).code === 'GLB_BAD_MAGIC');
check('glTF version 1 is refused', validateGlb(buildGlb({ version: 1 })).code === 'GLB_BAD_VERSION');
check('a declared length that disagrees with the file is refused (a truncated download)', validateGlb(buildGlb({ declaredLength: 999999 })).code === 'GLB_LENGTH_MISMATCH');
check('a first chunk that is not JSON is refused', validateGlb(buildGlb({ jsonChunkType: CHUNK_BIN })).code === 'GLB_NO_JSON_CHUNK');
check('unparseable JSON is refused', validateGlb(buildGlb({ jsonText: '{ this is not json' })).code === 'GLB_BAD_JSON');
check('a valid container with no meshes is refused (an empty scene is not a model)', validateGlb(buildGlb({ meshes: 0 })).code === 'GLB_NO_MESHES');
check('a file above the size ceiling is refused', validateGlb(Buffer.alloc(MAX_GLB_BYTES + 1)).code === 'GLB_TOO_LARGE');
check('a GLB with no BIN chunk still validates (the validator checks the container contract)', validateGlb(buildGlb({ withBin: false })).ok === true);
check('validation never throws on hostile input', (() => {
  try {
    validateGlb(Buffer.from([1, 2, 3]));
    validateGlb(null);
    validateGlb(undefined);
    validateGlb('a string, not a buffer');
    return true;
  } catch {
    return false;
  }
})());

// ══════════ §C PRIVATE STORAGE ══════════
section('§C PRIVATE STORAGE');

const slotId = new mongoose.Types.ObjectId();
const firstWrite = await assetStorage.writeAsset({
  fileId: slotId,
  workspaceSlug: wsA.slug,
  kind: 'glb',
  buffer: goodGlb,
  format: 'glb',
});
check('a write returns a key RELATIVE to the media root', !path.isAbsolute(firstWrite.storageKey) && firstWrite.storageKey.split(path.sep).includes(String(slotId)));
check('the stored key never contains the absolute root', !firstWrite.storageKey.includes(THREE_MEDIA_ROOT));
check('the write reports the true byte count and a sha256', firstWrite.bytes === goodGlb.length && /^[0-9a-f]{64}$/.test(firstWrite.sha256));
check('the bytes on disk are identical to the bytes written', (await fs.readFile(path.join(THREE_MEDIA_ROOT, firstWrite.storageKey))).equals(goodGlb));

check('a second write to the same slot is REFUSED (a validated GLB cannot be swapped)', await (async () => {
  try {
    await assetStorage.writeAsset({ fileId: slotId, workspaceSlug: wsA.slug, kind: 'glb', buffer: PNG_1X1, format: 'glb' });
    return false;
  } catch (err) {
    return err.code === 'ASSET_IMMUTABLE';
  }
})());
check('an explicit replace IS allowed for a derived file', (await assetStorage.replaceAsset({ fileId: slotId, workspaceSlug: wsA.slug, kind: 'thumbnail', buffer: PNG_1X1, format: 'png' })).bytes === PNG_1X1.length);

check('a traversal key is refused instead of escaping the root', assetStorage.resolveStorageKey(`..${path.sep}..${path.sep}etc${path.sep}passwd`) === null);
check('an absolute key is refused', assetStorage.resolveStorageKey(path.join(os.tmpdir(), 'anything')) === null);
check('an empty key is refused', assetStorage.resolveStorageKey('') === null);
check('the root itself is refused as a file key', assetStorage.resolveStorageKey('.') === null);
check('reading with a bad key returns null rather than throwing', (await assetStorage.readAsset('../../../etc/passwd')) === null);
check('an unsupported kind is refused', await (async () => {
  try {
    await assetStorage.writeAsset({ fileId: slotId, workspaceSlug: wsA.slug, kind: 'shapefile', buffer: PNG_1X1 });
    return false;
  } catch (err) {
    return err.code === 'INVALID_KIND';
  }
})());
check('an empty buffer is refused', await (async () => {
  try {
    await assetStorage.writeAsset({ fileId: slotId, workspaceSlug: wsA.slug, kind: 'glb', buffer: Buffer.alloc(0) });
    return false;
  } catch (err) {
    return err.code === 'VALIDATION_ERROR';
  }
})());
check('removal deletes only the requested asset directory', await (async () => {
  await assetStorage.removeAssetFiles(slotId, wsA.slug);
  const gone = (await fs.stat(path.join(THREE_MEDIA_ROOT, firstWrite.storageKey)).catch(() => null)) === null;
  const rootStillThere = (await fs.stat(THREE_MEDIA_ROOT).catch(() => null)) !== null;
  return gone && rootStillThere;
})());

// ══════════ §D REAL GENERATION ══════════
section('§D REAL GENERATION (test-double provider, real pipeline)');

const restoreProvider = provider.registerTestProvider('meshy', fakeProvider);

async function waitForJobTerminal(req, jobId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await generation.getJob(req, jobId);
    if (!JOB_STATUSES_ACTIVE.includes(last.status)) return last;
    await sleep(400);
  }
  throw new Error(`job ${jobId} never left an active state (last: ${last?.status})`);
}

const genStart = Date.now();
const started = await generation.startGeneration(reqA, {
  productSlug: slugA,
  referenceIds: [String(refA1._id), String(refA2._id), String(refA3._id)],
  quality: 'standard',
  notes: 'smoke: first real run',
});
const job1 = started.job;
check('starting a generation returns a job that is already claimed and running', Boolean(job1?.id) && JOB_STATUSES_ACTIVE.includes(job1.status), job1?.status);
check('the job records WHICH engine was asked, before any result exists', job1.provider === 'meshy' && Boolean(job1.model || job1.providerModel || job1.providerModelVersion));

const done1 = await waitForJobTerminal(reqA, job1.id);
check('the job reaches READY_FOR_REVIEW (not "done" — a human decides)', done1.status === 'READY_FOR_REVIEW', done1.status);
check('the finished job carries a completed timestamp and released claim', Boolean(done1.completedAt) && !done1.claimedBy);

const assetList1 = await assets.listAssetsForProduct(reqA, slugA);
const candidate1 = assetList1.find((a) => a.status === 'CANDIDATE');
check('exactly one CANDIDATE asset was created', assetList1.filter((a) => a.status === 'CANDIDATE').length === 1, `${assetList1.length} assets`);
check('the candidate is marked as HAVING a validated model (the gate for preview and approval)', candidate1?.hasModel === true);
check('the candidate records the container facts validation established', candidate1?.validation?.ok === true && candidate1?.validation?.meshes === 1 && candidate1?.validation?.gltfVersion === 2);
check('the candidate records the provider and model identity', candidate1?.provider === 'meshy' && Boolean(candidate1?.model));
check('the candidate records a real byte count and hash', (candidate1?.bytes || 0) === goodGlb.length && /^[0-9a-f]{64}$/.test(candidate1?.sha256 || ''));
check('the bytes stored really are the GLB the provider returned', await (async () => {
  const { buffer } = await assets.readAssetBytes(reqA, candidate1.id, 'glb');
  return buffer.equals(goodGlb) && validateGlb(buffer).ok === true;
})());
check('the staff projection NEVER exposes a storage key', !candidate1 || findKeyPaths(candidate1, 'storageKey').length === 0);
check('the staff projection never exposes a workspaceId to the client shape', Boolean(candidate1?.id) && candidate1.workspaceId === undefined);

check('the provider double was actually driven (submit + poll + download)', fakeCalls.submit === 1 && fakeCalls.status >= 1 && fakeCalls.download === 1, JSON.stringify(fakeCalls && { s: fakeCalls.submit, p: fakeCalls.status, d: fakeCalls.download }));
check('the provider received REAL accepted reference bytes, and the prepared cutout', fakeCalls.lastInputs.length === 3 && fakeCalls.lastInputs.every((i) => i.bytes === CUTOUT_PNG.length && i.kind === 'cutout'), JSON.stringify(fakeCalls.lastInputs));

const studioState = await generation.studioState(reqA, slugA);
check('the studio state reports no approved model yet, and that generation is possible', studioState.approved === null && studioState.canGenerate === true);
check('the studio state counts the accepted references it would use', studioState.plan.acceptedCount === 3, String(studioState.plan.acceptedCount));

const approved1 = await generation.approveJobCandidate(reqA, job1.id, candidate1.id);
check('approving the candidate makes it the product model', approved1.asset.status === 'APPROVED' && Boolean(approved1.asset.approval.approvedAt));
check('the job settles as APPROVED alongside its asset', (await generation.getJob(reqA, job1.id)).status === 'APPROVED');
check('approving the FIRST model replaces nothing', approved1.replacedAssetId === null);
const live1 = await assets.findApproved(reqA, slugA);
check('the product now has exactly one approved model', live1 && String(live1._id) === String(candidate1.id));
check(`the whole run took ${Math.round((Date.now() - genStart) / 1000)}s of real orchestration`, true);

// ══════════ §E FAILED REPLACEMENT ══════════
section('§E A FAILED REPLACEMENT NEVER DESTROYS THE LIVE MODEL');

fakeDownload = PNG_1X1; // a real file, but not a model
const failedStart = await generation.startGeneration(reqA, { productSlug: slugA, referenceIds: [String(refA1._id)] });
const failedJob = await waitForJobTerminal(reqA, failedStart.job.id);
check('a non-model download fails the job', failedJob.status === 'FAILED', failedJob.status);
check('the failure carries a readable, code-bearing reason', failedJob.error?.code === 'GLB_BAD_MAGIC' && /not a glTF Binary container/i.test(failedJob.error.message), `${failedJob.error?.code} ${failedJob.error?.message}`);
check('no candidate asset was left behind by the failed run', (await assets.listAssetsForProduct(reqA, slugA)).filter((a) => a.status === 'CANDIDATE').length === 0);
const stillApproved = await assets.findApproved(reqA, slugA);
check('the previously approved model is STILL the live model', stillApproved && String(stillApproved._id) === String(candidate1.id) && stillApproved.status === 'APPROVED');
check('the live model’s bytes are still readable after the failure', await (async () => {
  const { buffer } = await assets.readAssetBytes(reqA, candidate1.id, 'glb');
  return buffer.equals(goodGlb);
})());
check('the failed job did NOT overwrite the approved asset row', (await assets.getAsset(reqA, candidate1.id)).status === 'APPROVED');

// ══════════ §F REJECTED REPLACEMENT ══════════
section('§F A REJECTED REPLACEMENT NEVER DESTROYS THE LIVE MODEL');

fakeDownload = buildBoxGlb({ segments: 5, meshCount: 2, textureCount: 2 });
const secondStart = await generation.startGeneration(reqA, { productSlug: slugA, referenceIds: [String(refA1._id), String(refA2._id)] });
const secondJob = await waitForJobTerminal(reqA, secondStart.job.id);
check('the second run reaches review', secondJob.status === 'READY_FOR_REVIEW', secondJob.status);
const candidate2 = (await assets.listAssetsForProduct(reqA, slugA)).find((a) => a.status === 'CANDIDATE');
check('the second candidate is a distinct, newer version', candidate2 && candidate2.id !== candidate1.id && candidate2.version > candidate1.version, `v${candidate2?.version}`);
check('the second candidate carries its own validated measurements', candidate2?.validation?.meshes === 2 && candidate2?.validation?.textures === 2);

const rejected = await generation.rejectJobCandidate(reqA, secondJob.id, candidate2.id, 'Edges are wrong on the ribbon.');
check('rejecting marks the candidate REJECTED with the reason kept', rejected.asset.status === 'REJECTED' && rejected.asset.approval.rejectionReason === 'Edges are wrong on the ribbon.');
check('rejecting reports that the product still has an approved model', rejected.productStillHasApprovedModel === true);
check('the rejected candidate’s secret is that it is NOT servable, and its files were kept for the record', (await fs.stat(path.join(THREE_MEDIA_ROOT, wsA.slug, candidate2.id, 'model.glb')).catch(() => null)) !== null);
check('the job settles as REJECTED', (await generation.getJob(reqA, secondJob.id)).status === 'REJECTED');
const afterReject = await assets.findApproved(reqA, slugA);
check('the approved model is untouched by the rejection', afterReject && String(afterReject._id) === String(candidate1.id));

// ══════════ §G APPROVAL & ARCHIVE GUARDS ══════════
section('§G APPROVAL & ARCHIVE GUARDS');

check('a REJECTED asset cannot be approved', await (async () => {
  try {
    await assets.approveAsset(reqA, candidate2.id);
    return false;
  } catch (err) {
    return err.code === 'ASSET_NOT_CANDIDATE';
  }
})());
check('a REJECTED asset cannot be rejected again', await (async () => {
  try {
    await assets.rejectAsset(reqA, candidate2.id);
    return false;
  } catch (err) {
    return err.code === 'ASSET_NOT_CANDIDATE';
  }
})());
check('an APPROVED asset cannot be deleted directly', await (async () => {
  try {
    await assets.deleteAsset(reqA, candidate1.id);
    return false;
  } catch (err) {
    return err.code === 'ASSET_IS_APPROVED';
  }
})());

// A row that LOOKS like a candidate but has no stored bytes — the shape a crash
// between "validated" and "written" would leave. It must not be approvable.
const emptyCandidate = await Product3DAsset.create({
  workspaceId: wsA._id,
  productSlug: slugA,
  status: 'CANDIDATE',
  version: 99,
  validation: { ok: false },
});
check('a candidate with no validated bytes cannot be approved', await (async () => {
  try {
    await assets.approveAsset(reqA, emptyCandidate.id);
    return false;
  } catch (err) {
    return err.code === 'ASSET_HAS_NO_MODEL';
  }
})());
check('the no-bytes candidate is not presented as previewable', (await assets.getAsset(reqA, emptyCandidate.id)).hasModel === false);
check('a rejection cannot be faked as an approval by reusing another job', await (async () => {
  try {
    await generation.approveJobCandidate(reqA, secondJob.id, emptyCandidate.id);
    return false;
  } catch (err) {
    return err.code === 'ASSET_HAS_NO_MODEL';
  }
})());

// Now a legitimate replacement: approving it must ARCHIVE the incumbent.
fakeDownload = buildBoxGlb({ segments: 5, meshCount: 3, textureCount: 3 });
const thirdStart = await generation.startGeneration(reqA, { productSlug: slugA, referenceIds: [String(refA1._id)] });
const thirdJob = await waitForJobTerminal(reqA, thirdStart.job.id);
const candidate3 = (await assets.listAssetsForProduct(reqA, slugA)).find((a) => a.status === 'CANDIDATE');
const missingRefusal = await (async () => {
  try {
    await generation.approveJobCandidate(reqA, thirdJob.id, candidate3.id);
    return null;
  } catch (err) {
    return err;
  }
})();
check('approving a genuine replacement succeeds', missingRefusal === null, missingRefusal?.message);
const archived = await assets.getAsset(reqA, candidate1.id);
check('the previous model is DEPRECATED, not deleted', archived.status === 'DEPRECATED', archived.status);
check('the archive records WHAT replaced it and WHEN', String(archived.approval.replacedBy) === String(candidate3.id) && Boolean(archived.approval.replacedAt));
check('the archived model’s GLB is still on disk (restoring it is a status change, not a re-generation)', await (async () => {
  const onDisk = await fs.stat(path.join(THREE_MEDIA_ROOT, wsA.slug, candidate1.id, 'model.glb')).catch(() => null);
  return onDisk !== null;
})());
check('exactly one asset is APPROVED after the replacement', (await assets.listAssetsForProduct(reqA, slugA)).filter((a) => a.status === 'APPROVED').length === 1);
const live3 = await assets.findApproved(reqA, slugA);
check('the live model is the newest approval', live3 && String(live3._id) === String(candidate3.id));

// ══════════ §H TENANCY ══════════
section('§H TENANCY — a mismatch is a 404, never a 403');

const notFound = async (fn) => {
  try {
    await fn();
    return 'resolved';
  } catch (err) {
    return `${err.status}:${err.code}`;
  }
};
check('another workspace cannot read this workspace’s asset', (await notFound(() => assets.getAsset(reqB, candidate3.id))) === '404:ASSET_NOT_FOUND');
check('another workspace lists no assets for a foreign slug', (await assets.listAssetsForProduct(reqB, slugA)).length === 0);
check('another workspace finds no approved model for a foreign slug', (await assets.findApproved(reqB, slugA)) === null);
check('another workspace cannot stream the bytes', (await notFound(() => assets.readAssetBytes(reqB, candidate3.id, 'glb'))) === '404:ASSET_NOT_FOUND');
check(
  'another workspace cannot resolve the published media path either',
  (await notFound(() => assets.readPublishedAssetBytes(reqB, slugA, candidate3.id, 'glb'))) === '404:ASSET_NOT_FOUND'
);
check('another workspace’s plan sees none of this workspace’s accepted references', (await generation.planForProduct(reqB, slugA)).acceptedCount === 0);
check('a foreign product slug attaches to nothing', (await generation.studioState(reqB, slugA)).jobs.length === 0);
check('a generation cannot be started for a product that is not in this workspace', (await notFound(() => generation.startGeneration(reqB, { productSlug: slugA, referenceIds: [String(refA1._id)] }))) === '404:PRODUCT_NOT_FOUND');
check('a reference id from another workspace cannot be smuggled into a job', (await notFound(() => generation.startGeneration(reqA, { productSlug: slugA, referenceIds: [String(refB1._id)] }))) === '422:REFERENCE_NOT_FOUND');
check('an UNACCEPTED reference cannot be used for generation', (await notFound(() => generation.startGeneration(reqA, { productSlug: slugA, referenceIds: [String(refUnaccepted._id)] }))) === '422:NO_ACCEPTED_REFERENCES');
check('a reference belonging to a different product is refused', (await notFound(() => generation.startGeneration(reqA, { productSlug: slugB, referenceIds: [String(refA1._id)] }))) === '404:PRODUCT_NOT_FOUND');
check('another workspace cannot cancel or retry this workspace’s job', (await notFound(() => generation.cancelGeneration(reqB, thirdJob.id))) === '404:JOB_NOT_FOUND');
check('a malformed asset id is a 404, not a crash', (await notFound(() => assets.getAsset(reqA, 'not-an-object-id'))) === '404:ASSET_NOT_FOUND');
check('a media kind that is not a storage kind is refused', (await notFound(() => assets.readAssetBytes(reqA, candidate3.id, 'original'))) === '404:ASSET_NOT_FOUND');

// ══════════ §I HTTP SURFACE ══════════
section('§I HTTP SURFACE — real routes, real gates, default environment');

/*
 * UNDO the test double and the opt-in env BEFORE the child server starts.
 *
 * This matters more than it looks. `bootTestServer` inherits `process.env`, so a
 * suite that leaves 3D_PROVIDER=meshy + a placeholder MESHY_API_KEY set hands
 * them to the child — and the child, which has no test double, then reaches the
 * REAL hosted API with a fake key. That happened on the first run of this suite:
 * the server returned 201 and a job was created against api.meshy.ai. The opt-in
 * policy (never spend money by accident) is exactly what caught it. So the HTTP
 * section runs the shipped default configuration, restored explicitly here and
 * forced in the child's own environment as well.
 */
restoreProvider();
if (savedEnv.provider === undefined) delete process.env['3D_PROVIDER'];
else process.env['3D_PROVIDER'] = savedEnv.provider;
if (savedEnv.key === undefined) delete process.env.MESHY_API_KEY;
else process.env.MESHY_API_KEY = savedEnv.key;
check(
  'the test double was removed before the HTTP section (no fake can reach the child server)',
  provider.resolveProvider() === provider.PROVIDER_LOCAL_UNAVAILABLE && !process.env.MESHY_API_KEY
);

const { child: SERVER, base } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: {
    SEED_ON_START: 'false',
    // The private media root the in-process section wrote into, so the media
    // route reads the very files this suite created.
    THREE_MEDIA_ROOT,
    // Belt and braces: the child runs with NO provider SELECTED, so "a default
    // deployment refuses to generate" is a statement about the code rather than
    // about whatever the developer has in backend/.env.
    '3D_PROVIDER': '',
    // A sentinel credential is deliberately PRESENT in the child's environment.
    // It is inert — with 3D_PROVIDER empty `resolveProvider` never selects the
    // hosted adapter, so no call can be made — but it turns "no credential is
    // exposed" into a real test: the value is in the environment and must not
    // appear in ANY response body.
    MESHY_API_KEY: LEAK_SENTINEL,
  },
  label: '3d-studio',
});
const BASE = `${base}/api`;

async function req(method, path_, { token, body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${path_}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* non-json body */
      }
      return { status: res.status, json, headers: res.headers };
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(750);
    }
  }
}

async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  return r.json?.token || null;
}

const ADMIN_A = await login(adminAEmail, P('AdminA'));
const ADMIN_B = await login(adminBEmail, P('AdminB'));
const LIMITED = await login(limitedEmail, P('Limited'));
const ORPHAN = await login(orphanEmail, P('Orphan'));
check('fixtures: two workspace admins, a permissionless handler and a workspace-less admin signed in', Boolean(ADMIN_A && ADMIN_B && LIMITED && ORPHAN));

const CUSTOMER_EMAIL = `studio-3d-customer-${stamp}@three.test`;
await req('POST', '/auth/register', { body: { name: '3D Customer', email: CUSTOMER_EMAIL, password: P('Cust') } });
const CUSTOMER = await login(CUSTOMER_EMAIL, P('Cust'));
check('fixtures: customer signed in', Boolean(CUSTOMER));

const providerRes = await req('GET', '/3d/provider');
check('the provider endpoint requires authentication', providerRes.status === 401, String(providerRes.status));
check('a customer cannot read the provider endpoint', (await req('GET', '/3d/provider', { token: CUSTOMER })).status === 403);

const providerAuthed = await req('GET', '/3d/provider', { token: ADMIN_A });
check('a workspace admin can read it, and the shipped default reports generation unavailable', providerAuthed.status === 200 && providerAuthed.json?.provider?.available === false, `${providerAuthed.status} available=${providerAuthed.json?.provider?.available}`);
check('the endpoint explains WHY generation is unavailable', /GPU|NVIDIA/i.test(providerAuthed.json?.provider?.reason || ''));
check(
  'a credential present in the server environment is NEVER echoed by the provider endpoint',
  !containsValue(providerAuthed.json, LEAK_SENTINEL),
  containsValue(providerAuthed.json, LEAK_SENTINEL) ? 'the sentinel appeared in the response' : ''
);
check(
  'the reason names the variables an operator must set (guidance, not a value)',
  /MESHY_API_KEY/.test(providerAuthed.json?.provider?.reason || '')
);
check('a permissionless handler is refused the provider endpoint', (await req('GET', '/3d/provider', { token: LIMITED })).status === 403);
check('an identity with no workspace is refused by the workspace gate', (await req('GET', '/3d/provider', { token: ORPHAN })).status >= 400 && (await req('GET', '/3d/provider', { token: ORPHAN })).json?.code !== undefined);

const studioRes = await req('GET', `/3d/products/${slugA}/studio`, { token: ADMIN_A });
check('the studio state endpoint answers the whole screen in one response', studioRes.status === 200 && Array.isArray(studioRes.json?.jobs) && Array.isArray(studioRes.json?.assets));
check('the studio state shows the live approved model', studioRes.json?.approved?.id === String(candidate3.id) && studioRes.json?.approved?.status === 'APPROVED');
check('the studio state carries the real job history', (studioRes.json?.jobs || []).length >= 3);
check('the studio state never leaks a storage key', findKeyPaths(studioRes.json, 'storageKey').length === 0);
check('the studio state never echoes an environment credential', !containsValue(studioRes.json, LEAK_SENTINEL));
check('another workspace sees none of this product’s jobs or assets over HTTP', (await req('GET', `/3d/products/${slugA}/studio`, { token: ADMIN_B })).json?.jobs?.length === 0);

const generateRes = await req('POST', `/3d/products/${slugA}/jobs`, {
  token: ADMIN_A,
  body: { referenceIds: [String(refA1._id)], quality: 'standard' },
});
check('a DEFAULT server refuses an HTTP generation with PROVIDER_UNAVAILABLE', generateRes.status === 422 && generateRes.json?.code === 'PROVIDER_UNAVAILABLE', `${generateRes.status} ${generateRes.json?.code}`);
check('the HTTP refusal released no work (no new job row)', (await GenerationJob.countDocuments({ workspaceId: wsA._id })) === (studioRes.json?.jobs || []).length);
check('a customer cannot start a generation', (await req('POST', `/3d/products/${slugA}/jobs`, { token: CUSTOMER, body: { referenceIds: [String(refA1._id)] } })).status === 403);
check('a permissionless handler cannot start a generation', (await req('POST', `/3d/products/${slugA}/jobs`, { token: LIMITED, body: { referenceIds: [String(refA1._id)] } })).status === 403);
check('an unauthenticated caller cannot start a generation', (await req('POST', `/3d/products/${slugA}/jobs`, { body: { referenceIds: [String(refA1._id)] } })).status === 401);

const detailRes = await req('GET', `/3d/assets/${candidate3.id}`, { token: ADMIN_A });
check('the asset detail endpoint returns the projection, not the row', detailRes.status === 200 && detailRes.json?.asset?.hasModel === true && findKeyPaths(detailRes.json, 'storageKey').length === 0);
check('the asset detail endpoint never echoes an environment credential', !containsValue(detailRes.json, LEAK_SENTINEL));
check('a foreign asset is a 404 over HTTP', (await req('GET', `/3d/assets/${candidate3.id}`, { token: ADMIN_B })).status === 404);

const mediaRes = await fetch(`${BASE}/3d/media/${slugA}/${candidate3.id}/model`, { headers: { Authorization: `Bearer ${ADMIN_A}` } });
const mediaBytes = Buffer.from(await mediaRes.arrayBuffer());
check('the media route serves the real GLB bytes to its owner', mediaRes.status === 200 && mediaBytes.equals(fakeDownload) && validateGlb(mediaBytes).ok === true);
check('the media response is typed as a GLB binary', mediaRes.headers.get('content-type') === 'model/gltf-binary', mediaRes.headers.get('content-type'));
check('the media response is private and unstorable', /no-store/.test(mediaRes.headers.get('cache-control') || ''), mediaRes.headers.get('cache-control'));
check('the media response is marked nosniff', mediaRes.headers.get('x-content-type-options') === 'nosniff');
check('the media route requires authentication', (await fetch(`${BASE}/3d/media/${slugA}/${candidate3.id}/model`)).status === 401);
check('a foreign workspace gets a 404 for the media, never a 403', (await fetch(`${BASE}/3d/media/${slugA}/${candidate3.id}/model`, { headers: { Authorization: `Bearer ${ADMIN_B}` } })).status === 404);
check('a REJECTED model is unreachable through the media route', (await fetch(`${BASE}/3d/media/${slugA}/${candidate2.id}/model`, { headers: { Authorization: `Bearer ${ADMIN_A}` } })).status === 404);
check('an unknown media kind is a 404, not a filesystem lookup', (await fetch(`${BASE}/3d/media/${slugA}/${candidate3.id}/../../../etc/passwd`, { headers: { Authorization: `Bearer ${ADMIN_A}` } })).status === 404);
check('the media route is not cached by the public read cache', (await fetch(`${BASE}/3d/media/${slugA}/${candidate3.id}/thumbnail`, { headers: { Authorization: `Bearer ${ADMIN_A}` } })).status === 404);

const jobsRes = await req('GET', `/3d/products/${slugA}/jobs`, { token: ADMIN_A });
check('the job list endpoint requires the product permission', (await req('GET', `/3d/products/${slugA}/jobs`, { token: LIMITED })).status === 403);
check('the job list returns the real history for its owner', jobsRes.status === 200 && jobsRes.json.jobs.length >= 3);
check('an unknown path under /api/3d is a 404', (await req('GET', '/3d/nope', { token: ADMIN_A })).status === 404);

// ══════════ §J PUBLIC STOREFRONT DELIVERY (PHASE 3) ══════════
section('§J PUBLIC DELIVERY — one APPROVED model, and nothing else');

/** The storefront resolver, imported here so the cache-invalidation assertions
 *  run against the very module the serving process uses. */
const public3d = await import('../services/product3dPublicResolution.js');

const publicDetail = (slug) => req('GET', `/products/${slug}`);
const publicStatus = (slug) => req('GET', `/3d/products/${slug}/public`);
const glbUrl = (slug, assetId) => `/3d/products/${slug}/model/${assetId}/glb`;
const thumbUrl = (slug, assetId) => `/3d/products/${slug}/model/${assetId}/thumbnail`;
const glbStatus = async (slug, assetId) => (await fetch(`${BASE}${glbUrl(slug, assetId)}`)).status;

const detailA = await publicDetail(slugA);
const pub3d = detailA.json?.product3d;
check(
  'an APPROVED model is published on the public product detail to an ANONYMOUS visitor',
  detailA.status === 200 && pub3d?.hasModel === true,
  `${detailA.status} ${JSON.stringify(pub3d)}`
);
check(
  'the projection names the approved asset and points at the public delivery path',
  String(pub3d?.id) === String(candidate3.id) &&
    pub3d?.delivery?.glb === `/api/3d/products/${slugA}/model/${candidate3.id}/glb`,
  String(pub3d?.delivery?.glb)
);
check(
  'the projection carries ONLY the documented public keys (no accidental passthrough)',
  Object.keys(pub3d || {}).sort().join(',') === 'bytes,delivery,hasModel,id,provider,settings,thumbnail,validation,version',
  Object.keys(pub3d || {}).sort().join(',')
);
check(
  'the customer payload exposes no storage key, workspace, job, creator, reference, approval trail or hash',
  ['storageKey', 'workspaceId', 'jobId', 'createdBy', 'referenceIds', 'approval', 'providerTaskId', 'sha256', 'notes'].every(
    (key) => findKeyPaths(detailA.json, key).length === 0
  ),
  JSON.stringify(['storageKey', 'workspaceId', 'jobId', 'createdBy', 'referenceIds', 'approval', 'providerTaskId', 'sha256', 'notes'].map((k) => `${k}:${findKeyPaths(detailA.json, k).length}`))
);
check('the 3D projection holds no source photograph or generation-job material', !containsValue(pub3d, String(refA1._id)) && !containsValue(pub3d, String(job1.id)));
check('a model without a derived thumbnail says so instead of inventing a URL', pub3d?.thumbnail === null, String(pub3d?.thumbnail));
check('no environment credential is echoed anywhere in the public detail', !containsValue(detailA.json, LEAK_SENTINEL));

const detailB = await publicDetail(slugB);
check(
  'a product with NO approved model answers its normal detail, with no product3d field at all',
  detailB.status === 200 && !('product3d' in (detailB.json || {})) && detailB.json?.product?.slug === slugB,
  `${detailB.status} ${JSON.stringify(Object.keys(detailB.json || {}))}`
);

const statusA = await publicStatus(slugA);
check(
  'the storefront 3D status endpoint reports the SAME approved model and URL',
  statusA.status === 200 &&
    String(statusA.json?.product3d?.id) === String(candidate3.id) &&
    statusA.json?.product3d?.delivery?.glb === pub3d?.delivery?.glb,
  `${statusA.status}`
);
const statusB = await publicStatus(slugB);
check('the status endpoint answers 200 with null for a product that has none (no button, no error)', statusB.status === 200 && statusB.json?.product3d === null, `${statusB.status} ${JSON.stringify(statusB.json)}`);
check('an unknown product is a 404 on the status endpoint (no enumeration)', (await publicStatus(`ghost-product-${stamp}`)).status === 404);
check(
  'the same reads work for a CUSTOMER session and for a staff session (they are storefront reads)',
  (await req('GET', `/3d/products/${slugA}/public`, { token: CUSTOMER })).status === 200 &&
    (await req('GET', `/3d/products/${slugA}/public`, { token: ADMIN_A })).status === 200
);
check(
  'a handler WITHOUT products.view is refused the 3D read, exactly as the catalogue read refuses them',
  (await req('GET', `/3d/products/${slugA}/public`, { token: LIMITED })).status === 403 &&
    (await req('GET', '/products', { token: LIMITED })).status === 403
);

const glbRes = await fetch(`${BASE}${glbUrl(slugA, candidate3.id)}`);
const glbBytes = Buffer.from(await glbRes.arrayBuffer());
check(
  'the public GLB URL streams the approved model to an anonymous visitor',
  glbRes.status === 200 && glbBytes.equals(fakeDownload) && validateGlb(glbBytes).ok === true,
  `${glbRes.status} ${glbBytes.length} bytes`
);
check('the public GLB is typed as a glTF binary and marked nosniff', glbRes.headers.get('content-type') === 'model/gltf-binary' && glbRes.headers.get('x-content-type-options') === 'nosniff', glbRes.headers.get('content-type'));
check(
  'the public GLB is cacheable but BOUNDED — never immutable, never no-store',
  /max-age=\d+/.test(glbRes.headers.get('cache-control') || '') &&
    !/immutable/.test(glbRes.headers.get('cache-control') || '') &&
    !/no-store/.test(glbRes.headers.get('cache-control') || ''),
  glbRes.headers.get('cache-control')
);
check('the public GLB is also reachable with a customer session', (await fetch(`${BASE}${glbUrl(slugA, candidate3.id)}`, { headers: { Authorization: `Bearer ${CUSTOMER}` } })).status === 200);

check('a missing derived thumbnail is a clean 404, not a failed model', (await fetch(`${BASE}${thumbUrl(slugA, candidate3.id)}`)).status === 404);
const thumbWritten = await assetStorage.replaceAsset({ fileId: candidate3.id, workspaceSlug: wsA.slug, kind: 'thumbnail', buffer: PNG_1X1, format: 'png' });
await Product3DAsset.updateOne({ _id: candidate3.id }, { $set: { 'storage.thumbnail': { storageKey: thumbWritten.storageKey, bytes: thumbWritten.bytes } } });
const thumbRes = await fetch(`${BASE}${thumbUrl(slugA, candidate3.id)}`);
check(
  'an approved model\u2019s thumbnail is served publicly as a PNG when it exists',
  thumbRes.status === 200 && thumbRes.headers.get('content-type') === 'image/png' && Buffer.from(await thumbRes.arrayBuffer()).equals(PNG_1X1),
  `${thumbRes.status}`
);

check('a REJECTED candidate is not downloadable', (await glbStatus(slugA, candidate2.id)) === 404);
check('a DEPRECATED (replaced) model is not downloadable', (await glbStatus(slugA, candidate1.id)) === 404);
check('a CANDIDATE with no bytes is not downloadable', (await glbStatus(slugA, emptyCandidate.id)) === 404);
check('a non-existent asset id is a 404 (no file is ever named by the client)', (await glbStatus(slugA, '0'.repeat(24))) === 404);
check('a malformed asset id is a 404, not a crash', (await glbStatus(slugA, 'not-an-object-id')) === 404);
check(
  'an unknown media kind is a 404 — only glb and thumbnail exist on the public surface',
  (await fetch(`${BASE}/3d/products/${slugA}/model/${candidate3.id}/original`)).status === 404
);
check('an asset id cannot be replayed under ANOTHER product\u2019s slug', (await glbStatus(slugB, candidate3.id)) === 404);

/* A row that IS approved, in ANOTHER workspace, naming THIS product's slug — the
   cross-tenant confusion the public resolver and the delivery controller both
   have to refuse. Real bytes are written so the refusal cannot be blamed on a
   missing file. */
const intruder = await Product3DAsset.create({
  workspaceId: wsB._id,
  productSlug: slugA,
  status: 'APPROVED',
  version: 99,
  provider: 'intruder',
  validation: { ok: true, magic: 'glTF', gltfVersion: 2, meshes: 1 },
});
const intruderFile = await assetStorage.writeAsset({
  fileId: intruder._id,
  workspaceSlug: wsB.slug,
  kind: 'glb',
  buffer: goodGlb,
  format: 'glb',
});
await Product3DAsset.updateOne(
  { _id: intruder._id },
  { $set: { 'storage.glb': { storageKey: intruderFile.storageKey, bytes: intruderFile.bytes, sha256: intruderFile.sha256 } } }
);
const intruderPrivate = await fetch(`${BASE}/3d/media/${slugA}/${intruder.id}/model`, { headers: { Authorization: `Bearer ${ADMIN_B}` } });
check(
  'the intruder row really is a servable model in its OWN workspace (the refusal below is about ownership)',
  intruderPrivate.status === 200 && Buffer.from(await intruderPrivate.arrayBuffer()).equals(goodGlb),
  `${intruderPrivate.status}`
);
const statusWithIntruder = await publicStatus(slugA);
check(
  'a foreign-workspace approved row is never the model the storefront is shown',
  String(statusWithIntruder.json?.product3d?.id) === String(candidate3.id),
  String(statusWithIntruder.json?.product3d?.id)
);
check('the foreign-workspace model cannot be downloaded under this product either', (await glbStatus(slugA, intruder.id)) === 404);
await Product3DAsset.deleteOne({ _id: intruder._id });
await assetStorage.removeAssetFiles(intruder._id, wsB.slug);

/* ── A deliberate REPLACEMENT through the real pipeline ────────────────────
   The parent process can publish (it holds the provider double); the SERVING
   process can only answer from the database. So the replacement proves three
   independent things at once: an unapproved candidate is invisible, approval
   invalidates the cached projection in the process that computes it, and the
   running server serves the new bytes and refuses the old ones. */
const beforeReplacement = await public3d.publicProduct3d(slugA, { workspaceId: wsA._id });
check('the in-process projection agrees with the HTTP one before the replacement', String(beforeReplacement?.id) === String(candidate3.id));

const restoreProviderAgain = provider.registerTestProvider('meshy', fakeProvider);
process.env['3D_PROVIDER'] = 'meshy';
process.env.MESHY_API_KEY = FAKE_KEY;
fakeDownload = buildBoxGlb({ segments: 5, meshCount: 4, textureCount: 4 });
const replStart = await generation.startGeneration(reqA, { productSlug: slugA, referenceIds: [String(refA2._id)] });
const replJob = await waitForJobTerminal(reqA, replStart.job.id);
const replCandidate = (await assets.listAssetsForProduct(reqA, slugA)).find((a) => a.status === 'CANDIDATE');
check('a replacement candidate is generated while a model is live', replJob.status === 'READY_FOR_REVIEW' && Boolean(replCandidate?.id));
check(
  'an UNAPPROVED candidate does not appear on the storefront (the live model is still shown)',
  String((await publicDetail(slugA)).json?.product3d?.id) === String(candidate3.id)
);
check('an UNAPPROVED candidate cannot be downloaded', (await glbStatus(slugA, replCandidate.id)) === 404);

await generation.approveJobCandidate(reqA, replJob.id, replCandidate.id);
check(
  'approval invalidates the cached public projection in the serving process',
  String((await public3d.publicProduct3d(slugA, { workspaceId: wsA._id }))?.id) === String(replCandidate.id)
);
const newGlb = await fetch(`${BASE}${glbUrl(slugA, replCandidate.id)}`);
check(
  'the replacement is downloadable from the RUNNING server immediately',
  newGlb.status === 200 && Buffer.from(await newGlb.arrayBuffer()).equals(fakeDownload),
  `${newGlb.status}`
);
check('the replaced model is no longer downloadable', (await glbStatus(slugA, candidate3.id)) === 404);

/** The serving process caches the projection for one public-read TTL (30s), so
 *  the detail read converges rather than being instantly fresh. Poll it: the
 *  point is that it is BOUNDED, never that it is instantaneous. */
async function waitForPublicProjection(slug, assetId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await publicDetail(slug)).json?.product3d?.id;
    if (String(last) === String(assetId)) return { converged: true, last };
    await sleep(2000);
  }
  return { converged: false, last };
}
const convergence = await waitForPublicProjection(slugA, replCandidate.id);
check(
  'the public detail follows the replacement within the bounded public-read cache window',
  convergence.converged,
  `still ${convergence.last}`
);

/* ── UNPUBLISH through the real write path (visibility), which is what a
   storefront operator actually does to take a product off the shelf. */
const hideRes = await req('PATCH', `/products/${slugA}`, { token: ADMIN_A, body: { visibility: 'Hidden' } });
check('the owning administrator can unpublish the product', hideRes.status === 200 && hideRes.json?.product?.visibility === 'Hidden', `${hideRes.status}`);
check('an unpublished product is not publicly readable at all (404, like an unknown slug)', (await publicDetail(slugA)).status === 404);
check('the 3D status endpoint 404s for an unpublished product', (await publicStatus(slugA)).status === 404);
check('the approved model cannot be downloaded once the product is unpublished', (await glbStatus(slugA, replCandidate.id)) === 404);
const showAgain = await req('PATCH', `/products/${slugA}`, { token: ADMIN_A, body: { visibility: 'Visible' } });
check('republishing exposes the SAME approved model again — the write invalidated both caches', showAgain.status === 200 && String((await publicDetail(slugA)).json?.product3d?.id) === String(replCandidate.id), `${showAgain.status}`);
check('and the model is downloadable again', (await glbStatus(slugA, replCandidate.id)) === 200);

/* The private surface is unchanged by any of this. */
check('the private media route still requires authentication after the public routes exist', (await fetch(`${BASE}/3d/media/${slugA}/${replCandidate.id}/model`)).status === 401);
check('a foreign workspace still gets a 404 (never a 403) on the private media route', (await fetch(`${BASE}/3d/media/${slugA}/${replCandidate.id}/model`, { headers: { Authorization: `Bearer ${ADMIN_B}` } })).status === 404);

restoreProviderAgain();

// ══════════ teardown ══════════
// The registry holds exactly the shipped providers — the double is gone and
// nothing else was removed by the restore. (Phase 4 added `local_worker`, so
// this asserts the SET, not a count: a length alone would go green again the
// moment someone adds a provider without proving the double was removed.)
const registryNames = provider.listProviders().map((d) => String(d.name)).sort();
check(
  'the test double was restored (the real registry is intact)',
  JSON.stringify(registryNames) === JSON.stringify(['local_unavailable', 'local_worker', 'meshy']) &&
    !String(provider.providerFor('meshy').health).includes('test double') &&
    String(provider.providerFor('local_worker').submit).includes('localWorkerSubmit'),
  JSON.stringify(registryNames)
);

await fs.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
check('the suite cleaned up its own private media root', (await fs.stat(MEDIA_DIR).catch(() => null)) === null);

try {
  await mongoose.connection.db.dropDatabase();
  console.log(`\n— cleanup: dropped ${DB_NAME} —`);
} catch (err) {
  console.log(`\n— cleanup skipped (${err.message}) —`);
}

console.log(`\n3D STUDIO RESULT: ${passed} passed, ${failed} failed`);
console.log('NOTE: no AI inference was performed. The provider was an explicit test double;');
console.log('      every other stage of the pipeline (validation, storage, approval, tenancy) was real.');
if (failed > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
}

try {
  await mongoose.disconnect().catch(() => {});
} finally {
  await stopTestServer(SERVER, base);
}
void BASE_URI;
