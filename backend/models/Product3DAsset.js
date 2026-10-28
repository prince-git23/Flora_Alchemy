/**
 * Product3DAsset — 3D Studio (Phase 2) — one generated GLB candidate, and the
 * single approved model a product may show.
 *
 * A product carries AT MOST ONE approved asset. Approving a new candidate
 * DEPRECATES the previous one instead of deleting it, which is what makes
 * "a failed or rejected replacement never destroys the live model" true: the
 * older row (and its files on disk) survive, so restoring it is a status
 * change rather than a re-generation.
 *
 * LIFE CYCLE:
 *   CANDIDATE → (approved) → APPROVED
 *   CANDIDATE → (rejected) → REJECTED
 *   APPROVED  → (replaced) → DEPRECATED
 *
 * Only a CANDIDATE that actually has stored, header-validated GLB bytes can be
 * approved. That check lives in the service, but the invariant it protects is
 * stated here: an asset row without `storage.glb.storageKey` is not previewable
 * and not approvable, so no customer-facing 3D preview can ever be backed by a
 * placeholder.
 */

import mongoose from 'mongoose';
/* PHASE 6 — the fingerprint's DEFINITION is imported, not re-implemented. Two
   copies of "what makes a report current" would drift, and the drift would
   quietly mark every stored verdict current. `3dQualityAssessment.js` is a pure
   function module that imports no model, so this direction cannot cycle. */
import { fingerprintFor, ASSESSMENT_VERSION } from '../services/3dQualityAssessment.js';

export const STATUS_CANDIDATE = 'CANDIDATE';
export const STATUS_APPROVED = 'APPROVED';
export const STATUS_REJECTED = 'REJECTED';
export const STATUS_DEPRECATED = 'DEPRECATED';

export const ASSET_STATUSES = [STATUS_CANDIDATE, STATUS_APPROVED, STATUS_REJECTED, STATUS_DEPRECATED];

const assetSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
    productSlug: { type: String, required: true, index: true, trim: true },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'GenerationJob', default: null },

    status: { type: String, enum: ASSET_STATUSES, default: STATUS_CANDIDATE, index: true },
    version: { type: Number, default: 1 },

    // Provider identity, copied from the job so the asset is self-describing even
    // if the job row is later pruned.
    provider: { type: String, default: '' },
    providerModel: { type: String, default: '' },
    providerModelVersion: { type: String, default: '' },
    providerTaskId: { type: String, default: '' },

    // Which accepted reference images produced this mesh.
    source: {
      referenceIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      viewCount: { type: Number, default: 0 },
      label: { type: String, default: '' },
    },

    // PRIVATE media. `storageKey` is a path relative to the 3D media root and is
    // never exposed to a customer; the only reader is the authenticated
    // /api/3d/media/... route.
    storage: {
      glb: {
        storageKey: { type: String, default: '' },
        bytes: { type: Number, default: 0 },
        sha256: { type: String, default: '' },
      },
      thumbnail: {
        storageKey: { type: String, default: '' },
        bytes: { type: Number, default: 0 },
      },
    },

    // What validation actually established about the bytes on disk.
    validation: {
      ok: { type: Boolean, default: false },
      magic: { type: String, default: '' },
      gltfVersion: { type: Number, default: 0 },
      declaredBytes: { type: Number, default: 0 },
      meshes: { type: Number, default: 0 },
      materials: { type: Number, default: 0 },
      textures: { type: Number, default: 0 },
      notes: { type: String, default: '' },
    },

    // PHASE 5 — the quality gate's verdict on THESE bytes against THIS reference
    // set. `fingerprint` is what makes staleness detectable: if the model, its
    // references or its settings change, the stored fingerprint no longer
    // matches and the gate re-assesses before any approval is honoured.
    quality: {
      version: { type: String, default: '' },
      decision: { type: String, enum: ['', 'PASS', 'REVIEW', 'BLOCKED'], default: '' },
      assessedAt: { type: Date, default: null },
      fingerprint: { type: String, default: '' },
      summary: { type: String, default: '' },
      report: { type: mongoose.Schema.Types.Mixed, default: null },
      // An explicit human acceptance of a REVIEW-grade model.
      review: {
        acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        acknowledgedAt: { type: Date, default: null },
        note: { type: String, default: '' },
      },
      // An authorised override past a BLOCKED verdict. The original decision is
      // retained, so an override never erases what the gate actually found.
      override: {
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        at: { type: Date, default: null },
        reason: { type: String, default: '' },
        previousDecision: { type: String, default: '' },
      },
    },

    // PHASE 9 — canonical presentation correction. The WORKER already exports
    // the mesh in the glTF frame (+Y up, see worker.canonical_orientation);
    // this is the STAFF-owned quarter-turn applied ON TOP when the engine's
    // frame guess is still wrong for a particular product. Whole 90-degree Y
    // turns only: exact, cannot drift, and applied exactly once per viewer load
    // (never accumulated). The generated GLB bytes are never rewritten — the
    // original stays auditable — and the correction is presentation, not
    // geometry: it does not touch the quality fingerprint.
    orientation: {
      yawQuarterTurns: { type: Number, default: 0, min: 0, max: 3 },
      correctedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      correctedAt: { type: Date, default: null },
      reason: { type: String, default: '' },
    },

    // Human decision trail.
    approval: {
      approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      approvedAt: { type: Date, default: null },
      rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      rejectedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: '' },
      replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Product3DAsset', default: null },
      replacedAt: { type: Date, default: null },
    },

    settings: {
      quality: { type: String, enum: ['draft', 'standard', 'high'], default: 'standard' },
      notes: { type: String, default: '' },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// A product may hold only one approved row; the partial unique index makes that
// a database fact rather than a convention the service must remember.
assetSchema.index(
  { workspaceId: 1, productSlug: 1 },
  {
    unique: true,
    partialFilterExpression: { status: STATUS_APPROVED },
    name: 'one_approved_asset_per_product',
  }
);
assetSchema.index({ workspaceId: 1, productSlug: 1, createdAt: -1 });
assetSchema.index({ jobId: 1 }, { sparse: true });

const iso = (value) => (value ? new Date(value).toISOString() : null);
const idOf = (value) => (value ? String(value) : null);

assetSchema.set('toJSON', {
  transform(_doc, item) {
    const out = { ...item };
    out.id = item._id ? item._id.toString() : null;
    delete out._id;
    delete out.__v;
    out.workspaceId = idOf(item.workspaceId);
    out.jobId = idOf(item.jobId);
    out.createdBy = idOf(item.createdBy);
    out.source = {
      referenceIds: (item.source?.referenceIds || []).map((id) => String(id)),
      viewCount: item.source?.viewCount || 0,
      label: item.source?.label || '',
    };
    out.approval = {
      approvedBy: idOf(item.approval?.approvedBy),
      approvedAt: iso(item.approval?.approvedAt),
      rejectedBy: idOf(item.approval?.rejectedBy),
      rejectedAt: iso(item.approval?.rejectedAt),
      rejectionReason: item.approval?.rejectionReason || '',
      replacedBy: idOf(item.approval?.replacedBy),
      replacedAt: iso(item.approval?.replacedAt),
    };
    out.quality = {
      version: item.quality?.version || '',
      decision: item.quality?.decision || '',
      assessedAt: iso(item.quality?.assessedAt),
      fingerprint: item.quality?.fingerprint || '',
      summary: item.quality?.summary || '',
      report: item.quality?.report || null,
      review: {
        acknowledgedBy: idOf(item.quality?.review?.acknowledgedBy),
        acknowledgedAt: iso(item.quality?.review?.acknowledgedAt),
        note: item.quality?.review?.note || '',
      },
      override: {
        by: idOf(item.quality?.override?.by),
        at: iso(item.quality?.override?.at),
        reason: item.quality?.override?.reason || '',
        previousDecision: item.quality?.override?.previousDecision || '',
      },
    };
    out.orientation = {
      yawQuarterTurns: Number(item.orientation?.yawQuarterTurns || 0) || 0,
      correctedBy: idOf(item.orientation?.correctedBy),
      correctedAt: iso(item.orientation?.correctedAt),
      reason: item.orientation?.reason || '',
    };
    out.createdAt = iso(item.createdAt);
    out.updatedAt = iso(item.updatedAt);
    return out;
  },
});

const Product3DAsset = mongoose.model('Product3DAsset', assetSchema);

export const normalizeObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const str = String(value);
  return mongoose.isValidObjectId(str) ? new mongoose.Types.ObjectId(str) : null;
};

