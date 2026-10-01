import mongoose from 'mongoose';

/**
 * Phase 22.2 — WORKSPACE (tenant) core.
 *
 * A Workspace is the canonical tenant boundary of the platform: the shop,
 * its settings, its catalogue, its orders, its people. Phase 21 shipped a
 * multi-PORTAL architecture (owner/admin/staff) over a single shared data
 * set; Phase 22 moves that shared set behind an explicit workspace.
 *
 * PHASE 22.3 STATUS (operational isolation enforced):
 *   · membership is recorded on `User.workspaceId` (see models/User.js);
 *   · every staff-facing router mounts a workspace gate and every
 *     operational query filters by workspaceId (legacy unattributed rows
 *     stay visible to all workspaces until the Phase 22.5 backfill);
 *   · a platform with zero Workspace documents runs in compat mode and
 *     behaves exactly like Phase 21 (docs/MULTI-TENANT.md).
 *
 * Invariants owned by this phase:
 *   · `slug` is the canonical, externally-stable tenant handle — lowercase,
 *     URL-safe, globally unique (slugs are echoed in URLs and audit text).
 *   · a Workspace is created SERVER-SIDE ONLY (owner activation / onboarding);
 *     there is no public or operator endpoint that creates one, and no
 *     request body can supply its id (the body scrub in server.js removes
 *     any client-supplied workspaceId before a controller sees it).
 *   · `status` mirrors the account-status vocabulary: a SUSPENDED workspace
 *     makes every member request fail closed (403 WORKSPACE_SUSPENDED) on
 *     the very next request — the gates re-read the workspace per request.
 *   · the platform itself has NO workspace — the owner's account and the
 *     pre-migration data are unscoped (`workspaceId` absent) until the
 *     owner deliberately runs the Phase 22.5 backfill with an explicit
 *     name/slug. Nothing invents a production displayName or slug.
 */
export const WORKSPACE_STATUSES = ['ACTIVE', 'SUSPENDED', 'PENDING'];

const workspaceSchema = new mongoose.Schema(
  {
    // Canonical tenant handle (URL-safe). Required on creation; never
    // derived automatically from a display name. Phase 22.4 — the ONLY
    // creation path is the admin-invitation activation transaction, which
    // resolves an explicit validated slug (application proposedSlug /
    // preferredSlug / recipient suggestion) — see
    // services/workspaceProvisioningService.js.
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 64,
      index: true,
    },
    // Human label shown in the portal header / owner console.
    displayName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    status: {
      type: String,
      enum: WORKSPACE_STATUSES,
      default: 'ACTIVE',
      index: true,
    },
    statusChangedAt: { type: Date, default: null },
    // The primary owner/administrator for support and ownership transfer.
    primaryAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    // Free-text note for the operator (never rendered to customers).
    notes: { type: String, trim: true, default: '' },
    isFixture: { type: Boolean, default: false },
    // Phase 22.6 — designate the platform's CANONICAL BOOTSTRAP workspace
    // (the one-time migration target holding the real business). An ACTIVE,
    // UNCLAIMED bootstrap workspace is CLAIMED by the first real
    // administrator activation instead of provisioning a duplicate empty
    // tenant. A genuinely new client business still gets its own Workspace.
    isBootstrap: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Read patterns: "the member list of one workspace", "is this slug free?".
workspaceSchema.index({ createdAt: -1 });

const Workspace = mongoose.model('Workspace', workspaceSchema);
export default Workspace;
