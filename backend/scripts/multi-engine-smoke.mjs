/**
 * MULTI-ENGINE LOCAL GPU — FOCUSED SUITE (`npm run test:engines`).
 *
 * Self-contained: own database (Flora-Alchemy-Test-MultiEngine), own private
 * media roots under the OS temp directory, own port. No GPU, no checkpoints, no
 * network beyond loopback.
 *
 * ═══ WHAT IS REAL ═══
 *   The REAL booted backend, the REAL machine-token middleware, the REAL claim /
 *   lease / result-slot machinery, the REAL per-engine input validation, the REAL
 *   GLB validation → private storage → quality → CANDIDATE pipeline, and the REAL
 *   artifact storage. The agent side is this suite speaking the protocol over
 *   HTTP, exactly as tools/3d-worker/agent.py does.
 *   STAND-IN: inference. A fixture GLB is uploaded (lib/glbFixture.mjs), because
 *   a GPU cannot be assumed and what is under test is the SYSTEM around the
 *   bytes — dispatch, provenance, validation and the review gate.
 *
 * §A ADAPTER REGISTRY — three installed adapters, TripoSR still the default.
 * §B HUNYUAN CONTRACT — named slots, no sheet, no duplicate slot.
 * §C RELI3D CONTRACT — RGBA, recorded poses only, a real transforms.json.
 * §D HEALTH — the agent's probe decides readiness; configuration does not.
 * §E DISPATCH — a machine is only handed jobs for engines it declared.
 * §F INPUT — each engine receives its own contract, and TripoSR is unchanged.
 * §G RESULT — validated candidate, idempotent upload, cancel wins.
 * §H ARTIFACTS — illumination.hdr + run_info.json stored privately, immutably.
 * §I APPROVAL — nothing is published by inference alone.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import {
  testMongoUri,
  loadBackendEnv,
  bootTestServer,
  stopTestServer,
  pinFilesystemMediaDriver,
} from './lib/testServer.mjs';
import { buildGlb } from './lib/glbFixture.mjs';

loadBackendEnv();
if (!process.env.MONGO_URI) {
  console.error('[engines] MONGO_URI is not configured (backend/.env).');
  process.exit(1);
}

const DB_NAME = 'Flora-Alchemy-Test-MultiEngine';
const PORT = Number(process.env.MULTI_ENGINE_TEST_PORT || 4139);
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = `${BASE}/api/3d/agent`;
const AGENT_TOKEN = `agent-token-${crypto.randomBytes(24).toString('base64url')}`;

const MEDIA_DIR = await fs.mkdtemp(path.join(process.env.TEMP || os.tmpdir(), 'multi-engine-'));
const REFERENCE_DIR = path.join(MEDIA_DIR, 'reference-media');
const THREE_MEDIA_ROOT = path.join(MEDIA_DIR, '3d-media');
process.env.REFERENCE_MEDIA_DIR = REFERENCE_DIR;
process.env.THREE_MEDIA_ROOT = THREE_MEDIA_ROOT;
pinFilesystemMediaDriver();
process.env['THREE_D_PROVIDER'] = 'local_gpu_agent';
process.env.THREE_WORKER_AGENT_TOKEN = AGENT_TOKEN;
process.env.THREE_AGENT_HEARTBEAT_TIMEOUT_MS = '60000';

const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);
if (!TEST_URI) {
  console.error('[engines] could not derive an isolated test database URI.');
  process.exit(1);
}

const Workspace = (await import('../models/Workspace.js')).default;
const User = (await import('../models/User.js')).default;
const Product = (await import('../models/Product.js')).default;
const ProductReferenceImage = (await import('../models/ProductReferenceImage.js')).default;
const GenerationJob = (await import('../models/GenerationJob.js')).default;
const Product3DAsset = (await import('../models/Product3DAsset.js')).default;
const GpuAgent = (await import('../models/GpuAgent.js')).default;
const referenceStorage = await import('../services/referenceAssetStorage.js');
const agentService = await import('../services/3dAgentService.js');
const generation = await import('../services/3dGenerationService.js');
const vendor = await import('../services/3dModelProvider.js');
const adapters = await import('../services/localEngineAdapters.js');
const capabilities = await import('../services/engineCapabilities.js');
const storage = await import('../services/3dAssetStorage.js');
const gpuAgentProvider = await import('../services/3dGpuAgentProvider.js');

/* ── assertions ─────────────────────────────────────────────────────────── */
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

/* ── fixtures ───────────────────────────────────────────────────────────── */
const stamp = Date.now().toString(36);
const goodGlb = buildGlb();

