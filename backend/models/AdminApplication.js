import mongoose from 'mongoose';

/**
 * Phase 20.6.1 — Admin Application.
 *
 * A public applicant submits an application for ADMINISTRATOR consideration.
 * Submitting creates ONLY this record — never a User, never a credential,
 * never a JWT. The Owner reviews it; approval mints a one-time admin
 * invitation (see models/Invitation.js). Activation is Phase 20.6.2.
 *
 * Lifecycle:
 *   PENDING_REVIEW  →  APPROVED  →  INVITED  →  ACTIVATED
 *         ↓
 *      REJECTED
 *   EXPIRED (invitation TTL passed without activation)
 *   SUBMITTED       (reserved: pre-review intake state; creation starts at
 *                    PENDING_REVIEW because owner review is immediately
 *                    available — the public flow diagram collapses SUBMITTED
 *                    into PENDING_REVIEW)
 */
export const APPLICATION_STATUSES = [
  'SUBMITTED',
  'PENDING_REVIEW',
  'APPROVED',
  'INVITED',
  'ACTIVATED',
  'REJECTED',
  'EXPIRED',
];

const adminApplicationSchema = new mongoose.Schema(
  {
    applicationId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
      maxlength: 20,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 2000,
    },
    background: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 2000,
    },
    // ── Phase 22.4 — client onboarding identity ───────────────────────────
    // The business the applicant wants to run. REQUIRED at submission
    // (validated in adminApplicationController); not schema-required so
    // pre-22.4 dossiers stay readable.
    businessName: {
      type: String,
      trim: true,
      default: '',
      maxlength: 120,
    },
    // Explicit shop address the applicant asked for (optional). Normalized
    // to lowercase at submission; reserved words are rejected there.
    preferredSlug: {
      type: String,
      trim: true,
      default: '',
      maxlength: 64,
    },
    // The SERVER-derived public handle that activation will use for the
    // Workspace (explicit preferredSlug, else slugify(businessName)).
    // Always a valid, non-reserved slug — enforced at submission.
    proposedSlug: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      maxlength: 64,
      index: true,
    },
    status: {
      type: String,
      enum: APPLICATION_STATUSES,
      default: 'PENDING_REVIEW',
      index: true,
    },
    // Owner review record. reviewedByName is denormalized so the UI can show
    // "Approved by <owner>" without joining users on every list render.
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedByName: {
      type: String,
      default: '',
      maxlength: 100,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    // Approval note (optional) or the REQUIRED rejection reason.
    reviewNote: {
      type: String,
      default: '',
      maxlength: 2000,
    },
  },
  { timestamps: true }
);

adminApplicationSchema.index({ email: 1, status: 1 });
adminApplicationSchema.index({ status: 1, createdAt: -1 });

const AdminApplication = mongoose.model('AdminApplication', adminApplicationSchema);
export default AdminApplication;
