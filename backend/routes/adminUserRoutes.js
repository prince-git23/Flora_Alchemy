import { Router } from 'express';
import {
  listOperators,
  createOperator,
  updateOperatorRole,
  updateOperatorStatus,
  deleteOperator,
} from '../controllers/adminUserController.js';
import { protect, requireRole } from '../middleware/authMiddleware.js';
import { requireWorkspaceOrOwner } from '../middleware/workspaceMiddleware.js';

const router = Router();

// Phase 22.3 — operator management is membership-aware:
//   owner        → platform scope (§19 Administrators); mints platform ids;
//   workspace admin → its own workspace's operators (mints members);
//   compat mode  → unchanged until the first workspace exists.
router.use(protect, requireRole('admin'), requireWorkspaceOrOwner);

router.get('/', listOperators);
router.post('/', createOperator);
router.patch('/:id/role', updateOperatorRole);
router.patch('/:id/status', updateOperatorStatus);
router.delete('/:id', deleteOperator);

export default router;