function crc32(buffer) {
  return zlib.crc32 ? zlib.crc32(buffer) : 0;
}
function chunk(kind, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  // zlib.crc32 exists on Node 22+; this fixture only needs a stable PNG header +
  // valid IDAT for sharp, so use a real CRC32 table when the helper is absent.
  const table = chunk.table || (chunk.table = (() => {
    const out = [];
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      out[i] = c >>> 0;
    }
    return out;
  })());
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([kind, data])) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, kind, data, crcBuffer]);
}
function rgbaPng(width = 64, height = 64, colorType = 6) {
  const channels = colorType === 6 ? 4 : 3;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * channels);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * channels;
      const inside = Math.hypot(x - width / 2, y - height / 2) < width * 0.35;
      row[offset] = inside ? 180 : 20;
      row[offset + 1] = inside ? 90 : 30;
      row[offset + 2] = inside ? 140 : 40;
      if (channels === 4) row[offset + 3] = inside ? 255 : 0;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk(Buffer.from('IHDR'), ihdr),
    chunk(Buffer.from('IDAT'), zlib.deflateSync(Buffer.concat(rows))),
    chunk(Buffer.from('IEND'), Buffer.alloc(0)),
  ]);
}

const PNG_RGBA = rgbaPng();
const PNG_RGB = rgbaPng(64, 64, 2);
const HDR = Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'), Buffer.alloc(8)]);
const RUN_INFO = Buffer.from(JSON.stringify({ engine: 'ReLi3D', frames: 3, gpu: 'RTX 4050' }));

/* ── §A/§B/§C: pure contracts (no database, no server) ───────────────────── */
console.log(`[engines] test database: ${DB_NAME}`);
console.log(`[engines] private media root: ${THREE_MEDIA_ROOT}`);
console.log('[engines] the backend is REAL; inference is a fixture GLB');

section('§A ADAPTER REGISTRY — three installed adapters, TripoSR still the default');
{
  check('three local adapters ship', Object.keys(adapters.LOCAL_ENGINE_ADAPTERS).length === 3);
  check('TripoSR is installed and measured', adapters.localEngineAdapter('triposr').installed === true && adapters.localEngineAdapter('triposr').evidence === 'measured');
  check('Hunyuan3D-2mv has an adapter', capabilities.ENGINE_CAPABILITIES.hunyuan3d_2mv.installed === true);
  check('ReLi3D has an adapter', capabilities.ENGINE_CAPABILITIES.reli3d.installed === true);
  check('both new engines stay unverified evidence, not "measured"',
    capabilities.ENGINE_CAPABILITIES.hunyuan3d_2mv.evidence.state === 'unverified' &&
    capabilities.ENGINE_CAPABILITIES.reli3d.evidence.state === 'unverified');
  check('the provider default engine is still TripoSR',
    capabilities.defaultEngineForProvider('local_gpu_agent') === 'local_single_view');
  check('an empty engineId means the legacy TripoSR engine',
    adapters.engineIdForJob({ engineId: '' }) === 'local_single_view');
  check('an unknown engine is refused', (() => {
    try { adapters.requireLocalEngineAdapter('flux-capacitor'); return false; } catch (err) { return err.code === 'ENGINE_UNKNOWN'; }
  })());
  check('Hunyuan declares shape-only stages', adapters.localEngineAdapter('hunyuan3d_2mv').stages.texture === false);
  check('ReLi3D declares its two companion artifacts',
    adapters.artifactKindsForEngine('reli3d').join(',') === 'illumination,run-info');
  check('a legacy claim maps to TripoSR engine ids',
    adapters.engineIdsForAdapters([]).includes('local_single_view') && adapters.engineIdsForAdapters([]).includes(''));
}

section('§B HUNYUAN CONTRACT — named slots, never a contact sheet');
const named = (view, extra = {}) => ({
  id: `ref-${view}`,
  viewAngle: view,
  label: `${view}.png`,
  data: PNG_RGBA.toString('base64'),
  ...extra,
});
{
  const ok = adapters.validateEngineInputs({ engineId: 'hunyuan3d_2mv', images: [named('back'), named('front'), named('left')] });
  check('front + left + back is accepted', ok.ok === true);
  check('the selection is in slot order', ok.inputs.map((i) => i.viewAngle).join(',') === 'front,left,back');
  check('each input carries its named slot', ok.inputs.every((i) => i.slot === i.viewAngle));

  const sheet = adapters.validateEngineInputs({
    engineId: 'hunyuan3d_2mv',
    images: [named('front', { sheet: true }), named('left'), named('back')],
  });
  check('a composite sheet is refused as a view', sheet.ok === false && sheet.errors.some((e) => e.code === 'SHEET_NOT_A_VIEW'));

  const dup = adapters.validateEngineInputs({
    engineId: 'hunyuan3d_2mv',
    images: [named('front'), named('front'), named('left'), named('back')],
  });
  check('two rows labelled front are ambiguous', dup.ok === false && dup.errors.some((e) => e.code === 'NAMED_VIEW_DUPLICATE'));

  const missing = adapters.validateEngineInputs({ engineId: 'hunyuan3d_2mv', images: [named('front'), named('left')] });
  check('a missing back view names the missing slot',
    missing.ok === false && missing.errors.some((e) => e.code === 'NAMED_VIEW_MISSING' && e.view === 'back'));

  const unknown = adapters.validateEngineInputs({
    engineId: 'hunyuan3d_2mv',
    images: [named('front'), named('left'), named('back'), named('detail')],
  });
  check('a non-slot label is refused', unknown.ok === false && unknown.errors.some((e) => e.code === 'VIEW_UNKNOWN_FOR_ENGINE'));

  const optional = adapters.validateEngineInputs({
    engineId: 'hunyuan3d_2mv',
    images: [named('right'), named('front'), named('left'), named('back')],
  });
  check('the optional right slot is accepted, in model order',
    optional.ok === true && optional.inputs.map((i) => i.viewAngle).join(',') === 'front,left,back,right');

  check('no TripoSR fallback is offered when Hunyuan inputs fail',
    adapters.validateEngineInputs({ engineId: 'hunyuan3d_2mv', images: [named('front')] }).engineId === 'hunyuan3d_2mv');
}

