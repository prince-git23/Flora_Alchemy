import { Router } from 'express';
import {
  listCustomers,
  getCustomer,
  getMyProfile,
  updateCustomer,
  getMyAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
} from '../controllers/customerController.js';
import { protect, adminOrHandler, requireRole } from '../middleware/authMiddleware.js';
import {
  requireWorkspace,
  requireWorkspaceForStaff,
} from '../middleware/workspaceMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';

const router = Router();

router.use(protect);

// Own profile + own addresses (must be declared before /:id).
router.get('/me', getMyProfile);
router.get('/me/addresses', requireRole('customer'), getMyAddresses);
router.post('/me/addresses', requireRole('customer'), addAddress);
router.patch('/me/addresses/:addressId', requireRole('customer'), updateAddress);
router.delete('/me/addresses/:addressId', requireRole('customer'), deleteAddress);

// Staff-only collection listing (handler portal customer list) — membership
// required; the controller then applies the RELATIONSHIP rule (orders,
// conversations, custom requests) so a workspace only sees customers it served.
router.get('/', adminOrHandler, requireWorkspace, requirePermission('customers.view'), listCustomers);

// Detail: owner (customer) or staff; controller enforces ownership AND the
// relationship rule for staff (unrelated customer → 404). A customer reading
// its OWN profile keeps the ownership path (skipNonStaff); a handler needs
// customers.view.
router.get(
  '/:id',
  requireWorkspaceForStaff,
  requirePermission('customers.view', { skipNonStaff: true }),
  getCustomer
);

// Update: owner or staff; controller enforces ownership + relationship.
router.patch(
  '/:id',
  requireWorkspaceForStaff,
  requirePermission('customers.update', { skipNonStaff: true }),
  updateCustomer
);

export default router;
