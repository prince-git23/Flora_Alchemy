import { Router } from 'express';
import { getInvitation, activateInvitation } from '../controllers/invitationController.js';

/**
 * Phase 20.6.2 — PUBLIC invitation endpoints.
 *
 * Deliberately unauthenticated: the invitation token IS the credential
 * (256-bit, single-use, 72-hour TTL). The invitationLimiter (mounted in
 * server.js) caps probing; nothing here accepts a role, an email, or any
 * other account attribute from the client — everything comes from the
 * invitation document minted during owner approval.
 */
const router = Router();

router.get('/:token', getInvitation);
router.post('/:token/activate', activateInvitation);

export default router;
