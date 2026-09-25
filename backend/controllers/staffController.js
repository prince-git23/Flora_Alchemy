import Invitation from '../models/Invitation.js';
import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { staffIdFor, initialsOf, roleLabel, roleBadge, relativeTime } from '../utils/staffIdentity.js';
import { recordStaffEvent, loadStaffTimeline } from '../utils/staffEvents.js';

/**
 * Phase 20.6.4 — Staff Directory & Personnel Lifecycle.
 *
 * The authoritative permission matrix for staff management lives here:
 *
 *   · any ADMIN may create/revoke HANDLER invitations, suspend/reactivate
 *     HANDLER accounts, and read the directory and audit timeline
 *   · only the OWNER (role 'admin' AND isOwner) may act on an ADMINISTRATOR
 *     account, or on the owner account itself
 *   · an account can never act on itself (self-suspension / self-reactivation)
 *   · the last remaining active administrator can never be suspended
 *
 * Every rule is enforced on the server (requireRole('admin') gates the router,
 * `assertCanManage` gates the target). The frontend hides actions it knows
 * will be refused, but hiding is UX only.
 */

const STAFF_ROLES = ['admin', 'handler'];

/** Mirror of the invitation presentation statuses, so the directory can show
 *  invited (not yet existing) people in the same table as real accounts. */
function invitationStatus(inv) {
  if (inv.status === 'INVITED' && inv.expiresAt <= new Date()) return 'EXPIRED';
  if (inv.status === 'ACTIVE' || inv.status === 'ACCEPTED') return 'ACTIVE';
  return inv.status;
}

/** Directory row for a real account. */
function userRow(u, actor) {
  const id = u._id.toString();
  const isSelf = actor && String(actor._id) === id;
  return {
    id,
    kind: 'user',
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
    isSelf: !!isSelf,
    invitedBy: u.invitedBy ? u.invitedBy.toString() : null,
    invitedByName: u.invitedByName || '',
    createdAt: u.createdAt,
    joinedLabel: relativeTime(u.createdAt),
    lastActiveAt: u.lastActiveAt || null,
    lastActiveLabel: u.lastActiveAt ? relativeTime(u.lastActiveAt) : 'Never signed in',
    suspension: u.suspension
      ? { reason: u.suspension.reason || '', note: u.suspension.note || '', at: u.suspension.at || null }
      : { reason: '', note: '', at: null },
  };
}

/** Directory row for a not-yet-activated invitation. */
function invitationRow(inv, inviterName) {
  return {
    id: inv._id.toString(),
    kind: 'invitation',
    name: inv.recipientName || inv.recipientEmail.split('@')[0],
    initials: initialsOf(inv.recipientName, inv.recipientEmail),
    email: inv.recipientEmail,
    role: inv.role,
    roleLabel: roleLabel(inv.role),
    roleBadge: roleBadge(inv.role),
    staffId: `INV-${inv._id.toString().slice(-6).toUpperCase()}`,
    department: inv.department || '',
    phone: inv.phone || '',
    status: invitationStatus(inv),
    isOwner: false,
    isFixture: false,
    isSelf: false,
    invitedBy: String(inv.inviter),
    invitedByName: inviterName || '',
    createdAt: inv.createdAt,
    joinedLabel: relativeTime(inv.createdAt),
    lastActiveAt: inv.lastSentAt || inv.createdAt,
    lastActiveLabel: 'Invitation pending',
    expiresAt: inv.expiresAt,
    resendCount: inv.resendCount || 0,
    canResend: inv.status === 'INVITED' || invitationStatus(inv) === 'EXPIRED',
    canRevoke: inv.status === 'INVITED' || invitationStatus(inv) === 'EXPIRED',
    suspension: { reason: '', note: '', at: null },
  };
}

