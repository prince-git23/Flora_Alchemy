import { Router } from 'express';
import {
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
} from '../controllers/collectionController.js';
import { protect, optionalProtect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspace } from '../middleware/workspaceMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';

const router = Router();

// Phase 22.3 — reads mirror productRoutes: ungated for the storefront, with
// the staff token's workspace decided in `catalogueContext`. Writes gated so
// only workspace members (never the platform owner) can mutate collections.
//
// GRANULAR STAFF ACCESS — same rule as the catalogue: a staff session on the
// shared read is permission-checked, visitors and customers are unaffected.
const collectionRead = requirePermission('collections.view', { onlyStaff: true, skipNonStaff: true });
router.get('/', optionalProtect, collectionRead, listCollections);
router.get('/:id', optionalProtect, collectionRead, getCollection);

router.post('/', protect, adminOrHandler, requireWorkspace, requirePermission('collections.create'), createCollection);
router.patch('/:id', protect, adminOrHandler, requireWorkspace, requirePermission('collections.update'), updateCollection);
router.delete('/:id', protect, adminOrHandler, requireWorkspace, requirePermission('collections.delete'), deleteCollection);

export default router;
