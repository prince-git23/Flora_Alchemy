import mongoose from 'mongoose';

/**
 * User = authentication identity (email + passwordHash + role).
 * Customer = business profile. A User with role 'customer' links to a
 * Customer via customerId. Handlers/admins have no Customer profile.
 */
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['customer', 'handler', 'admin'],
      default: 'customer',
      index: true,
    },
    name: {
      type: String,
      trim: true,
      default: '',
    },
    // Only set when role === 'customer'
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
      index: true,
    },
    // ── Phase 22.2 — tenant membership ─────────────────────────────────
    // The workspace this identity belongs to. DELIBERATELY HAS NO DEFAULT:
    // an absent field means "unscoped" — owner accounts, customer accounts
    // and every document created before the Phase 22.5 backfill. It is
    // server-assigned only (owner activation, invitation activation or the
    // guarded backfill script); a request body can never set it, because
    // server.js scrubs a client-supplied `workspaceId` before any
    // controller runs. Sparse index: unscoped rows are never indexed.
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      index: true,
      sparse: true,
    },
    // Operator account status. Suspended accounts are rejected at login AND
    // on every protected request (authMiddleware checks it server-side).
    status: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED'],
      default: 'ACTIVE',
    },
    statusChangedAt: {
      type: Date,
      default: null,
    },
    isFixture: {
      type: Boolean,
      default: false,
      // Seed/demo accounts are real documents but are flagged so they are
      // never presented to normal users as their own identity.
    },
    // Phase 20.6.1 — the Owner is an ADMINISTRATOR with ownership privileges,
    // not a fourth role. The role enum stays customer/handler/admin; owner-only
      // capabilities (reviewing admin applications) are gated by requireOwner
    // (role === 'admin' AND isOwner). Existing admins are unaffected
    // (default false).
    isOwner: {
      type: Boolean,
      default: false,
      index: true,
    },
    // ── Phase 20.6.3 / 20.6.4 — staff lifecycle fields ──────────────────
    // All optional and defaulted, so accounts created before this phase (and
    // customer accounts) are unaffected.
    //
    // `staffId` is the stable human-readable badge identifier shown in the
    // staff directory (HND-1A2B3C / ADM-… / OWN-…). It is DERIVED from the
    // document id at creation time (see utils/staffIdentity.js) and stored so
    // it never changes even if derivation rules evolve.
    staffId: {
      type: String,
      default: null,
      index: true,
    },
    // Department / atelier responsibility. Free text chosen by the inviting
    // admin (the reference UI offers a fixed list, but the server does not
    // constrain it to those values).
    department: {
      type: String,
      trim: true,
      default: '',
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    // Internal onboarding note captured with the invitation.
    staffNotes: {
      type: String,
      trim: true,
      default: '',
    },
    // Who issued the invitation that created this account (audit trail).
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Last successful sign-in — real "Last Active" for the staff dossier.
    lastActiveAt: {
      type: Date,
      default: null,
    },
    // Suspension audit trail (status itself stays on `status` above).
    suspension: {
      reason: { type: String, trim: true, default: '' },
      note: { type: String, trim: true, default: '' },
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    // ── Granular staff access (role template + explicit permissions) ────
    // ROLE = permission bundle, PERMISSIONS = actual authority.
    //
    // `staffRole` names the template an administrator picked (fulfillment,
    // inventory, customer_support, catalog_operations, full_workspace or
    // custom). Presentation/metadata only: the AUTHORITY is `permissions`.
    //
    // `permissions` is the explicit list the middleware enforces. It has NO
    // default on purpose — an ABSENT array means "this handler predates
    // granular permissions" and resolves to full workspace access (the
    // migration rule in utils/permissions.js). An EMPTY array means "holds
    // nothing", so a removal an administrator saves is enforceable on the very
    // next request (protect re-reads this document per request — no stale JWT).
    // Only admin/owner surfaces write these; a client body can never set them
    // (the staff access route is the only writer, and it is admin-gated).
    staffRole: {
      type: String,
      default: null,
    },
    permissions: {
      type: [String],
      default: undefined,
    },
    accessUpdatedAt: {
      type: Date,
      default: null,
    },
    accessUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        return ret;
      },
    },
  }
);

// Phase 22.5 — workspace staff-directory reads.
userSchema.index({ workspaceId: 1, role: 1, status: 1 });

const User = mongoose.model('User', userSchema);
export default User;
