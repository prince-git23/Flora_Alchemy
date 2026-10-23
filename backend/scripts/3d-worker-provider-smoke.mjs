/**
 * 3D WORKER PROVIDER — PHASE 4 — THE ADAPTER CONTRACT (focused suite).
 *
 * Self-contained: own database (Flora-Alchemy-Test-3DWorker), own private media
 * roots under the OS temp directory, own port. Nothing here touches dev or
 * production data, and nothing here makes a network call beyond LOOPBACK.
 *
 * ═══ WHAT IS REAL, AND WHAT STANDS IN — READ THIS FIRST ═══
 *
 * The thing under test is the SHIPPED adapter: `services/3dLocalWorkerProvider.js`
 * plus the provider policy in `services/3dModelProvider.js`. The HTTP peer is a
 * stand-in — a tiny node server on 127.0.0.1 that speaks the worker's protocol —
 * because:
 *
 *   · a GPU worker cannot be assumed on a test machine, and a suite that silently
 *     passes without one would be worse than no suite; and
 *   · the adapter's job is exactly this: turn the worker's protocol into the
 *     provider interface the job service already drives. That contract is what is
 *     verified here, byte for byte, including which reference photograph gets
 *     sent and what happens when the worker lies, fails, or disappears.
 *
 * REAL: the provider registry and its opt-in policy · the request/response
 * shapes · which accepted reference is selected and that its EXACT bytes are
 * transmitted · the job row, claim and poll loop · GLB container validation of
 * the returned bytes · private storage writes · the candidate asset and its
 * provider identity · cancellation · the "no leak" projection.
 * STAND-IN: the inference itself (the real one is exercised by
 * `npm run test:3d-real` against a genuinely running worker).
 *
 * §A ADAPTER POLICY — opt-in only, loopback only, no credential in any payload.
 * §B A REAL JOB THROUGH THE ADAPTER — one primary view, exact bytes, validated
 *    candidate stored privately.
 * §C FAILURE PATHS — a failed task, garbage bytes, a worker that lies about its
 *    own container, and an unreachable worker each end the JOB with a readable
 *    reason and leave no asset and no orphaned file.
 * §D CANCELLATION — the worker is told, and the job ends cancelled.
 * §E PROJECTION — the customer-facing projection of a real candidate carries no
 *    storage key, workspace id or creator id.
 *
 * Run: npm run test:3d-worker
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { BACKEND_DIR, testMongoUri, loadBackendEnv, pinFilesystemMediaDriver } from './lib/testServer.mjs';
import { buildGlb, PNG_1X1 } from './lib/glbFixture.mjs';

loadBackendEnv();
if (!process.env.MONGO_URI) {
  console.error('[3d-worker] MONGO_URI is not configured (backend/.env).');
  process.exit(1);
}

const DB_NAME = 'Flora-Alchemy-Test-3DWorker';
const PORT = Number(process.env.THREE_WORKER_TEST_PORT || 4131);
const BASE = `http://127.0.0.1:${PORT}`;
const WORKER_TOKEN = `worker-token-${Date.now().toString(36)}`;

const MEDIA_DIR = await fs.mkdtemp(path.join(process.env.TEMP || os.tmpdir(), 'three-worker-'));
const REFERENCE_DIR = path.join(MEDIA_DIR, 'reference-media');
const THREE_MEDIA_ROOT = path.join(MEDIA_DIR, '3d-media');
// Must be set BEFORE the storage modules are imported: they resolve their root
// at import time, and a wrong root would put bytes somewhere nothing serves.
process.env.REFERENCE_MEDIA_DIR = REFERENCE_DIR;
process.env.THREE_MEDIA_ROOT = THREE_MEDIA_ROOT;
// Fixtures live in this suite's temp roots; never inherit a live bucket.
pinFilesystemMediaDriver();
process.env['THREE_D_PROVIDER'] = 'local_worker';
process.env.THREE_WORKER_URL = BASE;

const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);
if (!TEST_URI) {
  console.error('[3d-worker] could not derive an isolated test database URI.');
  process.exit(1);
}

const { default: Workspace } = await import('../models/Workspace.js');
const { default: User } = await import('../models/User.js');
const { default: Product } = await import('../models/Product.js');
const { default: ProductReferenceImage } = await import('../models/ProductReferenceImage.js');
const { default: GenerationJob } = await import('../models/GenerationJob.js');
const { default: Product3DAsset } = await import('../models/Product3DAsset.js');
const referenceStorage = await import('../services/referenceAssetStorage.js');
const assetStorage = await import('../services/3dAssetStorage.js');
const provider = await import('../services/3dModelProvider.js');
const providerModule = await import('../services/3dLocalWorkerProvider.js');
const generation = await import('../services/3dGenerationService.js');
const assets = await import('../services/3dAssetService.js');
const { validateGlb } = await import('../services/3dModelValidation.js');

/* ── tiny assertion helper (same style as the other suites) ──────────────── */
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`.trimEnd());
  }
}
const section = (title) => console.log(`\n— ${title} —`);

/* ── the stand-in worker ─────────────────────────────────────────────────── */
const goodGlb = buildGlb();
const primaryCutout = Buffer.concat([PNG_1X1, Buffer.from('primary-view-bytes')]);
const secondaryCutout = Buffer.concat([PNG_1X1, Buffer.from('secondary-view-bytes-must-not-be-sent')]);

/** Mutable scenario the stand-in worker answers from. */
const workerState = {
  taskStatus: 'succeeded', // succeeded | failed | running | cancelled
  glb: goodGlb,
  containerOk: true, // what the worker claims about its own export
  failMessage: 'the model produced no triangles',
  failCode: 'RuntimeError',
  received: [], // every /generate body
  cancelled: [], // every task id a cancel named
  healthCalls: 0,
  servesToken: false,
};

const readBody = (req) =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });

const json = (res, code, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

const worker = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const authorized = req.headers.authorization === `Bearer ${WORKER_TOKEN}`;
  if (url.pathname === '/health') {
    workerState.healthCalls += 1;
    return json(res, 200, {
      ok: true,
      ready: true,
      provider: 'local_worker',
      model: 'TripoSR',
      modelVersion: 'triposr-1.0',
      device: 'cuda:0',
      gpuName: 'stand-in GPU',
      vramTotalMb: 6141,
      marchingCubes: 'skimage-shim',
      torch: '2.9.1+cu128',
      python: '3.14.2',
      loadSeconds: 9.27,
      maxInputViews: 1,
      detail: 'TripoSR ready on cuda:0',
    });
  }
  // Every non-health route requires the bearer token when one is configured,
  // which is how the suite proves the adapter actually sends it.
  if (!authorized && !workerState.servesToken) return json(res, 401, { error: 'unauthorized' });

  if (url.pathname === '/generate' && req.method === 'POST') {
    const body = await readBody(req);
    workerState.received.push(JSON.parse(body));
    return json(res, 202, { taskId: 'stand-in-task-1', status: 'queued' });
  }
  const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)(\/glb|\/cancel)?$/);
  if (taskMatch) {
    const [, taskId, suffix] = taskMatch;
    if (suffix === '/cancel') {
      workerState.cancelled.push(taskId);
      return json(res, 200, { taskId, cancelRequested: true });
    }
    if (suffix === '/glb') {
      if (workerState.taskStatus !== 'succeeded' || !workerState.glb) {
        return json(res, 409, { error: `task is ${workerState.taskStatus}` });
      }
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': workerState.glb.length });
      return res.end(workerState.glb);
    }
    const status = workerState.cancelRequestedFor === taskId ? 'cancelled' : workerState.taskStatus;
    if (status === 'succeeded') {
      return json(res, 200, {
        taskId,
        status,
        stage: 'done',
        progress: 100,
        durationMs: 78_200,
        result: {
          bytes: goodGlb.length,
          sha256: crypto.createHash('sha256').update(goodGlb).digest('hex'),
          vertices: 3,
          faces: 1,
          container: { ok: workerState.containerOk, meshes: 1, hasNormals: true, reason: workerState.containerOk ? '' : 'not a GLB' },
          device: 'cuda:0',
          marchingCubes: 'skimage-shim',
          inputMode: 'original',
        },
      });
    }
    if (status === 'failed') {
      return json(res, 200, {
        taskId,
        status,
        stage: 'failed',
        progress: 60,
        error: { code: workerState.failCode, message: workerState.failMessage },
      });
    }
    return json(res, 200, { taskId, status: 'running', stage: 'extracting-mesh', progress: 60 });
  }
  return json(res, 404, { error: 'not found' });
});

await new Promise((resolve) => worker.listen(PORT, '127.0.0.1', resolve));

/* ── fixtures ────────────────────────────────────────────────────────────── */
const stamp = Date.now().toString(36);
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15_000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  Workspace.init(), User.init(), Product.init(),
  ProductReferenceImage.init(), GenerationJob.init(), Product3DAsset.init(),
]);

const workspace = await Workspace.create({
  slug: `worker-suite-${stamp}`, displayName: 'Worker Suite', status: 'ACTIVE',
});
const user = await User.create({
  email: `worker-suite-${stamp}@three.test`,
  passwordHash: await bcrypt.hash(`Worker-${stamp}!,`, 10),
  role: 'admin', name: 'Worker Suite Admin', status: 'ACTIVE', workspaceId: workspace._id,
});
const req = { user, workspaceSlug: workspace.slug };
const PRODUCT_SLUG = `worker-suite-product-${stamp}`;
await Product.create({ slug: PRODUCT_SLUG, name: 'Worker Suite Product', price: 1000, workspaceId: workspace._id });

/** An ACCEPTED reference with real ORIGINAL bytes on disk, through the studio store. */
async function makeAcceptedReference(buffer, { primary = false, order = 0, label = '' } = {}) {
  const doc = await ProductReferenceImage.create({
    workspaceId: workspace._id,
    productSlug: PRODUCT_SLUG,
    status: 'READY',
    accepted: true,
    isPrimary: primary,
    order,
    label,
    original: { fileName: 'photo.png', format: 'png', hasAlpha: true },
  });
  const written = await referenceStorage.writeAsset({
    imageId: doc._id, workspaceSlug: workspace.slug, kind: 'original', buffer, format: 'png',
  });
  doc.original = { ...(doc.original.toObject?.() ?? {}), storageKey: written.storageKey, bytes: written.bytes, sha256: written.sha256 };
  await doc.save();
  return doc;
}

const primaryRef = await makeAcceptedReference(primaryCutout, { primary: true, order: 0, label: 'primary' });
const secondaryRef = await makeAcceptedReference(secondaryCutout, { order: 1, label: 'second view' });

const listFiles = async (dir) => {
  const out = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dir);
  return out;
};

console.log(`[3d-worker] test database: ${DB_NAME}`);
console.log(`[3d-worker] private media root: ${THREE_MEDIA_ROOT}`);
console.log('[3d-worker] the adapter is real; the worker it talks to is a loopback STAND-IN (no inference)');
console.log(`[3d-worker] stand-in worker listening on ${BASE}`);

/* ══════════ §A ADAPTER POLICY ══════════ */
section('§A ADAPTER POLICY — opt-in, loopback-only, no credential in any payload');

check('the provider name is exported and stable', providerModule.PROVIDER_LOCAL_WORKER === 'local_worker');
check(
  'opting in selects the local worker and reports it as local and unmetered',
  provider.resolveProvider() === 'local_worker' && provider.describeProvider().local === true && provider.describeProvider().metered === false
);
check('the plan advertises exactly ONE input (TripoSR is single-image)', provider.describeProvider().maxInputs === 1);
check(
  'a plan states the engine reconstructs from ONE image rather than implying joint multi-view use',
  provider.describeProvider().supportsMultiView === false && /ONE image/i.test(provider.plansForProduct([{ id: '1' }]).notes)
);
check(
  'the loopback and private ranges are accepted',
  providerModule.isLocalWorkerUrl('http://127.0.0.1:8791') &&
    providerModule.isLocalWorkerUrl('http://localhost:8791') &&
    providerModule.isLocalWorkerUrl('http://10.1.2.3:8791') &&
    providerModule.isLocalWorkerUrl('http://192.168.0.10:8791')
);
check(
  'a public host, a non-http scheme and nonsense are all refused',
  !providerModule.isLocalWorkerUrl('http://evil.example.com:8791') &&
    !providerModule.isLocalWorkerUrl('file:///etc/passwd') &&
    !providerModule.isLocalWorkerUrl('not a url')
);

{
  // A token must travel OUT but never come back in a payload.
  process.env.THREE_WORKER_TOKEN = WORKER_TOKEN;
  const described = provider.describeProvider();
  check('the token never appears in the provider description', !JSON.stringify(described).includes(WORKER_TOKEN));
  check('the description names the worker URL so an operator can see where it points', described.workerUrl === BASE);

  const health = await providerModule.localWorkerHealth();
  check('a reachable worker reports ready with its device and GPU', health.ok === true && /TripoSR/.test(health.detail), health.detail);
  check('the health detail carries no token', !health.detail.includes(WORKER_TOKEN));
  check('the health read reported the stand-in GPU', health.worker?.gpuName === 'stand-in GPU');

  // The adapter sends the bearer token; the stand-in refuses without it.
  workerState.servesToken = false;
  const submission = await providerModule.localWorkerSubmit([{ id: 'x', buffer: primaryCutout, kind: 'original' }]);
  check('the adapter submits with the configured bearer token', Boolean(submission.providerTaskId), JSON.stringify(submission));
  workerState.received.length = 0;
  delete process.env.THREE_WORKER_TOKEN;
  // This block proved the token is SENT. Everything after it deliberately runs
  // WITHOUT a token, so a later job proves the adapter never invents one when
  // none is configured — and the stand-in stops demanding it.
  workerState.servesToken = true;
}

{
  // A NON-local URL is refused before any request leaves the process.
  process.env.THREE_WORKER_URL = 'http://evil.example.com:8791';
  check('a public worker URL makes the provider unavailable with a readable reason', provider.describeProvider().available === false && /local worker address/i.test(provider.describeProvider().reason));
  let refusal = null;
  try {
    await providerModule.localWorkerSubmit([{ id: 'x', buffer: primaryCutout, kind: 'original' }]);
  } catch (err) {
    refusal = err;
  }
  check('submitting to a non-local URL is refused with WORKER_NOT_LOCAL', refusal?.code === 'WORKER_NOT_LOCAL', refusal?.code);
  process.env.THREE_WORKER_URL = BASE;
  check('restoring a loopback URL makes it available again', provider.describeProvider().available === true);
}

{
  // An unreachable worker (nothing listening) must be a READABLE failure.
  const closed = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  process.env.THREE_WORKER_URL = `http://127.0.0.1:${closed}`;
  const health = await providerModule.localWorkerHealth();
  check('an unreachable worker reports not-ready with the address it tried', health.ok === false && health.detail.includes(String(closed)), health.detail.slice(0, 120));
  check('the unreachable detail tells the operator how to start it', /tools\/3d-worker\/worker\.py/.test(health.detail));
  process.env.THREE_WORKER_URL = BASE;
}

