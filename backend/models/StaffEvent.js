import mongoose from 'mongoose';

/**
 * Phase 20.6.4 — minimal staff audit trail.
 *
 * AUDIT FINDING: this project has NO audit/activity infrastructure. Staff
 * lifecycle events were previously only inferable from whatever timestamps
 * happened to exist on a document (createdAt / statusChangedAt / consumedAt),
 * which cannot express "who did what" and disappears when a document is
 * deleted. Notifications are a delivery mechanism, not a ledger: they are
 * per-recipient, mutable (read/unread) and pruned by the client.
 *
 * So this is the MINIMUM addition that makes a real timeline possible: one
 * append-only collection, written at the handful of lifecycle points that
 * matter. It is deliberately NOT a generic system-wide audit log — nothing
 * outside the staff lifecycle writes here, and there is no admin editor for
 * it, so it cannot be mistaken for a compliance ledger.
 *
 * Ordering: `at` is explicit (and indexed) so events sort by when they
 * actually happened, not by insertion time.
 */
export const STAFF_EVENT_TYPES = [
  'INVITATION_CREATED',
  'INVITATION_RESENT',
  'INVITATION_REVOKED',
  'ACCOUNT_ACTIVATED',
  'ACCOUNT_CREATED',
  'LOGIN',
  'SUSPENDED',
  'REACTIVATED',
  'ROLE_CHANGED',
  'PROFILE_UPDATED',
  // Phase 20.6.6 — the owner's review decision on a public application.
  // (The invitation minted by an approval still records INVITATION_CREATED,
  // and activation still records ACCOUNT_ACTIVATED — no parallel types.)
  'ADMIN_APPLICATION_SUBMITTED',
  'ADMIN_APPLICATION_APPROVED',
  'ADMIN_APPLICATION_REJECTED',
];

const staffEventSchema = new mongoose.Schema(
  {
    // The staff member the event is about — a User id once the account
    // exists, otherwise null (pre-activation events key off `invitation`).
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    // Stable badge id (HND-…/ADM-…) captured at write time, so the timeline
    // stays readable even if the account is later removed.
    staffId: { type: String, default: null },
    recipientEmail: { type: String, lowercase: true, trim: true, index: true },
    invitation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invitation',
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: STAFF_EVENT_TYPES,
      required: true,
      index: true,
    },
    // Rendered sentence ("Priya Sharma invited devika.m@… as Handler").
    message: { type: String, trim: true, default: '' },
    // Who caused it (null for self-service actions like a successful login).
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    actorName: { type: String, trim: true, default: '' },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

// The dossier timeline query: everything about one person, newest first.
staffEventSchema.index({ user: 1, at: -1 });

const StaffEvent = mongoose.model('StaffEvent', staffEventSchema);
export default StaffEvent;
