import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { accessView } from '../utils/permissions.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { staffIdFor, roleLabel } from '../utils/staffIdentity.js';
import { recordStaffEvent } from '../utils/staffEvents.js';
import { normalizePortal, portalFor, evaluatePortalAccess, portalHomePath } from '../utils/portals.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(user) {
  return jwt.sign({ sub: user._id.toString(), role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function publicUser(user) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    customerId: user.customerId ? user.customerId.toString() : null,
    isFixture: !!user.isFixture,
    // Phase 20.6.1 — ownership designation (admin accounts only in practice).
    // Consumed by the frontend for NAVIGATION VISIBILITY; the backend never
    // trusts it (requireOwner re-reads the user from the database).
    isOwner: user.isOwner === true,
    // Phase 21.1 — the portal this identity belongs to (server-derived, never
    // client-supplied). One of 'owner' | 'admin' | 'staff', or null for a
    // customer. Used by the frontend purely to route to the right shell; every
    // capability is still authorized server-side per request.
    portal: portalFor(user),
    // Phase 20.6.3 — staff identity for the portal shell (badge id in the
    // sidebar/header, department on the dossier). Display data only: the
    // server derives all of it from the database on every protected request.
    staffId:
      user.role === 'customer'
        ? null
        : user.staffId || staffIdFor(user, user.role, !!user.isOwner),
    roleLabel: roleLabel(user.role, user.isOwner === true),
    department: user.department || '',
    // Phase 22.4 — DISPLAY-ONLY workspace context for the portal shell
    // (business name + public slug in the sidebar). Present only when the
    // login/me responses populated the reference; authorization never reads
    // this — every request still re-derives membership from the database.
    workspace: workspaceClaim(user),
    // GRANULAR STAFF ACCESS — DISPLAY-ONLY effective permissions, computed from
    // this same database document, so the staff portal renders only the
    // navigation its role actually holds. Hidden UI is never the control: every
    // gated route re-derives the same list server-side (permissionMiddleware),
    // which is why a permission removed while a handler is signed in takes
    // effect on their very next request instead of at token expiry.
    access: user.role === 'customer' ? null : accessView(user),
  };
}

/** Populated-or-not Workspace reference → a safe display claim (or null). */
function workspaceClaim(user) {
  const ws = user.workspaceId;
  if (ws && typeof ws === 'object' && ws.slug) {
    return {
      id: ws._id ? ws._id.toString() : null,
      slug: ws.slug,
      name: ws.displayName || '',
      status: ws.status || 'ACTIVE',
    };
  }
  return null;
}

