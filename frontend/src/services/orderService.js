import api from './apiClient.js';
import { store, signalDataChanged, commitStore } from './dataStore.js';
import { isCatalogueProduct } from './productService.js';

/**
 * Phase 3C — orderService is fully API-backed.
 *
 * Reads come from the server-hydrated store (GET /api/orders or /orders/mine).
 * createOrder POSTs /api/orders and the SERVER is authoritative for identity,
 * prices, totals and transactional stock deduction — this module no longer
 * decrements inventory or writes localStorage.
 */

// ─── Canonical Status ───
export const ORDER_STATUSES = [
  { key: 'new', label: 'New', description: 'Payment confirmed', stageNum: 1 },
  { key: 'confirmed', label: 'Confirmed', description: 'Stem assigned', stageNum: 2 },
  { key: 'in_production', label: 'In Production', description: 'Currently being crafted', stageNum: 3 },
  { key: 'quality_check', label: 'Quality Check', description: 'Petal inspection', stageNum: 4 },
  { key: 'ready_to_dispatch', label: 'Ready to Dispatch', description: 'Wax seal & box', stageNum: 5 },
  { key: 'shipped', label: 'Shipped', description: 'Handed to courier', stageNum: 6 },
  { key: 'delivered', label: 'Delivered', description: 'Archived delivery', stageNum: 7 },
];

export const PAYMENT_STATUSES = ['Paid', 'Pending', 'Refunded'];

