import User from '../models/User.js';
import Invitation from '../models/Invitation.js';
import AdminApplication from '../models/AdminApplication.js';
import StaffEvent from '../models/StaffEvent.js';
import Workspace from '../models/Workspace.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { staffIdFor, initialsOf, roleLabel, roleBadge, relativeTime } from '../utils/staffIdentity.js';
import { recordStaffEvent } from '../utils/staffEvents.js';
import { cacheInvalidatePrefix } from '../utils/publicCache.js';

/**
 * Phase 21.2 — OWNER PORTAL API.
 *
 * Owner-only surfaces deliberately live behind `protect + requireOwner`
 * (see routes/ownerRoutes.js): an administrator without the isOwner
 * designation is refused by the middleware before any of this runs.
 *
 * Everything returned is REAL: counts come from the live collections, and the
 * activity feed reads the same StaffEvent audit trail the staff directory uses.
 * No demo names, no invented numbers, no fabricated security vocabulary.
 */

/** Shape a staff row for the owner-facing directories. */
function staffRow(u) {
  return {
    id: u._id.toString(),
    name: u.name || u.email.split('@')[0],
    initials: initialsOf(u.name, u.email),
    email: u.email,
    role: u.role,
    roleLabel: roleLabel(u.role, !!u.isOwner),
    roleBadge: roleBadge(u.role, !!u.isOwner),
    staffId: u.staffId || staffIdFor(u, u.role, !!u.isOwner),
    department: u.department || '',
    phone: u.phone || '',
    status: u.status || 'ACTIVE',
    isOwner: !!u.isOwner,
    isFixture: !!u.isFixture,
    joinedAt: u.createdAt,
    joinedLabel: relativeTime(u.createdAt),
    lastActiveAt: u.lastActiveAt || null,
    lastActiveLabel: u.lastActiveAt ? relativeTime(u.lastActiveAt) : 'Never signed in',
    invitedByName: u.invitedByName || '',
  };
}

/** Display name for a person reference (inviter / actor). */
function nameOf(u) {
  return u ? u.name || u.email : '';
}

/** Honest expiry label for a not-yet-activated invitation. */
function expiresLabel(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const ms = d.getTime() - Date.now();
  if (ms <= 0) {
    return `Expired ${new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`;
  }
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return `Expires in ${Math.max(1, Math.floor(ms / 60000))}m`;
  if (hours < 48) return `Expires in ${hours}h`;
  return `Expires ${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`;
}

/**
 * GET /api/owner/overview — the executive KPI bundle.
 *
 * One round trip per metric, run concurrently. `counts` and `kpis` carry the
 * same numbers under stable names so the dashboard and any future consumer
 * agree.
 */
