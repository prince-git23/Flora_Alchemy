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
router.get('/', adminOrHandler, requireWorkspace, listCustomers);

// Detail: owner (customer) or staff; controller enforces ownership AND the
// relationship rule for staff (unrelated customer → 404).
router.get('/:id', requireWorkspaceForStaff, getCustomer);

// Update: owner or staff; controller enforces ownership + relationship.
router.patch('/:id', requireWorkspaceForStaff, updateCustomer);

export default router;
