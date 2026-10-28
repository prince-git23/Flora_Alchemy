/**
 * threeGlbService — 3D Studio (Phase 2) client for `/api/3d`.
 *
 * ALL generation/asset HTTP lives here (a page or component never calls the API
 * itself), and it goes through the shared transports in apiClient:
 *
 *   · `api.get/post/delete` for JSON — same normalized { ok, status, data,
 *     message, code } envelope every other service uses;
 *   · a bare `fetch` ONLY for reading model bytes. That is a constraint, not a
 *     workaround: a generated GLB lives in a PRIVATE root and is served only
 *     behind a bearer token, and neither <img> nor three.js' GLTFLoader can
 *     attach one to its own request. So the bytes are fetched here with the
 *     admin token, turned into a Blob, and handed to the viewer as an object
 *     URL — which is why this file owns the fetch and no component does.
 *
 * THE ASSET SHAPE. Assets are returned as the backend's `publicAssetProjection`,
 * which deliberately OMITS the raw storage key (that is an implementation
 * detail of the private root). It carries `id`, `hasModel`, `thumbnail`-worth of
 * metadata and the validation/approval trail instead. So a media URL is built
 * from `(productSlug, asset.id, kind)` — never from a storage key, and never
 * from a field that only exists on the server.
 */

import api, { API_BASE_URL, getToken } from './apiClient.js';

/** Which qualities the server accepts (mirrors services/3dModelProvider.js). */
export const QUALITIES = ['draft', 'standard', 'high'];

/** Job states the studio renders, and the two that mean "still working". */
export const JOB_ACTIVE_STATUSES = ['QUEUED', 'GENERATING', 'POST_PROCESSING'];
export const JOB_FINAL_STATUSES = ['APPROVED', 'REJECTED', 'FAILED', 'CANCELLED'];

/** Poll cadence for a running job. The server polls its provider every 5s. */
export const JOB_POLL_MS = 4000;

/* ── Bounded private-media reads ────────────────────────────────────────────
 *
 * A `fetch` has NO default timeout. That is fine for a JSON call that fails
 * fast, and wrong for a 20 MB binary read: a connection that opens and then
 * stalls — a cold instance, a proxy holding the stream, a bucket that never
 * answers — leaves the promise pending forever, and the viewer above it can
 * only wait. That is exactly how the 3D Model Studio sat on “Loading the 3D
 * model…” with no error and no Retry. Every private read below is therefore
 * bounded, cancelled through an AbortController, and reported as a TYPED
 * failure the viewer can explain.
 */

