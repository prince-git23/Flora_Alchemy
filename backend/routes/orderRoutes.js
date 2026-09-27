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
import {
  requireWorkspace,
  requireWorkspaceForStaff,
} from '../middleware/workspaceMiddleware.js';

const router = Router();

router.use(protect);

// Customers: their own orders (identity-scoped in the controller; customers
// are never workspace members so the gate skips them).
router.get('/mine', listMyOrders);

// Staff: full operational order list — workspace members only.
router.get('/', adminOrHandler, requireWorkspace, listOrders);

// Staff: update lifecycle status.
router.patch('/:id/status', adminOrHandler, requireWorkspace, updateOrderStatus);

// Create order (customer only — controller enforces role).
router.post('/', createCustomerOrder);

// Staff creates an order for a verified existing customer.
router.post('/admin', adminOrHandler, requireWorkspace, createStaffOrder);

// Read: owner (customer) or staff. Customers keep their ownership path;
// staff must be a workspace member (others get 404, never existence).
router.get('/:id', requireWorkspaceForStaff, getOrder);

export default router;
