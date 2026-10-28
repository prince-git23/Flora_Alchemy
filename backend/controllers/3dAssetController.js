/**
 * 3D ASSET CONTROLLER — 3D Studio (Phase 2).
 *
 * Approve / reject / list / delete for generated models. Approving or rejecting
 * goes through the JOB so the job and its asset cannot disagree about what was
 * decided.
 */

import { ApiError } from '../middleware/errorMiddleware.js';
import * as assets from '../services/3dAssetService.js';
import * as generation from '../services/3dGenerationService.js';

/** GET /api/3d/products/:productSlug/assets */
export async function listHandler(req, res, next) {
  try {
    const items = await assets.listAssetsForProduct(req, req.params.productSlug);
    res.json({
      success: true,
      assets: items,
      approved: items.find((a) => a.status === 'APPROVED') || null,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/3d/products/:productSlug/assets/current */
export async function currentHandler(req, res, next) {
  try {
    const approved = await assets.findApproved(req, req.params.productSlug);
    res.json({
      success: true,
      asset: approved ? assets.publicAssetProjection(approved) : null,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/3d/assets/:assetId */
export async function detailHandler(req, res, next) {
  try {
    const asset = await assets.getAsset(req, req.params.assetId);
    res.json({ success: true, asset });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/3d/jobs/:jobId/approve
 *
 * `assetId` may be omitted when the job has exactly one candidate, which is the
 * normal case; requiring the client to echo back an id it just read adds a way
 * to get it wrong without adding safety.
 */
export async function approveHandler(req, res, next) {
  try {
    const body = req.body || {};
    const job = await generation.getJob(req, req.params.jobId);

    let assetId = body.assetId ? String(body.assetId) : '';
    if (!assetId) {
      const items = await assets.listAssetsForProduct(req, job.productSlug);
      const candidates = items.filter((a) => a.status === 'CANDIDATE');
      if (candidates.length !== 1) {
        throw new ApiError(
          candidates.length === 0 ? 422 : 409,
          candidates.length === 0
            ? 'This job has no candidate model to approve.'
            : 'This job has more than one candidate; say which one to approve.',
          candidates.length === 0 ? 'ASSET_NOT_FOUND' : 'ASSET_AMBIGUOUS'
        );
      }
      assetId = candidates[0].id;
    }

    const result = await generation.approveJobCandidate(req, req.params.jobId, assetId, {
      /* PHASE 5 — the quality gate's only inputs from the request. `body.quality`
         (or any other submitted verdict) is deliberately NOT read: a client may
         decide to stand behind a model, but it cannot compute a verdict, and the
         server never accepts one it did not measure itself. */
      reviewNote: body.reviewNote ? String(body.reviewNote).slice(0, 500) : '',
      override: body.overrideQuality === true || body.override === true,
      overrideReason: body.overrideReason ? String(body.overrideReason).slice(0, 500) : '',
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/3d/jobs/:jobId/reject */
export async function rejectHandler(req, res, next) {
  try {
    const body = req.body || {};
    const job = await generation.getJob(req, req.params.jobId);

    let assetId = body.assetId ? String(body.assetId) : '';
    if (!assetId) {
      const items = await assets.listAssetsForProduct(req, job.productSlug);
      const candidates = items.filter((a) => a.status === 'CANDIDATE');
      if (candidates.length !== 1) {
        throw new ApiError(
          candidates.length === 0 ? 422 : 409,
          candidates.length === 0
            ? 'This job has no candidate model to reject.'
            : 'This job has more than one candidate; say which one to reject.',
          candidates.length === 0 ? 'ASSET_NOT_FOUND' : 'ASSET_AMBIGUOUS'
        );
      }
      assetId = candidates[0].id;
    }

    const result = await generation.rejectJobCandidate(
      req,
      req.params.jobId,
      assetId,
      body.reason ? String(body.reason).slice(0, 500) : ''
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/3d/assets/:assetId/assess — re-run the quality gate on demand.
 *
 * A WRITE, not a read: it re-measures the stored model, so it sits behind the
 * same permission and rate-limit gates as any other change to the studio's
 * state. Useful after accepting a better reference, when the earlier verdict was
 * reached against a poorer photograph.
 */
export async function assessHandler(req, res, next) {
  try {
    const result = await assets.reassessAsset(req, req.params.assetId);
    res.json({
      success: true,
      asset: result.asset,
      report: result.report,
      reassessed: Boolean(result.reassessed),
    });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/3d/assets/:assetId — only a non-approved asset may be deleted. */
export async function deleteHandler(req, res, next) {
  try {
    const result = await assets.deleteAsset(req, req.params.assetId);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/3d/assets/:assetId/orientation — PHASE 9 staff correction.
 *
 * Persists a whole number of quarter-turns (0..3, 0 = upright reset) on the
 * candidate or approved asset. The request body carries ONLY the yaw and an
 * optional reason: any `quality`/`score`/`decision`-shaped field is ignored the
 * same way every other studio write ignores one — this endpoint corrects
 * presentation and can neither improve geometry nor buy an approval.
 */
export async function orientationHandler(req, res, next) {
  try {
    const body = req.body || {};
    const asset = await assets.setAssetOrientation(req, req.params.assetId, {
      yawQuarterTurns: body.yawQuarterTurns,
      reason: body.reason ? String(body.reason).slice(0, 240) : '',
    });
    res.json({ success: true, asset });
  } catch (err) {
    next(err);
  }
}
