import { Router } from 'express';
import {
  listStaff,
  getStaffMember,
  getStaffActivity,
  suspendStaff,
  reactivateStaff,
  updateStaffProfile,
} from '../controllers/staffController.js';
import { protect, requireRole } from '../middleware/authMiddleware.js';

/**
 * Phase 20.6.4 — staff directory + lifecycle.
 *
 * Every route requires an authenticated ADMIN. Handlers (403) and customers
 * (403) cannot read the directory at all — there is no read-only staff view
 * for handlers, because the roster contains colleague contact details.
 *
 * The finer matrix (only the owner may act on an administrator; nobody may act
 * on themselves; the last active admin is protected) is enforced per-target in
 * the controller, where the target's role is actually known.
 */
const router = Router();

router.use(protect, requireRole('admin'));

router.get('/', listStaff);
router.get('/:id', getStaffMember);
router.get('/:id/activity', getStaffActivity);
router.post('/:id/suspend', suspendStaff);
router.post('/:id/reactivate', reactivateStaff);
router.patch('/:id', updateStaffProfile);

export default router;
