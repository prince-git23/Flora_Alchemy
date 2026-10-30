import mongoose from 'mongoose';

/**
 * 3D STUDIO — Phase 1 — one prepared reference image.
 *
 * WHAT IT IS
 * ----------
 * A photograph an administrator uploaded for a product, plus everything the
 * pipeline learned about it: the untouched ORIGINAL, where it came from (its own
 * upload, or one panel of a composite sheet), the measurements and the warnings.
 * Phase 2 consumes this document — it never has to look at the filesystem, guess
 * a filename, or ask the administrator to upload anything again.
 *
 * WHAT IT IS NOT (Phase 9)
 * -----------------------
 * It is NOT a cutout record. The automatic background-removal step that used to
 * fill `cutout`/`neutral` damaged the product it was supposed to prepare, so it
 * no longer runs and nothing writes those fields. They remain declared, with no
 * writer, ONLY so previously stored media can still be read and deleted by the
 * cleanup paths; `legacyCutout` records that a row predates the removal.
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
    /** Optional human labelling of the viewpoint. Never inferred: the pipeline
     *  cannot tell a back view from a front view, and pretending otherwise would
     *  feed a wrong ordering into a pose-aware model later. */
    viewAngle: { type: String, default: '' },

    /**
     * PHASE 11 — the recorded CAMERA POSE for this photograph, or null.
     *
     * Only a human (`manual`) or an operator's import (`imported`) may write
     * this. There is deliberately no `inferred` source and no estimation path:
     * a pose-aware engine (ReLi3D-style, `transforms.json`) trusts the numbers it
     * is given, so a guessed camera position is worse than an absent one. See
     * `services/capturePose.js` — the ONE definition of a valid pose.
     *
     * Camera-to-world, right-handed Y-up, metres and degrees. `distance` is
     * derived on write and stored so a reviewer reads one number instead of two
     * that can disagree.
     */
    pose: {
      type: new mongoose.Schema(
        {
          position: {
            x: { type: Number, required: true },
            y: { type: Number, required: true },
            z: { type: Number, required: true },
          },
          target: {
            x: { type: Number, required: true },
            y: { type: Number, required: true },
            z: { type: Number, required: true },
          },
          fov: { type: Number, required: true },
          distance: { type: Number, required: true },
          source: { type: String, enum: ['manual', 'imported'], required: true },
          recordedAt: { type: Date, default: null },
          recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        },
        { _id: false }
      ),
      default: null,
    },

    original: { type: assetSchema, default: () => ({}) },
    /** LEGACY, NO WRITER. Phase 1 wrote a background-removed cutout and a neutral
     *  preview here. Multi-view references keep the original pixels instead, so
     *  nothing writes these any more; they are declared so old rows stay
     *  readable (and deletable) rather than becoming untyped junk. */
    cutout: { type: assetSchema, default: () => ({}) },
    neutral: { type: assetSchema, default: () => ({}) },

    /**
     * WHERE THIS REFERENCE CAME FROM.
     *
     * A row is either its own upload (`type: 'upload'`), one panel cut from a
     * composite sheet (`type: 'panel'`), or a legacy row from before the removal
     * of background removal. `parentId` + `panelIndex` are UNIQUE TOGETHER, which
     * is what makes re-confirming a grid idempotent instead of duplicating views.
     */
    source: {
      type: {
        type: String,
        enum: ['upload', 'panel'],
        default: 'upload',
      },
      /** The composite row this panel was cut from. */
      parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductReferenceImage', default: null },
      panelIndex: { type: Number, default: null },
      /** The layout in force when the panel was cut, kept so the crop is
       *  reproducible from the parent alone (audit trail). */
      grid: {
        columns: { type: Number, default: 0 },
        rows: { type: Number, default: 0 },
        padding: { type: Number, default: 0 },
      },
      /** Normalized box of the panel inside the parent's ORIGINAL frame. */
      box: {
        x: { type: Number, default: 0 },
        y: { type: Number, default: 0 },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
      },
    },

    /**
     * COMPOSITE STATE (parent rows only). Written by the detector, corrected by
     * the administrator, and never trusted to infer a view count at generation
     * time — the panels that actually exist are the source of truth.
     */
    composite: {
      /** The detector (or the administrator) says this image is a grid. */
      detected: { type: Boolean, default: false },
      columns: { type: Number, default: 0 },
      rows: { type: Number, default: 0 },
      confidence: { type: Number, default: null },
      needsCorrection: { type: Boolean, default: false },
      /** Set when a human confirmed or overrode the grid. */
      confirmed: { type: Boolean, default: false },
      confirmedAt: { type: Date, default: null },
      layoutSource: { type: String, default: '' },
      padding: { type: Number, default: 0 },
      panelCount: { type: Number, default: 0 },
      warnings: { type: [String], default: [] },
      notes: { type: [String], default: [] },
    },

    /** True on rows whose `cutout`/`neutral` were written by the removed Phase 1
     *  engine. Read-only history; no new row can acquire it. */
    legacyCutout: { type: Boolean, default: false },

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
// One panel per (parent, index): re-confirming a corrected grid updates the
// existing view instead of cutting a second copy of it.
referenceImageSchema.index(
  { 'source.parentId': 1, 'source.panelIndex': 1 },
  { unique: true, partialFilterExpression: { 'source.parentId': { $type: 'objectId' } } }
);

const ProductReferenceImage = mongoose.model('ProductReferenceImage', referenceImageSchema);
export default ProductReferenceImage;
