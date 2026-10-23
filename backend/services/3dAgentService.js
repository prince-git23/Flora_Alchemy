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
  releaseAgentLease,
  renewAgentLease,
  takeResultSlot,
} from '../models/GenerationJob.js';
import { agentStaleMs, touchAgentHeartbeat } from '../models/GpuAgent.js';
import { PROVIDER_LOCAL_GPU_AGENT, describeGpuAgent } from './3dGpuAgentProvider.js';
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
    job,
  };
}

/* ── claim ──────────────────────────────────────────────────────────────── */

function claimPayload(job) {
  return {
    id: String(job._id),
    productSlug: job.productSlug || '',
    status: job.status,
    provider: job.provider || '',
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
export async function claimJobForAgent({ workerId = '', waitSeconds = 0 } = {}) {
  const wait = Math.min(Math.max(Number(waitSeconds) || 0, 0), AGENT_MAX_WAIT_SECONDS);
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const job = await claimNextJobForAgent({ provider: PROVIDER_LOCAL_GPU_AGENT, workerId });
    if (job) return { job: claimPayload(job) };
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
    .select('_id original.storageKey isPrimary order label viewAngle source composite')
    .lean();

  // Belt and braces: a composite SOURCE SHEET must never be handed to the
  // agent. `accepted: true` already excludes an un-accepted sheet, but if one
  // were ever accepted the grid itself would be reconstructed as if it were a
  // single viewpoint — so the sheet is dropped here as well.
  const viewRefs = refs.filter((row) => !isSourceSheet(row));

  const byId = new Map(viewRefs.map((r) => [String(r._id), r]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

  // WHAT THE ENGINE ACTUALLY CONSUMES.
  //
  // The agent runs TripoSR, which is SINGLE-IMAGE (`supportsMultiView: false` in
  // 3dGpuAgentProvider). Handing it twelve views would be theatre: the worker
  // would take the first and silently drop the rest. So the server sends exactly
  // the views the model uses and states the policy in the payload, and the
  // unused views stay stored for the (licence-gated) multi-view engine. When a
  // provider with genuine multi-view conditioning is registered, this branch
  // sends the whole set with no other change.
  const described = describeGpuAgent();
  const usedIds = described.supportsMultiView
    ? ids
    : ids.slice(0, Math.max(1, described.maxInputs || 1));

  const { readAsset } = await import('./referenceAssetStorage.js');
  const images = [];
  let total = 0;
  for (const ref of ordered) {
    if (!usedIds.includes(String(ref._id))) continue;
    const key = ref.original?.storageKey;
    if (!key) continue;
    const buffer = await readAsset(key).catch(() => null);
    if (!buffer?.length) continue;
    total += buffer.length;
    if (total > AGENT_INPUT_MAX_BYTES) {
      throw new ApiError(413, 'The reference images for this job exceed the transfer limit.', 'AGENT_INPUT_TOO_LARGE');
    }
    images.push({
      id: String(ref._id),
      kind: 'original',
      bytes: buffer.length,
      label: ref.label || '',
      viewAngle: ref.viewAngle || '',
      // Base64 so the agent can hand the payload to its engine unchanged (the
      // worker's own protocol is base64 images), and so one GET is one request.
      data: buffer.toString('base64'),
    });
  }
  if (!images.length) {
    throw new ApiError(409, 'None of this job\'s accepted reference images could be read.', 'NO_REFERENCE_BYTES');
  }

  return {
    job: {
      id: String(job._id),
      status: job.status,
      quality: job.settings?.quality || 'standard',
      leaseExpiresAt: job.claimExpiresAt ? new Date(job.claimExpiresAt).toISOString() : null,
    },
    /** Stated per job so a reader of the protocol can never assume joint use. */
    viewPolicy: {
      model: described.model,
      supportsMultiView: described.supportsMultiView,
      acceptedViews: ordered.length,
      viewsSent: images.length,
      reason: described.supportsMultiView
        ? 'The configured engine conditions on multiple views jointly; every accepted view is sent.'
        : `${described.model} is single-image. Only the primary view is sent; the remaining views stay stored for a multi-view engine.`,
    },
    images,
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
export async function submitResult({ jobId, leaseToken, glbBuffer, agentTaskId = '' }) {
  const slot = await takeResultSlot(jobId, leaseToken);
  if (!slot.ok) {
    if (slot.reason === 'DUPLICATE') {
      const job = slot.job || {};
      return {
        ok: true,
        duplicate: true,
        assetId: job.providerExtra?.assetId || '',
        job: { id: String(jobId), status: job.status || '' },
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

  return {
    ok: true,
    duplicate: false,
    assetId: String(asset._id),
    job: { id: String(jobId), status: 'READY_FOR_REVIEW' },
    validation: {
      meshes: asset.validation?.meshes || 0,
      materials: asset.validation?.materials || 0,
      textures: asset.validation?.textures || 0,
    },
    qualityDecision: asset.quality?.decision || '',
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
  trustedContextForJob,
  recommendedHeartbeatMs,
  AGENT_INPUT_MAX_BYTES,
};
