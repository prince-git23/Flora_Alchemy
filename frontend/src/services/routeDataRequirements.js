/**
 * Phase 20.5 — route → required data map.
 *
 * The application used to block the WHOLE shell behind one global hydration of
 * products + collections + settings (+ the signed-in profile and order list).
 * A visitor landing on /shop therefore waited for collections and for the
 * customer's order history before the Shop page could even mount.
 *
 * This module states, per route, the smallest dataset that must exist before
 * that route can render honestly, and what may hydrate afterwards in the
 * background. It is derived from the code, not assumed:
 *
 *   getProducts()        Home · Shop · Product · Cart · Checkout preflight ·
 *                        Search · GiftFinder · all admin catalogue screens
 *   getSettings()        store config used by the SHELL and by Cart/Checkout
 *                        (shipping rates, free-shipping threshold, flags)
 *   getCollections()     ONLY CollectionsPage · AdminCollectionsPage ·
 *                        AdminHeader — Home and Shop link to /collections but
 *                        never read the slice
 *   getActiveCustomer()  Navbar (signed-in identity) · Checkout (saved address)
 *                        · Account — backed by store.currentCustomer, i.e. the
 *                        /auth/me slice
 *   store.orders         Account history · order-success / order-tracking
 *                        fallback lookups
 *
 * Admin-only slices (customers, inventory, analytics, and admin-scoped orders)
 * are never requested for customer routes, and customer/storefront slices are
 * never requested for admin routes — the endpoint scope follows the session,
 * so the request set stays isolated both ways.
 */

/** Every slice the store can hydrate independently (Phase 20.1 refreshers). */
export const ALL_SLICES = [
  'products',
  'collections',
  'settings',
  'identity',
  'orders',
  'customers',
  'inventory',
  'analytics',
];

// Catalogue + store config. Needed by every storefront route that shows prices
// or shipping, and by the shell's search/account affordances.
const STOREFRONT = ['products', 'settings'];
// Collections is genuinely required only by the archives route.
const CATALOGUE_ARCHIVE = ['products', 'collections', 'settings'];
// Staff console: every admin screen reads these (endpoint scope = admin token).
const ADMIN_CONSOLE = [
  'products',
  'collections',
  'settings',
  'orders',
  'customers',
  'inventory',
  'analytics',
];
// Customer self-service: the identity is required (Navbar label, saved address).
const ACCOUNT = ['products', 'settings', 'identity'];

const AUTH_SCREENS = ['/login', '/admin/login'];

function normalizePath(pathname) {
  const raw = String(pathname || '/');
  const cut = raw.split('?')[0].split('#')[0];
  if (cut.length > 1 && cut.endsWith('/')) return cut.slice(0, -1);
  return cut || '/';
}

function isAccountRoute(p) {
  return (
    p.startsWith('/account') ||
    p.startsWith('/order-success') ||
    p.startsWith('/order-tracking') ||
    p.startsWith('/order/') || // /order/:orderId/conversation
    p === '/wishlist' ||
    p === '/notifications'
  );
}

/**
 * @param {string} pathname            current route
 * @param {{hasAdminSession?: boolean, hasCustomerSession?: boolean}} session
 * @returns {{route: string, critical: string[], background: string[]}}
 *          `critical` must resolve before this route renders; `background`
 *          hydrates silently afterwards and is never allowed to re-show the
 *          bootstrap gate.
 */
export function dataRequirementsFor(pathname, session = {}) {
  const p = normalizePath(pathname);
  const hasAdmin = !!session.hasAdminSession;
  const hasCustomer = !!session.hasCustomerSession;
  const customer = (slices) => (hasCustomer ? [...slices, 'identity'] : slices);

  // Auth screens need nothing from the store to be correct — the form works
  // offline and reports its own errors. Warm the catalogue behind them so a
  // client-side hop to /shop right after signing in is already paid for.
  // Phase 20.6.2 — the invitation activation screen (/admin/activate/:token)
  // is a PUBLIC auth-class screen: it must render before any store data
  // exists, and never wait on the admin console slices.
  if (AUTH_SCREENS.includes(p) || p === '/admin/activate' || p.startsWith('/admin/activate/')) {
    return {
      route: 'auth',
      critical: [],
      background: customer(['products', 'collections', 'settings']),
    };
  }

  // Staff console. Without a staff session the admin endpoints would 401, so
  // the console only needs the public shell data — AdminRoute sends the user
  // to /admin/login. With a session, the admin-scoped slices are required.
  if (p.startsWith('/admin')) {
    if (!hasAdmin) {
      return { route: 'admin (unauthenticated)', critical: STOREFRONT, background: ['collections'] };
    }
    return { route: 'admin', critical: ADMIN_CONSOLE, background: [] };
  }

  if (p === '/collections') {
    return { route: 'collections', critical: customer(CATALOGUE_ARCHIVE), background: [] };
  }

  // Order confirmation / tracking / account history read their order from the
  // order list as a fallback when the single-order fetch is unavailable.
  if (isAccountRoute(p)) {
    return {
      route: 'account',
      critical: customer([...ACCOUNT, 'orders']),
      background: ['collections'],
    };
  }

  // Checkout: cart + authoritative price/stock come from products, shipping
  // and payment config from settings, and the saved delivery address from the
  // customer identity. It does NOT need the order history.
  if (p.startsWith('/checkout')) {
    return {
      route: 'checkout',
      critical: customer(STOREFRONT),
      background: ['collections', 'orders'],
    };
  }

  // Home: verified to link to /collections without reading the slice.
  if (p === '/') {
    return { route: 'home', critical: customer(STOREFRONT), background: ['collections'] };
  }

  // Shop, Product, Cart, Search, Gift Finder, custom + editorial pages.
  return { route: 'storefront', critical: customer(STOREFRONT), background: ['collections'] };
}
