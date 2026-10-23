/**
 * 3D REMOTE GPU AGENT — FOCUSED SUITE (`npm run test:3d-agent`).
 *
 * Self-contained: own database (Flora-Alchemy-Test-3DAgent), own private media
 * roots under the OS temp directory, own port. Nothing here touches dev or
 * production data, and every network call is LOOPBACK.
 *
 * ═══ WHAT IS REAL ═══
 *   The REAL booted backend (server.js) with the REAL mounted agent router,
 *   the REAL machine-token middleware, the REAL claim/lease/result-slot
 *   machinery on the GenerationJob model, the REAL candidate pipeline
 *   (GLB validation → private storage → Phase 5 quality measurement), and the
 *   REAL tenancy scoping. The agent side is this suite speaking the protocol
 *   over HTTP — exactly what tools/3d-worker/agent.py does.
 *   STAND-IN: the inference itself (a fixture GLB from lib/glbFixture.mjs, the
 *   same one the provider suite uses) — a GPU cannot be assumed, and what is
 *   under test here is the SYSTEM around the bytes, not TripoSR.
 *
 * §A MACHINE AUTH — missing/wrong/unconfigured token, production HTTPS.
 * §B PROVIDER POLICY — opt-in only, honest description.
 * §C QUEUE + CLAIM — atomic claims, provider scoping, stale-lease recovery.
 * §D INPUT — only the claimed job's accepted references; cross-workspace.
 * §E LEASE + HEARTBEAT — renewal, honest online/offline, abort signalling.
 * §F RESULT — validated pipeline, idempotency, invalid/oversized/empty bytes.
 * §G FAILURE / RELEASE / CANCEL — terminal states, give-back, cancel wins.
 * §H STAFF VIEW — no lease token, no workspace id, no machine token anywhere.
 * §I APPROVAL STILL GATED — a human decision is still required.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import {
  BACKEND_DIR,
  testMongoUri,
  loadBackendEnv,
  bootTestServer,
  stopTestServer,
  pinFilesystemMediaDriver,
} from './lib/testServer.mjs';
import { buildGlb, PNG_1X1 } from './lib/glbFixture.mjs';

loadBackendEnv();
if (!process.env.MONGO_URI) {
  console.error('[3d-agent] MONGO_URI is not configured (backend/.env).');
  process.exit(1);
}

const DB_NAME = 'Flora-Alchemy-Test-3DAgent';
const PORT = Number(process.env.THREE_AGENT_TEST_PORT || 4137);
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = `${BASE}/api/3d/agent`;
const AGENT_TOKEN = `agent-token-${crypto.randomBytes(24).toString('base64url')}`;

const MEDIA_DIR = await fs.mkdtemp(path.join(process.env.TEMP || os.tmpdir(), 'three-agent-'));
const REFERENCE_DIR = path.join(MEDIA_DIR, 'reference-media');
const THREE_MEDIA_ROOT = path.join(MEDIA_DIR, '3d-media');
// Must be set BEFORE the storage modules are imported: they resolve their root
// at import time, and a wrong root would put bytes somewhere nothing serves.
process.env.REFERENCE_MEDIA_DIR = REFERENCE_DIR;
process.env.THREE_MEDIA_ROOT = THREE_MEDIA_ROOT;
// Fixtures live in this suite's temp roots; never inherit a live bucket.
pinFilesystemMediaDriver();
process.env['THREE_D_PROVIDER'] = 'local_gpu_agent';
process.env.THREE_WORKER_AGENT_TOKEN = AGENT_TOKEN;
process.env.THREE_AGENT_HEARTBEAT_TIMEOUT_MS = '60000';

const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);
if (!TEST_URI) {
  console.error('[3d-agent] could not derive an isolated test database URI.');
  process.exit(1);
}

const { default: Workspace } = await import('../models/Workspace.js');
const { default: User } = await import('../models/User.js');
const { default: Product } = await import('../models/Product.js');
const { default: ProductReferenceImage } = await import('../models/ProductReferenceImage.js');
const { default: GenerationJob } = await import('../models/GenerationJob.js');
const { default: Product3DAsset } = await import('../models/Product3DAsset.js');
const { default: GpuAgent, latestAgentSnapshot } = await import('../models/GpuAgent.js');
const referenceStorage = await import('../services/referenceAssetStorage.js');
const agentModule = await import('../services/3dAgentService.js');
const providerModule = await import('../services/3dModelProvider.js');
const generation = await import('../services/3dGenerationService.js');
const assets = await import('../services/3dAssetService.js');
const { requireAgentToken } = await import('../middleware/agentAuthMiddleware.js');

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

/* ── fixtures ────────────────────────────────────────────────────────────── */
const stamp = Date.now().toString(36);
const goodGlb = buildGlb();
const primaryCutout = Buffer.concat([PNG_1X1, Buffer.from(`agent-primary-${stamp}`)]);
const otherCutout = Buffer.concat([PNG_1X1, Buffer.from(`agent-other-${stamp}`)]);
const foreignCutout = Buffer.concat([PNG_1X1, Buffer.from(`agent-foreign-${stamp}`)]);

