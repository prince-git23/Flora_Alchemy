import Collection from '../models/Collection.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { cached, cacheInvalidatePrefix } from '../utils/publicCache.js';
import { getWorkspaceId, workspaceScope } from '../utils/tenancy.js';
import { catalogueContext } from '../utils/catalogueContext.js';

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

export async function listCollections(req, res, next) {
  try {
    const ctx = await catalogueContext(req);
    const filters = {};
    if (!ctx.staff) filters.visibility = 'Visible';
    // Public visible-only listing: 30s TTL cache, invalidated on writes.
    // Staff reads are LIVE and scoped to the caller's workspace (Phase 22.3).
    const load = () =>
      Collection.find({ ...workspaceScope(ctx.user), ...filters }).sort({ createdAt: 1 }).limit(200).lean();
    const collections = ctx.staff ? await load() : await cached('collections:list', load, Collection);
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
    res.json({ success: true, collection });
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
    const collection = await Collection.create({
      slug,
      name: String(name).trim(),
      description: description || '',
      image: image || '',
      occasion: occasion || '',
      productSlugs: Array.isArray(productSlugs) ? productSlugs : [],
      visibility: ['Visible', 'Hidden'].includes(visibility) ? visibility : 'Visible',
      ...(collectionWorkspaceId ? { workspaceId: collectionWorkspaceId } : {}),
      isFixture: false,
    });
    cacheInvalidatePrefix('collections:');
    res.status(201).json({ success: true, collection });
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
    const allowed = ['description', 'image', 'occasion', 'productSlugs', 'visibility', 'name'];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        if (field === 'name') {
          collection.name = String(req.body.name).trim();
          collection.slug = slugify(collection.name);
        } else if (field === 'visibility' && !['Visible', 'Hidden'].includes(req.body.visibility)) {
          throw new ApiError(422, 'Visibility must be Visible or Hidden.', 'VALIDATION_ERROR');
        } else {
          collection[field] = req.body[field];
        }
      }
    }
    await collection.save();
    cacheInvalidatePrefix('collections:');
    res.json({ success: true, collection });
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
