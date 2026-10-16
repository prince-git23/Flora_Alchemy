/**
 * product3dService — PHASE 3 — the STOREFRONT's client for an approved product
 * model.
 *
 * Deliberately separate from `threeGlbService.js`, which is the ADMIN studio's
 * client: that one attaches an admin bearer token and addresses the private
 * `/api/3d/media/...` route for candidates and history. This one talks only to
 * the public storefront surface and never sends a credential:
 *
 *   · `getProduct3d(slug)`             → `{ product3d } | null`  (metadata only,
 *                                        a few hundred bytes; this is what the
 *                                        gallery uses to decide whether to offer
 *                                        a 3D View button)
 *   · `loadPublicModelObjectUrl(path)` → the GLB bytes as an object URL, fetched
 *                                        ONLY when the customer opens 3D View
 *
 * WHY A BARE `fetch` FOR THE BYTES. `apiClient`'s JSON helper always parses JSON
 * and attaches whatever session token it is told to; model bytes are binary and
 * public, so they are fetched here as a blob with `credentials: 'omit'` and
 * handed to three.js' GLTFLoader as an object URL (which is also the only way to
 * give the loader a local URL it can read). No component calls `fetch` itself.
 *
 * NOTHING IS PREFETCHED OR CACHED IN MEMORY. A GLB is tens of megabytes; a
 * cached object URL pointing at a model that has since been replaced is exactly
 * the mix-up the Phase 2 asset life cycle exists to prevent. The caller owns the
 * returned `revoke` and the viewer calls it on unmount.
 */

import api, { API_BASE_URL } from './apiClient.js';

/**
 * Turn the API-relative delivery path the server returned (`/api/3d/...`) into
 * an absolute URL for this deployment, without hardcoding an origin: the path is
 * resolved against the SAME base URL every other request uses, so a build
 * pointed at a different API cannot fetch the model from the wrong place.
 */
export function publicAssetUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  try {
    return new URL(path, API_BASE_URL).href;
  } catch {
    return path;
  }
}

/**
 * Whether a product has an approved 3D model, and where to get it.
 *
 * The read is ANONYMOUS on purpose (`scope: null`): it is a public storefront
 * read, and a signed-in staff browser must not turn it into a permission-
 * checked call that could 403 for a handler whose role lacks `products.view`
 * even though the product page itself is public.
 *
 * A failure is not an error state for the page: an unreachable 3D service means
 * "no 3D button", exactly like a product that has no model. The gallery is the
 * product's primary experience, and it must never depend on this.
 */
export async function getProduct3d(productSlug) {
  if (!productSlug) return null;
  const res = await api.get(`/3d/products/${encodeURIComponent(productSlug)}/public`, { scope: null });
  if (!res.ok) return null;
  const projection = res.data?.product3d;
  if (!projection || projection.hasModel !== true || !projection.delivery?.glb) return null;
  return projection;
}

/** True when a projection really can be opened in the viewer. */
export function hasPlayableModel(projection) {
  return Boolean(projection && projection.hasModel === true && projection.delivery?.glb);
}

/**
 * Fetch an approved model's GLB and return `{ url, bytes, revoke }`.
 *
 * The returned object URL MUST be revoked by the caller — the viewer does it on
 * unmount and on every re-load, so a customer browsing ten products does not
 * leak ten multi-megabyte blobs.
 */
export async function loadPublicModelObjectUrl(deliveryPath) {
  const requestUrl = publicAssetUrl(deliveryPath);
  if (!requestUrl) {
    const err = new Error('This product has no 3D model to show.');
    err.code = 'NO_MODEL';
    throw err;
  }

  let res;
  try {
    res = await fetch(requestUrl, { credentials: 'omit' });
  } catch {
    const err = new Error('The 3D model could not be reached. Check your connection and try again.');
    err.code = 'NETWORK';
    throw err;
  }

  if (!res.ok) {
    const err = new Error(
      res.status === 404
        ? 'This 3D model is no longer available for this product.'
        : `The 3D model could not be loaded (${res.status}).`
    );
    err.status = res.status;
    err.code = res.status === 404 ? 'MODEL_GONE' : 'MODEL_FAILED';
    throw err;
  }

  const blob = await res.blob();
  if (!blob || blob.size === 0) {
    const err = new Error('The 3D model file was empty.');
    err.code = 'MODEL_EMPTY';
    throw err;
  }

  // The OBJECT URL is what the caller must revoke — revoking the request URL
  // (or nothing at all) is the classic way to keep a 20 MB blob alive for the
  // lifetime of the tab.
  const objectUrl = URL.createObjectURL(blob);
  return {
    url: objectUrl,
    bytes: blob.size,
    revoke: () => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* already revoked */
      }
    },
  };
}

export default { getProduct3d, publicAssetUrl, loadPublicModelObjectUrl, hasPlayableModel };
