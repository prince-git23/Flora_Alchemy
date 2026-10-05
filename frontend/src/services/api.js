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

import { tenantKey } from './tenantContext.js';

/** Phase 22.5 — the cart key is namespaced by the active workspace. */
function cartKey() {
  return tenantKey(STORAGE_KEYS.CART);
}

const STORAGE_KEYS = {
  CART: 'flora_alchemy_cart',
};

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

// ─── Guest cart ───
export async function getCart() {
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

/** Remove a cart add-on (e.g. the packaging upgrade) by its id. */
export async function removeAddOnFromCart(addOnId) {
  const cart = await getCart();
  const updated = cart.filter((item) => !(item.isAddOn && item.id === addOnId));
  setStored(cartKey(), updated);
  return updated;
}
