/**
 * 3D AGENT ROUTES — the RESTRICTED internal API a self-hosted GPU agent calls.
 * Mounted at `/api/3d/agent`, BEFORE the staff router, and guarded by its own
 * MACHINE credential — no JWT, no session, no workspace, and nothing here is
 * reachable with a customer or staff token.
 *
 * AUTHENTICATION LAYERING (all three must pass for a job-scoped call):
 *   1. `agentLimiter`  — one machine, steady cadence; bounds credential guessing.
 *   2. `requireAgentToken` — the shared machine secret, constant-time, HTTPS in
 *      production (middleware/agentAuthMiddleware.js).
 *   3. the JOB'S OWN LEASE token (`x-agent-lease` header) — minted per job at
 *      claim time; checked inside the service against the authoritative job
 *      document. A machine that holds no lease can reach nothing but heartbeat,
 *      claim, and a 404/409 everywhere else.
 *
 * PROTOCOL (what agent.py speaks — see tools/3d-worker/agent.py):
 *   POST /heartbeat                  → presence + lease renewal + settings/queue
 *   POST /jobs/claim                 → { job } | { job: null }   (bounded long-poll)
 *   GET  /jobs/:id/input             → accepted references of the claimed job
 *   POST /jobs/:id/lease             → explicit renewal
 *   POST /jobs/:id/release           → unfinished job back to the queue
 *   POST /jobs/:id/result            → the GLB bytes (raw body, capped)
 *   POST /jobs/:id/failure           → bounded failure report
 *
 * DELIBERATELY ABSENT: any way to browse jobs, list workspaces, read a
 * reference that is not bound to a claimed job, fetch an uploaded model, or
 * approve anything. A generated model still needs a HUMAN approval through the
 * staff studio before any customer can see it.
 */

import { Router } from 'express';
import express from 'express';
import { requireAgentToken } from '../middleware/agentAuthMiddleware.js';
import { agentLimiter } from '../middleware/securityMiddleware.js';
import { MAX_GLB_BYTES } from '../services/3dModelValidation.js';
import * as agent from '../controllers/3dAgentController.js';

const router = Router();

router.use(agentLimiter);
router.use(requireAgentToken);

// ── presence ─────────────────────────────────────────────────────────────
router.post('/heartbeat', agent.heartbeatHandler);

// `/jobs/claim` is a LITERAL and is registered before the parameterised
// `/jobs/:jobId/...` family so it can never be captured as an id.
router.post('/jobs/claim', agent.claimHandler);

// ── one job, bound by its lease ──────────────────────────────────────────
router.get('/jobs/:jobId/input', agent.inputHandler);
router.post('/jobs/:jobId/lease', agent.leaseHandler);
router.post('/jobs/:jobId/release', agent.releaseHandler);
router.post('/jobs/:jobId/failure', agent.failureHandler);

// The result is a RAW body: the GLB is uploaded as bytes, not as JSON (a
// base64 JSON envelope would inflate a 60 MB model by a third for nothing).
// The cap is the same ceiling `validateGlb` enforces, plus a little slack;
// exceeding it is an honest 413 (see middleware/errorMiddleware.js).
router.post(
  '/jobs/:jobId/result',
  express.raw({ type: ['model/gltf-binary', 'application/octet-stream'], limit: MAX_GLB_BYTES + 1024 * 1024 }),
  agent.resultHandler
);

export default router;
