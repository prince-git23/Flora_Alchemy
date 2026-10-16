/**
 * 3D MODEL PROVIDER — 3D Studio (Phase 2) — the provider abstraction.
 *
 * POLICY (load-bearing, do not relax):
 *
 *   1. LOCAL FIRST. A real local provider (TRELLIS.2, TripoSR, a future one) is
 *      the preferred option because it has no recurring per-generation cost. The
 *      default deployment must never incur an external charge by accident.
 *      PHASE 4 turned this from an intention into a working provider: the
 *      `local_worker` slot below is a genuine self-hosted GPU worker
 *      (tools/3d-worker/worker.py, TripoSR, MIT weights), reachable only when the
 *      operator sets 3D_PROVIDER=local_worker. It needs no credential and spends
 *      nothing, but it is still EXPLICIT: nothing selects it on the operator's
 *      behalf, and when it fails the job fails as a local failure exactly as
 *      before — never with a paid retry behind it.
 *
 *   2. MESHY 7.1 IS OPT-IN ONLY. The hosted adapter is reachable only when the
 *      operator both sets `3D_PROVIDER=meshy` AND provides `MESHY_API_KEY`. A
 *      missing key is a refusal, not a fallback to local, and a local failure is
 *      NEVER followed by a silent paid retry.
 *
 *   3. CREDENTIALS STAY SERVER-SIDE. `MESHY_API_KEY` is read from the process
 *      environment here and is never returned by any endpoint. The health
 *      endpoint reports availability and a reason, never a key.
 *
 *   4. HONESTY ABOUT THIS MACHINE. With no provider selected the default is still
 *      `local_unavailable`, and generation is disabled with a readable reason
 *      rather than pretending to work. Opting in is a deliberate act with an
 *      environment variable, and the health endpoint reports whether the worker
 *      is actually reachable rather than assuming it is.
 *
 * PROVIDER INTERFACE
 *   name / model / modelVersion / maxInputs / supportsMultiView
 *   submit(inputs)      → { providerTaskId }
 *   status(taskId)      → { status: 'polling'|'ready', providerTaskStatus, progress }
 *   download(taskId)    → { buffer, contentType }
 *   cancel(taskId)      → true
 *   health()            → { ok, detail }
 */

const MESHY_API_BASE = process.env.MESHY_API_BASE_URL || 'https://api.meshy.ai/v1';
const MESHY_MODEL = process.env.MESHY_MODEL || 'meshy-7-1';
const MESHY_MAX_INPUTS = 4;

export const PROVIDER_LOCAL_UNAVAILABLE = 'local_unavailable';
export const PROVIDER_MESHY = 'meshy';
// Phase 4 — the self-hosted GPU worker (see services/3dLocalWorkerProvider.js).
export { PROVIDER_LOCAL_WORKER } from './3dLocalWorkerProvider.js';
import {
  PROVIDER_LOCAL_WORKER,
  describeLocalWorker,
  isLocalWorkerUrl,
  localWorkerProvider,
} from './3dLocalWorkerProvider.js';

export const QUALITY_LEVELS = ['draft', 'standard', 'high'];

const LOCAL_REASON =
  'No 3D generation provider is selected on this server. Start the self-hosted worker ' +
  '(tools/3d-worker/worker.py, which runs TripoSR on an NVIDIA GPU) and set ' +
  '3D_PROVIDER=local_worker, or opt in to the metered Meshy 7.1 adapter by setting ' +
  '3D_PROVIDER=meshy and MESHY_API_KEY. See docs/IMAGE_STUDIO.md §Phase 4.';

const MESHY_REASON =
  'Meshy 7.1 is selected as the provider but MESHY_API_KEY is not set. This adapter is metered ' +
  'and opt-in only, so generation stays disabled rather than falling back to it automatically.';

/** The provider this process is configured to use (never a silent paid fallback). */
export function resolveProvider() {
  const requested = String(process.env['3D_PROVIDER'] || '').trim().toLowerCase();
  if (requested === PROVIDER_MESHY) return PROVIDER_MESHY;
  if (requested === PROVIDER_LOCAL_WORKER) return PROVIDER_LOCAL_WORKER;
  return PROVIDER_LOCAL_UNAVAILABLE;
}

/** Is the named provider usable right now? */
export function isProviderConfigured(provider = resolveProvider()) {
  if (provider === PROVIDER_MESHY) return Boolean(process.env.MESHY_API_KEY);
  // The local worker needs no credential — only a worker address that is
  // actually local. Reachability is checked separately (and honestly) by the
  // async health read, because this function must stay synchronous.
  if (provider === PROVIDER_LOCAL_WORKER) return isLocalWorkerUrl();
  return false;
}