/**
 * Does this asset carry a completed quality assessment?
 *
 * Deliberately a predicate about the STORED REPORT only. Whether that report is
 * still CURRENT is a question about the model, its references and its settings,
 * which the service answers by recomputing the fingerprint.
 */
export function hasQualityReport(asset) {
  if (!asset) return false;
  const src = typeof asset.toObject === 'function' ? asset.toObject() : asset;
  return Boolean(src.quality?.decision) && Boolean(src.quality?.fingerprint);
}

/**
 * Has this asset got real, validated GLB bytes behind it?
 *
 * Approval and preview both hinge on this, so it is a single named predicate
 * rather than a repeated `storage?.glb?.storageKey` truthiness check.
 */
export function hasValidatedModel(asset) {
  if (!asset) return false;
  const key = typeof asset.toObject === 'function' ? asset.toObject().storage?.glb?.storageKey : asset.storage?.glb?.storageKey;
  const ok = typeof asset.toObject === 'function' ? asset.toObject().validation?.ok : asset.validation?.ok;
  return Boolean(key) && Boolean(ok);
}

/**
 * Is this asset a PUBLICLY SERVABLE approved model?
 *
 * Phase 3 reuses this in BOTH application code (publicProject3d) and controller
 * code (3dPublicDeliveryController), so the same rule is not restated in two
 * places.
 */
export function isApprovedModelServable(asset) {
  if (!asset || asset.status !== STATUS_APPROVED) return false;
  if (!asset.storage?.glb?.storageKey) return false;
  if (!asset.validation?.ok) return false;
  return true;
}

/** The public kinds a storefront may request (not the private storage kinds). */
export const PUBLIC_ASSET_KINDS = ['glb', 'thumbnail'];

/**
 * The staff-facing projection of an asset. Deliberately omits the raw storage
 * key: staff screens address media through `/api/3d/media/...`, and a storage
 * key is an implementation detail of the private root.
 */
/**
 * The exact identity of what a stored report describes: the model's own bytes,
 * the reference set it was measured against, the generation settings, and the
 * assessment version. Change any of them and an older report stops describing
 * the thing it was written about — which is what makes "stale" a fact about the
 * row rather than a judgement about it.
 */
export function qualityFingerprint(asset) {
  const src = typeof asset.toObject === 'function' ? asset.toObject() : asset;
  return fingerprintFor({
    sha256: src.storage?.glb?.sha256 || '',
    referenceIds: src.source?.referenceIds || [],
    assessmentVersion: ASSESSMENT_VERSION,
    settings: src.settings || {},
  });
}

/** Is the stored verdict about the CURRENT bytes, references and settings? */
export function qualityIsCurrent(asset) {
  const src = typeof asset.toObject === 'function' ? asset.toObject() : asset;
  if (!src.quality?.decision || !src.quality?.fingerprint) return false;
  return src.quality.fingerprint === qualityFingerprint(src);
}