/* ══════════ §B A REAL JOB THROUGH THE ADAPTER ══════════ */
section('§B A REAL JOB — one primary view, exact bytes, a validated private candidate');

workerState.received.length = 0;
workerState.taskStatus = 'succeeded';
workerState.glb = goodGlb;

const filesBefore = (await listFiles(THREE_MEDIA_ROOT)).length;
const { job } = await generation.startGeneration(req, {
  productSlug: PRODUCT_SLUG,
  referenceIds: [String(primaryRef._id), String(secondaryRef._id)],
  quality: 'standard',
  notes: 'provider-contract suite',
});

async function waitForJob(jobId, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = null;
  while (Date.now() < deadline) {
    current = await generation.getJob(req, jobId);
    if (['READY_FOR_REVIEW', 'FAILED', 'CANCELLED', 'APPROVED', 'REJECTED'].includes(current.status)) return current;
    await new Promise((r) => setTimeout(r, 500));
  }
  return current;
}

const finished = await waitForJob(job.id);
check('the job reaches READY_FOR_REVIEW through the real worker loop', finished.status === 'READY_FOR_REVIEW', `${finished.status} ${JSON.stringify(finished.error || {})}`);
check('the job records the provider identity it used', finished.provider === 'local_worker' && finished.providerModel === 'TripoSR', `${finished.provider}/${finished.providerModel}`);

