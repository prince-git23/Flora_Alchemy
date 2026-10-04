/**
 * PHASE 1 (marketplace identity) — the ONE canonical public Shop contract.
 *
 * A Shop is the customer-facing representation of a Workspace (the internal
 * tenant). Every public surface that answers "which shop does this belong to?"
 * must answer with the SAME shape:
 *
 *     shop = { slug, displayName }
 *
 * and nothing else. The internal tenant identifier (`workspaceId`) is never
 * part of a public payload; neither is `primaryAdminId`, `isBootstrap`,
 * membership, staff or owner data.
 *
 * `status` is deliberately NOT part of the contract: a non-ACTIVE workspace is
 * not a discoverable shop at all, so it resolves to `null` (excluded from the
 * catalogue, 404 on direct lookup) rather than to a shop with a status flag.
 *
 * This module exists so no controller invents its own projection: products,
 * collections, the shop directory and the wishlist all call these helpers.
 */
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';

/** The public projection of a Workspace. `null` when there is nothing to show. */
export function publicShopIdentity(workspace) {
  if (!workspace || !workspace.slug) return null;
  return {
    slug: workspace.slug,
    displayName: workspace.displayName || workspace.slug,
  };
}

/**
 * Resolve a Map<workspaceIdString, shop> for the ACTIVE workspaces among the
 * given ids. Suspended, missing and PENDING workspaces are absent from the map
 * — callers then exclude the owning product/collection or answer 404.
 *
 * Runs LIVE on every read (never cached), so a suspension takes effect on the
 * very next request; the write-side cache invalidation is a second belt.
 */
export async function activeShopMap(workspaceIds) {
  const ids = [...new Set((workspaceIds || []).map((v) => (v ? String(v) : '')).filter((v) => v && mongoose.isValidObjectId(v)))];
  if (ids.length === 0) return new Map();
  const rows = await Workspace.find({ _id: { $in: ids }, status: 'ACTIVE' })
    .select('slug displayName')
    .lean();
  return new Map(rows.map((w) => [String(w._id), publicShopIdentity(w)]));
}

/** Convenience for a single document read: the shop, or null. */
export async function activeShopForId(workspaceId) {
  if (!workspaceId) return null;
  const map = await activeShopMap([workspaceId]);
  return map.get(String(workspaceId)) || null;
}

/**
 * Is this catalogue row publicly discoverable?
 *
 *   · no workspace at all (single-workspace compatibility / pre-migration) → yes
 *   · workspace resolves to an ACTIVE shop                               → yes
 *   · workspace suspended, PENDING or deleted                            → NO
 *
 * Orphaned rows (a workspace that no longer exists) are therefore excluded
 * from public discovery and 404 on direct lookup — a shop is never fabricated.
 */
export function isPubliclyDiscoverable(doc, shopMap) {
  const workspaceId = doc && doc.workspaceId;
  if (!workspaceId) return true;
  return shopMap.has(String(workspaceId));
}

/**
 * Canonical public PRODUCT payload: the row with the internal tenant id
 * removed and the shop attribution attached. Works for lean documents,
 * serialized cache rows and Mongoose documents alike — every other field is
 * passed through untouched.
 */
export function publicProduct(product, shop = null) {
  if (!product) return product;
  const out = typeof product.toObject === 'function' ? product.toObject() : { ...product };
  delete out.workspaceId;
  out.shop = shop || null;
  return out;
}

/** Canonical public COLLECTION payload — same rules as a product. */
export function publicCollection(collection, shop = null) {
  if (!collection) return collection;
  const out = typeof collection.toObject === 'function' ? collection.toObject() : { ...collection };
  delete out.workspaceId;
  out.shop = shop || null;
  return out;
}