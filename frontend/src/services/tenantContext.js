/**
 * Phase 22.5 — client-side TENANT CONTEXT.
 *
 * The active workspace SLUG for browser state (cart, snapshots, caches). This
 * is set by the shop resolver (ShopWorkspaceGate) from the URL, and defaults to
 * `'default'` for the main single-store storefront.
 *
 * IMPORTANT: this is UI/navigation context ONLY. It never authorizes anything —
 * the backend resolves the workspace server-side from the slug (or the single
 * active workspace). A tampered slug here can at most reveal an empty local
 * cart; it can never move data between tenants or change order tenancy.
 */

let current = 'default';
const listeners = new Set();

export function getTenant() {
  return current;
}

export function setTenant(slug) {
  const next = slug ? String(slug).trim().toLowerCase() : 'default';
  if (next === current) return;
  current = next;
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      /* listener errors never break navigation */
    }
  }
}

export function subscribeTenant(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Namespace a browser-state key by the active tenant. */
export function tenantKey(base) {
  return `${base}::${current}`;
}
