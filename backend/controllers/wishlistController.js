import Wishlist from '../models/Wishlist.js';
import Product from '../models/Product.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { activeShopMap, publicProduct } from '../utils/publicShop.js';

/**
 * Customer wishlist controller — PHASE 2: ONE GLOBAL WISHLIST PER CUSTOMER.
 *
 * Ownership is ALWAYS the authenticated customer (`req.user.customerId`) and
 * NOTHING else:
 *
 *   · the wishlist is a customer-owned record, so its authority is the customer
 *     identity — never a shop, never a workspace;
 *   · a customer can save products from ANY shop into the SAME wishlist, and
 *     browsing /shops/shop-a → /shops/shop-b never changes which record is
 *     read or written (Phase 2 removed the former per-(customer, workspace)
 *     model and its `?shop=` selector);
 *   · `?shop=` may still arrive from an older client or a bookmarked link and
 *     is deliberately IGNORED — it is a discovery hint, not an authority;
 *   · a raw client `workspaceId` is scrubbed globally in server.js.
 *
 * LEGACY DATA SAFETY: before the merge migration runs, a customer may still
 * hold several historical scoped documents (the Phase 22.5 model created
 * `(customerId, workspaceId)` rows). Reads therefore UNION every document that
 * belongs to the customer so nothing a customer already saved disappears, and
 * writes converge on ONE canonical document (the unscoped row when one exists,
 * else the oldest). `scripts/merge-wishlists-global.mjs` consolidates the
 * documents themselves; the API behaves correctly either way.
 *
 * Products are returned through the SAME canonical public projection as the
 * catalogue (Phase 1): no `workspaceId`, and the owning shop attached as
 * `{ slug, displayName }`. A saved product whose shop is not publicly
 * discoverable (suspended, pending or deleted) is reported as UNAVAILABLE
 * instead of being rendered as a live product the catalogue would 404.
 */

const MAX_DOCS_PER_CUSTOMER = 20;

/** Every wishlist document this customer owns, canonical row first. */
async function loadWishlistDocs(customerId) {
  const docs = await Wishlist.find({ customerId })
    .sort({ createdAt: 1 })
    .limit(MAX_DOCS_PER_CUSTOMER);
  if (docs.length === 0) return [];
  // Canonical = the unscoped (global) row when one exists, else the oldest.
  const canonical = docs.find((d) => !d.workspaceId) || docs[0];
  return [canonical, ...docs.filter((d) => !d._id.equals(canonical._id))];
}

/** Ensure a canonical document exists (create it on first use). */
async function ensureCanonicalDoc(customerId, docs) {
  if (docs.length > 0) return docs[0];
  return Wishlist.create({ customerId, productIds: [] });
}

/** The effective saved product ids: the union of every owned document. */
function effectiveProductIds(docs) {
  const ids = [];
  for (const doc of docs) {
    for (const id of doc.productIds || []) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * Resolve saved slugs against the GLOBAL catalogue (slugs are globally unique,
 * so no tenant filter is involved) and split them into the products that are
 * still publicly discoverable and the ids that are not.
 */
async function resolveProducts(productIds) {
  if (productIds.length === 0) return { existing: [], unavailableIds: [] };
  const products = await Product.find({ slug: { $in: productIds } });
  const shopMap = await activeShopMap(products.map((p) => p.workspaceId));
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  const existing = [];
  const unavailableIds = [];
  for (const id of productIds) {
    const product = bySlug.get(id);
    // A product whose owning shop is not discoverable is unavailable, exactly
    // as it is absent from the public catalogue (Phase 1 rule).
    if (product && (!product.workspaceId || shopMap.has(String(product.workspaceId)))) {
      existing.push({ product, shop: product.workspaceId ? shopMap.get(String(product.workspaceId)) : null });
    } else {
      unavailableIds.push(id);
    }
  }
  return { existing, unavailableIds };
}

async function view(productIds) {
  const { existing, unavailableIds } = await resolveProducts(productIds);
  return {
    // The union is what the customer actually sees; the canonical document is
    // where new saves land (see addToWishlist).
    productIds: [...productIds],
    products: existing.map(({ product, shop }) => publicProduct(product.toJSON(), shop)),
    unavailableIds,
  };
}

export async function getWishlist(req, res, next) {
  try {
    const docs = await loadWishlistDocs(req.user.customerId);
    res.json({ success: true, wishlist: await view(effectiveProductIds(docs)) });
  } catch (err) {
    next(err);
  }
}

export async function addToWishlist(req, res, next) {
  try {
    const slug = String(req.params.productId).trim().toLowerCase();
    // The catalogue is GLOBAL: the customer may save any publicly discoverable
    // product, from any shop (no shop selector, no tenant filter).
    const product = await Product.findOne({ slug });
    if (!product) {
      throw new ApiError(404, 'This creation no longer exists.', 'PRODUCT_NOT_FOUND');
    }

    const docs = await loadWishlistDocs(req.user.customerId);
    const canonical = await ensureCanonicalDoc(req.user.customerId, docs);
    // $addToSet dedupes: saving the same creation twice is a no-op.
    const updated = await Wishlist.findByIdAndUpdate(
      canonical._id,
      { $addToSet: { productIds: product.slug } },
      { new: true }
    );
    // Re-read so the union still covers any pre-migration sibling documents.
    const fresh = await loadWishlistDocs(req.user.customerId);
    const ids = effectiveProductIds([updated, ...fresh.filter((d) => !d._id.equals(updated._id))]);
    res.json({ success: true, wishlist: await view(ids) });
  } catch (err) {
    next(err);
  }
}

export async function removeFromWishlist(req, res, next) {
  try {
    const slug = String(req.params.productId).trim().toLowerCase();
    const docs = await loadWishlistDocs(req.user.customerId);
    if (docs.length === 0) {
      throw new ApiError(404, 'Wishlist not found.', 'NOT_FOUND');
    }
    // Remove from EVERY owned document, so the union reflects the deletion.
    await Wishlist.updateMany(
      { customerId: req.user.customerId },
      { $pull: { productIds: slug } }
    );
    const fresh = await loadWishlistDocs(req.user.customerId);
    res.json({ success: true, wishlist: await view(effectiveProductIds(fresh)) });
  } catch (err) {
    next(err);
  }
}

export async function clearWishlist(req, res, next) {
  try {
    const docs = await loadWishlistDocs(req.user.customerId);
    await ensureCanonicalDoc(req.user.customerId, docs);
    await Wishlist.updateMany({ customerId: req.user.customerId }, { $set: { productIds: [] } });
    res.json({ success: true, wishlist: await view([]) });
  } catch (err) {
    next(err);
  }
}
