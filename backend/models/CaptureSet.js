import mongoose from 'mongoose';

/**
 * 3D STUDIO — PHASE 11 — ONE capture-set record.
 *
 * WHAT IT IS
 * ----------
 * The set-level document beside a product's reference images: the capture
 * profile (how the photographs were taken), the last validation the server
 * performed (which views exist, which are missing, what is suspicious, and what
 * each ENGINE would say about it), and an APPEND-ONLY history of explicit
 * submissions to a reconstruction engine.
 *
 * WHY IT IS NOT A FIELD ON ProductReferenceImage
 * ----------------------------------------------
 * Coverage, duplicates and pose consistency are properties of the SET, not of a
 * single photograph. Coverage is also ENGINE-SPECIFIC: the same set can be
 * valid for an engine that accepts unposed photographs and invalid for one that
 * requires poses. A per-row field could only store one row's opinion.
 *
 * WHY IT IS NOT THE JOB RECORD EITHER
 * -----------------------------------
 * A capture set exists BEFORE any engine may run, and exists even when no
 * provider is configured. Generation jobs are executions; a set is the input
 * contract. Keeping them apart is what lets the studio say "this set is
 * incomplete" without pretending a failed job is the reason.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * Uploading an image never creates, validates or submits a set. `submissions`
 * is written ONLY by the explicit submit path, and only appends — so a later
 * edit to the set can never rewrite what was actually sent.
 *
 * TENANCY
 * -------
 * `workspaceId` is server-written from the resolved session workspace, exactly
 * like ProductReferenceImage; every read is filtered by it and a mismatch is a
 * 404. `draftKey` values are accepted only when the caller already owns
 * reference rows under that key in the same workspace.
 */

const vectorSchema = new mongoose.Schema(
  {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    z: { type: Number, default: 0 },
  },
  { _id: false }
);

const poseSnapshotSchema = new mongoose.Schema(
  {
    position: { type: vectorSchema, default: null },
    target: { type: vectorSchema, default: null },
    fov: { type: Number, default: null },
    distance: { type: Number, default: null },
    source: { type: String, default: '' },
  },
  { _id: false }
);

const profileSchema = new mongoose.Schema(
  {
    /** Free-text rig description ("tripod, 1.2 m, 40 mm equivalent"). */
    rig: { type: String, default: '' },
    camera: { type: String, default: '' },
    lens: { type: String, default: '' },
    /** Metres. Recorded, never inferred from the photographs. */
    distanceMetres: { type: Number, default: null },
    /** Degrees, vertical. */
    fovDegrees: { type: Number, default: null },
    background: {
      type: String,
      enum: ['', 'plain-seamless', 'transparent', 'studio-white', 'other'],
      default: '',
    },
    lighting: { type: String, default: '' },
    notes: { type: String, default: '' },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false }
);

const issueSchema = new mongoose.Schema(
  {
    code: { type: String, default: '' },
    message: { type: String, default: '' },
    referenceId: { type: String, default: '' },
    view: { type: String, default: '' },
  },
  { _id: false }
);

const coverageSchema = new mongoose.Schema(
  {
    view: { type: String, default: '' },
    required: { type: Boolean, default: false },
    recommended: { type: Boolean, default: false },
    present: { type: Boolean, default: false },
    ids: { type: [String], default: [] },
  },
  { _id: false }
);

const engineVerdictSchema = new mongoose.Schema(
  {
    engineId: { type: String, default: '' },
    label: { type: String, default: '' },
    installed: { type: Boolean, default: false },
    enabled: { type: Boolean, default: false },
    valid: { type: Boolean, default: false },
    missingViews: { type: [String], default: [] },
    recommendedMissing: { type: [String], default: [] },
    posesRecorded: { type: Number, default: 0 },
    posesUsable: { type: Boolean, default: false },
    selectedImages: { type: [String], default: [] },
    unusedViews: { type: Number, default: 0 },
    maxInputs: { type: Number, default: 0 },
    /** Stored as `issues`, NOT `errors`: `errors` is a reserved Mongoose schema
     *  pathname that shadows `Document#errors`. The API projects it back as
     *  `errors` so the client vocabulary stays stable. */
    issues: { type: [issueSchema], default: [] },
    warnings: { type: [issueSchema], default: [] },
  },
  { _id: false }
);

