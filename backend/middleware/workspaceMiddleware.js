/**
 * Phase 22.2 — workspace (tenant) middleware.
 *
 * Two responsibilities, both deliberately independent of any router so they
 * can be adopted incrementally in Phase 22.3:
 *
 *  1. `stripClientWorkspaceId` — mounted globally in server.js right after
 *     the body parsers. `workspaceId` is a SERVER-ASSIGNED fact (owner
 *     activation, invitation activation, the guarded backfill). No request —
 *     register, login, createOperator, staff profile update, invitation
 *     activation, product create — may smuggle one in, so the field is
 *     removed from the parsed body/query before any controller runs. This
 *     is what makes the new model fields non-negotiable from day one.
 *
 *  2. `requireWorkspace` — the gate a router mounts when it is ready to be
 *     tenant-scoped (Phase 22.3+). It is NOT wired to any router yet: no
 *     endpoint changes behaviour in Phase 22.2, so Phase 21 semantics are
 *     preserved exactly. It fails closed on every unscoped state.
 */
import Workspace from '../models/Workspace.js';
import { getWorkspaceId } from '../utils/tenancy.js';
import { ApiError } from './errorMiddleware.js';

const MAX_SCRUB_DEPTH = 6;

function scrubValue(value, depth) {
  if (!value || typeof value !== 'object' || depth > MAX_SCRUB_DEPTH) return false;
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (scrubValue(item, depth + 1)) changed = true;
    }
    return changed;
  }
  for (const key of Object.keys(value)) {
    if (key === 'workspaceId' || key === 'workspace_id') {
      delete value[key];
      changed = true;
    } else if (scrubValue(value[key], depth + 1)) {
      changed = true;
    }
  }
  return changed;
}

/**
 * Remove any client-supplied `workspaceId` from the parsed body and query.
 * Purely mutation-of-input; it never rejects the request (a rejected request
 * would leak that the field exists), it simply makes the value impossible to
 * influence. `req.workspaceIdStripped` is set so suites can assert the scrub.
 */
export function stripClientWorkspaceId(req, _res, next) {
  try {
    let stripped = false;
    if (req.body && typeof req.body === 'object') {
      if (scrubValue(req.body, 0)) stripped = true;
    }
    if (req.query && typeof req.query === 'object') {
      if (scrubValue(req.query, 0)) stripped = true;
    }
    if (stripped) req.workspaceIdStripped = true;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Refuse the request unless the authenticated identity belongs to an ACTIVE
 * workspace. Mount AFTER `protect` (it reads `req.user`):
 *
 *   401  not authenticated (protect has not run or rejected)
 *   403  WORKSPACE_REQUIRED  — owner/customer/unscoped identity
 *   403  WORKSPACE_SUSPENDED — the workspace itself is suspended
 *   403  WORKSPACE_FORBIDDEN — a customer identity (customers are owners of
 *                              their own data, never workspace members)
 *
 * The workspace document is re-read per request (same philosophy as
 * `protect` re-reading the User): a workspace suspended a second ago must
 * stop serving immediately, and the result is not cached in the JWT.
 */
export async function requireWorkspace(req, _res, next) {
  try {
    if (!req.user) {
      throw new ApiError(401, 'Not authenticated.', 'UNAUTHORIZED');
    }
    if (req.user.role === 'customer') {
      throw new ApiError(
        403,
        'Customer accounts are not workspace members.',
        'WORKSPACE_FORBIDDEN'
      );
    }
    const workspaceId = getWorkspaceId(req.user);
    if (!workspaceId) {
      throw new ApiError(
        403,
        'This account is not attached to a workspace.',
        'WORKSPACE_REQUIRED'
      );
    }

    const workspace = await Workspace.findById(workspaceId).select('status slug').lean();
    if (!workspace) {
      throw new ApiError(
        403,
        'This account is not attached to a workspace.',
        'WORKSPACE_REQUIRED'
      );
    }
    if (workspace.status !== 'ACTIVE') {
      throw new ApiError(403, 'This workspace is suspended.', 'WORKSPACE_SUSPENDED');
    }

    req.workspaceId = workspaceId;
    req.workspaceSlug = workspace.slug;
    next();
  } catch (err) {
    next(err);
  }
}