/*
 * RESET WITH A BARE DRIVER CLIENT, BEFORE MONGOOSE CONNECTS.
 *
 * Mongoose auto-initializes every registered model when it connects, and that
 * init creates collections asynchronously (`workspaces`, `products`, … keep
 * appearing for a moment after `connect()` resolves). Dropping the database
 * underneath that init produced `DatabaseDropPending` (code 215) and killed the
 * whole CI run on 2026-10-21 — reported as "ENVIRONMENTAL/TIMEOUT ... no summary
 * line". A client that has imported no models has nothing to initialize, so it
 * can drop the database cleanly; mongoose then initializes a genuinely empty
 * one, indexes included.
 */
{
  const { MongoClient } = mongoose.mongo;
  const client = new MongoClient(TEST_URI, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  try {
    await client.db(DB_NAME).dropDatabase();
  } finally {
    await client.close();
  }
}

await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15_000 });

const { child } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  label: '3d-agent',
  extraEnv: {
    'THREE_D_PROVIDER': 'local_gpu_agent',
    'THREE_WORKER_AGENT_TOKEN': AGENT_TOKEN,
    'THREE_AGENT_HEARTBEAT_TIMEOUT_MS': '60000',
    'REFERENCE_MEDIA_DIR': REFERENCE_DIR,
    'THREE_MEDIA_ROOT': THREE_MEDIA_ROOT,
    // This suite creates EVERY row it needs (workspaces, users, products,
    // references, jobs); the fixture seed would only write rows it never reads.
    SEED_ON_START: 'false',
  },
});

