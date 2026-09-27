/**
 * Phase 22.2/22.3 — workspace (tenant) middleware.
 *
 * Three responsibilities, all independent of any particular router so they
 * could be adopted incrementally (Phase 22.3 is when they were mounted):
 *
 *  1. `stripClientWorkspaceId` — mounted globally in server.js right after
 *     the body parsers. `workspaceId` is a SERVER-ASSIGNED fact (owner
 *     activation, invitation activation, the guarded backfill). No request —
 *     register, login, createOperator, staff profile update, invitation
 *     activation, product create — may smuggle one in, so the field is
 *     removed from the parsed body/query before any controller runs. This
 *     is what makes the new model fields non-negotiable from day one.
 *
 *  2. `requireWorkspace` (and the three gate variants below) — the gate a
 *     router mounts to become tenant-scoped. It fails closed on every
 *     unscoped state and re-reads the workspace document per request.
 *
 *  3. The gate records its DECISION on the request:
 *       req.workspaceId     — the caller's workspace (null when unscoped)
 *       req.workspaceSlug   — for namespaced uploads / settings keys
 *       req.workspaceScope  — the query filter controllers must spread into
 *                             their reads (see utils/tenancy.js)
 *       req.workspaceCompat — true in single-workspace pre-migration mode
 *       req.workspacePlatform — true for the owner acting as platform
 *
 * SINGLE-WORKSPACE COMPATIBILITY (Phase 22.3 §15): an unscoped staff identity
 * is only admitted while the platform has NO Workspace document at all — the
 * state every deployment (dev, tests, production) is in until the first
 * workspace is created by Phase 22.4/22.5. The moment one exists, membership
 * becomes mandatory and unscoped staff fail closed. This keeps the shipped
 * single-shop behaviour byte-identical while making multi-workspace
 * isolation real for any platform that has been onboarded.
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
 * Resolve the workspace gate for one request and record the decision.
 *
 *   401  not authenticated (protect has not run or rejected)
 *   403  WORKSPACE_FORBIDDEN — a customer identity (customers are owners of
 *                              their own data, never workspace members)
 *   403  WORKSPACE_REQUIRED  — owner on a workspace-scoped surface, or an
 *                              unscoped staff identity once any workspace
 *                              exists (fail closed)
 *   403  WORKSPACE_SUSPENDED — the workspace itself is suspended
 *
 * The workspace document is re-read per request (same philosophy as
 * `protect` re-reading the User): a workspace suspended a second ago must
 * stop serving immediately, and the result is not cached in the JWT.
 *
 * `allowOwner` exists for the surfaces Phase 22.3 §18/§19 deliberately keeps
 * on the platform side — the owner is NOT a workspace member (workspaceId is
 * null by design), yet must still administer Administrators, Invitations,
 * Administrator Activity, Applications and Platform Settings.
 */
async function resolveWorkspaceGate(req, { allowOwner }) {
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
  if (workspaceId) {
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
    req.workspacePlatform = false;
    req.workspaceCompat = false;
    // Phase 22.5 — STRICT scope (the legacy `$in [id, null]` branch is gone
    // after the production backfill).
    req.workspaceScope = { workspaceId };
    return;
  }

  // ── Unscoped identity ─────────────────────────────────────────────
  const isOwner = req.user.role === 'admin' && !!req.user.isOwner;
  if (isOwner && allowOwner) {
    // Platform governance: the owner sees every workspace's staff surfaces
    // (owner-only actions are still enforced per target in the controllers).
    req.workspaceId = null;
    req.workspaceSlug = null;
    req.workspacePlatform = true;
    req.workspaceCompat = false;
    req.workspaceScope = {};
    return;
  }

  // Single-workspace compatibility: only while NO workspace exists at all.
  // `exists()` runs just here (the scoped path above never pays for it).
  const anyWorkspace = await Workspace.exists({});
  if (anyWorkspace) {
    throw new ApiError(
      403,
      'This account is not attached to a workspace.',
      'WORKSPACE_REQUIRED'
    );
  }
  req.workspaceId = null;
  req.workspaceSlug = null;
  req.workspacePlatform = false;
  req.workspaceCompat = true;
  req.workspaceScope = {};
}

/**
 * Gate factory. Four exports cover the two orthogonal switches:
 *
 *   allowOwner   — the owner (platform identity) may pass this surface
 *   skipCustomers — customer routes skip the gate entirely (their access is
 *                   ownership-scoped, and customers are never members)
 */
function makeWorkspaceGate({ allowOwner = false, skipCustomers = false } = {}) {
  return async function workspaceGate(req, _res, next) {
    try {
      if (skipCustomers && req.user && req.user.role === 'customer') {
        next();
        return;
      }
      await resolveWorkspaceGate(req, { allowOwner });
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Workspace-only operational surfaces (owner included in the 403). */
export const requireWorkspace = makeWorkspaceGate();
/** Mixed customer/staff routes: customers keep their ownership path. */
export const requireWorkspaceForStaff = makeWorkspaceGate({ skipCustomers: true });
/** Platform-governance surfaces the owner retains (§18/§19). */
export const requireWorkspaceOrOwner = makeWorkspaceGate({ allowOwner: true });
/** Platform surfaces that customers may still reach (own notifications). */
export const requireWorkspaceOrOwnerForStaff = makeWorkspaceGate({
  allowOwner: true,
  skipCustomers: true,
});
