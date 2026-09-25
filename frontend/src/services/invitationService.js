import api from './apiClient.js';

/**
 * invitationService — Phase 20.6.2 public invitation endpoints.
 *
 * These are the only staff-console calls made WITHOUT a session: the
 * invitation token itself is the credential (256-bit, single-use, 72-hour
 * TTL). Responses keep the status code so the activation screen can render
 * its real states: 404 invalid · 410 expired · 403 revoked · 409 already
 * activated · 200 ready.
 */

/**
 * GET /api/invitations/:token
 * @returns {Promise<{ok:boolean,status:number,code?:string,invitation?:object,message?:string}>}
 */
export async function getInvitation(token) {
  const res = await api.get(`/invitations/${encodeURIComponent(token)}`);
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    invitation: res.data?.invitation || null,
    message: res.message,
  };
}

/**
 * POST /api/invitations/:token/activate — consume the invitation once and
 * create the staff account. The role comes from the invitation document;
 * the server ignores any role/owner fields sent alongside the password.
 * @returns {Promise<{ok:boolean,status:number,code?:string,account?:object,message?:string}>}
 */
export async function activateInvitation(token, password) {
  const res = await api.post(`/invitations/${encodeURIComponent(token)}/activate`, { password });
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    account: res.data?.account || null,
    message: res.message,
  };
}

/**
 * POST /api/notifications/elevation-request — the real action behind
 * "Request Elevated Clearance": every active owner admin is notified with
 * the requester identity and the denied route. Requires a staff session.
 * @returns {Promise<{ok:boolean,requested:number,message?:string}>}
 */
export async function requestElevation(path, scope = 'admin') {
  const res = await api.post('/notifications/elevation-request', { path }, { scope });
  return {
    ok: res.ok,
    requested: res.data?.requested ?? 0,
    message: res.message,
  };
}
