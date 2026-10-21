/**
 * AGENT AUTH MIDDLEWARE — machine authentication for the remote GPU agent API.
 *
 * This is a THIRD kind of identity, deliberately separate from both staff and
 * customer JWT sessions:
 *
 *   · it is a single long random SECRET (`THREE_WORKER_AGENT_TOKEN`), shared
 *     between the backend and the owner's PC — not an account, with no roles,
 *     no workspace of its own, and nothing to suspend;
 *   · it unlocks ONLY the routes under `/api/3d/agent`, each of which is still
 *     bound to one job by that job's own lease token;
 *   · it is compared in CONSTANT TIME (hashed, then timingSafeEqual — see
 *     utils/secretCompare.js) and is NEVER logged, echoed, or included in any
 *     payload, health output, or description;
 *   · in production the exchange must be HTTPS: the token travels on every
 *     request, and Render terminates TLS in front of the app, so `req.secure`
 *     (with TRUST_PROXY=true) is the check.
 *
 * Fail-closed everywhere: no token configured → 503 (the endpoint does not
 * exist as far as an agent is concerned), wrong/missing token → 401, plain-HTTP
 * production → 400. A rejected attempt logs the REMOTE ADDRESS and PATH only.
 */

import { ApiError } from './errorMiddleware.js';
import { timingSafeStringEqual } from '../utils/secretCompare.js';

/** Tokens shorter than this are a misconfiguration, not a credential. */
export const AGENT_TOKEN_MIN_LENGTH = 16;

function providedToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return '';
}

export function requireAgentToken(req, _res, next) {
  try {
    const configured = String(process.env.THREE_WORKER_AGENT_TOKEN || '');

    if (configured.length < AGENT_TOKEN_MIN_LENGTH) {
      throw new ApiError(
        503,
        'The GPU agent endpoint is not configured on this server. Set THREE_WORKER_AGENT_TOKEN ' +
          'to a long random secret in the backend environment (and the agent\'s environment).',
        'AGENT_NOT_CONFIGURED'
      );
    }

    // Production requires TLS: the machine credential rides on every request.
    if (process.env.NODE_ENV === 'production' && !req.secure) {
      throw new ApiError(
        400,
        'The GPU agent must connect over HTTPS in production.',
        'AGENT_HTTPS_REQUIRED'
      );
    }

    const given = providedToken(req);
    // NOTE: the supplied value is never logged, not even on failure.
    if (!given || !timingSafeStringEqual(given, configured)) {
      console.warn(`[3d-agent] rejected a machine-token attempt · ip=${req.ip} ${req.method} ${req.path}`);
      throw new ApiError(401, 'The GPU agent credential is missing or invalid.', 'AGENT_UNAUTHORIZED');
    }

    req.agent = { machine: true };
    next();
  } catch (err) {
    next(err);
  }
}

export default { requireAgentToken, AGENT_TOKEN_MIN_LENGTH };