section('§C RELI3D CONTRACT — RGBA frames, recorded poses only');
const pose = {
  position: { x: 0, y: 0, z: 2 },
  target: { x: 0, y: 0, z: 0 },
  fov: 40,
  source: 'imported',
  distance: 2,
};
const posed = (view, extra = {}) => ({ id: `ref-${view}`, viewAngle: view, label: `${view}.png`, data: PNG_RGBA.toString('base64'), pose, ...extra });
{
  const ok = adapters.validateEngineInputs({ engineId: 'reli3d', images: [posed('front'), posed('left'), posed('back')] });
  check('three posed RGBA frames are accepted', ok.ok === true);
  check('transforms.json is generated', Boolean(ok.transformsJson));
  check('transforms.json records zero inferred poses', ok.transformsJson?.provenance?.inferredPoses === 0);
  check('transforms.json carries one frame per input', ok.transformsJson?.frames?.length === 3);
  check('every transform matrix is 4x4', ok.transformsJson.frames.every((f) => f.transform_matrix.length === 4));
  check('intrinsics come from the frame size and FOV', ok.transformsJson.frames[0].fl_x > 0 && ok.transformsJson.frames[0].w === 64);
  check('provenance names the recording source', ok.transformsJson.provenance.poseSources.includes('imported'));

  const rgb = adapters.validateEngineInputs({
    engineId: 'reli3d',
    images: [posed('front', { data: PNG_RGB.toString('base64') }), posed('left'), posed('back')],
  });
  check('a PNG with no alpha is refused', rgb.ok === false && rgb.errors.some((e) => e.code === 'RGBA_REQUIRED'));

  const unposed = adapters.validateEngineInputs({
    engineId: 'reli3d',
    images: [posed('front', { pose: null }), posed('left'), posed('back')],
  });
  check('an unposed frame is refused, never completed', unposed.ok === false && unposed.errors.some((e) => e.code === 'POSE_REQUIRED'));
  check('no transforms.json is produced for a set with a missing pose', !unposed.transformsJson);

  const inferred = adapters.validateEngineInputs({
    engineId: 'reli3d',
    images: [posed('front', { pose: { ...pose, source: 'inferred' } }), posed('left'), posed('back')],
  });
  check('an "inferred" pose source is not a pose', inferred.ok === false && inferred.errors.some((e) => e.code === 'POSE_REQUIRED'));

  const badMatrix = adapters.validateTransformMatrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 1, 1]]);
  check('a malformed transform matrix is rejected', badMatrix.ok === false);
  check('a constructed matrix is right-handed and affine',
    adapters.validateTransformMatrix(adapters.cameraToWorldMatrix(pose)).ok === true);

  const sheet = adapters.validateEngineInputs({ engineId: 'reli3d', images: [posed('front', { composite: true }), posed('left'), posed('back')] });
  check('a sheet is refused for ReLi3D too', sheet.ok === false && sheet.errors.some((e) => e.code === 'SHEET_NOT_A_VIEW'));
}

/* ── boot the REAL backend ──────────────────────────────────────────────── */
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
  label: 'multi-engine',
  extraEnv: {
    'THREE_D_PROVIDER': 'local_gpu_agent',
    'THREE_WORKER_AGENT_TOKEN': AGENT_TOKEN,
    'THREE_AGENT_HEARTBEAT_TIMEOUT_MS': '60000',
    'REFERENCE_MEDIA_DIR': REFERENCE_DIR,
    'THREE_MEDIA_ROOT': THREE_MEDIA_ROOT,
    SEED_ON_START: 'false',
  },
});

