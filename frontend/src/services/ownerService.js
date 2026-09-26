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
