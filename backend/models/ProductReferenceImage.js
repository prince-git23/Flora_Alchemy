import mongoose from 'mongoose';

/**
 * 3D STUDIO — Phase 1 — one prepared reference image.
 *
 * WHAT IT IS
 * ----------
 * A photograph an administrator uploaded for a product, plus everything the
 * pipeline learned about it: the untouched ORIGINAL, the transparent CUTOUT, the
 * NEUTRAL preview, the crop that was applied, the measurements, the warnings and
 * the engine that produced them. Phase 2 consumes this document — it never has
 * to look at the filesystem, guess a filename, or ask the administrator to
 * upload anything again.
 *
 * WHY A SEPARATE COLLECTION (and not a field on Product)
 * -----------------------------------------------------
 *   · a reference set exists BEFORE the product does (the studio is used inside
 *     the create-product form), so it cannot be a subdocument of a document that
 *     has no _id yet — `draftKey` keys that window instead;
 *   · image rows are large, updated one at a time (reorder, retry, accept) and
 *     deleted individually; embedding them would rewrite the product on every
 *     keystroke of the review UI;
 *   · the storefront's `image`/`images` contract must not change, and it does
 *     not: reference images are internal working assets, not catalogue photos.
 *
 * TENANCY
 * -------
 * `workspaceId` is written from the SERVER's resolved workspace only (the same
 * rule as every other operational collection: `stripClientWorkspaceId` removes a
 * client-supplied value before any controller runs). Every read is filtered by
 * it, and a mismatch answers 404 so the existence of another workspace's image
 * is never disclosed.
 *
 * The status vocabulary is the one the review UI shows:
 *   UPLOADING · PROCESSING · READY · NEEDS_REVIEW · FAILED
 */

const boxSchema = new mongoose.Schema(
  {
    left: { type: Number, default: 0 },
    top: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
  },
  { _id: false }
);

const assetSchema = new mongoose.Schema(
  {
    /** Path relative to the reference-media root. Never an absolute path and
     *  never a public URL — these files are served only through the API, and
     *  the API strips this field from every response. */
    storageKey: { type: String, default: '' },
    bytes: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    /** Decoded container format as sharp reported it (`jpeg`, `png`, …). The
     *  original's format is needed again at REPROCESS time, where the quality
     *  heuristics re-run from the stored facts rather than the upload. */
    format: { type: String, default: '' },
    hasAlpha: { type: Boolean, default: false },
    fileName: { type: String, default: '' },
    sha256: { type: String, default: '' },
  },
  { _id: false }
);

const referenceImageSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      index: true,
      sparse: true,
    },
    /** Set when the reference set is attached to a saved product. */
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', index: true, sparse: true },
    /** Denormalised for queries and for the case where a slug is known but the
     *  product document is not (imports, seed data). */
    productSlug: { type: String, default: '', index: true, sparse: true },
    /** Opaque client-generated key that groups references uploaded inside the
     *  create-product form, before any product exists. */
    draftKey: { type: String, default: '', index: true, sparse: true },
    /** The storage namespace this row's files live under (the workspace slug, or
     *  `platform` for an owner with no workspace). Persisted rather than derived
     *  per request so a file can still be found — and deleted — by a process with
     *  no request context (cleanup, teardown). Server-written only. */
    storageNamespace: { type: String, default: '', index: true },

    order: { type: Number, default: 0 },
    isPrimary: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['UPLOADING', 'PROCESSING', 'READY', 'NEEDS_REVIEW', 'FAILED'],
      default: 'UPLOADING',
      index: true,
    },
    /** The administrator approved this reference for Phase 2. */
    accepted: { type: Boolean, default: false },
    label: { type: String, default: '' },

    original: { type: assetSchema, default: () => ({}) },
    cutout: { type: assetSchema, default: () => ({}) },
    neutral: { type: assetSchema, default: () => ({}) },

    /** The administrator's crop, normalized 0..1 of the ORIGINAL frame. Stored
     *  so a retry re-applies the same crop and the UI can show it again. */
    crop: {
      type: new mongoose.Schema(
        { x: Number, y: Number, width: Number, height: Number },
        { _id: false }
      ),
      default: undefined,
    },

    processing: {
      engine: { type: String, default: '' },
      model: { type: String, default: '' },
      modelLicence: { type: String, default: '' },
      attempts: { type: Number, default: 0 },
      startedAt: { type: Date, default: null },
      finishedAt: { type: Date, default: null },
      durationMs: { type: Number, default: 0 },
      error: { type: String, default: '' },
      errorCode: { type: String, default: '' },
      /** Engine measurements (foreground ratio, border contact, confidence…).
       *  Mixed because each engine reports its own numbers, and Phase 2 may add
       *  more — a rigid schema here would reject honest new measurements. */
      metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
      foregroundBox: { type: boxSchema, default: () => ({}) },
    },

    validation: {
      sharpnessScore: { type: Number, default: null },
      contrastStdev: { type: Number, default: null },
      edgeMean: { type: Number, default: null },
      signature: {
        hueHistogram: { type: [Number], default: [] },
        meanSaturation: { type: Number, default: null },
        aspect: { type: Number, default: null },
      },
    },

    warnings: { type: [String], default: [] },
    confidence: { type: Number, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isFixture: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// The review UI's queries: one product (or one draft) inside one workspace,
// in display order. This is the index that keeps the studio responsive when a
// product has a dozen references.
referenceImageSchema.index({ workspaceId: 1, productSlug: 1, order: 1 });
referenceImageSchema.index({ workspaceId: 1, draftKey: 1, order: 1 });

const ProductReferenceImage = mongoose.model('ProductReferenceImage', referenceImageSchema);
export default ProductReferenceImage;
