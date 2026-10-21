/**
 * 3D LOCAL WORKER PROVIDER — 3D Studio (Phase 4) — the transport for a GENUINE
 * local generation worker.
 *
 * Phase 2 shipped a provider abstraction whose local slot was empty and honestly
 * said so (`local_unavailable`): no GPU model was installed, and the default
 * deployment reported generation as disabled rather than pretending. This module
 * fills that slot. The worker it talks to (`tools/3d-worker/worker.py`) loads a
 * real TripoSR checkpoint and runs real inference on the local GPU; the bytes it
 * returns are a real glTF Binary that the existing pipeline validates and stores.
 *
 * WHY THIS IS SAFE TO HAVE IN THE REGISTRY
 *
 *   · It is still OPT-IN. `resolveProvider` only selects it when
 *     `THREE_D_PROVIDER=local_worker` is set, so nothing about the default
 *     deployment's behaviour changes, and `local_unavailable` remains the
 *     default.
 *   · It is FREE, which is why it may be opted in casually at all. The metered
 *     hosted adapter keeps its own rule: both `THREE_D_PROVIDER=meshy` AND
 *     `MESHY_API_KEY`, and never as a silent fallback from a local failure.
 *   · It carries NO CREDENTIAL to leak. `THREE_WORKER_TOKEN`, when set, is a
 *     local shared secret read from the process environment here, sent as a
 *     bearer header, and never returned by an endpoint or a description.
 *   · It cannot reach an arbitrary host: the base URL comes from the server
 *     environment, never from a request body, and the URL is validated to be
 *     loopback or an explicit private host.
 *
 * WHY ONE IMAGE
 *
 * TripoSR is single-view: it reconstructs from ONE photograph and completes what
 * it cannot see. The plan advertises `maxInputs: 1`, and `submit` sends exactly
 * one reference — the PRIMARY accepted view, which is the one the loader sorts
 * first — instead of quietly forwarding several and letting the worker drop them.
 * The result's own metrics carry `inputMode` and the worker reports the view it
 * used, so "which photograph was this made from" is answerable after the fact.
 */

export const PROVIDER_LOCAL_WORKER = 'local_worker';

/** Where the worker listens by default (loopback: the worker is a local process). */
const DEFAULT_WORKER_URL = 'http://127.0.0.1:8791';

/** A generation takes seconds to minutes; the job's own poll loop is the real timer. */
const REQUEST_TIMEOUT_MS = 15_000;
const SUBMIT_TIMEOUT_MS = 60_000;

const LOCAL_WORKER_REASON =
  'The local worker provider is selected but THREE_WORKER_URL does not look like a local ' +
  'worker address. Set it to the worker you started with tools/3d-worker/worker.py ' +
  '(default http://127.0.0.1:8791).';

/** The configured worker base URL, without a trailing slash. */
export function workerUrl() {
  const raw = String(process.env.THREE_WORKER_URL || DEFAULT_WORKER_URL).trim();
  return raw.replace(/\/+$/, '');
}

/**
 * Is the configured URL plausibly OUR worker (and not, say, a public host that
 * someone could point the server at through a mis-set environment)?
 *
 * Only loopback or RFC1918/private addresses are accepted: the worker is a
 * process on the operator's own machine or LAN, and this keeps a form of
 * server-side request forgery out of the provider path.
 */
export function isLocalWorkerUrl(url = workerUrl()) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/** True when the worker provider is usable as configured. */
export function localWorkerConfigured() {
  return isLocalWorkerUrl();
}

/**
 * Describe the provider for the UI. `available` means "opted in and configured";
 * actual reachability is a separate, honest check (`localWorkerHealth`) because
 * this function is synchronous and a TCP probe is not.
 */
export function describeLocalWorker() {
  const url = workerUrl();
  const configured = isLocalWorkerUrl(url);
  return {
    name: PROVIDER_LOCAL_WORKER,
    label: 'Local GPU worker (TripoSR, self-hosted)',
    available: configured,
    reason: configured ? '' : LOCAL_WORKER_REASON,
    model: 'TripoSR',
    modelVersion: 'triposr-1.0',
    maxInputs: 1,
    supportsMultiView: false,
    metered: false,
    local: true,
    // Deliberately informational: the URL, never the token.
    workerUrl: configured ? url : '',
    requiresWorker: true,
    notes:
      'Single-image reconstruction from the primary accepted reference. The model ' +
      'completes surfaces it cannot see, so the result is a plausible reading of one ' +
      'photograph rather than a measured scan.',
  };
}

