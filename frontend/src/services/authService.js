import { getStored, setStored, clearStored } from './storage.js';
import { api, setToken, clearToken } from './apiClient.js';

const CUSTOMER_SESSION_KEY = 'flora_alchemy_customer_session';
const ADMIN_SESSION_KEY = 'flora_alchemy_admin_session';

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
  clearStored(CUSTOMER_SESSION_KEY);
  clearToken('customer');
}

// ─── Admin Auth ───

/**
 * Authenticate a handler/admin against the backend. Returns
 * { success, session } or { success:false, error }.
 */
function buildAdminSession(token, user) {
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
    // Phase 20.6.3 — staff identity badge for the portal shell. Presentation
    // only; every protected request re-derives the real role from the DB.
    staffId: user.staffId || null,
    roleLabel: user.roleLabel || null,
    department: user.department || '',
    loggedInAt: new Date().toISOString(),
  };
}

export async function adminLogin(email, password) {
  const res = await api.post('/auth/login', { email, password });
  if (!res.ok) {
    return { success: false, error: res.message || 'Sign in failed.' };
  }
  const { token, user } = res.data || {};
  if (!token || !['admin', 'handler'].includes(user?.role)) {
    return {
      success: false,
      error: 'This account does not have Handler Portal access.',
    };
  }
  const session = buildAdminSession(token, user);
  setStored(ADMIN_SESSION_KEY, session);
  setToken(token, 'admin');
  return { success: true, session };
}

export function getAdminSession() {
  return getStored(ADMIN_SESSION_KEY, null);
}

export function adminLogout() {
  clearStored(ADMIN_SESSION_KEY);
  clearToken('admin');
}

export function isAdminAuthenticated() {
  return getAdminSession() !== null;
}

export function isCustomerAuthenticated() {
  return getCustomerSession() !== null || !!localStorage.getItem('flora_alchemy_account');
}