try {
  await Promise.all([
    Workspace.init(),
    User.init(),
    Product.init(),
    ProductReferenceImage.init(),
    GenerationJob.init(),
    Product3DAsset.init(),
    GpuAgent.init(),
  ]);

  const workspaceA = await Workspace.create({ slug: `agent-a-${stamp}`, displayName: 'Agent Suite A', status: 'ACTIVE' });
  const workspaceB = await Workspace.create({ slug: `agent-b-${stamp}`, displayName: 'Agent Suite B', status: 'ACTIVE' });
  const adminA = await User.create({
    email: `agent-a-${stamp}@three.test`,
    passwordHash: await bcrypt.hash(`Agent-${stamp}!,`, 10),
    role: 'admin', name: 'Agent Suite Admin A', status: 'ACTIVE', workspaceId: workspaceA._id,
  });
  const adminB = await User.create({
    email: `agent-b-${stamp}@three.test`,
    passwordHash: await bcrypt.hash(`Agent-${stamp}!,`, 10),
    role: 'admin', name: 'Agent Suite Admin B', status: 'ACTIVE', workspaceId: workspaceB._id,
  });
  const staffReqA = { user: adminA, workspaceSlug: workspaceA.slug };

  const PRODUCT_A = `agent-product-a-${stamp}`;
  const PRODUCT_B = `agent-product-b-${stamp}`;
  await Product.create({ slug: PRODUCT_A, name: 'Agent Product A', price: 1000, workspaceId: workspaceA._id });
  await Product.create({ slug: PRODUCT_B, name: 'Agent Product B', price: 1000, workspaceId: workspaceB._id });

  async function makeAcceptedReference(workspace, productSlug, buffer, { primary = false } = {}) {
    const doc = await ProductReferenceImage.create({
      workspaceId: workspace._id,
      productSlug,
      status: 'READY',
      accepted: true,
      isPrimary: primary,
      original: { fileName: 'photo.png', format: 'png', hasAlpha: true },
    });
    // The ORIGINAL is what the agent is served: there is no prepared cutout any
    // more, and the removed segmentation step must not sneak back in through a
    // fixture that only exists to make an old assertion pass.
    const written = await referenceStorage.writeAsset({
      imageId: doc._id, workspaceSlug: workspace.slug, kind: 'original', buffer, format: 'png',
    });
    doc.original = { ...(doc.original.toObject?.() ?? {}), storageKey: written.storageKey, bytes: written.bytes, sha256: written.sha256 };
    await doc.save();
    return doc;
  }

  const refA1 = await makeAcceptedReference(workspaceA, PRODUCT_A, primaryCutout, { primary: true });
  const refA2 = await makeAcceptedReference(workspaceA, PRODUCT_A, otherCutout); // accepted but NOT selected
  const refB1 = await makeAcceptedReference(workspaceB, PRODUCT_B, foreignCutout, { primary: true });

  async function makeAgentJob(workspace, productSlug, referenceIds, extra = {}) {
    return GenerationJob.create({
      workspaceId: workspace._id,
      productSlug,
      status: 'QUEUED',
      provider: 'local_gpu_agent',
      providerModel: 'TripoSR',
      source: { referenceIds, viewCount: referenceIds.length, label: 'agent suite' },
      settings: { quality: 'standard', notes: '' },
      createdBy: null,
      ...extra,
    });
  }

  const jobA1 = await makeAgentJob(workspaceA, PRODUCT_A, [refA1._id]);
  const jobA2 = await makeAgentJob(workspaceA, PRODUCT_A, [refA1._id]);
  const jobB = await makeAgentJob(workspaceB, PRODUCT_B, [refB1._id]);
  const jobStale = await makeAgentJob(workspaceA, PRODUCT_A, [refA1._id], {
    status: 'GENERATING',
    providerExtra: { progress: 40 },
    lease: { token: 'stale-lease-token', workerId: 'crashed-pc', heartbeatAt: new Date(Date.now() - 600_000) },
    claimExpiresAt: new Date(Date.now() - 300_000), // lease long expired → reclaimable
    claimedAt: new Date(Date.now() - 600_000),
    startedAt: new Date(Date.now() - 600_000),
  });
  const jobMeshy = await makeAgentJob(workspaceA, PRODUCT_A, [refA1._id], { provider: 'meshy' });
  // §F/§G jobs are created INSIDE their sections: a job queued from the start
  // would be claimable during §C's "nothing left to claim" assertion.

  const WORKER = 'agent-suite-pc';

  /** Speak the agent protocol over HTTP, exactly as agent.py does. */
  async function agentCall(method, pathname, { body = null, raw = null, lease = '', token = AGENT_TOKEN, headers = {} } = {}) {
    const finalHeaders = { Accept: 'application/json', ...headers };
    if (token) finalHeaders.Authorization = `Bearer ${token}`;
    if (lease) finalHeaders['X-Agent-Lease'] = lease;
    let payload;
    if (raw !== null) {
      finalHeaders['Content-Type'] = 'model/gltf-binary';
      payload = raw;
    } else if (body !== null) {
      finalHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${AGENT}${pathname}`, { method, headers: finalHeaders, body: payload });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }

  const jobRow = async (id) => GenerationJob.findById(id).lean();
  const heartbeat = (extra = {}) =>
    agentCall('POST', '/heartbeat', { body: { workerId: WORKER, state: 'idle', modelLoaded: true, gpuName: 'suite GPU', ...extra } });

  console.log(`[3d-agent] test database: ${DB_NAME}`);
  console.log(`[3d-agent] private media root: ${THREE_MEDIA_ROOT}`);
  console.log('[3d-agent] the backend and its agent API are REAL; the GPU is a fixture GLB');
  console.log(`[3d-agent] backend on ${BASE}`);

  /* ══════════ §A MACHINE AUTH ══════════ */
  section('§A MACHINE AUTH — the machine credential, constant-time, HTTPS in production');

  {
    const calls = [];
    const fakeReq = (headers, secure = false) => ({ headers, ip: '127.0.0.1', path: '/api/3d/agent/heartbeat', secure, method: 'POST' });
    const next = () => calls.push('ok');
    const fail = (err) => calls.push(err);

    requireAgentToken(fakeReq({}), false, fail);
    check('middleware: no Authorization header → 401 AGENT_UNAUTHORIZED',
      calls[0]?.code === 'AGENT_UNAUTHORIZED', JSON.stringify(calls[0]));

    calls.length = 0;
    requireAgentToken(fakeReq({ authorization: 'Bearer wrong-token-value' }), false, fail);
    check('middleware: wrong token → 401 (never echoes the token)',
      calls[0]?.code === 'AGENT_UNAUTHORIZED' && !JSON.stringify(calls[0]).includes('wrong-token-value'));

    calls.length = 0;
    requireAgentToken(fakeReq({ authorization: `Bearer ${AGENT_TOKEN}` }), false, next);
    check('middleware: correct token → passes', calls[0] === 'ok');

    calls.length = 0;
    const saved = process.env.THREE_WORKER_AGENT_TOKEN;
    delete process.env.THREE_WORKER_AGENT_TOKEN;
    requireAgentToken(fakeReq({ authorization: 'Bearer anything' }), false, fail);
    check('middleware: token not configured → 503 AGENT_NOT_CONFIGURED (fail closed)',
      calls[0]?.code === 'AGENT_NOT_CONFIGURED');
    process.env.THREE_WORKER_AGENT_TOKEN = saved;

    calls.length = 0;
    process.env.THREE_WORKER_AGENT_TOKEN = 'x'.repeat(8);
    requireAgentToken(fakeReq({ authorization: `Bearer ${'x'.repeat(8)}` }), false, fail);
    check('middleware: a token shorter than 16 chars is a misconfiguration (503), not a credential',
      calls[0]?.code === 'AGENT_NOT_CONFIGURED');
    process.env.THREE_WORKER_AGENT_TOKEN = saved;

    calls.length = 0;
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    requireAgentToken(fakeReq({ authorization: `Bearer ${AGENT_TOKEN}` }, false), false, fail);
    check('middleware: production + plain HTTP → 400 AGENT_HTTPS_REQUIRED',
      calls[0]?.code === 'AGENT_HTTPS_REQUIRED');
    calls.length = 0;
    requireAgentToken(fakeReq({ authorization: `Bearer ${AGENT_TOKEN}` }, true), false, next);
    check('middleware: production + HTTPS (req.secure via the proxy) → passes', calls[0] === 'ok');
    process.env.NODE_ENV = savedEnv;
  }

  {
    const noAuth = await agentCall('POST', '/heartbeat', { body: { workerId: WORKER }, token: '' });
    check('HTTP: the agent endpoint refuses a request with no token (401)', noAuth.status === 401, String(noAuth.status));
    const badAuth = await agentCall('POST', '/jobs/claim', { body: { workerId: WORKER }, token: 'not-the-token' });
    check('HTTP: a wrong machine token is refused (401)', badAuth.status === 401, String(badAuth.status));
    const staffCall = await fetch(`${BASE}/api/3d/products/${PRODUCT_A}/studio`, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    check('the machine token cannot reach STAFF surfaces (401)', staffCall.status === 401, String(staffCall.status));
  }

  /* ══════════ §B PROVIDER POLICY ══════════ */
  section('§B PROVIDER POLICY — opt-in, unmetered, honest description');

  check('resolveProvider() selects local_gpu_agent', providerModule.resolveProvider() === 'local_gpu_agent');
  {
    const described = providerModule.describeProvider();
    check('the provider is described as configured and available', described.available === true && described.name === 'local_gpu_agent');
    check('it is unmetered and single-view (TripoSR)', described.metered === false && described.maxInputs === 1);
    const saved = process.env.THREE_WORKER_AGENT_TOKEN;
    process.env.THREE_WORKER_AGENT_TOKEN = '';
    check('without a token the provider reports unavailable with a reason',
      providerModule.describeProvider().available === false && Boolean(providerModule.describeProvider().reason));
    process.env.THREE_WORKER_AGENT_TOKEN = saved;
  }

  /* ══════════ §C QUEUE + CLAIM ══════════ */
  section('§C QUEUE + CLAIM — atomic, provider-scoped, crashed-PC recovery');

  {
    const first = await agentCall('POST', '/jobs/claim', { body: { workerId: WORKER, waitSeconds: 0 } });
    check('a claim returns the oldest queued job with a lease token',
      first.json?.job?.id === String(jobA1._id) && Boolean(first.json?.job?.lease?.token), JSON.stringify(first.json?.job?.id));
    const stored = await jobRow(jobA1._id);
    check('the job moved to GENERATING with the worker id and NO user claim',
      stored.status === 'GENERATING' && stored.lease?.workerId === WORKER && stored.claimedBy === null);
    check('the claim extended the lease into the future', stored.claimExpiresAt > new Date());

    const second = await agentCall('POST', '/jobs/claim', { body: { workerId: WORKER, waitSeconds: 0 } });
    check('a second claim takes a DIFFERENT job', second.json?.job?.id === String(jobA2._id));

    // Two claims at once: both must land on distinct jobs (atomic findOneAndUpdate).
    const [par1, par2] = await Promise.all([
      agentCall('POST', '/jobs/claim', { body: { workerId: 'pc-x', waitSeconds: 0 } }),
      agentCall('POST', '/jobs/claim', { body: { workerId: 'pc-y', waitSeconds: 0 } }),
    ]);
    const ids = [par1.json?.job?.id, par2.json?.job?.id].filter(Boolean);
    check('two concurrent claims never take the same job', ids.length === 2 && ids[0] !== ids[1], JSON.stringify(ids));

    const empty = await agentCall('POST', '/jobs/claim', { body: { workerId: WORKER, waitSeconds: 0 } });
    check('with nothing left to claim the answer is an honest null (200, not an error)',
      empty.status === 200 && empty.json?.job === null);

    const meshyRow = await jobRow(jobMeshy._id);
    check('a job for ANOTHER provider was never handed to the agent', meshyRow.status === 'QUEUED');
  }

  /* ══════════ §D INPUT ══════════ */
  section('§D INPUT — only the claimed job\'s accepted references, scoped to its workspace');

  {
    const stored = await jobRow(jobA1._id);
    const lease = stored.lease.token;
    const input = await agentCall('GET', `/jobs/${jobA1._id}/input`, { lease });
    check('the claimed job\'s input is served with the machine + lease token',
      input.status === 200 && input.json?.images?.length === 1, String(input.status));
    const served = input.json?.images?.[0];
    check('the served reference is the job\'s own, and its bytes are EXACTLY the stored original',
      served?.id === String(refA1._id) &&
      served?.kind === 'original' &&
      Buffer.from(served.data, 'base64').equals(primaryCutout));
    check('the payload states the view policy of the engine (single-image TripoSR)',
      input.json?.viewPolicy?.supportsMultiView === false && input.json?.viewPolicy?.viewsSent >= 1,
      JSON.stringify(input.json?.viewPolicy));
    check('the accepted reference that was NOT selected is never served',
      !(input.json?.images || []).some((i) => i.id === String(refA2._id)));

    const wrongLease = await agentCall('GET', `/jobs/${jobA1._id}/input`, { lease: 'not-the-lease' });
    check('a wrong lease token is refused (409 LEASE_LOST)', wrongLease.status === 409 && wrongLease.json?.code === 'LEASE_LOST');

    const unknown = await agentCall('GET', `/jobs/000000000000000000000000/input`, { lease });
    check('an unknown job is a 404, never a hint that it exists elsewhere', unknown.status === 404);

    const storedB = await jobRow(jobB._id);
    const inputB = await agentCall('GET', `/jobs/${jobB._id}/input`, { lease: storedB.lease.token });
    check('another workspace\'s job serves ITS OWN references only (cross-workspace isolation)',
      inputB.status === 200 &&
      (inputB.json?.images || []).length === 1 &&
      inputB.json.images[0].id === String(refB1._id) &&
      Buffer.from(inputB.json.images[0].data, 'base64').equals(foreignCutout));
  }

  /* ══════════ §E LEASE + HEARTBEAT ══════════ */
  section('§E LEASE + HEARTBEAT — renewal, honest availability, abort signalling');

  {
    const beat = await heartbeat();
    check('an idle heartbeat is accepted and returns the operational settings',
      beat.status === 200 && typeof beat.json?.settings?.leaseMs === 'number' && typeof beat.json?.settings?.heartbeatIntervalMs === 'number');
    check('the heartbeat reports the queue depth', typeof beat.json?.queue?.queued === 'number');

    const snapshot = await latestAgentSnapshot();
    check('the register went ONLINE (server-stamped, not client-claimed)',
      snapshot?.online === true && snapshot?.workerId === WORKER && snapshot?.modelLoaded === true);

    const health = await generation.providerHealth();
    check('provider health reads the heartbeat: ok while fresh', health.health?.ok === true && health.health?.agent?.workerId === WORKER);

    // Lease renewal through the heartbeat for a claimed job.
    const stored = await jobRow(jobA1._id);
    const before = stored.claimExpiresAt.getTime();
    await new Promise((r) => setTimeout(r, 20));
    const renew = await heartbeat({ currentJobId: String(jobA1._id), leaseToken: stored.lease.token });
    check('a heartbeat with the lease token renews the lease and says continue',
      renew.json?.job?.leaseValid === true && renew.json?.job?.action === 'continue');
    check('the stored claim expiry actually moved forward',
      (await jobRow(jobA1._id)).claimExpiresAt.getTime() > before);

    const lost = await heartbeat({ currentJobId: String(jobA1._id), leaseToken: 'wrong-lease' });
    check('a heartbeat with a WRONG lease reports lost (the agent must abort work)',
      lost.json?.job?.leaseValid === false && lost.json?.job?.action === 'lost');

    const explicit = await agentCall('POST', `/jobs/${jobA2._id}/lease`, { lease: (await jobRow(jobA2._id)).lease.token });
    check('the explicit lease endpoint renews too', explicit.status === 200 && Boolean(explicit.json?.leaseExpiresAt));
    const explicitBad = await agentCall('POST', `/jobs/${jobA2._id}/lease`, { lease: 'nope' });
    check('and refuses a wrong lease (409)', explicitBad.status === 409);

    // Offline detection: nothing beats for a while → stale → offline + health drops.
    await GpuAgent.updateOne({ workerId: WORKER }, { $set: { lastSeenAt: new Date(Date.now() - 120_000) } });
    const staleSnapshot = await latestAgentSnapshot();
    check('an old heartbeat reads as OFFLINE with its age', staleSnapshot?.online === false && staleSnapshot?.ageMs > 60_000);
    const staleHealth = await generation.providerHealth();
    check('health tells the truth when the PC goes quiet', staleHealth.health?.ok === false && /offline|checked in|reconnect/i.test(staleHealth.health?.detail || ''));
    // restore freshness for later sections
    await heartbeat();
  }

  /* ══════════ §F RESULT ══════════ */
  section('§F RESULT — the real pipeline, idempotency, and refused bytes');

  {
    const stored = await jobRow(jobA1._id);
    const lease = stored.lease.token;
    const up = await agentCall('POST', `/jobs/${jobA1._id}/result?taskId=agent-task-1`, { raw: goodGlb, lease });
    check('a valid GLB is accepted (200) and names the candidate asset',
      up.status === 200 && up.json?.duplicate === false && Boolean(up.json?.assetId), JSON.stringify(up.json));

    const jobAfter = await jobRow(jobA1._id);
    check('the job is READY_FOR_REVIEW with the lease released',
      jobAfter.status === 'READY_FOR_REVIEW' && jobAfter.lease?.token === '' && jobAfter.providerExtra?.assetId === String(up.json.assetId));

    const asset = await Product3DAsset.findById(up.json.assetId).lean();
    check('the candidate carries the agent provider identity and the job\'s workspace',
      asset?.provider === 'local_gpu_agent' && String(asset.workspaceId) === String(workspaceA._id) && asset.createdBy === null);
    check('the candidate is a CANDIDATE (a human must still approve it)', asset?.status === 'CANDIDATE');
    check('the quality gate measured the candidate (a decision exists)', Boolean(asset?.quality?.decision));

    const repeat = await agentCall('POST', `/jobs/${jobA1._id}/result?taskId=agent-task-1`, { raw: goodGlb, lease });
    check('a repeated upload is IDEMPOTENT (duplicate: true, same asset)',
      repeat.status === 200 && repeat.json?.duplicate === true && repeat.json?.assetId === String(up.json.assetId));
    check('exactly one candidate exists for the job',
      (await Product3DAsset.countDocuments({ jobId: jobA1._id })) === 1);

    // Wrong lease on a finished job: refused, and no extra asset appears.
    const wrongLease = await agentCall('POST', `/jobs/${jobA1._id}/result`, { raw: goodGlb, lease: 'wrong' });
    check('a result with a wrong lease is refused (409)', wrongLease.status === 409);

    // Invalid GLB → 422 and the job ends FAILED with a readable reason.
    const storedB = await jobRow(jobB._id);
    const bad = await agentCall('POST', `/jobs/${jobB._id}/result`, { raw: Buffer.from('this is not a GLB at all'), lease: storedB.lease.token });
    check('garbage bytes are rejected (422) with the validation reason',
      bad.status === 422 && /GLB|glTF/i.test(bad.json?.message || ''), JSON.stringify(bad.json?.code));
    const jobBAfter = await jobRow(jobB._id);
    check('the job ends FAILED with the reason recorded for a human',
      jobBAfter.status === 'FAILED' && Boolean(jobBAfter.error?.code) && Boolean(jobBAfter.error?.message));

    // Empty body is refused BEFORE the result slot is burned.
    const jobEmpty = await makeAgentJob(workspaceA, PRODUCT_A, [refA1._id]);
    await GenerationJob.updateOne(
      { _id: jobEmpty._id, status: 'QUEUED' },
      { $set: { status: 'GENERATING', claimExpiresAt: new Date(Date.now() + 120_000), lease: { token: 'empty-lease', workerId: WORKER, heartbeatAt: new Date() } } }
    );
    const emptyUp = await agentCall('POST', `/jobs/${jobEmpty._id}/result`, { raw: Buffer.alloc(0), lease: 'empty-lease' });
    check('an empty result body is refused (422 AGENT_EMPTY_RESULT)', emptyUp.status === 422 && emptyUp.json?.code === 'AGENT_EMPTY_RESULT');
    check('and the job is NOT consumed by the empty upload (still GENERATING, slot intact)',
      (await jobRow(jobEmpty._id)).status === 'GENERATING' && (await jobRow(jobEmpty._id)).resultReceivedAt === null);

    // Oversized body → honest 413 (body-parser cap), no job state change.
    const jobOversize = await makeAgentJob(workspaceA, PRODUCT_A, [refA1._id]);
    await GenerationJob.updateOne(
      { _id: jobOversize._id, status: 'QUEUED' },
      { $set: { status: 'GENERATING', claimExpiresAt: new Date(Date.now() + 120_000), lease: { token: 'over-lease', workerId: WORKER, heartbeatAt: new Date() } } }
    );
    const tooBig = await agentCall('POST', `/jobs/${jobOversize._id}/result`, { raw: Buffer.alloc(66 * 1024 * 1024, 7), lease: 'over-lease' });
    check('an oversized upload is refused with 413 (not a 500)', tooBig.status === 413, String(tooBig.status));
  }

  /* ══════════ §G FAILURE / RELEASE / CANCEL ══════════ */
  section('§G FAILURE / RELEASE / CANCEL — terminal truth, give-back, cancel wins');

  {
    const jobFailure = await makeAgentJob(workspaceA, PRODUCT_A, [refA1._id]);
    await GenerationJob.updateOne(
      { _id: jobFailure._id, status: 'QUEUED' },
      { $set: { status: 'GENERATING', claimExpiresAt: new Date(Date.now() + 120_000), lease: { token: 'fail-lease', workerId: WORKER, heartbeatAt: new Date() } } }
    );
    const fail = await agentCall('POST', `/jobs/${jobFailure._id}/failure`, {
      body: { code: 'RuntimeError', message: 'the model produced no triangles' },
      lease: 'fail-lease',
    });
    check('a bounded failure report is accepted and the job ends FAILED',
      fail.status === 200 && (await jobRow(jobFailure._id)).status === 'FAILED');
    check('the reported reason is stored verbatim (bounded)',
      (await jobRow(jobFailure._id)).error?.message === 'the model produced no triangles');
    const failLease = await agentCall('POST', `/jobs/${jobFailure._id}/failure`, { body: { code: 'X', message: 'Y' }, lease: 'wrong' });
    check('a stranger cannot fail someone\'s job (409)', failLease.status === 409);

    // Release: the job returns to the queue with no penalty.
    const jobRelease = await makeAgentJob(workspaceA, PRODUCT_A, [refA1._id]);
    await GenerationJob.updateOne(
      { _id: jobRelease._id, status: 'QUEUED' },
      { $set: { status: 'GENERATING', claimExpiresAt: new Date(Date.now() + 120_000), lease: { token: 'rel-lease', workerId: WORKER, heartbeatAt: new Date() } } }
    );
    const rel = await agentCall('POST', `/jobs/${jobRelease._id}/release`, { lease: 'rel-lease' });
    const relRow = await jobRow(jobRelease._id);
    check('a graceful release returns the job to QUEUED with the lease cleared',
      rel.status === 200 && relRow.status === 'QUEUED' && relRow.lease?.token === '' && relRow.resultReceivedAt === null);

    // Cancel wins over an in-flight agent run.
    const jobCancel = await makeAgentJob(workspaceA, PRODUCT_A, [refA1._id]);
    const cancelLease = 'cancel-lease';
    await GenerationJob.updateOne(
      { _id: jobCancel._id, status: 'QUEUED' },
      { $set: { status: 'GENERATING', claimExpiresAt: new Date(Date.now() + 120_000), lease: { token: cancelLease, workerId: WORKER, heartbeatAt: new Date() } } }
    );
    await generation.cancelGeneration(staffReqA, String(jobCancel._id));
    const beat = await heartbeat({ currentJobId: String(jobCancel._id), leaseToken: cancelLease });
    check('after a staff cancel, the next heartbeat says abort',
      beat.json?.job?.action === 'abort' && beat.json?.job?.status === 'CANCELLED');
    const lateResult = await agentCall('POST', `/jobs/${jobCancel._id}/result`, { raw: goodGlb, lease: cancelLease });
    check('a result arriving after cancellation is refused (409 JOB_CANCELLED)',
      lateResult.status === 409 && lateResult.json?.code === 'JOB_CANCELLED');
    check('and no candidate was created for the cancelled job',
      (await Product3DAsset.countDocuments({ jobId: jobCancel._id })) === 0);
  }

  /* ══════════ §H STAFF VIEW — LEAKS ══════════ */
  section('§H STAFF VIEW — the browser never sees a lease token or a tenant id');

  {
    const state = await generation.studioState(staffReqA, PRODUCT_A);
    const text = JSON.stringify(state);
    check('the studio state reports the agent\'s live heartbeat',
      state.provider?.name === 'local_gpu_agent' && Boolean(state.provider?.agent) && typeof state.provider.agent.online === 'boolean');
    check('no machine token appears anywhere in the studio payload', !text.includes(AGENT_TOKEN));
    check('no lease token appears anywhere in the studio payload', !text.includes('stale-lease-token') && !/"token"/.test(text));
    check('the workspace id is not in the staff job payload', !('workspaceId' in (state.jobs?.[0] || {})));

    const claimedJob = await GenerationJob.findOne({ 'lease.workerId': WORKER }).lean();
    const staffShape = claimedJob ? GenerationJob.hydrate(claimedJob).toJSON() : null;
    if (staffShape) {
      check('the serializer exposes WHO holds the lease but never the token',
        staffShape.lease?.held === true && Boolean(staffShape.lease.workerId) && !('token' in staffShape.lease));
    }
  }

  /* ══════════ §I APPROVAL STILL GATED ══════════ */
  section('§I APPROVAL — inference success alone never publishes a model');

  {
    const job = await jobRow(jobA1._id);
    const assetId = job.providerExtra.assetId;
    let approved = null;
    let gateRefused = null;
    try {
      approved = await generation.approveJobCandidate(staffReqA, String(jobA1._id), assetId, { reviewNote: 'agent suite review' });
    } catch (err) {
      gateRefused = err;
    }
    if (!approved && gateRefused) {
      // The gate refused (REVIEW/BLOCKED on this synthetic pair) — that IS the
      // behaviour under test; an administrator may then override WITH A REASON.
      check('the quality gate refused a plain approval (human gate intact)',
        /QUALITY|BLOCKED|REVIEW/i.test(gateRefused.code || ''), String(gateRefused.code));
      approved = await generation.approveJobCandidate(staffReqA, String(jobA1._id), assetId, {
        override: true,
        overrideReason: 'agent suite: administrator override path',
      });
    }
    check('an approval (plain or reasoned override) succeeds through the real gate', Boolean(approved));
    check('the asset is APPROVED and the job settled as APPROVED',
      (await Product3DAsset.findById(assetId)).status === 'APPROVED' &&
      (await jobRow(jobA1._id)).status === 'APPROVED');
  }

  /* ══════════ SUMMARY ══════════ */
  console.log('\n— summary —');
  console.log(`3D AGENT RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  failures: ${failures.join(' | ')}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('[3d-agent] suite crashed:', err);
  process.exitCode = 1;
} finally {
  await stopTestServer(child, BASE).catch(() => {});
  // Drop while still connected (the shared cluster has a collection cap — a
  // leftover test database would squat on it until the orchestrator reclaims).
  await mongoose.connection.db?.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  await fs.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  console.log(`[3d-agent] disposed ${DB_NAME} and removed ${MEDIA_DIR}`);
}
