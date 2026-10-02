import Product from '../models/Product.js';
import Inventory from '../models/Inventory.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { cached, cacheInvalidatePrefix } from '../utils/publicCache.js';
import { getWorkspaceId, workspaceScope, workspaceIdScope } from '../utils/tenancy.js';
import { catalogueContext } from '../utils/catalogueContext.js';

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function validateProductPayload(body, partial = false) {
  const out = {};
  const errors = [];
  const has = (k) => body[k] !== undefined;

  if (!partial || has('name')) {
    if (!body.name || String(body.name).trim().length < 2) {
      errors.push('Product name is required.');
    } else {
      out.name = String(body.name).trim();
      out.slug = slugify(out.name);
    }
  }
  if (has('price')) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) {
      errors.push('Price must be a non-negative number.');
    } else {
      out.price = Math.round(price);
    }
  }
  for (const field of ['sku', 'category', 'description', 'image', 'palette', 'ribbon', 'occasion']) {
    if (has(field)) out[field] = body[field];
  }
  // Multi-image gallery. `images` is the authoritative list; `image` is
  // derived from it so every single-image reader stays correct. A client may
  // still send `image` alone (legacy/admin edit of the primary photo only).
  if (has('images')) {
    if (body.images === null) {
      out.images = [];
    } else if (!Array.isArray(body.images)) {
      errors.push('Images must be a list of image URLs.');
    } else {
      out.images = body.images
        .map((url) => (typeof url === 'string' ? url.trim() : ''))
        .filter((url) => url.length > 0 && url.length <= 2048)
        .slice(0, 12);
    }
    if (Array.isArray(out.images)) {
      if (out.images.length > 0) out.image = out.images[0];
      else if (!has('image')) out.image = '';
    }
  }
  if (has('collections') && Array.isArray(body.collections)) out.collections = body.collections;
  if (has('visibility')) {
    if (!['Visible', 'Hidden'].includes(body.visibility)) {
      errors.push('Visibility must be Visible or Hidden.');
    } else {
      out.visibility = body.visibility;
    }
  }
  if (has('stockTracked')) out.stockTracked = !!body.stockTracked;

  return { out, errors };
}

/** Public: visible catalogue only (hidden products never leak to storefront). */

/**
 * Phase 20.2 — safe inventory initialization. A stock-tracked product must
 * always have an Inventory record; a missing record initializes at stock 0
 * (= unavailable) so a purchasable product can never lack inventory state.
 */
async function ensureInventoryRecord(product) {
  // Phase 22.3 — the record inherits the product's server-derived workspaceId
  // so stock for workspace A can never be administered by workspace B. A
  // product without membership (compat mode) keeps the historical unscoped row.
  const productWorkspaceId = getWorkspaceId(product);
  await Inventory.updateOne(
    { productSlug: product.slug },
    {
      $setOnInsert: {
        productSlug: product.slug,
        sku: product.sku || '',
        productName: product.name,
        currentStock: 0,
        reorderLevel: 5,
        unit: 'units',
        isFixture: !!product.isFixture,
        ...(productWorkspaceId ? { workspaceId: productWorkspaceId } : {}),
      },
    },
    { upsert: true }
  );
}

/**
 * Phase 20.2 — embed stock availability on product documents so the customer
 * portal can show real availability without access to /api/inventory
 * (admin-only). Stock counts are public product information; inventory
 * mutation endpoints stay staff-protected.
 * A stock-tracked product with NO inventory record is presented as stock 0
 * (unavailable) — never as silently purchasable.
 *
 * Deliberately runs OUTSIDE the read cache: the cached rows carry only
 * product metadata, so stock is read fresh on every request and a change is
 * visible immediately (no 30s staleness, no cache-invalidation requirement).
 */