check('the stand-in worker received exactly one request', workerState.received.length === 1, String(workerState.received.length));
const payload = workerState.received[0];
check('exactly ONE image was transmitted (single-image provider, no silent drop)', payload?.images?.length === 1, String(payload?.images?.length));
check(
  'the transmitted image is the PRIMARY accepted reference, byte for byte',
  payload?.images?.[0]?.data === primaryCutout.toString('base64'),
  `sent ${payload?.images?.[0]?.data?.length || 0} chars`
);
check('the secondary view was NOT sent', payload?.images?.[0]?.data !== secondaryCutout.toString('base64'));
check('the worker was told which storage kind it received (the untouched original)', payload?.images?.[0]?.kind === 'original', payload?.images?.[0]?.kind);

const candidateList = await assets.listAssetsForProduct(req, PRODUCT_SLUG);
const candidate = candidateList.find((a) => a.status === 'CANDIDATE') || null;
check('a CANDIDATE asset was created', Boolean(candidate), JSON.stringify(candidateList.map((a) => a.status)));
check('the candidate records the local_worker provider and its model', candidate?.provider === 'local_worker' && candidate?.model === 'TripoSR', `${candidate?.provider}/${candidate?.model}`);
check('the candidate carries the container facts validated from the bytes', candidate?.validation?.ok === true && candidate?.validation?.meshes === 1, JSON.stringify(candidate?.validation));
check('the candidate is not approved yet (a human decides)', candidateList.every((a) => a.status !== 'APPROVED'));