const inputSnapshotSchema = new mongoose.Schema(
  {
    referenceId: { type: String, default: '' },
    viewAngle: { type: String, default: '' },
    sha256: { type: String, default: '' },
    order: { type: Number, default: 0 },
    hasPose: { type: Boolean, default: false },
    pose: { type: poseSnapshotSchema, default: null },
  },
  { _id: false }
);

/**
 * ONE submission. Append-only: nothing in this path ever updates a previous
 * entry, so "what did we send, in what order, to which engine, at what time"
 * stays answerable after the set is edited, re-validated or archived.
 */
const submissionSchema = new mongoose.Schema(
  {
    at: { type: Date, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    engineId: { type: String, default: '' },
    engineLabel: { type: String, default: '' },
    /** 'single_view' | 'multi_view' — restated, never inferred later. */
    inputMode: { type: String, default: 'single_view' },
    inputs: { type: [inputSnapshotSchema], default: [] },
    inputIds: { type: [String], default: [] },
    viewsSent: { type: Number, default: 0 },
    unusedViews: { type: Number, default: 0 },
    /** Readable digest of the exact input set + order. */
    payloadFingerprint: { type: String, default: '' },
    /** The provider's own handle, once the adapter confirmed acceptance. */
    providerTaskId: { type: String, default: '' },
    jobId: { type: String, default: '' },
    outcome: {
      type: String,
      enum: ['requested', 'accepted', 'timeout', 'failed'],
      default: 'requested',
    },
    note: { type: String, default: '' },
  },
  { _id: true }
);

const captureSetSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      index: true,
      sparse: true,
    },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true, sparse: true },
    productSlug: { type: String, default: '', index: true, sparse: true },
    /** The create-product window, before a slug exists. */
    draftKey: { type: String, default: '', index: true, sparse: true },

    /**
     * The lifecycle. Transitions are enforced in
     * `services/captureSetService.js:transition()` — a client can never move a
     * set by sending a status, because no route accepts one.
     */
    status: {
      type: String,
      enum: ['draft', 'collecting', 'validated', 'submitted', 'processing', 'completed', 'failed', 'archived'],
      default: 'draft',
      index: true,
    },

    profile: { type: profileSchema, default: () => ({}) },

    /** The engine the operator last validated against. Not authorisation to run. */
    engineId: { type: String, default: '' },

    /**
     * The last validation this SERVER performed. Never trusted instead of a
     * fresh measurement — `GET` recomputes and reports live; this copy exists so
     * a submission is auditable after the references change.
     */
    validation: {
      complete: { type: Boolean, default: false },
      checkedAt: { type: Date, default: null },
      missing: { type: [String], default: [] },
      /** `errors` is reserved in Mongoose; stored as `issues`, projected back. */
      issues: { type: [issueSchema], default: [] },
      warnings: { type: [issueSchema], default: [] },
      coverage: { type: [coverageSchema], default: [] },
      counts: { type: mongoose.Schema.Types.Mixed, default: {} },
      engines: { type: [engineVerdictSchema], default: [] },
      referenceIds: { type: [String], default: [] },
    },

    /** APPEND-ONLY. Written only by the explicit submit path. */
    submissions: { type: [submissionSchema], default: [] },

    /** One active job at a time; a second submit is refused while it is set. */
    activeJobId: { type: String, default: '' },
    failure: {
      code: { type: String, default: '' },
      message: { type: String, default: '' },
      at: { type: Date, default: null },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    archivedAt: { type: Date, default: null },
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
        // The last submission is the one a reviewer cares about; the full
        // history stays available under `submissions`.
        ret.lastSubmission = Array.isArray(ret.submissions) && ret.submissions.length > 0
          ? ret.submissions[ret.submissions.length - 1]
          : null;
        return ret;
      },
    },
  }
);

// One set per product / per draft inside a workspace. Partial so an empty slug
// on a draft row cannot collide with every other draft.
captureSetSchema.index(
  { workspaceId: 1, productSlug: 1 },
  { unique: true, partialFilterExpression: { productSlug: { $type: 'string', $gt: '' } } }
);
captureSetSchema.index(
  { workspaceId: 1, draftKey: 1 },
  { unique: true, partialFilterExpression: { draftKey: { $type: 'string', $gt: '' } } }
);

const CaptureSet = mongoose.model('CaptureSet', captureSetSchema);
export default CaptureSet;
