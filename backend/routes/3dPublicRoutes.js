/**
 * PUBLIC 3D STOREFRONT ROUTES — Phase 3 — the SMALL public surface an approved
 * product model is reachable through. Mounted at `/api/3d` (after the staff
 * router, so nothing there is shadowed).
 *
 *   GET /api/3d/products/:productSlug/public
 *        → the customer-safe projection: `{ product3d }` or `{ product3d: null }`.
 *          Answers 200 with null when there is no approved model, so a gallery
 *          simply does not offer 3D. 404 for an unknown / Hidden / suspended-shop
 *          product, like the public catalogue read.
 *
 *   GET /api/3d/products/:productSlug/model/:assetId/glb
 *   GET /api/3d/products/:productSlug/model/:assetId/thumbnail
 *        → the bytes for ONE approved asset. The controller re-resolves the
 *          product, the product's workspace and the approved asset from those
 *          URL values on every request and streams nothing else, so a client
 *          can never name a storage key or reach another product's model.
 *
 * GATES: these are STOREFRONT reads. `optionalProtect` reads a session when one
 * is present, and the permission gate is the same `catalogueRead` shape the
 * public product routes use (`{ onlyStaff: true, skipNonStaff: true }`):
 *   · no session (a visitor)            → allowed
 *   · a customer session                → allowed
 *   · an administrator / owner          → allowed
 *   · a handler lacking `products.view` → refused, exactly as that handler is
 *                                          refused the product page itself
 * So the storefront keeps working for everyone it works for today, and a staff
 * session cannot use a public branch to read what its role was stripped of.
 *
 * The private `/api/3d/media/...` route and the private 3D media root are NOT
 * touched by any of this.
 */

import { Router } from 'express';
import { optionalProtect } from '../middleware/authMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';
import {
  publicProduct3dHandler,
  serveApprovedModel,
  serveApprovedThumbnail,
} from '../controllers/3dPublicDeliveryController.js';

const router = Router();

const catalogueRead = requirePermission('products.view', { onlyStaff: true, skipNonStaff: true });

router.get('/products/:productSlug/public', optionalProtect, catalogueRead, publicProduct3dHandler);
router.get(
  '/products/:productSlug/model/:assetId/glb',
  optionalProtect,
  catalogueRead,
  serveApprovedModel
);
router.get(
  '/products/:productSlug/model/:assetId/thumbnail',
  optionalProtect,
  catalogueRead,
  serveApprovedThumbnail
);

export default router;
