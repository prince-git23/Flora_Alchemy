import { Router } from 'express';
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} from '../controllers/productController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspace } from '../middleware/workspaceMiddleware.js';

const router = Router();

// Phase 22.3 — public catalogue reads stay ungated: the storefront has no
// session, and the workspace decision for a staff token is taken inside
// `catalogueContext` (server-derived, DB-backed). Writes are gated.

// Public catalogue reads (hidden products excluded server-side).
router.get('/', listProducts);
router.get('/:id', getProduct);

// Staff writes — workspace membership required (403 WORKSPACE_REQUIRED for
// the owner, who is a platform identity and never a workspace member).
router.post('/', protect, adminOrHandler, requireWorkspace, createProduct);
router.patch('/:id', protect, adminOrHandler, requireWorkspace, updateProduct);
router.delete('/:id', protect, adminOrHandler, requireWorkspace, deleteProduct);

export default router;
