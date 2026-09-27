import { Router } from 'express';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { stripClientWorkspaceId, requireWorkspace } from '../middleware/workspaceMiddleware.js';
import { uploadMiddleware, uploadProductImage } from '../controllers/uploadController.js';

const router = Router();

// Product image upload — staff only. Multipart handled by multer; validation
// (type + size) happens in the controller/multer filter. The workspace scrub
// runs AFTER multer because multipart fields never pass through express.json.
//
// Phase 22.3 — the membership gate runs BEFORE multer: a caller that is not a
// workspace member never gets to hand the server a file, and the resulting
// asset is written under the workspace's own upload directory.
router.post(
  '/product-image',
  protect,
  adminOrHandler,
  requireWorkspace,
  uploadMiddleware.single('image'),
  stripClientWorkspaceId,
  uploadProductImage
);

export default router;
