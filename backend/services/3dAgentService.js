/**
 * 3D AGENT SERVICE — the machine-facing half of the 3D Studio.
 *
 * Every function here is driven by the AGENT's authenticated requests (routes/
 * 3dAgentRoutes.js), never by a staff session. The authority for what an agent
 * may do to a job is always, in this order:
 *
 *   1. the MACHINE credential (checked once, in the middleware);
 *   2. the job's own LEASE token, minted at claim time by THIS server and
 *      compared timing-safely (models/GenerationJob.loadLeasedJob);
 *   3. the AUTHORITATIVE job document re-read from MongoDB on every call — the
 *      agent's claims about workspace, references or job state are never
 *      trusted, only its bytes and its reports.
 *
 * SERVICE BOUNDARY — THE TRUSTED CONTEXT
 *   The candidate/quality pipeline (`3dAssetService.createCandidateFromGeneration`
 *   and everything it calls) was written around a live staff request and reads
 *   `req.user` for scoping and attribution. A queued agent's result arrives on a
 *   SEPARATE request, minutes after the staff request that authorised the job
 *   has ended. The answer is NOT a fake admin request and NOT a bypass: each
 *   result call builds a narrow trusted context
 *       { user: null, workspaceId, workspaceSlug }
 *   from the JOB's own records (its workspace, and that workspace's slug), and
 *   the pipeline scopes by it (`scopeFor`). Tenancy is preserved — it is derived
 *   from the authorised job, not from anything the machine sent.
 *
 * IDEMPOTENCY
 *   `submitResult` takes an atomic RESULT SLOT on the job (lease-guarded, once
 *   per job). A repeated upload — a network retry, a reconnect — gets the same
 *   answer without creating a second candidate asset. A result that arrives
 *   after cancellation or a lease takeover is REFUSED and any candidate created
 *   in that window is discarded, so a stopped job cannot resurrect.
 */

import mongoose from 'mongoose';
import { ApiError } from '../middleware/errorMiddleware.js';
import {
  agentLeaseMs,
  claimNextJobForAgent,
  failJobByAgent,
  finalizeAgentResult,
  jobObjectId,
  loadLeasedJob,
  loadResultDeliveringJob,
  recordProviderMetrics,
  releaseAgentLease,
  renewAgentLease,
  takeResultSlot,
} from '../models/GenerationJob.js';
import { agentStaleMs, touchAgentHeartbeat } from '../models/GpuAgent.js';
import { PROVIDER_LOCAL_GPU_AGENT } from './3dGpuAgentProvider.js';
import {
  adapterIdsForEngineIds,
  artifactKindsForEngine,
  engineIdForJob,
  engineIdsForAdapters,
  localEngineAdapter,
  validateEngineInputs,
} from './localEngineAdapters.js';
import * as assets from './3dAssetService.js';
import { MAX_GLB_BYTES } from './3dModelValidation.js';
import { isSourceSheet } from './referenceImageService.js';

/** Cap on the reference bytes handed to one agent job (matches the worker's own body cap). */
export const AGENT_INPUT_MAX_BYTES = 48 * 1024 * 1024;

/** Longest long-poll a claim may ask for. */
export const AGENT_MAX_WAIT_SECONDS = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How often a healthy agent should heartbeat: a third of the staleness window. */
export function recommendedHeartbeatMs() {
  return Math.max(5_000, Math.floor(agentStaleMs() / 3));
}

/**
 * The trusted context for work on a job: derived from the JOB's workspace, with
 * no user (attribution flows from the job's own `createdBy`, never from the
 * machine). See the module docstring — this is the only place an agent-driven
 * pipeline call may get its scope from.
 */
export async function trustedContextForJob(job) {
  let workspaceSlug = 'platform';
  if (job?.workspaceId) {
    const Workspace = mongoose.model('Workspace');
    const ws = await Workspace.findById(job.workspaceId)
      .select('slug')
      .lean()
      .catch(() => null);
    if (ws?.slug) workspaceSlug = String(ws.slug);
  }
  return {
    user: null,
    workspaceId: job?.workspaceId || null,
    workspaceSlug,
  };
}

/* ── heartbeat ──────────────────────────────────────────────────────────── */

/**
 * Stamp the register, and — when the heartbeat names a current job with its
 * lease token — renew that lease in the same round trip. The response tells the
 * agent whether to KEEP WORKING or ABORT (cancelled / lease lost), which is how
 * a cancellation reaches a machine that is minutes into an inference.
 */
