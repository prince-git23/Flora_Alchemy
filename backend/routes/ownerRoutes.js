import { Router } from 'express';
import {
  getOwnerOverview,
  listAdministrators,
  listShops,
  suspendShop,
  reactivateShop,
} from '../controllers/ownerController.js';
import { protect, requireOwner } from '../middleware/authMiddleware.js';

/**
 * Phase 21.2 — OWNER PORTAL routes.
 *
 * Every route runs behind `protect + requireOwner`. `protect` re-reads the
 * user from the database on each request, so a suspended owner loses access
 * immediately and a forged JWT claim cannot grant ownership. A plain
 * administrator (role admin, isOwner false) is refused with 403 — which is
 * exactly what the RBAC matrix requires of the Owner Portal.
 *
 * PHASE 1 — SHOP GOVERNANCE (`/shops`): the owner can list every
 * Workspace/Shop and suspend/reactivate one. This is a GOVERNANCE surface
 * only: the owner never manages a shop's inventory, orders or catalogue, and
 * never acts as shop staff (those are workspace-scoped and answer 403
 * WORKSPACE_REQUIRED). Status changes are server-authorized here and take
 * effect on the public surfaces immediately.
 */
const router = Router();

router.use(protect, requireOwner);

router.get('/overview', getOwnerOverview);
router.get('/administrators', listAdministrators);

// Phase 1 — shop lifecycle governance.
router.get('/shops', listShops);
router.post('/shops/:slug/suspend', suspendShop);
router.post('/shops/:slug/reactivate', reactivateShop);

export default router;