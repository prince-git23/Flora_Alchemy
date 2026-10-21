/**
 * 3D AGENT CONTROLLER — the remote GPU agent's endpoints.
 *
 * Thin, like every controller here: validate the shape of what the machine
 * sent, delegate to services/3dAgentService.js, shape the envelope. The
 * authentication (machine token) happened in middleware; the AUTHORITY for
 * everything else is the job's lease, enforced in the service.
 *
 * Nothing in any response carries the machine token, the lease token of a job
 * the caller does not hold, a workspace id, a storage key, or an account id —
 * the agent gets job facts, bytes it is entitled to, and the verdict on its
 * own upload. Nothing more.
 */

import { ApiError } from '../middleware/errorMiddleware.js';
import * as agent from '../services/3dAgentService.js';

/** A machine id is a label, not a credential: printable, bounded. */
function workerIdOf(raw) {
  return String(raw || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 64);
}

function leaseOf(req) {
  return String(req.headers['x-agent-lease'] || '').trim();
}

/** POST /api/3d/agent/heartbeat — stamp presence; renew the current lease. */
export async function heartbeatHandler(req, res, next) {
  try {
    const body = req.body || {};
    const report = await agent.heartbeat({
      workerId: workerIdOf(body.workerId),
      state: body.state,
      modelLoaded: Boolean(body.modelLoaded),
      model: body.model,
      modelVersion: body.modelVersion,
      device: body.device,
      gpuName: body.gpuName,
      vramTotalMb: body.vramTotalMb,
      agentVersion: body.agentVersion,
      currentJobId: body.currentJobId,
      leaseToken: body.leaseToken,
    });
    res.json({ success: true, ...report });
  } catch (err) {
    next(err);
  }
}

/** POST /api/3d/agent/jobs/claim — atomically take the next queued job. */
export async function claimHandler(req, res, next) {
  try {
    const body = req.body || {};
    const result = await agent.claimJobForAgent({
      workerId: workerIdOf(body.workerId),
      waitSeconds: body.waitSeconds,
    });
    // 200 with `job: null` is the honest empty answer (nothing queued) — not an
    // error the agent should back off from.
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** GET /api/3d/agent/jobs/:jobId/input — the accepted references of THIS job. */
export async function inputHandler(req, res, next) {
  try {
    const result = await agent.jobInput(req.params.jobId, leaseOf(req));
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/3d/agent/jobs/:jobId/lease — explicit renewal (heartbeat also renews). */
export async function leaseHandler(req, res, next) {
  try {
    const result = await agent.renewLease(req.params.jobId, leaseOf(req));
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/3d/agent/jobs/:jobId/release — give an unfinished job back to the queue. */
export async function releaseHandler(req, res, next) {
  try {
    const result = await agent.releaseJob(req.params.jobId, leaseOf(req));
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/3d/agent/jobs/:jobId/failure — a bounded, sanitized failure report. */
export async function failureHandler(req, res, next) {
  try {
    const body = req.body || {};
    const result = await agent.reportFailure(req.params.jobId, leaseOf(req), {
      code: body.code,
      message: body.message,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/3d/agent/jobs/:jobId/result — the finished GLB, as a raw body.
 *
 * The route's raw parser caps the body at the GLB ceiling (+1 MB slack for a
 * header-worth of overhead, mapped to an honest 413 by errorMiddleware); an
 * empty body is refused BEFORE the result slot is consumed, so a broken upload
 * does not burn the job's one chance — the agent reports a failure instead.
 */
export async function resultHandler(req, res, next) {
  try {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) {
      throw new ApiError(422, 'The result body was empty.', 'AGENT_EMPTY_RESULT');
    }
    const result = await agent.submitResult({
      jobId: req.params.jobId,
      leaseToken: leaseOf(req),
      glbBuffer: buffer,
      agentTaskId: req.query.taskId,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export default {
  heartbeatHandler,
  claimHandler,
  inputHandler,
  leaseHandler,
  releaseHandler,
  failureHandler,
  resultHandler,
};
