import { Router } from 'express';
import {
  getShopProfile,
  getShopProducts,
  getShopCollections,
  getShopSettings,
} from '../controllers/shopController.js';

/**
 * Phase 22.4/22.5 — public shop directory (`/shops/<slug>` storefront routing).
 * Read-only, tokenless; mounted at /api/shops in server.js. The slug is a
 * lookup key only — every handler resolves the ACTIVE workspace server-side.
 */
const router = Router();

router.get('/:slug', getShopProfile);
router.get('/:slug/products', getShopProducts);
router.get('/:slug/collections', getShopCollections);
router.get('/:slug/settings', getShopSettings);

export default router;
