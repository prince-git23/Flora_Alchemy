import User from '../models/User.js';
import Invitation from '../models/Invitation.js';
import AdminApplication from '../models/AdminApplication.js';
import StaffEvent from '../models/StaffEvent.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { staffIdFor, initialsOf, roleLabel, roleBadge, relativeTime } from '../utils/staffIdentity.js';

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

    const accountEmails = new Set(admins.map((a) => a.email));

    let rows = [
      ...admins.map((a) => {
        const row = staffRow(a);
        row.kind = 'user';
        row.invitedByName = a.invitedBy ? inviterName.get(String(a.invitedBy)) || '' : '';
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
          expiresAt: i.expiresAt,
        })),
    ];

    const counts = {
      all: rows.length,
      owners: rows.filter((r) => r.isOwner).length,
      active: rows.filter((r) => r.status === 'ACTIVE').length,
      invited: rows.filter((r) => r.status === 'INVITED').length,
      suspended: rows.filter((r) => r.status === 'SUSPENDED').length,
      expired: rows.filter((r) => r.status === 'EXPIRED').length,
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
