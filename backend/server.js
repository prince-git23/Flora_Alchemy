import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { errorHandler, notFoundHandler } from './middleware/errorMiddleware.js';
import {
  paymentLimiter,
  uploadLimiter,
  notificationLimiter,
  webhookLimiter,
  apiWriteLimiter,
  invitationLimiter,
  REQUEST_BODY_LIMIT,
} from './middleware/securityMiddleware.js';
import authRoutes from './routes/authRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import productRoutes from './routes/productRoutes.js';
import collectionRoutes from './routes/collectionRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import inventoryRoutes from './routes/inventoryRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import wishlistRoutes from './routes/wishlistRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import conversationRoutes from './routes/conversationRoutes.js';
import customRequestRoutes from './routes/customRequestRoutes.js';
import adminUserRoutes from './routes/adminUserRoutes.js';
import staffRoutes from './routes/staffRoutes.js';
import staffInvitationRoutes from './routes/staffInvitationRoutes.js';
import adminApplicationRoutes from './routes/adminApplicationRoutes.js';
import invitationRoutes from './routes/invitationRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import uploadRoutes from './routes/uploadRoutes.js';
import { seedIfEmpty } from './seed/seed.js';
import { classifyDatabase, describeDatabase } from './utils/environmentGuard.js';

// ── Production configuration validation ──────────────────────────────────
// Fail fast when critical configuration is missing in production.
function validateProductionConfig() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) return; // Development — no strict validation.

  const missing = [];

  // Critical: must have a real database
  if (!process.env.MONGO_URI) missing.push('MONGO_URI');

  // Critical: must have a real JWT secret (not the development placeholder)
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');

  // Critical: must have explicit CORS origin (never default to localhost)
  if (!process.env.CORS_ORIGIN) missing.push('CORS_ORIGIN');

  // Critical: must not seed fixtures in production
  if (process.env.SEED_ON_START === 'true') {
    console.error('[config] SEED_ON_START=true is not allowed in production. Set SEED_ON_START=false.');
    process.exit(1);
  }

  // Warn: ImageKit not configured — uploads will use local filesystem (not durable)
  if (!process.env.IMAGEKIT_PRIVATE_KEY || !process.env.IMAGEKIT_PUBLIC_KEY || !process.env.IMAGEKIT_URL_ENDPOINT) {
    console.warn('[config] WARNING: ImageKit not configured. Product image uploads will use local filesystem storage which is NOT durable across redeployments. Configure IMAGEKIT_* for production image hosting.');
  }

  // Warn: Razorpay not configured — payments will use Sample status
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.warn('[config] WARNING: Razorpay not configured. Payments will use Sample (no real charge). Configure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET for live payments.');
  }

  if (missing.length > 0) {
    console.error(`[config] PRODUCTION CONFIGURATION ERROR: Missing required environment variables: ${missing.join(', ')}`);
    console.error('[config] Set these in your production environment before starting the server.');
    process.exit(1);
  }
}

const app = express();

