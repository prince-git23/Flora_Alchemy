/**
 * 3D GENERATION SERVICE — 3D Studio (Phase 2) — job orchestration.
 *
 * This is where a request becomes a job, a job becomes a provider call, and a
 * provider result becomes a REVIEWABLE candidate asset. It is the only module
 * that talks to both the job model and the provider.
 *
 * TWO DECISIONS WORTH KNOWING
 *
 *   1. GENERATION IS DISABLED UNTIL A PROVIDER IS CONFIGURED. `startGeneration`
 *      refuses before it writes a job row when no provider is available, so a
 *      misconfigured server cannot accumulate dead QUEUED jobs. The refusal
 *      carries the provider's own explanation, which is what the studio shows.
 *
 *   2. THE PROVIDER RUN IS NOT AWAITED BY THE HTTP REQUEST. A 3D generation
 *      takes minutes; holding the request open would time out at every proxy.
 *      The job is created, claimed, and handed to a background run whose failures
 *      are recorded ON THE JOB. That is what makes a provider outage visible in
 *      the studio instead of leaving a job stuck in GENERATING.
 *
 * The background run is in-process, which is an honest limitation: a process
 * restart during generation leaves the job to be retried (the claim expires, and
 * a job in a non-final state is retryable), rather than silently completing. A
 * durable queue is the right answer for production and is called out in the
 * Phase 2 documentation rather than pretended away.
 */

import mongoose from 'mongoose';
import { ApiError } from '../middleware/errorMiddleware.js';
import {
  attachProvider,
  claimJob,
  createGenerationJob,
  failJob,
  getJob,
  listJobsForProduct,
  cancelJob,
  retryJob,
  settleJob,
  updateJobStatus,
  jobObjectId,
} from '../models/GenerationJob.js';
import * as assets from './3dAssetService.js';
import { plansForProduct, providerFor, resolveProvider, describeProvider, isProviderConfigured } from './3dModelProvider.js';
import { PROVIDER_LOCAL_GPU_AGENT } from './3dGpuAgentProvider.js';
import { writeAsset } from './3dAssetStorage.js';
import { workspaceScope } from '../utils/tenancy.js';

/** Cap on provider polling so a stuck task cannot spin forever. */
const MAX_POLLS = 240;
const POLL_INTERVAL_MS = 5_000;

/** How many references must be accepted before a generation may start. */
export const MIN_REFERENCES = 1;

/** The provider/plan status the studio renders when generation is off. */
export function providerStatus() {
  const name = resolveProvider();
  const described = describeProvider(name);
  return {
    name,
    label: described.label,
    available: described.available,
    configured: isProviderConfigured(name),
    reason: described.reason,
    model: described.model,
    modelVersion: described.modelVersion,
    maxInputs: described.maxInputs,
    supportsMultiView: described.supportsMultiView,
    metered: described.metered,
    local: described.local,
  };
}

export async function providerHealth() {
  const name = resolveProvider();
  const status = providerStatus();
  const health = await providerFor(name)
    .health()
    .catch((err) => ({ ok: false, detail: err?.message || 'The provider health check failed.' }));
  return { ...status, health };
}

/**
 * Load the accepted, cutout-ready references for a product and turn them into a
 * provider plan. Refuses when the product or the references are not usable, so
 * the studio can explain exactly what is missing.
 */
export async function planForProduct(req, productSlug, referenceIds = []) {
  const ProductReferenceImage = mongoose.model('ProductReferenceImage');
  const ids = (Array.isArray(referenceIds) ? referenceIds : []).map((id) => jobObjectId(id)).filter(Boolean);

  // Scoped to the caller's workspace: a slug alone must never expose another
  // workspace's working material, and reference media IS working material.
  const query = { ...workspaceScope(req.user), productSlug: String(productSlug || ''), accepted: true };
  if (ids.length) query._id = { $in: ids };

  const refs = await ProductReferenceImage.find(query)
    .sort({ isPrimary: -1, order: 1 })
    .select('_id isPrimary order original cutout productSlug accepted status')
    .lean();

  // PROJECT BEFORE PLANNING. `plansForProduct` echoes back the objects it is
  // given as `selected`, and the raw rows carry `original.storageKey` /
  // `cutout.storageKey` — private paths in the 3D studio's own media root. A raw
  // pass-through therefore shipped storage keys to the browser through the
  // studio endpoint. Only the facts a screen needs (identity, primacy, which
  // derivations exist) go into the plan; the bytes are read server-side by
  // `loadReferenceBuffers`, which re-reads by id rather than trusting this list.
  const safeRefs = refs.map((r) => ({
    id: String(r._id),
    isPrimary: Boolean(r.isPrimary),
    hasOriginal: Boolean(r.original?.storageKey),
    hasCutout: Boolean(r.cutout?.storageKey),
    status: r.status,
  }));

  const plan = plansForProduct(safeRefs);
  return { ...plan, references: safeRefs };
}

/**
 * Create a job and start it. Returns the job as stored, plus the provider status
 * the caller used, so the UI can render the decision it just made.
 */
