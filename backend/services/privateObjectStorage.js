/**
 * PRIVATE OBJECT STORAGE — the driver layer behind the two private media roots.
 *
 * WHY THIS EXISTS
 * ---------------
 * `referenceAssetStorage` and `3dAssetStorage` grew up on the filesystem: a
 * private directory, a relative storage key, an authenticated route that
 * streams bytes. That works on a machine with a disk and quietly LOSES every
 * uploaded file on Render, whose app directory is replaced on every deploy —
 * so production needs the same contract over object storage, without changing
 * the contract.
 *
 * This module is that seam. `MEDIA_STORAGE_DRIVER` picks the driver:
 *
 *   fs        (default) — the existing local directory layout. Unchanged, and
 *                         the only driver used by local development and every
 *                         test suite that is not about this module.
 *   supabase            — a PRIVATE Supabase Storage bucket reached through
 *                         its documented Storage REST API with plain `fetch`
 *                         (zero dependencies), keyed with the SAME relative
 *                         keys the filesystem would have used, so a later
 *                         migration is a copy, not a rewrite.
 *
 * The earlier Cloudflare R2 driver was replaced by this one: the owner
 * requires a genuinely free setup with no payment method on file, and
 * Supabase Free documents a $0 plan (1 GB storage, 5+5 GB egress, 50 MB per
 * file — see docs/IMAGE_STUDIO.md §Storage for the sourced numbers).
 *
 * RULES THAT DID NOT MOVE
 *   · the bucket stays private — bytes are only ever read through the existing
 *     authenticated backend routes; nothing here publishes a URL or a signed
 *     link; the secret key never leaves the server and is never logged;
 *   · keys are server-derived and validated (`safeObjectKey`): a client-supplied
 *     string never becomes a key, and traversal is refused BEFORE any request
 *     is sent;
 *   · write immutability is decided by the STORAGE modules above (they own the
 *     per-kind rules); this module only performs the put/info/get/delete and
 *     reports what happened, so the filesystem and object drivers cannot
 *     disagree about policy;
 *   · a write is reconcilable: the sha256 is stored as object metadata
 *     (`x-metadata`, base64 JSON — the Storage API's documented custom-metadata
 *     channel), so an interrupted "bytes uploaded, document not yet saved" can
 *     be retried safely (the put upserts, and an info+sha comparison tells a
 *     retry from a genuine conflict);
 *   · production FAILS LOUDLY rather than writing private media into the
 *     ephemeral app directory (see `assertDurableWriteAllowed`);
 *   · objects above the free plan's 50 MB per-file limit are refused by the
 *     service with 413 and translated to a typed STORAGE_TOO_LARGE — but the
 *     real defence is upstream: MAX_GLB_BYTES (32 MiB) and the reference-image
 *     size caps refuse oversized payloads long before storage is reached.
 *
 * API SURFACE (Supabase Storage REST; every request carries `apikey`, plus
 * `Authorization: Bearer` ONLY for a LEGACY JWT service_role key — a new
 * `sb_secret_...` key must NOT be echoed into Authorization, see
 * `isNewSupabaseKey`. The key is a SERVER-ONLY secret):
 *   POST   /storage/v1/object/<bucket>/<key>            upload (x-upsert, x-metadata)
 *   GET    /storage/v1/object/info/<bucket>/<key>       metadata/size (existence)
 *   GET    /storage/v1/object/authenticated/<bucket>/<key>  download private bytes
 *   POST   /storage/v1/object/list/<bucket>             list children of a prefix
 *   DELETE /storage/v1/object/<bucket>/<key>            delete one
 *   DELETE /storage/v1/object/<bucket> {prefixes:[...]} batch delete (≤1000/call)
 * https://supabase.com/docs/guides/storage
 */

import crypto from 'node:crypto';
import { ApiError } from '../middleware/errorMiddleware.js';
import { isDurableRoot } from './privateMediaRoot.js';

export const STORAGE_DRIVERS = ['fs', 'supabase'];

/** Longest object key this system will ever use. */
export const MAX_KEY_LENGTH = 512;

/** Supabase's batch-delete limit: `prefixes` accepts at most 1000 per call. */
export const MAX_DELETE_BATCH = 1000;

