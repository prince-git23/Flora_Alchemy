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

import mongoose from 'mongoose';
import { ApiError } from '../middleware/errorMiddleware.js';
import { getWorkspaceId, workspaceScope } from '../utils/tenancy.js';

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

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    claimedAt: { type: Date, default: null },
    claimExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

jobSchema.index({ workspaceId: 1, productSlug: 1, createdAt: -1 });
jobSchema.index({ workspaceId: 1, status: 1, claimedAt: 1 });
jobSchema.index({ providerTaskId: 1 }, { sparse: true });

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
    set.claimedBy = null;
    set.claimedAt = null;
    set.claimExpiresAt = null;
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
        claimedBy: null,
        claimedAt: null,
        claimExpiresAt: null,
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
  doc.claimedBy = null;
  doc.claimedAt = null;
  doc.claimExpiresAt = null;
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

export { toObjectId as jobObjectId };
export default GenerationJob;
