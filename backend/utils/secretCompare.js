/**
 * SECRET COMPARE — timing-safe comparison of two secret strings, and a random
 * secret generator for per-job leases.
 *
 * Why hashing first: `crypto.timingSafeEqual` throws on different lengths, and
 * comparing lengths at all leaks information. Hashing both sides with SHA-256
 * makes the compared buffers fixed-length, so the comparison itself is the only
 * (constant-time) work — the standard construction for bearer-token checks.
 *
 * Used by: the GPU-agent machine-token middleware, and every lease-token check
 * on the agent's job endpoints.
 */

import crypto from 'node:crypto';

/** Constant-time string comparison that never leaks length. */
export function timingSafeStringEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

/** A URL-safe random secret (24 bytes ≈ 192 bits by default). */
export function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export default { timingSafeStringEqual, randomSecret };
