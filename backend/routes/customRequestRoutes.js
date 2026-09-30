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
import {
  requirePermission,
  requireAnyPermission,
} from '../middleware/permissionMiddleware.js';

const router = Router();

router.use(protect);

// Customer: submit a custom request
router.post('/', createCustomRequest);

// Customer: list their own requests
router.get('/mine', listMyCustomRequests);

// Staff: list all requests (workspace members only)
router.get('/', adminOrHandler, requireWorkspace, requirePermission('requests.view'), listAllCustomRequests);

// Staff: update status (workspace members only; cross-workspace id → 404).
// The route admits anyone holding ANY request-write permission, then the
// controller re-checks the EXACT permission for the target status
// (reviewing → requests.claim, everything else → requests.update) through
// assertPermission, so a claim-only handler cannot quote or accept.
router.patch(
  '/:id/status',
  adminOrHandler,
  requireWorkspace,
  requireAnyPermission(['requests.claim', 'requests.update']),
  updateCustomRequestStatus
);

export default router;
