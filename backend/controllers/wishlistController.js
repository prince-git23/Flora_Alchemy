import Wishlist from '../models/Wishlist.js';
import Product from '../models/Product.js';
import Workspace from '../models/Workspace.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { SLUG_RE } from '../utils/workspaceSlug.js';
import { activeShopMap, publicProduct } from '../utils/publicShop.js';

/**
 * Customer wishlist controller.
 *
 * Ownership is ALWAYS derived from the authenticated customer
 * (req.user.customerId) — a client-supplied owner id is never accepted.
 *
 * Phase 22.5 — the wishlist is TENANT-scoped: one document per
 * (customerId, workspaceId). The workspace is resolved SERVER-SIDE from an
 * optional `shop` slug (query or body) — a raw client `workspaceId` is never
 * trusted (and is scrubbed globally in server.js). When no slug is supplied the
 * request defaults to the platform's single ACTIVE workspace (and to the
 * unscoped/platform wishlist when the platform has none or several).
 */

/**
 * PHASE 1 — the wishlist returns products through the SAME canonical public
 * projection as the catalogue: no `workspaceId`, and the owning shop attached
 * as `{ slug, displayName }`.
 */
function serialize(products, shopMap) {
  return products.map((p) =>
    publicProduct(p.toJSON(), p.workspaceId ? shopMap.get(String(p.workspaceId)) || null : null)
  );
}

async function resolveWorkspaceId(req) {
  const raw = (req.query && req.query.shop) || (req.body && req.body.shop) || '';
  const slug = String(raw || '').trim().toLowerCase();
  if (slug) {
    if (!SLUG_RE.test(slug)) {
      throw new ApiError(404, 'Shop not found.', 'SHOP_NOT_FOUND');
    }
    const ws = await Workspace.findOne({ slug, status: 'ACTIVE' }).select('_id').lean();
    if (!ws) throw new ApiError(404, 'Shop not found.', 'SHOP_NOT_FOUND');
    return ws._id;
  }
  // No shop context: default to the single ACTIVE workspace when unambiguous.
  const actives = await Workspace.find({ status: 'ACTIVE' }).select('_id').limit(2).lean();
  return actives.length === 1 ? actives[0]._id : null;
}

async function loadWishlistDoc(customerId, workspaceId) {
  return Wishlist.findOneAndUpdate(
    { customerId, workspaceId },
    { $setOnInsert: { productIds: [] } },
    { upsert: true, new: true }
  );
}

async function resolveProducts(doc) {
  const filter = { slug: { $in: doc.productIds } };
  if (doc.workspaceId) filter.workspaceId = doc.workspaceId;
  const products = await Product.find(filter);
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  const existing = [];
  const unavailableIds = [];
  for (const id of doc.productIds) {
    const p = bySlug.get(id);
    if (p) existing.push(p);
    else unavailableIds.push(id);
  }
  return { existing, unavailableIds };
}

async function view(doc, existing, unavailableIds) {
  const shopMap = await activeShopMap(existing.map((p) => p && p.workspaceId));
  return {
    productIds: doc.productIds.map((id) => id.toString()),
    products: serialize(existing, shopMap),
    unavailableIds,
  };
}

export async function getWishlist(req, res, next) {
  try {
    const workspaceId = await resolveWorkspaceId(req);
    const doc = await loadWishlistDoc(req.user.customerId, workspaceId);
    const { existing, unavailableIds } = await resolveProducts(doc);
    res.json({ success: true, wishlist: await view(doc, existing, unavailableIds) });
  } catch (err) {
    next(err);
  }
}

export async function addToWishlist(req, res, next) {
  try {
    const workspaceId = await resolveWorkspaceId(req);
    const slug = String(req.params.productId).trim().toLowerCase();
    const productFilter = { slug };
    if (workspaceId) productFilter.workspaceId = workspaceId;
    const product = await Product.findOne(productFilter);
    if (!product) {
      throw new ApiError(404, 'This creation no longer exists.', 'PRODUCT_NOT_FOUND');
    }

    const doc = await Wishlist.findOneAndUpdate(
      { customerId: req.user.customerId, workspaceId },
      { $addToSet: { productIds: product.slug } },
      { upsert: true, new: true }
    );
    const { existing, unavailableIds } = await resolveProducts(doc);
    res.json({ success: true, wishlist: await view(doc, existing, unavailableIds) });
  } catch (err) {
    next(err);
  }
}

export async function removeFromWishlist(req, res, next) {
  try {
    const workspaceId = await resolveWorkspaceId(req);
    const slug = String(req.params.productId).trim().toLowerCase();
    const doc = await Wishlist.findOneAndUpdate(
      { customerId: req.user.customerId, workspaceId },
      { $pull: { productIds: slug } },
      { new: true }
    );
    if (!doc) {
      throw new ApiError(404, 'Wishlist not found.', 'NOT_FOUND');
    }
    const { existing, unavailableIds } = await resolveProducts(doc);
    res.json({ success: true, wishlist: await view(doc, existing, unavailableIds) });
  } catch (err) {
    next(err);
  }
}

export async function clearWishlist(req, res, next) {
  try {
    const workspaceId = await resolveWorkspaceId(req);
    const doc = await Wishlist.findOneAndUpdate(
      { customerId: req.user.customerId, workspaceId },
      { $set: { productIds: [] } },
      { upsert: true, new: true }
    );
    res.json({ success: true, wishlist: await view(doc, [], []) });
  } catch (err) {
    next(err);
  }
}