export async function getOwnerOverview(req, res, next) {
  try {
    const [
      appCounts,
      adminTotal,
      adminActive,
      adminSuspended,
      handlerTotal,
      handlerActive,
      handlerSuspended,
      pendingInvites,
      recentEvents,
    ] = await Promise.all([
      AdminApplication.aggregate([
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
      User.countDocuments({ role: 'admin' }),
      User.countDocuments({ role: 'admin', status: { $ne: 'SUSPENDED' } }),
      User.countDocuments({ role: 'admin', status: 'SUSPENDED' }),
      User.countDocuments({ role: 'handler' }),
      User.countDocuments({ role: 'handler', status: { $ne: 'SUSPENDED' } }),
      User.countDocuments({ role: 'handler', status: 'SUSPENDED' }),
      Invitation.countDocuments({ status: 'INVITED', expiresAt: { $gt: new Date() } }),
      StaffEvent.find({}).sort({ at: -1 }).limit(12).lean(),
    ]);

    const byStatus = {};
    for (const row of appCounts) byStatus[row._id] = row.n;
    const applications = {
      all: Object.values(byStatus).reduce((a, b) => a + b, 0),
      pending: (byStatus.PENDING_REVIEW || 0) + (byStatus.SUBMITTED || 0),
      approved: byStatus.APPROVED || 0,
      rejected: byStatus.REJECTED || 0,
      invited: byStatus.INVITED || 0,
      activated: byStatus.ACTIVATED || 0,
    };

    res.json({
      success: true,
      overview: {
        applications,
        administrators: { total: adminTotal, active: adminActive, suspended: adminSuspended },
        handlers: { total: handlerTotal, active: handlerActive, suspended: handlerSuspended },
        pendingInvitations: pendingInvites,
      },
      activity: recentEvents.map((e) => ({
        id: e._id.toString(),
        type: e.type,
        message: e.message,
        actorName: e.actorName || '',
        at: e.at,
        atLabel: relativeTime(e.at),
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/owner/administrators — the Administrators Directory.
 *
 * Returns every administrator account (owner included, flagged), plus live
 * administrator invitations that have not produced an account yet. Optional
 * `q` search and `status` filter. This is the owner's view of "who holds the
 * keys"; it is intentionally owner-only even though staff management is also
 * reachable by administrators for handlers.
 */
export async function listAdministrators(req, res, next) {
  try {
    // Keep the ledger honest before reading it.
    await Invitation.updateMany(
      { status: 'INVITED', expiresAt: { $lte: new Date() } },
      { $set: { status: 'EXPIRED' } }
    ).catch(() => {});

    const q = safeString(req.query.q, 200);
    const status = safeString(req.query.status, 20).toUpperCase();

    const [admins, invites] = await Promise.all([
      User.find({ role: 'admin' }).select('-passwordHash').sort({ isOwner: -1, createdAt: 1 }).lean(),
      Invitation.find({ role: 'admin', status: { $in: ['INVITED', 'EXPIRED', 'REVOKED'] } })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);

    const inviterIds = [
      ...admins.map((a) => a.invitedBy).filter(Boolean),
      ...invites.map((i) => i.inviter).filter(Boolean),
    ];
    const uniqueInviterIds = [...new Set(inviterIds.map(String))];
    const inviters = uniqueInviterIds.length
      ? await User.find({ _id: { $in: uniqueInviterIds } }).select('name email').lean()
      : [];
    const inviterName = new Map(inviters.map((u) => [String(u._id), nameOf(u)]));

    // Phase 22.4 — the directory answers "which business does this
    // administrator run?" in the same round trip: the workspace each
    // activated admin owns, plus the ACTIVATED application that produced
    // the account (for the "View application" action).
    const workspaceIds = [...new Set(admins.map((a) => a.workspaceId).filter(Boolean).map(String))];
    const [workspaces, activatedApplications] = await Promise.all([
      workspaceIds.length
        ? Workspace.find({ _id: { $in: workspaceIds } }).select('slug displayName status').lean()
        : Promise.resolve([]),
      AdminApplication.find({ email: { $in: [...new Set(admins.map((a) => a.email))] }, status: 'ACTIVATED' })
        .select('email applicationId businessName proposedSlug')
        .lean(),
    ]);
    const workspaceById = new Map(workspaces.map((w) => [String(w._id), w]));
    const applicationByEmail = new Map(activatedApplications.map((a) => [a.email, a]));

    const accountEmails = new Set(admins.map((a) => a.email));

    let rows = [
      ...admins.map((a) => {
        const row = staffRow(a);
        row.kind = 'user';
        row.invitedByName = a.invitedBy ? inviterName.get(String(a.invitedBy)) || '' : '';
        const ws = a.workspaceId ? workspaceById.get(String(a.workspaceId)) : null;
        row.workspace = ws
          ? { id: String(ws._id), slug: ws.slug, name: ws.displayName, status: ws.status }
          : null;
        const sourceApp = applicationByEmail.get(a.email);
        // Same convention as invitation rows: the dossier's ObjectId string,
        // so the UI can deep-link /owner/applications?id=…
        row.applicationId = sourceApp ? String(sourceApp._id) : null;
        row.applicationRef = sourceApp ? sourceApp.applicationId : null;
        row.businessName = sourceApp ? sourceApp.businessName || '' : (ws ? ws.displayName : '');
        return row;
      }),
      ...invites
        .filter((i) => !accountEmails.has(i.recipientEmail))
        .map((i) => ({
          id: i._id.toString(),
          kind: 'invitation',
          name: i.recipientName || i.recipientEmail.split('@')[0],
          initials: initialsOf(i.recipientName, i.recipientEmail),
          email: i.recipientEmail,
          role: 'admin',
          roleLabel: 'Administrator',
          roleBadge: 'ADMINISTRATOR',
          staffId: `INV-${i._id.toString().slice(-6).toUpperCase()}`,
          department: i.department || '',
          phone: i.phone || '',
          status: i.status === 'INVITED' && i.expiresAt <= new Date() ? 'EXPIRED' : i.status,
          isOwner: false,
          isFixture: false,
          joinedAt: i.createdAt,
          joinedLabel: relativeTime(i.createdAt),
          lastActiveAt: i.lastSentAt || i.createdAt,
          lastActiveLabel: 'Invitation pending',
          invitedByName: inviterName.get(String(i.inviter)) || '',
          applicationId: i.application ? String(i.application) : null,
          // Phase 22.4 — approved business identity this invitation will
          // provision (no Workspace exists yet; status is pending).
          workspace: i.workspaceSlug || i.workspaceName
            ? { id: null, slug: i.workspaceSlug || '', name: i.workspaceName || '', status: 'PENDING' }
            : null,
          businessName: i.workspaceName || '',
          expiresAt: i.expiresAt,
          expiresLabel: expiresLabel(i.expiresAt),
          resendCount: i.resendCount || 0,
          // Server-derived lifecycle rights for this row (Phase 21.4). An
          // invitation dossier must expose resend/revoke only while the link is
          // still actionable, mirroring `allowedActions` in staffController so
          // the UI never offers a control the backend would refuse.
          actions: (() => {
            const live = i.status === 'INVITED' || i.status === 'EXPIRED';
            return {
              canSuspend: false,
              canReactivate: false,
              canResend: live,
              canRevoke: live,
              canEditProfile: false,
              note: live ? '' : 'This invitation is no longer actionable.',
            };
          })(),
        })),
    ];

    // Phase 21.4 — the Administrators Directory KPI row needs the two
    // owner-side queues that gate administrator creation: applications still
    // awaiting review, and administrator invitations still live. Both are real
    // counts against the live collections so the directory is honest in ONE
    // request instead of stitching three endpoints together in the UI.
    const [pendingApplications, pendingInvitations] = await Promise.all([
      AdminApplication.countDocuments({ status: { $in: ['SUBMITTED', 'PENDING_REVIEW'] } }),
      Invitation.countDocuments({ role: 'admin', status: 'INVITED', expiresAt: { $gt: new Date() } }),
    ]);

    const counts = {
      all: rows.length,
      owners: rows.filter((r) => r.isOwner).length,
      active: rows.filter((r) => r.status === 'ACTIVE').length,
      invited: rows.filter((r) => r.status === 'INVITED').length,
      suspended: rows.filter((r) => r.status === 'SUSPENDED').length,
      expired: rows.filter((r) => r.status === 'EXPIRED').length,
      pendingApplications,
      pendingInvitations,
    };

    if (status && status !== 'ALL') rows = rows.filter((r) => r.status === status);
    if (q) {
      const regex = new RegExp(escapeRegExp(q), 'i');
      rows = rows.filter(
        (r) =>
          regex.test(r.name) ||
          regex.test(r.email) ||
          regex.test(r.staffId) ||
          regex.test(r.department)
      );
    }

    res.json({ success: true, administrators: rows, counts });
  } catch (err) {
    next(err);
  }
}

/**
 * PHASE 1 — OWNER SHOP GOVERNANCE.
 *
 * The marketplace needs exactly one platform-level control over a Shop's
 * lifecycle: the owner can SEE every Workspace/Shop and can SUSPEND or
 * REACTIVATE it. That is the whole surface.
 *
 * Deliberately NOT here (governance-only, per the phase brief): the owner
 * never manages inventory, never processes orders, never edits a shop's
 * catalogue and never acts as shop staff. Those surfaces are workspace-scoped
 * and answer 403 WORKSPACE_REQUIRED to the owner by design
 * (middleware/workspaceMiddleware.js).
 *
 * Every status change is server-authorized (`protect + requireOwner` on the
 * router) and recorded in the staff audit trail. Suspension takes effect
 * immediately: the public reads resolve shop status LIVE on every request, and
 * the public catalogue cache is invalidated here as a second belt so a cached
 * listing can never outlive a suspension.
 */

/** The owner-facing Shop row: identity + lifecycle + primary administrator. */
function shopRow(workspace, primaryAdmin) {
  return {
    id: String(workspace._id),
    slug: workspace.slug,
    displayName: workspace.displayName,
    status: workspace.status,
    statusChangedAt: workspace.statusChangedAt || null,
    isBootstrap: !!workspace.isBootstrap,
    createdAt: workspace.createdAt || null,
    createdLabel: workspace.createdAt ? relativeTime(workspace.createdAt) : '',
    primaryAdmin: primaryAdmin
      ? {
          id: String(primaryAdmin._id),
          name: primaryAdmin.name || primaryAdmin.email.split('@')[0],
          email: primaryAdmin.email,
          status: primaryAdmin.status || 'ACTIVE',
        }
      : null,
    actions: {
      canSuspend: workspace.status === 'ACTIVE',
      canReactivate: workspace.status !== 'ACTIVE',
    },
  };
}

/**
 * GET /api/owner/shops — every Workspace/Shop with its lifecycle status and
 * primary administrator association. Read-only; no catalogue, order or
 * inventory data is joined (the owner is a governance identity).
 */
export async function listShops(req, res, next) {
  try {
    const q = safeString(req.query.q, 200);
    const status = safeString(req.query.status, 20).toUpperCase();

    const filter = {};
    if (status && status !== 'ALL') filter.status = status;
    if (q) {
      const regex = new RegExp(escapeRegExp(q), 'i');
      filter.$or = [{ displayName: regex }, { slug: regex }];
    }

    const workspaces = await Workspace.find(filter)
      .sort({ displayName: 1, slug: 1 })
      .limit(500)
      .lean();

    // Primary admin association in ONE round trip (no per-row query).
    const adminIds = [...new Set(workspaces.map((w) => w.primaryAdminId).filter(Boolean).map(String))];
    const admins = adminIds.length
      ? await User.find({ _id: { $in: adminIds } }).select('name email status').lean()
      : [];
    const adminById = new Map(admins.map((a) => [String(a._id), a]));

    const shops = workspaces.map((w) =>
      shopRow(w, w.primaryAdminId ? adminById.get(String(w.primaryAdminId)) : null)
    );

    const counts = {
      all: shops.length,
      active: shops.filter((s) => s.status === 'ACTIVE').length,
      suspended: shops.filter((s) => s.status === 'SUSPENDED').length,
      pending: shops.filter((s) => s.status === 'PENDING').length,
    };

    res.json({ success: true, shops, counts });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/owner/shops/:slug/suspend — take a Shop out of public discovery.
 *
 * Idempotent by construction: the update is conditional on the CURRENT status,
 * so a double-click or a retry cannot flip a reactivated shop back. The public
 * catalogue cache is invalidated after the write, and the public reads resolve
 * status live anyway, so the shop disappears on the very next request.
 */
export async function suspendShop(req, res, next) {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    const workspace = await Workspace.findOne({ slug }).select('slug displayName status isBootstrap').lean();
    if (!workspace) {
      throw new ApiError(404, 'Shop not found.', 'SHOP_NOT_FOUND');
    }
    if (workspace.status === 'ACTIVE') {
      await Workspace.updateOne(
        { _id: workspace._id, status: 'ACTIVE' },
        { $set: { status: 'SUSPENDED', statusChangedAt: new Date() } }
      );
      cacheInvalidatePrefix('products:');
      cacheInvalidatePrefix('collections:');
      await recordStaffEvent({
        type: 'SUSPENDED',
        message: `Owner suspended the shop "${workspace.displayName}" (/shops/${workspace.slug}).`,
        actor: req.user,
        workspaceId: workspace._id,
      });
    }
    const updated = await Workspace.findById(workspace._id).lean();
    res.json({ success: true, shop: shopRow(updated, null) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/owner/shops/:slug/reactivate — return a Shop to public discovery. */
export async function reactivateShop(req, res, next) {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    const workspace = await Workspace.findOne({ slug }).select('slug displayName status isBootstrap').lean();
    if (!workspace) {
      throw new ApiError(404, 'Shop not found.', 'SHOP_NOT_FOUND');
    }
    if (workspace.status !== 'ACTIVE') {
      await Workspace.updateOne(
        { _id: workspace._id, status: { $ne: 'ACTIVE' } },
        { $set: { status: 'ACTIVE', statusChangedAt: new Date() } }
      );
      cacheInvalidatePrefix('products:');
      cacheInvalidatePrefix('collections:');
      await recordStaffEvent({
        type: 'REACTIVATED',
        message: `Owner reactivated the shop "${workspace.displayName}" (/shops/${workspace.slug}).`,
        actor: req.user,
        workspaceId: workspace._id,
      });
    }
    const updated = await Workspace.findById(workspace._id).lean();
    res.json({ success: true, shop: shopRow(updated, null) });
  } catch (err) {
    next(err);
  }
}