export async function heartbeat(report = {}) {
  const snapshot = await touchAgentHeartbeat(report);

  let job = null;
  const currentJobId = String(report.currentJobId || '');
  if (currentJobId && jobObjectId(currentJobId) && report.leaseToken) {
    const renew = await renewAgentLease(currentJobId, report.leaseToken);
    const action = renew.ok
      ? 'continue'
      : renew.reason === 'CANCELLED' || renew.reason === 'NOT_ACTIVE'
        ? 'abort'
        : 'lost';
    job = {
      id: currentJobId,
      status: renew.status || '',
      leaseValid: Boolean(renew.ok),
      action,
    };
  }

  const queued = await mongoose
    .model('GenerationJob')
    .countDocuments({ status: 'QUEUED', provider: PROVIDER_LOCAL_GPU_AGENT })
    .catch(() => null);

  return {
    ok: true,
    serverTime: new Date().toISOString(),
    agent: { workerId: snapshot.workerId, lastSeenAt: snapshot.lastSeenAt },
    settings: {
      leaseMs: agentLeaseMs(),
      staleAfterMs: agentStaleMs(),
      heartbeatIntervalMs: recommendedHeartbeatMs(),
      maxResultBytes: MAX_GLB_BYTES,
      maxInputBytes: AGENT_INPUT_MAX_BYTES,
      maxWaitSeconds: AGENT_MAX_WAIT_SECONDS,
    },
    queue: { queued },
    /** What the machine's own probe said about each engine it can run. */
    engines: snapshot.engines || [],
    job,
  };
}

/* ── claim ──────────────────────────────────────────────────────────────── */

function enginePayload(engineId) {
  const adapter = localEngineAdapter(engineIdForJob({ engineId }));
  return {
    engineId: adapter.engineId,
    adapter: adapter.adapterId,
    label: adapter.label,
    inputMode: adapter.inputMode,
    requiresPose: adapter.requiresPose,
    requiresRgba: adapter.requiresRgba,
    producesArtifacts: [...adapter.producesArtifacts],
    defaults: { ...adapter.defaults },
    checkpointEnv: adapter.checkpointEnv,
    entrypoint: adapter.entrypoint,
  };
}

function claimPayload(job) {
  return {
    id: String(job._id),
    productSlug: job.productSlug || '',
    status: job.status,
    provider: job.provider || '',
    /** WHICH ENGINE this job is for — the agent dispatches on this, never on a guess. */
    engine: enginePayload(job.engineId),
    quality: job.settings?.quality || 'standard',
    source: {
      referenceIds: (job.source?.referenceIds || []).map((id) => String(id)),
      viewCount: job.source?.viewCount || 0,
    },
    retryCount: job.retryCount || 0,
    lease: {
      token: job.lease?.token || '',
      expiresAt: job.claimExpiresAt ? new Date(job.claimExpiresAt).toISOString() : null,
      renewEveryMs: recommendedHeartbeatMs(),
    },
    // The agent's own task id is chosen by the agent; recorded at result time.
    resultPath: `/api/3d/agent/jobs/${job._id}/result`,
  };
}

/**
 * Claim the next queued agent job, or wait (bounded long-poll) for one to
 * appear. Returns `{ job: null }` when there is genuinely nothing to do — an
 * honest empty answer the agent turns into its idle loop.
 */
export async function claimJobForAgent({ workerId = '', waitSeconds = 0, engines = [] } = {}) {
  const wait = Math.min(Math.max(Number(waitSeconds) || 0, 0), AGENT_MAX_WAIT_SECONDS);
  const deadline = Date.now() + wait * 1000;
  // The machine declares the engines it can run. A claim with no declaration is
  // a legacy TripoSR agent, and it is matched to legacy/TripoSR jobs only — the
  // server never hands a machine work it did not say it could do.
  const engineIds = engineIdsForAdapters(engines);
  for (;;) {
    const job = await claimNextJobForAgent({ provider: PROVIDER_LOCAL_GPU_AGENT, workerId, engineIds });
    if (job) return { job: claimPayload(job), claimedEngines: adapterIdsForEngineIds(engineIds) };
    if (Date.now() >= deadline) return { job: null };
    await sleep(1_000);
  }
}

