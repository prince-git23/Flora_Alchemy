import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { ApiError } from './errorMiddleware.js';

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
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
