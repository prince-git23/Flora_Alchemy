import { Router } from 'express';
import { markReviewHelpful, reportReview } from '../controllers/reviewController.js';
import { protect, requireRole } from '../middleware/authMiddleware.js';
import { apiWriteLimiter } from '../middleware/securityMiddleware.js';

const router = Router();

/**
 * Public review actions.
 *
 * A "was this helpful" tap is an anonymous vote — the counter is the only thing
 * mutated, so a customer's review text can never be edited here.
 *
 * A report (PHASE 3) is an authenticated customer statement about someone
 * else's review: the author is the session, one report per customer, and the
 * review itself is never modified by reporting. It is a write, so it sits
 * behind the same write limiter as the rest of the public write surface.
 */
router.post('/:reviewId/helpful', markReviewHelpful);
router.post('/:reviewId/report', apiWriteLimiter, protect, requireRole('customer'), reportReview);

export default router;
