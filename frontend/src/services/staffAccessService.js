import api from './apiClient.js';

/**
 * staffAccessService — GRANULAR STAFF ACCESS (role template + permissions).
 *
 * Every call is session-authorized (admin scope) and returns the normalized
 * { ok, status, data, message, code } result rather than throwing, so the UI can
 * branch on the REAL server verdict (403 OWNER_REQUIRED for an administrator
 * account, 404 cross-workspace, 422 unknown permission) instead of inventing a
 * local rule that could drift from the backend.
 *
 * The catalogue comes from the SERVER on purpose: the frontend must never
 * invent a permission id the middleware cannot enforce.
 */

const ADMIN = { scope: 'admin' };

function normalize(res, key) {
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    message: res.message,
    data: key ? res.data?.[key] ?? null : res.data ?? null,
    catalogue: res.data?.catalogue || null,
    reserved: res.data?.reserved || null,
    staff: res.data?.staff || null,
    access: res.data?.access || null,
    changed: res.data?.changed || null,
  };
}

/** GET /api/admin/access/catalogue — groups, templates and the full bundle. */
export async function getAccessCatalogue() {
  const res = await api.get('/admin/access/catalogue', ADMIN);
  return normalize(res);
}

/** GET /api/admin/access/staff/:id — stored + effective access. */
export async function getStaffAccess(id) {
  const res = await api.get(`/admin/access/staff/${encodeURIComponent(id)}`, ADMIN);
  return normalize(res);
}

/**
 * PATCH /api/admin/access/staff/:id — save a role template and/or an explicit
 * permission bundle (or `fullAccess: true` for the full workspace bundle).
 */
export async function updateStaffAccess(id, { role, permissions, fullAccess } = {}) {
  const body = {};
  if (fullAccess === true) body.fullAccess = true;
  if (role !== undefined && role !== null) body.role = role;
  if (Array.isArray(permissions)) body.permissions = permissions;
  const res = await api.patch(`/admin/access/staff/${encodeURIComponent(id)}`, body, ADMIN);
  return normalize(res);
}

/**
 * The signed-in identity's own effective access (from /auth/me), used to render
 * only the staff navigation the role actually holds. DISPLAY ONLY — every gated
 * route re-derives the same list server-side.
 */
export function accessFromSession(session) {
  return session?.access || null;
}

/**
 * Was this failure an ACCESS DECISION rather than an outage?
 *
 * The permission middleware refuses a resource the role does not hold with 403
 * PERMISSION_DENIED. A screen that offers "Retry" for a connection problem must
 * not offer it here: retrying cannot grant a permission, so the button is a lie
 * about how to recover. Callers use this to say what actually happened and who
 * can change it.
 */
export function isAccessRefusal(err) {
  if (!err) return false;
  return (
    err.status === 403 ||
    err.code === 'PERMISSION_DENIED' ||
    err.code === 'FORBIDDEN' ||
    err.code === 'OWNER_REQUIRED'
  );
}

/** True when the session holds a permission (admins hold everything). */
export function sessionHasPermission(session, permission) {
  if (!session) return false;
  if (session.role === 'admin') return true;
  const list = session.access?.effective;
  if (!Array.isArray(list)) return true; // unknown → do not hide (server decides)
  return list.includes(permission);
}
