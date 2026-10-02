/**
 * GRANULAR STAFF ACCESS — route → required permission, for DIRECT navigation.
 *
 * The Staff sidebar already refuses to OFFER a door that answers 403 (it filters
 * each item by the permissions it needs). A direct navigation never passes that
 * filter: a typed address, a deep link from an email, a bookmark or the browser
 * back button all mount the route straight from App.jsx. Without a map here the
 * page mounted anyway, and produced one of two dishonest screens:
 *
 *   · a page that reads a console SLICE (customers, inventory, analytics) saw an
 *     empty array, because routeDataRequirements had deliberately not hydrated a
 *     slice this session may not read — so /staff/customers rendered
 *     "TOTAL CUSTOMERS 0 · No Customers Found", a business claim that was false;
 *   · a page that fetches its own data fired a request it must not make and then
 *     printed a 403 error frame INSIDE a page it should never have mounted.
 *
 * This module states, per staff route, the permission the SERVER requires for
 * that resource — mirrored from backend/routes/*.js (requirePermission) and from
 * the sidebar's own `any` lists. The gate (StaffRoute) uses it to render the
 * honest access state BEFORE the page mounts, so no request is made and no empty
 * business state is shown.
 *
 * HIDDEN UI IS NOT SECURITY. The backend re-reads the account from the database
 * on every gated request and returns 403 PERMISSION_DENIED regardless of what
 * this map, the sidebar or a forged client believes. This only stops the app
 * from stating something untrue.
 *
 * Order matters: the MORE SPECIFIC path must be tested first
 * (`/staff/inventory/history` needs inventory.movement.view, not inventory.view).
 */

const RULES = [
  // The staff login is a PUBLIC auth-class screen — it renders before any
  // session exists and must never be gated by a permission.
  { match: /^\/staff\/login$/, label: null, any: [] },

  // OVERVIEW — the dashboard is the landing screen for every staff session and
  // needs no console slice; it reports its own per-counter permission states.
  { match: /^\/staff(\/dashboard)?$/, label: null, any: [] },

  // Action Center — assembled from orders, custom requests, stock and
  // conversations, so at least ONE of those reads is enough (same rule as the
  // sidebar and backend/utils/operationalActions.js).
  {
    match: /^\/staff\/work$/,
    label: 'Action Center',
    any: ['orders.view', 'requests.view', 'inventory.view', 'conversations.view'],
  },

  // OPERATIONS
  { match: /^\/staff\/orders\/new$/, label: 'Orders', any: ['orders.create'] },
  // An order's conversation thread is reachable from Orders AND from
  // Conversations — either read permission grants the screen.
  {
    match: /^\/staff\/orders\/[^/]+\/conversation$/,
    label: 'Conversations',
    any: ['conversations.view', 'orders.view'],
  },
  { match: /^\/staff\/orders(\/.*)?$/, label: 'Orders', any: ['orders.view'] },
  { match: /^\/staff\/products\/new$/, label: 'Products', any: ['products.create'] },
  { match: /^\/staff\/products(\/.*)?$/, label: 'Products', any: ['products.view'] },
  { match: /^\/staff\/collections(\/.*)?$/, label: 'Collections', any: ['collections.view'] },
  {
    match: /^\/staff\/inventory\/history$/,
    label: 'Inventory History',
    any: ['inventory.movement.view'],
  },
  {
    match: /^\/staff\/inventory(\/.*)?$/,
    label: 'Inventory',
    any: ['inventory.view', 'inventory.movement.view'],
  },

  // CUSTOMER SERVICE
  { match: /^\/staff\/customers(\/.*)?$/, label: 'Customers', any: ['customers.view'] },
  { match: /^\/staff\/conversations(\/.*)?$/, label: 'Conversations', any: ['conversations.view'] },
  { match: /^\/staff\/custom-requests(\/.*)?$/, label: 'Custom Requests', any: ['requests.view'] },

  // INSIGHTS
  { match: /^\/staff\/analytics(\/.*)?$/, label: 'Analytics', any: ['analytics.view'] },
  { match: /^\/staff\/notifications$/, label: 'Notifications', any: ['notifications.view'] },
];

/** Route paths this map claims to cover — used by the smoke suite. */
export const STAFF_ROUTE_RULES = RULES;

/**
 * Which permission(s) does this staff route need?
 *
 * @param {string} pathname
 * @returns {{label: string|null, any: string[]}|null}
 *          null when the route is ungated (dashboard) or unknown — an unknown
 *          route must NOT be blocked here, because the server is the authority
 *          and a 404 page is a truer answer than a fabricated access refusal.
 */
export function requiredStaffPermissions(pathname) {
  const raw = String(pathname || '/');
  const path = raw.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  const normalized = path === '/' ? '/' : path;
  for (const rule of RULES) {
    if (rule.match.test(normalized)) {
      return { label: rule.label, any: rule.any };
    }
  }
  return null;
}
