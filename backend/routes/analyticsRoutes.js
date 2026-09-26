import { Router } from 'express';
import { overview, sales, performance } from '../controllers/analyticsController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';

const router = Router();

// PHASE-22.2: NOT YET TENANT-SCOPED — no requireWorkspace on this router (docs/MULTI-TENANT.md).

router.use(protect, adminOrHandler);

router.get('/overview', overview);
router.get('/sales', sales);
router.get('/performance', performance);

export default router;
