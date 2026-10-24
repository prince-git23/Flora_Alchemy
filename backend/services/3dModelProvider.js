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
 *      operator sets THREE_D_PROVIDER=local_worker. It needs no credential and spends
 *      nothing, but it is still EXPLICIT: nothing selects it on the operator's
 *      behalf, and when it fails the job fails as a local failure exactly as
 *      before — never with a paid retry behind it.
 *
 *   2. MESHY 7.1 IS OPT-IN ONLY. The hosted adapter is reachable only when the
 *      operator both sets `THREE_D_PROVIDER=meshy` AND provides `MESHY_API_KEY`. A
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
 * ENVIRONMENT
 *   Selection is read from `THREE_D_PROVIDER` (canonical: local_worker,
 *   local_gpu_agent, meshy; anything else = disabled). The original spelling
 *   `3D_PROVIDER` is read as a DEPRECATED alias only — some hosts, Render
 *   included, reject environment names that begin with a digit. Canonical wins.
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
// Remote GPU agent — the same TripoSR inference, on the owner's PC, driving IT
// itself over the deployed API's authenticated agent endpoints (the backend
// never dials the PC). See services/3dGpuAgentProvider.js.
export { PROVIDER_LOCAL_GPU_AGENT } from './3dGpuAgentProvider.js';
import {
  PROVIDER_LOCAL_GPU_AGENT,
  describeGpuAgent,
  gpuAgentProvider,
  isAgentConfigured,
} from './3dGpuAgentProvider.js';

export const QUALITY_LEVELS = ['draft', 'standard', 'high'];

/**
 * ENVIRONMENT CONTRACT — the provider flag.
 *
 * The canonical name is `THREE_D_PROVIDER`. The original spelling
 * (`3D_PROVIDER`) began with a digit, which POSIX shells and some hosts —
 * including Render — refuse to accept as an environment-variable name, so the
 * deployed service could never be configured with it. The rename therefore
 * happened in code rather than in production settings.
 *
 * The legacy name is still READ, deliberately, so an existing developer machine
 * keeps working; it is a DEPRECATED alias only. `THREE_D_PROVIDER` always wins
 * when both are present, and nothing in the deployed configuration may rely on
 * the old key. See `providerEnvSource()` for which one actually supplied the
 * selection.
 */
export const PROVIDER_ENV_VAR = 'THREE_D_PROVIDER';
export const LEGACY_PROVIDER_ENV_VAR = '3D_PROVIDER';

/** Every value `THREE_D_PROVIDER` is allowed to take. */
export const PROVIDER_ENV_VALUES = [
  PROVIDER_LOCAL_WORKER,
  PROVIDER_LOCAL_GPU_AGENT,
  PROVIDER_MESHY,
];

const LOCAL_REASON =
  'No 3D generation provider is selected on this server. Start the self-hosted worker ' +
  '(tools/3d-worker/worker.py, which runs TripoSR on an NVIDIA GPU) and set ' +
  'THREE_D_PROVIDER=local_worker, or opt in to the metered Meshy 7.1 adapter by setting ' +
  'THREE_D_PROVIDER=meshy and MESHY_API_KEY. See docs/IMAGE_STUDIO.md §Phase 4.';

/**
 * A value was supplied but it is not one of `PROVIDER_ENV_VALUES`.
 *
 * The value is deliberately NOT echoed: an operator who pasted a credential into
 * the wrong variable must not have it repeated in an API response, a log line or
 * a readiness report. Naming the valid options is what makes the typo fixable.
 */
const UNRECOGNIZED_REASON =
  'THREE_D_PROVIDER is set to a value that is not a recognized 3D provider, so generation ' +
  `stays disabled. Valid values: ${PROVIDER_ENV_VALUES.join(', ')}. Leave it unset to disable ` +
  'generation entirely. See docs/IMAGE_STUDIO.md §Phase 4.';

const MESHY_REASON =
  'Meshy 7.1 is selected as the provider but MESHY_API_KEY is not set. This adapter is metered ' +
  'and opt-in only, so generation stays disabled rather than falling back to it automatically.';

const envValue = (name) => String(process.env[name] ?? '').trim();

/**
 * Which variable supplied the provider selection: the canonical name, the
 * deprecated alias, or null when neither is set. Canonical takes precedence, so
 * a stale alias can never override the deployed value.
 */
export function providerEnvSource() {
  if (envValue(PROVIDER_ENV_VAR)) return PROVIDER_ENV_VAR;
  if (envValue(LEGACY_PROVIDER_ENV_VAR)) return LEGACY_PROVIDER_ENV_VAR;
  return null;
}

