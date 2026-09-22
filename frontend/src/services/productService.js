import api from './apiClient.js';
import { store, signalDataChanged, commitStore } from './dataStore.js';

/**
 * Phase 3C — productService is now backed by the Express/MongoDB API.
 * Reads come from the server-hydrated store (no localStorage, no static
 * PRODUCTS array); writes POST/PATCH/DELETE and refresh the store from the
 * server response. The UI shape (category keys, images[], visibility) is
 * normalized here so pages were not rewritten.
 */

const FALLBACK_IMAGE = '/assets/images/flora-asset-01.jpg';

const CATEGORY_KEYS = {
  'Flowers & Bouquets': 'bouquets',
  'Handmade Cards': 'cards',
  'Charms & Vessels': 'charms',
  'Custom Gifts & Hampers': 'hampers',
  'Custom Gifts': 'custom',
  Other: 'other',
};

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function deriveStockStatus(stock, reorder) {
  if (stock === undefined || stock === null) return undefined;
  if (stock <= 0) return 'Out of Stock';
  if (stock <= reorder / 2) return 'Critical';
  if (stock <= reorder) return 'Low Stock';
  return 'In Stock';
}

function inventoryFor(slug) {
  const inv = store.inventory.find((i) => i.productSlug === slug || i.productId === slug);
  return inv || null;
}

