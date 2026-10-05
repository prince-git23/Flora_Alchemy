import Product from '../models/Product.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import {
  activeShopBySlug,
  activeShopForId,
  anyWorkspaceExists,
  singleActiveShop,
} from '../utils/publicShop.js';

/**
 * PHASE 3 — ONE ORDER, ONE WORKSPACE.
 *
 * A customer bag may contain products from several shops, but a single
 * checkout may only ever contain ONE shop's products. This resolver is the
 * single place where an order's authoritative workspace is decided — and it is
 * decided from STORED data, never from the client:
 *
 *   1. every catalogue `productSlug` resolves to its Product row, and the
 *      Product's `workspaceId` (when present) is the item's owner;
 *   2. every owning workspace must be an ACTIVE shop (a suspended shop cannot
 *      receive a new order at all);
 *   3. if the items resolve to more than one workspace → `409
 *      MIXED_WORKSPACE_ORDER`, before anything is created;
 *   4. a client `shopSlug` is only ever a LOOKUP/confirmation key: when the
 *      items have an authoritative owner the slug must MATCH it (`409
 *      SHOP_MISMATCH` otherwise), and it can never move a product to another
 *      shop;
 *   5. a staff-created order must satisfy the caller's own membership — the
 *      products must belong to the staff member's workspace, and the order is
 *      attributed to that workspace, never to a body/tenant input;
 *   6. bespoke lines (a Custom Gift Studio gift, a storefront add-on) have no
 *      product of their own, so they inherit the one workspace the catalogue
 *      lines establish; a gift-only order resolves an explicit ACTIVE slug, or
 *      the single live shop when that is unambiguous;
 *   7. legacy-unscoped rows (a Product that predates attribution) keep the
 *      documented single-store compatibility path: with exactly one ACTIVE
 *      shop the order is attributed to it; with several and no explicit slug
 *      the customer is asked to choose (`422 SHOP_REQUIRED`); a deployment
 *      that has never been onboarded (zero Workspace documents) keeps the
 *      historical unattributed behaviour.
 *
 * The return value is `{ workspaceId, shop }` where `shop` is the canonical
 * `{ slug, displayName }` identity (or null for the zero-workspace,
 * legacy-unscoped case). `workspaceId` is what `createOrder` stamps on the
 * order document — client-supplied `workspaceId` is scrubbed globally in
 * server.js and is never read here.
 */
export async function resolveOrderDestination({
  items,
  shopSlug = '',
  staffWorkspaceId = null,
  requireOrderable = false,
} = {}) {
  const slug = String(shopSlug || '').trim().toLowerCase();
  const list = Array.isArray(items) ? items : [];

  // Resolve every catalogue line in ONE read. Slugs are globally unique, so a
  // slug identifies exactly one row regardless of owner; the workspace comes
  // from that row, never from the caller.
  const slugs = [
    ...new Set(
      list
        .filter((i) => i && i.productSlug)
        .map((i) => String(i.productSlug).trim())
        .filter(Boolean)
    ),
  ];
  const products = slugs.length
    ? await Product.find({ slug: { $in: slugs } })
        .select('slug name visibility workspaceId')
        .lean()
    : [];
  const bySlug = new Map(products.map((p) => [p.slug, p]));

  // workspaceId → shop identity, for the workspaces the items actually own.
  const owners = new Map();
  for (const item of list) {
    if (!item || !item.productSlug) continue;
    const product = bySlug.get(String(item.productSlug).trim());
    if (!product) {
      throw new ApiError(
        422,
        `"${item.name || item.productSlug}" is no longer available. Please remove it from your bag to continue.`,
        'PRODUCT_NOT_FOUND'
      );
    }
    if (requireOrderable && product.visibility && product.visibility !== 'Visible') {
      // A hidden catalogue row is not orderable by a customer (staff keep the
      // operational path: an explicit staff order may include it).
      throw new ApiError(
        422,
        `"${product.name || product.slug}" is not available for ordering right now. Please remove it from your bag to continue.`,
        'PRODUCT_NOT_FOUND'
      );
    }
    if (product.workspaceId) {
      // Live ACTIVE-shop resolution: a suspended/pending/deleted shop cannot
      // receive a new order, and its products leave public discovery.
      const owner = await activeShopForId(product.workspaceId);
      if (!owner) {
        throw new ApiError(
          422,
          `"${product.name || product.slug}" is no longer available — its shop is not accepting orders right now.`,
          'SHOP_NOT_FOUND'
        );
      }
      owners.set(String(product.workspaceId), { workspaceId: product.workspaceId, shop: owner });
    }
  }

  if (owners.size > 1) {
    // ONE SHOP PER CHECKOUT — nothing is created; the customer chooses a shop.
    throw new ApiError(
      409,
      'Your bag contains items from more than one shop. Please check out one shop at a time.',
      'MIXED_WORKSPACE_ORDER'
    );
  }

  const authoritative = owners.size === 1 ? [...owners.values()][0] : null;

  // ── Staff-created orders ─────────────────────────────────────────────
  // The caller's membership (re-read from the DB by protect + the workspace
  // gate) is the authority: the products must belong to the SAME workspace,
  // so a staff member of shop A can never place shop B's product into an A
  // order (and vice versa).
  if (staffWorkspaceId) {
    if (authoritative && String(authoritative.workspaceId) !== String(staffWorkspaceId)) {
      throw new ApiError(
        403,
        'Those products belong to another shop — a staff order can only contain products of its own shop.',
        'FORBIDDEN'
      );
    }
    if (slug && authoritative && slug !== authoritative.shop.slug) {
      throw new ApiError(
        409,
        'This order is fulfilled by a different shop — it cannot be moved to another one.',
        'SHOP_MISMATCH'
      );
    }
    const shop = authoritative ? authoritative.shop : await activeShopForId(staffWorkspaceId);
    return { workspaceId: staffWorkspaceId, shop };
  }

  // ── Customer orders ──────────────────────────────────────────────────
  if (authoritative) {
    if (slug && slug !== authoritative.shop.slug) {
      throw new ApiError(
        409,
        'This order is fulfilled by a different shop — it cannot be moved to another one.',
        'SHOP_MISMATCH'
      );
    }
    return { workspaceId: authoritative.workspaceId, shop: authoritative.shop };
  }

  // No catalogue item carries an authoritative owner (bespoke lines only, or
  // legacy-unscoped products). An explicit ACTIVE slug is honoured; it names
  // the shop that will fulfil the order.
  if (slug) {
    const resolved = await activeShopBySlug(slug);
    if (!resolved) {
      throw new ApiError(422, 'This shop is not available for orders right now.', 'SHOP_NOT_FOUND');
    }
    return { workspaceId: resolved.workspaceId, shop: resolved.shop };
  }

  // No slug: only the single-live-shop case is unambiguous enough to guess.
  const only = await singleActiveShop();
  if (only) return { workspaceId: only.workspaceId, shop: only.shop };
  if (await anyWorkspaceExists()) {
    throw new ApiError(
      422,
      'Please choose the shop that should fulfil this order.',
      'SHOP_REQUIRED'
    );
  }

  // Zero workspaces: a deployment that has never been onboarded keeps the
  // historical unattributed order (single-store compatibility).
  return { workspaceId: null, shop: null };
}
