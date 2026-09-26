import { Router } from 'express';
import {
  listOperators,
  createOperator,
  updateOperatorRole,
  updateOperatorStatus,
  deleteOperator,
} from '../controllers/adminUserController.js';
import { protect, requireRole } from '../middleware/authMiddleware.js';

const router = Router();

// PHASE-22.2: NOT YET TENANT-SCOPED — operator list/creation still GLOBAL (docs/MULTI-TENANT.md).

// All admin user management routes require admin role.
router.use(protect, requireRole('admin'));

router.get('/', listOperators);
router.post('/', createOperator);
router.patch('/:id/role', updateOperatorRole);
router.patch('/:id/status', updateOperatorStatus);
router.delete('/:id', deleteOperator);

export default router;
