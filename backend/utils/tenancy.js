/**
 * Phase 22.2 — tenancy helpers.
 *
 * Every helper here is READ-SIDE and dependency-light so both the middleware
 * and the individual controllers can share one definition of "which
 * workspace does this request belong to". None of them touch the database —
 * the membership fact comes from `req.user.workspaceId`, which `protect`
 * re-reads from the User document on every request (never from token claims).
 *
 * Phase 22.2 ships these as the CONTRACT for Phase 22.3: the operational
 * controllers start calling `workspaceFilter(req.user)` when their queries
 * are scoped. Until a router opts in (via `requireWorkspace`), an absent
 * workspaceId simply means "single-workspace mode" and nothing changes.
 */
import mongoose from 'mongoose';
import { ApiError } from '../middleware/errorMiddleware.js';

/**
 * Normalise a membership value to a real ObjectId, or null when the identity
 * is unscoped (owner/customer/pre-migration rows) or unusable input.
 */
export function getWorkspaceId(user) {
  const raw = user && user.workspaceId;
  if (!raw) return null;
  if (raw instanceof mongoose.Types.ObjectId) return raw;
  const str = String(raw);
  return mongoose.isValidObjectId(str) ? new mongoose.Types.ObjectId(str) : null;
}

/**
 * The canonical tenant filter for a query: `{ workspaceId }`.
 *
 * FAILS CLOSED — an identity with no workspace cannot be allowed to read a
 * shared collection once the collection is scoped, so asking for a filter
 * without membership is a 403, not an empty/greedy filter. (Passing
 * `requireWorkspace: false` opts into the transitional single-workspace
 * behaviour, where `{}` is returned and the query stays unscoped.)
 */
export function workspaceFilter(user, { requireWorkspace = true } = {}) {
  const workspaceId = getWorkspaceId(user);
  if (!workspaceId) {
    if (!requireWorkspace) return {};
    throw new ApiError(
      403,
      'This account is not attached to a workspace.',
      'WORKSPACE_REQUIRED'
    );
  }
  return { workspaceId };
}

/**
 * Membership assertion for cross-document reads: the document's workspace
 * must be the caller's workspace. Two deliberate quirks:
 *
 *  · a document with NO workspaceId matches (Phase 22.2 single-workspace
 *    legacy data stays readable by everyone who is already authorized by
 *    ownership/role checks — isolation is tightened only in Phase 22.5);
 *  · mismatch and suspended workspace both report the SAME 403 so a caller
 *    cannot probe which workspaces exist.
 */
export function assertWorkspaceMember(user, document, { what = 'resource' } = {}) {
  const caller = getWorkspaceId(user);
  const owner = getWorkspaceId(document);
  if (!owner) return true; // unscoped legacy document — not a cross-tenant leak yet
  if (caller && String(caller) === String(owner)) return true;
  throw new ApiError(403, `This ${what} belongs to another workspace.`, 'WORKSPACE_MISMATCH');
}

/** Convenience: the plain string form (for logs / audit output). */
export function workspaceIdString(user) {
  const id = getWorkspaceId(user);
  return id ? String(id) : '';
}