/** The raw configured provider name (never a credential). `''` when unset. */
export function requestedProvider() {
  const source = providerEnvSource();
  return source ? envValue(source) : '';
}

/** Is this a provider name this build ships? (Case-insensitive.) */
export function isRecognizedProvider(value) {
  return PROVIDER_ENV_VALUES.includes(String(value || '').trim().toLowerCase());
}

/**
 * Non-secret configuration diagnostics for readiness reporting and tests: which
 * variable was used, whether it came from the deprecated alias, and whether the
 * value is recognized. Never includes a credential — these are variable NAMES
 * and provider NAMES only.
 */
export function providerConfigDiagnostics() {
  const source = providerEnvSource();
  const requested = source ? envValue(source) : '';
  return {
    variable: PROVIDER_ENV_VAR,
    legacyVariable: LEGACY_PROVIDER_ENV_VAR,
    source,
    legacyAliasUsed: source === LEGACY_PROVIDER_ENV_VAR,
    requested: isRecognizedProvider(requested) ? requested.toLowerCase() : (requested ? '(unrecognized)' : ''),
    recognized: !requested || isRecognizedProvider(requested),
    selected: resolveProvider(),
  };
}

/** The provider this process is configured to use (never a silent paid fallback). */
export function resolveProvider() {
  const requested = requestedProvider().toLowerCase();
  if (requested === PROVIDER_MESHY) return PROVIDER_MESHY;
  if (requested === PROVIDER_LOCAL_WORKER) return PROVIDER_LOCAL_WORKER;
  if (requested === PROVIDER_LOCAL_GPU_AGENT) return PROVIDER_LOCAL_GPU_AGENT;
  return PROVIDER_LOCAL_UNAVAILABLE;
}

/** Is the named provider usable right now? */
export function isProviderConfigured(provider = resolveProvider()) {
  if (provider === PROVIDER_MESHY) return Boolean(process.env.MESHY_API_KEY);
  // The local worker needs no credential — only a worker address that is
  // actually local. Reachability is checked separately (and honestly) by the
  // async health read, because this function must stay synchronous.
  if (provider === PROVIDER_LOCAL_WORKER) return isLocalWorkerUrl();
  // The agent needs the machine token. Whether the PC is actually ONLINE is a
  // database fact (heartbeat), read by `gpuAgentHealth` — never assumed here.
  if (provider === PROVIDER_LOCAL_GPU_AGENT) return isAgentConfigured();
  return false;
}

/**
 * Describe a provider for the UI. Carries `available` plus a human reason, and
 * never a credential.
 */
export function describeProvider(provider = resolveProvider()) {
  if (provider === PROVIDER_LOCAL_WORKER) return describeLocalWorker();
  if (provider === PROVIDER_LOCAL_GPU_AGENT) return describeGpuAgent();
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
  const requested = requestedProvider();
  return {
    name: PROVIDER_LOCAL_UNAVAILABLE,
    label: 'Local provider (not configured)',
    available: false,
    // A typo ('meshy7', 'triposr') is a different problem from "nothing is
    // selected", and saying so is the difference between a five-second fix and
    // a support thread.
    reason: requested && !isRecognizedProvider(requested) ? UNRECOGNIZED_REASON : LOCAL_REASON,
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
  const unused = Math.max(0, refs.length - selected.length);

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
    /** How many accepted views the SET has. */
    viewsAccepted: refs.length,
    selected,
    viewCount: selected.length,
    /** Accepted views the model will NOT see, and why. Exposed so the studio can
     *  stop implying that a 12-view sheet is being reconstructed jointly when
     *  the configured engine is single-image. */
    unusedViews: unused,
    singleView: selected.length <= 1,
    notes: !described.available
      ? 'Generation is unavailable until a provider is configured.'
      : !described.supportsMultiView
        ? unused > 0
          ? `${refs.length} accepted view${refs.length === 1 ? ' is' : 's are'} stored, but ${described.label} reconstructs from ONE image: ${selected.length} view${selected.length === 1 ? ' is' : 's are'} sent and the rest are kept for a multi-view engine.`
          : `${refs.length} accepted view${refs.length === 1 ? ' is' : 's are'} sent, and ${described.label} reconstructs from ONE image — it does not condition on them jointly.`
        : `${selected.length} of ${refs.length} accepted views will be sent to ${described.label}, which uses them jointly.`,
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
  [PROVIDER_LOCAL_GPU_AGENT, gpuAgentProvider],
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
  providerEnvSource,
  requestedProvider,
  providerConfigDiagnostics,
};
