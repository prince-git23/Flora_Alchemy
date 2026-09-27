import api from './apiClient.js';

/**
 * shopService — Phase 22.4 public shop directory reads.
 *
 * getShop is the storefront's ONLY tokenless workspace lookup: GET
 * /api/shops/:slug resolves an ACTIVE workspace's public identity (slug +
 * display name). It deliberately attaches no session (scope: null) — the
 * endpoint is public by design, and a signed-in customer/admin token must
 * never ride along on a directory probe.
 *
 * Suspended or unknown slugs answer 404 SHOP_NOT_FOUND, so the resolver can
 * collapse them to the standard not-found page without leaking whether the
 * address ever existed.
 *
 * Phase 22.5 will hydrate the per-shop catalogue (products/collections)
 * through DataContext once a shop resolves; this phase stops at identity.
 */

/**
 * @param {string} slug workspace slug (the /shops/ path segment)
 * @returns {Promise<{ok:boolean,status:number,code?:string,shop?:{slug:string,displayName:string}|null,message?:string}>}
 */
export async function getShop(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) {
    return { ok: false, status: 404, code: 'SHOP_NOT_FOUND', shop: null, message: 'Shop not found.' };
  }
  const res = await api.get(`/shops/${encodeURIComponent(normalized)}`, { scope: null });
  return {
    ok: res.ok,
    status: res.status,
    code: res.code,
    shop: res.data?.shop || null,
    message: res.message,
  };
}
