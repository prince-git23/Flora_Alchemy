/**
 * 3D MODEL ROUTES — 3D Studio (Phase 2) — mounted at `/api/3d`.
 *
 * GATE ORDER follows the project's standard for staff surfaces, and the order
 * matters (it is the same order `/api/references` uses):
 *
 *   protect          → who is this? role/status/workspace re-read from the DB
 *   adminOrHandler   → staff only; a customer is refused before anything else
 *   requireWorkspace → the caller must belong to an ACTIVE workspace
 *   requirePermission→ the granular product authority the operation needs
 *
 * So a platform owner or a non-member never reaches a handler that could touch a
 * product, and a handler who cannot see products cannot see their models either.
 *
 * There is deliberately NO public route in Phase 2. A generated model belongs to
 * the workspace that made it until the storefront tier (Phase 3) defines how a
 * customer may see an APPROVED one.
 *
 * Route shape: everything is addressed by product slug or job id, and slug routes
 * are nested under `/products/` so a slug can never be mistaken for a job id.
 */

import { Router } from 'express';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspace, stripClientWorkspaceId } from '../middleware/workspaceMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';
import { apiWriteLimiter } from '../middleware/securityMiddleware.js';
import * as generation from '../controllers/3dGenerationController.js';
import * as asset from '../controllers/3dAssetController.js';
import * as media from '../controllers/3dMediaController.js';

const router = Router();

const staff = [protect, adminOrHandler, requireWorkspace];
// Reading a model is a catalogue read; changing one is a catalogue change.
const canView = requirePermission('products.view');
const canEdit = requirePermission('products.update');

// ── Provider capability ───────────────────────────────────────────────────
// Registered before anything that could shadow it, and it is a READ: asking
// whether generation is possible must never cost anything.
router.get('/provider', ...staff, canView, generation.providerStatusHandler);

// ── Per-product studio state ──────────────────────────────────────────────
router.get('/products/:productSlug/studio', ...staff, canView, generation.studioStateHandler);
router.get('/products/:productSlug/jobs', ...staff, canView, generation.listJobsHandler);
router.get('/products/:productSlug/assets', ...staff, canView, asset.listHandler);

// `/current` is registered BEFORE `/:assetId` so it is never captured as an id.
router.get('/products/:productSlug/assets/current', ...staff, canView, asset.currentHandler);

// ── Starting work ─────────────────────────────────────────────────────────
// Generation is a WRITE and costs money when a metered provider is configured,
// so it sits behind the write limiter as well as the permission gate.
router.post(
  '/products/:productSlug/jobs',
  ...staff,
  canEdit,
  apiWriteLimiter,
  stripClientWorkspaceId,
  generation.createJobHandler
);

// ── Jobs ──────────────────────────────────────────────────────────────────
router.get('/jobs/:jobId', ...staff, canView, generation.getJobHandler);
router.post('/jobs/:jobId/retry', ...staff, canEdit, apiWriteLimiter, generation.retryJobHandler);
router.post('/jobs/:jobId/cancel', ...staff, canEdit, apiWriteLimiter, generation.cancelJobHandler);
router.post('/jobs/:jobId/approve', ...staff, canEdit, apiWriteLimiter, asset.approveHandler);
router.post('/jobs/:jobId/reject', ...staff, canEdit, apiWriteLimiter, asset.rejectHandler);

// ── Assets ────────────────────────────────────────────────────────────────
router.get('/assets/:assetId', ...staff, canView, asset.detailHandler);
router.delete('/assets/:assetId', ...staff, canEdit, apiWriteLimiter, asset.deleteHandler);
// PHASE 5 — re-measure a stored model against its accepted reference. A write
// (it recomputes and stores a verdict), hence canEdit rather than canView.
router.post('/assets/:assetId/assess', ...staff, canEdit, apiWriteLimiter, asset.assessHandler);

// ── Private media ─────────────────────────────────────────────────────────
// `kind` is `model` or `thumbnail`; the controller maps it to a storage kind and
// refuses anything else, so this path cannot be used to reach another file.
router.get('/media/:productSlug/:assetId/:kind', ...staff, canView, media.getMediaHandler);

export default router;