// Guarded so one failed job reports as failures instead of ending the suite with
// a TypeError: every assertion below still runs and still reports.
let stored = null;
try {
  stored = candidate ? await assets.readAssetBytes(req, candidate.id, 'glb') : null;
} catch (err) {
  stored = null;
}
check('the stored bytes are the bytes the worker served', Boolean(stored && stored.buffer.equals(goodGlb)), `${stored?.buffer?.length ?? 0} vs ${goodGlb.length}`);
check('the stored bytes hash to the same value the row recorded', Boolean(stored && candidate && crypto.createHash('sha256').update(stored.buffer).digest('hex') === candidate.sha256));
check('the stored bytes are a valid glTF Binary container', Boolean(stored && validateGlb(stored.buffer).ok === true));

const filesAfter = await listFiles(THREE_MEDIA_ROOT);
check('the model was written into the PRIVATE media root exactly once', filesAfter.length === filesBefore + 1, `${filesBefore} -> ${filesAfter.length}`);
check('every written file lives under the private root', filesAfter.every((f) => f.startsWith(THREE_MEDIA_ROOT)));

/* ══════════ §C FAILURE PATHS ══════════ */
section('§C FAILURE PATHS — a readable reason, no asset, no orphaned file');

// C1 — the worker reports the task as failed.
workerState.taskStatus = 'failed';
workerState.failCode = 'RuntimeError';
workerState.failMessage = 'the model produced no triangles';
const assetsBeforeFailure = await Product3DAsset.countDocuments({});
const failedJobRun = await generation.startGeneration(req, {
  productSlug: PRODUCT_SLUG, referenceIds: [String(primaryRef._id)],
});
const failedJob = await waitForJob(failedJobRun.job.id);
check('a failed worker task fails the job', failedJob.status === 'FAILED', failedJob.status);
check(
  "the job carries the worker's own error code and message (not a generic failure)",
  failedJob.error?.code === 'RuntimeError' && /no triangles/.test(failedJob.error?.message || ''),
  JSON.stringify(failedJob.error)
);
check('a failed task writes no asset', (await Product3DAsset.countDocuments({})) === assetsBeforeFailure);

