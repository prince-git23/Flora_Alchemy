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

const router = Router();

// PHASE-22.2: NOT YET TENANT-SCOPED — no requireWorkspace on this router (docs/MULTI-TENANT.md).

router.use(protect);

// Own profile + own addresses (must be declared before /:id).
router.get('/me', getMyProfile);
router.get('/me/addresses', requireRole('customer'), getMyAddresses);
router.post('/me/addresses', requireRole('customer'), addAddress);
router.patch('/me/addresses/:addressId', requireRole('customer'), updateAddress);
router.delete('/me/addresses/:addressId', requireRole('customer'), deleteAddress);

// Staff-only collection listing (handler portal customer list).
router.get('/', adminOrHandler, listCustomers);

// Detail: owner (customer) or staff; controller enforces ownership.
router.get('/:id', getCustomer);

// Update: owner or staff; controller enforces ownership.
router.patch('/:id', updateCustomer);

export default router;
