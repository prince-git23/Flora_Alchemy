/**
 * captureSetService — 3D Studio client for /api/capture-sets (Phase 11).
 *
 * ALL capture-set HTTP lives here and goes through `apiClient`, per the project
 * rule that no page or component calls `fetch` itself. Errors are normalised to a
 * thrown Error carrying `code`/`status`, the convention the other admin services
 * follow (`referenceImageService`, `threeGlbService`).
 *
 * The scope of a set is EITHER a saved product slug OR a draft key; exactly one
 * identifies it, which mirrors the reference studio and the server.
 */

import api from './apiClient.js';

function fail(res, fallback) {
  const err = new Error(res.message || fallback);
  err.code = res.code || 'API_ERROR';
  err.status = res.status;
  err.errorId = res.errorId || null;
  return err;
}

function scopeParams({ productSlug = '', draftKey = '' } = {}) {
  const params = new URLSearchParams();
  if (productSlug) params.set('productSlug', productSlug);
  else if (draftKey) params.set('draftKey', draftKey);
  else throw new Error('A capture set needs a product slug or a draft key.');
  return params.toString();
}

function scopeBody({ productSlug = '', draftKey = '' } = {}) {
  return productSlug ? { productSlug } : { draftKey };
}

/** The engine registry + provider facts. Read once per panel mount. */
export async function getEngines() {
  const res = await api.get('/capture-sets/engines', { scope: 'admin' });
  if (!res.ok) throw fail(res, 'The reconstruction engines could not be loaded.');
  return {
    provider: res.data.provider || {},
    engines: res.data.engines || [],
    meteredAuthorised: Boolean(res.data.meteredAuthorised),
  };
}

/** Start (or reopen) the set. Safe to call twice — the server returns the same one. */
export async function startCaptureSet(scope, { engineId = '' } = {}) {
  const res = await api.post('/capture-sets', { ...scopeBody(scope), engineId }, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'The capture set could not be started.');
  return res.data.captureSet;
}

/** Live state, no writes. 404 → the set has not been started yet. */
export async function getCaptureSet(scope) {
  const res = await api.get(`/capture-sets?${scopeParams(scope)}`, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'The capture set could not be loaded.');
  return res.data.captureSet;
}

/** Save the capture profile and/or the selected engine. Status is never sent. */
export async function updateCaptureSet(id, scope, patch) {
  const res = await api.patch(`/capture-sets/${encodeURIComponent(id)}`, { ...scopeBody(scope), ...patch }, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'Those capture details could not be saved.');
  return res.data.captureSet;
}

/** Recompute and persist the validation snapshot. */
export async function validateCaptureSet(id, scope) {
  const res = await api.post(`/capture-sets/${encodeURIComponent(id)}/validate`, scopeBody(scope), { scope: 'admin' });
  if (!res.ok) throw fail(res, 'The capture set could not be validated.');
  return res.data.captureSet;
}

/**
 * The DRY RUN: exactly which images would be sent, in which order. Writes
 * nothing and contacts no provider, so it is safe to call on every engine change.
 */
export async function previewPlan(id, scope, { engineId = '' } = {}) {
  const res = await api.post(`/capture-sets/${encodeURIComponent(id)}/plan`, { ...scopeBody(scope), engineId }, { scope: 'admin' });
  if (!res.ok) throw fail(res, 'The submission plan could not be built.');
  return res.data.plan;
}

/**
 * THE explicit action. `acknowledgeMetered` is required by the server only for a
 * metered engine, and it is sent as an explicit boolean — never defaulted.
 */
export async function submitCaptureSet(id, scope, { engineId = '', acknowledgeMetered = false, notes = '', label = '' } = {}) {
  const res = await api.post(
    `/capture-sets/${encodeURIComponent(id)}/submit`,
    { ...scopeBody(scope), engineId, acknowledgeMetered, notes, label },
    { scope: 'admin' }
  );
  if (!res.ok) throw fail(res, 'The capture set could not be submitted.');
  return { submission: res.data.submission || null, captureSet: res.data.captureSet };
}

export async function archiveCaptureSet(id, scope) {
  const res = await api.post(`/capture-sets/${encodeURIComponent(id)}/archive`, scopeBody(scope), { scope: 'admin' });
  if (!res.ok) throw fail(res, 'The capture set could not be archived.');
  return res.data.captureSet;
}

/** Human labels for the engine ids the server may return. */
export const ENGINE_LABELS = {
  local_single_view: 'Local TripoSR (single photograph)',
  meshy_multi_image: 'Meshy 7.1 (hosted, metered)',
  hunyuan3d_2mv: 'Hunyuan3D-2mv (local, experimental)',
  reli3d: 'ReLi3D (local, pose-required)',
};

export default {
  getEngines,
  startCaptureSet,
  getCaptureSet,
  updateCaptureSet,
  validateCaptureSet,
  previewPlan,
  submitCaptureSet,
  archiveCaptureSet,
  ENGINE_LABELS,
};
