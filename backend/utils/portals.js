/**
 * Phase 21.1 — ORIGIN OF TRUTH for portal authorization.
 *
 * Flora Alchemy exposes three staff-facing portals, each with its own login
 * route:
 *
 *   /owner/login   → portal 'owner'   the business proprietor (admin + isOwner)
 *   /admin/login   → portal 'admin'   approved administrators
 *   /staff/login   → portal 'staff'   operational handlers
 *
 * A portal is a NAVIGATION CONTEXT, never a grant of authority: selecting a
 * portal URL can never turn a customer into an owner. The backend resolves the
 * authenticated identity from the database (authMiddleware `protect` re-reads
 * the user on every request) and this module decides whether that identity is
 * permitted to enter the requested portal.
 *
 * Roles remain exactly `customer | handler | admin`; the Owner is an
 * administrator carrying `isOwner = true` (there is deliberately NO 'owner'
 * role). Keeping the decision here — a single exported function — means the
 * login controller, the tests, and any future surface cannot drift apart.
 */

/** The portals a staff session may be scoped to. */
export const PORTALS = ['owner', 'admin', 'staff'];

/** Normalize a client-supplied portal hint. Returns null when absent/invalid. */
export function normalizePortal(value) {
  const raw = String(value || '').trim().toLowerCase();
  return PORTALS.includes(raw) ? raw : null;
}

/**
 * The portal a user's identity belongs to. Owners are administrators, so their
 * home portal is the Owner Portal; plain administrators use the Admin Portal;
 * handlers use the Staff Portal; customers belong to none.
 */
export function portalFor(user) {
  if (!user) return null;
  if (user.role === 'admin') return user.isOwner ? 'owner' : 'admin';
  if (user.role === 'handler') return 'staff';
  return null;
}

/**
 * Decide whether `user` may authenticate into `portal`.
 *
 * Policy (explicit, least-privilege):
 *   • owner  — administrator with isOwner. A plain administrator is refused,
 *              so the Owner Portal can never be entered by an admin account.
 *   • admin  — any administrator (an owner also holds the admin role and may
 *              administer the business).
 *   • staff  — handlers only. Administrators/owners are refused: their
 *              operational surfaces live in the Admin/Owner portals, and
 *              allowing cross-entry would blur the portal boundary.
 *   • customers are refused by every staff portal.
 *
 * @returns {{allowed: boolean, reason?: string, code?: string}}
 */
export function evaluatePortalAccess(user, portal) {
  if (!user) {
    return { allowed: false, reason: 'Authentication required.', code: 'UNAUTHORIZED' };
  }
  if (user.role === 'customer') {
    return {
      allowed: false,
      reason: 'This portal is for Flora Alchemy staff accounts only.',
      code: 'PORTAL_FORBIDDEN',
    };
  }

  const isOwner = user.role === 'admin' && user.isOwner === true;

  if (portal === 'owner') {
    if (isOwner) return { allowed: true };
    return {
      allowed: false,
      reason: 'The Owner Portal is restricted to the business owner.',
      code: 'PORTAL_FORBIDDEN',
    };
  }

  if (portal === 'admin') {
    if (user.role === 'admin') return { allowed: true };
    return {
      allowed: false,
      reason: 'This account does not have administrator access.',
      code: 'PORTAL_FORBIDDEN',
    };
  }

  if (portal === 'staff') {
    if (user.role === 'handler') return { allowed: true };
    return {
      allowed: false,
      reason: 'The Staff Portal is for handler accounts. Use your Administrator or Owner portal.',
      code: 'PORTAL_FORBIDDEN',
    };
  }

  // Unknown portal — fail closed.
  return { allowed: false, reason: 'Unknown portal.', code: 'PORTAL_FORBIDDEN' };
}

/** Client-side landing route for a portal (shared with the frontend contract). */
export function portalHomePath(portal) {
  if (portal === 'owner') return '/owner/dashboard';
  if (portal === 'staff') return '/staff/dashboard';
  return '/admin/dashboard';
}
