import mongoose from 'mongoose';

/**
 * Phase 20.6.1 — one-time staff invitation.
 *
 * Security properties:
 *   · the RAW token is generated with crypto.randomBytes and returned exactly
 *     ONCE, in the response of the operation that creates the invitation;
 *     it is NEVER stored, logged, or re-readable from the API
 *   · only the SHA-256 hash (`tokenHash`) is persisted (unique index), so a
 *     database dump cannot replay invitations
 *   · single-use: consumption happens at activation (Phase 20.6.2) via an
 *     atomic status transition; this phase only creates/reads invitations
 *   · 72-hour TTL (`expiresAt`); readers lazily mark past-due invitations
 *     EXPIRED (see controller)
 *
 * For THIS phase only the `admin` role path is created (owner approval).
 * `handler` is allowed by the model so Phase 20.6.3 reuses it unchanged.
 */
export const INVITATION_STATUSES = [
  'INVITED',
  'ACCEPTED',
  'ACTIVE',
  'SUSPENDED',
  'REVOKED',
  'EXPIRED',
];

export const INVITATION_TTL_HOURS = 72;

const invitationSchema = new mongoose.Schema(
  {
    recipientEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // ── Phase 20.6.3 — invitation dossier metadata ────────────────────────
    // Captured when an admin invites a handler so the landing screen and the
    // staff directory can render a real identity before the account exists.
    // All optional: admin invitations (Phase 20.6.1) carry an application
    // instead and leave these empty.
    recipientName: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    department: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' },
    role: {
      type: String,
      enum: ['admin', 'handler'],
      required: true,
    },
    // The user who authorized this invitation (owner for admin invites).
    inviter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Source application (admin invitations). Null for direct handler invites.
    application: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdminApplication',
      default: null,
      index: true,
    },
    // SHA-256 hex of the raw token. The raw token exists only in the single
    // creation response — never here.
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: INVITATION_STATUSES,
      default: 'INVITED',
      index: true,
    },
    // Set when the invitation is consumed (Phase 20.6.2 activation).
    consumedAt: {
      type: Date,
      default: null,
    },
    // ── Phase 20.6.3 — delivery + revocation audit ────────────────────────
    // Resending mints a NEW token (the old hash is overwritten, so the
    // previously emailed link stops working) and pushes `expiresAt` out.
    lastSentAt: { type: Date, default: null },
    resendCount: { type: Number, default: 0 },
    revokedAt: { type: Date, default: null },
    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    revokeReason: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

/** True when the invitation is past its TTL and not yet consumed. */
invitationSchema.methods.isExpired = function isExpired() {
  return this.status !== 'ACTIVE' && this.expiresAt <= new Date();
};

const Invitation = mongoose.model('Invitation', invitationSchema);
export default Invitation;
