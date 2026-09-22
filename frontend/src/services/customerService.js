import { getStored, setStored, clearStored } from './storage.js';
import { api, setToken, clearToken } from './apiClient.js';
import { store, signalDataChanged, upsertCustomer } from './dataStore.js';

/**
 * Phase 3C — customerService.
 *
 * Identity/session: fresh browsers are GUEST; account is only written after an
 * explicit login/registration against the backend.
 * Business data: customer lists/profiles come from the server-hydrated store
 * (GET /api/customers for staff, GET /api/auth/me for the signed-in customer).
 * No demo customers are seeded or shown as the current user.
 */

const ACCOUNT_KEY = 'flora_alchemy_account';

// ─── Normalization ───
function withDerivedStats(c) {
  const id = String(c.id || c._id || '');
  const own = store.orders.filter((o) => String(o.customerId) === id);
  const spend = own.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  return {
    id,
    name: c.name || '',
    email: c.email || '',
    phone: c.phone || '',
    status: c.status || 'Active',
    addresses: c.addresses || [],
    preferences: c.preferences || {},
    city: c.city || '',
    state: c.state || '',
    isFixture: !!c.isFixture,
    createdAt: c.createdAt,
    orderCount: own.length,
    totalSpend: Math.round(spend),
    orders: own.length,
  };
}

export function getCustomers() {
  return store.customers.map(withDerivedStats);
}

export function getCustomerById(customerId) {
  if (!customerId) return null;
  const id = String(customerId);
  const fromList = store.customers.find((c) => String(c.id || c._id) === id);
  if (fromList) return withDerivedStats(fromList);
  if (store.currentCustomer && String(store.currentCustomer.id || store.currentCustomer._id) === id) {
    return withDerivedStats(store.currentCustomer);
  }
  return null;
}

export function getCustomerByEmail(email) {
  if (!email) return null;
  const lower = String(email).toLowerCase();
  const fromList = store.customers.find((c) => String(c.email || '').toLowerCase() === lower);
  if (fromList) return withDerivedStats(fromList);
  if (store.currentCustomer && String(store.currentCustomer.email || '').toLowerCase() === lower) {
    return withDerivedStats(store.currentCustomer);
  }
  return null;
}

/** Backend registration (User + Customer) — used by the explicit sign-up flow. */
export async function createCustomer(data) {
  return apiRegister(data);
}

/** Profile update — owner (customer scope) or staff (admin scope). */
export async function updateCustomer(customerId, updates) {
  const payload = {};
  for (const field of ['name', 'phone', 'addresses', 'preferences', 'city', 'state']) {
    if (updates[field] !== undefined) payload[field] = updates[field];
  }
  const scope = getStored('flora_alchemy_admin_session', null) ? 'admin' : 'customer';
  const res = await api.patch(`/customers/${encodeURIComponent(customerId)}`, payload, { scope });
  if (!res.ok) {
    const err = new Error(res.message || 'Profile could not be updated.');
    err.code = res.code;
    throw err;
  }
  upsertCustomer(res.data.customer);
  // Keep the lightweight account marker in sync so the navbar/account header
  // reflect the saved name immediately.
  if (res.data.customer) {
    const updated = withDerivedStats(res.data.customer);
    setAccount({
      name: updated.name,
      email: updated.email,
      phone: updated.phone || '',
      customerId: updated.id,
    });
  }
  return withDerivedStats(res.data.customer);
}

// ─── Own addresses (backend-owned, Phase 3D) ───

function addressPayload(addr) {
  const payload = {};
  for (const field of ['label', 'name', 'address', 'city', 'state', 'pincode', 'phone', 'isDefault']) {
    if (addr[field] !== undefined) payload[field] = addr[field];
  }
  return payload;
}

