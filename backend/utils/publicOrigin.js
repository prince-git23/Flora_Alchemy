/**
 * PUBLIC FRONTEND ORIGIN (invitation link base) — ONE source of truth.
 *
 * An activation link is a FRONTEND url: the recipient opens it in a browser and
 * the SPA calls the API from there. It must therefore never be built from the
 * API's own origin (on Render that would be flora-alchemy.onrender.com) and must
 * never fall back to localhost outside development.
 *
 * Resolution order:
 *   1. STAFF_PORTAL_URL      — the documented variable (backend/.env.example)
 *   2. CLIENT_URL            — the older name, still honoured
 *   3. http://localhost:3000 — DEVELOPMENT ONLY
 *
 * FAIL CLOSED IN PRODUCTION: when NODE_ENV=production and the resolved origin is
 * missing (or is a loopback address, however it got there), link generation
 * raises 500 CONFIG_ERROR instead of returning a link nobody can open. A
 * misconfigured deploy creates no invitations — it does not mail a broken
 * credential. Nothing here is a secret: only the origin is read.
 */

import { ApiError } from '../middleware/errorMiddleware.js';

const DEV_FALLBACK = 'http://localhost:3000';

/** True for localhost / loopback / wildcard-bound development origins. */
export function isLoopbackOrigin(origin) {
  const value = String(origin || '').trim();
  if (!value) return false;

  // Checked BEFORE any URL parsing, on purpose. A bare "localhost:3000" is not
  // an absolute URL — WHATWG URL reads "localhost" as the SCHEME and yields an
  // empty hostname, which a hostname-only check would judge "not loopback" and
  // let through as a production origin. The string form closes that hole.
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(:|\/|$)/i.test(value)) return true;

  try {
    // WHATWG keeps the brackets on an IPv6 hostname ("[::1]").
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

/**
 * The origin every invitation link is built from.
 * @param {{ env?: NodeJS.ProcessEnv, strict?: boolean }} [options]
 *   strict — force the production rule (used by tests and by boot checks).
 * @throws {ApiError} 500 CONFIG_ERROR when production has no usable origin.
 */
export function publicFrontendOrigin({ env = process.env, strict = false } = {}) {
  const isProduction = strict || env.NODE_ENV === 'production';
  const configured = String(env.STAFF_PORTAL_URL || env.CLIENT_URL || '').trim().replace(/\/+$/, '');

  if (configured && !(isProduction && isLoopbackOrigin(configured))) return configured;

  if (isProduction) {
    const detail = configured
      ? 'it points at a local address'
      : 'STAFF_PORTAL_URL is not set';
    throw new ApiError(
      500,
      `Invitation links are misconfigured: ${detail}. Set STAFF_PORTAL_URL to the PUBLIC FRONTEND origin (for example https://your-store.vercel.app) and redeploy. No invitation was created.`,
      'CONFIG_ERROR'
    );
  }

  // Development / test: the local storefront is the correct origin.
  return DEV_FALLBACK;
}

/** `<origin>/admin/activate/<token>` — the one activation-route builder. */
export function activationUrlFor(rawToken, options) {
  return `${publicFrontendOrigin(options)}/admin/activate/${rawToken}`;
}

/**
 * Boot-time sanity note. Never throws (the server should still serve the API);
 * the failure surface is invitation creation, which refuses loudly.
 */
export function describeInvitationOrigin(env = process.env) {
  try {
    const origin = publicFrontendOrigin({ env });
    return { origin, ok: true, warning: null };
  } catch (err) {
    return {
      origin: null,
      ok: false,
      warning:
        `[config] Invitation links are DISABLED: ${err.message} ` +
        '(set STAFF_PORTAL_URL to the public frontend origin).',
    };
  }
}