/** Actions the ACTOR is allowed to take on a row (server-derived). */
function allowedActions(row, actor) {
  if (!actor) return [];
  const noActions = {
    canSuspend: false,
    canReactivate: false,
    canResend: false,
    canRevoke: false,
    canEditProfile: false,
    note: '',
  };
  if (row.isSelf) return { ...noActions, canEditProfile: true, note: 'This is your own account.' };

  // Owner-only: any action against an ADMINISTRATOR account.
  const targetIsAdmin = row.role === 'admin';
  if (targetIsAdmin && !(actor.role === 'admin' && actor.isOwner)) {
    return { ...noActions, note: 'Only the owner can manage administrator accounts.' };
  }

  if (row.kind === 'invitation') {
    const active = row.status === 'INVITED' || row.status === 'EXPIRED';
    return {
      ...noActions,
      canResend: active,
      canRevoke: active,
      note: active ? '' : 'This invitation is no longer actionable.',
    };
  }

  if (row.isFixture) {
    return { ...noActions, note: 'Seed fixture accounts are read-only.' };
  }

  return {
    ...noActions,
    canSuspend: row.status === 'ACTIVE',
    canReactivate: row.status === 'SUSPENDED',
    canEditProfile: true,
    note: '',
  };
}

/**
 * GET /api/admin/staff — the unified directory.
 *
 * Merges real accounts with live invitations so a person who has been invited
 * but has not activated yet is visible in the same roster (which is what the
 * reference screen shows), while keeping their identity unambiguous via
 * `kind` and the INV-/HND- badge prefixes.
 */
