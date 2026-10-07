import { Router } from 'express';
import {
  listReviewsForModeration,
  setReviewStatus,
  deleteReview,
} from '../controllers/reviewController.js';
import { protect, adminOrHandler, requireRole } from '../middleware/authMiddleware.js';

/**
 * PHASE 3 — review moderation.
 *
 * Guarded by the EXISTING role authority (no new permission id is invented):
 *   · read + hide/restore → protect + adminOrHandler
 *   · permanent delete    → protect + requireRole('admin')
 *
 * Reviews are customer-global rather than workspace-owned, so these routes are
 * deliberately not workspace-scoped: a review is published about a product and
 * is moderated by the studio, not by one shop's operator. `protect` re-reads
 * the staff user from the database on every request, so a suspended or demoted
 * operator loses access immediately.
 */
const router = Router();

router.get('/', protect, adminOrHandler, listReviewsForModeration);
router.patch('/:reviewId/status', protect, adminOrHandler, setReviewStatus);
router.delete('/:reviewId', protect, requireRole('admin'), deleteReview);

export default router;
