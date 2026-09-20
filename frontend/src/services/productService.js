import api from './apiClient.js';
import { store, signalDataChanged, hydratePublic } from './dataStore.js';

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
    // (customers get 403 on /api/inventory), so `stock` is only advisory here.
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
    stock: inv ? inv.currentStock : undefined,
    reorderLevel: inv ? inv.reorderLevel : 10,
    stockStatus: inv ? deriveStockStatus(inv.currentStock, inv.reorderLevel) : undefined,
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
  signalDataChanged();
  // Re-hydrate the public catalogue so the storefront immediately
  // picks up the new product instead of showing a stale listing.
  hydratePublic().catch(() => {});
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
  signalDataChanged();
  hydratePublic().catch(() => {});
  return fromApiProduct(p);
}

export async function deleteProduct(id) {
  const res = await api.delete(`/products/${encodeURIComponent(id)}`, { scope: 'admin' });
  if (!res.ok) {
    throw new Error(res.message || 'Product could not be deleted.');
  }
  store.products = store.products.filter((x) => x.slug !== id);
  signalDataChanged();
  hydratePublic().catch(() => {});
  return store.products;
}

export function getProductImage(product) {
  return product.images && product.images.length > 0
    ? product.images[0]
    : FALLBACK_IMAGE;
}

// Made-to-order / custom items (and anything not in the catalogue) have no
// tracked stock, so they must never block or deduct inventory.
export function isCatalogueProduct(productId) {
  if (!productId) return false;
  return store.products.some((p) => p.slug === productId);
}
