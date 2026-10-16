/**
 * 3D MEDIA CONTROLLER — 3D Studio (Phase 2).
 *
 * Serves a generated model's private bytes to its OWNER only.
 *
 * Why this is a controller rather than a static mount: the GLB and thumbnail
 * live in a private root, and the only way to read them is this authenticated
 * route, which re-derives the caller's workspace from the session on every
 * request. There is deliberately NO public counterpart — a candidate model is
 * unreviewed working material, and the storefront tier does not exist yet.
 *
 * The response is explicitly `private, no-store`: model bytes are tenant data
 * and must not sit in a shared cache.
 */

import { ApiError } from '../middleware/errorMiddleware.js';
import * as assets from '../services/3dAssetService.js';

/** `/model` and `/thumbnail` in the URL are mapped to the storage kinds here. */
const KIND_BY_URL_SEGMENT = { model: 'glb', thumbnail: 'thumbnail' };

export async function getMediaHandler(req, res, next) {
  try {
    const kind = KIND_BY_URL_SEGMENT[req.params.kind];
    if (!kind) {
      throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
    }

    const { buffer, contentType } = await assets.readPublishedAssetBytes(
      req,
      req.params.productSlug,
      req.params.assetId,
      kind
    );

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    // The bytes are binary; nothing here should be sniffed or framed.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

export default { getMediaHandler };
