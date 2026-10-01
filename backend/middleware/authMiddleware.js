import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import { ApiError } from './errorMiddleware.js';

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/**
 * A CUSTOMER identity is governed by TWO documents, and both are status-checked
 * on every request:
 *
 *   User.status     ACTIVE | SUSPENDED   — the authentication identity
 *   Customer.status Active | Inactive    — the business profile
 *
 * These are deliberately DIFFERENT vocabularies and different systems: the
 * operator lifecycle (`User.status`) covers staff, and the customer profile
 * (`Customer.status`) covers storefront buyers. This function reads ONLY the
 * customer field, ONLY for a customer identity, and never writes either — so
 * it cannot weaken or duplicate the operator lifecycle.
 *
 * Without it, marking a customer profile `Inactive` changed a display value and
 * nothing else: the session kept working. Now a deactivated customer loses
 * access on the very next request, exactly like a suspended operator, with its
 * own code so the frontend can show an honest, distinct state.
 */
async function assertCustomerProfileActive(user) {
  if (!user || user.role !== 'customer' || !user.customerId) return;
  const customer = await Customer.findById(user.customerId).select('status').catch(() => null);
  // A missing profile is not a deactivation (legacy/partial rows must keep
  // working); only an explicit Inactive status refuses access.
  if (customer && customer.status === 'Inactive') {
    throw new ApiError(
      403,
      'This customer account has been deactivated. Please contact support to restore access.',
      'ACCOUNT_INACTIVE'
    );
  }
}

/**
 * Requires a valid Bearer token; attaches req.user (from DB, not token claims)
 * so role/identity can never be forged by an edited token payload.
 */
export async function protect(req, _res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      throw new ApiError(401, 'Authentication required. Please sign in.', 'UNAUTHORIZED');
    }
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      throw new ApiError(401, 'Your session is invalid or has expired. Please sign in again.', 'UNAUTHORIZED');
    }
    const user = await User.findById(decoded.sub);
    if (!user) {
      throw new ApiError(401, 'Account no longer exists. Please sign in again.', 'UNAUTHORIZED');
    }
    // Suspended operators lose access on the very next protected request —
    // no waiting for token expiry.
    if (user.status === 'SUSPENDED') {
      throw new ApiError(403, 'This account has been suspended. Contact an administrator.', 'ACCOUNT_SUSPENDED');
    }
    // …and a deactivated customer profile loses it in the same breath.
    await assertCustomerProfileActive(user);
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * OPTIONAL authentication for routes that serve BOTH the public/storefront and
 * the staff console through one path (GET /api/products, GET /api/collections).
 *
 * The session is resolved exactly like `protect` when a Bearer token is
 * present — from the DATABASE, so role/status/permissions are per-request
 * facts — but a missing or invalid token continues as an anonymous request
 * instead of failing. A SUSPENDED account is still refused: an operator whose
 * access was just revoked must not keep browsing on a stale token.
 *
 * Purpose: let middleware/permissionMiddleware.js see the identity on a shared
 * route, so a handler whose permission was removed is refused instead of
 * silently falling back to the anonymous public branch.
 */
export async function optionalProtect(req, _res, next) {
  try {
    const token = extractToken(req);
    if (!token) return next();
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return next(); // invalid/expired token → anonymous, not an error
    }
    const user = await User.findById(decoded.sub).catch(() => null);
    if (!user) return next();
    if (user.status === 'SUSPENDED') {
      throw new ApiError(403, 'This account has been suspended. Contact an administrator.', 'ACCOUNT_SUSPENDED');
    }
    // Same rule as `protect`: a deactivated customer profile must not keep
    // browsing on a stale token, so the session is invalidated here too.
    await assertCustomerProfileActive(user);
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Restrict a protected route to the given roles. Must run after protect. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'Authentication required.', 'UNAUTHORIZED'));
    }
    if (!roles.includes(req.user.role)) {
      return next(
        new ApiError(403, 'You do not have permission to perform this action.', 'FORBIDDEN')
      );
    }
    next();
  };
}

export const adminOrHandler = requireRole('admin', 'handler');

/**
 * Phase 20.6.1 — OWNER gate. The Owner is not a fourth role: it is an
 * administrator that carries the `isOwner` designation. Must run after
 * `protect` (which re-reads the user from the database per request, so a
 * forged/edited JWT claim can never grant ownership).
 *
 * Frontend visibility (session.isOwner) is UX only — this middleware is the
 * authority for every owner-only capability.
 */
export function requireOwner(req, _res, next) {
  if (!req.user) {
    return next(new ApiError(401, 'Authentication required.', 'UNAUTHORIZED'));
  }
  if (req.user.role !== 'admin' || !req.user.isOwner) {
    return next(
      new ApiError(403, 'You do not have permission to perform this action.', 'FORBIDDEN')
    );
  }
  next();
}
