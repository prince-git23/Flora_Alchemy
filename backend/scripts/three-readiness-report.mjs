/**
 * three-readiness-report — read-only operational status of the 3D product
 * model feature. Answers four DIFFERENT questions that are easy to conflate:
 *
 *   1. is the feature implemented?         (code + routes present)
 *   2. is a generation provider reachable? (loopback worker / opt-in Meshy)
 *   3. is private media storage durable?   (a mounted disk, not the app tree)
 *   4. does any product actually have an approved, readable GLB?
 *
 * Usage (from backend/):
 *   node scripts/three-readiness-report.mjs                 # configured MONGO_URI
 *   node scripts/three-readiness-report.mjs --db=Flora-Alchemy
 *
 * It never writes, never spends credits, never prints credentials — provider
 * keys are reported as set/unset only, and the worker is probed on loopback.
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import { loadBackendEnv } from './lib/testServer.mjs';
import { classifyDatabase } from '../utils/environmentGuard.js';
import {
  mediaRootInfo as referenceRootInfo,
  mediaStatus as referenceMediaStatus,
} from '../services/referenceAssetStorage.js';
import { mediaRootInfo as threeRootInfo, mediaStatus as threeMediaStatus } from '../services/3dAssetStorage.js';
import { MAX_GLB_BYTES } from '../services/3dModelValidation.js';
import { bucketPrivacy, usingObjectStorage } from '../services/privateObjectStorage.js';
import {
  LEGACY_PROVIDER_ENV_VAR,
  PROVIDER_ENV_VAR,
  PROVIDER_LOCAL_GPU_AGENT,
  providerConfigDiagnostics,
  resolveProvider,
} from '../services/3dModelProvider.js';

loadBackendEnv();

const argv = process.argv.slice(2);
const dbArg = argv.find((a) => a.startsWith('--db='));
const targetDb = dbArg ? dbArg.slice(5) : null;

const rows = [];
const row = (stage, status, detail) => rows.push({ stage, status, detail });

// ── 1. implemented? (static evidence from this checkout) ──────────────────
{
  const backend = [
    'services/referenceImageService.js', 'services/bgRemoval/index.js',
    'services/3dModelProvider.js', 'services/3dLocalWorkerProvider.js',
    'services/3dGpuAgentProvider.js', 'services/3dAgentService.js',
    'services/privateObjectStorage.js', 'services/3dGenerationService.js',
    'services/3dAssetService.js',
    'services/3dModelValidation.js', 'services/3dAssetStorage.js',
    'services/3dQualityAssessment.js', 'services/product3dPublicResolution.js',
    'routes/referenceImageRoutes.js', 'routes/3dModelRoutes.js', 'routes/3dPublicRoutes.js',
    'routes/3dAgentRoutes.js', 'middleware/agentAuthMiddleware.js',
  ];
  const frontend = [
    '../frontend/src/components/admin/ReferenceImageStudio.jsx',
    '../frontend/src/components/admin/GenerationJobsForProduct.jsx',
    '../frontend/src/components/admin/ThreeGlbPreview.jsx',
    '../frontend/src/components/Product3dViewer.jsx',
  ];
  // PATH CONVENTION: every entry is relative to backend/ (the `../` prefix
  // below turns that into a URL relative to this script). The agent script
  // therefore sits one level ABOVE backend/ — `../tools/...`, not `../../tools/...`.
  const agent = ['../tools/3d-worker/agent.py'];
  const missing = [...backend, ...frontend, ...agent].filter((p) => !fs.existsSync(new URL(`../${p}`, import.meta.url)));
  row('implemented (code)', missing.length ? 'partial' : 'yes',
    missing.length ? `missing: ${missing.join(', ')}` : `${backend.length} backend + ${frontend.length} frontend + ${agent.length} agent modules present`);
}

// ── 2. provider reachable? ────────────────────────────────────────────────
{
  // Selection is read through the SAME accessor the server uses, so this report
  // can never disagree with the running API about which variable (canonical or
  // the deprecated alias) actually configured the provider.
  const diagnostics = providerConfigDiagnostics();
  const selected = diagnostics.selected;
  const selection = diagnostics.source
    ? `${diagnostics.source}=${diagnostics.requested || '(empty)'}`
    : `${PROVIDER_ENV_VAR} unset → local_unavailable, generation disabled`;
  // The alias is a compatibility shim, not a deployment value — say so before a
  // host that rejects digit-leading names has to say it for us.
  const aliasNote = diagnostics.legacyAliasUsed
    ? ` · DEPRECATED: ${LEGACY_PROVIDER_ENV_VAR} used — rename it to ${PROVIDER_ENV_VAR}`
    : '';
  const unknownNote = diagnostics.recognized
    ? ''
    : ' · UNRECOGNIZED VALUE (valid: local_worker, local_gpu_agent, meshy)';
  const meshyKeySet = Boolean(String(process.env.MESHY_API_KEY || '').trim());
  const workerUrl = String(process.env.THREE_WORKER_URL || 'http://127.0.0.1:8791');
  let reachable = false;
  let reason = '';
  try {
    const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(2500) });
    reachable = res.ok;
    reason = `HTTP ${res.status}`;
  } catch (e) {
    reason = `no answer at ${workerUrl} (${e.cause?.code || e.name || 'error'})`;
  }
  if (selected === PROVIDER_LOCAL_GPU_AGENT) {
    // The backend never dials the agent — a loopback probe would be a category
    // error. Configuration and LIVE availability are reported separately (the
    // heartbeat row below, read from the database).
    const agentTokenSet = Boolean(String(process.env.THREE_WORKER_AGENT_TOKEN || '').trim());
    row('generation provider', agentTokenSet ? 'configured' : 'unavailable',
      `${PROVIDER_ENV_VAR}=${PROVIDER_LOCAL_GPU_AGENT} · machine token set: ${agentTokenSet} · ` +
      `agent calls ${String(process.env.THREE_WORKER_AGENT_URL || '(THREE_WORKER_AGENT_URL unset)')} · ` +
      'live availability is the GPU agent heartbeat (see below)' + aliasNote);
  } else {
    const operational = reachable || (selected === 'meshy' && meshyKeySet);
    row('generation provider', operational ? 'available' : 'unavailable',
      `${selection}${unknownNote}${aliasNote} · local worker: ${reason} · MESHY_API_KEY set: ${meshyKeySet}`);
  }
}

// ── 3. private storage durable AND private? ───────────────────────────────
{
  // `mediaRootInfo()` answers "where do the bytes live" synchronously but knows
  // nothing about an OBJECT driver's configuration — reading only it printed
  // `supabase object storage (NOT configured)` while the bucket was live and
  // answering. `mediaStatus()` is the authority for driver configuration; it is
  // read with `probe: false` (no list request), and the bucket's PRIVACY is then
  // verified explicitly with one bounded, read-only GET of the bucket's own
  // metadata. Durability without privacy is not usable private media, so the
  // verdict below is `blocked` whenever privacy cannot be established.
  const ref = { ...referenceRootInfo(), ...(await referenceMediaStatus({ probe: false })) };
  const three = { ...threeRootInfo(), ...(await threeMediaStatus({ probe: false })) };
  const privacy = usingObjectStorage() ? await bucketPrivacy({ force: true }) : null;
  const fmt = (r) =>
    r.driver && r.driver !== 'fs'
      ? `${r.driver} object storage (${r.configured ? 'configured' : 'NOT configured'}${r.usable === true ? ' · answered probe' : r.usable === false ? ' · probe FAILED' : ''})`
      : `${r.configured ? 'configured' : 'NOT configured'}${r.durable ? ' · durable' : ' · EPHEMERAL (inside the app tree)'}`;
  const durable = Boolean(ref.durable && three.durable);
  const privateConfirmed = !privacy || privacy.private === true;
  const mib = (bytes) => `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
  row('private media storage', durable && privateConfirmed ? 'durable' : 'blocked',
    `driver=${ref.driver || 'fs'} · reference: ${fmt(ref)} · 3d: ${fmt(three)} · ` +
    `GLB ceiling: ${mib(MAX_GLB_BYTES)} per file`);
  if (privacy) {
    const label = privacy.private === true ? 'private' : privacy.public === true ? 'PUBLIC' : 'unverified';
    row('bucket privacy', label,
      `bucket "${privacy.bucket}" · ${privacy.checked ? 'checked' : 'not checked'}` +
        `${privacy.private === true ? ' · confirmed private' : ` · ${privacy.reason} Writes are blocked until this is fixed.`}`);
  }
}

// ── 4. does any product actually have an approved, readable GLB? ──────────
{
  const uri = process.env.MONGO_URI;
  const cls = classifyDatabase(uri);
  const dbName = targetDb || cls.dbName;
  // Re-derived here (each section is its own scope) for the agent row below.
  // The variable NAME is reported from the same diagnostics as §2, so the row
  // never claims `THREE_D_PROVIDER=<value>` when the deprecated alias is what
  // actually configured it.
  const providerDiagnostics = providerConfigDiagnostics();
  const provider = resolveProvider();
  const providerVar = providerDiagnostics.source || PROVIDER_ENV_VAR;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 12000 });
    const db = mongoose.connection.useDb(dbName, { noStore: true }).db;
    const assets = db.collection('product3dassets');
    const refs = db.collection('productreferenceimages');
    const jobs = db.collection('generationjobs');
    const products = await db.collection('products').countDocuments({});
    const approved = await assets.countDocuments({ status: 'approved' });
    const withBytes = await assets.countDocuments({ status: 'approved', 'file.storageKey': { $exists: true } });
    const readable = await assets.countDocuments({ status: 'approved', 'validation.valid': true });
    const refImages = await refs.countDocuments({});
    const jobCount = await jobs.countDocuments({});
    let missingFiles = 0;
    const threeRoot = threeRootInfo();
    // A local existence check only means something for the filesystem driver;
    // under object storage the bytes are not on this machine's disk.
    if (threeRoot.driver === 'fs') {
      for (const a of await assets.find({ status: 'approved' }).project({ 'file.storageKey': 1 }).toArray()) {
        const key = a.file?.storageKey;
        if (!key || !fs.existsSync(`${threeRoot.root}/${key}`)) missingFiles += 1;
      }
    }
    row('approved models on the live data', approved > 0 && readable > 0 ? 'present' : 'none',
      `database "${dbName}": products=${products} · approved assets=${approved} ` +
      `(with storage key: ${withBytes}, validation valid: ${readable}, bytes missing on disk: ${missingFiles}) · ` +
      `reference images=${refImages} · generation jobs=${jobCount}`);

    // ── 5. GPU agent heartbeat (only meaningful for the agent provider) ──
    if (provider === PROVIDER_LOCAL_GPU_AGENT) {
      const agents = db.collection('gpuagents');
      const newest = await agents.findOne({}, { sort: { lastSeenAt: -1 } });
      const staleMs = Number(process.env.THREE_AGENT_HEARTBEAT_TIMEOUT_MS) > 0
        ? Number(process.env.THREE_AGENT_HEARTBEAT_TIMEOUT_MS)
        : 60_000;
      if (!newest) {
        row('GPU agent', 'offline', 'configured, but no agent has ever checked in — start tools/3d-worker/agent.py on the PC');
      } else {
        const ageMs = Date.now() - new Date(newest.lastSeenAt).getTime();
        row('GPU agent', ageMs <= staleMs ? 'online' : 'offline',
          `worker=${newest.workerId} · state=${newest.state} · modelLoaded=${newest.modelLoaded} ` +
          `· last seen ${Math.round(ageMs / 1000)}s ago (stale after ${Math.round(staleMs / 1000)}s)` +
          (newest.gpuName ? ` · ${newest.gpuName}` : ''));
      }
    } else {
      row('GPU agent', 'n/a', `${providerVar}=${provider} — the remote agent is only used with ${PROVIDER_ENV_VAR}=${PROVIDER_LOCAL_GPU_AGENT}`);
    }
  } catch (e) {
    row('approved models on the live data', 'unknown', `could not read "${dbName}": ${e.codeName || e.message}`);
    if (provider === PROVIDER_LOCAL_GPU_AGENT) row('GPU agent', 'unknown', 'the database was unreachable');
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

console.log('\n3D PRODUCT MODEL — OPERATIONAL READINESS');
console.log('─────────────────────────────────────────────────────────────');
for (const r of rows) console.log(`  ${r.stage.padEnd(30)} ${r.status.padEnd(12)} ${r.detail}`);
console.log('─────────────────────────────────────────────────────────────');
console.log('  note: "implemented" describes this checkout; "available" describes THIS machine.');
console.log('  With THREE_D_PROVIDER=local_gpu_agent the deployed API never dials the PC — availability');
console.log('  is the agent\'s own heartbeat (start tools/3d-worker/agent.py on the GPU machine).');
process.exit(0);