export async function register(req, res, next) {
  try {
    const { name, email, password, phone, role } = req.body || {};

    // Phase 20.6.1 — public registration is CUSTOMER-ONLY. A request that
    // tries to smuggle `role: "admin"` / `role: "handler"` (or any non-customer
    // value) is rejected outright rather than silently downgraded, so nobody
    // can mistake the endpoint for a staff-signup path. Staff accounts are
    // created only by an authorized admin (POST /api/admin/users) or by the
    // guarded provisioning script (npm run provision-admin).
    if (role !== undefined && role !== null && String(role).toLowerCase() !== 'customer') {
      throw new ApiError(
        422,
        'Staff accounts cannot be created through public registration.',
        'PRIVILEGED_ROLE_FORBIDDEN'
      );
    }

    if (!name || String(name).trim().length < 2 || String(name).trim().length > 100) {
      throw new ApiError(422, 'Please provide your full name (2–100 characters).', 'VALIDATION_ERROR');
    }
    if (phone && String(phone).replace(/\D/g, '').length > 15) {
      throw new ApiError(422, 'Please provide a valid phone number.', 'VALIDATION_ERROR');
    }
    if (!email || !EMAIL_RE.test(String(email))) {
      throw new ApiError(422, 'Please provide a valid email address.', 'VALIDATION_ERROR');
    }
    if (!password || String(password).length < 6) {
      throw new ApiError(422, 'Password must be at least 6 characters.', 'VALIDATION_ERROR');
    }

    const existing = await User.findOne({ email: String(email).toLowerCase() });
    if (existing) {
      throw new ApiError(409, 'An account with this email already exists. Please sign in.', 'EMAIL_TAKEN');
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    // Create the business profile and the auth identity atomically.
    const session = await User.startSession();
    let customer;
    let user;
    try {
      session.startTransaction();
      [customer] = await Customer.create(
        [
          {
            name: String(name).trim(),
            email: String(email).toLowerCase(),
            phone: phone || '',
            status: 'Active',
            preferences: { newsletter: true, notifications: true },
          },
        ],
        { session }
      );
      [user] = await User.create(
        [
          {
            email: String(email).toLowerCase(),
            passwordHash,
            role: 'customer',
            name: String(name).trim(),
            customerId: customer._id,
          },
        ],
        { session }
      );
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }

    res.status(201).json({
      success: true,
      token: signToken(user),
      user: publicUser(user),
      customer,
    });
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    // Phase 21.1 — optional portal context. A client may declare WHICH portal
    // it is signing into (/owner/login, /admin/login, /staff/login); the
    // server validates that the authenticated identity is actually permitted
    // there. Omitting it preserves the legacy "any staff account" behaviour.
    const requestedPortal = normalizePortal(req.body?.portal);
    if (!email || !password) {
      throw new ApiError(422, 'Email and password are required.', 'VALIDATION_ERROR');
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) {
      throw new ApiError(401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
    }

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) {
      throw new ApiError(401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
    }

    // Suspended operators are blocked at login even with valid credentials.
    if (user.status === 'SUSPENDED') {
      throw new ApiError(403, 'This account has been suspended. Contact an administrator.', 'ACCOUNT_SUSPENDED');
    }

    // Phase 21.1 — portal authorization. Credentials are proven above; this is
    // the separate question of whether THIS identity may enter THIS portal.
    // A customer, an administrator reaching for the Owner Portal, or a handler
    // reaching for the Administrator Portal is refused here — a URL can never
    // grant a role.
    if (requestedPortal) {
      const verdict = evaluatePortalAccess(user, requestedPortal);
      if (!verdict.allowed) {
        throw new ApiError(403, verdict.reason, verdict.code);
      }
    }

    let customer = null;
    if (user.role === 'customer' && user.customerId) {
      customer = await Customer.findById(user.customerId);
    }

    // Phase 20.6.4 — real "Last Active" for the staff dossier, plus a genuine
    // sign-in entry on the person's audit timeline. Deliberately AFTER the
    // suspension check (a refused sign-in is not activity) and deliberately
    // non-critical: instrumentation must never be able to break sign-in.
    if (user.role !== 'customer') {
      const now = new Date();
      user.lastActiveAt = now;
      await user.save().catch(() => {});
      await recordStaffEvent({
        user: user._id,
        staffId: user.staffId || staffIdFor(user, user.role, !!user.isOwner),
        recipientEmail: user.email,
        type: 'LOGIN',
        message: `${user.name || user.email} signed in to the staff portal.`,
        at: now,
      });
    }

    // Phase 22.4 — display-only workspace context for the session payload
    // (one extra read for scoped staff; customers/owner skip it).
    if (user.workspaceId) {
      await user.populate('workspaceId', 'slug displayName status').catch(() => {});
    }

    res.json({
      success: true,
      token: signToken(user),
      user: publicUser(user),
      // Phase 21.1 — the landing route for the resolved portal, so every client
      // routes identically instead of each page inventing its own rule.
      redirectTo: portalHomePath(portalFor(user)),
      customer,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/auth/me — current authenticated identity + customer profile. */
export async function me(req, res, next) {
  try {
    let customer = null;
    if (req.user.role === 'customer' && req.user.customerId) {
      customer = await Customer.findById(req.user.customerId);
    }
    if (req.user.workspaceId) {
      await req.user.populate('workspaceId', 'slug displayName status').catch(() => {});
    }
    res.json({
      success: true,
      user: publicUser(req.user),
      customer,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Logout is stateless (JWT). The route exists as a contract endpoint; the
 * client discards its token. Documented here for when sessions move to
 * server-side cookies/blacklists.
 */
export function logout(_req, res) {
  res.json({ success: true, message: 'Signed out.' });
}
