/**
 * 3D STUDIO — Phase 1 — HTTP boundary for prepared product reference images.
 *
 * Thin by design: everything that decides anything (validation, processing,
 * tenancy, storage) lives in services/referenceImageService.js. This file does
 * the three things a controller is allowed to do here:
 *
 *   1. shape the request into the service's argument list;
 *   2. FAIL CLOSED on malformed input (a crop that is not four numbers inside
 *      the frame is refused, never coerced);
 *   3. present the result — with one deliberate omission, below.
 *
 * WHAT IS NEVER RETURNED
 * ----------------------
 * `storageKey` (the path inside the private reference store) is stripped from
 * every response. It is not a credential, but it is also not the client's
 * business: publishing it would leak the on-disk layout and invite clients to
 * treat it as a URL. What the client gets instead is `available` plus the
 * authenticated API path that serves the bytes, so the only way to read a
 * reference image stays a workspace-checked request.
 *
 * `workspaceId` and `createdBy` are dropped for the same reason the rest of the
 * codebase keeps internal ids out of payloads: the caller's workspace is
 * already implied by the fact that the request succeeded, so returning it adds
 * no capability — only another place for a tenant identifier to leak.
 *
 * AUTHORIZATION is not re-implemented here: the route carries
 * protect + adminOrHandler + requireWorkspace + requirePermission, and the
 * service filters every query by the workspace `protect` resolved from the
 * DATABASE. A reference id from another workspace therefore answers 404.
 */

import { ApiError } from '../middleware/errorMiddleware.js';
import {
  assetPresence,
  attachReferencesToProduct,
  cleanupAbandoned,
  createReferenceImage,
  getReferenceImage,
  listReferenceImages,
  readReferenceAsset,
  removeReferenceImage,
  reorderReferenceImages,
  reprocessReferenceImage,
  updateReferenceImage,
} from '../services/referenceImageService.js';
import { describeEngine } from '../services/bgRemoval/index.js';
import { getWorkspaceId } from '../utils/tenancy.js';
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';

/** The API path that serves one asset of one reference image. */
function assetPath(imageId, kind) {
  return `/references/${imageId}/file/${kind}`;
}

/**
 * Strip the storage key and describe an asset by what the client can do with
 * it.
 *
 * `registered` (a storage key exists) and `available` (the BYTES exist) are two
 * different facts, and conflating them is how a row whose file had been erased
 * still advertised a readable asset. `exists` comes from the service's
 * filesystem check; `missing: true` is the honest report of "the record says
 * there is a file and there is not" — the client shows it as a lost file, never
 * as "not generated yet".
 */
function assetView(imageId, kind, asset, exists) {
  const registered = Boolean(asset && asset.storageKey);
  const present = registered && exists !== false;
  return {
    available: present,
    registered,
    missing: registered && exists === false,
    bytes: registered ? asset.bytes || 0 : 0,
    width: asset?.width || 0,
    height: asset?.height || 0,
    hasAlpha: kind === 'cutout' ? present : Boolean(asset?.hasAlpha),
    format: asset?.format || (kind === 'original' ? '' : 'png'),
    fileName: asset?.fileName || '',
    sha256: asset?.sha256 || '',
    url: present ? assetPath(imageId, kind) : null,
  };
}

/** One image, as the studio UI consumes it. `presence` is optional: when it is
 *  omitted the asset's own metadata is reported (used by paths that just wrote
 *  or read the row in this request). */
function presentImage(image, presence = null) {
  const out = typeof image?.toJSON === 'function' ? image.toJSON() : { ...(image || {}) };
  const id = out.id || String(image?._id || '');
  const exists = presence?.exists || {};
  delete out.workspaceId;
  delete out.createdBy;
  return {
    ...out,
    original: assetView(id, 'original', image.original || out.original, exists.original),
    cutout: assetView(id, 'cutout', image.cutout || out.cutout, exists.cutout),
    neutral: assetView(id, 'neutral', image.neutral || out.neutral, exists.neutral),
  };
}

/**
 * Present a whole list. Existence is checked per image (three keys at most, in
 * parallel) so the studio can distinguish "not generated yet" from "the file
 * is gone" — the difference decides whether the administrator retries
 * processing or re-uploads the photograph.
 */
async function presentList(payload) {
  const images = await Promise.all(
    (payload.images || []).map(async (image) => presentImage(image, await assetPresence(image)))
  );
  return {
    images,
    setWarnings: payload.setWarnings || [],
    setNotes: payload.setNotes || [],
  };
}

/**
 * A crop is normalized 0..1 of the ORIGINAL frame. Anything else is refused:
 * silently clamping a nonsense crop would produce a cutout the administrator
 * did not ask for and cannot explain.
 */
