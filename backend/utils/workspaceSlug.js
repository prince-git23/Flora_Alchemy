/**
 * Phase 22.4 — workspace (shop) slug authority.
 *
 * A workspace slug is the public URL handle of a shop (`/shops/<slug>`). It
 * is minted SERVER-SIDE only:
 *   · at submission, from the applicant's explicit `preferredSlug` or
 *     deterministically from the business name (`proposedSlug` on the
 *     application);
 *   · at activation, resolved inside the provisioning transaction — the
 *     caller may suggest an alternative (collision retry), but the value is
 *     always re-validated here and uniqueness is enforced by the unique
 *     index on Workspace.slug.
 *
 * Rules enforced:
 *   · format: 2–64 chars, lowercase letters / digits / hyphens, must start
 *     and end alphanumeric (matches models/Workspace.js);
 *   · reserved: never collides with a frontend route or API path, so a shop
 *     can never shadow the platform's own URLs;
 *   · uniqueness: checked against Workspace at submission (fast, friendly
 *     409) and re-checked inside the activation transaction (authoritative).
 */

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/**
 * Frontend route roots + API/platform paths a workspace slug must never
 * shadow. Keep in sync with the top-level `<Route path>` values in
 * frontend/src/App.jsx and the mounted API paths in backend/server.js.
 */
export const RESERVED_WORKSPACE_SLUGS = new Set([
  // Storefront routes (App.jsx)
  'access',
  'account',
  'admin',
  'apply',
  'cart',
  'checkout',
  'collections',
  'custom-gifts',
  'custom-request',
  'gift-finder',
  'how-its-made',
  'login',
  'notifications',
  'order',
  'order-success',
  'order-tracking',
  'our-creations',
  'our-story',
  'owner',
  'product',
  'search',
  'shop',
  'shops',
  'staff',
  'wishlist',
  // Platform / API / static paths (server.js)
  'api',
  'assets',
  'default',
  'favicon',
  'health',
  'robots',
  'sitemap',
  'static',
  'uploads',
]);

/** Deterministic URL slug from a business name. '' when nothing usable. */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** Normalize a caller-provided slug (trim + lowercase). Never invents. */
export function normalizeSlug(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * Validate a candidate slug.
 * @returns {{ok:true, slug:string} | {ok:false, code:string, message:string}}
 */
export function validateWorkspaceSlug(rawSlug) {
  const slug = normalizeSlug(rawSlug);
  if (!slug || !SLUG_RE.test(slug) || slug.length < 2 || slug.length > 64) {
    return {
      ok: false,
      code: 'INVALID_SLUG',
      message:
        'Workspace address must be 2–64 characters using lowercase letters, numbers and hyphens (no leading/trailing hyphen).',
    };
  }
  if (RESERVED_WORKSPACE_SLUGS.has(slug)) {
    return {
      ok: false,
      code: 'INVALID_SLUG',
      message: 'That workspace address is reserved by the platform. Please choose another.',
    };
  }
  return { ok: true, slug };
}
