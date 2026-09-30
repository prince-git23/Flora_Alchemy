import api from './apiClient.js';

/**
 * staffService — Phase 20.6.3 / 20.6.4 staff directory, lifecycle and
 * invitation management.
 *
 * Every call is session-authorized (admin scope) and returns the normalized
 * client result { ok, status, data, message, code } rather than throwing, so
 * callers can branch on the REAL server verdict (401/403/404/409/422) instead
 * of inventing a local rule that might drift from the backend.
 */

const ADMIN = { scope: 'admin' };

function normalize(res, key) {
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    message: res.message,
    data: key ? res.data?.[key] ?? null : res.data ?? null,
    counts: res.data?.counts || null,
    link: res.data?.link || null,
  };
}

// ── Directory ──────────────────────────────────────────────────────────────

/** GET /api/admin/staff — unified roster (accounts + live invitations). */
export async function getStaff({ role, status, q, sort } = {}) {
  const params = new URLSearchParams();
  if (role && role !== 'ALL') params.set('role', role);
  if (status && status !== 'ALL') params.set('status', status);
  if (q) params.set('q', q);
  if (sort) params.set('sort', sort);
  const qs = params.toString();
  const res = await api.get(`/admin/staff${qs ? `?${qs}` : ''}`, ADMIN);
  return { ...normalize(res), staff: res.data?.staff || [] };
}

/** GET /api/admin/staff/:id — one dossier (user id or invitation id). */
export async function getStaffMember(id) {
  const res = await api.get(`/admin/staff/${id}`, ADMIN);
  return { ...normalize(res), member: res.data?.member || null };
}

/** GET /api/admin/staff/:id/activity — real audit timeline (may be empty). */
export async function getStaffActivity(id) {
  const res = await api.get(`/admin/staff/${id}/activity`, ADMIN);
  return { ...normalize(res), events: res.data?.events || [] };
}

/** POST /api/admin/staff/:id/suspend — revoke access immediately. */
export async function suspendStaff(id, { reason, note } = {}) {
  const res = await api.post(`/admin/staff/${id}/suspend`, { reason, note }, ADMIN);
  return { ...normalize(res), member: res.data?.member || null };
}

/** POST /api/admin/staff/:id/reactivate — restore access. */
export async function reactivateStaff(id) {
  const res = await api.post(`/admin/staff/${id}/reactivate`, {}, ADMIN);
  return { ...normalize(res), member: res.data?.member || null };
}

/** PATCH /api/admin/staff/:id — department / phone / notes. */
export async function updateStaffProfile(id, patch) {
  const res = await api.patch(`/admin/staff/${id}`, patch, ADMIN);
  return { ...normalize(res), member: res.data?.member || null };
}

// ── Invitations ────────────────────────────────────────────────────────────

/** GET /api/admin/invitations — ledger with status counts. */
export async function listInvitations({ status, q, role } = {}) {
  const params = new URLSearchParams();
  if (status && status !== 'ALL') params.set('status', status);
  if (q) params.set('q', q);
  if (role) params.set('role', role);
  const qs = params.toString();
  const res = await api.get(`/admin/invitations${qs ? `?${qs}` : ''}`, ADMIN);
  return { ...normalize(res), invitations: res.data?.invitations || [] };
}

/**
 * POST /api/admin/invitations — issue a HANDLER invitation.
 * The response is the ONLY place the raw activation link ever appears.
 */
export async function createHandlerInvitation({
  name,
  email,
  phone,
  department,
  notes,
  // GRANULAR STAFF ACCESS — the bundle the invited account starts with. The
  // server validates every key/id against its own catalogue (422 otherwise), so
  // this is a request, never an authority.
  staffRole,
  permissions,
  fullAccess,
}) {
  const body = { name, email, phone, department, notes };
  if (fullAccess === true) body.fullAccess = true;
  else if (staffRole) {
    body.staffRole = staffRole;
    if (Array.isArray(permissions)) body.permissions = permissions;
  }
  const res = await api.post('/admin/invitations', body, ADMIN);
  return { ...normalize(res), invitation: res.data?.invitation || null };
}

/** POST /api/admin/invitations/:id/resend — new link, previous one dies. */
export async function resendInvitation(id) {
  const res = await api.post(`/admin/invitations/${id}/resend`, {}, ADMIN);
  return { ...normalize(res), invitation: res.data?.invitation || null };
}

/** POST /api/admin/invitations/:id/revoke — withdraw an unused invitation. */
export async function revokeInvitation(id, reason) {
  const res = await api.post(`/admin/invitations/${id}/revoke`, { reason }, ADMIN);
  return { ...normalize(res), invitation: res.data?.invitation || null };
}

/**
 * NOTE — activation links are NOT built here.
 *
 * The link is minted by the SERVER from one configured origin
 * (STAFF_PORTAL_URL). Screens display the returned `link` through the shared
 * presenter in services/activationLink.js, which checks it but never rewrites
 * it. Deriving an activation URL from window.location.origin would make the
 * browser the authority, so a preview domain or a local port would decide what
 * an invited colleague receives.
 */
