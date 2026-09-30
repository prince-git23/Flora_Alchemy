import { Router } from 'express';
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} from '../controllers/productController.js';
import { protect, optionalProtect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspace } from '../middleware/workspaceMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';

const router = Router();

// Phase 22.3 — public catalogue reads stay ungated: the storefront has no
// session, and the workspace decision for a staff token is taken inside
// `catalogueContext` (server-derived, DB-backed). Writes are gated.
//
// GRANULAR STAFF ACCESS — the read stays public for visitors and customers,
// but a request that carries a STAFF session is permission-checked, so a
// handler whose product access was removed cannot use the public branch to
// keep reading what its role no longer grants.

// Public catalogue reads (hidden products excluded server-side).
const catalogueRead = requirePermission('products.view', { onlyStaff: true, skipNonStaff: true });
router.get('/', optionalProtect, catalogueRead, listProducts);
router.get('/:id', optionalProtect, catalogueRead, getProduct);

// Staff writes — workspace membership required (403 WORKSPACE_REQUIRED for
// the owner, who is a platform identity and never a workspace member) and the
// exact permission required.
router.post('/', protect, adminOrHandler, requireWorkspace, requirePermission('products.create'), createProduct);
router.patch('/:id', protect, adminOrHandler, requireWorkspace, requirePermission('products.update'), updateProduct);
router.delete('/:id', protect, adminOrHandler, requireWorkspace, requirePermission('products.delete'), deleteProduct);

export default router;
