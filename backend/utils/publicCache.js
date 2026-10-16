/**
 * Phase 17 — tiny TTL cache for low-volatility PUBLIC reads.
 *
 * Scope (deliberately narrow):
 *   - public product list / product detail
 *   - public collections list
 *   - public settings
 *
 * Explicitly NOT cached (authority + volatility): orders, payments, inventory,
 * notifications, conversations, customers, admin/staff views of any kind.
 *
 * Invalidation: settings invalidate on PATCH /api/settings; product/collection
 * writes invalidate on every product/collection create/update/delete.
 * Stale-data tolerance: TTL is 30s, so even without a write event a stale
 * storefront read self-heals within 30 seconds.
 *
 * Values are deep-copied on both set and get so callers can never mutate the
 * cached object (Mongoose docs are converted with toObject + JSON clone).
 */

const TTL_MS = 30 * 1000;
const store = new Map(); // key → { expires, value }

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    store.delete(key);
    return undefined;
  }
  return clone(hit.value);
}

export function cacheSet(key, value) {
  if (value === undefined) return;
  store.set(key, { expires: Date.now() + TTL_MS, value: clone(value) });
}

/**
 * Invalidate by prefix — "products:" clears every product-list key including
 * query variants. Called from write controllers.
 */
export function cacheInvalidatePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/**
 * Ensure cached JSON carries the SAME response contract as a live Mongoose
 * res.json(): lean() bypasses toJSON transforms (e.g. Product maps id=slug
 * and strips _id/__v). Round-tripping each plain object through a throwaway
 * model document applies the model's own transform, so cached and live
 * responses are byte-equivalent. Models without transforms are unaffected.
 */
function serializeContract(docs, model) {
  if (!model || !Array.isArray(docs)) return clone(docs);
  try {
    return clone(docs.map((d) => new model(d).toJSON()));
  } catch {
    return clone(docs);
  }
}

/** Test hook: drop everything. */
export function cacheClear() {
  store.clear();
}

/**
 * PHASE 3 — invalidate the cached PUBLIC 3D projection for a product.
 *
 * The storefront's 3D metadata (`services/product3dPublicResolution.js`) sits
 * under the key `3d:model:<productSlug>` with the same 30s TTL as every other
 * public read, so a newly approved model would otherwise take up to 30 seconds
 * to appear — and a replaced or unpublished one up to 30 seconds to disappear.
 * Every write that can change the answer therefore drops the key explicitly:
 *
 *   · approving / rejecting / deleting an asset        (3dAssetService)
 *   · creating / editing / renaming / deleting a product, and any
 *     publish/unpublish (visibility) change           (productController)
 *
 * A product with no model simply has no key, so the call is a cheap no-op.
 */
export function cacheInvalidate3dDelivery(productSlug) {
  if (!productSlug) return;
  store.delete('3d:model:' + productSlug);
}

/**
 * Wrap an async loader with read-through caching.
 * `model` is optional — when given a Mongoose model, cached values are
 * serialized through the model's toJSON transform for contract parity
 * (lean() results otherwise bypass transforms like Product's id=slug map).
 */
export async function cached(key, loader, model = null) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const fresh = await loader();
  // Misses are never cached: wrapping a null through the model transform
  // would turn it into a truthy empty object and break 404 semantics.
  if (fresh === null || fresh === undefined) return fresh;
  if (model) {
    const single = !Array.isArray(fresh);
    const transformed = serializeContract(single ? [fresh] : fresh, model);
    cacheSet(key, single ? transformed[0] : transformed);
  } else {
    cacheSet(key, fresh);
  }
  return cacheGet(key);
}