// Behind a reverse proxy, trust the proxy's X-Forwarded-For so rate limiting
// sees real client IPs. Disabled in direct exposure to prevent IP spoofing.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// ── Security headers (Helmet) ────────────────────────────────────────────
// The API serves JSON only — CSP can be locked down hard. crossOriginResource
// and crossOriginEmbedder are left off because the Vite frontend and Razorpay
// Checkout load cross-origin resources.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https:'],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// ── CORS — explicit allowlist, never wildcard for an auth-bearing API ────
// Development defaults to localhost origins; production MUST configure
// CORS_ORIGIN (see backend/.env.example). Non-browser clients (curl, node
// smoke tests) send no Origin header and are allowed through.
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);
// Capture the raw body for the payment webhook signature check while still
// parsing JSON normally (verify runs before body parsing).
app.use(
  express.json({
    limit: REQUEST_BODY_LIMIT,
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Health / diagnostics
// GET /api/health — liveness probe: process is alive.
app.get('/api/health', (_req, res) => {
  res.json({ success: true, service: 'flora-alchemy-api', status: 'ok', time: new Date().toISOString() });
});

// GET /api/readiness — readiness probe: critical dependencies are available.
app.get('/api/readiness', (_req, res) => {
  // Check MongoDB connection state (0=disconnected, 1=connected, 2=connecting, 3=disconnecting)
  const dbReady = mongoose.connection.readyState === 1;
  if (dbReady) {
    res.json({ success: true, status: 'ready' });
  } else {
    res.status(503).json({ success: false, status: 'not_ready' });
  }
});

// ── Rate-limited route mounting ──────────────────────────────────────
// Auth endpoints carry their own granular limiters inside authRoutes
// (failed-login brute-force control on /login, register cap on /register).
// Moderate on payments/uploads/notifications, generous on public catalogue
// reads (products/collections stay unlimited so browsing is never throttled).
app.use('/api/auth', authRoutes);
app.use('/api/customers', apiWriteLimiter, customerRoutes);
app.use('/api/orders', apiWriteLimiter, orderRoutes);
app.use('/api/products', productRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/inventory', apiWriteLimiter, inventoryRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/wishlist', apiWriteLimiter, wishlistRoutes);
app.use('/api/payments', paymentLimiter, paymentRoutes);
app.use('/api/conversations', apiWriteLimiter, conversationRoutes);
app.use('/api/custom-requests', apiWriteLimiter, customRequestRoutes);
app.use('/api/admin/users', apiWriteLimiter, adminUserRoutes);
// Phase 20.6.3 / 20.6.4 — staff directory, lifecycle and invitation
// management. Session-authorized (protect + requireRole('admin') inside each
// router), so they use the standard authenticated write ceiling rather than a
// public probing cap.
app.use('/api/admin/staff', apiWriteLimiter, staffRoutes);
app.use('/api/admin/invitations', apiWriteLimiter, staffInvitationRoutes);
// Phase 20.6.6 — PUBLIC application intake + OWNER-only review. The router
// carries its own limiters (applicationLimiter on the public submit,
// apiWriteLimiter on approve/reject) so public traffic never eats the
// shared authenticated write budget mounted above.
app.use('/api/admin-applications', adminApplicationRoutes);
// Phase 20.6.2 — invitation landing + activation are PUBLIC (the token is
// the credential) and therefore carry their own probing cap.
app.use('/api/invitations', invitationLimiter, invitationRoutes);
app.use('/api/notifications', notificationLimiter, notificationRoutes);
app.use('/api/uploads', uploadLimiter, uploadRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

// The hosting harness may inject PORT=0 ("pick a free port"); treat any
// non-positive value as unset so backend/.env controls the port.
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 4000;

// ── Graceful shutdown ───────────────────────────────────────────────────
// SIGTERM/SIGINT → stop accepting new requests → drain active requests →
// close MongoDB → exit cleanly. Idempotent: multiple signals are safe.
const SHUTDOWN_TIMEOUT_MS = 10_000; // 10 seconds max to drain
let server = null;
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return; // Idempotent guard
  shuttingDown = true;
  console.log(`[server] ${signal} received — shutting down gracefully...`);

  // Stop accepting new connections
  if (server) {
    server.close(async () => {
      console.log('[server] HTTP server closed');
      try {
        await mongoose.connection.close(false);
        console.log('[db] MongoDB connection closed');
      } catch (err) {
        console.error('[db] error closing MongoDB:', err.message);
      }
      console.log('[server] shutdown complete');
      process.exit(0);
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      console.error(`[server] forced shutdown after ${SHUTDOWN_TIMEOUT_MS}ms timeout`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref(); // unref so it doesn't keep the process alive
  } else {
    // Server hasn't started yet — close DB and exit
    mongoose.connection.close(false).catch(() => {});
    process.exit(0);
  }
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function main() {
  try {
    // Validate production configuration before doing anything else
    validateProductionConfig();

    await connectDB();
    // Phase 20.6 — say OUT LOUD which database this process is actually using.
    // Environment mistakes are silent by nature; the effective database name is
    // the one fact that makes them visible in the logs.
    console.log(`[db] connected to MongoDB — ${describeDatabase()}`);
    const dbClass = classifyDatabase();
    if (!dbClass.disposable && !dbClass.isProductionEnv) {
      console.warn(
        `[db] WARNING: this non-production process is connected to a NON-disposable database (${dbClass.dbName}). ` +
        'Fixture seeding and other writes are refused here — point MONGO_URI at a development database.'
      );
    }

    // Seed safety: reject in production, allow in development. seedIfEmpty
    // additionally refuses to write fixtures (or demo credentials) into a
    // database that is not unmistakably disposable.
    if (process.env.SEED_ON_START === 'true') {
      const created = await seedIfEmpty();
      if (created === 0) {
        console.log('[seed] no fixtures created (target database is not disposable, or already seeded)');
      } else {
        console.log(`[seed] fixtures ensured (${created} created)`);
      }
    }

    server = app.listen(PORT, () => {
      console.log(`[server] Flora Alchemy API listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] failed to start:', err.message);
    process.exit(1);
  }
}

main();
