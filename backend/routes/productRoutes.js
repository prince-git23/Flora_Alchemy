import { Router } from 'express';
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} from '../controllers/productController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';

const router = Router();

// PHASE-22.2: NOT YET TENANT-SCOPED — no requireWorkspace on this router (docs/MULTI-TENANT.md).

// Public catalogue reads (hidden products excluded server-side).
router.get('/', listProducts);
router.get('/:id', getProduct);

// Staff writes.
router.post('/', protect, adminOrHandler, createProduct);
router.patch('/:id', protect, adminOrHandler, updateProduct);
router.delete('/:id', protect, adminOrHandler, deleteProduct);

export default router;