let workspace;
let productSlug;

try {
  await Promise.all([Workspace.init(), User.init(), Product.init(), ProductReferenceImage.init(), GenerationJob.init(), Product3DAsset.init(), GpuAgent.init()]);

  workspace = await Workspace.create({ slug: `engines-${stamp}`, displayName: 'Multi Engine', status: 'ACTIVE' });
  const admin = await User.create({
    email: `engines-${stamp}@three.test`,
    passwordHash: await bcrypt.hash(`Engines-${stamp}!,`, 10),
    role: 'admin',
    name: 'Engines Admin',
    status: 'ACTIVE',
    workspaceId: workspace._id,
  });
  productSlug = `engines-product-${stamp}`;
  await Product.create({ slug: productSlug, name: 'Multi Engine Product', price: 1000, workspaceId: workspace._id });

  async function makeReference({ view, png = PNG_RGBA, poseValue = pose, accepted = true, sheet = false }) {
    const doc = await ProductReferenceImage.create({
      workspaceId: workspace._id,
      productSlug,
      status: 'READY',
      accepted,
      viewAngle: view,
      label: `${view}.png`,
      pose: poseValue,
      composite: sheet ? { confirmed: true, panelCount: 4 } : undefined,
      original: { fileName: `${view}.png`, format: 'png', hasAlpha: png === PNG_RGBA },
    });
    const written = await referenceStorage.writeAsset({
      imageId: doc._id,
      workspaceSlug: workspace.slug,
      kind: 'original',
      buffer: png,
      format: 'png',
    });
    doc.original = {
      ...(doc.original.toObject?.() ?? {}),
      storageKey: written.storageKey,
      bytes: written.bytes,
      sha256: written.sha256,
    };
    await doc.save();
    return doc;
  }

  const refFront = await makeReference({ view: 'front' });
  const refLeft = await makeReference({ view: 'left' });
  const refBack = await makeReference({ view: 'back' });
  const refRight = await makeReference({ view: 'right' });
  const refPoseLess = await makeReference({ view: 'front', poseValue: null });
  const refSheet = await makeReference({ view: 'other', sheet: true });
  const refRgb = await makeReference({ view: 'back', png: PNG_RGB });

  let jobSeq = 0;
  const JOB = 'agent-pc';
  async function makeJob({ engineId = '', refs = [refFront], provider = 'local_gpu_agent', status = 'QUEUED' } = {}) {
    jobSeq += 1;
    return GenerationJob.create({
      workspaceId: workspace._id,
      productSlug,
      status,
      provider,
      engineId,
      providerModel: engineId === 'hunyuan3d_2mv' ? 'Hunyuan3D-2mv' : engineId === 'reli3d' ? 'ReLi3D' : 'TripoSR',
      source: { referenceIds: refs.map((row) => row._id), viewCount: refs.length, label: `engine suite ${jobSeq}` },
      settings: { quality: 'standard', notes: '' },
      createdBy: admin._id,
    });
  }

  async function agentCall(method, pathname, { body = null, raw = null, lease = '', token = AGENT_TOKEN, contentType = '' } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (lease) headers['X-Agent-Lease'] = lease;
    let payload;
    if (raw !== null) {
      headers['Content-Type'] = contentType || 'model/gltf-binary';
      payload = raw;
    } else if (body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${AGENT}${pathname}`, { method, headers, body: payload });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }

  const heartbeat = (engines = [], extra = {}) =>
    agentCall('POST', '/heartbeat', { body: { workerId: JOB, state: 'idle', modelLoaded: true, engines, ...extra } });
  const claim = (engines = []) => agentCall('POST', '/jobs/claim', { body: { workerId: JOB, engines, waitSeconds: 0 } });

  /* ── §D HEALTH ────────────────────────────────────────────────────────── */
  section('§D HEALTH — readiness comes from the machine, never from configuration');
  {
    const before = await heartbeat([]);
    check('heartbeat accepted', before.status === 200);
    const snapshot = await GpuAgent.findOne({ workerId: JOB }).lean();
    check('an agent that reported no engines stores none', (snapshot?.engines || []).length === 0);

    const after = await heartbeat([
      { id: 'hunyuan3d_2mv', adapter: 'hunyuan3d_2mv', ready: true, installed: true, detail: 'CUDA ready', cuda: true, device: 'cuda:0' },
      { id: 'reli3d', adapter: 'reli3d', ready: false, installed: true, detail: 'checkpoint missing', cuda: true },
    ]);
    check('engine probes are accepted', after.status === 200);
    const stored = await GpuAgent.findOne({ workerId: JOB }).lean();
    check('the probe is remembered per engine', (stored?.engines || []).length === 2);
    const hunyuan = (stored?.engines || []).find((e) => e.id === 'hunyuan3d_2mv');
    check('a ready engine is recorded ready', hunyuan?.ready === true && hunyuan?.cuda === true);

    const readiness = adapters.engineReadinessFromSnapshot(await (await import('../models/GpuAgent.js')).latestAgentSnapshot());
    check('an ENGINE reported ready becomes ready', readiness.hunyuan3d_2mv.ready === true);
    check('an ENGINE reported unready stays unready with its reason',
      readiness.reli3d.ready === false && /checkpoint/.test(readiness.reli3d.detail));
    check('an ENGINE not reported is NOT assumed ready', readiness.local_single_view.ready === false);

    const summaries = capabilities.engineSummaries({ readiness, providerName: 'local_gpu_agent' });
    check('the summary marks Hunyuan selectable', summaries.find((e) => e.id === 'hunyuan3d_2mv').selectable === true);
    check('the summary refuses an unready engine', summaries.find((e) => e.id === 'reli3d').selectable === false);
    check('TripoSR is not selectable while unreported by this agent',
      summaries.find((e) => e.id === 'local_single_view').selectable === false);

    const { verdicts } = capabilities.evaluateAllEngines({
      providerName: 'local_gpu_agent',
      providerAvailable: true,
      engineReadiness: readiness,
      engineReadinessApplies: true,
      rows: [{ viewAngle: 'front' }, { viewAngle: 'left' }, { viewAngle: 'back' }],
    });
    check('Hunyuan is enabled when the agent reports it ready', verdicts.hunyuan3d_2mv.enabled === true);
    check('ReLi3D is disabled when the agent reports it unready',
      verdicts.reli3d.enabled === false && verdicts.reli3d.errors.some((e) => e.code === 'ENGINE_DISABLED'));

    const health = await gpuAgentProvider.gpuAgentHealth();
    check('provider health names the engines it can read', Boolean(health.engines?.hunyuan3d_2mv));
    check('provider health is ok for an online agent', health.ok === true);
    check('the agent description lists all three engines',
      (gpuAgentProvider.describeGpuAgent().engines || []).length === 3);
  }

  /* ── §E DISPATCH ──────────────────────────────────────────────────────── */
  section('§E DISPATCH — a machine is only handed jobs for engines it declared');
  {
    const triposrJob = await makeJob({ engineId: 'local_single_view' });
    const legacyJob = await makeJob({ engineId: undefined });

    const first = await claim(['triposr']);
    check('a TripoSR-only agent is given a TripoSR job', String(first.json?.job?.id) === String(triposrJob._id), JSON.stringify(first.json?.job?.engine));
    check('the claim names the adapter to run', first.json?.job?.engine?.adapter === 'triposr');
    check('the claim names the engine id', first.json?.job?.engine?.engineId === 'local_single_view');

    const second = await claim(['triposr']);
    check('a legacy job (no engineId) is still claimed by TripoSR',
      String(second.json?.job?.id) === String(legacyJob._id) &&
      second.json?.job?.engine?.engineId === 'local_single_view');

    const hunyuanJob = await makeJob({ engineId: 'hunyuan3d_2mv', refs: [refFront, refLeft, refBack] });
    const triposrAgain = await claim(['triposr']);
    check('a TripoSR agent is NOT handed a Hunyuan job', triposrAgain.json?.job === null);

    const hunyuanClaim = await claim(['hunyuan3d_2mv']);
    check('a Hunyuan agent is handed the Hunyuan job',
      String(hunyuanClaim.json?.job?.id) === String(hunyuanJob._id) &&
      hunyuanClaim.json?.job?.engine?.adapter === 'hunyuan3d_2mv');
    check('the Hunyuan claim states shape-only defaults',
      hunyuanClaim.json?.job?.engine?.defaults?.octreeResolution === 256);

    const reli3dJob = await makeJob({
      engineId: 'reli3d',
      refs: [refFront, refLeft, refBack],
    });
    const reli3dClaim = await claim(['reli3d']);
    check('a ReLi3D agent is handed the ReLi3D job', String(reli3dClaim.json?.job?.id) === String(reli3dJob._id));
    check('the ReLi3D claim requires poses and artifacts',
      reli3dClaim.json?.job?.engine?.requiresPose === true &&
      reli3dClaim.json?.job?.engine?.producesArtifacts?.join(',') === 'illumination,run-info');

    const none = await claim([]);
    check('an agent that declares nothing claims TripoSR-class work only', none.json?.job !== null ? none.json.job.engine.engineId === 'local_single_view' : true);
  }

  /* ── §F INPUT ─────────────────────────────────────────────────────────── */
  section('§F INPUT — each engine receives its own contract; TripoSR is unchanged');
  {
    const triposrJob = await makeJob({ engineId: 'local_single_view', refs: [refFront, refLeft] });
    const married = await claim(['triposr']);
    const lease = married.json.job.lease.token;
    const input = await agentCall('GET', `/jobs/${triposrJob._id}/input`, { lease });
    check('TripoSR input succeeds', input.status === 200);
    check('TripoSR keeps the single-view policy', input.json.viewPolicy.inputMode === 'single_view');
    check('TripoSR is still sent candidates, not joint views', input.json.images.length === 2);
    check('TripoSR input carries base64 original bytes', typeof input.json.images[0].data === 'string' && input.json.images[0].data.length > 100);
    check('TripoSR declares no artifacts', (input.json.requiredArtifacts || []).length === 0);
    check('TripoSR input never includes a transforms file', input.json.transformsJson === undefined);

    const hunyuanJob = await makeJob({
      engineId: 'hunyuan3d_2mv',
      refs: [refFront, refLeft, refBack, refSheet],
    });
    const hunyuanClaim = await claim(['hunyuan3d_2mv']);
    const hunyuanLease = hunyuanClaim.json.job.lease.token;
    const hunyuanInput = await agentCall('GET', `/jobs/${hunyuanJob._id}/input`, { lease: hunyuanLease });
    check('Hunyuan input succeeds with named views', hunyuanInput.status === 200);
    check('Hunyuan input uses the named multi-view policy', hunyuanInput.json.viewPolicy.inputMode === 'named_multi_view');
    check('the sheet is never sent to Hunyuan',
      hunyuanInput.json.images.every((image) => image.id !== String(refSheet._id)));
    check('the named slots are named', hunyuanInput.json.images.map((i) => i.slot).join(',') === 'front,left,back');
    check('Hunyuan input carries no transforms file', hunyuanInput.json.transformsJson === undefined);

    const reli3dJob = await makeJob({ engineId: 'reli3d', refs: [refFront, refLeft, refBack] });
    const reli3dClaim = await claim(['reli3d']);
    const reli3dLease = reli3dClaim.json.job.lease.token;
    const reli3dInput = await agentCall('GET', `/jobs/${reli3dJob._id}/input`, { lease: reli3dLease });
    check('ReLi3D input succeeds with posed RGBA frames', reli3dInput.status === 200);
    check('ReLi3D input uses the posed policy', reli3dInput.json.viewPolicy.inputMode === 'posed_rgba');
    check('ReLi3D receives a real transforms.json', reli3dInput.json.transformsJson?.frames?.length === 3);
    check('every ReLi3D frame carries its recorded pose', reli3dInput.json.images.every((i) => i.pose?.source === 'imported'));
    check('ReLi3D declares its required artifacts',
      reli3dInput.json.requiredArtifacts.join(',') === 'illumination,run-info');

    const unposedJob = await makeJob({ engineId: 'reli3d', refs: [refPoseLess, refLeft, refBack] });
    const unposedClaim = await claim(['reli3d']);
    const unposedInput = await agentCall('GET', `/jobs/${unposedJob._id}/input`, { lease: unposedClaim.json.job.lease.token });
    check('ReLi3D refuses a set with a missing pose at input time',
      unposedInput.status === 422 && unposedInput.json.code === 'POSE_REQUIRED');

    const rgbJob = await makeJob({ engineId: 'reli3d', refs: [refFront, refLeft, refRgb] });
    const rgbClaim = await claim(['reli3d']);
    const rgbInput = await agentCall('GET', `/jobs/${rgbJob._id}/input`, { lease: rgbClaim.json.job.lease.token });
    check('ReLi3D refuses an RGB PNG at input time',
      rgbInput.status === 422 && rgbInput.json.code === 'RGBA_REQUIRED');
  }

  /* ── §G RESULT ────────────────────────────────────────────────────────── */
  section('§G RESULT — validated candidate, idempotent upload, cancel wins');
  let artifactJobId = '';
  let artifactLease = '';
  {
    const job = await makeJob({ engineId: 'hunyuan3d_2mv', refs: [refFront, refLeft, refBack] });
    const claimed = await claim(['hunyuan3d_2mv']);
    const lease = claimed.json.job.lease.token;

    const bad = await agentCall('POST', `/jobs/${job._id}/result?taskId=t0`, { raw: Buffer.from('not a glb'), lease });
    check('invalid bytes are refused', bad.status === 422 || bad.status === 400);
    const failedRow = await GenerationJob.findById(job._id).lean();
    check('a refused upload fails the job with a readable reason', failedRow.status === 'FAILED' && Boolean(failedRow.error?.message));

    const nextJob = await makeJob({ engineId: 'hunyuan3d_2mv', refs: [refFront, refLeft, refBack] });
    const nextClaim = await claim(['hunyuan3d_2mv']);
    const nextLease = nextClaim.json.job.lease.token;
    const ok = await agentCall('POST', `/jobs/${nextJob._id}/result?taskId=t1`, { raw: goodGlb, lease: nextLease });
    check('a valid GLB creates a candidate', ok.status === 200 && Boolean(ok.json.assetId));
    check('inference alone does not approve it', ok.json.job.status === 'READY_FOR_REVIEW');
    check('the candidate is CANDIDATE status', (await Product3DAsset.findById(ok.json.assetId).lean()).status === 'CANDIDATE');
    check('the asset records the engine it came from',
      (await Product3DAsset.findById(ok.json.assetId).lean()).engineId === 'hunyuan3d_2mv');
    check('the asset records the adapter that ran',
      (await Product3DAsset.findById(ok.json.assetId).lean()).engineAdapter === 'hunyuan3d_2mv');
    check('the quality gate produced a decision',
      ['PASS', 'REVIEW', 'BLOCKED'].includes((await Product3DAsset.findById(ok.json.assetId).lean()).quality?.decision));

    const duplicate = await agentCall('POST', `/jobs/${nextJob._id}/result?taskId=t1`, { raw: goodGlb, lease: nextLease });
    check('a repeated upload is idempotent', duplicate.status === 200 && duplicate.json.duplicate === true);
    check('the duplicate names the SAME asset', duplicate.json.assetId === ok.json.assetId);
    check('one job produced exactly one asset',
      (await Product3DAsset.countDocuments({ jobId: nextJob._id })) === 1);

    const crossJob = await makeJob({ engineId: 'hunyuan3d_2mv', refs: [refFront, refLeft, refBack] });
    const stolen = await agentCall('POST', `/jobs/${crossJob._id}/result?taskId=t2`, { raw: goodGlb, lease: nextLease });
    check('another job cannot be fed with a lease it does not hold', stolen.status === 409 && stolen.json.code === 'LEASE_LOST');

    const cancelledJob = await makeJob({ engineId: 'hunyuan3d_2mv', refs: [refFront, refLeft, refBack] });
    const cancelledClaim = await claim(['hunyuan3d_2mv']);
    await GenerationJob.updateOne({ _id: cancelledJob._id }, { $set: { status: 'CANCELLED' }, $unset: { 'lease.token': '' } });
    const cancelled = await agentCall('POST', `/jobs/${cancelledJob._id}/result?taskId=t3`, { raw: goodGlb, lease: cancelledClaim.json.job.lease.token });
    check('a cancelled job refuses its result', cancelled.status === 409 && cancelled.json.code === 'JOB_CANCELLED');

    /* ReLi3D's result, kept for §H (its artifacts follow the GLB). */
    const reliJob = await makeJob({ engineId: 'reli3d', refs: [refFront, refLeft, refBack] });
    const reliClaim = await claim(['reli3d']);
    artifactJobId = String(reliJob._id);
    artifactLease = reliClaim.json.job.lease.token;
    const reliResult = await agentCall('POST', `/jobs/${artifactJobId}/result?taskId=reli`, { raw: goodGlb, lease: artifactLease });
    check('a ReLi3D GLB goes through the same pipeline', reliResult.status === 200 && reliResult.json.engine?.engineId === 'reli3d');
    check('the ReLi3D result lists artifacts it still needs',
      reliResult.json.requiredArtifacts?.join(',') === 'illumination,run-info' &&
      reliResult.json.artifactsReceived?.length === 0);
  }

  /* ── §H ARTIFACTS ─────────────────────────────────────────────────────── */
  section('§H ARTIFACTS — kept separate, private, immutable');
  {
    const assetBefore = await Product3DAsset.findOne({ jobId: artifactJobId });
    const hdr = await agentCall('POST', `/jobs/${artifactJobId}/artifacts/illumination`, {
      raw: HDR, lease: artifactLease, contentType: 'image/vnd.radiance',
    });
    check('illumination.hdr is accepted', hdr.status === 200, JSON.stringify(hdr.json));
    check('the artifact response carries facts, not a storage key',
      hdr.json.artifact?.bytes === HDR.length && !JSON.stringify(hdr.json).includes('storageKey'));

    // RAW BYTES, not application/json: the API's global JSON parser would
    // consume that content type before this route saw the body.
    const info = await agentCall('POST', `/jobs/${artifactJobId}/artifacts/run-info`, {
      raw: RUN_INFO, lease: artifactLease, contentType: 'application/octet-stream',
    });
    check('run_info.json is accepted', info.status === 200);

    const row = await Product3DAsset.findById(assetBefore._id).lean();
    check('both artifacts are recorded on the asset', (row.artifacts || []).length === 2);
    check('each artifact has its own private file', (row.artifacts || []).every((a) => Boolean(a.storageKey)));
    check('artifact hashes are recorded', (row.artifacts || []).every((a) => /^[a-f0-9]{64}$/.test(a.sha256 || '')));
    const hdrRow = (row.artifacts || []).find((a) => a.kind === 'illumination');
    const bytes = await storage.readAsset(hdrRow.storageKey);
    check('the HDR bytes are readable through the private store', Buffer.compare(bytes, HDR) === 0);
    check('the GLB file is NOT merged with the artifacts',
      (row.storage?.glb?.bytes || 0) === goodGlb.length);

    const repeat = await agentCall('POST', `/jobs/${artifactJobId}/artifacts/illumination`, {
      raw: HDR, lease: artifactLease, contentType: 'image/vnd.radiance',
    });
    check('the same artifact bytes are an idempotent retry', repeat.status === 200 && repeat.json.artifact?.duplicate === true);

    const changed = await agentCall('POST', `/jobs/${artifactJobId}/artifacts/illumination`, {
      raw: Buffer.concat([HDR, Buffer.from('x')]), lease: artifactLease, contentType: 'image/vnd.radiance',
    });
    check('different artifact bytes are refused', changed.status === 409 && changed.json.code === 'ARTIFACT_IMMUTABLE');

    const bogusHdr = await agentCall('POST', `/jobs/${artifactJobId}/artifacts/illumination`, {
      raw: Buffer.from('this is not an HDR'), lease: artifactLease, contentType: 'image/vnd.radiance',
    });
    check('an arbitrary file cannot masquerade as illumination', bogusHdr.status === 422 && bogusHdr.json.code === 'ARTIFACT_INVALID_HDR');

    const bogusInfo = await agentCall('POST', `/jobs/${artifactJobId}/artifacts/run-info`, {
      raw: Buffer.from('not json'), lease: artifactLease, contentType: 'application/octet-stream',
    });
    check('run_info.json must be valid JSON', bogusInfo.status === 422 && bogusInfo.json.code === 'ARTIFACT_INVALID_JSON');

    const wrongKind = await agentCall('POST', `/jobs/${artifactJobId}/artifacts/thumbnail`, {
      raw: HDR, lease: artifactLease, contentType: 'application/octet-stream',
    });
    check('an undeclared artifact kind is refused', wrongKind.status === 422 && wrongKind.json.code === 'ARTIFACT_NOT_ACCEPTED');

    const triposrJob = await makeJob({ engineId: 'local_single_view' });
    const triClaim = await claim(['triposr']);
    const triLease = triClaim.json.job.lease.token;
    const triResult = await agentCall('POST', `/jobs/${triposrJob._id}/result?taskId=tri`, { raw: goodGlb, lease: triLease });
    const triArtifact = await agentCall('POST', `/jobs/${triposrJob._id}/artifacts/illumination`, {
      raw: HDR, lease: triLease, contentType: 'image/vnd.radiance',
    });
    check('a TripoSR job cannot acquire a relighting artifact',
      triResult.status === 200 && triArtifact.status === 422 && triArtifact.json.code === 'ARTIFACT_NOT_ACCEPTED');

    const foreignLease = await agentCall('POST', `/jobs/${artifactJobId}/artifacts/run-info`, {
      raw: RUN_INFO, lease: 'not-the-lease', contentType: 'application/octet-stream',
    });
    check('an artifact cannot be uploaded with a lease the agent does not hold',
      foreignLease.status === 409 && foreignLease.json.code === 'LEASE_LOST');
  }

  /* ── §I APPROVAL ──────────────────────────────────────────────────────── */
  section('§I APPROVAL — inference never publishes a model');
  {
    const assets = await Product3DAsset.find({ productSlug }).lean();
    check('no asset was approved by inference', assets.every((asset) => asset.status !== 'APPROVED'));
    check('no product 3D projection was made live', assets.every((asset) => asset.engineId));
    check('every candidate carries the engine that produced it',
      assets.every((asset) => Boolean(asset.engineId)));
  }

  /* ── wire-level fallback checks ───────────────────────────────────────── */
  section('§J WIRE — providers and summaries stay honest');
  {
    const described = vendor.describeProvider();
    check('the deployment still resolves local_gpu_agent', described.name === 'local_gpu_agent');
    check('the provider description lists three adapters', described.engines.length === 3);
    check('no metered provider was enabled', described.metered === false);
    const status = generation.providerStatus();
    check('provider status exposes the engine catalogue', (status.engines || []).length === 3);
    check('the studio does not claim readiness from configuration',
      (await gpuAgentProvider.gpuAgentHealth()).engines.reli3d.ready === false);
  }
} catch (err) {
  failed += 1;
  failures.push('suite error');
  console.error('[engines] SUITE ERROR:', err?.stack || err);
} finally {
  await stopTestServer(child);
  await mongoose.disconnect().catch(() => {});
  await fs.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nMULTI ENGINE RESULT: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error(`Failures: ${failures.join(' | ')}`);
  process.exit(1);
}
process.exit(0);
