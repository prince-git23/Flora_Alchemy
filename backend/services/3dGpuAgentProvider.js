/**
 * 3D LOCAL GPU AGENT PROVIDER — the REMOTE self-hosted GPU machine.
 *
 * Phase 4 shipped `local_worker`: the backend DRIVES a worker on its own
 * loopback, submitting work and polling for the result. That is the right shape
 * for a co-located process and the WRONG shape for production: Render cannot
 * dial 127.0.0.1 of the owner's Windows PC, and exposing a worker port to the
 * internet would put an unauthenticated inference server in public reach.
 *
 * This provider reverses the direction of travel, which is the whole design:
 *
 *   local_worker     backend ──HTTP──▶ worker (loopback / LAN)
 *   local_gpu_agent  agent   ──HTTPS──▶ backend (the deployed API), claims a
 *                                      job from the database, runs TripoSR on
 *                                      the local GPU, uploads the GLB.
 *
 * The backend never dials the PC. The agent holds a MACHINE CREDENTIAL
 * (`THREE_WORKER_AGENT_TOKEN`) plus a per-JOB LEASE token minted at claim time
 * (see models/GenerationJob.js). Jobs are QUEUED, not started in-process: the
 * request that creates one returns immediately, and the job stays queued until
 * an agent claims it — which is what makes an offline PC an honest WAITING
 * state instead of a failure.
 *
 * AVAILABILITY IS NEVER ASSUMED. `configured` (a token exists) and `online`
 * (a fresh heartbeat — see models/GpuAgent.js) are deliberately different
 * facts. `describeGpuAgent()` reports the first; `gpuAgentHealth()` reads the
 * second from the database, so "THREE_D_PROVIDER has a value" can never masquerade
 * as "the agent is running".
 *
 * POLICY: same as every provider here — free, opt-in, never a fallback. The
 * metered adapter remains reachable ONLY by explicit configuration, and a local
 * failure is never followed by a silent paid retry.
 */

import { PROVIDER_LOCAL_WORKER } from './3dLocalWorkerProvider.js';

export const PROVIDER_LOCAL_GPU_AGENT = 'local_gpu_agent';

/** Minimum accepted machine-token length. Short tokens are a misconfiguration. */
export const AGENT_TOKEN_MIN_LENGTH = 16;

const AGENT_REASON_NO_TOKEN =
  'The remote GPU agent provider is selected but THREE_WORKER_AGENT_TOKEN is not set (or is shorter ' +
  `than ${AGENT_TOKEN_MIN_LENGTH} characters). Generate a long random secret, put it in the backend's ` +
  'environment AND in the PC agent\'s environment, then restart. Until then generation stays disabled ' +
  'rather than pretending an agent exists.';

const AGENT_REASON_NO_PROVIDER =
  'This server would accept a remote GPU agent, but THREE_D_PROVIDER is not set to local_gpu_agent.';

/** The machine token, read fresh every time, never returned by any payload. */
export function agentToken() {
  return String(process.env.THREE_WORKER_AGENT_TOKEN || '');
}

/** True when an agent credential is configured strongly enough to accept. */
export function isAgentConfigured() {
  return agentToken().length >= AGENT_TOKEN_MIN_LENGTH;
}

/**
 * The base URL an agent should call (`/api` of the deployed backend). Purely
 * informational for the studio and the readiness report — the backend itself
 * never calls the agent, so this is display-only and carries no credential.
 */
export function agentApiBase() {
  return String(process.env.THREE_WORKER_AGENT_URL || '').trim().replace(/\/+$/, '');
}

/** Describe the provider for the UI. Synchronous; `available` = CONFIGURED. */
export function describeGpuAgent() {
  const configured = isAgentConfigured();
  return {
    name: PROVIDER_LOCAL_GPU_AGENT,
    label: 'Remote GPU agent (TripoSR on the owner\'s PC)',
    available: configured,
    reason: configured ? '' : AGENT_REASON_NO_TOKEN,
    model: 'TripoSR',
    modelVersion: 'triposr-1.0',
    maxInputs: 1,
    supportsMultiView: false,
    metered: false,
    local: false,
    agent: true,
    requiresAgent: true,
    apiBase: agentApiBase(),
    notes:
      'Jobs are QUEUED for the self-hosted agent (tools/3d-worker/agent.py). They start when the PC ' +
      'claims them; while the agent is offline they simply wait, and the studio says so honestly.',
  };
}

/**
 * True when the operator selected this provider AND configured it. Reachability
 * is a separate, honest, database-backed check (`gpuAgentHealth`) — a token on
 * the server says nothing about whether the PC is running.
 */
export function gpuAgentConfigured() {
  return isAgentConfigured();
}

/**
 * Honest health: the most recent heartbeat, never the configuration. A configured
 * token with a stale heartbeat is NOT healthy, and says so with the window.
 */
export async function gpuAgentHealth() {
  if (!isAgentConfigured()) {
    return { ok: false, detail: AGENT_REASON_NO_TOKEN, agent: null };
  }
  const { latestAgentSnapshot, agentStaleMs } = await import('../models/GpuAgent.js');
  const snapshot = await latestAgentSnapshot().catch(() => null);
  if (!snapshot || !snapshot.online) {
    const seconds = Math.round(agentStaleMs() / 1000);
    return {
      ok: false,
      detail: snapshot
        ? `The GPU agent last checked in ${Math.round((snapshot.ageMs || 0) / 1000)}s ago (stale after ${seconds}s) — ` +
          'jobs stay queued until it reconnects.'
        : `No GPU agent has checked in yet (stale after ${seconds}s). Start tools/3d-worker/agent.py on the PC.`,
      agent: snapshot,
    };
  }
  const facts = [
    snapshot.gpuName || null,
    snapshot.modelLoaded ? 'model loaded' : 'model NOT loaded',
    snapshot.state,
  ].filter(Boolean);
  return {
    ok: true,
    detail: `The GPU agent "${snapshot.workerId}" is online (${facts.join(', ')}).`,
    agent: snapshot,
  };
}

/**
 * The provider object in the registry.
 *
 * submit/status/download/cancel exist ONLY so the registry contract holds; the
 * agent path never runs the in-process `runJob` loop, and if anything ever
 * reaches these they REFUSE loudly rather than pretending to work.
 */
export const gpuAgentProvider = {
  name: PROVIDER_LOCAL_GPU_AGENT,
  submit: async () => {
    throw Object.assign(
      new Error(
        'The remote GPU agent provider does not accept in-process submission: jobs are queued and ' +
          'claimed by the agent over its authenticated API.'
      ),
      { code: 'AGENT_NOT_DISPATCHED' }
    );
  },
  status: async () => ({ status: 'polling', providerTaskStatus: 'WAITING_FOR_AGENT' }),
  download: async () => {
    throw Object.assign(
      new Error('The remote GPU agent uploads its result directly; there is nothing to download.'),
      { code: 'AGENT_NOT_DISPATCHED' }
    );
  },
  // A cancel is the JOB state (models/GenerationJob clears the lease); the
  // agent learns about it on its next heartbeat and aborts local inference.
  cancel: async () => true,
  health: gpuAgentHealth,
};

/** Re-exported so the registry can keep one import per provider family. */
export { PROVIDER_LOCAL_WORKER };

export default {
  PROVIDER_LOCAL_GPU_AGENT,
  AGENT_TOKEN_MIN_LENGTH,
  agentToken,
  isAgentConfigured,
  agentApiBase,
  describeGpuAgent,
  gpuAgentConfigured,
  gpuAgentHealth,
  gpuAgentProvider,
};
