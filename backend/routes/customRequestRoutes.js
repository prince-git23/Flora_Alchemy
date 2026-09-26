import { Router } from 'express';
import {
  createCustomRequest,
  listMyCustomRequests,
  listAllCustomRequests,
  updateCustomRequestStatus,
} from '../controllers/customRequestController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';

const router = Router();

// PHASE-22.2: NOT YET TENANT-SCOPED — no requireWorkspace on this router (docs/MULTI-TENANT.md).

router.use(protect);

// Customer: submit a custom request
router.post('/', createCustomRequest);

// Customer: list their own requests
router.get('/mine', listMyCustomRequests);

// Staff: list all requests
router.get('/', adminOrHandler, listAllCustomRequests);

// Staff: update status
router.patch('/:id/status', adminOrHandler, updateCustomRequestStatus);

export default router;
