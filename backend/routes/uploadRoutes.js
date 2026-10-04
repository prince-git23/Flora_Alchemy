import { Router } from 'express';
import { protect, adminOrHandler, requireRole } from '../middleware/authMiddleware.js';
import { stripClientWorkspaceId, requireWorkspace } from '../middleware/workspaceMiddleware.js';
import { uploadMiddleware, uploadProductImage, uploadCustomRequestImage } from '../controllers/uploadController.js';

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

// Customer review media. Same validated pipeline (MIME whitelist + 5 MB cap
// + ImageKit/local persistence) but opened to an authenticated CUSTOMER,
// because a review is customer-authored content. No workspace membership is
// required: reviews are customer-global, so the asset lands in the base
// folder with no tenant-scoped path.
router.post(
  '/review-image',
  protect,
  requireRole('customer'),
  uploadMiddleware.single('image'),
  uploadProductImage
);

// Customer reference image for a custom request. Same validated pipeline,
// opened to an authenticated CUSTOMER (the request is customer-authored),
// written under the custom-requests folder. The returned URL is what the
// customer's request stores as imageUrl.
router.post(
  '/custom-request-image',
  protect,
  requireRole('customer'),
  uploadMiddleware.single('image'),
  uploadCustomRequestImage
);

export default router;
