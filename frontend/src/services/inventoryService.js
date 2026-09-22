import api from './apiClient.js';
import { store, signalDataChanged, commitStore } from './dataStore.js';

/**
 * Phase 3C — inventoryService is backed by the API. Reads come from the
 * server-hydrated store; adjustments POST to the backend, which records the
 * movement and returns the authoritative stock. No localStorage inventory.
 */

function statusOf(current, reorder) {
  if (current <= 0) return 'Out of Stock';
  if (current <= (reorder || 0) / 2) return 'Critical';
  if (current <= reorder) return 'Low Stock';
  return 'In Stock';
}

function normalizeInv(i) {
  const currentStock = Number(i.currentStock) || 0;
  const reorderLevel = Number(i.reorderLevel) || 0;
  return {
    productId: i.productSlug,
    productSlug: i.productSlug,
    sku: i.sku || '',
    productName: i.productName || i.productSlug,
    currentStock,
    reorderLevel,
    unit: i.unit || 'units',
    status: statusOf(currentStock, reorderLevel),
    updatedAt: i.updatedAt,
    lastRestocked: i.lastRestocked || i.updatedAt,
  };
}

function normalizeMovement(m) {
  return {
    id: m.id || m._id,
    product: m.productName || m.productSlug,
    sku: m.sku || '',
    quantityChange: m.delta || 0,
    stockAfter: m.newStock,
    type: m.type || 'adjustment',
    reference: m.orderId ? `Order ${m.orderId}` : m.reason || '',
    notes: m.reason || '',
    date: m.createdAt,
    createdAt: m.createdAt,
  };
}

export function getInventory() {
  return store.inventory.map(normalizeInv);
}

export function getInventoryItem(productId) {
  const raw = store.inventory.find((i) => i.productSlug === productId || i.productId === productId);
  return raw ? normalizeInv(raw) : null;
}

export function getLowStockItems() {
  return getInventory().filter((i) => i.status === 'Low Stock' || i.status === 'Critical');
}

export function getCriticalStockItems() {
  return getInventory().filter((i) => i.status === 'Critical');
}

/** Adjust stock through the API (staff). quantity > 0; type: restock|remove|adjustment */
export async function adjustInventory(productId, quantity, type = 'adjustment', reference = null, notes = '') {
  const abs = Math.abs(Number(quantity));
  const apiType =
    String(type || '').toLowerCase() === 'sale' || String(type || '').toLowerCase() === 'remove'
      ? 'remove'
      : 'restock';
  const res = await api.post(
    `/inventory/${encodeURIComponent(productId)}/adjust`,
    {
      type: apiType,
      quantity: abs,
      reason: notes || reference || 'Stock adjustment',
    },
    { scope: 'admin' }
  );
  if (!res.ok) {
    const err = new Error(res.message || 'Stock adjustment failed.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  // Server returns the authoritative inventory doc → refresh cache copy.
  // Phase 18.5.2: commit() notifies subscribed pages in place — the stock
  // value updates immediately from the confirmed backend value without any
  // global reload. signalDataChanged() then triggers a SILENT background
  // refresh of ONLY inventory + history + analytics (Phase 20.1 slices)
  // that cannot blank the UI.
  const inv = res.data.inventory;
  store.inventory = [...store.inventory.filter((x) => x.productSlug !== inv.productSlug), inv];
  commitStore();
  signalDataChanged('data', ['inventory']);
  return {
    success: true,
    productId,
    newStock: inv.currentStock,
    quantityChange: quantity,
  };
}

export async function adjustStock(productId, quantity, type, reason, handlerName = 'Handler') {
  return adjustInventory(productId, quantity, type, null, `${handlerName} — ${reason || ''}`);
}

export function getInventoryHistory() {
  return store.inventoryHistory.map(normalizeMovement);
}

export function validateStock(productId, requiredQuantity) {
  // Phase 20.2 — customers NEVER receive /api/inventory (403, staff-only),
  // so reading store.inventory here made this a silent no-op for every
  // storefront session: out-of-stock bags passed preflight unnoticed. The
  // check now reads the stock embedded on the catalogue product — the same
  // live value attachAvailability serves on each request. store.inventory
  // remains as the admin-session fallback.
  const product = store.products.find((p) => p.slug === productId);
  if (product && product.stockTracked === false) {
    return { available: true, currentStock: null, message: 'Made-to-order item — not stock tracked' };
  }
  if (product && typeof product.stock === 'number') {
    if (product.stock < requiredQuantity) {
      return {
        available: false,
        currentStock: product.stock,
        message: product.stock <= 0 ? 'Out of stock' : `Only ${product.stock} available`,
      };
    }
    return { available: true, currentStock: product.stock, message: 'In stock' };
  }
  const item = getInventoryItem(productId);
  if (!item) {
    // No stock signal in this session — the server pre-check at order
    // creation remains the authority.
    return { available: true, currentStock: null, message: 'Confirmed at order time' };
  }
  if (item.currentStock < requiredQuantity) {
    return { available: false, currentStock: item.currentStock, message: `Only ${item.currentStock} units available` };
  }
  return { available: true, currentStock: item.currentStock, message: 'In stock' };
}
