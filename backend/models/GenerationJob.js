/**
 * GenerationJob — 3D Studio (Phase 2) — one 3D model generation request.
 *
 * A job records WHAT was asked for (which accepted reference images, at which
 * quality), WHO asked, and HOW it went (provider identity, provider task id,
 * progress, failure reason). It never holds the generated mesh: that is a
 * Product3DAsset, created only once a provider genuinely returned bytes.
 *
 * LIFE CYCLE — forward-only, like the order lifecycle:
 *
 *   QUEUED → GENERATING → POST_PROCESSING → READY_FOR_REVIEW
 *                                          ↘ FAILED / CANCELLED
 *
 * READY_FOR_REVIEW is deliberately NOT "done": a generated mesh is a candidate
 * that a human must approve before it can reach a customer. That is what makes
 * "only a genuinely generated, validated asset may be previewed or approved"
 * enforceable rather than a promise.
 *
 * TENANCY — every read and write is scoped to the caller's workspace, and a
 * document belonging to another workspace is reported as a 404 (never a 403,
 * which would confirm the row exists).
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiError } from '../middleware/errorMiddleware.js';
import { getWorkspaceId, workspaceScope } from '../utils/tenancy.js';
import { timingSafeStringEqual } from '../utils/secretCompare.js';

export const JOB_STATUSES = [
  'QUEUED',
  'GENERATING',
  'POST_PROCESSING',
  'READY_FOR_REVIEW',
  'APPROVED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
];

/** The job is still doing work; a worker may hold it. */
export const JOB_STATUSES_ACTIVE = ['QUEUED', 'GENERATING', 'POST_PROCESSING'];
/** The job produced a candidate asset that only a human decision can resolve. */
export const JOB_STATUSES_READY_FOR_REVIEW = ['READY_FOR_REVIEW'];
/** The job is over and cannot move again without a new job. */
export const JOB_STATUSES_FINAL = ['APPROVED', 'REJECTED', 'FAILED', 'CANCELLED'];
/** A failed or cancelled job may be retried in place. */
export const JOB_STATUSES_CAN_RETRY = ['FAILED', 'CANCELLED'];

/** A worker claim is valid for this long before another worker may take it. */
export const CLAIM_WINDOW_MS = 60_000;

/* ── REMOTE GPU AGENT LEASE ───────────────────────────────────────────────
 *
 * An in-process run (Meshy, the loopback worker) holds a claim for the seconds
 * between "start" and "download", and the 60 s window above is enough for it.
 * A REMOTE agent works for MINUTES: inference runs on the owner's PC, so the
 * lease has to survive a long job while still recovering quickly when the PC
 * dies mid-generation. The pair is therefore configurable together:
 *
 *   THREE_AGENT_LEASE_MS           (default 120 000 = 2 min)  — how long a
 *       claim survives without a renewal. The agent renews it with every
 *       heartbeat (every 20 s), so five consecutive missed beats are needed
 *       before another agent may take the job over — that is the double-work
 *       guard, and it is a deliberate trade: a lease long enough to survive a
 *       GC pause, short enough to recover a crashed run within minutes.
 *   THREE_AGENT_HEARTBEAT_TIMEOUT_MS (default 60 000) — how stale a HEARTBEAT
 *       may be before the studio reports the machine offline (see GpuAgent).
 *
 * A lease is TWO things on purpose: `claimExpiresAt` (existing field, so every
 * historical claim query keeps working) and `lease.token` — a per-job random
 * secret the agent must present on input/heartbeat/result. The machine token
 * authenticates the MACHINE; the lease token binds a request to THE job that
 * machine claimed, so a second agent (or a replayed request) cannot feed bytes
 * into, or read references for, a job it does not hold.
 */
export const DEFAULT_AGENT_LEASE_MS = 120_000;