/** Add an address to the authenticated customer's address book. */
export async function addAddress(addr) {
  const res = await api.post('/customers/me/addresses', addressPayload(addr), { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'Address could not be saved.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  upsertCustomer(res.data.customer);
  return res.data.customer;
}

/** Edit an address (owner only). */
export async function updateAddress(addressId, updates) {
  const res = await api.patch(
    `/customers/me/addresses/${encodeURIComponent(addressId)}`,
    addressPayload(updates),
    { scope: 'customer' }
  );
  if (!res.ok) {
    const err = new Error(res.message || 'Address could not be updated.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  upsertCustomer(res.data.customer);
  return res.data.customer;
}

/** Delete an address (owner only). */
export async function deleteAddress(addressId) {
  const res = await api.delete(`/customers/me/addresses/${encodeURIComponent(addressId)}`, { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'Address could not be removed.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  upsertCustomer(res.data.customer);
  return res.data.customer;
}

/** Re-read the authenticated customer's live profile from the backend. */
export async function refreshCurrentCustomer() {
  const res = await api.get('/auth/me', { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'Profile could not be loaded.');
    err.code = res.code;
    throw err;
  }
  if (res.data.customer) upsertCustomer(res.data.customer);
  return res.data.customer || null;
}

/** Server maintains customer stats with each order — no local bookkeeping. */
export function addOrderToCustomer() {
  return undefined;
}

// ─── Customer session (explicit auth only) ───
export function getAccount() {
  return getStored(ACCOUNT_KEY, null);
}

export function setAccount(accountData) {
  const current = getAccount() || {};
  const updated = {
    ...current,
    ...accountData,
    customerId: accountData.customerId || current.customerId || null,
  };
  setStored(ACCOUNT_KEY, updated);
  return updated;
}

export function logoutAccount() {
  clearStored(ACCOUNT_KEY);
}

export function getActiveCustomerId() {
  const account = getAccount();
  return account?.customerId ?? null;
}

export function getActiveCustomer() {
  const customerId = getActiveCustomerId();
  if (!customerId) return null;
  return getCustomerById(customerId);
}

// ─── Real API authentication ───
async function applyAuthSession({ token, user, customer }) {
  setToken(token, 'customer');
  if (customer) {
    setAccount({
      name: customer.name,
      email: customer.email,
      phone: customer.phone || '',
      customerId: customer.id,
    });
    store.currentCustomer = customer;
  }
  return { user, customer };
}

export async function apiLogin(email, password) {
  const res = await api.post('/auth/login', { email, password });
  if (!res.ok) {
    return { error: res.message || 'Sign in failed. Please try again.', code: res.code, status: res.status };
  }
  await applyAuthSession(res.data);
  signalDataChanged('auth');
  return { success: true, ...res.data };
}

export async function apiRegister({ name, email, password, phone }) {
  const res = await api.post('/auth/register', { name, email, password, phone });
  if (!res.ok) {
    return { error: res.message || 'Registration failed. Please try again.', code: res.code, status: res.status };
  }
  await applyAuthSession(res.data);
  signalDataChanged('auth');
  return { success: true, created: res.status === 201, ...res.data };
}

export async function apiLogout() {
  try {
    await api.post('/auth/logout', {});
  } catch {
    /* best effort */
  }
  clearToken('customer');
  logoutAccount();
  store.currentCustomer = null;
  signalDataChanged('auth');
}

// ─── Phase 20.3 — checkout address persistence ───

/**
 * Backend-sync an address captured during checkout (Phase 20.3).
 * The customer's address book is the single source of truth — the checkout
 * form only seeds it. Invalid/incomplete data is rejected by the server
 * (422 surfaces to the customer), never silently stored as a reusable
 * default. Matching addresses are refreshed in place instead of duplicated.
 */
export async function saveAddressToAccount(addr) {
  const current = getActiveCustomer();
  const addresses = (current && current.addresses) || [];

  // Already in the book (same recipient street + pincode)? Refresh it.
  const match = addresses.find(
    (a) =>
      String(a.address || '').trim().toLowerCase() === String(addr.address || '').trim().toLowerCase() &&
      String(a.pincode || '') === String(addr.pincode || '')
  );
  if (match) {
    // Keep the newest contact details; the default flag is untouched.
    return updateAddress(match._id || match.id, {
      name: addr.name || match.name,
      phone: addr.phone || match.phone,
      city: addr.city || match.city,
      state: addr.state || match.state,
    });
  }

  // New address: make it the default so the NEXT checkout pre-fills it.
  return addAddress({
    label: addr.label || 'Home',
    name: addr.name || '',
    address: addr.address || '',
    city: addr.city || '',
    state: addr.state || '',
    pincode: addr.pincode || '',
    phone: addr.phone || '',
    isDefault: true,
  });
}
