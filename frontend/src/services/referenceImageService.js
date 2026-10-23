/**
 * referenceImageService — 3D Studio client for /api/references (multi-view).
 *
 * ALL studio HTTP lives here (a page or component never calls the API itself),
 * and it goes through the shared transports in apiClient:
 *
 *   · `api.get/patch/post/delete` for JSON;
 *   · `postForm` for the multipart upload, which is the only transport that
 *     exposes real upload progress (it is XHR-backed for exactly that reason);
 *   · a bare `fetch` ONLY for reading asset bytes. That is not a workaround but
 *     a constraint: reference images are private, so they are served behind a
 *     bearer token, and an <img src> cannot send one. The bytes are fetched here
 *     with the same admin token lookup and turned into a blob URL by the caller,
 *     which is why this file owns the fetch and no component does.
 *
 * Errors are normalized to a thrown Error carrying `code`/`status`, which is the
 * convention the other services follow (`reviewService`, `customRequestService`).
 */

import api, { API_BASE_URL, getToken, postForm } from './apiClient.js';

/** Mirrors the server's accepted image types so a bad pick fails instantly. */
export const REFERENCE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
/** Mirrors the server's cap (backend/controllers/uploadController.js). */
export const REFERENCE_MAX_BYTES = 5 * 1024 * 1024;
/** The server's per-set ceiling (services/referenceImageService.js). */
export const REFERENCE_SET_LIMIT = 24;
/** The server's composite panel budget (services/referenceViews.js). */
export const REFERENCE_PANEL_LIMIT = 24;

/** Viewpoint labels the server accepts. Order matches the studio's picker. */
export const VIEW_ANGLES = [
  'front',
  'back',
  'left',
  'right',
  'three-quarter-left',
  'three-quarter-right',
  'top',
  'bottom',
  'detail',
  'texture',
  'wrapping',
  'other',
];

export const REFERENCE_STATUSES = ['UPLOADING', 'PROCESSING', 'READY', 'NEEDS_REVIEW', 'FAILED'];

/**
 * Normalize a failed response into an Error that carries everything the studio
 * needs to say something USEFUL: the server's code, the HTTP status, and — for
 * a server-side fault — the id that matches the server log line.
 *
 * Before this, all four collapsed into one sentence, so "your file is
 * unreadable" (422), "the disk is not writable" (503 STORAGE_NOT_WRITABLE) and
 * "the server threw" (500) were indistinguishable to the administrator.
 */
function fail(res, fallback) {
  const err = new Error(res.message || fallback);
  err.code = res.code || 'API_ERROR';
  err.status = res.status;
  err.errorId = res.errorId || null;
  return err;
}

/**
 * List the studio's references for a product, or for a draft key while the
 * product does not exist yet. Exactly one of the two identifies the set.
 */
export async function listReferences({ productSlug = '', draftKey = '', ids = null } = {}) {
  const params = new URLSearchParams();
  if (productSlug) params.set('productSlug', productSlug);
  else if (draftKey) params.set('draftKey', draftKey);
  else if (ids && ids.length) params.set('ids', ids.join(','));
  const res = await api.get(`/references?${params.toString()}`, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'The prepared images could not be loaded.');
  return {
    images: res.data.images || [],
    setWarnings: res.data.setWarnings || [],
    setNotes: res.data.setNotes || [],
  };
}

/**
 * Upload one ORIGINAL image; the server validates it, stores it unchanged and
 * measures it. `mode` says whether the upload may be read as a composite sheet:
 * 'auto' (detect), 'single' (one photograph) or 'composite' (the administrator
 * knows it is a grid).
 */
export async function uploadReference(
  file,
  { productSlug = '', draftKey = '', label = '', mode = 'auto', viewAngle = '', onProgress } = {}
) {
  const form = new FormData();
  form.append('image', file);
  if (productSlug) form.append('productSlug', productSlug);
  if (draftKey) form.append('draftKey', draftKey);
  if (label) form.append('label', label);
  if (mode && mode !== 'auto') form.append('mode', mode);
  if (viewAngle) form.append('viewAngle', viewAngle);
  const res = await postForm('/references', form, { scope: 'admin', onProgress });
  if (!res.ok) throw fail(res, 'That image could not be uploaded.');
  return {
    image: res.data.image,
    duplicateOf: res.data.duplicateOf || null,
    setWarnings: res.data.setWarnings || [],
    setNotes: res.data.setNotes || [],
  };
}

