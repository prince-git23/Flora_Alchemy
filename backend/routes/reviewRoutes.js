import { Router } from 'express';
import { markReviewHelpful } from '../controllers/reviewController.js';

const router = Router();

// Public: a "was this helpful" tap is an anonymous vote. The counter is the
// only thing mutated — a customer's review text can never be edited here.
router.post('/:reviewId/helpful', markReviewHelpful);

export default router;
