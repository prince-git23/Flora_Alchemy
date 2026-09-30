import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { getWorkspaceId, requestScope } from '../utils/tenancy.js';

/**
 * Admin Operator Management — real backend-backed user CRUD.
 *
 * Only admins can manage operators. Handlers are read-only.
 * Password hashes are NEVER exposed.
 *
 * Phase 21 — this surface enforces the SAME matrix as staffController:
 *   any admin may manage HANDLER accounts; only the OWNER (role admin +
 *   isOwner) may act on ADMINISTRATOR/owner accounts (create, promote,
 *   suspend, demote, delete). Self-action stays refused (422) first.
 */

/** Owner-gate mirror of staffController.assertCanManage (minus self/fixture). */
function assertOwnerMayManageAdministrator(req, target) {
  const actorIsOwner = req.user.role === 'admin' && !!req.user.isOwner;
  if (target.role === 'admin' && !actorIsOwner) {
    throw new ApiError(403, 'Only the owner can manage administrator accounts.', 'OWNER_REQUIRED');
  }
}

export async function listOperators(req, res, next) {
  try {
    const { role, status } = req.query;
    const q = safeString(req.query.q, 200);
    const match = { role: { $in: ['admin', 'handler'] } };
    if (role && role !== 'ALL') {
      match.role = role === 'ADMINISTRATOR' ? 'admin' : 'handler';
    }
    if (q) {
      const regex = new RegExp(escapeRegExp(q), 'i');
      match.$or = [{ name: regex }, { email: regex }];
    }
    // Operators are members: the owner (platform scope) sees every account,
    // a workspace's admins see only their own workspace plus legacy rows.
    const users = await User.find({ ...requestScope(req), ...match })
      .select('-passwordHash')
      .sort({ createdAt: -1 })
      .limit(200);
    // Map to the frontend shape
    const operators = users.map((u) => ({
      id: u._id.toString(),
      name: u.name || u.email.split('@')[0],
      initials: (u.name || u.email)
        .split(' ')
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2),
      title: u.role === 'admin' ? 'Administrator' : 'Handler',
      role: u.role === 'admin' ? 'ADMINISTRATOR' : 'HANDLER',
      email: u.email,
      status: u.status || 'ACTIVE',
      lastActivity: u.updatedAt
        ? formatRelativeTime(u.updatedAt)
        : 'Unknown',
      isFixture: !!u.isFixture,
      createdAt: u.createdAt,
    }));
    res.json({ success: true, operators });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/users — DISABLED (invitation-based onboarding only).
 *
 * This endpoint used to mint an ACTIVE staff account from a password the
 * ADMIN chose. That is no longer the architecture: an administrator INVITES a
 * staff member, the server mints a single-use invitation bound to the
 * inviter's workspace, and the invited person sets their own password on the
 * activation screen (/admin/activate/<token>). The administrator never knows
 * or transports a credential.
 *
 * The route is kept as an explicit, self-documenting refusal (410 Gone with a
 * pointer) instead of being deleted: a silent 404 would look like a typo to an
 * integrator, and this way the old contract states exactly what replaced it.
 */
export async function createOperator(_req, _res, next) {
  next(
    new ApiError(
      410,
      'Direct staff creation is disabled. Invite the staff member instead: Team → Staff → Invite Staff (POST /api/admin/invitations). They choose their own password at activation.',
      'INVITATION_REQUIRED'
    )
  );
}


/**
 * PATCH /api/admin/users/:id/status — suspend or reactivate an operator.
 *
 * Suspension is enforced server-side: login rejects suspended accounts and
 * every protected request re-checks status from the database, so an existing
 * token stops working immediately.
 */
export async function updateOperatorStatus(req, res, next) {
  try {
    const user = await User.findOne({
      _id: req.params.id,
      ...requestScope(req),
    });
    if (!user) {
      throw new ApiError(404, 'Operator not found.', 'NOT_FOUND');
    }
    if (user._id.toString() === req.user._id.toString()) {
      throw new ApiError(422, 'You cannot change your own account status.', 'VALIDATION_ERROR');
    }
    // Phase 21 — administrators (incl. the owner) are owner-managed only.
    assertOwnerMayManageAdministrator(req, user);
    const { status } = req.body || {};
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
      throw new ApiError(422, 'Status must be ACTIVE or SUSPENDED.', 'VALIDATION_ERROR');
    }
    // Guard: never disable the last active administrator.
    if (user.role === 'admin' && status === 'SUSPENDED') {
      const activeAdmins = await User.countDocuments({
        // Deliberately GLOBAL (not workspaceId-scoped): this guard protects
        // the platform from an administration lockout; self-action is already
        // refused above, so scoping it could only weaken the check.
        role: 'admin',
        status: 'ACTIVE',
      });
      if (activeAdmins <= 1) {
        throw new ApiError(422, 'Cannot suspend the last active administrator.', 'VALIDATION_ERROR');
      }
    }
    user.status = status;
    user.statusChangedAt = new Date();
    await user.save();
    res.json({
      success: true,
      operator: {
        id: user._id.toString(),
        name: user.name,
        status: user.status,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function updateOperatorRole(req, res, next) {
  try {
    const user = await User.findOne({
      _id: req.params.id,
      ...requestScope(req),
    });
    if (!user) {
      throw new ApiError(404, 'Operator not found.', 'NOT_FOUND');
    }
    if (user._id.toString() === req.user._id.toString()) {
      throw new ApiError(422, 'Cannot change your own role.', 'VALIDATION_ERROR');
    }
    const { role } = req.body;
    if (!['admin', 'handler'].includes(role)) {
      throw new ApiError(422, 'Role must be admin or handler.', 'VALIDATION_ERROR');
    }
    // Phase 21 — role assignment touches the administrator cohort from EITHER
    // side: demoting an admin AND promoting a handler into admin are both
    // owner-only (a non-owner promoting an ally would bypass the matrix).
    if (user.role === 'admin' || role === 'admin') {
      assertOwnerMayManageAdministrator(req, user.role === 'admin' ? user : { role: 'admin' });
    }
    // Guard: demoting the last active admin would lock out administration.
    if (user.role === 'admin' && role !== 'admin') {
      const activeAdmins = await User.countDocuments({
        // Deliberately GLOBAL (not workspaceId-scoped): the last-admin rule is
        // a platform-wide safety net, not a per-workspace preference.
        role: 'admin',
        status: 'ACTIVE',
      });
      if (activeAdmins <= 1) {
        throw new ApiError(422, 'Cannot demote the last active administrator.', 'VALIDATION_ERROR');
      }
    }
    user.role = role;
    await user.save();
    res.json({
      success: true,
      operator: {
        id: user._id.toString(),
        name: user.name,
        role: user.role === 'admin' ? 'ADMINISTRATOR' : 'HANDLER',
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteOperator(req, res, next) {
  try {
    const user = await User.findOne({
      _id: req.params.id,
      ...requestScope(req),
    });
    if (!user) {
      throw new ApiError(404, 'Operator not found.', 'NOT_FOUND');
    }
    if (user._id.toString() === req.user._id.toString()) {
      throw new ApiError(422, 'Cannot delete your own account.', 'VALIDATION_ERROR');
    }
    // Phase 21 — deleting an administrator (incl. the owner) is owner-only.
    assertOwnerMayManageAdministrator(req, user);
    if (user.isFixture) {
      throw new ApiError(422, 'Cannot delete seed fixture accounts.', 'VALIDATION_ERROR');
    }
    // Guard: never remove the last active administrator (docs/API promise).
    // Same formula as the suspend/demote guards: the count is of ACTIVE
    // administrators, so a sole-active-admin state can never be written away.
    if (user.role === 'admin') {
      const activeAdmins = await User.countDocuments({
        // Deliberately GLOBAL (not workspaceId-scoped): platform-wide safety
        // net for the last-admin invariant (see updateOperatorStatus).
        role: 'admin',
        status: 'ACTIVE',
      });
      if (activeAdmins <= 1) {
        throw new ApiError(422, 'Cannot delete the last active administrator.', 'VALIDATION_ERROR');
      }
    }
    // Scope re-asserted at write time (TOCTOU-safe), not just on the fetch.
    await User.deleteOne({ _id: user._id, ...requestScope(req) });
    res.json({ success: true, message: `Removed operator "${user.name}".` });
  } catch (err) {
    next(err);
  }
}

function formatRelativeTime(date) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString('en-IN');
}