/** Every object-store request is bounded; a hung service must not hang a route. */
export const OBJECT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long a CONFIRMED-PRIVATE bucket verification is trusted.
 *
 * Every write still calls the guard; the cache only avoids a second round trip
 * per upload inside this window. 60 s is short enough that an owner flipping
 * the bucket to public is caught within a minute of the next write, and long
 * enough that a burst of reference-image uploads pays one metadata GET, not
 * one per file. Only POSITIVE results are cached — a failed check is retried by
 * the very next write, so fixing the configuration takes effect immediately.
 */
export const BUCKET_PRIVACY_CACHE_TTL_MS = 60_000;

/** Bound on the bucket-details request (its own, shorter than a transfer). */
export const BUCKET_DETAILS_TIMEOUT_MS = 8_000;

/** The configured driver for private media ('fs' unless asked otherwise). */
export function storageDriver() {
  const requested = String(process.env.MEDIA_STORAGE_DRIVER || '')
    .trim()
    .toLowerCase();
  if (!requested) return 'fs';
  return STORAGE_DRIVERS.includes(requested) ? requested : 'fs';
}

/** True when the object driver (Supabase Storage) is selected. */
export function usingObjectStorage() {
  return storageDriver() === 'supabase';
}

/* ── Supabase configuration ────────────────────────────────────────────── */

function loopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

/**
 * The project's storage base URL, in exactly ONE documented way:
 *   https://<project-ref>.supabase.co
 * `SUPABASE_URL` IS that value (the same variable every Supabase tool uses).
 * Plain HTTP is accepted only for loopback hosts (the local mock suite); a
 * real project must be HTTPS because the secret key rides on every request.
 */
export function supabaseBase() {
  const raw = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !loopbackHost(url.hostname)) return '';
    return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
  } catch {
    return '';
  }
}

function supabaseSettings() {
  return {
    base: supabaseBase(),
    bucket: String(process.env.SUPABASE_STORAGE_BUCKET || '').trim(),
    secretKey: String(process.env.SUPABASE_SECRET_KEY || '').trim(),
  };
}

/**
 * Supabase's CURRENT secret keys (`sb_secret_...`) are short strings, NOT
 * JWTs, and belong in the `apikey` header ONLY: the platform parses an
 * `Authorization: Bearer` copy as a JWT and rejects the request with
 * "Invalid JWT" (supabase.com/docs/guides/getting-started/
 * migrating-to-new-api-keys). A legacy JWT `service_role` key still requires
 * BOTH headers for service-level access, so the scheme is chosen per format.
 */
export function isNewSupabaseKey(key = supabaseSettings().secretKey) {
  return typeof key === 'string' && key.startsWith('sb_secret_');
}

/** All required Supabase variables present and usable? (Never reveals values.) */
export function supabaseConfigured() {
  const s = supabaseSettings();
  return Boolean(s.base && s.bucket && s.secretKey.length >= 16 && !s.secretKey.startsWith('sb_publishable_'));
}

/** Which Supabase variables are missing/unusable, for an actionable diagnostic. */
export function supabaseMissingSettings() {
  const s = supabaseSettings();
  const missing = [];
  if (!s.base) {
    missing.push(
      String(process.env.SUPABASE_URL || '').trim()
        ? 'SUPABASE_URL (must be https://<ref>.supabase.co)'
        : 'SUPABASE_URL'
    );
  }
  if (!s.bucket) missing.push('SUPABASE_STORAGE_BUCKET');
  if (s.secretKey.startsWith('sb_publishable_')) {
    // The public CLIENT key cannot reach a private bucket from a server;
    // naming the exact mistake is the actionable diagnostic.
    missing.push('SUPABASE_SECRET_KEY (an sb_publishable_ key is public — a private bucket needs the sb_secret_ key)');
  } else if (s.secretKey.length < 16) {
    missing.push('SUPABASE_SECRET_KEY');
  }
  return missing;
}

/**
 * No HTTP client is cached — every request reads the current configuration,
 * so a rotation takes effect on the next call. This export is kept (as a
 * no-op) for API compatibility with callers/tests that used to reset the
 * cached SDK client.
 */
export function resetObjectStoreClient() {
  // A "new client" also forgets any cached privacy confirmation: callers use
  // this after changing configuration, where a stale confirmation would be
  // describing a different bucket.
  privacyCache = null;
}

/* ── keys ───────────────────────────────────────────────────────────────── */