async function attachAvailability(rows) {
  const tracked = rows.filter((p) => p && p.stockTracked !== false);
  if (tracked.length === 0) return rows;
  const invs = await Inventory.find({
    productSlug: { $in: tracked.map((p) => p.slug) },
  })
    .select('productSlug currentStock reorderLevel workspaceId')
    .lean();
  const bySlug = new Map();
  for (const inv of invs) {
    // Phase 22.3 — the inventory row must belong to the product's workspace
    // (or be an unassigned legacy row). Slugs are globally unique today, so
    // this never fires, but it keeps stock display honest the moment slugs
    // become workspace-local (Phase 22.5 composite index).
    const owner = tracked.find((p) => p.slug === inv.productSlug);
    const ownerWorkspace = getWorkspaceId(owner);
    const inventoryWorkspace = getWorkspaceId(inv);
    if (ownerWorkspace && inventoryWorkspace && String(ownerWorkspace) !== String(inventoryWorkspace)) {
      continue;
    }
    bySlug.set(inv.productSlug, inv);
  }
  for (const p of tracked) {
    const inv = bySlug.get(p.slug);
    p.stock = inv ? inv.currentStock : 0;
    p.reorderLevel = inv ? inv.reorderLevel : 5;
  }
  return rows;
}

/**
 * Phase 20.2 — keep the inventory record coherent across product edits:
 * a slug rename MIGRATES the record (otherwise stock is orphaned and the
 * next order dies with "No inventory record exists for <new-slug>"), names
 * stay in sync, and a (re)enabled stockTracked product with no record gets
 * a safe stock-0 initialization.
 */
async function syncInventoryAfterProductEdit(product, previousSlug) {
  if (product.stockTracked === false) return; // made-to-order — record optional
  const sku = product.sku || '';
  // Phase 22.3 — inventory is keyed by slug AND scoped to the product's
  // workspace: a rename/migration can only ever touch this workspace's row
  // (or a legacy unassigned one), never another workspace's stock.
  const productWorkspaceId = getWorkspaceId(product);
  if (previousSlug !== product.slug) {
    const forNewSlug = await Inventory.findOne({
      productSlug: product.slug,
      ...workspaceIdScope(productWorkspaceId),
    });
    if (forNewSlug) {
      // The new slug already carries a record (recreated product): adopt it
      // and drop the old-keyed row so the unique index stays clean.
      await Inventory.deleteOne({
        productSlug: previousSlug,
        ...workspaceIdScope(productWorkspaceId),
      });
      await Inventory.updateOne(
        { productSlug: product.slug, ...workspaceIdScope(productWorkspaceId) },
        { $set: { productName: product.name, sku } }
      );
      return;
    }
    const renamed = await Inventory.updateOne(
      { productSlug: previousSlug, ...workspaceIdScope(productWorkspaceId) },
      { $set: { productSlug: product.slug, productName: product.name, sku } }
    );
    if (renamed.matchedCount === 0) await ensureInventoryRecord(product);
    return;
  }
  const synced = await Inventory.updateOne(
    { productSlug: product.slug, ...workspaceIdScope(productWorkspaceId) },
    { $set: { productName: product.name, sku } }
  );
  if (synced.matchedCount === 0) await ensureInventoryRecord(product);
}

export async function listProducts(req, res, next) {
  try {
    const ctx = await catalogueContext(req);
    const staff = ctx.staff;
    const category = safeString(req.query.category, 100);
    const q = safeString(req.query.q, 200);
    const { visibility } = req.query;
    const filters = {};
    if (!staff) filters.visibility = 'Visible';
    if (staff && visibility) filters.visibility = visibility;
    if (category) filters.category = { $regex: `^${escapeRegExp(category)}$`, $options: 'i' };
    if (q) {
      filters.$or = [
        { name: { $regex: escapeRegExp(q), $options: 'i' } },
        { category: { $regex: escapeRegExp(q), $options: 'i' } },
        { sku: { $regex: escapeRegExp(q), $options: 'i' } },
      ];
    }
    // Staff views stay live (admin must see writes instantly) and are scoped
    // to the caller's workspace; the public visible-only listing is workspace
    // context free (single shared storefront) and stays on the 30s TTL cache
    // invalidated by any product write (Phase 17).
    const cacheKey = `products:list:${category || ''}:${q || ''}`;
    const load = () =>
      Product.find({ ...workspaceScope(ctx.user), ...filters }).sort({ createdAt: 1 }).limit(500).lean();
    const products = staff ? await load() : await cached(cacheKey, load, Product);
    // Phase 20.2 — availability attached post-cache so stock is always live.
    await attachAvailability(products);
    res.json({ success: true, products });
  } catch (err) {
    next(err);
  }
}