function parseCrop(raw) {
  if (raw === undefined) return { present: false, value: undefined };
  if (raw === null || raw === '') return { present: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(422, 'A crop must be { x, y, width, height }.', 'VALIDATION_ERROR');
  }
  const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(raw[key]));
  if (numbers.some((n) => !Number.isFinite(n))) {
    throw new ApiError(422, 'A crop must be four numbers.', 'VALIDATION_ERROR');
  }
  const [x, y, width, height] = numbers;
  const EPS = 0.001;
  if (x < 0 || y < 0 || width <= 0 || height <= 0) {
    throw new ApiError(422, 'A crop must start inside the frame and have a positive size.', 'VALIDATION_ERROR');
  }
  if (x + width > 1 + EPS || y + height > 1 + EPS) {
    throw new ApiError(422, 'The crop must stay inside the image.', 'VALIDATION_ERROR');
  }
  return { present: true, value: { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) } };
}

/** POST /api/references — upload one original and start real processing. */
export async function uploadReferenceImage(req, res, next) {
  try {
    const body = req.body || {};
    const { doc, uploadedNotes, duplicateOf } = await createReferenceImage(req, {
      file: req.file,
      productSlug: body.productSlug ? String(body.productSlug).slice(0, 200) : '',
      draftKey: body.draftKey ? String(body.draftKey).slice(0, 120) : '',
      label: body.label ? String(body.label).slice(0, 120) : '',
    });
    // The original was just written by this request, so its bytes exist by
    // construction; the check is still performed so the response shape is
    // identical to every other read of the same row.
    const image = presentImage(doc, await assetPresence(doc));
    res.status(201).json({
      success: true,
      image,
      // A duplicate is NOT an error: the administrator may legitimately upload
      // the same photograph twice by accident, and saying so is more useful than
      // refusing. The row still exists and can be removed.
      duplicateOf: duplicateOf || null,
      setWarnings: (doc.warnings || []).filter(Boolean),
      setNotes: (uploadedNotes || []).filter(Boolean),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/references?productSlug=… | ?draftKey=… | ?ids=a,b,c
 * The `ids` form exists for the product EDIT page: it already knows which
 * references belong to the product and needs their current state in one call.
 */
export async function listReferenceImagesHandler(req, res, next) {
  try {
    const { productSlug, draftKey, ids } = req.query || {};
    const payload = await listReferenceImages(req, {
      productSlug: productSlug ? String(productSlug) : '',
      draftKey: draftKey ? String(draftKey) : '',
      ids: ids ? String(ids).split(',').map((s) => s.trim()).filter(Boolean) : null,
    });
    res.json({ success: true, ...(await presentList(payload)) });
  } catch (err) {
    next(err);
  }
}

/** GET /api/references/:id */
export async function getReferenceImageHandler(req, res, next) {
  try {
    const image = await getReferenceImage(req, req.params.id);
    res.json({ success: true, image: presentImage(image, await assetPresence(image)) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/references/:id/file/:kind — the ONLY way to read the bytes.
 *
 * `private, no-store`: these are unreviewed working assets, so no shared cache
 * and no browser cache retention. The response is a stream of the file the
 * service resolved inside the caller's workspace.
 */
export async function getReferenceAssetHandler(req, res, next) {
  try {
    const { buffer, contentType, fileName } = await readReferenceAsset(req, req.params.id, req.params.kind);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buffer);
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/references/:id — label, acceptance, primary flag, crop. */
export async function updateReferenceImageHandler(req, res, next) {
  try {
    const body = req.body || {};
    const patch = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.accepted !== undefined) patch.accepted = Boolean(body.accepted);
    if (body.isPrimary !== undefined) patch.isPrimary = Boolean(body.isPrimary);
    const crop = parseCrop(body.crop);
    if (crop.present) patch.crop = crop.value;
    const image = await updateReferenceImage(req, req.params.id, patch);
    res.json({ success: true, image: presentImage(image, await assetPresence(image)) });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/references/order — the drag result, applied atomically-in-order. */
export async function reorderReferenceImagesHandler(req, res, next) {
  try {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) {
      throw new ApiError(422, 'ids must be an ordered array of reference ids.', 'VALIDATION_ERROR');
    }
    const payload = await reorderReferenceImages(req, ids.map(String));
    res.json({ success: true, ...(await presentList(payload)) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/references/:id/reprocess — retry (optionally with a new crop). */
export async function reprocessReferenceImageHandler(req, res, next) {
  try {
    const crop = parseCrop((req.body || {}).crop);
    const image = await reprocessReferenceImage(req, req.params.id, crop.present ? { crop: crop.value } : {});
    res.json({ success: true, image: presentImage(image, await assetPresence(image)) });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/references/:id */
export async function deleteReferenceImageHandler(req, res, next) {
  try {
    const result = await removeReferenceImage(req, req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/references/attach — hand a product's accepted references to the
 * product being saved. Called by the studio right after a create/update so the
 * edit page can find them again; the service refuses any id outside the
 * caller's workspace.
 */
export async function attachReferenceImagesHandler(req, res, next) {
  try {
    const body = req.body || {};
    if (!body.productSlug) {
      throw new ApiError(422, 'A product slug is required.', 'VALIDATION_ERROR');
    }
    const result = await attachReferencesToProduct(req, {
      productSlug: String(body.productSlug),
      productId: body.productId || null,
      ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
      draftKey: body.draftKey ? String(body.draftKey) : '',
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/references/engine — which background-removal engine this server will
 * actually use, and why. The studio shows it so an administrator can tell
 * "the built-in engine ran" from "the ML model ran" without reading logs.
 */
export async function engineInfoHandler(_req, res, next) {
  try {
    const engine = await describeEngine();
    res.json({ success: true, engine });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/references/cleanup — internal maintenance (owner-only; the route
 * carries `protect` + `requireOwner`). Deletes references that were never
 * attached to a product and are older than the given age.
 *
 * THREE SAFETY GATES, because this deletes bytes as well as rows:
 *
 *   1. SCOPE. The default scope is the caller's OWN workspace, taken from the
 *      session (`getWorkspaceId(req.user)`) — never from the body, so a client
 *      cannot point the sweep at another tenant. A platform-wide sweep requires
 *      `allWorkspaces: true`.
 *   2. CONFIRMATION. Because the route is owner-only, `allWorkspaces` is
 *      additionally gated on the explicit `confirmAllWorkspaces: true` field:
 *      a maintenance call that happens to set one flag must not silently sweep
 *      every tenant.
 *   3. DRY RUN BY DEFAULT. `dryRun` defaults to TRUE, so the same call is a
 *      preview unless the caller asks to delete. The response always states the
 *      scope that was used, so the log and the caller agree on what happened.
 */
export async function cleanupReferencesHandler(req, res, next) {
  try {
    const body = req.body || {};
    const hours = Number(body.olderThanHours ?? 24);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
      throw new ApiError(422, 'olderThanHours must be between 1 and 720.', 'VALIDATION_ERROR');
    }

    const allWorkspaces = body.allWorkspaces === true;
    if (allWorkspaces) {
      if (!req.user?.isOwner) {
        throw new ApiError(
          403,
          'A platform-wide cleanup is available to the platform owner only.',
          'OWNER_REQUIRED'
        );
      }
      if (body.confirmAllWorkspaces !== true) {
        throw new ApiError(
          422,
          'A platform-wide cleanup removes working material across every workspace. Repeat the call with confirmAllWorkspaces: true to confirm.',
          'CONFIRMATION_REQUIRED'
        );
      }
    }

    // The SCOPE. Default: the caller's own workspace, taken from the session.
    //
    // An owner may additionally name ONE workspace — by its PUBLIC SLUG, not by
    // id. That is deliberate: `stripClientWorkspaceId` scrubs `workspaceId`
    // from every body and query BEFORE any controller runs (Phase 22.2), and
    // that rule is not going to be relaxed for a maintenance endpoint. A slug
    // cannot establish tenancy either (it only SELECTS a target this owner is
    // already entitled to act on, and it is validated against the DB), so the
    // anti-smuggling guarantee is untouched. The platform-wide sweep remains a
    // separate, explicitly confirmed request.
    let targetWorkspaceId = getWorkspaceId(req.user);
    const requestedSlug = body.workspaceSlug ? String(body.workspaceSlug).trim() : '';
    if (!allWorkspaces && requestedSlug) {
      if (!req.user?.isOwner) {
        throw new ApiError(
          403,
          'Only the platform owner may target another workspace.',
          'OWNER_REQUIRED'
        );
      }
      const workspace = await Workspace.findOne({ slug: requestedSlug }).select('_id').lean();
      if (!workspace) {
        throw new ApiError(404, 'That workspace does not exist.', 'WORKSPACE_NOT_FOUND');
      }
      targetWorkspaceId = new mongoose.Types.ObjectId(workspace._id);
    }

    // `dryRun` defaults to true: leaving the field out of a maintenance call
    // must never be the thing that deleted data.
    const dryRun = body.dryRun !== false;
    const result = await cleanupAbandoned({
      olderThanMs: hours * 60 * 60 * 1000,
      workspaceId: targetWorkspaceId,
      allWorkspaces,
      dryRun,
    });
    res.json({
      success: true,
      dryRun: result.dryRun,
      removed: result.removed,
      wouldRemove: result.wouldRemove,
      ids: result.ids,
      scope: result.scope,
      cutoff: result.cutoff,
    });
  } catch (err) {
    next(err);
  }
}
