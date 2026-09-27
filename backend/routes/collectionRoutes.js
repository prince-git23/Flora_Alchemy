import { Router } from 'express';
import {
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
} from '../controllers/collectionController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspace } from '../middleware/workspaceMiddleware.js';

const router = Router();

// Phase 22.3 — reads mirror productRoutes: ungated for the storefront, with
// the staff token's workspace decided in `catalogueContext`. Writes gated so
// only workspace members (never the platform owner) can mutate collections.
router.get('/', listCollections);
router.get('/:id', getCollection);

router.post('/', protect, adminOrHandler, requireWorkspace, createCollection);
router.patch('/:id', protect, adminOrHandler, requireWorkspace, updateCollection);
router.delete('/:id', protect, adminOrHandler, requireWorkspace, deleteCollection);

export default router;
