import { Router } from 'express';
import {
  submitApplication,
  listApplications,
  getApplicationById,
  approveApplication,
  rejectApplication,
} from '../controllers/adminApplicationController.js';
import { protect, requireOwner } from '../middleware/authMiddleware.js';
import { applicationLimiter, apiWriteLimiter } from '../middleware/securityMiddleware.js';

/**
 * Phase 20.6.6 — admin application routes (public intake + owner review).
 *
 * The PUBLIC intake endpoint sits above every guard: submitting an
 * application must never require a session, and applicationLimiter (applied
 * on the POST below) caps how many dossiers one IP can
 * file. It creates a review record only — no account, no credential.
 *
 * Everything else runs behind `protect + requireOwner`: an owner is an
 * administrator carrying the isOwner designation, re-read from the database
 * on every request, so neither a forged token claim nor a plain
 * administrator session can approve an application. Frontend visibility
 * (OwnerRoute) is UX; these guards are the authority.
 */
const router = Router();

// PUBLIC — application intake.
router.post('/', applicationLimiter, submitApplication);

// OWNER — review, dossier, approve, reject.
router.use(protect, requireOwner);

router.get('/', listApplications);
router.get('/:id', getApplicationById);
router.post('/:id/approve', apiWriteLimiter, approveApplication);
router.post('/:id/reject', apiWriteLimiter, rejectApplication);

export default router;
