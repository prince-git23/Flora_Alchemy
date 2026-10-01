/**
 * Single API client for the Flora Alchemy backend.
 *
 * All HTTP goes through here — no scattered fetch calls in pages. Base URL
 * comes from VITE_API_URL (root .env). Responses are normalized to
 * { status, ok, data } and API errors to { status, message, code }.
 *
 * Tokens: customer and admin sessions are separate (keys below). Pass the
 * correct token when calling protected endpoints.
 */

export const CUSTOMER_TOKEN_KEY = 'flora_alchemy_customer_token';
export const ADMIN_TOKEN_KEY = 'flora_alchemy_admin_token';

import { tenantKey } from './tenantContext.js';

const BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:4000/api').replace(/\/$/, '');

export function getToken(scope = 'customer') {
  try {
    return localStorage.getItem(scope === 'admin' ? ADMIN_TOKEN_KEY : CUSTOMER_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token, scope = 'customer') {
  try {
    if (token) localStorage.setItem(scope === 'admin' ? ADMIN_TOKEN_KEY : CUSTOMER_TOKEN_KEY, token);
    else localStorage.removeItem(scope === 'admin' ? ADMIN_TOKEN_KEY : CUSTOMER_TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function clearToken(scope = 'customer') {
  setToken(null, scope);
}

const ACCOUNT_KEY = 'flora_alchemy_account';
export const ADMIN_SESSION_KEY = 'flora_alchemy_admin_session';
// Legacy/companion customer marker. It is not written by the current login
// flow, but older sessions may still carry it — so a clear must remove it too.
export const CUSTOMER_SESSION_KEY = 'flora_alchemy_customer_session';

/**
 * Every storage key that can make a scope look authenticated.
 *
 * A session is only truly gone when ALL of its keys are gone. The clears used
 * to live at each call site and disagreed with each other — `customerLogout()`
 * removed the token but left `flora_alchemy_account`, while the 401 handler did
 * the reverse and left the customer marker. Either leftover is enough for the
 * app to keep presenting a signed-in (or suspended) identity after a reload, so
 * the key list lives here once and every clear goes through it.
 */
const AUTH_KEYS = {
  customer: [CUSTOMER_TOKEN_KEY, ACCOUNT_KEY, CUSTOMER_SESSION_KEY],
  admin: [ADMIN_TOKEN_KEY, ADMIN_SESSION_KEY],
};

/** Remove ONE scope's authentication completely (token + every session marker). */
export function clearAuthScope(scope = 'customer') {
  const keys = AUTH_KEYS[scope === 'admin' ? 'admin' : 'customer'];
  try {
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Remove EVERY scope's authentication and tell the app to forget the identity.
 *
 * Used when the current session is unusable (a suspended account) and the
 * visitor chooses to start over. Clearing both scopes is deliberate: a person
 * may hold a staff token and a customer marker at once, and leaving either
 * behind lets the removed identity reappear on the next hydration.
 */
export function clearAllAuthState() {
  clearAuthScope('admin');
  clearAuthScope('customer');
  try {
    // Contexts drop their in-memory session…
    window.dispatchEvent(new CustomEvent('fa:auth-expired', { detail: { scope: 'admin' } }));
    window.dispatchEvent(new CustomEvent('fa:auth-expired', { detail: { scope: 'customer' } }));
    // …and the data layer re-hydrates without one (this is what makes the
    // storefront load as a guest instead of re-running the refused request).
    window.dispatchEvent(new CustomEvent('fa:refresh', { detail: { scope: 'auth', slices: null } }));
  } catch {
    /* non-browser */
  }
}

/**
 * Session hardening: when the server rejects a request that carried a token
 * with 401, the session is genuinely over. Clear that session's markers and
 * notify the app so the user lands on the right login screen. Requests that
 * carried no token (e.g. a failed login attempt) never trigger this.
 */
/** Internal-only redirect target check — blocks protocol-relative/open redirects. */
export function isSafeInternalPath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
}

/**
 * Phase 20.3 — checkout context snapshot (sessionStorage).
 * Checkout state that used to live only in React state (step, delivery form,
 * shipping choice) was destroyed whenever the customer left /checkout — an
 * auth round-trip or a cart edit restarted the whole flow. The snapshot
 * survives route changes AND refreshes within the tab session and is
 * consumed once by CheckoutPage on remount. Address form data is transport
 * detail, not a credential; sessionStorage is this app's standard place for
 * short-lived non-credential state.
 */
const CHECKOUT_SNAPSHOT_BASE = 'flora_alchemy_checkout_snapshot';

/**
 * Phase 22.5 — the snapshot key is namespaced by the active workspace, so a
 * checkout started at shop A can never prefill (or be resumed as) shop B.
 */
function checkoutSnapshotKey() {
  return tenantKey(CHECKOUT_SNAPSHOT_BASE);
}

export function saveCheckoutSnapshot(snapshot) {
  try {
    sessionStorage.setItem(checkoutSnapshotKey(), JSON.stringify({ ...snapshot, savedAt: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

export function loadCheckoutSnapshot() {
  try {
    const raw = sessionStorage.getItem(checkoutSnapshotKey());
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearCheckoutSnapshot() {
  try {
    sessionStorage.removeItem(checkoutSnapshotKey());
  } catch {
    /* non-browser */
  }
}

function handleSessionExpired(scope) {
  const resolved = scope === 'admin' ? 'admin' : 'customer';
  clearAuthScope(resolved);
  try {
    window.dispatchEvent(new CustomEvent('fa:auth-expired', { detail: { scope: resolved } }));
  } catch {
    /* non-browser */
  }
}

async function request(method, path, { token, body, scope } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // scope === null → deliberately anonymous request (no auth header).
  const activeToken =
    token || (scope === undefined || scope === null ? null : getToken(scope));
  if (activeToken) headers.Authorization = `Bearer ${activeToken}`;

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: 'Unable to reach the Flora Alchemy server. Please check your connection and try again.',
      code: 'NETWORK_ERROR',
      raw: err,
    };
  }

  // A token-bearing request that the server rejects with 401 means the
  // session expired or was revoked — clear it and redirect the user.
  if (res.status === 401 && activeToken) {
    handleSessionExpired(scope === 'admin' ? 'admin' : 'customer');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.ok && data && data.success !== false) {
    return { ok: true, status: res.status, data };
  }

  return {
    ok: false,
    status: res.status,
    message: (data && data.message) || `Request failed (${res.status}).`,
    code: (data && data.code) || 'API_ERROR',
    data,
  };
}

export const api = {
  get: (path, opts = {}) => request('GET', path, opts),
  post: (path, body, opts = {}) => request('POST', path, { ...opts, body }),
  patch: (path, body, opts = {}) => request('PATCH', path, { ...opts, body }),
  delete: (path, opts = {}) => request('DELETE', path, opts),
};

export default api;
