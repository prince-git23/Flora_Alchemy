/**
 * PHASE 3 — group a GLOBAL bag by its real Shop.
 *
 * The bag holds products from many shops at once; checkout happens one shop at
 * a time. This helper turns flat cart lines into per-shop groups for display
 * and for the per-shop checkout action:
 *
 *   · a catalogue line carries the Phase 1 public projection
 *     `shop: { slug, displayName }` stamped when it was added;
 *   · a Custom Gift Studio line carries the fulfilment shop the customer
 *     chose (`fulfillmentShopSlug`);
 *   · an old line saved before Phase 3 has neither — the current catalogue is
 *     consulted, and when the deployment has exactly ONE live shop the single-
 *     store compatibility rule applies (the server applies the same rule);
 *   · a line whose shop is no longer ACTIVE (or is ambiguous with several
 *     shops) is surfaced as UNAVAILABLE — it can be removed, never checked out.
 *
 * The grouping is DISPLAY ONLY: the server re-derives every order's real
 * workspace from the Product rows and refuses a mixed or stale bag.
 */
import { getProducts } from './productService.js';

/** The shop slug a line belongs to, or null. */
export function shopSlugOfLine(item, catalog = []) {
  if (!item) return null;
  if (item.shop && item.shop.slug) return item.shop.slug;
  if (item.fulfillmentShopSlug) return item.fulfillmentShopSlug;
  const product = catalog.find((p) => p.slug === item.productSlug || p.id === item.id);
  return product?.shop?.slug || null;
}

/**
 * @param {Array} cart       raw cart lines
 * @param {object} opts
 * @param {Array} opts.catalog   normalized public products (may include `shop`)
 * @param {Array} opts.shops     ACTIVE shop directory (`{ slug, displayName }`)
 * @returns {{ groups: Array, addOns: Array }}
 */
export function groupCartByShop(cart, { catalog = [], shops = [] } = {}) {
  const catalogRows = catalog.length ? catalog : getProducts();
  const activeBySlug = new Map((shops || []).map((s) => [s.slug, s]));
  const singleShop = shops && shops.length === 1 ? shops[0] : null;

  const groups = new Map();
  const addOns = [];
  for (const item of cart || []) {
    if (!item) continue;
    if (item.isAddOn) {
      addOns.push(item);
      continue;
    }
    let slug = item.shop?.slug || item.fulfillmentShopSlug || null;
    let displayName = item.shop?.displayName || null;
    if (!slug) {
      const product = catalogRows.find((p) => p.slug === item.productSlug || p.id === item.id);
      slug = product?.shop?.slug || null;
      displayName = product?.shop?.displayName || null;
    }
    if (!slug && singleShop) {
      slug = singleShop.slug;
      displayName = singleShop.displayName;
    }
    const key = slug || '__unattributed__';
    if (!groups.has(key)) {
      groups.set(key, { key, slug, displayName: displayName || null, items: [], subtotal: 0 });
    }
    const group = groups.get(key);
    if (!group.displayName && displayName) group.displayName = displayName;
    group.items.push(item);
    group.subtotal += (Number(item.price) || 0) * (Number(item.quantity) || 1);
  }

  for (const group of groups.values()) {
    const live = group.slug ? activeBySlug.get(group.slug) : null;
    group.available = group.slug
      ? !!live
      : // No shop on the line and no live shop to fall back to: orderable only
        // when the deployment has no shops at all (pre-onboarding compatibility,
        // the server's documented legacy path).
        (shops || []).length === 0;
    group.displayName = live?.displayName || group.displayName || 'Flora Alchemy';
  }

  return { groups: [...groups.values()], addOns };
}

/** The checkout URL for one group (the selection is a LOOKUP key server-side). */
export function checkoutUrlFor(group) {
  return group.slug ? `/checkout?shop=${encodeURIComponent(group.slug)}` : '/checkout';
}