export function publicAssetProjection(asset) {
  if (!asset) return null;
  const src = typeof asset.toObject === 'function' ? asset.toObject() : asset;
  return {
    id: idOf(src._id || src.id),
    productSlug: src.productSlug || '',
    status: src.status || '',
    version: src.version || 1,
    provider: src.provider || '',
    model: src.providerModel || '',
    modelVersion: src.providerModelVersion || '',
    source: {
      referenceIds: (src.source?.referenceIds || []).map((id) => String(id)),
      viewCount: src.source?.viewCount || 0,
      label: src.source?.label || '',
    },
    hasModel: Boolean(src.storage?.glb?.storageKey) && Boolean(src.validation?.ok),
    bytes: src.storage?.glb?.bytes || 0,
    sha256: src.storage?.glb?.sha256 || '',
    validation: {
      ok: Boolean(src.validation?.ok),
      magic: src.validation?.magic || '',
      gltfVersion: src.validation?.gltfVersion || 0,
      bytes: src.validation?.declaredBytes || 0,
      meshes: src.validation?.meshes || 0,
      materials: src.validation?.materials || 0,
      textures: src.validation?.textures || 0,
      notes: src.validation?.notes || '',
    },
    // PHASE 5 — staff-facing only. The CUSTOMER projection is built separately
    // (`product3dPublicResolution.js`) and deliberately carries none of this.
    quality: {
      decision: src.quality?.decision || '',
      version: src.quality?.version || '',
      assessedAt: iso(src.quality?.assessedAt),
      fingerprint: src.quality?.fingerprint || '',
      /* PHASE 6 — a verdict about DIFFERENT bytes, references or settings is
         reported to the reviewer as out of date instead of being passed off as
         current. The rule is a property of the row (see `qualityIsCurrent`), so
         the client cannot decide it and cannot fake it. */
      stale: !qualityIsCurrent(src),
      summary: src.quality?.summary || '',
      silhouette: src.quality?.report?.silhouette || null,
      geometry: src.quality?.report?.geometry
        ? {
            vertices: src.quality.report.geometry.vertices,
            triangles: src.quality.report.geometry.triangles,
            fileBytes: src.quality.report.geometry.fileBytes,
            watertight: src.quality.report.geometry.watertight,
            boundaryEdges: src.quality.report.geometry.boundaryEdges,
            degenerateTriangles: src.quality.report.geometry.degenerateTriangles,
            dimensions: src.quality.report.geometry.dimensions,
            /* PHASE H3 — fragmentation + depth facts. The projection is an
               ALLOWLIST (FLOW 32): a report field not listed here is invisible
               to the reviewer, which is exactly how the panel once showed
               geometry beside an unexplained verdict. */
            flatness: src.quality.report.geometry.flatness,
            componentCount: src.quality.report.geometry.componentCount ?? null,
            largestComponentShare: src.quality.report.geometry.largestComponentShare ?? null,
          }
        : null,
      /* Which depth band judged THIN_OUTPUT (and where it came from) and the
         product category it resolved from — without these the band is a number
         with no origin on the reviewer's screen. */
      depthBand: src.quality?.report?.depthBand || null,
      category: src.quality?.report?.category || '',
      materials: src.quality?.report?.materials || null,
      /* PHASE 7 — COLOUR, projected as its own section because it is judged
         apart from shape: which colour source the file actually carries, the
         metallicity a PBR viewer will apply, and the measured distribution.
         Without this the panel could show perfect geometry beside a model that
         renders black and say nothing about why. The CUSTOMER projection is
         built separately (`product3dPublicResolution.js`) and carries none of
         it. */
      colour: src.quality?.report?.colour || null,
      /* PHASE 9 — ORIENTATION, projected as its own section: the worker's
         measured frame transform, the view that matched the reference outline
         (and the margin behind that choice), and the coverage numbers. Without
         this the panel could show a perfectly valid model that renders sideways
         and say nothing about why. Allowlist rule as in Phase H3. */
      orientation: src.quality?.report?.orientation || null,
      reference: src.quality?.report?.reference || null,
      reasons: src.quality?.report?.reasons || [],
      warnings: src.quality?.report?.warnings || [],
      calibration: src.quality?.report?.calibration || null,
      review: {
        acknowledgedBy: idOf(src.quality?.review?.acknowledgedBy),
        acknowledgedAt: iso(src.quality?.review?.acknowledgedAt),
        note: src.quality?.review?.note || '',
      },
      override: {
        by: idOf(src.quality?.override?.by),
        at: iso(src.quality?.override?.at),
        reason: src.quality?.override?.reason || '',
        previousDecision: src.quality?.override?.previousDecision || '',
      },
    },
    // PHASE 9 — presentation correction (and who made it). The staff projection
    // carries the full record; the CUSTOMER projection carries only the yaw
    // number needed to render the same pose.
    orientation: {
      yawQuarterTurns: Number(src.orientation?.yawQuarterTurns || 0) || 0,
      correctedBy: idOf(src.orientation?.correctedBy),
      correctedAt: iso(src.orientation?.correctedAt),
      reason: src.orientation?.reason || '',
    },
    approval: {
      approvedBy: idOf(src.approval?.approvedBy),
      approvedAt: iso(src.approval?.approvedAt),
      rejectedBy: idOf(src.approval?.rejectedBy),
      rejectedAt: iso(src.approval?.rejectedAt),
      rejectionReason: src.approval?.rejectionReason || '',
      replacedBy: idOf(src.approval?.replacedBy),
      replacedAt: iso(src.approval?.replacedAt),
    },
    settings: {
      quality: src.settings?.quality || 'standard',
      notes: src.settings?.notes || '',
    },
    createdAt: iso(src.createdAt),
    updatedAt: iso(src.updatedAt),
  };
}

export { hasQualityReport as hasQuality };
export default Product3DAsset;
