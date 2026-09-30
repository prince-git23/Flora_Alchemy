import { Router } from 'express';
import {
  overview,
  byProduct,
  history,
  adjust,
} from '../controllers/inventoryController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspace } from '../middleware/workspaceMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';

const router = Router();

// Phase 22.3 — inventory is an operational surface end to end: staff only,
// workspace members only (owner excluded, 403 WORKSPACE_REQUIRED).
// GRANULAR STAFF ACCESS — reading stock, reading the movement ledger and
// WRITING a movement are three separate authorities: a handler can be trusted
// with visibility without being trusted to change quantities.
router.use(protect, adminOrHandler, requireWorkspace);

router.get('/', requirePermission('inventory.view'), overview);
router.get('/history', requirePermission('inventory.movement.view'), history);
router.get('/:productId', requirePermission('inventory.view'), byProduct);
router.post('/:productId/adjust', requirePermission('inventory.adjust'), adjust);

export default router;
