import api from './apiClient.js';
import { getTenant } from './tenantContext.js';

/**
 * Phase 22.5 — the active workspace (shop slug) is passed as a SELECTOR so the
 * backend stores/reads the wishlist for the right tenant. It is NOT an
 * authorization input: the server resolves the slug to an ACTIVE workspace and
 * still derives ownership from the customer JWT. `default` means the main
 * storefront (the backend then uses the single active workspace).
 */
function shopQuery() {
  const t = getTenant();
  return t && t !== 'default' ? `?shop=${encodeURIComponent(t)}` : '';
}

/**
 * Phase 3D — customer wishlist is real backend state.
 *
 * The wishlist belongs to the authenticated customer and persists in
 * MongoDB (GET/POST/DELETE /api/wishlist). Ownership is derived from the
 * customer JWT on the server — the browser never sends an owner id.
 *
 * Guests have NO persistent wishlist: the heart opens a "Sign in to save
 * your favorite creations." prompt instead (handled in StoreContext), so no
 * temporary guest IDs exist to merge or leak.
 */

function parseWishlist(data) {
  return {
    productIds: (data.wishlist && data.wishlist.productIds) || [],
    products: (data.wishlist && data.wishlist.products) || [],
    unavailableIds: (data.wishlist && data.wishlist.unavailableIds) || [],
  };
}

/** GET /api/wishlist — the authenticated customer's saved products. */
export async function getWishlist() {
  const res = await api.get(`/wishlist${shopQuery()}`, { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'Wishlist could not be loaded.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  return parseWishlist(res.data);
}

/** POST /api/wishlist/:productId — saves a product (deduped server-side). */
export async function addToWishlist(productId) {
  const res = await api.post(`/wishlist/${encodeURIComponent(productId)}${shopQuery()}`, undefined, { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'This creation could not be saved.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  return parseWishlist(res.data);
}

/** DELETE /api/wishlist/:productId — removes one saved product. */
export async function removeFromWishlist(productId) {
  const res = await api.delete(`/wishlist/${encodeURIComponent(productId)}${shopQuery()}`, { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'This creation could not be removed.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  return parseWishlist(res.data);
}

/** DELETE /api/wishlist — removes every saved product. */
export async function clearWishlist() {
  const res = await api.delete(`/wishlist${shopQuery()}`, { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'Wishlist could not be cleared.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  return parseWishlist(res.data);
}