function authHeaders() {
  const token = process.env.THREE_WORKER_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function workerFetch(pathname, { method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT_MS, raw = false } = {}) {
  const url = workerUrl();
  if (!isLocalWorkerUrl(url)) {
    throw Object.assign(new Error(LOCAL_WORKER_REASON), { code: 'WORKER_NOT_LOCAL' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${url}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    // A refused connection or a timeout is a READABLE outcome: the operator
    // started the backend but not the worker (or the worker is still loading).
    const reason = err?.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : err?.message || String(err);
    throw Object.assign(
      new Error(
        `The local 3D worker at ${url} is unreachable (${reason}). Start it with ` +
          'tools/3d-worker/worker.py, or set THREE_D_PROVIDER to an available provider.'
      ),
      { code: 'WORKER_UNREACHABLE', status: 503 }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      detail = JSON.parse(text)?.error || detail;
    } catch {
      /* keep the raw slice */
    }
    throw Object.assign(new Error(`The local 3D worker returned ${res.status}: ${detail}`), {
      code: `WORKER_HTTP_${res.status}`,
      status: res.status,
    });
  }
  if (raw) {
    return Buffer.from(await res.arrayBuffer());
  }
  return res.json();
}

/* ── the provider interface (same shape as the Meshy adapter) ────────────── */

/**
 * Submit ONE accepted reference view.
 *
 * `inputs` arrive from the job service as `{ id, buffer, kind }` sorted
 * primary-first; the primary is what gets sent, and the choice is recorded so the
 * asset can say which photograph produced it.
 */
export async function localWorkerSubmit(inputs = []) {
  const usable = (Array.isArray(inputs) ? inputs : []).filter((i) => i?.buffer?.length);
  if (!usable.length) {
    throw Object.assign(new Error('No reference image bytes were supplied to the local worker.'), {
      code: 'WORKER_NO_INPUT',
    });
  }
  const primary = usable[0];
  const { taskId } = await workerFetch('/generate', {
    method: 'POST',
    timeoutMs: SUBMIT_TIMEOUT_MS,
    body: {
      images: [
        {
          id: String(primary.id || 'primary'),
          kind: primary.kind || 'cutout',
          data: primary.buffer.toString('base64'),
        },
      ],
      options: { source: 'flora-alchemy', viewCount: usable.length },
    },
  });
  if (!taskId) {
    throw Object.assign(new Error('The local worker accepted the request but returned no task id.'), {
      code: 'WORKER_SUBMIT_FAILED',
    });
  }
  return { providerTaskId: String(taskId), selectedReferenceId: String(primary.id || ''), kind: primary.kind || '' };
}

/** Poll one task. Maps the worker's vocabulary onto the job service's. */
export async function localWorkerStatus(providerTaskId) {
  const task = await workerFetch(`/tasks/${encodeURIComponent(providerTaskId)}`);
  const progress = typeof task?.progress === 'number' ? task.progress : null;

  if (task?.status === 'succeeded') {
    const container = task?.result?.container || {};
    if (container.ok === false) {
      // The worker inspected its own export; if that inspection failed there is
      // nothing worth downloading, and saying so is better than shipping bytes
      // the backend will refuse one step later.
      return {
        status: 'polling',
        providerTaskStatus: 'FAILED',
        progress,
        error: { code: 'WORKER_BAD_CONTAINER', message: `The worker produced an invalid GLB (${container.reason}).` },
      };
    }
    return {
      status: 'ready',
      providerTaskStatus: 'SUCCEEDED',
      progress: 100,
      result: task.result || null,
    };
  }
  if (task?.status === 'failed') {
    return {
      status: 'polling',
      providerTaskStatus: 'FAILED',
      progress,
      error: {
        code: task?.error?.code || 'WORKER_TASK_FAILED',
        message: task?.error?.message || 'The local worker reported a failed task.',
      },
    };
  }
  if (task?.status === 'cancelled') {
    return {
      status: 'polling',
      providerTaskStatus: 'CANCELED',
      progress,
      error: { code: 'WORKER_TASK_CANCELLED', message: 'The local worker task was cancelled.' },
    };
  }
  return {
    status: 'polling',
    providerTaskStatus: String(task?.stage || task?.status || 'RUNNING').toUpperCase(),
    progress,
  };
}

export async function localWorkerDownload(providerTaskId) {
  const buffer = await workerFetch(`/tasks/${encodeURIComponent(providerTaskId)}/glb`, {
    raw: true,
    timeoutMs: 60_000,
  });
  if (!buffer?.length) {
    throw Object.assign(new Error('The local worker returned an empty model.'), {
      code: 'WORKER_EMPTY_MODEL',
    });
  }
  return { buffer, contentType: 'model/gltf-binary' };
}

export async function localWorkerCancel(providerTaskId) {
  await workerFetch(`/tasks/${encodeURIComponent(providerTaskId)}/cancel`, {
    method: 'POST',
    timeoutMs: 10_000,
  }).catch(() => {});
  return true;
}

/**
 * Real reachability of the worker, for the operator-facing health read. Reports
 * the device, GPU and which marching-cubes backend is in use — facts an operator
 * needs to know whether a failure is "worker is down" or "worker is on CPU".
 */
export async function localWorkerHealth() {
  if (!isLocalWorkerUrl()) return { ok: false, detail: LOCAL_WORKER_REASON };
  try {
    const health = await workerFetch('/health');
    if (!health?.ready) {
      return {
        ok: false,
        detail: health?.detail || 'The local worker is running but its model is not loaded.',
        worker: health || null,
      };
    }
    return {
      ok: true,
      detail:
        `The local worker is ready: ${health.model} on ${health.device}` +
        (health.gpuName ? ` (${health.gpuName}, ${health.vramTotalMb} MB VRAM)` : '') +
        `, marching cubes via ${health.marchingCubes}.`,
      worker: health,
    };
  } catch (err) {
    return { ok: false, detail: err?.message || 'The local worker could not be reached.' };
  }
}

/** The provider object the registry stores. */
export const localWorkerProvider = {
  name: PROVIDER_LOCAL_WORKER,
  submit: localWorkerSubmit,
  status: localWorkerStatus,
  download: localWorkerDownload,
  cancel: localWorkerCancel,
  health: localWorkerHealth,
};

export default {
  PROVIDER_LOCAL_WORKER,
  workerUrl,
  isLocalWorkerUrl,
  localWorkerConfigured,
  describeLocalWorker,
  localWorkerProvider,
  localWorkerSubmit,
  localWorkerStatus,
  localWorkerDownload,
  localWorkerCancel,
  localWorkerHealth,
};
