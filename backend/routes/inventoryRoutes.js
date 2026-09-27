import { Router } from 'express';
import {
  overview,
  byProduct,
  history,
  adjust,
} from '../controllers/inventoryController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspace } from '../middleware/workspaceMiddleware.js';

const router = Router();

// Phase 22.3 — inventory is an operational surface end to end: staff only,
// workspace members only (owner excluded, 403 WORKSPACE_REQUIRED).
router.use(protect, adminOrHandler, requireWorkspace);

router.get('/', overview);
router.get('/history', history);
router.get('/:productId', byProduct);
router.post('/:productId/adjust', adjust);

export default router;
