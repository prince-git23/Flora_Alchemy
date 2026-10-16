/**
 * 3D GENERATION CONTROLLER — 3D Studio (Phase 2).
 *
 * Thin: validate shape, delegate to the service, shape the JSON envelope. Every
 * endpoint answers `{ success: true, ... }` and throws ApiError for anything
 * else, so `errorMiddleware` owns the failure envelope.
 */

import { ApiError } from '../middleware/errorMiddleware.js';
import * as generation from '../services/3dGenerationService.js';

const QUALITIES = ['draft', 'standard', 'high'];

function parseReferenceIds(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => String(id)).filter(Boolean);
}

/** GET /api/3d/provider — is generation possible, and with what? */
export async function providerStatusHandler(_req, res, next) {
  try {
    const status = generation.providerStatus();
    const health = status.available ? await generation.providerHealth() : null;
    res.json({ success: true, provider: status, health: health ? health.health : null });
  } catch (err) {
    next(err);
  }
}

/** GET /api/3d/products/:productSlug/studio — the whole studio state. */
export async function studioStateHandler(req, res, next) {
  try {
    const state = await generation.studioState(req, req.params.productSlug);
    res.json({ success: true, ...state });
  } catch (err) {
    next(err);
  }
}

/** GET /api/3d/products/:productSlug/jobs */
export async function listJobsHandler(req, res, next) {
  try {
    const jobs = await generation.listJobsForProduct(req, req.params.productSlug);
    res.json({ success: true, jobs });
  } catch (err) {
    next(err);
  }
}

/** POST /api/3d/products/:productSlug/jobs — create and start a generation. */
export async function createJobHandler(req, res, next) {
  try {
    const body = req.body || {};
    const referenceIds = parseReferenceIds(body.referenceIds);
    if (referenceIds.length === 0) {
      throw new ApiError(
        422,
        'Select at least one accepted reference image before generating.',
        'NO_REFERENCES'
      );
    }
    const quality = QUALITIES.includes(body.quality) ? body.quality : 'standard';
    const result = await generation.startGeneration(req, {
      productSlug: req.params.productSlug,
      referenceIds,
      quality,
      notes: body.notes ? String(body.notes).slice(0, 1000) : '',
      label: body.label ? String(body.label).slice(0, 200) : '',
    });
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** GET /api/3d/jobs/:jobId */
export async function getJobHandler(req, res, next) {
  try {
    const job = await generation.getJob(req, req.params.jobId);
    res.json({ success: true, job });
  } catch (err) {
    next(err);
  }
}

/** POST /api/3d/jobs/:jobId/retry */
export async function retryJobHandler(req, res, next) {
  try {
    const result = await generation.retryGeneration(req, req.params.jobId);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/3d/jobs/:jobId/cancel */
export async function cancelJobHandler(req, res, next) {
  try {
    const job = await generation.cancelGeneration(req, req.params.jobId);
    res.json({ success: true, job });
  } catch (err) {
    next(err);
  }
}
