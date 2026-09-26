import { Router } from 'express';
import {
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
} from '../controllers/collectionController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';

const router = Router();

// PHASE-22.2: NOT YET TENANT-SCOPED — no requireWorkspace on this router (docs/MULTI-TENANT.md).

router.get('/', listCollections);
router.get('/:id', getCollection);

router.post('/', protect, adminOrHandler, createCollection);
router.patch('/:id', protect, adminOrHandler, updateCollection);
router.delete('/:id', protect, adminOrHandler, deleteCollection);

export default router;