export async function startGeneration(req, { productSlug, referenceIds = [], quality = 'standard', notes = '', label = '' } = {}) {
  const status = providerStatus();
  if (!status.available) {
    throw new ApiError(422, status.reason, 'PROVIDER_UNAVAILABLE');
  }

  const job = await createGenerationJob(req, { productSlug, referenceIds, label, quality, notes });

  // Record WHICH engine was asked for BEFORE any work starts. The asset copies
  // the provider identity off the job, so attaching it here (rather than when a
  // result arrives) is what makes a FAILED run still say "Meshy 7.1 was asked"
  // instead of leaving an anonymous failure behind. Best-effort: a bookkeeping
  // failure must not block the generation.
  await attachProvider(req, job.id, await planForProduct(req, productSlug, referenceIds)).catch(() => {});

  // REMOTE GPU AGENT — the job is QUEUED, not started. The agent on the owner's
  // PC claims it over the authenticated agent API when it is online; while it is
  // offline the job simply waits (an honest waiting state, not a failure), which
  // is why the in-process claim/run below is skipped entirely for this provider.
  if (status.name === PROVIDER_LOCAL_GPU_AGENT) {
    return { job: await getJob(req, job.id), provider: status, queued: true };
  }

  // Claim it immediately so the response can honestly say whether a worker took
  // it; a second worker cannot claim a job that already has a live claim.
  const claimed = await claimJob(req, job.id);
  if (!claimed) {
    await failJob(req, job.id, {
      code: 'CLAIM_FAILED',
      message: 'The job could not be claimed by a worker.',
    });
    throw new ApiError(503, 'The generation job could not be claimed. Try again.', 'JOB_CLAIM_FAILED');
  }

  // Fire-and-forget. Any throw is recorded on the job by runJob itself.
  void runJob(req, claimed).catch((err) => {
    console.error('[3d-generation] unexpected worker error:', err?.message || String(err));
  });

  return { job: await getJob(req, job.id), provider: status, queued: false };
}

/** Load the accepted reference bytes for the views a plan selected. */
async function loadReferenceBuffers(req, referenceIds = []) {
  const ProductReferenceImage = mongoose.model('ProductReferenceImage');
  const ids = referenceIds.map((id) => jobObjectId(id)).filter(Boolean);
  if (!ids.length) return [];
  const refs = await ProductReferenceImage.find({ ...workspaceScope(req.user), _id: { $in: ids } }).sort({
    isPrimary: -1,
    order: 1,
  });
  const { readAsset } = await import('./referenceAssetStorage.js');
  const out = [];
  for (const ref of refs) {
    // A prepared cutout is what generation wants; fall back to the original only
    // when no cutout exists, because a busy background measurably degrades the mesh.
    const key = ref.cutout?.storageKey || ref.original?.storageKey;
    if (!key) continue;
    const buffer = await readAsset(key).catch(() => null);
    if (buffer?.length) out.push({ id: String(ref._id), buffer, kind: ref.cutout?.storageKey ? 'cutout' : 'original' });
  }
  return out;
}

/**
 * The worker body: submit to the provider, poll to completion, validate the
 * download, and store a CANDIDATE. Every failure path ends with the job in a
 * terminal FAILED state carrying a readable reason.
 */
export async function runJob(req, claimedJob) {
  const jobId = String(claimedJob._id || claimedJob.id);
  const providerName = resolveProvider();

  try {
    const provider = providerFor(providerName);

    const inputs = await loadReferenceBuffers(req, claimedJob.source?.referenceIds || []);
    if (!inputs.length) {
      throw Object.assign(new Error('None of the accepted reference images could be read from storage.'), {
        code: 'NO_REFERENCE_BYTES',
      });
    }

    await updateJobStatus(req, jobId, 'GENERATING', { providerTaskId: '' });

    const { providerTaskId } = await provider.submit(inputs);
    await updateJobStatus(req, jobId, 'GENERATING', { providerTaskId });

    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const state = await provider.status(providerTaskId);

      // A cancel that landed while we were polling must win over the poll.
      const fresh = await getJob(req, jobId).catch(() => null);
      if (!fresh || fresh.status === 'CANCELLED') {
        await provider.cancel(providerTaskId).catch(() => {});
        return;
      }

      if (state.error) {
        throw Object.assign(new Error(state.error.message || 'The provider task failed.'), {
          code: state.error.code || 'PROVIDER_TASK_FAILED',
        });
      }
      if (state.providerTaskStatus === 'FAILED' || state.providerTaskStatus === 'CANCELED') {
        throw Object.assign(new Error('The provider reported the task as failed or cancelled.'), {
          code: 'PROVIDER_TASK_FAILED',
        });
      }
      if (state.status === 'ready') {
        await updateJobStatus(req, jobId, 'POST_PROCESSING', { providerTaskId });
        const { buffer } = await provider.download(providerTaskId);
        await updateJobStatus(req, jobId, 'POST_PROCESSING', { providerTaskId });

        const fullJob = await getJob(req, jobId);
        const asset = await assets.createCandidateFromGeneration(req, {
          job: { ...fullJob, _id: jobObjectId(jobId) || fullJob.id },
          glbBuffer: buffer,
          providerTaskId,
        });

        await updateJobStatus(req, jobId, 'READY_FOR_REVIEW', {
          providerTaskId,
          providerExtra: { assetId: String(asset._id), bytes: asset.storage?.glb?.bytes || 0 },
        });
        return;
      }

      await updateJobStatus(req, jobId, 'GENERATING', {
        providerTaskId,
        providerExtra: { progress: state.progress ?? null, providerTaskStatus: state.providerTaskStatus || '' },
      });
    }

    throw Object.assign(new Error('The provider did not finish within the polling window.'), {
      code: 'PROVIDER_TIMEOUT',
    });
  } catch (err) {
    await failJob(req, jobId, {
      code: err?.code || 'PROVIDER_ERROR',
      message: err?.message || String(err),
    }).catch((failErr) => {
      console.error('[3d-generation] could not record job failure:', failErr?.message);
    });
    if (process.env.THREE_STUDIO_DEBUG === '1') {
      console.error(`[3d-generation] job ${jobId} failed:`, err?.message || String(err));
    }
  }
}

