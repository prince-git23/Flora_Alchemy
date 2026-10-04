import Collection from '../models/Collection.js';
import Product from '../models/Product.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { cached, cacheInvalidatePrefix } from '../utils/publicCache.js';
import { getWorkspaceId, workspaceIdScope, workspaceScope } from '../utils/tenancy.js';
import { catalogueContext } from '../utils/catalogueContext.js';
import {
  activeShopForId,
  activeShopMap,
  isPubliclyDiscoverable,
  publicCollection,
} from '../utils/publicShop.js';

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

/** Normalize a client-supplied slug list: strings only, trimmed, deduped. */
function normalizeSlugs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const slug = raw.trim().toLowerCase();
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * PHASE 1 — OWNERSHIP INTEGRITY for collection membership.
 *
 * A collection belongs to ONE workspace, and it may only reference products of
 * that SAME workspace. The workspace is always the SERVER-RESOLVED one (the
 * caller's membership, or — for the platform owner / single-workspace compat
 * mode — the single workspace a slug resolves to); a client-supplied
 * `workspaceId` is never read (it is scrubbed globally in server.js).
 *
 * Every referenced slug must resolve to a product in that workspace. A
 * cross-workspace reference (or an unknown slug) is rejected with 422 rather
 * than silently stored, so a collection can never become a window into another
 * shop's catalogue.
 *
 * @returns {Promise<string[]>} the validated slug list
 * @throws {ApiError} 422 when any slug is unknown or belongs to another shop
 */
async function resolveOwnedProductSlugs(slugs, workspaceId) {
  if (slugs.length === 0) return [];
  const found = await Product.find({
    slug: { $in: slugs },
    ...(workspaceId ? { workspaceId } : {}),
  })
    .select('slug')
    .lean();
  const owned = new Set(found.map((p) => p.slug));
  const rejected = slugs.filter((s) => !owned.has(s));
  if (rejected.length > 0) {
    throw new ApiError(
      422,
      `These products are not part of this shop's catalogue: ${rejected.join(', ')}.`,
      'PRODUCT_NOT_IN_WORKSPACE'
    );
  }
  return slugs;
}

export async function listCollections(req, res, next) {
  try {
    const ctx = await catalogueContext(req);
    const filters = {};
    if (!ctx.staff) filters.visibility = 'Visible';
    // Public visible-only listing: 30s TTL cache, invalidated on writes.
    // Staff reads are LIVE and scoped to the caller's workspace (Phase 22.3).
    //
    // PHASE 1 — the cache holds only the RAW rows; shop attribution and the
    // suspended/missing-workspace exclusion are applied LIVE after it.
    const load = () =>
      Collection.find({ ...workspaceScope(ctx.user), ...filters }).sort({ createdAt: 1 }).limit(200).lean();
    const rows = ctx.staff ? await load() : await cached('collections:list', load, Collection);
    const shopMap = await activeShopMap(rows.map((c) => c && c.workspaceId));
    const discoverable = ctx.staff ? rows : rows.filter((c) => isPubliclyDiscoverable(c, shopMap));
    const collections = discoverable.map((c) =>
      publicCollection(c, c.workspaceId ? shopMap.get(String(c.workspaceId)) || null : null)
    );
    res.json({ success: true, collections });
  } catch (err) {
    next(err);
  }
}

export async function getCollection(req, res, next) {
  try {
    // Scoped for staff (another workspace's collection answers 404); the
    // storefront reads with no membership and then applies the visibility rule.
    const ctx = await catalogueContext(req);
    const collection = await Collection.findOne({
      slug: req.params.id,
      ...workspaceScope(ctx.user),
    });
    if (!collection) {
      throw new ApiError(404, 'Collection not found.', 'NOT_FOUND');
    }
    if (!ctx.staff && collection.visibility === 'Hidden') {
      throw new ApiError(404, 'Collection not found.', 'NOT_FOUND');
    }
    // PHASE 1 — a collection of a suspended/missing workspace is not public.
    const shop = collection.workspaceId ? await activeShopForId(collection.workspaceId) : null;
    if (!ctx.staff && collection.workspaceId && !shop) {
      throw new ApiError(404, 'Collection not found.', 'NOT_FOUND');
    }
    res.json({ success: true, collection: publicCollection(collection, shop) });
  } catch (err) {
    next(err);
  }
}