// C2 — the worker serves bytes that are not a GLB.
workerState.taskStatus = 'succeeded';
workerState.glb = Buffer.concat([PNG_1X1, Buffer.from('this is a photograph, not a model')]);
const garbageRun = await generation.startGeneration(req, {
  productSlug: PRODUCT_SLUG, referenceIds: [String(primaryRef._id)],
});
const garbageJob = await waitForJob(garbageRun.job.id);
check('non-GLB bytes fail the job', garbageJob.status === 'FAILED', garbageJob.status);
check(
  'the failure is the validator\'s own code (from the BYTES, not a filename)',
  String(garbageJob.error?.code || '').startsWith('GLB_'),
  JSON.stringify(garbageJob.error)
);
check('garbage writes no asset', (await Product3DAsset.countDocuments({})) === assetsBeforeFailure);
check(
  'garbage leaves NO file behind in the private root',
  (await listFiles(THREE_MEDIA_ROOT)).length === filesAfter.length,
  `${(await listFiles(THREE_MEDIA_ROOT)).length} vs ${filesAfter.length}`
);

// C3 — the worker says it succeeded but its own container inspection failed.
workerState.glb = goodGlb;
workerState.containerOk = false;
const lyingRun = await generation.startGeneration(req, {
  productSlug: PRODUCT_SLUG, referenceIds: [String(primaryRef._id)],
});
const lyingJob = await waitForJob(lyingRun.job.id);
check('a worker that reports an invalid container fails the job instead of shipping bytes onward', lyingJob.status === 'FAILED', lyingJob.status);
check('the failure names the container problem', lyingJob.error?.code === 'WORKER_BAD_CONTAINER', JSON.stringify(lyingJob.error));
workerState.containerOk = true;

