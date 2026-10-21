/**
 * GpuAgent — 3D Studio (remote GPU agent) — the heartbeat of ONE self-hosted
 * inference machine.
 *
 * The deployed backend cannot connect to the owner's PC (Render must never dial
 * a loopback/LAN address), so availability is observed the other way round: the
 * agent calls home on a short interval and this collection remembers what it
 * last said. ONE document per `workerId`, overwritten in place — it is a status
 * register, not an event log.
 *
 * WHY A DOCUMENT AND NOT AN ENVIRONMENT VARIABLE
 *   `THREE_D_PROVIDER=local_gpu_agent` says the DEPLOYMENT wants an agent; it says
 *   nothing about whether the PC is actually running. The studio must never
 *   report "available" from configuration alone, so `online` is always computed
 *   from `lastSeenAt` against a documented staleness window (see
 *   `agentStaleMs`), and a heartbeat older than the window is OFFLINE.
 *
 * WHAT IS IN HERE
 *   Facts the agent reported about itself (model, GPU, state) plus the one
 *   server-side fact that matters operationally: `lastSeenAt`, stamped by THIS
 *   server on every heartbeat. The token is never stored here or anywhere: the
 *   agent authenticates with it, the server only compares it.
 *
 * TENANCY — deliberately NONE. A GPU agent is a machine of the deployment, not
 * of a tenant: it may only ever touch jobs its own claims bind it to (enforced
 * per job by the lease). This register carries no workspace data.
 */

import mongoose from 'mongoose';

/** Agent states an operator can read at a glance. */
export const AGENT_STATES = ['starting', 'idle', 'busy', 'stopping', 'error'];

/**
 * How long a heartbeat stays fresh. Defaults are chosen as a pair:
 *   · the agent heartbeats every 20 s (`THREE_AGENT_HEARTBEAT_INTERVAL_MS`);
 *   · 60 s tolerates two missed beats (GC pause, brief Wi-Fi drop) before the
 *     studio honestly reports offline, and it is what a stale job lease
 *     recovery window is measured against.
 */
export const DEFAULT_STALE_MS = 60_000;

/** Configured staleness window in ms; never negative, never NaN. */
export function agentStaleMs() {
  const raw = Number(process.env.THREE_AGENT_HEARTBEAT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_STALE_MS;
}

const gpuAgentSchema = new mongoose.Schema(
  {
    workerId: { type: String, required: true, unique: true, trim: true },
    state: { type: String, enum: AGENT_STATES, default: 'idle' },

    // What the agent reports about itself. None of it is trusted for anything
    // beyond display and diagnostics — a lying heartbeat cannot grant access.
    modelLoaded: { type: Boolean, default: false },
    model: { type: String, default: '' },
    modelVersion: { type: String, default: '' },
    device: { type: String, default: '' },
    gpuName: { type: String, default: '' },
    vramTotalMb: { type: Number, default: 0 },
    agentVersion: { type: String, default: '' },

    // The job the agent says it is working on (informational — the AUTHORITY
    // for a claim is the GenerationJob's own lease, never this field).
    currentJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'GenerationJob', default: null },

    // Server-stamped. The ONLY field availability is computed from.
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true }
);

gpuAgentSchema.index({ lastSeenAt: -1 });

gpuAgentSchema.set('toJSON', {
  transform(_doc, item) {
    const out = { ...item };
    out.id = item._id ? item._id.toString() : null;
    delete out._id;
    delete out.__v;
    out.currentJobId = item.currentJobId ? item.currentJobId.toString() : null;
    return out;
  },
});

const GpuAgent = mongoose.model('GpuAgent', gpuAgentSchema);

/**
 * Stamp (or create) the register for one worker. Returns the fresh snapshot.
 * A malformed worker id is refused here rather than stored for a later query to
 * trip over.
 */
export async function touchAgentHeartbeat(report = {}) {
  const workerId = String(report.workerId || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 64);
  if (!workerId) {
    throw Object.assign(new Error('A worker id is required for a heartbeat.'), { code: 'AGENT_NO_WORKER_ID' });
  }
  const state = AGENT_STATES.includes(report.state) ? report.state : 'idle';
  const now = new Date();
  const update = {
    state,
    modelLoaded: Boolean(report.modelLoaded),
    model: String(report.model || '').slice(0, 120),
    modelVersion: String(report.modelVersion || '').slice(0, 60),
    device: String(report.device || '').slice(0, 60),
    gpuName: String(report.gpuName || '').slice(0, 120),
    vramTotalMb: Number(report.vramTotalMb) > 0 ? Number(report.vramTotalMb) : 0,
    agentVersion: String(report.agentVersion || '').slice(0, 60),
    lastSeenAt: now,
  };
  if (report.currentJobId && mongoose.isValidObjectId(String(report.currentJobId))) {
    update.currentJobId = new mongoose.Types.ObjectId(String(report.currentJobId));
  } else {
    update.currentJobId = null;
  }

  const doc = await GpuAgent.findOneAndUpdate(
    { workerId },
    { $set: update, $setOnInsert: { workerId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return withOnline(doc, now);
}

/** The freshest register, or null when no agent has ever checked in. */
export async function latestAgentSnapshot() {
  const doc = await GpuAgent.findOne({}).sort({ lastSeenAt: -1 }).lean();
  if (!doc) return null;
  return withOnline(doc, new Date());
}

/** Attach `online` (within the staleness window) and `ageMs`. */
export function withOnline(doc, now = new Date()) {
  if (!doc) return null;
  const lastSeen = doc.lastSeenAt ? new Date(doc.lastSeenAt) : null;
  const ageMs = lastSeen ? now.getTime() - lastSeen.getTime() : null;
  return {
    workerId: doc.workerId,
    state: doc.state,
    modelLoaded: Boolean(doc.modelLoaded),
    model: doc.model || '',
    modelVersion: doc.modelVersion || '',
    device: doc.device || '',
    gpuName: doc.gpuName || '',
    vramTotalMb: doc.vramTotalMb || 0,
    agentVersion: doc.agentVersion || '',
    currentJobId: doc.currentJobId ? String(doc.currentJobId) : null,
    lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
    ageMs,
    online: ageMs !== null && ageMs <= agentStaleMs(),
    staleAfterMs: agentStaleMs(),
  };
}

export default GpuAgent;