/** Configured lease window in ms (never negative, never NaN). */
export function agentLeaseMs() {
  const raw = Number(process.env.THREE_AGENT_LEASE_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : DEFAULT_AGENT_LEASE_MS;
}

/** Fields cleared whenever a job stops being held by anyone. */
const CLAIM_RELEASED = {
  claimedBy: null,
  claimedAt: null,
  claimExpiresAt: null,
  'lease.token': '',
  'lease.workerId': '',
  'lease.heartbeatAt': null,
};

const toObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const str = String(value);
  return mongoose.isValidObjectId(str) ? new mongoose.Types.ObjectId(str) : null;
};

const jobSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
    productSlug: { type: String, required: true, index: true, trim: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },

    status: { type: String, enum: JOB_STATUSES, default: 'QUEUED', index: true },

    // Provider identity, captured at request time so the audit trail says which
    // engine produced (or was asked to produce) this mesh.
    provider: { type: String, default: '' },
    providerModel: { type: String, default: '' },
    providerModelVersion: { type: String, default: '' },
    providerTaskId: { type: String, default: '' },
    providerExtra: { type: mongoose.Schema.Types.Mixed, default: null },

    source: {
      referenceIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      viewCount: { type: Number, default: 0 },
      label: { type: String, default: '' },
    },

    settings: {
      quality: { type: String, enum: ['draft', 'standard', 'high'], default: 'standard' },
      notes: { type: String, default: '' },
    },

    error: {
      code: { type: String, default: '' },
      message: { type: String, default: '' },
    },

    retryCount: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // REMOTE GPU AGENT — the result "slot" guard. Set atomically (together
    // with the POST_PROCESSING transition) by the FIRST result upload that
    // holds the lease, so a retried/duplicated upload cannot create a second
    // candidate asset for one job. Cleared on re-claim (stale-lease recovery)
    // and on retry.
    resultReceivedAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    claimedAt: { type: Date, default: null },
    claimExpiresAt: { type: Date, default: null },

    // REMOTE GPU AGENT — machine claim bookkeeping. `token` is a per-job random
    // secret (never a credential of any account) and is STRIPPED from every
    // serializer below: the staff UI must never receive it, and neither must
    // any browser payload. `resultToken` is the token that DELIVERED the result:
    // the active token is cleared at finalisation (so a finished job holds no
    // live lease), but the agent's own retried upload must still be recognised
    // as a duplicate rather than as a stranger — this is that proof. It mutates
    // nothing (every transition requires an active status), is replaced on
    // re-claim/retry, and is stripped by the same serializer whitelist.
    lease: {
      token: { type: String, default: '' },
      resultToken: { type: String, default: '' },
      workerId: { type: String, default: '' },
      heartbeatAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

jobSchema.index({ workspaceId: 1, productSlug: 1, createdAt: -1 });
jobSchema.index({ workspaceId: 1, status: 1, claimedAt: 1 });
jobSchema.index({ providerTaskId: 1 }, { sparse: true });
// The agent's claim query: next QUEUED/active job for one provider, oldest first.
jobSchema.index({ status: 1, provider: 1, createdAt: 1 });

jobSchema.set('toJSON', {
  transform(_doc, item) {
    const out = { ...item };
    out.id = item._id ? item._id.toString() : null;
    delete out._id;
    delete out.__v;
    delete out.isFixture;
    /* PHASE 6 — the workspace id is INTERNAL and is NOT part of the client shape.
       The staff projection of an ASSET has never exposed it (Phase 2 asserts that
       outright), and this payload is read by the same browser: leaving a tenant
       identifier here would have been the single internal field on the screen
       while every other row hid it. The field stays in the database — it is only
       the serializer that drops it. Found by the E2E payload check in
       `specs/13-quality-review.spec.js`, not by review. */
    delete out.workspaceId;
    out.productId = item.productId ? item.productId.toString() : null;
    out.createdBy = item.createdBy ? item.createdBy.toString() : null;
    out.claimedBy = item.claimedBy ? item.claimedBy.toString() : null;
    /* PHASE — remote GPU agent. The lease TOKEN is a per-job secret: it is the
       second half of what authorises an input read or a result write, so it
       must never reach a browser. The safe facts (which machine, when it last
       renewed, whether a lease is held at all) stay visible for the studio's
       honest availability display. */
    out.lease = {
      held: Boolean(item.lease?.token),
      workerId: item.lease?.workerId || '',
      heartbeatAt: item.lease?.heartbeatAt ? item.lease.heartbeatAt.toISOString() : null,
    };
    if (out.source) {
      out.source = {
        referenceIds: (item.source.referenceIds || []).map((id) => id.toString()),
        viewCount: item.source.viewCount || 0,
        label: item.source.label || '',
      };
    }
    return out;
  },
});

const GenerationJob = mongoose.model('GenerationJob', jobSchema);

/** Load one job inside the caller's workspace, or throw 404. */
async function loadScoped(req, jobId) {
  const id = toObjectId(jobId);
  if (!id) throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
  const doc = await GenerationJob.findOne({ _id: id, ...workspaceScope(req.user) });
  if (!doc) throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
  return doc;
}

/**
 * Create a QUEUED job for one product from a set of ACCEPTED reference images.
 *
 * The reference ids are validated against the caller's workspace and against
 * `accepted: true`: an unaccepted (or someone else's) reference is refused
 * outright rather than silently dropped, because generating from material a
 * person explicitly did not accept is precisely the behaviour Phase 1 forbids.
 */
export async function createGenerationJob(
  req,
  { productSlug, referenceIds = [], label = '', quality = 'standard', notes = '' } = {}
) {
  const slug = String(productSlug || '').trim();
  if (!slug) throw new ApiError(422, 'A product is required to start a generation.', 'VALIDATION_ERROR');
  if (!Array.isArray(referenceIds) || referenceIds.length === 0) {
    throw new ApiError(422, 'At least one accepted reference image is required.', 'NO_REFERENCES');
  }

  const Product = mongoose.model('Product');
  const product = await Product.findOne({ slug, ...workspaceScope(req.user) })
    .select('_id slug workspaceId')
    .lean();
  if (!product) throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');

  const ProductReferenceImage = mongoose.model('ProductReferenceImage');
  const ids = referenceIds.map(toObjectId).filter(Boolean);
  if (ids.length !== referenceIds.length) {
    throw new ApiError(422, 'One or more reference images could not be found.', 'REFERENCE_NOT_FOUND');
  }

  const refs = await ProductReferenceImage.find({ _id: { $in: ids }, ...workspaceScope(req.user) })
    .select('_id accepted status productSlug')
    .lean();
  if (refs.length !== ids.length) {
    throw new ApiError(422, 'One or more reference images could not be found.', 'REFERENCE_NOT_FOUND');
  }
  // Preserve the caller's ordering — the first accepted reference is the primary view.
  const byId = new Map(refs.map((r) => [String(r._id), r]));
  const ordered = ids.map((id) => byId.get(String(id))).filter(Boolean);
  const unaccepted = ordered.filter((r) => !r.accepted);
  if (unaccepted.length > 0) {
    throw new ApiError(
      422,
      'Only accepted reference images can be used for 3D generation.',
      'NO_ACCEPTED_REFERENCES'
    );
  }
  // A reference belonging to a DIFFERENT product would leak another product's
  // working material into this product's model, so it is refused.
  const foreign = ordered.filter((r) => r.productSlug && r.productSlug !== slug);
  if (foreign.length > 0) {
    throw new ApiError(422, 'Those reference images belong to another product.', 'REFERENCE_MISMATCH');
  }

  const doc = new GenerationJob({
    workspaceId: getWorkspaceId(req.user) || product.workspaceId || null,
    productSlug: slug,
    productId: product._id,
    status: 'QUEUED',
    source: {
      referenceIds: ordered.map((r) => r._id),
      viewCount: ordered.length,
      label: String(label || '').slice(0, 200) || `3D generation from ${ordered.length} accepted reference${ordered.length === 1 ? '' : 's'}`,
    },
    settings: { quality, notes: String(notes || '').slice(0, 1000) },
    createdBy: req.user?._id || null,
  });
  await doc.save();
  return doc.toJSON();
}

/** Record the provider identity chosen for a job. */
export async function attachProvider(req, jobId, plan) {
  const doc = await loadScoped(req, jobId);
  doc.provider = plan.provider || doc.provider;
  doc.providerModel = plan.model || doc.providerModel;
  doc.providerModelVersion = plan.modelVersion || doc.providerModelVersion;
  await doc.save();
  return doc.toJSON();
}

/** All jobs for one product, newest first. */
export async function listJobsForProduct(req, productSlug) {
  const docs = await GenerationJob.find({
    ...workspaceScope(req.user),
    productSlug: String(productSlug || ''),
  }).sort({ createdAt: -1 });
  return docs.map((d) => d.toJSON());
}

export async function getJob(req, jobId) {
  const doc = await loadScoped(req, jobId);
  return doc.toJSON();
}

export async function findJobById(req, jobId) {
  const id = toObjectId(jobId);
  if (!id) return null;
  return GenerationJob.findOne({ _id: id, ...workspaceScope(req.user) }).lean();
}

/**
 * Atomically claim ONE active job for this workspace so a second worker cannot
 * process the same job. Returns the claimed lean document, or null when there
 * is nothing to claim. A stale claim (past `claimExpiresAt`) is reclaimable, so
 * a crashed worker cannot strand a job forever.
 */
export async function claimNextJob(req) {
  const now = new Date();
  const doc = await GenerationJob.findOneAndUpdate(
    {
      ...workspaceScope(req.user),
      status: { $in: JOB_STATUSES_ACTIVE },
      // A job currently held by a REMOTE AGENT's lease is never claimable by
      // the in-process path, whatever its `claimedBy` says (agent claims carry
      // no user). Legacy documents without the field match `null` in $in, so
      // historical rows keep their exact behaviour.
      'lease.token': { $in: [null, ''] },
      $or: [{ claimedBy: null }, { claimExpiresAt: { $lte: now } }],
    },
    {
      $set: {
        status: 'GENERATING',
        claimedBy: req.user?._id || null,
        claimedAt: now,
        claimExpiresAt: new Date(now.getTime() + CLAIM_WINDOW_MS),
        startedAt: now,
      },
    },
    { sort: { createdAt: 1 }, new: true }
  ).lean();
  return doc || null;
}

/** Claim one specific job by id (the request path claims the job it just made). */
export async function claimJob(req, jobId) {
  const id = toObjectId(jobId);
  if (!id) return null;
  const now = new Date();
  return GenerationJob.findOneAndUpdate(
    {
      _id: id,
      ...workspaceScope(req.user),
      status: { $in: JOB_STATUSES_ACTIVE },
      // See claimNextJob: an agent-held lease refuses an in-process claim.
      'lease.token': { $in: [null, ''] },
      $or: [{ claimedBy: null }, { claimExpiresAt: { $lte: now } }],
    },
    {
      $set: {
        status: 'GENERATING',
        claimedBy: req.user?._id || null,
        claimedAt: now,
        claimExpiresAt: new Date(now.getTime() + CLAIM_WINDOW_MS),
        startedAt: now,
      },
    },
    { new: true }
  ).lean();
}

/**
 * Move a job forward. `patch` carries the provider bookkeeping (task id,
 * progress, failure reason). Terminal statuses stamp `completedAt` and release
 * the claim so a retry starts clean.
 */
export async function updateJobStatus(req, jobId, status, patch = {}) {
  const id = toObjectId(jobId);
  if (!id) throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
  if (!JOB_STATUSES.includes(status)) {
    throw new ApiError(500, `Unknown job status "${status}".`, 'JOB_BAD_STATUS');
  }

  const set = { status };
  if (typeof patch.providerTaskId === 'string') set.providerTaskId = patch.providerTaskId;
  if (patch.providerExtra !== undefined) set.providerExtra = patch.providerExtra;
  if (patch.startedAt) set.startedAt = patch.startedAt;
  if (JOB_STATUSES_FINAL.includes(status) || status === 'READY_FOR_REVIEW') {
    set.completedAt = new Date();
    Object.assign(set, CLAIM_RELEASED);
  }
  if (patch.error) {
    set.error = {
      code: String(patch.error.code || '').slice(0, 100),
      message: String(patch.error.message || '').slice(0, 500),
    };
  }

  const doc = await GenerationJob.findOneAndUpdate(
    { _id: id, ...workspaceScope(req.user) },
    { $set: set },
    { new: true }
  );
  if (!doc) throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
  return doc.toJSON();
}

/**
 * Mark a job FAILED with a readable reason. Idempotent-ish: a job already in a
 * terminal state keeps its outcome rather than being overwritten by a late
 * worker error.
 */
export async function failJob(req, jobId, { code = '', message = '' } = {}) {
  const id = toObjectId(jobId);
  if (!id) return null;
  const doc = await GenerationJob.findOneAndUpdate(
    { _id: id, ...workspaceScope(req.user), status: { $nin: JOB_STATUSES_FINAL } },
    {
      $set: {
        status: 'FAILED',
        error: { code: String(code || '').slice(0, 100), message: String(message || '').slice(0, 500) },
        completedAt: new Date(),
        ...CLAIM_RELEASED,
      },
    },
    { new: true }
  );
  return doc ? doc.toJSON() : null;
}

/** Cancel an active job. A job that already finished is not cancellable. */
export async function cancelJob(req, jobId) {
  const doc = await loadScoped(req, jobId);
  if (JOB_STATUSES_FINAL.includes(doc.status) || doc.status === 'READY_FOR_REVIEW') {
    throw new ApiError(422, `A job in status "${doc.status}" cannot be cancelled.`, 'JOB_NOT_CANCELABLE');
  }
  doc.status = 'CANCELLED';
  doc.completedAt = new Date();
  doc.claimedBy = null;
  doc.claimedAt = null;
  doc.claimExpiresAt = null;
  doc.lease = { token: '', resultToken: '', workerId: '', heartbeatAt: null };
  await doc.save();
  return doc.toJSON();
}

/** Re-queue a failed or cancelled job so it can run again. */
export async function retryJob(req, jobId) {
  const doc = await loadScoped(req, jobId);
  if (!JOB_STATUSES_CAN_RETRY.includes(doc.status)) {
    throw new ApiError(422, `A job in status "${doc.status}" cannot be retried.`, 'JOB_NOT_RETRYABLE');
  }
  doc.status = 'QUEUED';
  doc.error = { code: '', message: '' };
  doc.providerTaskId = '';
  doc.providerExtra = null;
  doc.retryCount += 1;
  doc.startedAt = null;
  doc.completedAt = null;
  doc.resultReceivedAt = null;
  doc.claimedBy = null;
  doc.claimedAt = null;
  doc.claimExpiresAt = null;
  doc.lease = { token: '', resultToken: '', workerId: '', heartbeatAt: null };
  await doc.save();
  return doc.toJSON();
}

/** Record the human decision on a job once its candidate asset is resolved. */
export async function settleJob(req, jobId, decision) {
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    throw new ApiError(500, `Unknown job decision "${decision}".`, 'JOB_BAD_DECISION');
  }
  const id = toObjectId(jobId);
  if (!id) throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
  const doc = await GenerationJob.findOneAndUpdate(
    { _id: id, ...workspaceScope(req.user) },
    { $set: { status: decision } },
    { new: true }
  );
  if (!doc) throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
  return doc.toJSON();
}