// C4 — the worker is unreachable.
process.env.THREE_WORKER_URL = `http://127.0.0.1:1`;
const offlineRun = await generation.startGeneration(req, {
  productSlug: PRODUCT_SLUG, referenceIds: [String(primaryRef._id)],
});
const offlineJob = await waitForJob(offlineRun.job.id);
check('an unreachable worker fails the job (it does not hang forever)', offlineJob.status === 'FAILED', offlineJob.status);
check('the failure says the worker was unreachable and names the address', offlineJob.error?.code === 'WORKER_UNREACHABLE' && /127\.0\.0\.1:1/.test(offlineJob.error?.message || ''), JSON.stringify(offlineJob.error));
check('no paid provider was tried as a fallback', !/meshy/i.test(offlineJob.error?.message || ''));
process.env.THREE_WORKER_URL = BASE;

/* ══════════ §D CANCELLATION ══════════ */
section('§D CANCELLATION — the worker is told, the job ends cancelled');

workerState.cancelled.length = 0;
workerState.taskStatus = 'running';
const runningRun = await generation.startGeneration(req, {
  productSlug: PRODUCT_SLUG, referenceIds: [String(primaryRef._id)],
});
await new Promise((r) => setTimeout(r, 300));
await generation.cancelGeneration(req, runningRun.job.id);
const cancelledJob = await waitForJob(runningRun.job.id, { timeoutMs: 40_000 });
check('the worker was told to cancel the task', workerState.cancelled.includes(runningRun.job.providerTaskId || 'stand-in-task-1'), JSON.stringify(workerState.cancelled));
check('the job ends CANCELLED', cancelledJob.status === 'CANCELLED', cancelledJob.status);
check('a cancelled job produces no asset', (await Product3DAsset.countDocuments({})) === assetsBeforeFailure);
workerState.taskStatus = 'succeeded';

// The cancelled job's poll loop sleeps up to 5 s before it looks at the job
// again and returns. Waiting here (rather than tearing the database down under
// it) keeps the suite from printing a "client must be connected" error from a
// background run that is doing exactly what it should: noticing the cancel and
// stopping quietly while the worker is still up.
console.log('  … letting the cancelled job’s background poll loop observe the cancel and exit');
await new Promise((r) => setTimeout(r, 6_000));

/* ══════════ §E PROJECTION ══════════ */
section('§E PROJECTION — the staff view keeps the decision trail, and no key leaks');

const candidateProjection = candidate ? await assets.getAsset(req, candidate.id) : null;
const serialized = JSON.stringify(candidateProjection);
check('the staff projection has no storage key', !/storageKey/.test(serialized));
check('the staff projection hides the raw _id/__v fields', !serialized.includes('"__v"') && !serialized.includes('"_id"'));
check('the staff projection keeps the approval trail administrators need', candidateProjection && 'approval' in candidateProjection);
const statusPayload = generation.providerStatus();
check('the provider status payload names the worker model without a credential', statusPayload.model === 'TripoSR' && !JSON.stringify(statusPayload).includes(WORKER_TOKEN));

/* ── cleanup ─────────────────────────────────────────────────────────────── */
console.log(`\n3D WORKER RESULT: ${passed} passed, ${failed} failed`);
console.log('NOTE: the provider ADAPTER and every pipeline stage were real; the worker was a loopback');
console.log('      stand-in. No inference happened — run `npm run test:3d-real` for that.');
if (failed > 0) {
  console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
}

await new Promise((resolve) => worker.close(resolve));
try {
  await mongoose.connection.db.dropDatabase();
  console.log(`\n— cleanup: dropped ${DB_NAME} —`);
} catch (err) {
  console.log(`\n— cleanup skipped (${err.message}) —`);
}
await fs.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
await mongoose.disconnect().catch(() => {});
void BACKEND_DIR;
void assetStorage;