/**
 * Validate a server-derived storage key before it touches the object store.
 * Refuses empty keys, absolute paths, traversal, backslashes, NULs and
 * over-long keys — the same guarantees `resolveStorageKey` gives the
 * filesystem, in the vocabulary object storage needs.
 */
export function safeObjectKey(key) {
  const raw = String(key || '').replace(/\\/g, '/');
  const ok =
    raw.length > 0 &&
    raw.length <= MAX_KEY_LENGTH &&
    !raw.startsWith('/') &&
    !raw.includes('\0') &&
    !raw.split('/').some((segment) => segment === '..' || segment === '' || segment === '.');
  if (!ok) {
    throw Object.assign(new Error('That object key is not a valid storage key.'), { code: 'STORAGE_KEY_INVALID' });
  }
  return raw;
}

/* ── HTTP plumbing ─────────────────────────────────────────────────────── */

function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** URL-encode every key segment so a key can never alter the request path. */
function objectPath(bucket, key) {
  const encoded = String(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/storage/v1/object/${encodeURIComponent(bucket)}/${encoded}`;
}

/**
 * One bounded fetch against the Storage API. Sends the server credential on
 * every request (header scheme chosen by key format — `apikey` only for a
 * new `sb_secret_...` key, both headers for a legacy JWT), NEVER logs it,
 * and returns the raw response for the caller to translate (status
 * semantics differ per operation).
 */
async function storageFetch(pathname, { method = 'GET', headers = {}, body, timeoutMs = OBJECT_REQUEST_TIMEOUT_MS } = {}) {
  const s = supabaseSettings();
  if (!s.base || !s.bucket || s.secretKey.length < 16 || s.secretKey.startsWith('sb_publishable_')) {
    throw Object.assign(
      new Error(`Supabase Storage is not configured (${supabaseMissingSettings().join(', ')}).`),
      { code: 'STORAGE_NOT_CONFIGURED' }
    );
  }
  let response;
  try {
    response = await fetch(`${s.base}${pathname}`, {
      method,
      headers: {
        ...(isNewSupabaseKey(s.secretKey)
          ? { apikey: s.secretKey } // new-format key: NEVER echoed into Authorization
          : { apikey: s.secretKey, Authorization: `Bearer ${s.secretKey}` }),
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network/DNS/TLS/timeout — never includes the key.
    throw Object.assign(
      new Error(`The private media storage is unreachable (${err?.name || 'network error'}).`),
      { code: 'STORAGE_UNAVAILABLE', cause: err }
    );
  }
  return { response, bucket: s.bucket };
}

/**
 * Translate a Storage API failure into the typed, safe storage failure the
 * API uses. Documented status codes: 404 NoSuchBucket/NotFound, 401
 * InvalidJWT, 403 AccessDenied, 413 EntityTooLarge.
 */
function storageError(status, ErrorCode, label) {
  const code = String(ErrorCode || '');
  let apiCode = 'STORAGE_UNAVAILABLE';
  let sentence = 'The private media storage refused the operation.';
  let http = 503;
  if (status === 413 || code === 'EntityTooLarge') {
    apiCode = 'STORAGE_TOO_LARGE';
    sentence = 'That file exceeds the storage service upload limit.';
    http = 413;
  } else if (code === 'BucketNotFound') {
    // A missing bucket is a configuration problem with the whole store —
    // checked BEFORE the 404 clause so it can never read as "file missing".
    sentence = 'The private media bucket is unavailable; check SUPABASE_STORAGE_BUCKET configuration.';
  } else if (status === 404 || code === 'NotFound' || code === 'NoSuchKey') {
    apiCode = 'STORAGE_MISSING';
    sentence = 'The stored file is missing.';
    http = 404;
  } else if (status === 401 || status === 403 || code === 'InvalidJWT' || code === 'AccessDenied') {
    sentence = 'The private media storage rejected the server credential; check SUPABASE_* configuration.';
  } else if (status >= 500 || !status) {
    sentence = 'The private media storage is unavailable; retry shortly.';
  }
  console.error(`[private-media] ${label.toLowerCase()} object-store failure · status=${status || '?'} code=${code || 'UNKNOWN'}`);
  const err = new ApiError(
    http,
    `${sentence} Nothing was changed, so it is safe to retry. (${apiCode})`,
    apiCode
  );
  return err;
}

async function errorBody(response) {
  try {
    const data = await response.json();
    return { ErrorCode: data?.error_code || data?.code || '', Message: data?.message || data?.error || '' };
  } catch {
    return { ErrorCode: '', Message: '' };
  }
}

/* ── bucket privacy guard ───────────────────────────────────────────────── */

/*
 * WHY A RUNTIME GUARD, NOT JUST A TEST
 * ------------------------------------
 * The bucket's visibility is a property of the PROJECT, not of this process. A
 * smoke test that says "private" today proves nothing about tomorrow: one
 * dashboard toggle turns every reference original, cutout and approved GLB into
 * a world-readable object for anyone who can guess a key. So the driver checks
 * the bucket's own metadata before every write, and fails CLOSED when it cannot
 * confirm privacy.
 *
 * The check is the documented bucket-details endpoint:
 *
 *   GET /storage/v1/bucket/<bucketId>   → { id, name, public, ... }
 *
 * Privacy requires ALL of:
 *   · the request succeeded (2xx) and returned JSON,
 *   · the response names THIS bucket (`id` or `name` matches exactly),
 *   · `public` is the boolean `false` — an absent or non-boolean field is NOT
 *     read as private.
 *
 * A confirmed-private result is cached for BUCKET_PRIVACY_CACHE_TTL_MS (60 s)
 * so a burst of uploads does not pay a metadata GET per file; the cached result
 * carries `cached: true` and its `ageMs`, so no caller can present it as a
 * fresh check. Failed checks are never cached. There is NO fallback to the
 * filesystem and NO attempt to change the bucket itself.
 *
 * LIMIT, stated plainly: this guard can only prevent FUTURE writes. If an owner
 * turns an existing bucket public, every object already in it is exposed until
 * the bucket is made private again — which is why the public-bucket error says
 * so, and why it is raised on the next write rather than silently tolerated.
 */

function privacyCacheKey(s) {
  return `${s.base}|${s.bucket}`;
}

/** Only a POSITIVE confirmation is cached; a null value means "not confirmed". */
let privacyCache = null;

/** Forget the cached confirmation (tests and an explicit operator re-check). */
export function resetBucketPrivacyCache() {
  privacyCache = null;
}

function bucketDetailsTimeout() {
  // Test/ops override; otherwise a bounded metadata read.
  const override = Number(process.env.STORAGE_PRIVACY_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : BUCKET_DETAILS_TIMEOUT_MS;
}

/** The cache view, with no network access (used by status when probe is off). */
function cachedPrivacy() {
  const s = supabaseSettings();
  if (!privacyCache || privacyCache.key !== privacyCacheKey(s)) {
    return {
      checked: false, cached: false, private: null, public: null,
      checkedAt: null, ageMs: null, reason: 'Privacy has not been checked in this process.',
    };
  }
  const ageMs = Date.now() - privacyCache.checkedAt;
  if (ageMs > BUCKET_PRIVACY_CACHE_TTL_MS) {
    return {
      checked: false, cached: false, private: null, public: null,
      checkedAt: new Date(privacyCache.checkedAt).toISOString(), ageMs,
      reason: `The last privacy confirmation is stale (${Math.round(ageMs / 1000)}s old).`,
    };
  }
  return {
    checked: true, cached: true, private: true, public: false,
    checkedAt: new Date(privacyCache.checkedAt).toISOString(), ageMs, reason: '',
  };
}

/**
 * Verify the configured bucket is private. NEVER throws and never leaks a
 * credential; every failure is a `private: null` (or `private: false`) result
 * with a human reason. `force` bypasses the cache for an explicit fresh check.
 */
export async function bucketPrivacy({ force = false } = {}) {
  const driver = storageDriver();
  const s = supabaseSettings();
  const blocked = (reason, extra = {}) => ({
    driver, bucket: s.bucket, checked: true, cached: false,
    private: null, public: null, checkedAt: new Date().toISOString(), ageMs: 0,
    writesBlocked: true, reason, ...extra,
  });

  if (driver !== 'supabase') {
    return {
      driver, bucket: '', checked: false, cached: false, private: null, public: null,
      checkedAt: null, ageMs: null, writesBlocked: false,
      reason: 'Filesystem driver — bucket visibility does not apply.',
    };
  }
  if (!supabaseConfigured()) {
    return {
      driver, bucket: s.bucket, checked: false, cached: false, private: null, public: null,
      checkedAt: null, ageMs: null, writesBlocked: true,
      reason: `Supabase Storage is not configured (${supabaseMissingSettings().join(', ')}).`,
    };
  }
  if (!force) {
    const cached = cachedPrivacy();
    if (cached.private === true) return { driver, bucket: s.bucket, writesBlocked: false, ...cached };
  }

  let response;
  try {
    ({ response } = await storageFetch(`/storage/v1/bucket/${encodeURIComponent(s.bucket)}`, {
      timeoutMs: bucketDetailsTimeout(),
    }));
  } catch (err) {
    return blocked(
      `The bucket privacy could not be verified because the storage service did not answer ` +
        `(${err?.code || err?.name || 'error'}).`
    );
  }

  if (!response.ok) {
    const { ErrorCode } = await errorBody(response);
    const authFailed = response.status === 401 || response.status === 403;
    // Live-verified wire detail (2026-10-21): a missing bucket answers
    // `400 NoSuchBucket`, not only 404. Both mean "this bucket does not exist".
    const missing = response.status === 404 || ErrorCode === 'NoSuchBucket' || ErrorCode === 'BucketNotFound';
    const why = missing
      ? `the bucket does not exist (HTTP ${response.status}${ErrorCode ? ` ${ErrorCode}` : ''})`
      : authFailed
        ? `the storage service rejected the server credential (HTTP ${response.status})`
        : `the bucket details request failed (HTTP ${response.status}${ErrorCode ? ` ${ErrorCode}` : ''})`;
    return blocked(`The bucket privacy could not be verified: ${why}.`, { authFailed });
  }

  let info = null;
  try {
    info = await response.json();
  } catch {
    info = null;
  }
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    return blocked('The bucket privacy could not be verified: the bucket details response was not a JSON object.');
  }

  const reportedNames = [String(info.id || ''), String(info.name || '')].filter(Boolean);
  if (!reportedNames.length) {
    return blocked('The bucket privacy could not be verified: the bucket details carried no id or name.');
  }
  if (!reportedNames.includes(s.bucket)) {
    // Identity is part of privacy: a different bucket's `public: false` must
    // never be accepted as this bucket's privacy.
    return blocked('The bucket privacy could not be verified: the storage service returned a different bucket.');
  }

  if (info.public === true) {
    return blocked(
      `The private media bucket "${s.bucket}" is PUBLIC. Anything written to it would be readable by anyone ` +
        'who can guess the key. Set the bucket to private in the Supabase dashboard (Storage → the bucket → ' +
        'Public bucket: off), review every object already in it, and retry.',
      { private: false, public: true }
    );
  }
  if (info.public !== false) {
    return blocked(
      'The bucket privacy could not be verified: the bucket details did not say `public: false` explicitly.'
    );
  }

  const checkedAt = Date.now();
  privacyCache = { key: privacyCacheKey(s), checkedAt };
  return {
    driver, bucket: s.bucket, checked: true, cached: false, private: true, public: false,
    checkedAt: new Date(checkedAt).toISOString(), ageMs: 0, writesBlocked: false, reason: '',
  };
}

/**
 * FAIL-CLOSED write gate: throws a typed 503 unless the bucket is confirmed
 * private. Used by `putObject`, so no new private-media write can happen while
 * privacy is unknown, public, or unverifiable. Never touches the filesystem.
 */
export async function assertBucketPrivate(opts = {}) {
  if (!usingObjectStorage()) return { writesBlocked: false };
  if (!supabaseConfigured()) {
    // Preserve the driver's existing configuration error for this state — it is
    // more actionable than "privacy unverified" and the callers already handle it.
    throw new ApiError(
      503,
      `Supabase Storage is not configured (${supabaseMissingSettings().join(', ')}). Nothing was written. (STORAGE_NOT_CONFIGURED)`,
      'STORAGE_NOT_CONFIGURED'
    );
  }
  const status = await bucketPrivacy(opts);
  if (status.private === true) return status;
  if (status.authFailed) {
    // A rejected credential is a storage/config failure, not an ambiguous
    // privacy state: keep the driver's existing typed error for it.
    throw new ApiError(
      503,
      'The private media storage rejected the server credential; check SUPABASE_* configuration. ' +
        'Nothing was written. (STORAGE_UNAVAILABLE)',
      'STORAGE_UNAVAILABLE'
    );
  }
  if (status.public === true) {
    throw new ApiError(
      503,
      `The private media bucket is PUBLIC, so nothing was written — a file there would be readable by ` +
        'anyone with the key. Make the bucket private in the Supabase dashboard (Storage → the bucket → ' +
        'Public bucket: off), then review any object written while it was public and retry. ' +
        'Nothing fell back to the local filesystem. (STORAGE_BUCKET_PUBLIC)',
      'STORAGE_BUCKET_PUBLIC'
    );
  }
  throw new ApiError(
    503,
    `The private media bucket could not be confirmed private. ${status.reason} Nothing was written, and ` +
      'nothing fell back to the local filesystem, so it is safe to retry once the configuration is fixed. ' +
      '(STORAGE_PRIVACY_UNVERIFIED)',
    'STORAGE_PRIVACY_UNVERIFIED'
  );
}

/* ── object operations ──────────────────────────────────────────────────── */

/**
 * Put bytes. `metadata` is stored through the API's `x-metadata` channel
 * (base64-encoded JSON — the encoding supabase-js itself uses); sha256 is
 * always included. `x-upsert: true` keeps the put idempotent so an interrupted
 * write can be retried with identical bytes (a DIFFERENT-bytes overwrite is
 * refused by the storage modules above, not here).
 */
export async function putObject({ key, buffer, contentType = 'application/octet-stream', metadata = {} } = {}) {
  const safeKey = safeObjectKey(key);
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!body.length) {
    throw Object.assign(new Error('An object body is required.'), { code: 'VALIDATION_ERROR' });
  }
  // PRIVACY GATE: checked before the first byte is sent. A public or
  // unverifiable bucket must never receive a new private object.
  await assertBucketPrivate();
  const s = supabaseSettings();
  const { response } = await storageFetch(objectPath(s.bucket, safeKey), {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'x-upsert': 'true',
      'x-metadata': Buffer.from(JSON.stringify({ ...metadata, sha256: sha256Of(body) })).toString('base64'),
    },
    body,
  });
  if (!response.ok) {
    const { ErrorCode } = await errorBody(response);
    // A 404 here is a missing BUCKET — a configuration problem with the whole
    // store, never "file missing" — so it reports as unavailable, not MISSING.
    throw storageError(
      response.status === 404 ? 503 : response.status,
      ErrorCode || (response.status === 404 ? 'BucketNotFound' : ''),
      '3D media'
    );
  }
  return { key: safeKey, bytes: body.length, sha256: sha256Of(body) };
}

/** Info for one object (size + custom metadata). Null when it does not exist. */
export async function headObject(key) {
  const safeKey = safeObjectKey(key);
  const s = supabaseSettings();
  const { response } = await storageFetch(`/storage/v1/object/info/${encodeURIComponent(s.bucket)}/${safeKey.split('/').map(encodeURIComponent).join('/')}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    const { ErrorCode } = await errorBody(response);
    // The REAL service answers a missing object with 400 NoSuchKey as well as
    // 404 NotFound (observed against a live project, 2026-10-20) — both mean
    // "absent" here. BucketNotFound keeps its own code and still throws.
    if (ErrorCode === 'NotFound' || ErrorCode === 'NoSuchKey') return null;
    throw storageError(response.status, ErrorCode, '3D media');
  }
  const info = await response.json();
  return {
    key: safeKey,
    bytes: Number(info?.size || 0),
    sha256: String(info?.metadata?.sha256 || ''),
    // Live projects report the MIME as top-level snake_case `content_type`
    // (observed 2026-10-20); other shapes used `mimeType` or a nested
    // mimetype — read every known shape, first non-empty wins.
    contentType: String(info?.content_type || info?.mimeType || info?.metadata?.mimetype || ''),
    lastModified: String(info?.last_modified || '') || null,
  };
}

