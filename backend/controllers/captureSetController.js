/**
 * 3D STUDIO — PHASE 11 — capture-set controller.
 *
 * Thin: validate the request shape, delegate to the service, shape the JSON
 * envelope (`{ success: true, ... }`). Every refusal is an ApiError so
 * `errorMiddleware` owns the failure envelope and the frontend sees the same
 * codes it already handles.
 *
 * THE ONE ROUTE THAT CAN SPEND MONEY
 * ----------------------------------
 * `submitCaptureSetHandler` is the only path in this file that can reach a
 * metered provider. It is protected by three independent facts:
 *
 *   1. the engine must be INSTALLED and ENABLED for the resolved provider;
 *   2. a metered engine additionally needs `THREE_D_METERED_SUBMIT=true` on the
 *      deployment (an operator decision, not a request field);
 *   3. the request must carry `acknowledgeMetered: true` (a staff decision made
 *      in the confirm dialog).
 *
 * No upload, validation or read route can reach it, and the same route refuses
 * with `ENGINE_NOT_AUTHORISED` rather than silently downgrading to a free engine.
 */

import * as capture from '../services/captureSetService.js';
import * as generation from '../services/3dGenerationService.js';
import { capabilityFor, engineSummaries, ENGINE_CAPABILITIES } from '../services/engineCapabilities.js';
import { ApiError } from '../middleware/errorMiddleware.js';

/** Deployment-level authorisation for a metered provider. Default OFF. */
function meteredSubmissionAuthorised() {
  return String(process.env.THREE_D_METERED_SUBMIT || '').toLowerCase() === 'true';
}

/** The provider facts the capture service evaluates against. */
function providerFacts() {
  const status = generation.providerStatus();
  return { name: status.name, available: status.available, status };
}

function scopeFrom(query = {}) {
  const productSlug = query.productSlug ? String(query.productSlug) : '';
  const draftKey = query.draftKey ? String(query.draftKey) : '';
  if (!productSlug && !draftKey) {
    throw new ApiError(422, 'Supply productSlug (or draftKey for an unsaved product).', 'CAPTURE_SET_SCOPE_REQUIRED');
  }
  return { productSlug, draftKey };
}

