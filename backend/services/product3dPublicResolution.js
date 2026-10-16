/**
 * PUBLIC 3D ASSET RESOLUTION — Phase 3 — the SAFE storefront projection of an
 * approved product model.
 *
 * This module is the ONLY place the storefront learns that a product has a 3D
 * model: it consults the existing Phase 2 `findApproved` query (which is
 * workspace-scoped and approval-gated) and returns a deliberately narrow,
 * customer-safe projection.
 *
 * WHAT A CUSTOMER MAY SEE
 *   · that the product HAS an approved 3D model
 *   · the public delivery URL for that model's GLB + its thumbnail
 *   · the model's version, provider name and validation summary
 *
 * WHAT A CUSTOMER MUST NEVER SEE (even when a product has no model)
 *   · any candidate, rejected, failed or deprecated asset
 *   · generation-job records, source reference ids, provider task ids
 *   · provider credentials, local storage keys, workspace ids, admin ids
 *   · the full asset history, the approval trail, or `_id`/`__v`
 *
 * Public projection is intentionally DIFFERENT from the staff projection in
 * `models/Product3DAsset.js` (`publicAssetProjection`): the staff projection
 * keeps the decision trail (approvedBy/approvedAt/rejectedBy/rejectedAt/
 * rejectionReason/replacedBy/replacedAt) because administrators need it; the
 * public projection strips it entirely because customers do not.
 *
 * The delivery URL is built HERE rather than imported from the route module, so
 * the dependency direction stays service → util → nothing: a route that imports
 * this resolver must never be imported back by it.
 */

import { cached, cacheInvalidate3dDelivery } from '../utils/publicCache.js';
import { findApprovedInWorkspace } from './3dAssetService.js';
import { PUBLIC_ASSET_KINDS, isApprovedModelServable } from '../models/Product3DAsset.js';

/**
 * The public delivery path for one approved asset file.
 *
 * `kind` is a PUBLIC kind ('glb' | 'thumbnail'), never a storage key: the
 * controller that answers this path re-resolves the product and the approved
 * asset server-side, so the URL carries no authority of its own.
 *
 * Returns null for an unusable input rather than a URL that could only 404.
 */
export function assetDeliveryUrl(productSlug, assetId, kind) {
  if (!PUBLIC_ASSET_KINDS.includes(kind)) return null;
  if (!productSlug || !assetId) return null;
  return `/api/3d/products/${encodeURIComponent(String(productSlug))}/model/${encodeURIComponent(String(assetId))}/${kind}`;
}

/**
 * Resolve the public 3D projection for a product, or null when the product has
 * no approved model worth showing.
 *
 * `workspaceId` is the PRODUCT's own workspace, not the caller's: a storefront
 * visitor has no workspace, and the model a customer may see is the one that
 * belongs to the product in front of them. Passing the product's membership is
 * therefore both sufficient and correct, and it is why a second workspace's
 * approved row naming the same slug can never be projected here.
 *
 * Returns null (never throws) so a catalogue detail read keeps its own 404
 * semantics even when 3D resolution has nothing to show.
 */
export async function publicProduct3d(productSlug, { workspaceId = null } = {}) {
  if (!productSlug) return null;

  // A positive result is cached for the SAME short TTL as every other public
  // read (30s) so a popular product does not re-query on every page view. It is
  // a metadata-only cache: the bytes are resolved live by the delivery
  // controller, which re-checks approval, the product's visibility and the file
  // on every single request. A miss (no approved model) is never cached, so
  // publishing the first model is visible immediately.
  const key = `3d:model:${productSlug}`;
  return cached(key, () => resolvePublic3d(productSlug, workspaceId), null).catch(() => null);
}

/** The uncached resolution: approved + in the product's workspace → projection. */
async function resolvePublic3d(productSlug, workspaceId) {
  let approved = null;
  try {
    approved = await findApprovedInWorkspace(productSlug, workspaceId);
  } catch {
    // A 3D lookup failure must never take down the product detail read.
    return null;
  }
  if (!approved) return null;

  // Application-level belt on top of the query's status filter: a servable
  // model must have real validated bytes recorded on the row.
  if (!isApprovedModelServable(approved)) return null;

  const glbUrl = assetDeliveryUrl(approved.productSlug, approved.id, 'glb');
  if (!glbUrl) return null;
  const thumbUrl = approved.storage?.thumbnail?.storageKey
    ? assetDeliveryUrl(approved.productSlug, approved.id, 'thumbnail')
    : null;

  return {
    id: approved.id,
    version: approved.version || 1,
    provider: publicProviderName(approved),
    hasModel: true,
    // Customer-visible size is the GLB byte count (already validated and stored
    // by Phase 2), never the raw storage key.
    bytes: approved.storage?.glb?.bytes || 0,
    thumbnail: thumbUrl,
    delivery: {
      glb: glbUrl,
    },
    validation: {
      ok: true,
      gltfVersion: approved.validation?.gltfVersion || 0,
      meshes: approved.validation?.meshes || 0,
      materials: approved.validation?.materials || 0,
      textures: approved.validation?.textures || 0,
    },
    settings: {
      quality: approved.settings?.quality || 'standard',
    },
  };
}

/**
 * A customer does not need provider MODEL/OS/version strings and must not see a
 * blank provider label. Keep the public readout to a single human-friendly name.
 */
function publicProviderName(asset) {
  const fromModel = asset.providerModel && asset.providerModel.trim();
  if (fromModel) return fromModel;
  const fromProvider = asset.provider && asset.provider.trim();
  if (fromProvider) return fromProvider;
  return 'Generated model';
}

/** Re-exported so write paths can drop a stale projection in the same breath. */
export { cacheInvalidate3dDelivery };
