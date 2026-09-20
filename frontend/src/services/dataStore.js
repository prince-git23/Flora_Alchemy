import api from './apiClient.js';
import { getToken } from './apiClient.js';
import { getStored } from './storage.js';

/**
 * Server-backed in-memory data store (Phase 3C).
 *
 * The store holds the authoritative business collections hydrated from the
 * Express/MongoDB API and exposes them synchronously so existing pages keep
 * working. localStorage is NO LONGER used for business records — it remains
 * only for the auth session markers and guest cart/wishlist.
 *
 * Hydration is scope-aware:
 *   public   — catalogue (visible products), collections, settings
 *   admin    — full orders/customers/inventory/history/products/analytics
 *   customer — /auth/me profile (+ own orders via /orders/mine when alone)
 *
 * Mutations call the API and then signal the store so the UI re-renders with
 * the server-confirmed state.
 */

export const store = {
  products: [],
  collections: [],
  settings: null,
  orders: [],
  customers: [],
  inventory: [],
  inventoryHistory: [],
  analyticsOverview: null,
  currentCustomer: null,
};

let version = 0;
const listeners = new Set();

export function getStoreVersion() {
  return version;
}

export function subscribeStore(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function commit() {
  version += 1;
  listeners.forEach((fn) => fn());
}

/**
 * Phase 18.5.2 — targeted synchronization: notify store subscribers that a
 * mutation just updated part of the store with server-confirmed data. Pages
 * re-render in place (no global loader, no remount). The full background
 * re-sync remains available via signalDataChanged().
 */
export function commitStore() {
  commit();
}

/**
 * Signal that data changed → DataProvider re-syncs.
 * scope: 'auth'  — session changed (login/logout); DataProvider may re-show
 *                  the bootstrap loader because the whole dataset scope flips.
 *        'data'  — business mutation (default); DataProvider syncs silently
 *                  in the background and the UI must stay visible (Phase 18.5.2).
 */
export function signalDataChanged(scope = 'data') {
  try {
    window.dispatchEvent(new CustomEvent('fa:refresh', { detail: { scope } }));
  } catch {
    /* non-browser */
  }
}

export class DataError extends Error {
  constructor(message, status = 0, code = 'API_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function getOrThrow(path, scope) {
  const res = await api.get(path, { scope });
  if (!res.ok) {
    throw new DataError(res.message, res.status, res.code);
  }
  return res.data;
}

export function hasAdminSessionScope() {
  return !!getStored('flora_alchemy_admin_session', null);
}

export function hasCustomerSessionScope() {
  return !!getToken('customer') || !!getStored('flora_alchemy_account', null);
}

/** Public catalogue + store config (visible products only). */
export async function hydratePublic() {
  // Public reads need no token; an existing admin token is deliberately not
  // attached so the storefront always receives the visible-only catalogue.
  const [p, c, s] = await Promise.all([
    api.get('/products', { scope: null }),
    api.get('/collections', { scope: null }),
    api.get('/settings', { scope: null }),
  ]);
  if (!p.ok || !c.ok || !s.ok) {
    const bad = [p, c, s].find((r) => !r.ok);
    throw new DataError(bad.message, bad.status, bad.code);
  }
  store.products = p.data.products || [];
  store.collections = c.data.collections || [];
  store.settings = s.data.settings || null;
  commit();
}

/** Admin scope: staff catalogue (incl. hidden), all orders, customers, inventory, analytics. */
export async function hydrateAdmin() {
  const [products, orders, customers, inventory, history, analytics] = await Promise.all([
    api.get('/products', { scope: 'admin' }),
    api.get('/orders', { scope: 'admin' }),
    api.get('/customers', { scope: 'admin' }),
    api.get('/inventory', { scope: 'admin' }),
    api.get('/inventory/history', { scope: 'admin' }),
    api.get('/analytics/overview', { scope: 'admin' }),
  ]);
  const bad = [products, orders, customers, inventory, history, analytics].find((r) => !r.ok);
  if (bad) throw new DataError(bad.message, bad.status, bad.code);
  store.products = products.data.products || [];
  store.orders = orders.data.orders || [];
  store.customers = customers.data.customers || [];
  store.inventory = inventory.data.inventory || [];
  store.inventoryHistory = history.data.movements || [];
  store.analyticsOverview = analytics.data.analytics || null;
  commit();
}

/** Customer scope: profile + own orders (only when no admin session provides the full list). */
export async function hydrateCustomer() {
  const me = await api.get('/auth/me', { scope: 'customer' });
  if (!me.ok) throw new DataError(me.message, me.status, me.code);
  store.currentCustomer = me.data.customer || null;

  if (!hasAdminSessionScope()) {
    const mine = await api.get('/orders/mine', { scope: 'customer' });
    if (!mine.ok) throw new DataError(mine.message, mine.status, mine.code);
    store.orders = mine.data.orders || [];
  }
  commit();
}

export async function refreshOrders() {
  if (hasAdminSessionScope()) {
    const r = await getOrThrow('/orders', 'admin');
    store.orders = r.orders || [];
  } else if (hasCustomerSessionScope()) {
    const r = await getOrThrow('/orders/mine', 'customer');
    store.orders = r.orders || [];
  }
  commit();
}

export async function refreshProducts() {
  const res = hasAdminSessionScope()
    ? await api.get('/products', { scope: 'admin' })
    : await api.get('/products', { scope: null });
  if (!res.ok) throw new DataError(res.message, res.status, res.code);
  store.products = res.data.products || [];
  commit();
}

export async function refreshInventory() {
  if (hasAdminSessionScope()) {
    const [inv, hist] = await Promise.all([
      getOrThrow('/inventory', 'admin'),
      getOrThrow('/inventory/history', 'admin'),
    ]);
    store.inventory = inv.inventory || [];
    store.inventoryHistory = hist.movements || [];
  }
  commit();
}

export async function refreshAnalytics() {
  if (hasAdminSessionScope()) {
    const r = await getOrThrow('/analytics/overview', 'admin');
    store.analyticsOverview = r.analytics || null;
  }
  commit();
}

export async function refreshAdminList() {
  if (!hasAdminSessionScope()) return;
  const [orders, customers, inventory, history, analytics] = await Promise.all([
    api.get('/orders', { scope: 'admin' }),
    api.get('/customers', { scope: 'admin' }),
    api.get('/inventory', { scope: 'admin' }),
    api.get('/inventory/history', { scope: 'admin' }),
    api.get('/analytics/overview', { scope: 'admin' }),
  ]);
  const bad = [orders, customers, inventory, history, analytics].find((r) => !r.ok);
  if (bad) throw new DataError(bad.message, bad.status, bad.code);
  store.orders = orders.data.orders || [];
  store.customers = customers.data.customers || [];
  store.inventory = inventory.data.inventory || [];
  store.inventoryHistory = history.data.movements || [];
  store.analyticsOverview = analytics.data.analytics || null;
  commit();
}

export function clearSessionData() {
  store.currentCustomer = null;
  if (!hasAdminSessionScope()) {
    store.orders = [];
    store.customers = [];
    store.inventory = [];
    store.inventoryHistory = [];
    store.analyticsOverview = null;
  }
  commit();
}

export function upsertOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return;
  const byId = new Map(store.orders.map((o) => [o.orderId || o.id, o]));
  orders.forEach((o) => byId.set(o.orderId || o.id, o));
  store.orders = [...byId.values()];
  commit();
}

/**
 * Merge an updated customer document into the store (list + current profile)
 * and notify listeners — used after profile/address mutations so the UI
 * reflects the server-confirmed state without a full re-hydration.
 */
export function upsertCustomer(customer) {
  if (!customer) return;
  const id = String(customer.id || customer._id);
  store.customers = [
    ...store.customers.filter((c) => String(c.id || c._id) !== id),
    customer,
  ];
  if (store.currentCustomer && String(store.currentCustomer.id || store.currentCustomer._id) === id) {
    store.currentCustomer = customer;
  }
  commit();
}
