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
import {
  requirePermission,
  requireAnyPermission,
} from '../middleware/permissionMiddleware.js';

const router = Router();

router.use(protect);

// Customers: their own orders (identity-scoped in the controller; customers
// are never workspace members so the gate skips them).
router.get('/mine', listMyOrders);

// Staff: full operational order list — workspace members only.
router.get('/', adminOrHandler, requireWorkspace, requirePermission('orders.view'), listOrders);

// Staff: update lifecycle status. The route admits anyone holding ANY
// order-write permission; the controller then requires the EXACT permission for
// the target stage (confirmed → orders.accept, shipped → orders.fulfillment,
// delivered → orders.complete, production stages → orders.update_status), so a
// packing-only handler cannot declare an order delivered.
router.patch(
  '/:id/status',
  adminOrHandler,
  requireWorkspace,
  requireAnyPermission(['orders.accept', 'orders.update_status', 'orders.fulfillment', 'orders.complete']),
  updateOrderStatus
);

// Create order (customer only — controller enforces role).
router.post('/', createCustomerOrder);

// Staff creates an order for a verified existing customer.
router.post('/admin', adminOrHandler, requireWorkspace, requirePermission('orders.create'), createStaffOrder);

// Read: owner (customer) or staff. Customers keep their ownership path
// (skipNonStaff); staff must be a workspace member and hold orders.view.
router.get(
  '/:id',
  requireWorkspaceForStaff,
  requirePermission('orders.view', { skipNonStaff: true }),
  getOrder
);

export default router;
