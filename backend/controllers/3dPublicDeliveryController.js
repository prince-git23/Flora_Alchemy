/**
 * PUBLIC 3D DELIVERY CONTROLLER — Phase 3 — streams ONE approved product model
 * (or its thumbnail) to the storefront, and reports whether a product has one.
 *
 * Every public delivery request is re-validated server-side:
 *   1. the product exists, is Visible, and belongs to an ACTIVE shop
 *   2. the asset id belongs to THAT product AND that product's workspace
 *   3. the asset is APPROVED, with validated bytes, not deprecated/rejected
 *   4. the requested kind is a public kind ('glb' | 'thumbnail')
 *   5. the bytes on disk are STILL a valid glTF Binary container
 *
 * If any of those fail the controller answers 404 with the SAME code shape as
 * the private media route ('ASSET_NOT_FOUND'), so a client cannot distinguish
 * "wrong product" from "wrong asset" from "none exists" — existence is never
 * disclosed. Note that a mismatch is a 404 and never a 403: the storefront is
 * anonymous, so a 403 would itself confirm that something is there.
 *
 * This is deliberately SEPARATE from the private `/api/3d/media/...` route:
 *   · the private route is staff-only and workspace-scoped through auth
 *   · this route is public-storefront-only and re-validates the product/asset/
 *     workspace relationship on every request, which is what makes it safe to
 *     expose. The private media root is never turned into a public directory.
 */

import { ApiError } from '../middleware/errorMiddleware.js';
import Product from '../models/Product.js';
import Product3DAsset, { isApprovedModelServable, normalizeObjectId } from '../models/Product3DAsset.js';
import { readAsset } from '../services/3dAssetStorage.js';
import { validateGlb, MAX_GLB_BYTES } from '../services/3dModelValidation.js';
import { activeShopForId } from '../utils/publicShop.js';
import { publicProduct3d } from '../services/product3dPublicResolution.js';

/**
 * The storefront's 3D availability read: `{ product3d }` or `{ product3d: null }`.
 *
 * It answers 200 for a product with no approved model — "no model" is a normal,
 * expected answer that the gallery renders by simply not offering 3D. A product
 * that is unknown / Hidden / owned by a suspended shop is a 404, exactly like
 * the public catalogue read, so this endpoint cannot be used to enumerate.
 */
export async function publicProduct3dHandler(req, res, next) {
  try {
    const { productSlug } = req.params;
    const product = await resolvePublishedProduct(productSlug);
    const product3d = await publicProduct3d(product.slug, { workspaceId: product.workspaceId });
    // Never cached by an intermediary beyond the product's own public policy:
    // a newly approved or withdrawn model must be visible immediately.
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, product3d: product3d || null });
  } catch (err) {
    next(err);
  }
}

/**
 * Resolve the published product that owns this model. A customer may only see a
 * model that belongs to a VISIBLE product whose shop is ACTIVE — the same rule
 * `getProduct` applies to the product itself.
 */
async function resolvePublishedProduct(productSlug) {
  const doc = await Product.findOne({ slug: String(productSlug || '') }).lean();
  if (!doc || doc.visibility === 'Hidden') throw notFound();
  if (doc.workspaceId) {
    const shop = await activeShopForId(doc.workspaceId);
    if (!shop) throw notFound();
  }
  return doc;
}

/**
 * Resolve the ONE approved asset for that product by the public asset id.
 *
 * The id comes from the public projection, but it is re-queried against the
 * PRODUCT and its WORKSPACE rather than trusted: a stale id cannot be replayed
 * against a replaced model, an id belonging to another product cannot be
 * smuggled in, and an asset row that (however it got there) names a foreign
 * product slug is refused rather than served under this product's URL.
 */
async function resolveApprovedAsset(product, assetId) {
  const id = normalizeObjectId(assetId);
  if (!id) throw notFound();
  const doc = await Product3DAsset.findOne({
    _id: id,
    productSlug: String(product.slug || ''),
    status: 'APPROVED',
  }).lean();
  if (!doc) throw notFound();
  // The asset must belong to the product's own workspace — an unscoped legacy
  // product (pre-migration) is the only case where the row may carry none.
  if (product.workspaceId && String(doc.workspaceId || '') !== String(product.workspaceId)) {
    throw notFound();
  }
  if (!isApprovedModelServable(doc)) throw notFound();
  return doc;
}

function notFound() {
  return new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
}

/**
 * Read + re-validate one stored file. The bytes must still be a real glTF
 * Binary container: an approved row whose file was replaced, truncated or
 * corrupted on disk is refused rather than handed to a browser as a "model".
 */
async function readValidated(entry, { validateBytes = true } = {}) {
  if (!entry?.storageKey) throw notFound();
  const buffer = await readAsset(entry.storageKey);
  if (!buffer || buffer.length === 0) throw notFound();
  if (buffer.length > MAX_GLB_BYTES) {
    throw new ApiError(413, 'This model is too large to serve right now.', 'ASSET_TOO_LARGE');
  }
  if (validateBytes) {
    const check = validateGlb(buffer);
    if (!check.ok) throw notFound();
  }
  return buffer;
}

/**
 * GET /api/3d/products/:productSlug/model/:assetId/glb
 *
 * Approved, validated models are immutable content addressed by the asset id in
 * the URL, so they are cached for a bounded window (10 minutes) after which the
 * browser revalidates — which is what makes an unpublish or a replacement take
 * effect promptly without re-downloading the same model during a normal
 * gallery interaction. Express' own ETag turns the revalidation into a 304.
 */
export async function serveApprovedModel(req, res, next) {
  try {
    const { productSlug, assetId } = req.params;
    const product = await resolvePublishedProduct(productSlug);
    const asset = await resolveApprovedAsset(product, assetId);
    const buffer = await readValidated(asset.storage?.glb);

    res.set({
      'Content-Type': 'model/gltf-binary',
      'Content-Disposition': 'inline; filename="model.glb"',
      'Cache-Control': 'public, max-age=600, must-revalidate',
      'Content-Length': String(buffer.length),
      'Accept-Ranges': 'none',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/3d/products/:productSlug/model/:assetId/thumbnail
 *
 * The thumbnail is a derived convenience (a poster frame for the viewer), so a
 * missing one answers 404 and the frontend falls back to a neutral panel — it is
 * never a reason to refuse the model itself.
 */
export async function serveApprovedThumbnail(req, res, next) {
  try {
    const { productSlug, assetId } = req.params;
    const product = await resolvePublishedProduct(productSlug);
    const asset = await resolveApprovedAsset(product, assetId);
    const buffer = await readValidated(asset.storage?.thumbnail, { validateBytes: false });

    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': 'inline',
      'Cache-Control': 'public, max-age=600, must-revalidate',
      'Content-Length': String(buffer.length),
      'Accept-Ranges': 'none',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}
