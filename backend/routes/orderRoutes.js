import { Router } from 'express';
import {
  listOrders,
  listMyOrders,
  getOrder,
  createCustomerOrder,
  createStaffOrder,
  updateOrderStatus,
} from '../controllers/orderController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';

const router = Router();

// PHASE-22.2: NOT YET TENANT-SCOPED — no requireWorkspace on this router (docs/MULTI-TENANT.md).

router.use(protect);

// Customers: their own orders.
router.get('/mine', listMyOrders);

// Staff: full operational order list.
router.get('/', adminOrHandler, listOrders);

// Staff: update lifecycle status.
router.patch('/:id/status', adminOrHandler, updateOrderStatus);

// Create order (customer only — controller enforces role).
router.post('/', createCustomerOrder);

// Staff creates an order for a verified existing customer.
router.post('/admin', adminOrHandler, createStaffOrder);

// Read: owner (customer) or staff.
router.get('/:id', getOrder);

export default router;
