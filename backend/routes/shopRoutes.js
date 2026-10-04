import { Router } from 'express';
import {
  listShops,
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

// PHASE 1 — the public shop directory. Declared BEFORE `/:slug` so the
// literal path can never be captured by the slug parameter.
router.get('/', listShops);

router.get('/:slug', getShopProfile);
router.get('/:slug/products', getShopProducts);
router.get('/:slug/collections', getShopCollections);
router.get('/:slug/settings', getShopSettings);

export default router;
