import api from './apiClient.js';

/**
 * adminApplicationService — Phase 20.6.6 owner ↔ public application flow.
 *
 * submitApplication is PUBLIC (deliberately anonymous scope — no token is
 * attached, so a signed-in customer session can never leak into the intake
 * endpoint). Everything else is session-authorized with the ADMIN scope and
 * the backend re-derives ownership on every request (requireOwner), so these
 * calls return the REAL server verdict ({ ok, status, code, message })
 * instead of inventing a local rule.
 */

const ADMIN = { scope: 'admin' };

function normalize(res) {
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    message: res.message,
    data: res.data ?? null,
    counts: res.data?.counts || null,
    application: res.data?.application || null,
    invitation: res.data?.invitation || null,
    link: res.data?.link || null,
  };
}

/**
 * POST /api/admin-applications — PUBLIC intake.
 * Creates a review record only: never an account, never a credential.
 */
export async function submitApplication({ name, email, phone, reason, background }) {
  const res = await api.post(
    '/admin-applications',
    { name, email, phone, reason, background },
    { scope: null } // anonymous — never attach a session token
  );
  return normalize(res);
}

/** GET /api/admin-applications — owner ledger with live counts + paging. */
export async function listApplications({ status, q, page, limit } = {}) {
  const params = new URLSearchParams();
  if (status && status !== 'ALL') params.set('status', status);
  if (q) params.set('q', q);
  if (page) params.set('page', String(page));
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  const res = await api.get(`/admin-applications${qs ? `?${qs}` : ''}`, ADMIN);
  return {
    ...normalize(res),
    applications: res.data?.applications || [],
    page: res.data?.page || 1,
    total: res.data?.total || 0,
    hasMore: !!res.data?.hasMore,
  };
}

/** GET /api/admin-applications/:id — one dossier + its live invitation state. */
export async function getApplication(id) {
  const res = await api.get(`/admin-applications/${id}`, ADMIN);
  return normalize(res);
}

/**
 * POST /api/admin-applications/:id/approve — the response's `link` is the
 * ONLY place the raw activation token ever appears. `applicationActivationUrl`
 * repins that link to the origin the operator is actually on, so a copy
 * always points at this deployment even if the server's portal base URL is
 * misconfigured.
 */
export async function approveApplication(id, { note } = {}) {
  const res = await api.post(`/admin-applications/${id}/approve`, { note }, ADMIN);
  return normalize(res);
}

export function applicationActivationUrl(link) {
  if (!link) return '';
  if (typeof window === 'undefined') return link;
  try {
    return `${window.location.origin}${new URL(link).pathname}`;
  } catch {
    return link;
  }
}

/** POST /api/admin-applications/:id/reject — reason is REQUIRED by the server. */
export async function rejectApplication(id, { reason }) {
  const res = await api.post(`/admin-applications/${id}/reject`, { reason }, ADMIN);
  return normalize(res);
}