export async function createCollection(req, res, next) {
  try {
    const { name, description, image, occasion, productSlugs, visibility } = req.body || {};
    if (!name || String(name).trim().length < 2) {
      throw new ApiError(422, 'Collection name is required.', 'VALIDATION_ERROR');
    }
    const slug = slugify(name);
    // Global slug uniqueness (Phase 22.3 §3) — deliberately not workspace-scoped.
    const clash = await Collection.findOne({ slug });
    if (clash) {
      throw new ApiError(409, `A collection named "${name}" already exists.`, 'DUPLICATE');
    }
    // workspaceId is SERVER-DERIVED from the gate's membership (Phase 22.3).
    const collectionWorkspaceId = getWorkspaceId(req.user);
    // PHASE 1 — every referenced product must belong to this same workspace.
    const ownedSlugs = await resolveOwnedProductSlugs(normalizeSlugs(productSlugs), collectionWorkspaceId);
    const collection = await Collection.create({
      slug,
      name: String(name).trim(),
      description: description || '',
      image: image || '',
      occasion: occasion || '',
      productSlugs: ownedSlugs,
      visibility: ['Visible', 'Hidden'].includes(visibility) ? visibility : 'Visible',
      ...(collectionWorkspaceId ? { workspaceId: collectionWorkspaceId } : {}),
      isFixture: false,
    });
    cacheInvalidatePrefix('collections:');
    res.status(201).json({ success: true, collection: publicCollection(collection, await activeShopForId(collectionWorkspaceId)) });
  } catch (err) {
    next(err);
  }
}

export async function updateCollection(req, res, next) {
  try {
    const collection = await Collection.findOne({
      slug: req.params.id,
      ...workspaceScope(req.user),
    });
    if (!collection) {
      throw new ApiError(404, 'Collection not found.', 'NOT_FOUND');
    }
    // PHASE 1 — the collection's own workspace is authoritative for its
    // membership; a PATCH can never re-point it at another shop's products.
    const collectionWorkspaceId = getWorkspaceId(collection);
    const allowed = ['description', 'image', 'occasion', 'productSlugs', 'visibility', 'name'];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        if (field === 'name') {
          collection.name = String(req.body.name).trim();
          collection.slug = slugify(collection.name);
        } else if (field === 'productSlugs') {
          collection.productSlugs = await resolveOwnedProductSlugs(
            normalizeSlugs(req.body.productSlugs),
            collectionWorkspaceId
          );
        } else if (field === 'visibility' && !['Visible', 'Hidden'].includes(req.body.visibility)) {
          throw new ApiError(422, 'Visibility must be Visible or Hidden.', 'VALIDATION_ERROR');
        } else {
          collection[field] = req.body[field];
        }
      }
    }
    await collection.save();
    cacheInvalidatePrefix('collections:');
    res.json({
      success: true,
      collection: publicCollection(collection, await activeShopForId(collectionWorkspaceId)),
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteCollection(req, res, next) {
  try {
    const collection = await Collection.findOne({
      slug: req.params.id,
      ...workspaceScope(req.user),
    });
    if (!collection) {
      throw new ApiError(404, 'Collection not found.', 'NOT_FOUND');
    }
    // Re-assert the scope at write time (TOCTOU-safe), not just on the fetch.
    await Collection.deleteOne({ _id: collection._id, ...workspaceScope(req.user) });
    cacheInvalidatePrefix('collections:');
    res.json({ success: true, message: `Deleted collection "${collection.name}".` });
  } catch (err) {
    next(err);
  }
}
