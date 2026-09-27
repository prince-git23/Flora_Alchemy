import api from './apiClient.js';

/**
 * shopService — Phase 22.4/22.5 public shop directory + storefront reads.
 *
 * The slug is the ONLY tenant input, and it is a LOOKUP key sent to the
 * backend — never an authorization grant. Every call attaches no session
 * (`scope: null`): a signed-in customer/admin token must never ride along on a
 * public shop probe, and the backend resolves the ACTIVE workspace itself.
 *
 * Unknown / suspended / malformed / reserved slugs all answer 404 SHOP_NOT_FOUND,
 * so the resolver collapses them to the standard not-found page without
 * disclosing whether the address ever existed.
 */

function normalize(slug) {
  return String(slug || '').trim().toLowerCase();
}

async function shopGet(slug, suffix) {
  const normalized = normalize(slug);
  if (!normalized) {
    return { ok: false, status: 404, code: 'SHOP_NOT_FOUND' };
  }
  const res = await api.get(`/shops/${encodeURIComponent(normalized)}${suffix}`, { scope: null });
  return res;
}

/**
 * @param {string} slug workspace slug (the /shops/ path segment)
 * @returns {Promise<{ok:boolean,status:number,code?:string,shop?:{slug:string,displayName:string}|null,message?:string}>}
 */
export async function getShop(slug) {
  const res = await shopGet(slug, '');
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    shop: res.data?.shop || null,
    message: res.message,
  };
}

/** The resolved workspace's own VISIBLE products (no inventory quantities). */
export async function getShopProducts(slug) {
  const res = await shopGet(slug, '/products');
  return {
    ok: res.ok,
    status: res.status,
    shop: res.data?.shop || null,
    products: res.data?.products || [],
    message: res.message,
  };
}

/** The resolved workspace's own VISIBLE collections. */
export async function getShopCollections(slug) {
  const res = await shopGet(slug, '/collections');
  return {
    ok: res.ok,
    status: res.status,
    shop: res.data?.shop || null,
    collections: res.data?.collections || [],
    message: res.message,
  };
}

/** The public slice of the resolved workspace's settings. */
export async function getShopSettings(slug) {
  const res = await shopGet(slug, '/settings');
  return {
    ok: res.ok,
    status: res.status,
    shop: res.data?.shop || null,
    settings: res.data?.settings || null,
    message: res.message,
  };
}
