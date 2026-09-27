import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import jwt from 'jsonwebtoken';
import { workspaceScope } from './tenancy.js';

/**
 * Phase 22.3 — optional STAFF context for the PUBLIC catalogue reads.
 *
 * Products and collections serve two callers through one route:
 *   · the storefront (no token)     → public. The workspace comes from the
 *                                     STOREFRONT CONTEXT (today: the single
 *                                     shared storefront, so unscoped) — never
 *                                     from whoever happens to be signed in;
 *   · a staff token on the portal   → the portal's list/detail view, which
 *                                     must only see its own workspace.
 *
 * The identity is re-read from the database (role + status + workspaceId),
 * never taken from the JWT claim: a suspended or deleted staff token must not
 * keep revealing Hidden products, and membership is a per-request fact. This
 * replaces the Phase-14 `isStaffRequest` helper whose JWT-role-only trust was
 * an audit finding (Phase 22.1, HIGH).
 *
 * Returns `{ staff, user, scope }` where `scope` is the query filter to spread
 * into a catalogue read (`{}` for the public/storefront case).
 */
export async function catalogueContext(req) {
  const header = (req && req.headers && req.headers.authorization) || '';
  if (!header.startsWith('Bearer ')) return { staff: false, user: null, scope: {} };
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (!['admin', 'handler'].includes(decoded.role)) {
      return { staff: false, user: null, scope: {} };
    }
    const user = await User.findById(decoded.sub).select('role status workspaceId').lean();
    if (!user || user.status === 'SUSPENDED') return { staff: false, user: null, scope: {} };
    // Phase 22.3 — catalogue reads are ungated (the storefront has no
    // session), so both workspace checks happen right here:
    //  · a member whose workspace is suspended/deleted degrades to the public
    //    view instead of keeping portal visibility;
    //  · an identity with NO membership only keeps the staff view while the
    //    platform has zero workspaces (single-workspace compatibility) — the
    //    moment one exists, membership is mandatory (same fail-closed rule as
    //    requireWorkspace), so a pre-migration token can never keep reading
    //    other tenants' Hidden products.
    if (user.workspaceId) {
      const workspace = await Workspace.findById(user.workspaceId).select('status').lean();
      if (!workspace || workspace.status !== 'ACTIVE') {
        return { staff: false, user: null, scope: {} };
      }
    } else if (await Workspace.exists({})) {
      return { staff: false, user: null, scope: {} };
    }
    return { staff: true, user, scope: workspaceScope(user) };
  } catch {
    return { staff: false, user: null, scope: {} };
  }
}