/** Map a backend Product document to the storefront/admin product shape. */
export function fromApiProduct(p) {
  const inv = inventoryFor(p.slug);
  // Phase 20.2 — stock is embedded on the product document by the API
  // (attachAvailability: a live read OUTSIDE the 30s read cache), so the
  // storefront sees real availability on every request. store.inventory is
  // staff-only (customers get 403 on /api/inventory), so the embedded value
  // takes precedence and the inventory-slice lookup is only an admin fallback.
  const stock = typeof p.stock === 'number'
    ? p.stock
    : inv ? inv.currentStock : undefined;
  const reorderLevel = typeof p.reorderLevel === 'number'
    ? p.reorderLevel
    : inv ? inv.reorderLevel : 5;
  const image = Array.isArray(p.image) ? p.image[0] : p.image;
  return {
    id: p.slug,
    slug: p.slug,
    sku: p.sku || '',
    name: p.name,
    shortName: p.name,
    category: CATEGORY_KEYS[p.category] || slugify(p.category) || 'other',
    categoryLabel: p.category || 'Other',
    price: Number(p.price) || 0,
    originalPrice: null,
    images: [image || FALLBACK_IMAGE],
    description: p.description || '',
    shortDescription: '',
    badge: '',
    craftTime: '',
    materials: '',
    dimensions: '',
    rating: 0,
    reviewCount: 0,
    // Phase 3G-A: expose the raw backend palette/occasion labels and the
    // public stockTracked flag so gift discovery (Gift Finder, occasion /
    // recipient shop filters) derives its taxonomy from real product data
    // instead of a duplicate catalogue. Inventory itself stays admin-scoped
    // (customers get 403 on /api/inventory); stock arrives embedded on the
    // product document instead (Phase 20.2).
    palette: p.palette || '',
    occasion: p.occasion || '',
    stockTracked: p.stockTracked !== false,
    // Real palette / ribbon values only. Previously the palette carried two
    // invented swatch colours; the product page now renders the real label
    // instead of fabricating colour data.
    palettes: p.palette ? [{ id: slugify(p.palette), name: p.palette }] : [],
    ribbons: p.ribbon ? [{ id: slugify(p.ribbon), name: p.ribbon, desc: '' }] : [],
    ribbon: p.ribbon || '',
    collections: Array.isArray(p.collections) ? p.collections : [],
    tags: [],
    isFeatured: false,
    isBestseller: false,
    availability: 'Ready to Ship',
    visibility: p.visibility === 'Hidden' ? 'Hidden' : 'Public',
    stock,
    reorderLevel,
    stockStatus: stock !== undefined ? deriveStockStatus(stock, reorderLevel) : undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function getProducts() {
  return store.products.map(fromApiProduct);
}

export function getProductById(id) {
  const raw = store.products.find((p) => p.slug === id);
  if (!raw) {
    // tolerate legacy id-based lookups on normalized products
    const product = getProducts().find((p) => p.id === id || p.sku === id);
    return product || null;
  }
  return fromApiProduct(raw);
}

function toApiPayload(data) {
  const reverseKeys = {};
  Object.entries(CATEGORY_KEYS).forEach(([label, key]) => {
    reverseKeys[key] = label;
  });
  return {
    name: data.name,
    price: Number(data.price),
    sku: data.sku || '',
    category: data.categoryLabel || reverseKeys[data.category] || data.category || 'Other',
    description: data.description || '',
    image: Array.isArray(data.images) ? data.images[0] : data.image || FALLBACK_IMAGE,
    palette: (data.palettes && data.palettes[0] && data.palettes[0].name) || data.palette || '',
    visibility: data.visibility === 'Hidden' ? 'Hidden' : 'Visible',
    stockTracked: data.stockTracked !== false,
  };
}

export async function createProduct(data) {
  const res = await api.post('/products', toApiPayload(data), { scope: 'admin' });
  if (!res.ok) {
    throw new Error(res.message || 'Product could not be created.');
  }
  const p = res.data.product;
  store.products = [...store.products.filter((x) => x.slug !== p.slug), p];
  commitStore();
  // Phase 20.1 — refresh ONLY products + inventory in the background; the
  // signal's targeted slice refresh replaces the old duplicate full
  // re-hydration (signal + hydratePublic), so no global loader and no
  // redundant catalogue fetch.
  signalDataChanged('data', ['products', 'inventory']);
  return fromApiProduct(p);
}

export async function updateProduct(id, data) {
  const res = await api.patch(`/products/${encodeURIComponent(id)}`, toApiPayload(data), {
    scope: 'admin',
  });
  if (!res.ok) {
    throw new Error(res.message || 'Product could not be updated.');
  }
  const p = res.data.product;
  store.products = [...store.products.filter((x) => x.slug !== p.slug), p];
  commitStore();
  signalDataChanged('data', ['products']);
  return fromApiProduct(p);
}

export async function deleteProduct(id) {
  const res = await api.delete(`/products/${encodeURIComponent(id)}`, { scope: 'admin' });
  if (!res.ok) {
    throw new Error(res.message || 'Product could not be deleted.');
  }
  store.products = store.products.filter((x) => x.slug !== id);
  commitStore();
  signalDataChanged('data', ['products', 'inventory']);
  return store.products;
}

export function getProductImage(product) {
  return product.images && product.images.length > 0
    ? product.images[0]
    : FALLBACK_IMAGE;
}

// ── Phase 20.2 — customer-facing stock semantics (single source) ────────────
// Existing thresholds are preserved: each product's reorderLevel (default 5)
// marks low stock; 0 means sold out; stock === undefined means "no signal yet"
// (the server still validates authoritatively at order time).

/** Stock-tracked and at zero → must never look purchasable anywhere. */
export function isOutOfStock(product) {
  return !!product && product.stockTracked !== false && product.stock === 0;
}

/** Stock-tracked, in stock, at or below its reorder threshold. */
export function isLowStock(product) {
  if (!product || product.stockTracked === false) return false;
  return (
    typeof product.stock === 'number' &&
    product.stock > 0 &&
    product.stock <= (product.reorderLevel || 5)
  );
}

/** Max units a customer may order right now (storefront cap stays 10). */
export function maxOrderable(product, cap = 10) {
  if (!product || product.stockTracked === false) return cap;
  if (typeof product.stock !== 'number') return cap;
  return Math.max(0, Math.min(cap, product.stock));
}

// Made-to-order / custom items (and anything not in the catalogue) have no
// tracked stock, so they must never block or deduct inventory.
export function isCatalogueProduct(productId) {
  if (!productId) return false;
  return store.products.some((p) => p.slug === productId);
}