/** Read one object's bytes, or null when it does not exist. */
export async function getObject(key) {
  const safeKey = safeObjectKey(key);
  const s = supabaseSettings();
  const { response } = await storageFetch(
    `/storage/v1/object/authenticated/${encodeURIComponent(s.bucket)}/${safeKey.split('/').map(encodeURIComponent).join('/')}`
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const { ErrorCode } = await errorBody(response);
    // 400 NoSuchKey (live shape) / 404 NotFound both mean "absent" — the
    // download of a missing object must answer null, never throw.
    if (ErrorCode === 'NotFound' || ErrorCode === 'NoSuchKey') return null;
    throw storageError(response.status, ErrorCode, '3D media');
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Delete one object. A missing object is not an error. */
export async function deleteObject(key) {
  const safeKey = safeObjectKey(key);
  const s = supabaseSettings();
  const { response } = await storageFetch(objectPath(s.bucket, safeKey), { method: 'DELETE' });
  if (response.status === 404) return;
  if (!response.ok) {
    const { ErrorCode } = await errorBody(response);
    // Already absent = idempotent success, in either observed shape.
    if (ErrorCode === 'NotFound' || ErrorCode === 'NoSuchKey') return;
    throw storageError(response.status, ErrorCode, '3D media');
  }
}

/**
 * The listing primitive: the IMMEDIATE children of one folder prefix. Objects
 * come back with their `name` (relative to the prefix) and `id` (null for a
 * folder). Pagination honours the documented `limit`/`offset` body fields.
 */
async function listChildren(folder, { limit = 1000, offset = 0, search = '' } = {}) {
  const s = supabaseSettings();
  const { response } = await storageFetch(`/storage/v1/object/list/${encodeURIComponent(s.bucket)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: folder, limit, offset, ...(search ? { search } : {}) }),
  });
  if (!response.ok) {
    const { ErrorCode } = await errorBody(response);
    throw storageError(response.status, ErrorCode, '3D media');
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

/**
 * Delete every object under a prefix (one asset's whole directory). Walks the
 * folder tree breadth-first, then deletes in batches of ≤1000 — the documented
 * `remove` limit — and ONLY from explicit removal paths, never by a loop of
 * API calls per file.
 */
export async function deletePrefix(prefix) {
  const safePrefix = safeObjectKey(prefix);
  const folders = [safePrefix];
  const files = [];
  while (folders.length) {
    const folder = folders.pop();
    let offset = 0;
    for (;;) {
      const rows = await listChildren(folder, { limit: 1000, offset });
      for (const row of rows) {
        const name = String(row?.name || '');
        if (!name) continue;
        const full = `${folder}/${name}`;
        if (row?.id === null || name.endsWith('/')) folders.push(full.replace(/\/+$/, ''));
        else files.push(full);
      }
      if (rows.length < 1000) break;
      offset += rows.length;
    }
  }
  for (let i = 0; i < files.length; i += MAX_DELETE_BATCH) {
    const batch = files.slice(i, i + MAX_DELETE_BATCH);
    if (!batch.length) continue;
    const s = supabaseSettings();
    const { response } = await storageFetch(`/storage/v1/object/${encodeURIComponent(s.bucket)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: batch }),
    });
    if (!response.ok) {
      const { ErrorCode } = await errorBody(response);
      throw storageError(response.status, ErrorCode, '3D media');
    }
  }
}

