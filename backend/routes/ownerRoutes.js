import { Router } from 'express';
import { getOwnerOverview, listAdministrators } from '../controllers/ownerController.js';
import { protect, requireOwner } from '../middleware/authMiddleware.js';

/**
 * Phase 21.2 — OWNER PORTAL routes.
 *
 * Every route runs behind `protect + requireOwner`. `protect` re-reads the
 * user from the database on each request, so a suspended owner loses access
 * immediately and a forged JWT claim cannot grant ownership. A plain
 * administrator (role admin, isOwner false) is refused with 403 — which is
 * exactly what the RBAC matrix requires of the Owner Portal.
 */
const router = Router();

router.use(protect, requireOwner);

router.get('/overview', getOwnerOverview);
router.get('/administrators', listAdministrators);

export default router;
