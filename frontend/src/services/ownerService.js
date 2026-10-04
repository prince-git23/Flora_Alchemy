import api from './apiClient.js';

/**
 * ownerService — Phase 21.2 Owner Portal API.
 *
 * Both endpoints are owner-only on the server (protect + requireOwner). The
 * client sends the admin-scoped token (the owner is an administrator carrying
 * the isOwner designation) and branches on the REAL server verdict — a plain
 * administrator receives 403 here, which the OwnerRoute guard already prevents
 * the UI from reaching.
 */

const ADMIN = { scope: 'admin' };

/** GET /api/owner/overview — executive KPI bundle + real activity trail. */
export async function getOwnerOverview() {
  const res = await api.get('/owner/overview', ADMIN);
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    message: res.message,
    overview: res.data?.overview || null,
    activity: res.data?.activity || [],
  };
}

/** GET /api/owner/administrators — the administrators directory. */
export async function getOwnerAdministrators({ q, status } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status && status !== 'ALL') params.set('status', status);
  const qs = params.toString();
  const res = await api.get(`/owner/administrators${qs ? `?${qs}` : ''}`, ADMIN);
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    message: res.message,
    administrators: res.data?.administrators || [],
    counts: res.data?.counts || null,
  };
}

/**
 * PHASE 1 — SHOP GOVERNANCE.
 *
 * The owner's platform-level view of every Workspace/Shop: identity, lifecycle
 * status and primary administrator. Suspend/reactivate are the ONLY mutations
 * — the owner never manages a shop's inventory, orders or catalogue (those are
 * workspace-scoped and refuse the platform identity server-side).
 */

/** GET /api/owner/shops — every shop with its lifecycle status. */
export async function getOwnerShops({ q, status } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status && status !== 'ALL') params.set('status', status);
  const qs = params.toString();
  const res = await api.get(`/owner/shops${qs ? `?${qs}` : ''}`, ADMIN);
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    message: res.message,
    shops: res.data?.shops || [],
    counts: res.data?.counts || null,
  };
}

/** POST /api/owner/shops/:slug/suspend — remove a shop from public discovery. */
export async function suspendShop(slug) {
  const res = await api.post(`/owner/shops/${encodeURIComponent(slug)}/suspend`, undefined, ADMIN);
  return { ok: res.ok, status: res.status, code: res.code, message: res.message, shop: res.data?.shop || null };
}

/** POST /api/owner/shops/:slug/reactivate — restore a shop to public discovery. */
export async function reactivateShop(slug) {
  const res = await api.post(`/owner/shops/${encodeURIComponent(slug)}/reactivate`, undefined, ADMIN);
  return { ok: res.ok, status: res.status, code: res.code, message: res.message, shop: res.data?.shop || null };
}