/**
 * Find an existing object by key PREFIX (used by the reference store's
 * by-KIND immutability rule, where the extension varies but "at most one
 * original" must hold). Supabase's list takes a FOLDER prefix plus a `search`
 * fragment, so the key prefix is split into its directory and its name stem;
 * the first matching child's head is returned.
 */
export async function findObjectByPrefix(prefix) {
  const safePrefix = safeObjectKey(prefix);
  const cut = safePrefix.lastIndexOf('/');
  const folder = cut === -1 ? '' : safePrefix.slice(0, cut);
  const stem = cut === -1 ? safePrefix : safePrefix.slice(cut + 1);
  const rows = await listChildren(folder, { limit: 100, search: stem });
  const hit = rows.find((row) => String(row?.name || '').startsWith(stem) && row?.id !== null);
  if (!hit) return null;
  return headObject(`${folder ? `${folder}/` : ''}${hit.name}`);
}

/* ── status / production guard ──────────────────────────────────────────── */

/**
 * A non-throwing, SECRET-FREE description for health output and the readiness
 * report: which driver, whether configured, whether usable. `probe` performs a
 * bounded round trip (an empty-prefix list) so "usable" means the bucket
 * actually answered — without writing anything.
 */
export async function objectStoreStatus({ probe = false } = {}) {
  const driver = storageDriver();
  if (driver !== 'supabase') {
    return {
      driver, configured: false, usable: null, checked: false, writesBlocked: false,
      privacy: { checked: false, private: null, public: null, reason: 'Not applicable to the filesystem driver.' },
      reason: 'Filesystem driver (local development / tests).',
    };
  }
  const configured = supabaseConfigured();
  const base = {
    driver,
    configured,
    usable: null,
    checked: false,
    // Supabase Storage is durable by construction — the bucket is not the app
    // directory and survives redeploys.
    durable: true,
    endpointSet: Boolean(supabaseBase()),
    bucketSet: Boolean(supabaseSettings().bucket),
  };
  if (!configured) {
    return {
      ...base,
      writesBlocked: true,
      privacy: { checked: false, private: null, public: null, reason: 'Not configured.' },
      reason: `Missing: ${supabaseMissingSettings().join(', ')}.`,
    };
  }

  // `probe: false` must stay network-free: it reports only a confirmation THIS
  // process already obtained, and says so honestly when there is none.
  if (!probe) {
    const privacy = cachedPrivacy();
    return {
      ...base,
      privacy,
      writesBlocked: privacy.private !== true,
      reason: 'Configured (not probed).',
    };
  }

  const privacy = await bucketPrivacy({ force: true });
  const view = {
    checked: privacy.checked,
    cached: privacy.cached,
    private: privacy.private,
    public: privacy.public,
    checkedAt: privacy.checkedAt,
    ageMs: privacy.ageMs,
    reason: privacy.reason,
  };
  let reachable = true;
  try {
    const rows = await listChildren('', { limit: 1 });
    void rows;
  } catch (err) {
    reachable = false;
    if (privacy.private === true) {
      // The list probe failed but privacy was confirmed; report the transfer
      // probe honestly rather than borrowing the privacy result.
      return {
        ...base, privacy: view, usable: false, checked: true, writable: false,
        writesBlocked: true, errorCode: err?.code || 'STORAGE_UNAVAILABLE',
        reason: `The bucket refused the probe (${err?.code || 'error'}).`,
      };
    }
  }
  if (privacy.private !== true) {
    return {
      ...base, privacy: view, usable: false, checked: true, writable: false,
      writesBlocked: true,
      errorCode: privacy.public === true ? 'STORAGE_BUCKET_PUBLIC' : 'STORAGE_PRIVACY_UNVERIFIED',
      reason: privacy.reason || 'The bucket privacy could not be verified.',
    };
  }
  return {
    ...base, privacy: view, usable: reachable, checked: true, writable: reachable,
    writesBlocked: !reachable, reason: 'The bucket answered and is private.',
  };
}

