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
const ADMIN_SESSION_KEY = 'flora_alchemy_admin_session';

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
const CHECKOUT_SNAPSHOT_KEY = 'flora_alchemy_checkout_snapshot';

export function saveCheckoutSnapshot(snapshot) {
  try {
    sessionStorage.setItem(CHECKOUT_SNAPSHOT_KEY, JSON.stringify({ ...snapshot, savedAt: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

export function loadCheckoutSnapshot() {
  try {
    const raw = sessionStorage.getItem(CHECKOUT_SNAPSHOT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearCheckoutSnapshot() {
  try {
    sessionStorage.removeItem(CHECKOUT_SNAPSHOT_KEY);
  } catch {
    /* non-browser */
  }
}

function handleSessionExpired(scope) {
  try {
    if (scope === 'admin') {
      localStorage.removeItem(ADMIN_SESSION_KEY);
    } else {
      localStorage.removeItem(ACCOUNT_KEY);
    }
    localStorage.removeItem(scope === 'admin' ? ADMIN_TOKEN_KEY : CUSTOMER_TOKEN_KEY);
    window.dispatchEvent(new CustomEvent('fa:auth-expired', { detail: { scope } }));
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