/**
 * Describe a provider for the UI. Carries `available` plus a human reason, and
 * never a credential.
 */
export function describeProvider(provider = resolveProvider()) {
  if (provider === PROVIDER_LOCAL_WORKER) return describeLocalWorker();
  if (provider === PROVIDER_MESHY) {
    const available = Boolean(process.env.MESHY_API_KEY);
    return {
      name: PROVIDER_MESHY,
      label: 'Meshy 7.1 (hosted, metered)',
      available,
      reason: available ? '' : MESHY_REASON,
      model: MESHY_MODEL,
      modelVersion: '7.1',
      maxInputs: MESHY_MAX_INPUTS,
      supportsMultiView: true,
      metered: true,
      local: false,
    };
  }
  return {
    name: PROVIDER_LOCAL_UNAVAILABLE,
    label: 'Local provider (not configured)',
    available: false,
    reason: LOCAL_REASON,
    model: '',
    modelVersion: '',
    maxInputs: 0,
    supportsMultiView: false,
    metered: false,
    local: true,
  };
}

/**
 * The generation plan for a set of accepted references: which provider would be
 * used, whether it is available, and which views would actually be sent.
 */
export function plansForProduct(acceptedRefs = []) {
  const provider = resolveProvider();
  const described = describeProvider(provider);
  const refs = Array.isArray(acceptedRefs) ? acceptedRefs.filter(Boolean) : [];
  const selected = described.available ? refs.slice(0, described.maxInputs) : [];

  return {
    provider,
    available: described.available,
    reason: described.reason,
    label: described.label,
    metered: described.metered,
    model: described.model,
    modelVersion: described.modelVersion,
    maxInputs: described.maxInputs,
    supportsMultiView: described.supportsMultiView,
    acceptedCount: refs.length,
    selected,
    viewCount: selected.length,
    singleView: selected.length <= 1,
    notes: !described.available
      ? 'Generation is unavailable until a provider is configured.'
      : selected.length <= 1
        ? 'Single-view reconstruction — the result is approximate.'
        : `${selected.length} reference views will be sent.`,
  };
}

/* ── Meshy 7.1 (hosted, metered, opt-in) ─────────────────────────────────── */

function meshyKey() {
  const key = process.env.MESHY_API_KEY;
  if (!key) throw Object.assign(new Error('MESHY_API_KEY is not configured.'), { code: 'MESHY_NO_KEY' });
  return key;
}

export async function meshySubmit(inputs = []) {
  const key = meshyKey();
  const form = new FormData();
  let attached = 0;
  for (const input of inputs) {
    const bytes = input?.buffer;
    if (!bytes) continue;
    form.append('image_file', new Blob([bytes], { type: 'image/png' }), `view-${attached}.png`);
    attached += 1;
  }
  if (attached === 0) {
    throw Object.assign(new Error('No reference image bytes were supplied to the provider.'), {
      code: 'MESHY_NO_INPUT',
    });
  }
  form.append('model_type', 'standard');
  form.append('ai_model', MESHY_MODEL);

  const res = await fetch(`${MESHY_API_BASE}/image-to-3d`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw Object.assign(new Error(`Meshy submit failed (${res.status}): ${text.slice(0, 200)}`), {
      status: res.status,
      code: 'MESHY_SUBMIT_FAILED',
    });
  }
  const data = JSON.parse(text);
  const taskId = data?.result || data?.id || '';
  if (!taskId) {
    throw Object.assign(new Error('Meshy accepted the request but returned no task id.'), {
      code: 'MESHY_SUBMIT_FAILED',
    });
  }
  return { providerTaskId: String(taskId) };
}

