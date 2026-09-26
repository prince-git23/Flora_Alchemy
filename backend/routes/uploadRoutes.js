import { Router } from 'express';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { stripClientWorkspaceId } from '../middleware/workspaceMiddleware.js';
import { uploadMiddleware, uploadProductImage } from '../controllers/uploadController.js';

const router = Router();

// PHASE-22.2: NOT YET TENANT-SCOPED — uploads are not workspace-scoped (docs/MULTI-TENANT.md).

// Product image upload — staff only. Multipart handled by multer; validation
// (type + size) happens in the controller/multer filter. The workspace scrub
// runs AFTER multer because multipart fields never pass through express.json.
router.post('/product-image', protect, adminOrHandler, uploadMiddleware.single('image'), stripClientWorkspaceId, uploadProductImage);

export default router;
