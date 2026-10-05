/**
 * Guest UI-state persistence only.
 *
 * Business data (products, collections, customers, orders, inventory,
 * analytics, settings, authentication, wishlist) is authoritative in MongoDB
 * and is reached through the API via the service layer. This module persists
 * only temporary, non-authoritative browser state:
 *
 *   - guest cart (local browser state — cart survives while browsing)
 *
 * The wishlist is customer-owned backend state (Phase 3D): guests get a
 * "Sign in to save" prompt instead of a local wishlist.
 */

const STORAGE_KEYS = {
  CART: 'flora_alchemy_cart',
};

/**
 * PHASE 3 — ONE GLOBAL BAG.
 *
 * The cart key is deliberately NOT namespaced by the active shop any more:
 * browsing /shops/a then /shops/b used to swap the whole bag (`…::a` vs
 * `…::b`), so a customer lost sight of products added in another shop — the
 * exact behaviour a marketplace bag must not have. There is now exactly ONE
 * cart key for the browser, and the shop each line belongs to is carried ON
 * the line (see `addToCart`), not in the storage key.
 */
function cartKey() {
  return STORAGE_KEYS.CART;
}

/** One-time merge of the Phase 22.5 per-tenant keys into the global bag. */
function migrateLegacyCarts() {
  try {
    if (localStorage.getItem(STORAGE_KEYS.CART) !== null) return;
    const legacyKeys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`${STORAGE_KEYS.CART}::`)) legacyKeys.push(key);
    }
    if (legacyKeys.length === 0) return;
    const merged = [];
    const seen = new Map();
    for (const key of legacyKeys) {
      let rows = [];
      try {
        rows = JSON.parse(localStorage.getItem(key) || '[]');
      } catch {
        rows = [];
      }
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const k = lineKey(row);
        const prior = seen.get(k);
        if (prior) {
          // Keep the higher quantity instead of dropping a duplicate line.
          prior.quantity = Math.max(Number(prior.quantity) || 1, Number(row.quantity) || 1);
          continue;
        }
        seen.set(k, row);
        merged.push(row);
      }
    }
    if (merged.length > 0) setStored(STORAGE_KEYS.CART, merged);
    for (const key of legacyKeys) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* storage unavailable — the in-memory bag still works for this session */
  }
}

/** Stable identity of one bag line (same line = same product + customisation). */
export function lineKey(item) {
  if (!item) return '';
  const kind = item.isAddOn ? 'addon' : item.customGiftConfig ? 'gift' : 'product';
  return [
    kind,
    item.id || item.productSlug || item.name || '',
    item.palette || '',
    item.ribbon || '',
    item.customGiftConfig ? JSON.stringify(item.customGiftConfig) : '',
  ].join('|');
}

/**
 * Studio packaging add-on.
 *
 * The storefront has always offered this upgrade in the bag, but the selection
 * used to live in local component state and vanished at checkout. It is now a
 * real cart carriage so it survives Bag → Checkout → Order → Admin Order
 * Detail through the existing (non-catalogue) order-item path.
 *
 * NOTE: there is no backend add-on catalogue, so this price is a storefront
 * constant — reported, not silently presented as backend data.
 */
export const PACKAGING_ADD_ON = {
  id: 'studio-pine-casket',
  name: 'Studio Pine Keepsake Casket Upgrade',
  price: 450,
  category: 'Gift Packaging',
  description: 'Solid sliding pine casket with a brass wax seal.',
  image: '',
  isAddOn: true,
};

function getStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function setStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

// ─── Guest cart (ONE global bag) ───
export async function getCart() {
  migrateLegacyCarts();
  return getStored(cartKey(), []);
}

export async function updateCart(items) {
  setStored(cartKey(), items);
  return items;
}

export async function addToCart(product, options = {}) {
  const cart = await getCart();
  const quantity = options.quantity || 1;
  const isAddOn = !!options.isAddOn;
  // A product line and a single-selection add-on dedupe differently: products
  // merge only when their customization matches, add-ons merge by id alone.
  const existingIdx = cart.findIndex((item) =>
    isAddOn
      ? item.isAddOn && item.id === product.id
      : item.id === product.id &&
        item.palette === options.palette &&
        item.ribbon === options.ribbon
  );

  let updated;
  if (existingIdx > -1) {
    updated = [...cart];
    // An add-on is a single selection; it is never multiplied by line quantity.
    if (!isAddOn) updated[existingIdx].quantity += quantity;
  } else {
    const newItem = {
      id: product.id,
      name: product.name,
      price: options.customPrice || product.price,
      quantity: isAddOn ? 1 : quantity,
      image: product.images
        ? product.images[0]
        : product.image || '',
      category: product.categoryLabel || product.category || 'Handcrafted Flora',
      // Catalogue identity the server re-prices from. Add-ons and bespoke
      // items deliberately carry no slug so they resolve through the
      // non-catalogue order path.
      productSlug: isAddOn ? null : (product.slug || options.productSlug || null),
      description: options.description || product.description || null,
      palette: options.palette || null,
      ribbon: options.ribbon || null,
      giftMessage: options.giftMessage || null,
      customDetails: options.customDetails || null,
      customGiftConfig: options.customGiftConfig || null,
      addOnId: options.addOnId || null,
      // PHASE 2 — the shop the customer chose to make a Custom Gift Studio
      // gift. It rides the line (local bag state) to checkout, where it is
      // sent as `shopSlug` and VALIDATED server-side against ACTIVE shops;
      // the browser value is never an authority on its own.
      fulfillmentShopSlug: options.fulfillmentShopSlug || null,
      // PHASE 3 — the public Shop identity of a catalogue line
      // (`{ slug, displayName }`, Phase 1 projection). It is DISCOVERY/UI
      // metadata only: the cart groups lines by it and offers a per-shop
      // checkout, while the server re-derives the real owner from the
      // Product row and refuses anything that disagrees.
      shop: product.shop && product.shop.slug
        ? { slug: product.shop.slug, displayName: product.shop.displayName || product.shop.slug }
        : null,
      isAddOn,
    };
    updated = [newItem, ...cart];
  }
  setStored(cartKey(), updated);
  return updated;
}

export async function removeFromCart(itemIndex) {
  const cart = await getCart();
  const updated = cart.filter((_, idx) => idx !== itemIndex);
  setStored(cartKey(), updated);
  return updated;
}

/**
 * PHASE 3 §20 — remove ONLY the lines that were purchased.
 *
 * A global bag may still hold other shops' products after a successful
 * checkout; clearing everything would destroy them. The caller passes the
 * exact purchased lines and every other line survives.
 */
export async function removeCartLines(lines) {
  const cart = await getCart();
  const keys = new Set((lines || []).map(lineKey));
  if (keys.size === 0) return cart;
  const updated = cart.filter((item) => !keys.has(lineKey(item)));
  setStored(cartKey(), updated);
  return updated;
}

/** Remove a cart add-on (e.g. the packaging upgrade) by its id. */
export async function removeAddOnFromCart(addOnId) {
  const cart = await getCart();
  const updated = cart.filter((item) => !(item.isAddOn && item.id === addOnId));
  setStored(cartKey(), updated);
  return updated;
}