export async function getReference(id) {
  const res = await api.get(`/references/${encodeURIComponent(id)}`, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'That prepared image could not be loaded.');
  return res.data.image;
}

/**
 * Patch one reference: `label`, `viewAngle`, `accepted`, `isPrimary`.
 *
 * There is no crop any more: cropping in place produced a derived image that
 * could be cropped again. A composite panel is the only supported narrowing, and
 * it is traceable to the sheet it came from.
 */
export async function updateReference(id, patch) {
  const res = await api.patch(`/references/${encodeURIComponent(id)}`, patch, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'That change could not be saved.');
  return res.data.image;
}

/** Apply a drag result. The whole ordered list is sent; the server is atomic-ish
 *  and refuses a stale list outright rather than half-applying it. */
export async function reorderReferences(ids) {
  const res = await api.patch('/references/order', { ids }, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'The new order could not be saved.');
  return { images: res.data.images || [], setWarnings: res.data.setWarnings || [], setNotes: res.data.setNotes || [] };
}

/** Re-measure a reference (and re-read a composite grid). The original is kept. */
export async function reprocessReference(id) {
  const res = await api.post(`/references/${encodeURIComponent(id)}/reprocess`, {}, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'Processing could not be restarted.');
  return res.data.image;
}

/**
 * Preview what a grid would produce, WITHOUT cutting anything. `columns`/`rows`
 * omitted = ask the detector. This is what the correction UI renders before a
 * human commits to a layout.
 */
export async function previewViews(id, { columns, rows, padding } = {}) {
  const params = new URLSearchParams();
  if (Number.isFinite(Number(columns))) params.set('columns', String(columns));
  if (Number.isFinite(Number(rows))) params.set('rows', String(rows));
  if (Number.isFinite(Number(padding))) params.set('padding', String(padding));
  const res = await api.get(`/references/${encodeURIComponent(id)}/views?${params.toString()}`, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'The panel layout could not be analysed.');
  return res.data.analysis;
}

/** Cut the confirmed views out of a composite (idempotent per panel index). */
export async function confirmViews(id, { columns, rows, padding = 0, angles = [] } = {}) {
  const res = await api.post(
    `/references/${encodeURIComponent(id)}/views`,
    { columns, rows, padding, angles },
    { scope: 'admin' }
  );
  if (!res.ok) throw fail(res, 'The views could not be created.');
  return res.data;
}

export async function removeReference(id) {
  const res = await api.delete(`/references/${encodeURIComponent(id)}`, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'That image could not be removed.');
  return res.data;
}

/** Hand the draft's accepted references to a just-saved product. */
export async function attachReferencesToProduct({ productSlug, productId = null, ids = [], draftKey = '' }) {
  const res = await api.post(
    '/references/attach',
    { productSlug, productId, ids, draftKey },
    { scope: 'admin' }
  );
  if (!res.ok) throw fail(res, 'The prepared images could not be attached to the product.');
  return res.data;
}

/**
 * The reference vocabulary this server supports (formats, size limits, panel
 * budget, viewpoint labels).
 *
 * This replaced `getEngineInfo`, which described a background-removal engine
 * that no longer exists.
 */
export async function getReferenceOptions() {
  const res = await api.get('/references/options', { scope: 'admin' });
  if (!res.ok) throw fail(res, 'The reference options could not be loaded.');
  return res.data.options;
}

/**
 * Fetch one asset's bytes with the admin token. `original` is the only kind the
 * studio renders; `cutout`/`neutral` remain readable for legacy rows.
 * Returns a Blob; the caller owns the object URL and must revoke it.
 */
export async function fetchReferenceAsset(id, kind) {
  const token = getToken('admin');
  const res = await fetch(`${API_BASE_URL}/references/${encodeURIComponent(id)}/file/${kind}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = `That image could not be loaded (${res.status}).`;
    try {
      const data = await res.json();
      if (data && data.message) message = data.message;
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}
