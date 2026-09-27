import Workspace from '../models/Workspace.js';
import Product from '../models/Product.js';
import Collection from '../models/Collection.js';
import Settings from '../models/Settings.js';
import Inventory from '../models/Inventory.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { SLUG_RE } from '../utils/workspaceSlug.js';

/**
 * Phase 22.4/22.5 — PUBLIC shop directory + storefront reads.
 *
 * The slug is the ONLY tenant input from the browser, and it is a LOOKUP key,
 * never an authorization grant: every handler below resolves the ACTIVE
 * workspace from the slug and then filters strictly by that workspace's id —
 * a client-supplied `workspaceId` is never read (and is scrubbed globally in
 * server.js). Unknown, malformed, reserved or non-ACTIVE slugs all answer an
 * indistinguishable 404, so existence is never disclosed.
 *
 * Public reads expose ONLY storefront data: visible products/collections and a
 * public slice of settings. Inventory quantities, staff, analytics, customers
 * and internal configuration are never part of these responses.
 */

async function resolveActiveWorkspace(slugRaw) {
  const slug = String(slugRaw || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  return Workspace.findOne({ slug, status: 'ACTIVE' }).select('slug displayName').lean();
}

/** Public projection of a product — NO inventory quantities. */
function publicProduct(p, inv) {
  const inStock = p.stockTracked === false ? true : (inv ? inv.currentStock : 0) > 0;
  return {
    slug: p.slug,
    name: p.name,
    category: p.category || '',
    price: p.price,
    originalPrice: p.originalPrice ?? null,
    image: p.image || '',
    images: p.images || [],
    description: p.description || '',
    occasion: p.occasion || '',
    tags: p.tags || [],
    stockTracked: p.stockTracked !== false,
    inStock,
    availability: inStock ? 'In Stock' : 'Out of Stock',
  };
}

/** The public slice of settings a storefront legitimately needs. */
const PUBLIC_SETTING_FIELDS = [
  'storeName',
  'storeTagline',
  'currency',
  'storeAvailability',
  'acceptNewOrders',
  'shippingConfiguration',
  'customGiftConfiguration',
  'contactEmail',
  'contactPhone',
  'timezone',
];

function publicSettings(doc, fallback) {
  const out = {};
  for (const f of PUBLIC_SETTING_FIELDS) {
    out[f] = doc && doc[f] !== undefined ? doc[f] : fallback ? fallback[f] : undefined;
  }
  return out;
}

export async function getShopProfile(req, res, next) {
  try {
    const workspace = await resolveActiveWorkspace(req.params.slug);
    if (!workspace) {
      throw new ApiError(404, 'Shop not found.', 'SHOP_NOT_FOUND');
    }
    res.json({
      success: true,
      shop: { slug: workspace.slug, displayName: workspace.displayName },
    });
  } catch (err) {
    next(err);
  }
}

export async function getShopProducts(req, res, next) {
  try {
    const workspace = await resolveActiveWorkspace(req.params.slug);
    if (!workspace) {
      throw new ApiError(404, 'Shop not found.', 'SHOP_NOT_FOUND');
    }
    const products = await Product.find({ workspaceId: workspace._id, visibility: 'Visible' })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();

    const tracked = products.filter((p) => p && p.stockTracked !== false);
    const invs = tracked.length
      ? await Inventory.find({ workspaceId: workspace._id, productSlug: { $in: tracked.map((p) => p.slug) } })
          .select('productSlug currentStock')
          .lean()
      : [];
    const bySlug = new Map(invs.map((i) => [i.productSlug, i]));

    res.json({
      success: true,
      shop: { slug: workspace.slug, displayName: workspace.displayName },
      products: products.map((p) => publicProduct(p, bySlug.get(p.slug))),
    });
  } catch (err) {
    next(err);
  }
}

export async function getShopCollections(req, res, next) {
  try {
    const workspace = await resolveActiveWorkspace(req.params.slug);
    if (!workspace) {
      throw new ApiError(404, 'Shop not found.', 'SHOP_NOT_FOUND');
    }
    const collections = await Collection.find({ workspaceId: workspace._id, visibility: 'Visible' })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();
    res.json({
      success: true,
      shop: { slug: workspace.slug, displayName: workspace.displayName },
      collections: collections.map((c) => ({
        slug: c.slug,
        name: c.name,
        description: c.description || '',
        image: c.image || '',
        occasion: c.occasion || '',
        productSlugs: c.productSlugs || [],
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function getShopSettings(req, res, next) {
  try {
    const workspace = await resolveActiveWorkspace(req.params.slug);
    if (!workspace) {
      throw new ApiError(404, 'Shop not found.', 'SHOP_NOT_FOUND');
    }
    const own = await Settings.findOne({ workspaceId: workspace._id }).lean();
    // Fall back to the platform singleton's public slice when a workspace has
    // not customised settings yet (same defaults the storefront would show).
    const fallback = own ? null : await Settings.findOne({ key: 'default' }).lean();
    res.json({
      success: true,
      shop: { slug: workspace.slug, displayName: workspace.displayName },
      settings: publicSettings(own || fallback, { storeName: workspace.displayName }),
    });
  } catch (err) {
    next(err);
  }
}
