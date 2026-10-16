/**
 * 3D STUDIO — Phase 1 — reference-image routes (mounted at /api/references).
 *
 * Gate order is the project's standard for staff writes and it matters that the
 * order is exactly this:
 *
 *   protect            → who is this? (role/status/workspace re-read from the DB)
 *   adminOrHandler     → staff only; a customer is refused before anything else
 *   requireWorkspace   → the caller must be a member of an ACTIVE workspace
 *   requirePermission  → the granular product permission the operation needs
 *   referenceUpload…   → ONLY NOW may a file be handed to the server
 *
 * A non-member therefore never gets as far as multer parsing a body, which is
 * the same rule /api/uploads/product-image already follows.
 *
 * There is deliberately NO public route: reference media is unreviewed working
 * material and is served only through the authenticated `/:id/file/:kind` path.
 */

import { Router } from 'express';
import { protect, adminOrHandler, requireOwner } from '../middleware/authMiddleware.js';
import { stripClientWorkspaceId, requireWorkspace } from '../middleware/workspaceMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';
import { uploadLimiter } from '../middleware/securityMiddleware.js';
import { referenceUploadMiddleware } from '../controllers/uploadController.js';
import {
  attachReferenceImagesHandler,
  cleanupReferencesHandler,
  deleteReferenceImageHandler,
  engineInfoHandler,
  getReferenceAssetHandler,
  getReferenceImageHandler,
  listReferenceImagesHandler,
  reorderReferenceImagesHandler,
  reprocessReferenceImageHandler,
  updateReferenceImageHandler,
  uploadReferenceImage,
} from '../controllers/referenceImageController.js';

const router = Router();

const staff = [protect, adminOrHandler, requireWorkspace];
const canView = requirePermission('products.view');
const canEdit = requirePermission('products.update');

// Fixed paths BEFORE '/:id' so `/engine`, `/order` and `/attach` are never
// captured as an id (Express matches in registration order).
router.get('/engine', ...staff, canView, engineInfoHandler);

// Internal maintenance. Owner-only ON TOP of the staff gate, and it still only
// ever deletes references that were never attached to a product.
router.post('/cleanup', protect, requireOwner, cleanupReferencesHandler);

router.get('/', ...staff, canView, listReferenceImagesHandler);

// The upload cap is applied HERE and not to the whole router: a review screen
// legitimately fetches 2–3 assets per image, so counting reads against the
// disk-filling budget would make the studio unusable after one product.
router.post(
  '/',
  ...staff,
  canEdit,
  uploadLimiter,
  referenceUploadMiddleware.single('image'),
  stripClientWorkspaceId,
  uploadReferenceImage
);

router.post('/attach', ...staff, canEdit, attachReferenceImagesHandler);
router.patch('/order', ...staff, canEdit, reorderReferenceImagesHandler);

router.get('/:id', ...staff, canView, getReferenceImageHandler);
router.get('/:id/file/:kind', ...staff, canView, getReferenceAssetHandler);
router.patch('/:id', ...staff, canEdit, updateReferenceImageHandler);
router.post('/:id/reprocess', ...staff, canEdit, reprocessReferenceImageHandler);
router.delete('/:id', ...staff, canEdit, deleteReferenceImageHandler);

export default router;