export const ORDER_STATUS_STYLES = {
  new: { bg: 'bg-purple-50', text: 'text-purple-800', border: 'border-purple-200', dot: 'bg-purple-600' },
  confirmed: { bg: 'bg-slate-100', text: 'text-slate-800', border: 'border-slate-200', dot: 'bg-slate-500' },
  in_production: { bg: 'bg-[var(--color-badge-bg)]', text: 'text-[var(--color-badge-fg-strong)]', border: 'border-[var(--color-badge-bg)]', dot: 'bg-[#964735]' },
  quality_check: { bg: 'bg-amber-50', text: 'text-amber-900', border: 'border-amber-200', dot: 'bg-amber-500' },
  ready_to_dispatch: { bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-200', dot: 'bg-emerald-600' },
  shipped: { bg: 'bg-sky-50', text: 'text-sky-800', border: 'border-sky-200', dot: 'bg-sky-600' },
  delivered: { bg: 'bg-stone-100', text: 'text-stone-700', border: 'border-stone-200', dot: 'bg-stone-500' },
  cancelled: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', dot: 'bg-red-500' },
};

// ─── Status mapping helpers ───
export function getStatusLabel(key) {
  const s = ORDER_STATUSES.find(st => st.key === key);
  return s ? s.label : key;
}

export function getStatusDescription(key) {
  const s = ORDER_STATUSES.find(st => st.key === key);
  return s ? s.description : '';
}

export function getStatusStage(key) {
  const s = ORDER_STATUSES.find(st => st.key === key);
  return s ? s.stageNum : 1;
}

export function getCustomerFacingStatus(key) {
  const map = {
    new: 'Order Received',
    confirmed: 'Confirmed',
    in_production: 'Being Crafted',
    quality_check: 'Quality Check',
    ready_to_dispatch: 'Ready for Dispatch',
    shipped: 'Shipped',
    delivered: 'Delivered',
  };
  return map[key] || key;
}

// ─── Normalization (backend doc → UI shape) ───
function normalizeOrder(o) {
  if (!o) return null;
  const orderId = o.orderId || o.id;
  const items = (o.items || []).map((it) => ({
    id: it.productSlug || it.id || it.name,
    productSlug: it.productSlug || it.id || null,
    name: it.name,
    price: Number(it.price) || 0,
    quantity: Number(it.quantity) || 1,
    image: it.image || '',
    palette: it.palette || '',
    ribbon: it.ribbon || '',
    giftMessage: it.giftMessage || '',
    customDetails: it.customDetails || null,
    description: it.description || '',
    isAddOn: !!it.isAddOn,
    isCatalogue: it.isCatalogue !== false,
  }));
  const addr = o.shippingAddress || {};
  return {
    id: orderId,
    orderId,
    customerId: o.customerId ? String(o.customerId) : '',
    customerName: o.customerName || '',
    customerEmail: o.customerEmail || '',
    items,
    subtotal: Number(o.subtotal) || 0,
    shipping: Number(o.shipping) || 0,
    total: Number(o.total) || 0,
    paymentStatus: o.paymentStatus || 'Pending',
    paymentMethod: o.paymentMethod || 'Sample',
    paymentProvider: o.paymentProvider || '',
    paymentProviderOrderId: o.paymentProviderOrderId || '',
    paymentProviderPaymentId: o.paymentProviderPaymentId || '',
    paymentReference: o.paymentReference || '',
    paymentSignatureVerified: !!o.paymentSignatureVerified,
    paymentVerifiedAt: o.paymentVerifiedAt || null,
    paymentFailureReason: o.paymentFailureReason || '',
    orderStatus: o.orderStatus || 'new',
    shippingAddress: {
      name: addr.name || '',
      address: addr.address || '',
      city: addr.city || '',
      state: addr.state || '',
      pincode: addr.pincode || '',
      phone: addr.phone || '',
    },
    giftMessage: o.giftMessage || '',
    trackingNumber: o.trackingNumber || '',
    statusHistory: o.statusHistory || [],
    isFixture: !!o.isFixture,
    deliveryTarget: null,
    isRush: false,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

export function getOrders() {
  return store.orders.map(normalizeOrder).filter(Boolean);
}

export function getOrderById(orderId) {
  if (!orderId) return null;
  const raw = store.orders.find(
    (o) => (o.orderId || o.id) === orderId || o.trackingNumber === orderId
  );
  return normalizeOrder(raw || null);
}

/**
 * Fetch a single order from the API, bypassing the in-memory store.
 * Use this when you need the current database-backed status (e.g. order
 * tracking page) rather than the potentially stale store snapshot.
 */
export async function fetchOrderFromApi(orderId) {
  if (!orderId) return null;
  const res = await api.get(`/orders/${encodeURIComponent(orderId)}`, { scope: 'customer' });
  if (!res.ok) return null;
  const serverOrder = res.data.order;
  // Update the store so subsequent local reads are also fresh.
  store.orders = [...store.orders.filter((o) => (o.orderId || o.id) !== serverOrder.orderId), serverOrder];
  commitStore();
  // Phase 20.1 — this is a READ: the confirmed order is already committed to
  // the store above, so no re-hydration signal is needed (a full background
  // refresh for a single read was wasted work).
  return normalizeOrder(serverOrder);
}

export function getMyOrders() {
  return getOrders();
}

export function getOrdersByCustomer(customerId) {
  if (!customerId) return [];
  const id = String(customerId);
  return getOrders().filter((o) => o.customerId === id);
}

export function getOrdersByStatus(statusKey) {
  return getOrders().filter((o) => o.orderStatus === statusKey);
}

function imageForItem(item) {
  if (item.image) return item.image;
  if (item.images && item.images.length) return item.images[0];
  return '/assets/images/flora-asset-01.jpg';
}

/**
 * Create an order through the backend. Only catalogue items send a slug —
 * the server re-prices them from MongoDB. Custom Gift Studio items send a
 * customGiftConfig (never a price) — the server calculates the authoritative
 * total via backend/config/customGiftPricing.js. Add-ons send addOnId and are
 * likewise priced server-side.
 */
export async function createOrder(orderData) {
  const items = (orderData.items || []).map((item) => {
    // `id` is a storefront UI key only — the server must never treat it as a
    // catalogue slug. Only an explicit productSlug is sent as a catalogue item.
    const productSlug = item.productSlug;
    if (productSlug && isCatalogueProduct(productSlug)) {
      return {
        productSlug,
        name: item.name,
        quantity: item.quantity || 1,
        palette: item.palette || '',
        ribbon: item.ribbon || '',
        giftMessage: item.giftMessage || '',
        customDetails: item.customDetails || null,
      };
    }
    // Add-ons: send addOnId for server-authoritative pricing; price is ignored.
    if (item.isAddOn) {
      return {
        name: item.name || 'Add-on',
        addOnId: item.addOnId || item.id || null,
        quantity: item.quantity || 1,
        image: imageForItem(item),
        isAddOn: true,
      };
    }
    return {
      name: item.name || 'Custom Gift',
      price: Number(item.price) || 0,
      quantity: item.quantity || 1,
      image: imageForItem(item),
      palette: item.palette || '',
      ribbon: item.ribbon || '',
      giftMessage: item.giftMessage || '',
      customDetails: item.customDetails || null,
      customGiftConfig: item.customGiftConfig || null,
      description: item.description || '',
    };
  });

  const payload = {
    items,
    paymentMethod: orderData.paymentMethod || 'Sample',
    shippingAddress: orderData.shippingAddress || {},
    giftMessage: orderData.giftMessage || '',
    isRush: !!orderData.isRush,
  };

  const res = await api.post('/orders', payload, { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'Your order could not be placed.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }

  // Server order becomes the source of truth in the store.
  const serverOrder = res.data.order;
  store.orders = [...store.orders.filter((o) => (o.orderId || o.id) !== serverOrder.orderId), serverOrder];
  commitStore();
  signalDataChanged('data', ['orders', 'inventory']);
  return normalizeOrder(serverOrder);
}

/**
 * Admin/handler creates an order on behalf of a selected customer
 * (POST /api/orders/admin — staff only; prices still computed server-side).
 */
export async function createAdminOrder({ customerId, items, shippingAddress, giftMessage, paymentMethod, isRush }) {
  const payloadItems = (items || []).map((item) => {
    const productId = item.productSlug || item.productId || item.id;
    if (productId && isCatalogueProduct(productId)) {
      return { productSlug: productId, name: item.name, quantity: item.quantity || 1 };
    }
    return { name: item.name || 'Custom Gift', price: Number(item.price) || 0, quantity: item.quantity || 1 };
  });

  const res = await api.post('/orders/admin', {
    customerId,
    items: payloadItems,
    shippingAddress: shippingAddress || {},
    giftMessage: giftMessage || '',
    paymentMethod: paymentMethod || 'Sample',
    isRush: !!isRush,
  }, { scope: 'admin' });

  if (!res.ok) {
    const err = new Error(res.message || 'Order could not be created.');
    err.code = res.code;
    throw err;
  }
  const serverOrder = res.data.order;
  store.orders = [...store.orders.filter((o) => (o.orderId || o.id) !== serverOrder.orderId), serverOrder];
  commitStore();
  signalDataChanged('data', ['orders', 'inventory']);
  return normalizeOrder(serverOrder);
}

/** PATCH the canonical lifecycle — server validates the transition. */
export async function updateOrderStatus(orderId, newStatusKey) {
  const res = await api.patch(
    `/orders/${encodeURIComponent(orderId)}/status`,
    { status: newStatusKey },
    { scope: 'admin' }
  );
  if (!res.ok) {
    const err = new Error(res.message || 'Status could not be updated.');
    err.code = res.code;
    throw err;
  }
  const serverOrder = res.data.order;
  store.orders = [...store.orders.filter((o) => (o.orderId || o.id) !== orderId), serverOrder];
  commitStore();
  signalDataChanged('data', ['orders', 'inventory']);
  return normalizeOrder(serverOrder);
}

export async function updateOrder(orderId, updates) {
  const res = await api.patch(
    `/orders/${encodeURIComponent(orderId)}/status`,
    { status: updates.orderStatus, note: updates.note },
    { scope: 'admin' }
  );
  if (!res.ok) {
    const err = new Error(res.message || 'Order could not be updated.');
    err.code = res.code;
    throw err;
  }
  const serverOrder = res.data.order;
  store.orders = [...store.orders.filter((o) => (o.orderId || o.id) !== orderId), serverOrder];
  commitStore();
  signalDataChanged('data', ['orders', 'inventory']);
  return normalizeOrder(serverOrder);
}

export async function deleteOrder(orderId) {
  // No delete endpoint exists in the API contract; report honestly.
  const err = new Error('Order deletion is not supported by the backend.');
  err.code = 'UNSUPPORTED';
  throw err;
}

// ─── Format Helpers ───
function formatShortDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

export function formatINR(amount) {
  return `\u20B9${Number(amount || 0).toLocaleString('en-IN')}`;
}

export function formatDate(iso) {
  return formatShortDate(iso);
}

export function getStatusCounts() {
  const orders = getOrders();
  const counts = {};
  ORDER_STATUSES.forEach((s) => { counts[s.key] = 0; });
  orders.forEach((o) => {
    if (counts[o.orderStatus] !== undefined) counts[o.orderStatus] += 1;
  });
  return {
    total: orders.length,
    new: counts.new || 0,
    confirmed: counts.confirmed || 0,
    inProduction: counts.in_production || 0,
    qualityCheck: counts.quality_check || 0,
    readyToDispatch: counts.ready_to_dispatch || 0,
    shipped: counts.shipped || 0,
    delivered: counts.delivered || 0,
  };
}
