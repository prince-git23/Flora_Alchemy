/**
 * PERMISSION ENFORCEMENT (server authoritative).
 *
 * `protect` (middleware/authMiddleware.js) already re-read an authenticated
 * identity from the DATABASE for this request — role, status, workspaceId and
 * now the permission list are per-request facts, never token claims. This
 * middleware is the second question:
 *
 *   MAY this identity perform THIS OPERATION inside its workspace?
 *
 * Rules, in order:
 *   · no session            → public reads pass through (dual public/staff
 *                             routes such as GET /api/products); everything
 *                             else is 401
 *   · administrators/owner  → allowed. Their limits are the workspace/tenancy
 *                             gates and requireOwner, not this catalogue.
 *   · handler               → allowed only when the permission is in the
 *                             effective set for the CURRENT database document
 *                             (so a permission the administrator just removed
 *                             is refused on the next request, and one just
 *                             granted works without signing in again)
 *   · customer / unknown    → 403
 *
 * Hidden UI is never the control: this runs on the server for every request a
 * gated route receives.
 */

import { ApiError } from './errorMiddleware.js';
import { effectivePermissions, isLegacyAccess } from '../utils/permissions.js';

/**
 * @param {string} permission  a real id from utils/permissions.js
 * @param {{ onlyStaff?: boolean, skipNonStaff?: boolean, message?: string }} [options]
 *   onlyStaff    — when true, an UNauthenticated request continues (the public
 *                  branch of a shared route, e.g. the storefront catalogue
 *                  read). A request that DOES carry a staff session is still
 *                  permission-checked, so a handler cannot use the public
 *                  branch to read what it may not read.
 *   skipNonStaff — when true, a non-staff identity (a customer) continues.
 *                  Used by the routes customers share with staff (own order
 *                  detail, own conversation, notifications feed, storefront
 *                  catalogue): those paths are ownership-scoped in their own
 *                  controller and must keep working for a signed-in customer.
 */
export function requirePermission(permission, options = {}) {
  const { onlyStaff = false, skipNonStaff = false, message } = options;
  return function permissionGate(req, _res, next) {
    const user = req.user;
    if (!user) {
      if (onlyStaff) return next();
      return next(new ApiError(401, 'Authentication required. Please sign in.', 'UNAUTHORIZED'));
    }
    if (user.role === 'admin') return next(); // workspace admin / owner: admin gate applies
    if (user.role !== 'handler') {
      // Customers are not staff: on a shared route they keep their own
      // ownership-scoped behaviour; anywhere else the role gate refused them.
      if (onlyStaff || skipNonStaff) return next();
      return next(new ApiError(403, 'You do not have permission to perform this action.', 'FORBIDDEN'));
    }
    if (effectivePermissions(user).includes(permission)) return next();
    const hint = isLegacyAccess(user)
      ? ''
      : ' Ask your workspace administrator to grant it in Team → Staff → Access & Role.';
    return next(
      new ApiError(
        403,
        message || `Your staff role does not include the "${permission}" permission.${hint}`,
        'PERMISSION_DENIED'
      )
    );
  };
}

/**
 * Multi-permission variant: allowed when the identity holds ANY of the ids.
 * Used where one endpoint serves several capabilities (for example a status
 * write whose permission depends on the target stage — see the order and
 * custom-request controllers, which call `requireAnyPermission` after the
 * target value is known).
 */
export function requireAnyPermission(permissions, options = {}) {
  const ids = Array.isArray(permissions) ? permissions : [permissions];
  return function permissionGate(req, _res, next) {
    const user = req.user;
    if (!user) {
      if (options.onlyStaff) return next();
      return next(new ApiError(401, 'Authentication required. Please sign in.', 'UNAUTHORIZED'));
    }
    if (user.role === 'admin') return next();
    if (user.role !== 'handler') {
      if (options.onlyStaff || options.skipNonStaff) return next();
      return next(new ApiError(403, 'You do not have permission to perform this action.', 'FORBIDDEN'));
    }
    const effective = effectivePermissions(user);
    if (ids.some((id) => effective.includes(id))) return next();
    return next(
      new ApiError(
        403,
        options.message || `Your staff role does not include any of: ${ids.join(', ')}. Ask your workspace administrator to grant it in Team → Staff → Access & Role.`,
        'PERMISSION_DENIED'
      )
    );
  };
}

/**
 * Assertion form for controllers that only learn the required permission after
 * validating the request body (order / request status transitions).
 * Throws the SAME 403 shape as the middleware so clients branch identically.
 */
export function assertPermission(user, permission) {
  if (!user) {
    throw new ApiError(401, 'Authentication required. Please sign in.', 'UNAUTHORIZED');
  }
  if (user.role === 'admin') return;
  if (user.role !== 'handler') {
    throw new ApiError(403, 'You do not have permission to perform this action.', 'FORBIDDEN');
  }
  if (!effectivePermissions(user).includes(permission)) {
    throw new ApiError(
      403,
      `Your staff role does not include the "${permission}" permission. Ask your workspace administrator to grant it in Team → Staff → Access & Role.`,
      'PERMISSION_DENIED'
    );
  }
}
