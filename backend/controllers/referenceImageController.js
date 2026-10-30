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
  confirmReferenceViews,
  createReferenceImage,
  getReferenceImage,
  listReferenceImages,
  previewReferenceViews,
  readReferenceAsset,
  removeReferenceImage,
  reorderReferenceImages,
  reprocessReferenceImage,
  updateReferenceImage,
} from '../services/referenceImageService.js';
import { GRID_LIMITS, VIEW_ANGLES } from '../services/referenceViews.js';
import { getWorkspaceId } from '../utils/tenancy.js';
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import { IMAGE_RULES } from '../services/referenceImageValidation.js';

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
 * Grid correction input. Fail closed: a columns/rows pair that is not two
 * positive integers is refused rather than coerced, and the panel budget is
 * enforced before any crop is taken.
 */
function parseGrid(body = {}) {
  const grid = {};
  if (body.columns !== undefined) grid.columns = Number(body.columns);
  if (body.rows !== undefined) grid.rows = Number(body.rows);
  if (body.padding !== undefined) {
    const padding = Number(body.padding);
    if (!Number.isInteger(padding) || padding < 0 || padding > 200) {
      throw new ApiError(422, 'padding must be a whole number of pixels between 0 and 200.', 'VALIDATION_ERROR');
    }
    grid.padding = padding;
  }
  for (const key of ['columns', 'rows']) {
    if (grid[key] === undefined) continue;
    if (!Number.isInteger(grid[key]) || grid[key] < 1 || grid[key] > (key === 'columns' ? GRID_LIMITS.maxColumns : GRID_LIMITS.maxRows)) {
      throw new ApiError(
        422,
        `${key} must be a whole number between 1 and ${key === 'columns' ? GRID_LIMITS.maxColumns : GRID_LIMITS.maxRows}.`,
        'VALIDATION_ERROR'
      );
    }
  }
  if (grid.columns !== undefined && grid.rows !== undefined && grid.columns * grid.rows > GRID_LIMITS.maxPanels) {
    throw new ApiError(
      422,
      `A ${grid.columns}×${grid.rows} layout is ${grid.columns * grid.rows} views; the limit is ${GRID_LIMITS.maxPanels}.`,
      'GRID_TOO_LARGE'
    );
  }
  return grid;
}

/** POST /api/references — upload one original and start real processing. */
export async function uploadReferenceImage(req, res, next) {
  try {
    const body = req.body || {};
    const mode = ['auto', 'single', 'composite'].includes(String(body.mode || '')) ? String(body.mode) : 'auto';
    const { doc, uploadedNotes, duplicateOf } = await createReferenceImage(req, {
      file: req.file,
      productSlug: body.productSlug ? String(body.productSlug).slice(0, 200) : '',
      draftKey: body.draftKey ? String(body.draftKey).slice(0, 120) : '',
      label: body.label ? String(body.label).slice(0, 120) : '',
      mode,
      viewAngle: body.viewAngle ? String(body.viewAngle) : '',
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
    if (body.crop !== undefined) patch.crop = body.crop;
    // `composite: false` is the "this is one photograph" decision (the detector
    // may have proposed a grid). It clears the proposal; it never deletes views.
    if (body.composite !== undefined) patch.composite = body.composite;
    if (body.viewAngle !== undefined) patch.viewAngle = body.viewAngle;
    // PHASE 11 — the recorded camera pose. Validated in the service by
    // capturePose.normalisePose; `null` is an explicit clear, not an omission.
    if (body.pose !== undefined) patch.pose = body.pose;
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

/** POST /api/references/:id/reprocess — re-measure (and re-read a composite grid). */
export async function reprocessReferenceImageHandler(req, res, next) {
  try {
    if ((req.body || {}).crop !== undefined) {
      throw new ApiError(
        422,
        'Cropping a reference in place is not supported. Confirm a composite grid instead.',
        'CROP_NOT_SUPPORTED'
      );
    }
    const image = await reprocessReferenceImage(req, req.params.id);
    res.json({ success: true, image: presentImage(image, await assetPresence(image)) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/references/:id/views — what the current (or a proposed) grid would
 * produce, WITHOUT writing anything. This is the correction UI's preview.
 */
export async function previewReferenceViewsHandler(req, res, next) {
  try {
    const grid = parseGrid({ ...(req.query || {}) });
    const analysis = await previewReferenceViews(req, req.params.id, grid);
    res.json({ success: true, analysis });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/references/:id/views — create (or correct) the views of a composite
 * from an EXPLICIT layout. Never called with a detector-only guess: the studio
 * sends the numbers the administrator saw and confirmed.
 */
export async function confirmReferenceViewsHandler(req, res, next) {
  try {
    const body = req.body || {};
    const grid = parseGrid(body);
    if (!grid.columns || !grid.rows) {
      throw new ApiError(422, 'columns and rows are required to confirm a layout.', 'VALIDATION_ERROR');
    }
    const result = await confirmReferenceViews(req, req.params.id, {
      ...grid,
      angles: Array.isArray(body.angles) ? body.angles.map(String) : [],
      replace: body.replace !== false,
    });
    res.json({
      success: true,
      parent: presentImage(result.parent, await assetPresence(result.parent)),
      layout: result.layout,
      panels: result.panels,
      created: result.created,
      updated: result.updated,
      removed: result.removed,
      warnings: result.warnings,
      notes: result.notes,
    });
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
 * GET /api/references/options — the reference vocabulary the studio renders:
 * supported formats, size limits, the panel budget and the viewpoint labels.
 *
 * This REPLACES the old `/engine` endpoint, which described a background-removal
 * engine. There is no engine any more, so there is nothing about one to report.
 */
export function referenceOptionsHandler(_req, res) {
  res.json({
    success: true,
    options: {
      segmentation: 'disabled',
      maxReferences: 24,
      grid: GRID_LIMITS,
      viewAngles: VIEW_ANGLES,
      imageRules: {
        minLongEdge: IMAGE_RULES.minLongEdge,
        maxLongEdge: IMAGE_RULES.maxLongEdge,
        maxPixels: IMAGE_RULES.maxPixels,
        allowedFormats: IMAGE_RULES.allowedFormats,
      },
    },
  });
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
