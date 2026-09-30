import { Router } from 'express';
import { overview, sales, performance } from '../controllers/analyticsController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspace } from '../middleware/workspaceMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';

const router = Router();

// Phase 22.3 — analytics are operational: workspace members only. The gate's
// scope is what every aggregate's first $match uses (analyticsService), so a
// handler can never widen its own numbers by passing a filter.
// GRANULAR STAFF ACCESS — business numbers are an explicit authority.
router.use(protect, adminOrHandler, requireWorkspace, requirePermission('analytics.view'));

router.get('/overview', overview);
router.get('/sales', sales);
router.get('/performance', performance);

export default router;
