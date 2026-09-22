import Product from '../models/Product.js';
import Inventory from '../models/Inventory.js';
import jwt from 'jsonwebtoken';
import { ApiError } from '../middleware/errorMiddleware.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { cached, cacheInvalidatePrefix } from '../utils/publicCache.js';

// Optional auth for public reads: a valid staff token reveals hidden products.
async function isStaffRequest(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    return ['admin', 'handler'].includes(decoded.role);
  } catch {
    return false;
  }
}

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
  }).lean();
  const bySlug = new Map(invs.map((i) => [i.productSlug, i]));
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
  if (previousSlug !== product.slug) {
    const forNewSlug = await Inventory.findOne({ productSlug: product.slug });
    if (forNewSlug) {
      // The new slug already carries a record (recreated product): adopt it
      // and drop the old-keyed row so the unique index stays clean.
      await Inventory.deleteOne({ productSlug: previousSlug });
      await Inventory.updateOne(
        { productSlug: product.slug },
        { $set: { productName: product.name, sku } }
      );
      return;
    }
    const renamed = await Inventory.updateOne(
      { productSlug: previousSlug },
      { $set: { productSlug: product.slug, productName: product.name, sku } }
    );
    if (renamed.matchedCount === 0) await ensureInventoryRecord(product);
    return;
  }
  const synced = await Inventory.updateOne(
    { productSlug: product.slug },
    { $set: { productName: product.name, sku } }
  );
  if (synced.matchedCount === 0) await ensureInventoryRecord(product);
}

export async function listProducts(req, res, next) {
  try {
    const staff = await isStaffRequest(req);
    const category = safeString(req.query.category, 100);
    const q = safeString(req.query.q, 200);
    const { visibility } = req.query;
    const match = {};
    if (!staff) match.visibility = 'Visible';
    if (staff && visibility) match.visibility = visibility;
    if (category) match.category = { $regex: `^${escapeRegExp(category)}$`, $options: 'i' };
    if (q) {
      match.$or = [
        { name: { $regex: escapeRegExp(q), $options: 'i' } },
        { category: { $regex: escapeRegExp(q), $options: 'i' } },
        { sku: { $regex: escapeRegExp(q), $options: 'i' } },
      ];
    }
    // Staff views stay live (admin must see writes instantly); the public
    // visible-only listing is read-heavy and low-volatility → 30s TTL cache
    // invalidated by any product write (Phase 17).
    const staffView = staff && (!visibility || visibility !== 'Visible');
    const cacheKey = `products:list:${category || ''}:${q || ''}`;
    const load = () =>
      Product.find(match).sort({ createdAt: 1 }).limit(500).lean();
    const products = staffView ? await load() : await cached(cacheKey, load, Product);
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
    // gets a live read so admin edits reflect instantly.
    const staff = await isStaffRequest(req);
    const load = () => Product.findOne({ slug: req.params.id }).lean();
    const product = staff ? await load() : await cached(`products:detail:${req.params.id}`, load, Product);
    if (!product) {
      throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    }
    if (!staff && product.visibility === 'Hidden') {
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
    const existing = await Product.findOne({ slug: out.slug });
    if (existing) {
      throw new ApiError(409, `A product named "${out.name}" already exists.`, 'DUPLICATE');
    }
    const product = await Product.create({ ...out, isFixture: false });
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
      });
    }

    res.status(201).json({ success: true, product });
  } catch (err) {
    next(err);
  }
}

export async function updateProduct(req, res, next) {
  try {
    const product = await Product.findOne({ slug: req.params.id });
    if (!product) {
      throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    }
    const { out, errors } = validateProductPayload(req.body, true);
    if (errors.length) {
      throw new ApiError(422, errors.join(' '), 'VALIDATION_ERROR');
    }
    if (out.slug && out.slug !== product.slug) {
      const clash = await Product.findOne({ slug: out.slug, _id: { $ne: product._id } });
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
    const product = await Product.findOne({ slug: req.params.id });
    if (!product) {
      throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    }
    await product.deleteOne();
    cacheInvalidatePrefix('products:');
    // Remove the linked inventory record so no orphan survives. Without this,
    // re-creating a product with the same slug fails on the inventory unique
    // index and dead stock rows pollute the inventory views.
    await Inventory.deleteOne({ productSlug: product.slug });
    res.json({ success: true, message: `Deleted "${product.name}".` });
  } catch (err) {
    next(err);
  }
}