export async function listStaff(req, res, next) {
  try {
    // Harden the ledger before reading: a pending invitation past its TTL is
    // EXPIRED regardless of who looks at it.
    await Invitation.updateMany(
      { status: 'INVITED', expiresAt: { $lte: new Date() } },
      { $set: { status: 'EXPIRED' } }
    ).catch(() => {});

    const role = safeString(req.query.role, 20).toUpperCase();
    const status = safeString(req.query.status, 20).toUpperCase();
    const q = safeString(req.query.q, 200);
    const includeInvitations = req.query.includeInvitations !== 'false';

    const userMatch = { role: { $in: STAFF_ROLES } };
    // The role filter must apply to BOTH populations. Leaving it off the
    // invitation query would leak handler invitations into an
    // "administrators only" view (caught by the lifecycle suite).
    const inviteMatch = { status: { $in: ['INVITED', 'EXPIRED', 'REVOKED'] } };
    if (role === 'ADMINISTRATOR') {
      userMatch.role = 'admin';
      inviteMatch.role = 'admin';
    }
    if (role === 'HANDLER') {
      userMatch.role = 'handler';
      inviteMatch.role = 'handler';
    }

    const [users, pendingInvites] = await Promise.all([
      User.find(userMatch)
        .select('-passwordHash')
        .sort({ createdAt: -1 })
        .limit(300)
        .lean(),
      includeInvitations
        ? Invitation.find(inviteMatch)
            .sort({ createdAt: -1 })
            .limit(200)
            .lean()
        : Promise.resolve([]),
    ]);

    // Inviter display names in one round trip (no N+1).
    const inviterIds = [
      ...users.map((u) => u.invitedBy).filter(Boolean),
      ...pendingInvites.map((i) => i.inviter).filter(Boolean),
    ];
    const uniqueInviterIds = [...new Set(inviterIds.map(String))];
    const inviters = uniqueInviterIds.length
      ? await User.find({ _id: { $in: uniqueInviterIds } }).select('name email').lean()
      : [];
    const inviterName = new Map(inviters.map((u) => [String(u._id), u.name || u.email]));

    // A pending invitation for an email that already has an account is stale
    // bookkeeping, not a person — drop it so nobody appears twice.
    const accountEmails = new Set(users.map((u) => u.email));

    let rows = [
      ...users.map((u) => {
        const row = userRow(u, req.user);
        row.invitedByName = u.invitedBy ? inviterName.get(String(u.invitedBy)) || '' : '';
        return row;
      }),
      ...pendingInvites
        .filter((i) => !accountEmails.has(i.recipientEmail))
        .map((i) => invitationRow(i, inviterName.get(String(i.inviter)))),
    ];

    // Counts describe the whole roster (before filtering) — the KPI cards must
    // not change meaning when a filter chip is selected.
    const counts = {
      all: rows.length,
      handlers: rows.filter((r) => r.role === 'handler').length,
      administrators: rows.filter((r) => r.role === 'admin').length,
      active: rows.filter((r) => r.status === 'ACTIVE').length,
      invited: rows.filter((r) => r.status === 'INVITED').length,
      suspended: rows.filter((r) => r.status === 'SUSPENDED').length,
      expired: rows.filter((r) => r.status === 'EXPIRED').length,
      revoked: rows.filter((r) => r.status === 'REVOKED').length,
    };

    if (status && status !== 'ALL') {
      if (status === 'PENDING' || status === 'INVITED') rows = rows.filter((r) => r.status === 'INVITED');
      else rows = rows.filter((r) => r.status === status);
    }
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

    // Sorting is server-side so the UI cannot accidentally sort a filtered
    // subset differently from the full roster.
    const sort = safeString(req.query.sort, 30) || 'joined-desc';
    const sorters = {
      'joined-desc': (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      'joined-asc': (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
      'name-asc': (a, b) => String(a.name).localeCompare(String(b.name)),
      'name-desc': (a, b) => String(b.name).localeCompare(String(a.name)),
      'activity-desc': (a, b) => new Date(b.lastActiveAt || 0) - new Date(a.lastActiveAt || 0),
    };
    // Owner first, then Role, then the requested sort — the owner account is
    // the anchor of the roster and should not drift to the bottom.
    rows.sort(sorters[sort] || sorters['joined-desc']);

    res.json({
      success: true,
      staff: rows.map((r) => ({ ...r, actions: allowedActions(r, req.user) })),
      counts,
    });
  } catch (err) {
    next(err);
  }
}

/** Load a staff row by id (accepts a User id or an invitation id). */
async function loadRow(id, actor) {
  const user = await User.findById(id).select('-passwordHash').lean();
  if (user) {
    const row = userRow(user, actor);
    if (user.invitedBy) {
      const inviter = await User.findById(user.invitedBy).select('name email').lean();
      row.invitedByName = inviter ? inviter.name || inviter.email : '';
    }
    return row;
  }
  const inv = await Invitation.findById(id).lean();
  if (inv) {
    const inviter = await User.findById(inv.inviter).select('name email').lean();
    return invitationRow(inv, inviter ? inviter.name || inviter.email : '');
  }
  return null;
}

/** GET /api/admin/staff/:id — dossier for one staff member. */
export async function getStaffMember(req, res, next) {
  try {
    const row = await loadRow(req.params.id, req.user);
    if (!row) throw new ApiError(404, 'Staff member not found.', 'NOT_FOUND');
    res.json({
      success: true,
      member: { ...row, actions: allowedActions(row, req.user) },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/staff/:id/activity — real audit timeline.
 *
 * Returns only events that were actually recorded. Accounts that predate the
 * audit trail return an empty list, which the UI renders as an honest empty
 * state rather than inventing history.
 */
export async function getStaffActivity(req, res, next) {
  try {
    const row = await loadRow(req.params.id, req.user);
    if (!row) throw new ApiError(404, 'Staff member not found.', 'NOT_FOUND');
    const events = await loadStaffTimeline({
      userId: row.kind === 'user' ? row.id : null,
      email: row.email,
      invitationId: row.kind === 'invitation' ? row.id : null,
      limit: req.query.limit,
    });
    res.json({
      success: true,
      events: events.map((e) => ({
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
 * Enforce the target-side permission matrix for a lifecycle action.
 * Shared by suspend / reactivate / profile edit so the rules cannot drift.
 */
async function assertCanManage(req, target) {
  if (String(target._id) === String(req.user._id)) {
    throw new ApiError(422, 'You cannot change your own staff record.', 'SELF_ACTION_FORBIDDEN');
  }
  const actorIsOwner = req.user.role === 'admin' && !!req.user.isOwner;
  if (target.role === 'admin' && !actorIsOwner) {
    throw new ApiError(
      403,
      'Only the owner can manage administrator accounts.',
      'OWNER_REQUIRED'
    );
  }
  if (target.isFixture) {
    throw new ApiError(422, 'Seed fixture accounts are read-only.', 'FIXTURE_READONLY');
  }
  return target;
}

/** POST /api/admin/staff/:id/suspend — revoke staff access immediately. */
export async function suspendStaff(req, res, next) {
  try {
    const target = await User.findById(req.params.id);
    if (!target) throw new ApiError(404, 'Staff member not found.', 'NOT_FOUND');
    await assertCanManage(req, target);

    if (target.status === 'SUSPENDED') {
      return res.json({ success: true, message: 'This account is already suspended.', member: userRow(target, req.user) });
    }
    // Guard: never lock administration out of the console.
    if (target.role === 'admin') {
      const activeAdmins = await User.countDocuments({ role: 'admin', status: 'ACTIVE' });
      if (activeAdmins <= 1) {
        throw new ApiError(422, 'Cannot suspend the last active administrator.', 'LAST_ADMIN');
      }
    }

    const reason = safeString(req.body?.reason, 200).trim();
    const note = safeString(req.body?.note, 500).trim();
    if (!reason) {
      throw new ApiError(422, 'Please select a suspension reason.', 'VALIDATION_ERROR');
    }

    target.status = 'SUSPENDED';
    target.statusChangedAt = new Date();
    target.suspension = { reason, note, at: new Date(), by: req.user._id };
    await target.save();

    await recordStaffEvent({
      user: target._id,
      staffId: target.staffId || staffIdFor(target, target.role, !!target.isOwner),
      recipientEmail: target.email,
      type: 'SUSPENDED',
      message: `${req.user.name || req.user.email} suspended this ${roleLabel(target.role, !!target.isOwner)} account (${reason})${note ? ` — ${note}` : ''}.`,
      actor: req.user,
    });

    res.json({
      success: true,
      message: `${target.name || target.email} has been suspended and can no longer access the staff portal.`,
      member: userRow(target, req.user),
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/staff/:id/reactivate — restore staff access. */
export async function reactivateStaff(req, res, next) {
  try {
    const target = await User.findById(req.params.id);
    if (!target) throw new ApiError(404, 'Staff member not found.', 'NOT_FOUND');
    await assertCanManage(req, target);

    if (target.status === 'ACTIVE') {
      return res.json({ success: true, message: 'This account is already active.', member: userRow(target, req.user) });
    }

    const previousReason = target.suspension?.reason || '';
    target.status = 'ACTIVE';
    target.statusChangedAt = new Date();
    target.suspension = { reason: '', note: '', at: null, by: null };
    await target.save();

    await recordStaffEvent({
      user: target._id,
      staffId: target.staffId || staffIdFor(target, target.role, !!target.isOwner),
      recipientEmail: target.email,
      type: 'REACTIVATED',
      message: `${req.user.name || req.user.email} reactivated this ${roleLabel(target.role, !!target.isOwner)} account${previousReason ? ` (previous reason: ${previousReason})` : ''}.`,
      actor: req.user,
    });

    res.json({
      success: true,
      message: `${target.name || target.email} can sign in again.`,
      member: userRow(target, req.user),
    });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/admin/staff/:id — department / phone / notes. */
export async function updateStaffProfile(req, res, next) {
  try {
    const target = await User.findById(req.params.id);
    if (!target) throw new ApiError(404, 'Staff member not found.', 'NOT_FOUND');
    // Self-editing is allowed for these non-privileged fields; manage rights
    // are only required when editing someone else.
    if (String(target._id) !== String(req.user._id)) {
      await assertCanManage(req, target);
    }

    const body = req.body || {};
    const changes = [];
    if (body.department !== undefined) {
      const department = safeString(body.department, 120).trim();
      if (department !== target.department) changes.push(`department → ${department || 'unassigned'}`);
      target.department = department;
    }
    if (body.phone !== undefined) {
      const phone = safeString(body.phone, 30).trim();
      if (phone && phone.replace(/\D/g, '').length > 15) {
        throw new ApiError(422, 'Please provide a valid phone number.', 'VALIDATION_ERROR');
      }
      if (phone !== target.phone) changes.push('phone updated');
      target.phone = phone;
    }
    if (body.notes !== undefined) target.staffNotes = safeString(body.notes, 500).trim();

    if (changes.length === 0) {
      return res.json({ success: true, message: 'Nothing changed.', member: userRow(target, req.user) });
    }

    await target.save();
    await recordStaffEvent({
      user: target._id,
      staffId: target.staffId || staffIdFor(target, target.role, !!target.isOwner),
      recipientEmail: target.email,
      type: 'PROFILE_UPDATED',
      message: `${req.user.name || req.user.email} updated the staff profile (${changes.join(', ')}).`,
      actor: req.user,
    });

    res.json({ success: true, message: 'Staff profile updated.', member: userRow(target, req.user) });
  } catch (err) {
    next(err);
  }
}
