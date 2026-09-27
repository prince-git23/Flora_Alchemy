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
 *  · a document with NO workspaceId still matches; post-22.5 this can only
 *    describe a deliberate platform/legacy identity, never an operational row
 *    (all were backfilled). This helper is currently unreferenced;
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

/**
 * Phase 22.5 — the QUERY FILTER for a staff read/write (STRICT).
 *
 *   scoped staff   → `{ workspaceId: id }`
 *   anyone else    → `{}` (the gate already decided they are allowed to run
 *                     unscoped: single-workspace compatibility or platform)
 *
 * The Phase 22.3 transitional `$in: [id, null]` branch was REMOVED after the
 * production backfill (docs/MULTI-TENANT.md §11): every operational document
 * now carries a real workspaceId, so the null branch matched nothing and is
 * gone rather than retained as dead tolerance. Isolation is now STRICT; `{}`
 * remains only for deliberate unscoped identities (owner platform scope,
 * customer-global storefront reads, and the zero-workspace compat mode a
 * brand-new deployment may still be in). The filter stays a single key so it
 * composes with any other predicate, including a query with its own `$or`.
 */
export function workspaceScope(user) {
  const id = getWorkspaceId(user);
  return id ? { workspaceId: id } : {};
}

/**
 * The STRICT fragment for a workspace id that is already known — a document's
 * own `workspaceId`, an event's attribution, an invitation's binding —
 * instead of an authenticated identity. Returns `{}` for null so a genuinely
 * unscoped/platform document keeps its historical behaviour.
 */
export function workspaceIdScope(workspaceId) {
  return workspaceId ? { workspaceId } : {};
}

/**
 * Phase 22.3 — `workspaceScope` from a REQUEST that already passed a
 * `requireWorkspace*` gate. The gate stores its decision on
 * `req.workspaceScope` (so the compat/platform branches are not recomputed),
 * and falls back to the identity for callers that run without a gate.
 */
export function requestScope(req) {
  if (req && req.workspaceScope) return req.workspaceScope;
  return workspaceScope(req && req.user);
}

/** True when the scope is a real workspace restriction (not `{}`). */
export function isScopedRequest(req) {
  return Object.keys(requestScope(req)).length > 0;
}