/** Cancel a job, stopping its provider task when one is running. */
export async function cancelGeneration(req, jobId) {
  const job = await getJob(req, jobId);
  if (job.providerTaskId) {
    await providerFor(resolveProvider())
      .cancel(job.providerTaskId)
      .catch(() => {});
  }
  return cancelJob(req, jobId);
}

/** Re-queue a failed or cancelled job and run it again. */
export async function retryGeneration(req, jobId, overrides = {}) {
  const status = providerStatus();
  if (!status.available) throw new ApiError(422, status.reason, 'PROVIDER_UNAVAILABLE');

  const previous = await getJob(req, jobId);
  const requeued = await retryJob(req, jobId);

  // REMOTE GPU AGENT — re-queue only: the agent picks it up on its next claim.
  if (status.name === PROVIDER_LOCAL_GPU_AGENT) {
    return { job: await getJob(req, requeued.id), previousJobId: previous.id, provider: status, queued: true };
  }

  const claimed = await claimJob(req, requeued.id);
  if (!claimed) {
    await failJob(req, requeued.id, {
      code: 'CLAIM_FAILED',
      message: 'The job could not be claimed by a worker.',
    });
    throw new ApiError(503, 'The generation job could not be claimed. Try again.', 'JOB_CLAIM_FAILED');
  }

  void runJob(req, claimed).catch((err) => {
    console.error('[3d-generation] unexpected worker error:', err?.message || String(err));
  });

  return { job: await getJob(req, requeued.id), previousJobId: previous.id, provider: status };
}

/**
 * The studio's whole state for one product: the provider decision, the accepted
 * reference plan, every job, and every asset. One request, one screen.
 */
export async function studioState(req, productSlug) {
  const [provider, plan, jobs, assetsList] = await Promise.all([
    Promise.resolve(providerStatus()),
    planForProduct(req, productSlug),
    listJobsForProduct(req, productSlug),
    assets.listAssetsForProduct(req, productSlug),
  ]);
  // REMOTE GPU AGENT — `available` (configured) and `agent.online` (a fresh
  // heartbeat) are different facts and the studio must render the second one:
  // a token on the server never means the PC is running. Read from the
  // database on every studio load; never cached, never faked.
  if (provider.name === PROVIDER_LOCAL_GPU_AGENT) {
    const { latestAgentSnapshot } = await import('../models/GpuAgent.js');
    provider.agent = await latestAgentSnapshot().catch(() => null);
  }
  const approved = assetsList.find((a) => a.status === 'APPROVED') || null;
  return {
    productSlug: String(productSlug || ''),
    provider,
    plan,
    jobs,
    assets: assetsList,
    approved,
    canGenerate: provider.available && plan.acceptedCount >= MIN_REFERENCES,
  };
}

/**
 * Approve the candidate a job produced, and settle the job as APPROVED.
 *
 * `options` carries the Phase 5 review note or override. It is forwarded
 * verbatim and never interpreted here: the quality gate inside `approveAsset`
 * is the only thing that decides whether the approval is allowed, so a caller
 * cannot reach an approval that skips it.
 */
export async function approveJobCandidate(req, jobId, assetId, options = {}) {
  const result = await assets.approveAsset(req, assetId, options);
  await settleJob(req, jobId, 'APPROVED').catch(() => {});
  return result;
}

/** Reject the candidate a job produced, leaving any live model in place. */
export async function rejectJobCandidate(req, jobId, assetId, reason = '') {
  const result = await assets.rejectAsset(req, assetId, reason);
  await settleJob(req, jobId, 'REJECTED').catch(() => {});
  return result;
}

export { getJob, listJobsForProduct, jobObjectId, writeAsset };
export default {
  providerStatus,
  providerHealth,
  planForProduct,
  startGeneration,
  runJob,
  cancelGeneration,
  retryGeneration,
  studioState,
  approveJobCandidate,
  rejectJobCandidate,
  MIN_REFERENCES,
};
