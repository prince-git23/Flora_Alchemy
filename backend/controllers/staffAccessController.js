import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { recordStaffEvent } from '../utils/staffEvents.js';
import { requestScope } from '../utils/tenancy.js';
import {
  accessView,
  normalizePermissions,
  permissionCatalogue,
  roleTemplate,
  ROLE_TEMPLATES,
  FULL_WORKSPACE_ACCESS,
} from '../utils/permissions.js';

/**
 * GRANULAR STAFF ACCESS — the administrator surface.
 *
 *   GET   /api/admin/access/catalogue     the assignable permissions + templates
 *   GET   /api/admin/access/staff/:id     one staff member's access (effective)
 *   PATCH /api/admin/access/staff/:id     set role template and/or permissions
 *
 * Boundaries (mirrors the staff lifecycle matrix, never widens it):
 *   · the router requires an ADMIN session and the workspace gate, so the
 *     target is always fetched with `requestScope` — an admin can only reach
 *     staff in ITS OWN workspace (cross-workspace id reads as 404, not 403);
 *   · an ADMINISTRATOR or OWNER account is refused (owner-managed elsewhere):
 *     a workspace admin can shape operational authority, never peer authority;
 *   · a customer account is refused (not staff);
 *   · self-service is refused — no role edits its own permissions;
 *   · the catalogue contains NO owner/platform permission at all, so no
 *     submitted bundle can escalate beyond workspace operations. Unknown ids
 *     raise 422 instead of being silently dropped.
 */

/** Load the target with the actor's tenancy scope + the manageability rules. */
async function loadManageableTarget(req) {
  const target = await User.findOne({ _id: req.params.id, ...requestScope(req) });
  if (!target) throw new ApiError(404, 'Staff member not found.', 'NOT_FOUND');
  if (String(target._id) === String(req.user._id)) {
    throw new ApiError(422, 'You cannot change your own access.', 'VALIDATION_ERROR');
  }
  if (target.role === 'admin') {
    throw new ApiError(
      403,
      'Administrator access is managed by the owner, not by staff access roles.',
      'OWNER_REQUIRED'
    );
  }
  if (target.role !== 'handler') {
    throw new ApiError(422, 'Only staff (handler) accounts carry access permissions.', 'NOT_STAFF');
  }
  return target;
}

/** GET /api/admin/access/catalogue — what an administrator may assign. */
export async function getAccessCatalogue(_req, res, next) {
  try {
    res.json({
      success: true,
      catalogue: permissionCatalogue(),
      // The platform boundary, stated for the UI: these are NEVER assignable.
      reserved: [
        'Owner authority',
        'Administrator lifecycle (invite, suspend, delete)',
        'Workspace ownership and provisioning',
        'Platform governance and applications',
        'Platform settings',
      ],
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/access/staff/:id — stored + effective access for one member. */
export async function getStaffAccess(req, res, next) {
  try {
    const target = await loadManageableTarget(req);
    res.json({
      success: true,
      staff: {
        id: target._id.toString(),
        name: target.name || target.email,
        email: target.email,
        staffId: target.staffId || null,
        status: target.status || 'ACTIVE',
      },
      access: accessView(target),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/admin/access/staff/:id
 *
 * Body accepts any of:
 *   { role }                        → apply a ROLE TEMPLATE's bundle
 *   { permissions: [...] }          → explicit bundle (role becomes `custom`
 *                                     unless a template key is also sent)
 *   { role, permissions }           → both, permissions win as the authority
 *   { fullAccess: true }            → full workspace access bundle
 */
export async function updateStaffAccess(req, res, next) {
  try {
    const target = await loadManageableTarget(req);
    const body = req.body || {};
    const before = accessView(target);

    let templateKey = null;
    if (body.role !== undefined && body.role !== null && body.role !== '') {
      templateKey = String(body.role);
      const template = roleTemplate(templateKey);
      if (!template) {
        throw new ApiError(
          422,
          `Unknown role template "${templateKey}". Allowed: ${ROLE_TEMPLATES.map((t) => t.key).join(', ')}.`,
          'VALIDATION_ERROR'
        );
      }
    }

    let nextPermissions;
    if (body.fullAccess === true) {
      nextPermissions = [...FULL_WORKSPACE_ACCESS];
      templateKey = templateKey && templateKey !== 'custom' ? templateKey : 'full_workspace';
    } else if (body.permissions !== undefined) {
      nextPermissions = normalizePermissions(body.permissions);
      // An explicit bundle with no template named is a CUSTOM role — except
      // when the bundle is exactly the full-access set, which we label honestly.
      if (!templateKey || templateKey === 'custom') {
        templateKey =
          FULL_WORKSPACE_ACCESS.length === nextPermissions.length &&
          FULL_WORKSPACE_ACCESS.every((p) => nextPermissions.includes(p))
            ? 'full_workspace'
            : 'custom';
      }
    } else if (templateKey) {
      nextPermissions = [...roleTemplate(templateKey).permissions];
    } else {
      throw new ApiError(
        422,
        'Send a role template, a permissions array, or fullAccess: true.',
        'VALIDATION_ERROR'
      );
    }

    target.staffRole = templateKey || 'custom';
    target.permissions = nextPermissions;
    target.accessUpdatedAt = new Date();
    target.accessUpdatedBy = req.user._id;
    await target.save();

    const after = accessView(target);
    const granted = after.effective.filter((p) => !before.effective.includes(p));
    const removed = before.effective.filter((p) => !after.effective.includes(p));

    await recordStaffEvent({
      // Bound to the ACCOUNT so the change lands in that member's timeline.
      user: target._id,
      recipientEmail: target.email,
      type: 'ACCESS_UPDATED',
      message: `${req.user.name || req.user.email} set ${target.name || target.email} to ${after.roleLabel}` +
        `${granted.length ? ` · granted: ${granted.join(', ')}` : ''}` +
        `${removed.length ? ` · removed: ${removed.join(', ')}` : ''}.`,
      actor: req.user,
    }).catch(() => {});

    res.json({
      success: true,
      message: `Access saved for ${target.name || target.email}.`,
      staff: {
        id: target._id.toString(),
        name: target.name || target.email,
        email: target.email,
      },
      access: after,
      changed: { granted, removed },
    });
  } catch (err) {
    next(err);
  }
}
