/**
 * CORS allowlist parsing and matching.
 *
 * The API is auth-bearing, so the allowlist is EXACT ORIGIN MATCHING — an
 * origin is either on the list or refused. Never a wildcard, never a reflected
 * origin. This module exists so that rule is (a) shared by the server and its
 * regression suite and (b) tolerant of the one class of mistake that silently
 * breaks a deployment without any signal: a configured entry that is not
 * byte-identical to what a browser sends.
 *
 * Browsers send a canonical serialized origin — lowercase scheme and host, no
 * path, no trailing slash (`https://store.example.com`). An operator typing
 * `https://store.example.com/` into CORS_ORIGIN (the natural way to write a
 * URL) previously produced an entry that could NEVER match: every cross-origin
 * request from the real frontend was refused, with no hint that the config was
 * the cause. Normalizing through `new URL()` maps every such spelling onto the
 * exact string a browser sends.
 *
 * Normalization cannot WIDEN the allowlist: it only ever returns a canonical
 * `scheme://host[:port]` for a syntactically valid http(s) URL. Anything that
 * cannot be canonicalized (a bare `*`, a `file:`/`chrome-extension:` value, a
 * typo like `store.example.com` with no scheme) is REJECTED and reported to
 * the caller, which logs it at boot — a live entry can never be dropped
 * silently.
 */

/** Canonical `scheme://host[:port]` for a configured entry, or '' when it is
 *  not a usable origin. Never returns a value a browser could not send. */
export function normalizeCorsOrigin(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    // No scheme (`store.example.com`) or nonsense — cannot be canonicalized.
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  // `URL#origin` lowercases the host and drops path/query/hash and any
  // trailing slash. Credentials in a configured origin are meaningless to CORS
  // and are stripped by `origin` too.
  const origin = url.origin;
  if (origin === 'null') return '';
  // The URL parser is lenient about hosts it will happily echo back — it
  // accepts `https://*` and `https://a.com,b` without complaint. Those can
  // never equal a serialized browser origin (so they are dead entries, not a
  // widening), but a wildcard character in an allowlist entry is exactly the
  // shape that invites someone to "fix" it into real pattern matching later.
  // Refuse them here so a wildcard can never be a configured value at all.
  if (/[*\s,@]/.test(origin)) return '';
  return origin;
}

/**
 * Parse the `CORS_ORIGIN` string into an exact-match allowlist.
 *
 * @param {string|undefined} raw comma-separated origins
 * @param {string} [fallback] used only when `raw` is missing/blank (the
 *        development default). Production validation requires a real value.
 * @returns {{origins: string[], rejected: string[]}} `rejected` holds entries
 *          that were dropped as unusable so the caller can shout about them.
 */
export function parseCorsOrigins(raw, fallback = 'http://localhost:3000,http://127.0.0.1:3000') {
  const source = raw && String(raw).trim() ? String(raw) : fallback;
  const origins = [];
  const rejected = [];
  const seen = new Set();
  for (const part of String(source).split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const origin = normalizeCorsOrigin(trimmed);
    if (!origin) {
      rejected.push(trimmed);
      continue;
    }
    if (seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
  }
  return { origins, rejected };
}

/** Exact-origin membership test. A request with no Origin (curl, server-to-
 *  server, Render's health check) is not a browser CORS request and is allowed
 *  by the caller before this is consulted. */
export function isOriginAllowed(origin, origins) {
  if (!origin) return true;
  if (!Array.isArray(origins) || origins.length === 0) return false;
  const canonical = normalizeCorsOrigin(origin) || String(origin).trim();
  return origins.includes(canonical);
}