export async function getProduct(req, res, next) {
  try {
    // Public detail reads are cached (30s TTL, write-invalidated). Staff always
    // gets a live read so admin edits reflect instantly, scoped to its
    // workspace — a product of another workspace answers 404 (existence is
    // never disclosed).
    const ctx = await catalogueContext(req);
    const load = () =>
      Product.findOne({ slug: req.params.id, ...workspaceScope(ctx.user) }).lean();
    const product = ctx.staff ? await load() : await cached(`products:detail:${req.params.id}`, load, Product);
    if (!product) {
      throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    }
    if (!ctx.staff && product.visibility === 'Hidden') {
      throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    }
    // Phase 20.2 — availability attached post-cache so stock is always live.
    await attachAvailability([product]);
    res.json({ success: true, product });
  } catch (err) {
    next(err);
  }
}

export async function createProduct(req, res, next) {
  try {
    const { out, errors } = validateProductPayload(req.body);
    if (errors.length) {
      throw new ApiError(422, errors.join(' '), 'VALIDATION_ERROR');
    }
    // Global slug uniqueness is deliberate (Phase 22.3 §3): slugs stay
    // worldwide-unique until Phase 22.5 introduces { workspaceId, slug }.
    const existing = await Product.findOne({ slug: out.slug });
    if (existing) {
      throw new ApiError(409, `A product named "${out.name}" already exists.`, 'DUPLICATE');
    }
    // workspaceId is SERVER-DERIVED from the gate's membership — the client
    // never chooses it (a smuggled value is scrubbed before this runs).
    const productWorkspaceId = getWorkspaceId(req.user);
    const product = await Product.create({
      ...out,
      ...(productWorkspaceId ? { workspaceId: productWorkspaceId } : {}),
      isFixture: false,
    });
    cacheInvalidatePrefix('products:');

    // Auto-create inventory record for stock-tracked products.
    // Initial stock comes from the request body (default 0 if not provided).
    if (product.stockTracked !== false) {
      const initialStock = Math.max(0, parseInt(req.body.initialStock, 10) || 0);
      const reorderLevel = Math.max(0, parseInt(req.body.reorderLevel, 10) || 5);
      await Inventory.create({
        productSlug: product.slug,
        sku: product.sku || '',
        productName: product.name,
        currentStock: initialStock,
        reorderLevel,
        unit: 'units',
        isFixture: false,
        ...(productWorkspaceId ? { workspaceId: productWorkspaceId } : {}),
      });
    }

    res.status(201).json({ success: true, product });
  } catch (err) {
    next(err);
  }
}

export async function updateProduct(req, res, next) {
  try {
    // Scoped lookup: another workspace's product simply does not exist here.
    const product = await Product.findOne({
      slug: req.params.id,
      ...workspaceScope(req.user),
    });
    if (!product) {
      throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    }
    const { out, errors } = validateProductPayload(req.body, true);
    if (errors.length) {
      throw new ApiError(422, errors.join(' '), 'VALIDATION_ERROR');
    }
    if (out.slug && out.slug !== product.slug) {
      const clash = await Product.findOne({
        // Global on purpose: slugs stay worldwide-unique here and only become
        // a { workspaceId, slug } composite index in Phase 22.5.
        slug: out.slug,
        _id: { $ne: product._id },
      });
      if (clash) {
        throw new ApiError(409, `A product named "${out.name}" already exists.`, 'DUPLICATE');
      }
    }
    const previousSlug = product.slug;
    Object.assign(product, out);
    await product.save();
    cacheInvalidatePrefix('products:');
    // Phase 20.2 — keep inventory coherent: migrate on slug rename, initialize
    // when stock tracking is (re)enabled, keep name/sku in sync.
    await syncInventoryAfterProductEdit(product, previousSlug);
    res.json({ success: true, product });
  } catch (err) {
    next(err);
  }
}

export async function deleteProduct(req, res, next) {
  try {
    const product = await Product.findOne({
      slug: req.params.id,
      ...workspaceScope(req.user),
    });
    if (!product) {
      throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    }
    const productWorkspaceId = getWorkspaceId(product);
    await product.deleteOne();
    cacheInvalidatePrefix('products:');
    // Remove the linked inventory record so no orphan survives. Without this,
    // re-creating a product with the same slug fails on the inventory unique
    // index and dead stock rows pollute the inventory views.
    await Inventory.deleteOne({
      productSlug: product.slug,
      ...workspaceIdScope(productWorkspaceId),
    });
    res.json({ success: true, message: `Deleted "${product.name}".` });
  } catch (err) {
    next(err);
  }
}