/** GET /api/capture-sets/engines — what an engine requires, and what is installed. */
export async function captureEnginesHandler(_req, res, next) {
  try {
    const status = generation.providerStatus();
    res.json({
      success: true,
      provider: status,
      engines: engineSummaries(),
      // The metered switch is a DEPLOYMENT fact, so the UI can say honestly
      // whether a metered submission is even possible here.
      meteredAuthorised: meteredSubmissionAuthorised(),
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/capture-sets — start (or reopen) the set for a product or draft. */
export async function startCaptureSetHandler(req, res, next) {
  try {
    const body = req.body || {};
    const { productSlug, draftKey } = scopeFrom(body);
    const provider = providerFacts();
    const set = await capture.ensureCaptureSet({
      user: req.user,
      productSlug,
      draftKey,
      engineId: body.engineId ? String(body.engineId) : '',
    });
    const { validation, rows } = await capture.refreshCaptureSet({
      user: req.user,
      set,
      provider,
      meshyAuthorised: meteredSubmissionAuthorised(),
    });
    res.status(201).json({
      success: true,
      captureSet: capture.presentCaptureSet(set, { validation, rows }),
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/capture-sets?productSlug=… | ?draftKey=… — live state, no writes. */
export async function getCaptureSetHandler(req, res, next) {
  try {
    const { productSlug, draftKey } = scopeFrom(req.query || {});
    const set = await capture.getCaptureSet({ user: req.user, productSlug, draftKey });
    const rows = await capture.loadRowsForSet(req.user, set);
    const validation = capture.validateCaptureSet({
      rows,
      profile: set.profile || {},
      provider: providerFacts(),
      meshyAuthorised: meteredSubmissionAuthorised(),
    });
    res.json({ success: true, captureSet: capture.presentCaptureSet(set, { validation, rows }) });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/capture-sets/:id — capture profile and selected engine.
 *
 * The STATUS is never accepted from the body: it is a server measurement, and a
 * client that could set `validated` would be able to skip validation entirely.
 */
export async function updateCaptureSetHandler(req, res, next) {
  try {
    const body = req.body || {};
    if (body.status !== undefined) {
      throw new ApiError(
        422,
        'A capture set’s status is measured by the server; it cannot be set by a request.',
        'CAPTURE_SET_STATUS_READ_ONLY'
      );
    }
    if (body.engineId !== undefined) {
      const capability = capabilityFor(String(body.engineId));
      if (!capability.installed) {
        throw new ApiError(
          422,
          `${capability.label} has no adapter in this build, so it cannot be selected for submission.`,
          'ENGINE_NOT_INSTALLED'
        );
      }
    }

    const set = await capture.getCaptureSet({
      user: req.user,
      productSlug: body.productSlug ? String(body.productSlug) : '',
      draftKey: body.draftKey ? String(body.draftKey) : '',
    });
    if (String(set._id) !== String(req.params.id)) {
      throw new ApiError(404, 'No capture set with that id.', 'CAPTURE_SET_NOT_FOUND');
    }

    if (body.engineId !== undefined) set.engineId = String(body.engineId);
    if (body.profile !== undefined) {
      await capture.applyProfile({ set, profilePatch: body.profile, updatedBy: req.user?._id });
    } else {
      await set.save();
    }

    const { validation, rows } = await capture.refreshCaptureSet({
      user: req.user,
      set,
      provider: providerFacts(),
      meshyAuthorised: meteredSubmissionAuthorised(),
    });
    res.json({ success: true, captureSet: capture.presentCaptureSet(set, { validation, rows }) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/capture-sets/:id/validate — recompute and persist the snapshot. */
export async function validateCaptureSetHandler(req, res, next) {
  try {
    const body = req.body || {};
    const set = await capture.getCaptureSet({
      user: req.user,
      productSlug: body.productSlug ? String(body.productSlug) : '',
      draftKey: body.draftKey ? String(body.draftKey) : '',
    });
    if (String(set._id) !== String(req.params.id)) {
      throw new ApiError(404, 'No capture set with that id.', 'CAPTURE_SET_NOT_FOUND');
    }
    const { validation, rows } = await capture.refreshCaptureSet({
      user: req.user,
      set,
      provider: providerFacts(),
      meshyAuthorised: meteredSubmissionAuthorised(),
    });
    res.json({ success: true, captureSet: capture.presentCaptureSet(set, { validation, rows }) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/capture-sets/:id/plan — the DRY RUN.
 *
 * Returns exactly which images would be sent, in which order, to which engine,
 * and why anything was left out. Nothing is submitted, nothing is written, and no
 * provider is contacted: this is what lets a reviewer check the plan before
 * authorising a metered run.
 */
export async function previewPlanHandler(req, res, next) {
  try {
    const body = req.body || {};
    const set = await capture.getCaptureSet({
      user: req.user,
      productSlug: body.productSlug ? String(body.productSlug) : '',
      draftKey: body.draftKey ? String(body.draftKey) : '',
    });
    if (String(set._id) !== String(req.params.id)) {
      throw new ApiError(404, 'No capture set with that id.', 'CAPTURE_SET_NOT_FOUND');
    }
    const engineId = String(body.engineId || set.engineId || '');
    const rows = await capture.loadRowsForSet(req.user, set);

    if (!engineId) {
      throw new ApiError(422, 'Choose a reconstruction engine first.', 'ENGINE_REQUIRED');
    }

    const plan = capture.buildSubmissionPlan({
      rows,
      profile: set.profile || {},
      engineId,
      provider: providerFacts(),
      meshyAuthorised: meteredSubmissionAuthorised(),
    });

    res.json({
      success: true,
      plan: {
        engineId: plan.engineId,
        engineLabel: plan.engineLabel,
        inputMode: plan.inputMode,
        metered: plan.metered,
        inputIds: plan.inputIds,
        viewsSent: plan.viewsSent,
        unusedViews: plan.unusedViews,
        inputs: plan.inputs,
        payloadFingerprint: plan.payloadFingerprint,
        warnings: plan.warnings,
        validation: {
          complete: plan.validation.complete,
          validFor: plan.validation.validFor,
          missing: plan.validation.missing,
          counts: plan.validation.counts,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/capture-sets/:id/submit — THE explicit action.
 *
 * Order matters and is deliberate:
 *   1. build the plan (which validates for THIS engine);
 *   2. atomically claim the set (so a double click cannot bill twice);
 *   3. start generation with EXACTLY the plan's ids;
 *   4. append the audit record.
 * If step 3 fails, the failure is recorded and the set moves to `failed` — it is
 * never reported as submitted.
 */
export async function submitCaptureSetHandler(req, res, next) {
  try {
    const body = req.body || {};
    const set = await capture.getCaptureSet({
      user: req.user,
      productSlug: body.productSlug ? String(body.productSlug) : '',
      draftKey: body.draftKey ? String(body.draftKey) : '',
    });
    if (String(set._id) !== String(req.params.id)) {
      throw new ApiError(404, 'No capture set with that id.', 'CAPTURE_SET_NOT_FOUND');
    }

    // The whole sequence (plan → claim → generate → append) lives in the service;
    // the controller supplies the deployment's metered switch and the generator.
    const result = await capture.executeSubmission({
      user: req.user,
      set,
      engineId: String(body.engineId || set.engineId || ''),
      acknowledgeMetered: body.acknowledgeMetered === true,
      meteredAuthorised: meteredSubmissionAuthorised(),
      provider: providerFacts(),
      notes: body.notes ? String(body.notes).slice(0, 1000) : '',
      label: body.label ? String(body.label).slice(0, 200) : '',
      startGeneration: (options) => generation.startGeneration(req, options),
    });

    res.status(201).json({
      success: true,
      submission: result.submission,
      captureSet: capture.presentCaptureSet(result.set, { validation: result.plan.validation, rows: result.rows }),
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/capture-sets/:id/archive */
export async function archiveCaptureSetHandler(req, res, next) {
  try {
    const body = req.body || {};
    const set = await capture.getCaptureSet({
      user: req.user,
      productSlug: body.productSlug ? String(body.productSlug) : '',
      draftKey: body.draftKey ? String(body.draftKey) : '',
    });
    if (String(set._id) !== String(req.params.id)) {
      throw new ApiError(404, 'No capture set with that id.', 'CAPTURE_SET_NOT_FOUND');
    }
    if (set.status === 'processing') {
      throw new ApiError(
        409,
        'This set has a reconstruction in flight; cancel that job before archiving the set.',
        'CAPTURE_SET_BUSY'
      );
    }
    await capture.archiveCaptureSet(set);
    res.json({ success: true, captureSet: capture.presentCaptureSet(set) });
  } catch (err) {
    next(err);
  }
}

/** GET /api/capture-sets/capabilities — the registry in full (staff read). */
export async function captureCapabilitiesHandler(_req, res, next) {
  try {
    res.json({ success: true, engines: ENGINE_CAPABILITIES });
  } catch (err) {
    next(err);
  }
}
