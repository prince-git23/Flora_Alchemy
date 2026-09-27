import { Router } from 'express';
import { getShopProfile } from '../controllers/shopController.js';

/**
 * Phase 22.4 — public shop directory (`/shops/<slug>` storefront routing).
 * Read-only, tokenless; mounted at /api/shops in server.js.
 */
const router = Router();

router.get('/:slug', getShopProfile);

export default router;
