/**
 * 3D STUDIO — PHASE 11 — capture-set routes (mounted at /api/capture-sets).
 *
 * Gate order is the project's standard for staff surfaces, and the order matters:
 *
 *   protect            → who is this? (role/status/workspace re-read from the DB)
 *   adminOrHandler     → staff only; a customer is refused before anything else
 *   requireWorkspace   → the caller must be a member of an ACTIVE workspace
 *   requirePermission  → the granular product permission the operation needs
 *
 * There is deliberately NO public route: a capture set names private reference
 * rows, their hashes and their camera poses, and none of that is customer-facing.
 *
 * The only route that can reach a metered provider is `POST /:id/submit`, and it
 * additionally requires the deployment switch `THREE_D_METERED_SUBMIT=true` plus
 * an explicit `acknowledgeMetered: true` in the request — see the controller.
 */

import { Router } from 'express';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspace } from '../middleware/workspaceMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';
import { apiWriteLimiter } from '../middleware/securityMiddleware.js';
import {
  archiveCaptureSetHandler,
  captureCapabilitiesHandler,
  captureEnginesHandler,
  getCaptureSetHandler,
  previewPlanHandler,
  startCaptureSetHandler,
  submitCaptureSetHandler,
  updateCaptureSetHandler,
  validateCaptureSetHandler,
} from '../controllers/captureSetController.js';

const router = Router();

const staff = [protect, adminOrHandler, requireWorkspace];
const canView = requirePermission('products.view');
const canEdit = requirePermission('products.update');

// Fixed paths BEFORE '/:id' (Express matches in registration order).
router.get('/engines', ...staff, canView, captureEnginesHandler);
router.get('/capabilities', ...staff, canView, captureCapabilitiesHandler);

router.get('/', ...staff, canView, getCaptureSetHandler);
router.post('/', ...staff, canEdit, apiWriteLimiter, startCaptureSetHandler);

router.patch('/:id', ...staff, canEdit, apiWriteLimiter, updateCaptureSetHandler);
router.post('/:id/validate', ...staff, canEdit, apiWriteLimiter, validateCaptureSetHandler);
// Dry run: builds the exact submission plan and writes nothing.
router.post('/:id/plan', ...staff, canView, apiWriteLimiter, previewPlanHandler);
// The explicit action. Metered providers are additionally gated (see header).
router.post('/:id/submit', ...staff, canEdit, apiWriteLimiter, submitCaptureSetHandler);
router.post('/:id/archive', ...staff, canEdit, apiWriteLimiter, archiveCaptureSetHandler);

export default router;
