import rateLimit from 'express-rate-limit';

/**
 * Phase 15 — security middleware.
 *
 * Rate-limiting strategy:
 *  - /auth/login  → counts only FAILED login attempts per IP (skipSuccessfulRequests).
 *    Legitimate users (successful logins) never accumulate; password-spraying
 *    attackers are throttled. This is the real brute-force control.
 *  - /auth/register → moderate IP cap to slow mass account creation.
 *  - payments / uploads / notifications / webhook → flood control on
 *    cost-bearing or abuse-prone writes.
 *  - apiWriteLimiter → generous ceiling on remaining authenticated mutations;
 *    strict in production, permissive in development so test suites and
 *    manual testing are never throttled.
 *
 * All limits are configurable via environment for production tuning.
 */

const isProd = process.env.NODE_ENV === 'production';

function minutes(n) {
  return n * 60 * 1000;
}

function handler(req, res) {
  res.status(429).json({
    success: false,
    message: 'Too many requests. Please wait a moment and try again.',
    code: 'RATE_LIMITED',
  });
}

// ── Login — brute-force & credential stuffing ─────────────────────────────
// Counts FAILED attempts only: a successful login clears the pressure, so a
// user who fat-fingers their password twice is never blocked, while an
// attacker cycling passwords for one or many accounts hits the wall fast.
export const loginLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_LOGIN_FAILED_MAX) || (isProd ? 10 : 50),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// ── Registration — mass account creation ──────────────────────────────────
export const registerLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_REGISTER_MAX) || (isProd ? 20 : 150),
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// ── Public admin-application submissions (Phase 20.6.1) ──────────────────
// Creating an APPLICATION is free of accounts but not of storage/notifications:
// cap it near the registration class so the endpoint cannot be flooded with
// junk dossiers the owner would have to sift through.
export const applicationLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_APPLICATION_MAX) || (isProd ? 10 : 150),
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// ── Staff invitation lookup / activation (Phase 20.6.2) ─────────────────
// Both endpoints are PUBLIC and keyed by a 256-bit token, so the real risk
// is online guessing/enumeration rather than throughput. The cap sits well
// above any legitimate single activation (landing lookup + submit + retries)
// while still making sustained token probing expensive.
export const invitationLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_INVITATION_MAX) || (isProd ? 60 : 300),
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// ── Payment operations — abuse of create-order/verify ────────────────────
export const paymentLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_PAYMENT_MAX) || 150,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// ── Uploads — disk-filling / provider-cost abuse ─────────────────────────
export const uploadLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_UPLOAD_MAX) || 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// ── Notification mutations — polling is fine; writes are limited ─────────
export const notificationLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_NOTIFICATION_MAX) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// ── Webhook — provider-only endpoint; forged floods are cheap to reject ──
export const webhookLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_WEBHOOK_MAX) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// ── Generic write limiter for remaining authenticated mutations ──────────
export const apiWriteLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_API_WRITE_MAX) || (isProd ? 600 : 3000),
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/**
 * Express 4 compatible JSON body limit — rejects oversized JSON payloads
 * before they reach controllers. (express.json already has a limit; this
 * documents and enforces the same contract at the security layer.)
 */
export const REQUEST_BODY_LIMIT = '1mb';

export default {
  loginLimiter,
  registerLimiter,
  applicationLimiter,
  invitationLimiter,
  paymentLimiter,
  uploadLimiter,
  notificationLimiter,
  webhookLimiter,
  apiWriteLimiter,
  REQUEST_BODY_LIMIT,
};
