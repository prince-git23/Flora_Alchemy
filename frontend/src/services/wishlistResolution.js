/**
 * WISHLIST RESOLUTION — where a saved id becomes a card, or a retired entry.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * The wishlist API already returns the saved products themselves
 * (`wishlist.products`) and the ids it could not resolve
 * (`wishlist.unavailableIds`). Resolving the saved ids ONLY against the
 * storefront catalogue made "is this saved item still available?" depend on an
 * unrelated cache having hydrated first: a catalogue read that lost the race, or
 * a slice that had not been fetched for this page, turned a perfectly live
 * product into "This creation was retired from the collection."
 *
 * That is a FALSE STATEMENT about a real product, and it is exactly what the
 * wishlist E2E flow hit in CI: `GET /api/products` returned the product,
 * `POST /api/wishlist/<slug>` returned the product, `GET /api/wishlist` returned
 * the product — and the page still rendered the retired card.
 *
 * So the server projection is the AUTHORITY:
 *   · a product the server sends is AVAILABLE, whatever the local cache holds;
 *   · an id the server lists in `unavailableIds` is RETIRED, whatever the cache holds;
 *   · the local catalogue is a FALLBACK for an id the server omitted (an older
 *     response shape, say) — never evidence of retirement on its own.
 *
 * Order is the customer's saved order, never an object's key order.
 *
 * This module is deliberately free of React, the DOM, `window` and the store, so
 * the rule can be exercised directly by the browser suite as well as by the UI.
 */

/**
 * Resolve a wishlist payload to ordered rows plus genuinely-unavailable ids.
 *
 * @param {object}  input
 * @param {string[]} input.productIds      The saved ids, IN SAVED ORDER.
 * @param {object[]} input.products        Raw products from the wishlist API.
 * @param {string[]} input.unavailableIds  Ids the SERVER says it could not resolve.
 * @param {object[]} input.catalog         Normalised storefront products (fallback).
 * @returns {{ rows: {id: string, from: 'server'|'catalog', raw: object}[], unavailable: string[] }}
 */
export function resolveWishlistRows({ productIds = [], products = [], unavailableIds = [], catalog = [] } = {}) {
  const ids = Array.isArray(productIds) ? productIds.map(String) : [];

  const serverById = new Map();
  for (const product of Array.isArray(products) ? products : []) {
    if (!product || typeof product !== 'object') continue;
    const id = String(product.slug || product.id || '');
    if (id) serverById.set(id, product);
  }

  const retired = new Set((Array.isArray(unavailableIds) ? unavailableIds : []).map(String));

  const catalogById = new Map();
  for (const product of Array.isArray(catalog) ? catalog : []) {
    if (!product || typeof product !== 'object') continue;
    const id = String(product.id || product.slug || '');
    if (id) catalogById.set(id, product);
  }

  const rows = [];
  const unavailable = [];
  const handled = new Set();

  for (const id of ids) {
    if (handled.has(id)) continue;
    handled.add(id);

    // The server's explicit retirement wins over everything, including a
    // catalogue row that happens to still be cached.
    if (retired.has(id)) {
      unavailable.push(id);
      continue;
    }

    const fromServer = serverById.get(id);
    if (fromServer) {
      rows.push({ id, from: 'server', raw: fromServer });
      continue;
    }

    const fromCatalog = catalogById.get(id);
    if (fromCatalog) {
      rows.push({ id, from: 'catalog', raw: fromCatalog });
      continue;
    }

    // Neither source can produce it: report it as unavailable so the customer
    // can remove it, rather than silently dropping a saved id.
    unavailable.push(id);
  }

  // A retired id the server reported but that is no longer in `productIds` still
  // has to be removable — the customer must never be stuck with it.
  for (const id of retired) {
    if (!handled.has(id)) {
      handled.add(id);
      unavailable.push(id);
    }
  }

  return { rows, unavailable };
}

/**
 * A monotonic guard for wishlist server calls.
 *
 * The wishlist is mutated (add/remove) and read (mount, sign-in) independently.
 * Without this, a slow GET that started BEFORE a successful removal can land
 * afterwards and put the removed product back on screen — the UI would then
 * disagree with the server until the next reload.
 *
 * Every call takes a token with `begin()` and may commit only while its token is
 * still the newest. Dropping a superseded response is always correct: a newer
 * call already describes later state.
 */
export function createWishlistRequestGuard() {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      return latest;
    },
    isCurrent(token) {
      return typeof token === 'number' && token === latest;
    },
  };
}

export default { resolveWishlistRows, createWishlistRequestGuard };