/**
 * PRODUCTION GUARD — private media must not be written into the ephemeral app
 * directory. Render replaces that directory on every deploy, so a silent write
 * there is a SLOW DATA LOSS: the row survives, the bytes do not. In production
 * the write is refused with the exact fix instead.
 */
export function assertDurableWriteAllowed({ root, label = 'Private media' } = {}) {
  if (process.env.NODE_ENV !== 'production') return;
  if (usingObjectStorage() && supabaseConfigured()) return;
  if (root && isDurableRoot(root)) return;
  throw new ApiError(
    503,
    `${label} is configured to write into the ephemeral deploy directory, which is erased on every ` +
      'deploy. Set MEDIA_STORAGE_DRIVER=supabase with the SUPABASE_URL, SUPABASE_STORAGE_BUCKET and ' +
      'SUPABASE_SECRET_KEY variables, or point the media root at a persistent disk. ' +
      'See docs/IMAGE_STUDIO.md §Storage. (STORAGE_NOT_DURABLE)',
    'STORAGE_NOT_DURABLE'
  );
}

export default {
  STORAGE_DRIVERS,
  storageDriver,
  usingObjectStorage,
  supabaseConfigured,
  supabaseMissingSettings,
  supabaseBase,
  isNewSupabaseKey,
  resetObjectStoreClient,
  safeObjectKey,
  putObject,
  headObject,
  getObject,
  deleteObject,
  deletePrefix,
  findObjectByPrefix,
  objectStoreStatus,
  bucketPrivacy,
  assertBucketPrivate,
  resetBucketPrivacyCache,
  assertDurableWriteAllowed,
};
