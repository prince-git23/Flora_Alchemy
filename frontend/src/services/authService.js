import { getStored, setStored } from './storage.js';
import {
  api,
  setToken,
  getToken,
  clearAuthScope,
  CUSTOMER_SESSION_KEY,
  ADMIN_SESSION_KEY,
} from './apiClient.js';

/**
 * Phase 3B — real authentication against the Express/MongoDB backend.
 *
 * Admin (handler) authentication posts to POST /api/auth/login and stores the
 * returned JWT + profile under the same admin session key the Handler Portal
 * has always used, so AdminRoute/AdminSessionContext behavior is unchanged.
 *
 * The customer identity for the storefront lives in customerService
 * (flora_alchemy_account) — set only by an explicit login/registration.
 * A fresh browser is always GUEST.
 */

// ─── Customer Auth (see customerService.apiLogin/apiRegister) ───

// Legacy sync helpers retained for callers that only inspect session state;
// credential validation now happens on the server through customerService.
export function getCustomerSession() {
  try {
    const stored = localStorage.getItem(CUSTOMER_SESSION_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function customerLogout() {
  // Clears the token AND every customer session marker — a token-only clear
  // left `flora_alchemy_account` behind and the identity came back on reload.
  clearAuthScope('customer');
}

// ─── Admin Auth ───

/**
 * Authenticate a handler/admin against the backend. Returns
 * { success, session } or { success:false, error }.
 */
/**
 * Phase 21.1 — the three staff portals. A portal is a NAVIGATION context, not
 * a grant of authority: the server resolves the identity and decides whether it
 * may enter. This map keeps the frontend's copy + routing in one place so the
 * three login pages and every guard agree.
 */
export const PORTAL_META = {
  owner: {
    key: 'owner',
    label: 'Owner Portal',
    short: 'Owner',
    login: '/owner/login',
    home: '/owner/dashboard',
  },
  admin: {
    key: 'admin',
    label: 'Administrator Portal',
    short: 'Administrator',
    login: '/admin/login',
    home: '/admin/dashboard',
  },
  staff: {
    key: 'staff',
    label: 'Staff Portal',
    short: 'Staff',
    login: '/staff/login',
    home: '/staff/dashboard',
  },
};

export function portalMeta(portal) {
  return PORTAL_META[portal] || PORTAL_META.admin;
}

/** Login route for a portal key. */
export function loginPathForPortal(portal) {
  return portalMeta(portal).login;
}

/** Landing route for a portal key. */
export function homePathForPortal(portal) {
  return portalMeta(portal).home;
}

/**
 * The portal an authenticated identity belongs to — derived from the session
 * the SERVER returned (role + isOwner), never from a client choice. Mirrors
 * backend/utils/portals.js so guards and navigation stay consistent.
 */
export function portalForSession(session) {
  if (!session) return null;
  if (session.portal) return session.portal;
  if (session.role === 'admin') return session.isOwner ? 'owner' : 'admin';
  if (session.role === 'handler') return 'staff';
  return null;
}

/**
 * Phase 21 — /admin → /staff mapping for the shared OPERATIONAL surfaces.
 *
 * Product, order, inventory, customer, conversation, custom-request and
 * analytics pages are one component behind two portal URLs (the backend
 * authorizes the handler for all of them via adminOrHandler). Shared pages
 * author links in the /admin namespace; this single allowlist rewrites those
 * targets for staff sessions so no page needs its own role logic.
 *
 * Governance surfaces (staff members, invitations, access, settings, owner
 * pages) are deliberately absent: a staff session following one of those
 * links falls back to /staff/dashboard — they are AdminRoute-blocked.
 */
const STAFF_OPERATIONAL_PATTERNS = [
  /^\/admin\/dashboard$/,
  /^\/admin\/orders(\/|$)/,
  /^\/admin\/products(\/|$)/,
  /^\/admin\/collections(\/|$)/,
  /^\/admin\/customers(\/|$)/,
  /^\/admin\/conversations(\/|$)/,
  /^\/admin\/custom-requests(\/|$)/,
  /^\/admin\/inventory(\/|$)/,
  /^\/admin\/analytics(\/|$)/,
  /^\/admin\/notifications(\/|$)/,
];

/**
 * @param {string} pathname an /admin/* location pathname
 * @returns {string|null} the /staff/* equivalent, or null when the path has
 *   no staff counterpart (callers should fall back to /staff/dashboard).
 */
export function staffPathFor(pathname) {
  const path = String(pathname || '');
  if (!STAFF_OPERATIONAL_PATTERNS.some((re) => re.test(path))) return null;
  return path.replace(/^\/admin\b/, '/staff');
}

function buildAdminSession(token, user, redirectTo) {
  return {
    token,
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    // Phase 20.6.2 — ownership designation for NAVIGATION VISIBILITY only
    // (OwnerRoute shows the owner console / access-denied dossier). The
    // backend never trusts it: requireOwner re-reads the user from the DB.
    isOwner: user.isOwner === true,
    // Phase 21.1 — the portal this session belongs to (server-derived).
    portal: user.portal || (user.role === 'admin' ? (user.isOwner ? 'owner' : 'admin') : user.role === 'handler' ? 'staff' : null),
    redirectTo: redirectTo || null,
    // Phase 20.6.3 — staff identity badge for the portal shell. Presentation
    // only; every protected request re-derives the real role from the DB.
    staffId: user.staffId || null,
    roleLabel: user.roleLabel || null,
    department: user.department || '',
    // Phase 22.4 — DISPLAY-ONLY workspace context { id, slug, name, status }
    // for the Administrator Portal shell (business name + public /shops/
    // address in the sidebar badge). Null for owners and unscoped legacy
    // accounts. Authorization never reads this: membership is re-derived from
    // the database on every protected request.
    workspace: user.workspace || null,
    // GRANULAR STAFF ACCESS — DISPLAY-ONLY effective permissions for the portal
    // shell (nav gating). The server re-derives the same list on every gated
    // request, which is why refreshAdminSession() below re-reads it after a
    // sign-in instead of trusting this stored copy.
    access: user.access || null,
    loggedInAt: new Date().toISOString(),
  };
}

/**
 * Authenticate a staff member. `portal` ('owner' | 'admin' | 'staff') tells the
 * server which portal is being entered; the server refuses a mismatch with 403
 * PORTAL_FORBIDDEN. Omitting it keeps the legacy "any staff account" behaviour.
 */
export async function adminLogin(email, password, portal) {
  const body = { email, password };
  if (portal) body.portal = portal;
  const res = await api.post('/auth/login', body);
  if (!res.ok) {
    return { success: false, error: res.message || 'Sign in failed.', code: res.code || null };
  }
  const { token, user, redirectTo } = res.data || {};
  if (!token || !['admin', 'handler'].includes(user?.role)) {
    return {
      success: false,
      error: 'This account does not have staff portal access.',
      code: 'PORTAL_FORBIDDEN',
    };
  }
  const session = buildAdminSession(token, user, redirectTo);
  setStored(ADMIN_SESSION_KEY, session);
  setToken(token, 'admin');
  return { success: true, session, redirectTo };
}

export function getAdminSession() {
  return getStored(ADMIN_SESSION_KEY, null);
}

/**
 * Re-read the CURRENT staff identity (role, status, workspace and effective
 * permissions) from the server and refresh the stored session.
 *
 * A permission an administrator changed while this person is signed in must be
 * reflected in the shell without forcing a re-login — and must never be trusted
 * from the stored copy. Returns the refreshed session, or null when the session
 * is gone (401/403 → apiClient already cleared the markers).
 */
export async function refreshAdminSession() {
  const token = getToken('admin');
  if (!token) return null;
  const res = await api.get('/auth/me', { scope: 'admin' });
  if (!res.ok || !res.data?.user) return null;
  const previous = getStored(ADMIN_SESSION_KEY, null) || {};
  const session = buildAdminSession(token, res.data.user, previous.redirectTo || null);
  setStored(ADMIN_SESSION_KEY, session);
  return session;
}

export function adminLogout() {
  clearAuthScope('admin');
}

export function isAdminAuthenticated() {
  return getAdminSession() !== null;
}

export function isCustomerAuthenticated() {
  return getCustomerSession() !== null || !!localStorage.getItem('flora_alchemy_account');
}