/* ── input ──────────────────────────────────────────────────────────────── */

/**
 * The ACCEPTED reference images bound to the claimed job — re-read from the
 * job's own `source.referenceIds`, scoped to the job's workspace, filtered to
 * `accepted: true` again (a reference de-accepted since job creation must not
 * be sent), and returned primary-first in the job's own ordering.
 *
 * This is the ONLY way an agent ever sees reference bytes; there is no browse,
 * no listing, and no id that works outside the claimed job.
 */
export async function jobInput(jobId, leaseToken) {
  const job = await loadLeasedJob(jobId, leaseToken, { provider: PROVIDER_LOCAL_GPU_AGENT });
  const ids = (job.source?.referenceIds || []).map((id) => String(id)).filter(Boolean);
  if (!ids.length) {
    throw new ApiError(422, 'This job has no reference images.', 'JOB_NO_REFERENCES');
  }

  const ProductReferenceImage = mongoose.model('ProductReferenceImage');
  const filter = { _id: { $in: ids }, accepted: true };
  if (job.workspaceId) filter.workspaceId = job.workspaceId;
  const refs = await ProductReferenceImage.find(filter)
    .select('_id original.storageKey original.fileName original.sha256 isPrimary order label viewAngle source composite pose')
    .lean();

  // Belt and braces: a composite SOURCE SHEET must never be handed to the
  // agent. `accepted: true` already excludes an un-accepted sheet, but if one
  // were ever accepted the grid itself would be reconstructed as if it were a
  // single viewpoint — so the sheet is dropped here as well.
  const viewRefs = refs.filter((row) => !isSourceSheet(row));

  const byId = new Map(viewRefs.map((r) => [String(r._id), r]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

  // WHICH ENGINE CONSUMES THESE BYTES, AND WHAT IT REQUIRES.
  //
  // This used to be one policy (TripoSR: up to four candidates, one consumed).
  // It is now a per-ADAPTER contract, because the engines disagree: Hunyuan
  // conditions on named slots and ReLi3D refuses a frame without a recorded
  // pose. The adapter is resolved from the JOB's own persisted engine id —
  // never from anything the machine sent — so a claim cannot be re-pointed at
  // an engine the job was not created for.
  const adapter = localEngineAdapter(engineIdForJob(job));
  const { readAsset } = await import('./referenceAssetStorage.js');
  const supplied = [];
  let total = 0;
  for (const ref of ordered.slice(0, adapter.maxInputs)) {
    const key = ref.original?.storageKey;
    if (!key) continue;
    const buffer = await readAsset(key).catch(() => null);
    if (!buffer?.length) continue;
    total += buffer.length;
    if (total > AGENT_INPUT_MAX_BYTES) {
      throw new ApiError(413, 'The reference images for this job exceed the transfer limit.', 'AGENT_INPUT_TOO_LARGE');
    }
    supplied.push({
      id: String(ref._id),
      kind: 'original',
      bytes: buffer.length,
      label: ref.label || '',
      viewAngle: ref.viewAngle || '',
      // Facts the CONTRACT needs: whether this row is a sheet, and whether a pose
      // was recorded. Neither is derived from the pixels.
      sheet: isSourceSheet(ref),
      source: ref.source || null,
      pose: ref.pose || null,
      original: { fileName: ref.original?.fileName || '', sha256: ref.original?.sha256 || '' },
      // Base64 so the agent can hand the payload to its engine unchanged (the
      // worker's own protocol is base64 images), and so one GET is one request.
      data: buffer.toString('base64'),
    });
  }
  if (!supplied.length) {
    throw new ApiError(409, 'None of this job\'s accepted reference images could be read.', 'NO_REFERENCE_BYTES');
  }

  // PER-ENGINE VALIDATION, ON THE SERVER, BEFORE A MACHINE SEES THE BYTES.
  // Hunyuan: named slots, no sheet, no duplicate slot. ReLi3D: RGBA PNG + a
  // recorded pose and FOV on EVERY frame, plus a transforms.json built from
  // those poses. TripoSR: one-to-four candidates, one consumed. The agent
  // re-validates independently; neither side trusts the other's assertion.
  const validation = validateEngineInputs({ engineId: adapter.engineId, images: supplied, job });
  if (!validation.ok) {
    throw new ApiError(
      422,
      `This job cannot be sent to ${adapter.label}: ${validation.errors.map((entry) => entry.message).join(' ')}`,
      validation.errors[0]?.code || 'ENGINE_INPUT_INVALID',
      { issues: validation.errors }
    );
  }

  const images = validation.inputs.map((image) => ({
    id: image.id,
    kind: 'original',
    bytes: image.bytes,
    label: image.label,
    viewAngle: image.viewAngle,
    // Named slot for an engine that conditions on names (Hunyuan); empty for the
    // others. Never invented: it is the row's own recorded label.
    slot: image.slot || image.viewAngle || '',
    pose: image.pose || null,
    sha256: image.frame?.sha256 || image.original?.sha256 || '',
    data: image.data,
  }));

  const supportsMultiView = adapter.inputMode !== 'single_view';
  const reason =
    adapter.inputMode === 'single_view'
      ? `${adapter.model} reconstructs from ONE image. ${images.length} of ` +
        `${ordered.length} accepted views are sent as CANDIDATE inputs so the agent can pick ` +
        'the best one after foreground hardening; the rest stay stored for a multi-view engine. ' +
        'This is single-view selection, not joint use.'
      : adapter.inputMode === 'named_multi_view'
        ? `${adapter.model} conditions on NAMED views. ${images.length} of ${ordered.length} accepted ` +
          `views are sent as ${images.map((image) => image.slot).join(', ')}; each named slot is filled ` +
          'at most once, and a composite sheet is never sent as a view.'
        : `${adapter.model} reconstructs from ${images.length} posed RGBA frame(s). Every frame carries ` +
          'a RECORDED camera-to-world pose and FOV; transforms.json is generated server-side from ' +
          'those recorded values, and no pose is inferred.';

  return {
    job: {
      id: String(job._id),
      status: job.status,
      quality: job.settings?.quality || 'standard',
      leaseExpiresAt: job.claimExpiresAt ? new Date(job.claimExpiresAt).toISOString() : null,
      engine: enginePayload(job.engineId),
    },
    /** Stated per job so a reader of the protocol can never assume joint use. */
    viewPolicy: {
      engineId: adapter.engineId,
      adapter: adapter.adapterId,
      model: adapter.model,
      inputMode: adapter.inputMode,
      supportsMultiView,
      acceptedViews: ordered.length,
      viewsSent: images.length,
      reason,
    },
    images,
    /** Files the adapter must deliver AFTER the GLB, each as its own artifact. */
    requiredArtifacts: artifactKindsForEngine(adapter.engineId),
    // Present only for a pose-aware engine. Generated from recorded poses.
    ...(validation.transformsJson ? { transformsJson: validation.transformsJson } : {}),
  };
}

/* ── lease / release / failure ──────────────────────────────────────────── */

/** Explicit lease renewal (heartbeats also renew; this is the direct form). */
export async function renewLease(jobId, leaseToken) {
  const renew = await renewAgentLease(jobId, leaseToken);
  if (!renew.ok) {
    if (renew.reason === 'CANCELLED') {
      throw new ApiError(409, 'This job was cancelled; stop inference.', 'JOB_CANCELLED');
    }
    if (renew.reason === 'NOT_FOUND') {
      throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
    }
    throw new ApiError(409, 'The lease for this job was lost.', 'LEASE_LOST');
  }
  return {
    ok: true,
    job: { id: String(jobId), status: renew.status },
    leaseExpiresAt: new Date(Date.now() + agentLeaseMs()).toISOString(),
  };
}

/**
 * Graceful give-back: the agent shuts down (or its model failed to load) before
 * producing anything, so the job returns to the QUEUE for the next agent to
 * take — no failure recorded, no retry counted.
 */
export async function releaseJob(jobId, leaseToken) {
  const released = await releaseAgentLease(jobId, leaseToken);
  if (!released.ok) {
    if (released.reason === 'NOT_FOUND') throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
    if (released.reason === 'CANCELLED') throw new ApiError(409, 'This job was cancelled.', 'JOB_CANCELLED');
    if (released.reason === 'DUPLICATE') {
      throw new ApiError(409, 'This job already produced a result and cannot be released.', 'JOB_NOT_ACTIVE');
    }
    throw new ApiError(409, 'The lease for this job was lost.', 'LEASE_LOST');
  }
  return { ok: true, job: { id: String(jobId), status: 'QUEUED' } };
}

/** A bounded, sanitized failure from the machine: recorded on the job, terminal. */
export async function reportFailure(jobId, leaseToken, { code = '', message = '' } = {}) {
  const failed = await failJobByAgent(jobId, leaseToken, {
    code: String(code || 'AGENT_REPORTED_FAILURE').slice(0, 100),
    message: String(message || 'The GPU agent reported a failure.').slice(0, 500),
  });
  if (!failed) {
    // Distinguish "no such job" from "not yours" without leaking which.
    await loadLeasedJob(jobId, leaseToken, { provider: PROVIDER_LOCAL_GPU_AGENT });
    throw new ApiError(409, 'This job is no longer active; the failure was not recorded.', 'JOB_NOT_ACTIVE');
  }
  return { ok: true, job: { id: String(failed._id), status: failed.status, error: failed.error } };
}

/* ── result ─────────────────────────────────────────────────────────────── */

/**
 * Accept the finished GLB.
 *
 * The bytes go through the EXACT pipeline a hosted provider's download would:
 * container validation from the bytes, private storage, candidate creation,
 * Phase 5 quality measurement — then an atomic lease-guarded promotion to
 * READY_FOR_REVIEW for a human to approve. Inference success alone never makes
 * a model deliverable.
 */
export async function submitResult({ jobId, leaseToken, glbBuffer, agentTaskId = '', metrics = null }) {
  const slot = await takeResultSlot(jobId, leaseToken);
  if (!slot.ok) {
    if (slot.reason === 'DUPLICATE') {
      const job = slot.job || {};
      return {
        ok: true,
        duplicate: true,
        assetId: job.providerExtra?.assetId || '',
        job: { id: String(jobId), status: job.status || '' },
        engine: enginePayload(job.engineId),
        requiredArtifacts: artifactKindsForEngine(engineIdForJob(job)),
      };
    }
    if (slot.reason === 'NOT_FOUND') throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
    if (slot.reason === 'CANCELLED') {
      throw new ApiError(409, 'This job was cancelled; the result was not accepted.', 'JOB_CANCELLED');
    }
    throw new ApiError(409, 'The lease for this job was lost; the result was not accepted.', 'LEASE_LOST');
  }

  const job = slot.job;
  const ctx = await trustedContextForJob(job);
  const providerTaskId = String(agentTaskId || job.lease?.workerId || '').slice(0, 200);

  // The quality gate reads the worker's diagnostics (which photograph produced
  // this mesh, and the foreground mask made from it) from the JOB ROW while the
  // candidate is being assessed, so they must be recorded BEFORE the asset is
  // created. A missing or malformed metrics payload is not an error here: the
  // gate then reports the silhouette as unavailable, exactly as before.
  await recordProviderMetrics(jobId, metrics).catch(() => {});

  let asset = null;
  try {
    asset = await assets.createCandidateFromGeneration(ctx, {
      job: { ...job, _id: jobObjectId(jobId) || job._id },
      glbBuffer,
      providerTaskId,
    });
  } catch (err) {
    // A rejected upload is terminal for THIS attempt: the job gets the reason a
    // human can read, and the agent is told the bytes were refused (it must not
    // silently retry the same model).
    await failJobByAgent(jobId, leaseToken, {
      code: err?.code || 'AGENT_RESULT_INVALID',
      message: err?.message || String(err),
    }).catch(() => {});
    throw new ApiError(
      422,
      `The uploaded model was rejected: ${err?.message || String(err)}`,
      err?.code || 'AGENT_RESULT_INVALID'
    );
  }

  const finalized = await finalizeAgentResult(jobId, leaseToken, {
    providerTaskId,
    assetId: String(asset._id),
    bytes: asset.storage?.glb?.bytes || glbBuffer.length,
    metrics,
  });

  if (!finalized) {
    // The job was cancelled (or its lease taken over) WHILE the bytes were being
    // validated. A stopped job must not resurrect: the candidate is discarded,
    // files and all.
    await assets.discardCandidate(ctx, asset).catch(() => {});
    throw new ApiError(
      409,
      'The job stopped while the result was being validated; the candidate was discarded.',
      'JOB_NOT_ACTIVE'
    );
  }

  const engine = enginePayload(job.engineId);
  return {
    ok: true,
    duplicate: false,
    assetId: String(asset._id),
    job: { id: String(jobId), status: 'READY_FOR_REVIEW' },
    engine,
    validation: {
      meshes: asset.validation?.meshes || 0,
      materials: asset.validation?.materials || 0,
      textures: asset.validation?.textures || 0,
    },
    qualityDecision: asset.quality?.decision || '',
    /* Artifacts are SEPARATE files (ReLi3D's illumination.hdr and run_info.json)
       uploaded after the GLB. Naming them here is the agent's checklist; missing
       ones stay visible on the asset rather than being invented. */
    requiredArtifacts: engine.producesArtifacts,
    artifactsReceived: (asset.artifacts || []).map((entry) => entry.kind),
  };
}

/** Per-artifact ceiling. An HDR is not a GLB and is bounded on its own terms. */
export const MAX_ARTIFACT_BYTES = {
  illumination: 16 * 1024 * 1024,
  'run-info': 512 * 1024,
};

/**
 * Store ONE companion artifact a pose-aware engine returned beside its mesh.
 *
 * Deliberately a SEPARATE request after the result: the GLB's own upload already
 * owns the job's result slot, and folding binary companions into it would make
 * the validated-bytes path ambiguous. This call is lease-guarded by the token
 * that DELIVERED the result (`lease.resultToken`) and accepts only the kinds the
 * job's adapter declares — a TripoSR job cannot acquire a relighting HDR it never
 * produced, and a ReLi3D job cannot smuggle an arbitrary file under a new name.
 */
export async function submitArtifact({ jobId, leaseToken, kind, buffer }) {
  const job = await loadResultDeliveringJob(jobId, leaseToken, { provider: PROVIDER_LOCAL_GPU_AGENT });
  const adapter = localEngineAdapter(engineIdForJob(job));
  const accepted = artifactKindsForEngine(adapter.engineId);
  const normalised = String(kind || '').trim().toLowerCase();

  if (!accepted.includes(normalised)) {
    throw new ApiError(
      422,
      `${adapter.label} does not produce a "${normalised || 'unnamed'}" artifact. Accepted for this job: ${accepted.join(', ') || 'none'}.`,
      'ARTIFACT_NOT_ACCEPTED'
    );
  }
  if (!buffer?.length) {
    throw new ApiError(422, 'The artifact body was empty.', 'ARTIFACT_EMPTY');
  }
  const ceiling = MAX_ARTIFACT_BYTES[normalised] || 8 * 1024 * 1024;
  if (buffer.length > ceiling) {
    throw new ApiError(
      413,
      `The ${normalised} artifact is ${(buffer.length / 1024 / 1024).toFixed(1)} MB, above its ${(ceiling / 1024 / 1024).toFixed(1)} MB limit.`,
      'ARTIFACT_TOO_LARGE'
    );
  }

  if (normalised === 'run-info') {
    try {
      const parsed = JSON.parse(buffer.toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    } catch (err) {
      throw new ApiError(422, `run_info.json is not valid JSON (${err?.message || String(err)}).`, 'ARTIFACT_INVALID_JSON');
    }
  }
  if (normalised === 'illumination') {
    // A Radiance HDR starts with a signature line; refusing arbitrary bytes here
    // keeps "there is an illumination file" from meaning "there are bytes".
    const head = buffer.subarray(0, 16).toString('ascii');
    if (!/^#\?(RADIANCE|RGBE)/.test(head)) {
      throw new ApiError(
        422,
        'illumination.hdr is not a Radiance HDR file (missing the #?RADIANCE signature).',
        'ARTIFACT_INVALID_HDR'
      );
    }
  }

  const assetId = job.providerExtra?.assetId;
  if (!assetId) {
    throw new ApiError(409, 'This job has no candidate to attach artifacts to.', 'JOB_NO_CANDIDATE');
  }
  const ctx = await trustedContextForJob(job);
  const stored = await assets.attachEngineArtifact(ctx, {
    assetId,
    kind: normalised,
    buffer,
    contentType: normalised === 'illumination' ? 'image/vnd.radiance' : 'application/json',
  });

  return {
    ok: true,
    job: { id: String(jobId), status: job.status },
    artifact: stored,
    artifactsReceived: stored.received,
  };
}

export default {
  heartbeat,
  claimJobForAgent,
  jobInput,
  renewLease,
  releaseJob,
  reportFailure,
  submitResult,
  submitArtifact,
  trustedContextForJob,
  recommendedHeartbeatMs,
  AGENT_INPUT_MAX_BYTES,
};
