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
 * Phase 22.4: for ADMIN invitations the landing also carries the approved
 * workspace identity (`workspaceName`/`workspaceSlug`) so the activation
 * screen can show WHICH business is being provisioned.
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
 *
 * Phase 22.4 (admin invitations only): `workspaceSlug` lets the recipient
 * choose/adjust the workspace address at activation (server-validated:
 * 422 INVALID_SLUG, 409 WORKSPACE_SLUG_TAKEN with the invitation left
 * usable). Handler activation ignores it (the workspace is inherited from
 * the inviter). The response may carry `workspace` (provisioned identity).
 * @returns {Promise<{ok:boolean,status:number,code?:string,account?:object,workspace?:object,message?:string}>}
 */
export async function activateInvitation(token, password, { workspaceSlug, name } = {}) {
  const body = { password };
  if (workspaceSlug) body.workspaceSlug = workspaceSlug;
  // The invited STAFF member sets their own full name on this screen. The
  // server treats it as the account name for handler invitations (falling back
  // to the name captured with the invitation) and ignores it for administrator
  // invitations, whose identity comes from the approved application.
  if (name) body.name = name;
  const res = await api.post(`/invitations/${encodeURIComponent(token)}/activate`, body);
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    account: res.data?.account || null,
    workspace: res.data?.workspace || res.data?.account?.workspace || null,
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