/* ── REMOTE GPU AGENT — claim, lease, result slot ─────────────────────────
 *
 * These are the ONLY transitions a machine-authenticated request may drive.
 * They are deliberately unscoped by user (the agent has no account): the
 * authority for every one of them is the job's own LEASE TOKEN, which was
 * minted at claim time and is never derivable from anything the agent sends
 * except by holding it. Workspace scoping still applies everywhere a STAFF
 * request acts, exactly as before.
 */

/** Mint a fresh per-job lease token. */
function newLeaseToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Atomically claim the NEXT job for provider `provider` on behalf of a remote
 * agent. Takes either a never-claimed QUEUED job or an ACTIVE job whose agent
 * lease EXPIRED (the crashed-PC recovery path) — and nothing else.
 *
 * Returns the raw document INCLUDING `lease.token` (server → agent, over the
 * machine-authenticated channel; the staff serializer strips it).
 */
export async function claimNextJobForAgent({ provider, workerId = '', leaseMs = agentLeaseMs() } = {}) {
  if (!provider) return null;
  const now = new Date();
  const doc = await GenerationJob.findOneAndUpdate(
    {
      status: { $in: JOB_STATUSES_ACTIVE },
      provider,
      $or: [
        // free: never agent-claimed (legacy docs have no lease field → null),
        { 'lease.token': { $in: [null, ''] } },
        // or held by a lease that has since expired (agent crashed mid-run).
        { claimExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'GENERATING',
        claimedAt: now,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
        startedAt: now,
        providerExtra: null,
        error: { code: '', message: '' },
        lease: { token: newLeaseToken(), workerId: String(workerId).slice(0, 64), heartbeatAt: now },
      },
    },
    { sort: { createdAt: 1 }, new: true }
  ).lean();
  return doc || null;
}

/**
 * Load a job the way an agent endpoint must: by id, bound to `provider`, and
 * only when the presented lease token matches the job's own. Throws the same
 * 404/409 shapes the rest of the API uses; the message never echoes a token.
 */
export async function loadLeasedJob(jobId, leaseToken, { provider } = {}) {
  const id = toObjectId(jobId);
  if (!id) throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
  const filter = { _id: id };
  if (provider) filter.provider = provider;
  const doc = await GenerationJob.findOne(filter).lean();
  if (!doc) throw new ApiError(404, 'Generation job not found.', 'JOB_NOT_FOUND');
  const held = String(doc.lease?.token || '');
  if (!held || !leaseToken || !timingSafeStringEqual(held, String(leaseToken))) {
    throw new ApiError(409, 'This job is not claimed by this agent (lease lost or never held).', 'LEASE_LOST');
  }
  return doc;
}

/**
 * Extend the lease (the agent's heartbeat for one job). Only an ACTIVE job
 * whose lease token matches may be renewed; the caller learns WHY it failed so
 * the agent can abort truthfully (cancelled vs lost).
 */
export async function renewAgentLease(jobId, leaseToken, leaseMs = agentLeaseMs()) {
  const id = toObjectId(jobId);
  if (!id) return { ok: false, reason: 'NOT_FOUND', status: '' };
  const current = await GenerationJob.findOne({ _id: id }).lean().catch(() => null);
  if (!current) return { ok: false, reason: 'NOT_FOUND', status: '' };
  const presented = String(leaseToken || '');
  const held = String(current.lease?.token || '');
  const heldOk = Boolean(held && presented && timingSafeStringEqual(held, presented));
  const resultOk = Boolean(
    !held &&
      current.lease?.resultToken &&
      presented &&
      timingSafeStringEqual(String(current.lease.resultToken), presented)
  );
  // CANCELLED comes FIRST: the cancel path clears the active token, so a
  // token-only check would tell the agent its lease was "lost" when the
  // truthful answer — the one that stops an in-flight inference — is "abort".
  if (current.status === 'CANCELLED') {
    return { ok: false, reason: 'CANCELLED', status: current.status };
  }
  if (!JOB_STATUSES_ACTIVE.includes(current.status)) {
    // Finished: the agent that delivered the result (its recorded token) is
    // told NOT_ACTIVE; any other token learns only that its lease is gone.
    if (heldOk || resultOk) return { ok: false, reason: 'NOT_ACTIVE', status: current.status };
    return { ok: false, reason: 'LEASE_LOST', status: current.status };
  }
  if (!heldOk) return { ok: false, reason: 'LEASE_LOST', status: current.status };
  const now = new Date();
  const doc = await GenerationJob.findOneAndUpdate(
    { _id: id, status: { $in: JOB_STATUSES_ACTIVE }, 'lease.token': held },
    { $set: { 'lease.heartbeatAt': now, claimExpiresAt: new Date(now.getTime() + leaseMs) } },
    { new: true }
  ).lean();
  if (!doc) return { ok: false, reason: 'LEASE_LOST', status: '' };
  return { ok: true, reason: '', status: doc.status, job: doc };
}

/**
 * Take the RESULT SLOT: atomically move GENERATING → POST_PROCESSING and mark
 * the result as received, guarded by the lease. A second (duplicated,
 * concurrent) upload finds the slot taken and is told so instead of creating a
 * second candidate asset.
 */
export async function takeResultSlot(jobId, leaseToken, leaseMs = agentLeaseMs()) {
  const id = toObjectId(jobId);
  if (!id) return { ok: false, reason: 'NOT_FOUND', status: '' };
  const current = await GenerationJob.findOne({ _id: id }).lean().catch(() => null);
  if (!current) return { ok: false, reason: 'NOT_FOUND', status: '' };
  const presented = String(leaseToken || '');
  const held = String(current.lease?.token || '');
  const heldOk = Boolean(held && presented && timingSafeStringEqual(held, presented));
  const resultOk = Boolean(
    !held &&
      current.lease?.resultToken &&
      presented &&
      timingSafeStringEqual(String(current.lease.resultToken), presented)
  );
  // A cancelled job answers truthfully: cancel clears the active token, and
  // the only safe, useful answer to its former holder is "stop".
  if (current.status === 'CANCELLED') {
    return { ok: false, reason: 'CANCELLED', status: current.status, job: current };
  }
  // The delivering agent's OWN retried upload (response lost in transit): the
  // active token is gone, but the recorded result token proves identity, so
  // the retry is a duplicate — never a second candidate, never a stranger's 409.
  if (!heldOk && resultOk) {
    return { ok: false, reason: 'DUPLICATE', status: current.status, job: current };
  }
  if (!heldOk) {
    return { ok: false, reason: 'LEASE_LOST', status: current.status, job: current };
  }
  const now = new Date();
  const doc = await GenerationJob.findOneAndUpdate(
    {
      _id: id,
      status: { $in: JOB_STATUSES_ACTIVE },
      'lease.token': held,
      resultReceivedAt: null,
    },
    {
      $set: {
        status: 'POST_PROCESSING',
        resultReceivedAt: now,
        'lease.heartbeatAt': now,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
      },
    },
    { new: true }
  ).lean();
  if (doc) return { ok: true, reason: '', status: doc.status, job: doc };
  // Slot refused: read the truth for the agent (duplicate vs cancelled vs lost).
  const latest = await GenerationJob.findOne({ _id: id }).lean().catch(() => null);
  const latestStatus = latest?.status || '';
  if (latest?.status === 'READY_FOR_REVIEW' || latest?.resultReceivedAt) {
    return { ok: false, reason: 'DUPLICATE', status: latestStatus, job: latest };
  }
  if (latestStatus === 'CANCELLED') return { ok: false, reason: 'CANCELLED', status: latestStatus, job: latest };
  return { ok: false, reason: 'LEASE_LOST', status: latestStatus, job: latest };
}

/**
 * Finalise: POST_PROCESSING → READY_FOR_REVIEW, still guarded by the lease.
 * Returns null when the guard lost (job cancelled or lease taken over while the
 * bytes were being validated) — the caller must then discard the candidate it
 * just created rather than promoting a job a human already stopped.
 */
export async function finalizeAgentResult(
  jobId,
  leaseToken,
  { providerTaskId = '', assetId = null, bytes = 0 } = {}
) {
  const id = toObjectId(jobId);
  if (!id) return null;
  const doc = await GenerationJob.findOneAndUpdate(
    {
      _id: id,
      status: 'POST_PROCESSING',
      'lease.token': String(leaseToken || ''),
    },
    {
      $set: {
        status: 'READY_FOR_REVIEW',
        completedAt: new Date(),
        providerTaskId: String(providerTaskId || '').slice(0, 200),
        providerExtra: { assetId: assetId ? String(assetId) : '', bytes, resultReceived: true },
        ...CLAIM_RELEASED,
        // Keep the proof that THIS token delivered the result: the active
        // token is released above, so a retried upload from the same agent is
        // recognised as a duplicate instead of a lost lease.
        'lease.resultToken': String(leaseToken || ''),
      },
    },
    { new: true }
  ).lean();
  return doc || null;
}

/**
 * Return a leased-but-unfinished job to the queue (graceful agent shutdown
 * before inference finished). Refuses when a result was already received —
 * that job is on its way to review, not up for grabs.
 */
export async function releaseAgentLease(jobId, leaseToken) {
  const id = toObjectId(jobId);
  if (!id) return { ok: false, reason: 'NOT_FOUND' };
  const current = await GenerationJob.findOne({ _id: id }).lean().catch(() => null);
  if (!current) return { ok: false, reason: 'NOT_FOUND' };
  const presented = String(leaseToken || '');
  const held = String(current.lease?.token || '');
  const heldOk = Boolean(held && presented && timingSafeStringEqual(held, presented));
  const resultOk = Boolean(
    !held &&
      current.lease?.resultToken &&
      presented &&
      timingSafeStringEqual(String(current.lease.resultToken), presented)
  );
  // Cancelled beats the token check: cancel cleared the token, and "cancelled"
  // is the answer that tells the agent why it must not release — or work —.
  if (current.status === 'CANCELLED') return { ok: false, reason: 'CANCELLED', status: current.status };
  if (current.resultReceivedAt) {
    return { ok: false, reason: heldOk || resultOk ? 'DUPLICATE' : 'LEASE_LOST', status: current.status };
  }
  if (!JOB_STATUSES_ACTIVE.includes(current.status)) {
    return { ok: false, reason: 'LEASE_LOST', status: current.status };
  }
  if (!heldOk) return { ok: false, reason: 'LEASE_LOST', status: current.status };
  const doc = await GenerationJob.findOneAndUpdate(
    { _id: id, status: { $in: JOB_STATUSES_ACTIVE }, 'lease.token': held, resultReceivedAt: null },
    { $set: { status: 'QUEUED', providerExtra: null, startedAt: null, ...CLAIM_RELEASED } },
    { new: true }
  ).lean();
  return doc ? { ok: true, reason: '', job: doc } : { ok: false, reason: 'LEASE_LOST', status: current.status };
}

/**
 * The agent's bounded failure report. Same terminal shape as the in-process
 * failure path, guarded by the lease so a stranger's report cannot fail a job.
 */
export async function failJobByAgent(jobId, leaseToken, { code = '', message = '' } = {}) {
  const id = toObjectId(jobId);
  if (!id) return null;
  const current = await GenerationJob.findOne({ _id: id }).lean().catch(() => null);
  if (!current) return null;
  const held = String(current.lease?.token || '');
  if (!held || !leaseToken || !timingSafeStringEqual(held, String(leaseToken))) return null;
  return GenerationJob.findOneAndUpdate(
    { _id: id, 'lease.token': held, status: { $in: JOB_STATUSES_ACTIVE } },
    {
      $set: {
        status: 'FAILED',
        error: { code: String(code || '').slice(0, 100), message: String(message || '').slice(0, 500) },
        completedAt: new Date(),
        ...CLAIM_RELEASED,
      },
    },
    { new: true }
  )
    .lean()
    .then((doc) => doc || null);
}

export { toObjectId as jobObjectId };
export default GenerationJob;
