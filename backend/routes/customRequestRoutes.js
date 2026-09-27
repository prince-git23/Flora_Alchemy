import { Router } from 'express';
import {
  createCustomRequest,
  listMyCustomRequests,
  listAllCustomRequests,
  updateCustomRequestStatus,
} from '../controllers/customRequestController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import {
  requireWorkspace,
  requireWorkspaceForStaff,
} from '../middleware/workspaceMiddleware.js';

const router = Router();

router.use(protect);

// Customer: submit a custom request
router.post('/', createCustomRequest);

// Customer: list their own requests
router.get('/mine', listMyCustomRequests);

// Staff: list all requests (workspace members only)
router.get('/', adminOrHandler, requireWorkspace, listAllCustomRequests);

// Staff: update status (workspace members only; cross-workspace id → 404)
router.patch('/:id/status', adminOrHandler, requireWorkspace, updateCustomRequestStatus);

export default router;