/** Read a positive number from the build environment, or use the fallback. */
function envMs(name, fallback) {
  try {
    const raw = Number(import.meta.env?.[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Default ceiling for ONE private media read. 120 s is deliberately generous —
 * a 32 MB GLB over a slow mobile link is a legitimate minute — because this is
 * a "the request is dead" bound, not a performance target. The browser suite
 * shortens it through the E2E build so a stalled request is provable in seconds.
 */
export const ASSET_FETCH_TIMEOUT_MS = envMs('VITE_GLB_FETCH_TIMEOUT_MS', 120_000);

/** The server's own GLB ceiling is 32 MB (services/3dModelValidation.js); a
 *  response larger than this is not a model we can render, whatever its type. */
export const MAX_ASSET_BYTES = 32 * 1024 * 1024;

/** A typed, explainable media failure. `code` is for the viewer, `status` for
 *  diagnostics; neither is ever a bearer token. */
function mediaError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function acceptContentType(kind, header) {
  const type = String(header || '').toLowerCase().split(';')[0].trim();
  // An absent type is tolerated: a proxy may strip it, and the bytes are
  // validated by the parser anyway. A WRONG type is refused by name, because
  // "the server sent a web page" is a very different failure from "bad GLB".
  if (!type) return '';
  if (kind === 'thumbnail') {
    return type.startsWith('image/') ? '' : type;
  }
  if (type === 'model/gltf-binary' || type === 'application/octet-stream') return '';
  return type;
}

function fail(res, fallback) {
  const err = new Error(res?.message || fallback);
  err.code = res?.code || 'API_ERROR';
  err.status = res?.status;
  return err;
}

/** Throw the server's refusals as a real Error so callers can show the reason. */
async function unwrap(promise, fallback) {
  const res = await promise;
  if (!res.ok) throw fail(res, fallback);
  return res.data;
}

/* ── Provider capability ─────────────────────────────────────────────────── */

/**
 * Whether generation is possible on THIS server, and with what.
 *
 * `available: false` is a normal, expected answer — the default deployment has
 * no local GPU worker and Meshy is opt-in — so this is a successful read that
 * the studio renders as an explanation, never as an error.
 */
export async function getProviderStatus() {
  const data = await unwrap(api.get('/3d/provider', { scope: 'admin' }), 'The model provider could not be described.');
  return { provider: data.provider || null, health: data.health || null };
}

/* ── Studio state for one product ────────────────────────────────────────── */

/** One request for the whole screen: provider, reference plan, jobs, assets. */
export async function getStudioState(productSlug) {
  const data = await unwrap(
    api.get(`/3d/products/${encodeURIComponent(productSlug)}/studio`, { scope: 'admin' }),
    'The 3D studio could not be loaded.'
  );
  return {
    productSlug: data.productSlug || productSlug,
    provider: data.provider || null,
    plan: data.plan || null,
    jobs: data.jobs || [],
    assets: data.assets || [],
    approved: data.approved || null,
    canGenerate: Boolean(data.canGenerate),
  };
}

export async function listJobs(productSlug) {
  const data = await unwrap(
    api.get(`/3d/products/${encodeURIComponent(productSlug)}/jobs`, { scope: 'admin' }),
    'The generation history could not be loaded.'
  );
  return data.jobs || [];
}

export async function listAssets(productSlug) {
  const data = await unwrap(
    api.get(`/3d/products/${encodeURIComponent(productSlug)}/assets`, { scope: 'admin' }),
    'The model history could not be loaded.'
  );
  return { assets: data.assets || [], approved: data.approved || null };
}

/** The product's single approved model, or null when it has none. */
export async function getCurrentAsset(productSlug) {
  const data = await unwrap(
    api.get(`/3d/products/${encodeURIComponent(productSlug)}/assets/current`, { scope: 'admin' }),
    'The approved model could not be loaded.'
  );
  return data.asset || null;
}

/* ── Starting and steering work ──────────────────────────────────────────── */

/**
 * Start a generation. The server answers 201 with the job already claimed and
 * running in the background, so the caller polls rather than waiting here.
 */
export async function startGeneration(productSlug, { referenceIds = [], quality = 'standard', notes = '', label = '' } = {}) {
  const data = await unwrap(
    api.post(
      `/3d/products/${encodeURIComponent(productSlug)}/jobs`,
      { referenceIds, quality, notes, label },
      { scope: 'admin' }
    ),
    'The generation could not be started.'
  );
  return { job: data.job, provider: data.provider || null };
}

export async function getJob(jobId) {
  const data = await unwrap(api.get(`/3d/jobs/${encodeURIComponent(jobId)}`, { scope: 'admin' }), 'That job could not be loaded.');
  return data.job;
}

export async function retryJob(jobId) {
  const data = await unwrap(
    api.post(`/3d/jobs/${encodeURIComponent(jobId)}/retry`, {}, { scope: 'admin' }),
    'That job could not be retried.'
  );
  return { job: data.job, previousJobId: data.previousJobId, provider: data.provider || null };
}

export async function cancelJob(jobId) {
  const data = await unwrap(
    api.post(`/3d/jobs/${encodeURIComponent(jobId)}/cancel`, {}, { scope: 'admin' }),
    'That job could not be cancelled.'
  );
  return data.job;
}

/**
 * Approve the candidate a job produced.
 *
 * `assetId` is optional: the server resolves the job's single candidate itself,
 * and refuses with 409 when the choice is genuinely ambiguous. Passing an id the
 * client just read adds a way to get it wrong without adding safety.
 */
export async function approveJob(jobId, { assetId = '', reviewNote = '', override = false, overrideReason = '' } = {}) {
  /* PHASE 5 — `reviewNote` and the override are DECISIONS, not verdicts. The
     server re-measures the model itself and refuses with QUALITY_REVIEW_REQUIRED
     or QUALITY_BLOCKED when the gate disagrees, so nothing here can manufacture
     a pass: no quality field is ever sent. */
  const body = {};
  if (assetId) body.assetId = assetId;
  if (reviewNote) body.reviewNote = reviewNote;
  if (override) {
    body.overrideQuality = true;
    body.overrideReason = overrideReason;
  }
  const data = await unwrap(
    api.post(`/3d/jobs/${encodeURIComponent(jobId)}/approve`, body, { scope: 'admin' }),
    'That model could not be approved.'
  );
  return {
    asset: data.asset,
    replacedAssetId: data.replacedAssetId || null,
    quality: data.quality || null,
  };
}

/** Reject a candidate. Any already-approved model is left exactly as it was. */
export async function rejectJob(jobId, { assetId = '', reason = '' } = {}) {
  const data = await unwrap(
    api.post(
      `/3d/jobs/${encodeURIComponent(jobId)}/reject`,
      assetId ? { assetId, reason } : { reason },
      { scope: 'admin' }
    ),
    'That model could not be rejected.'
  );
  return { asset: data.asset, productStillHasApprovedModel: Boolean(data.productStillHasApprovedModel) };
}

export async function getAsset(assetId) {
  const data = await unwrap(api.get(`/3d/assets/${encodeURIComponent(assetId)}`, { scope: 'admin' }), 'That model could not be loaded.');
  return data.asset;
}

/** Remove a non-approved candidate and its files. */
export async function deleteAsset(assetId) {
  const data = await unwrap(
    api.delete(`/3d/assets/${encodeURIComponent(assetId)}`, { scope: 'admin' }),
    'That model could not be removed.'
  );
  return data;
}

/**
 * PHASE 9 — record the staff ORIENTATION correction on an asset.
 *
 * A whole number of 90-degree Y turns (normalised server-side, 0–3). This is a
 * presentation fact stored beside the asset, not a rewrite of the bytes: the
 * viewer applies it once at load, and the storefront's public projection
 * carries it to customers with the approved model.
 */
export async function setOrientation(assetId, yawQuarterTurns) {
  const data = await unwrap(
    api.post(
      `/3d/assets/${encodeURIComponent(assetId)}/orientation`,
      { yawQuarterTurns },
      { scope: 'admin' }
    ),
    'The orientation could not be recorded.'
  );
  return data.asset;
}

/* ── Private media ───────────────────────────────────────────────────────── */

/** The authenticated media path for one asset file. `kind` is `model` | `thumbnail`. */
export function mediaPath(productSlug, assetId, kind) {
  return `${API_BASE_URL}/3d/media/${encodeURIComponent(productSlug)}/${encodeURIComponent(assetId)}/${kind}`;
}

/**
 * Fetch an asset's bytes with the admin token and return a Blob.
 *
 * BOUNDED AND TYPED. The request is aborted after `timeoutMs` (default
 * `ASSET_FETCH_TIMEOUT_MS`) and every failure is classified so the viewer can
 * say what happened: `TIMEOUT`, `AUTH`, `MISSING`, `HTTP`, `CONTENT_TYPE`,
 * `TOO_LARGE`, `EMPTY`, `NETWORK`. Without this a stalled read left the caller
 * awaiting a promise that never settled, and the spinner never moved.
 *
 * The caller owns the object URL created from the blob and MUST revoke it — a
 * GLB is tens of megabytes, so a leaked object URL is a real memory leak, not a
 * theoretical one.
 */
async function fetchAssetBlob(productSlug, assetId, kind, { timeoutMs } = {}) {
  const token = getToken('admin');
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : ASSET_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  // The timer stays armed until the BODY has been read: `res.blob()` streams,
  // so a response that arrives and then stalls still has to be bounded.
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort();
    } catch {
      /* an already-settled request cannot be aborted — nothing to do */
    }
  }, budget);

  try {
    let res;
    try {
      res = await fetch(mediaPath(productSlug, assetId, kind), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (err) {
      if (timedOut || err?.name === 'AbortError') {
        throw mediaError(
          `The model took longer than ${Math.round(budget / 1000)} seconds to download and the request was stopped. Check the connection and try again.`,
          'TIMEOUT'
        );
      }
      throw mediaError(
        'The model could not be reached. Check the connection and try again.',
        'NETWORK'
      );
    }

    if (!res.ok) {
      let message = '';
      try {
        const data = await res.json();
        if (data?.message) message = data.message;
      } catch {
        /* a binary/HTML error body is not JSON — the status message stands */
      }
      if (res.status === 401 || res.status === 403) {
        throw mediaError(
          message || 'Your session is no longer allowed to read this model. Sign in again to retry.',
          'AUTH',
          res.status
        );
      }
      if (res.status === 404 || res.status === 410) {
        throw mediaError(
          message || 'That model no longer exists — it may have been replaced or removed. Refresh the studio to see the current asset.',
          'MISSING',
          res.status
        );
      }
      throw mediaError(message || `That model file could not be loaded (${res.status}).`, 'HTTP', res.status);
    }

    const wrongType = acceptContentType(kind, res.headers.get('content-type'));
    if (wrongType) {
      throw mediaError(
        `The server answered with ${wrongType} instead of the ${kind === 'thumbnail' ? 'reference image' : 'model file'}. Refresh the studio and try again.`,
        'CONTENT_TYPE'
      );
    }

    const declared = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
      throw mediaError(
        `That model file is ${(declared / 1024 / 1024).toFixed(1)} MB, above the ${MAX_ASSET_BYTES / 1024 / 1024} MB limit this viewer can open.`,
        'TOO_LARGE'
      );
    }

    let blob;
    try {
      blob = await res.blob();
    } catch {
      if (timedOut) {
        throw mediaError(
          `The model stopped downloading after ${Math.round(budget / 1000)} seconds and the request was stopped. Try again.`,
          'TIMEOUT'
        );
      }
      throw mediaError('The model download was interrupted before it finished. Try again.', 'NETWORK');
    }

    if (!blob.size) {
      throw mediaError('The model file came back empty. Regenerate the candidate or try again.', 'EMPTY');
    }
    if (blob.size > MAX_ASSET_BYTES) {
      throw mediaError(
        `That model file is ${(blob.size / 1024 / 1024).toFixed(1)} MB, above the ${MAX_ASSET_BYTES / 1024 / 1024} MB limit this viewer can open.`,
        'TOO_LARGE'
      );
    }
    return blob;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load a model's GLB as an object URL suitable for GLTFLoader.
 *
 * Returns `{ url, bytes, revoke }`. A viewer must call `revoke()` when it
 * unmounts or swaps models; nothing here caches, deliberately — a stale cached
 * URL pointing at a DEPRECATED model is exactly the mix-up the asset life cycle
 * exists to prevent.
 */
export async function loadModelObjectUrl(productSlug, assetId, options = {}) {
  const blob = await fetchAssetBlob(productSlug, assetId, 'model', options);
  const url = URL.createObjectURL(blob);
  return {
    url,
    bytes: blob.size,
    revoke: () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already revoked */
      }
    },
  };
}

/** The thumbnail for a candidate/approved model, as a blob URL. */
export async function loadThumbnailObjectUrl(productSlug, assetId, options = {}) {
  const blob = await fetchAssetBlob(productSlug, assetId, 'thumbnail', options);
  const url = URL.createObjectURL(blob);
  return {
    url,
    bytes: blob.size,
    revoke: () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already revoked */
      }
    },
  };
}

/** True when an asset projection has real, validated bytes behind it. */
export function hasPlayableModel(asset) {
  return Boolean(asset && asset.id && asset.hasModel);
}

export default {
  QUALITIES,
  JOB_ACTIVE_STATUSES,
  JOB_FINAL_STATUSES,
  JOB_POLL_MS,
  getProviderStatus,
  getStudioState,
  listJobs,
  listAssets,
  getCurrentAsset,
  startGeneration,
  getJob,
  retryJob,
  cancelJob,
  approveJob,
  rejectJob,
  getAsset,
  deleteAsset,
  mediaPath,
  loadModelObjectUrl,
  loadThumbnailObjectUrl,
  hasPlayableModel,
};
