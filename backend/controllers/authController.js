import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import { ApiError } from '../middleware/errorMiddleware.js';

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
  };
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

    let customer = null;
    if (user.role === 'customer' && user.customerId) {
      customer = await Customer.findById(user.customerId);
    }

    res.json({
      success: true,
      token: signToken(user),
      user: publicUser(user),
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