export async function meshyStatus(providerTaskId) {
  const key = meshyKey();
  const res = await fetch(`${MESHY_API_BASE}/image-to-3d/${encodeURIComponent(providerTaskId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw Object.assign(new Error(`Meshy status failed (${res.status}): ${text.slice(0, 200)}`), {
      status: res.status,
      code: 'MESHY_STATUS_FAILED',
    });
  }
  const data = JSON.parse(text);
  const state = String(data?.status || '').toUpperCase();
  const progress = typeof data?.progress === 'number' ? data.progress : null;

  if (state === 'SUCCEEDED') {
    const url = data?.model_urls?.glb || data?.model_url;
    if (!url) {
      throw Object.assign(new Error('Meshy reported success but returned no model URL.'), {
        code: 'MESHY_NO_RESULT',
      });
    }
    return { status: 'ready', providerTaskStatus: state, progress: 100, modelUrl: url };
  }
  if (state === 'FAILED' || state === 'CANCELED') {
    return {
      status: 'polling',
      providerTaskStatus: state,
      progress,
      error: { code: 'MESHY_TASK_FAILED', message: data?.task_error?.message || 'The provider task failed.' },
    };
  }
  return { status: 'polling', providerTaskStatus: state, progress };
}

export async function meshyDownload(providerTaskId) {
  const state = await meshyStatus(providerTaskId);
  if (state.status !== 'ready' || !state.modelUrl) {
    throw Object.assign(new Error('The provider has no finished model to download yet.'), {
      code: 'MESHY_NOT_READY',
    });
  }
  const res = await fetch(state.modelUrl);
  if (!res.ok) {
    throw Object.assign(new Error(`Meshy download failed (${res.status}).`), {
      status: res.status,
      code: 'MESHY_DOWNLOAD_FAILED',
    });
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: res.headers.get('content-type') || 'model/gltf-binary' };
}

export async function meshyCancel(providerTaskId) {
  const key = meshyKey();
  await fetch(`${MESHY_API_BASE}/image-to-3d/${encodeURIComponent(providerTaskId)}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
  }).catch(() => {});
  return true;
}

/* ── Provider registry ───────────────────────────────────────────────────── */

const LOCAL_PROVIDER = {
  name: PROVIDER_LOCAL_UNAVAILABLE,
  submit: async () => {
    throw Object.assign(new Error(describeProvider(PROVIDER_LOCAL_UNAVAILABLE).reason), {
      code: 'PROVIDER_UNAVAILABLE',
    });
  },
  status: async () => ({ status: 'unavailable', providerTaskStatus: 'UNAVAILABLE' }),
  download: async () => {
    throw Object.assign(new Error('No provider is configured.'), { code: 'PROVIDER_UNAVAILABLE' });
  },
  cancel: async () => true,
  health: async () => ({ ok: false, detail: describeProvider(PROVIDER_LOCAL_UNAVAILABLE).reason }),
};

const MESHY_PROVIDER = {
  name: PROVIDER_MESHY,
  submit: meshySubmit,
  status: meshyStatus,
  download: meshyDownload,
  cancel: meshyCancel,
  health: async () => {
    const key = process.env.MESHY_API_KEY;
    if (!key) return { ok: false, detail: MESHY_REASON };
    // A cheap authenticated read; 401/403 means the key is no longer valid.
    try {
      const res = await fetch(`${MESHY_API_BASE}/image-to-3d?page_size=1`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      return res.ok
        ? { ok: true, detail: 'Meshy 7.1 is reachable with the configured key.' }
        : { ok: false, detail: `Meshy rejected the configured key (HTTP ${res.status}).` };
    } catch (err) {
      return { ok: false, detail: `Meshy is unreachable: ${err?.message || String(err)}` };
    }
  },
};

/**
 * Providers available in this build, keyed by name. The test-only fake provider
 * is registered from the test harness (see scripts/3d-studio-smoke.mjs) through
 * `registerTestProvider`, never from application code.
 */
const registry = new Map([
  [PROVIDER_LOCAL_UNAVAILABLE, LOCAL_PROVIDER],
  [PROVIDER_MESHY, MESHY_PROVIDER],
  [PROVIDER_LOCAL_WORKER, localWorkerProvider],
]);

export function providerFor(provider = resolveProvider()) {
  const found = registry.get(provider);
  if (!found) {
    throw Object.assign(new Error(`Unknown 3D provider "${provider}".`), { code: 'PROVIDER_UNKNOWN' });
  }
  return found;
}

export function listProviders() {
  return [...registry.keys()].map((name) => describeProvider(name));
}

/**
 * TEST-ONLY. Register a substitution provider under an existing name.
 *
 * This exists so the domain suite can exercise the REAL job life cycle — claim,
 * provider submit/status/download, GLB validation, approval — without paying for
 * a hosted call and without pretending a fabricated mesh was generated. It
 * returns `restore()`, and the suite always restores in a finally block.
 */
export function registerTestProvider(name, impl) {
  const previous = registry.get(name);
  registry.set(name, { name, ...impl });
  return () => {
    if (previous) registry.set(name, previous);
    else registry.delete(name);
  };
}

export default {
  resolveProvider,
  describeProvider,
  isProviderConfigured,
  plansForProduct,
  providerFor,
  listProviders,
  registerTestProvider,
};
