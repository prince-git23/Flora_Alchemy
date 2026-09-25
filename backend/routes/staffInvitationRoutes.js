import { Router } from 'express';
import {
  listInvitations,
  getInvitationById,
  createHandlerInvitation,
  resendInvitation,
  revokeInvitation,
} from '../controllers/staffInvitationController.js';
import { protect, requireRole } from '../middleware/authMiddleware.js';

/**
 * Phase 20.6.3 — invitation management for the staff console.
 *
 * These are the AUTHENTICATED invitation endpoints (an admin issuing,
 * resending or revoking an invitation). The PUBLIC landing/activation
 * endpoints live in invitationRoutes.js under /api/invitations and are
 * deliberately separate: one is authorized by a session, the other by token
 * possession, and mixing them in a single router would blur that boundary.
 *
 * requireRole('admin') is the authority: handlers and customers get 403 here,
 * so a handler can never invite another handler no matter what the UI shows.
 */
const router = Router();

router.use(protect, requireRole('admin'));

router.get('/', listInvitations);
router.post('/', createHandlerInvitation);
router.get('/:id', getInvitationById);
router.post('/:id/resend', resendInvitation);
router.post('/:id/revoke', revokeInvitation);

export default router;
