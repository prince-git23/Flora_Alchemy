/**
 * 3D STUDIO — Phase 5 — the QUALITY GATE for a generated model.
 *
 * Phase 2 answers "are these bytes genuinely a glTF Binary container?" and stops
 * there. That check passes for a mesh that looks nothing like the product, so on
 * its own it is not enough to put in front of a customer. This service asks the
 * next question and records the answer:
 *
 *     does this mesh actually resemble the thing in the accepted photograph?
 *
 * A VALID GLB IS NOT AUTOMATICALLY A VALID PRODUCT MODEL.
 *
 * ── WHAT IT MEASURES, AND WHY EACH THING IS THERE ───────────────────────────
 *
 *   STRUCTURAL  the container walk Phase 2 already performs (re-run here, never
 *               assumed: the gate must not depend on a caller having validated).
 *   GEOMETRY    vertices, triangles, degenerate triangles, non-finite vertices,
 *               boundary and non-manifold edges, bounds, extents, file size —
 *               read from the bytes, not from the provider's summary.
 *   SILHOUETTE  the mesh's orthographic projection against the accepted cutout:
 *               IoU after similarity alignment, aspect-ratio error, coverage
 *               delta, symmetric contour distance.
 *   MATERIALS   the presence or absence of material/texture maps, stated
 *               explicitly. A vertex-colour model is never described as
 *               textured, and is not rejected merely for being vertex-coloured.
 *   REFERENCE   the accepted cutout's own provenance and quality flags. A
 *               photograph whose cutout is itself doubtful cannot be used to
 *               condemn a model, so this is recorded and it changes the verdict.
 *
 * ── THE THREE DECISIONS ────────────────────────────────────────────────────
 *
 *   PASS     measured and comfortably inside every threshold.
 *   REVIEW   valid but not comfortably good: a borderline score, an uncertain
 *            viewing angle, a doubtful reference, or a missing measurement. A
 *            human must look at it and say so explicitly.
 *   BLOCKED  a critical structural failure or a severe mismatch. Normal approval
 *            is refused; the only way past is an audited owner override.
 *
 * ── HONESTY ABOUT THRESHOLDS ───────────────────────────────────────────────
 * The default bands are PROVISIONAL. They were chosen conservatively (the PASS
 * band is deliberately hard to reach) against ONE genuine generated model and a
 * set of synthetic fixtures — see `calibration` in the returned report, which
 * states the sample size rather than implying the numbers are validated. Nothing
 * here presents a score as an accuracy measurement: every metric is defined in
 * `3dSilhouetteMetrics.js` and reproducible from the stored bytes.
 */

import { ApiError } from '../middleware/errorMiddleware.js';
import { measureColourTier, measureGeometry, rasteriseSilhouette, VIEW_NAMES } from './3dMeshGeometry.js';
import {
  CANONICAL_SIZE,
  compareNormalised,
  frameCentroidOffset,
  maskFromPixels,
  normaliseMask,
  selectBestView,
} from './3dSilhouetteMetrics.js';
import { validateGlb } from './3dModelValidation.js';

/** Bumped whenever the MEANING of a report changes, so stale reports are visible.
 *  phase5-2: colour became a judged section of its own (materials, colour source,
 *  collapse bands), so every report produced before it is stale by definition and
 *  is re-measured before it can be approved.
 *  phase13-1: fragmentation gained a measured component distribution (areas,
 *  boxes, share bands, per-piece closure) and the report gained an `evidence`
 *  section listing the worker's per-view silhouette masks, which view was
 *  measured and which are uncalibrated. A pre-Phase-13 report cannot say any of
 *  that, so its verdict is not the same claim and it is stale by definition.
 *  phase13-2: a worker mask PNG (opaque greyscale, no alpha) is decoded by GREY
 *  LEVEL, not alpha. phase13-1 read alpha and therefore compared every view with
 *  a solid full frame — all views reported the same IoU — so the numbers those
 *  reports carry are not measurements of these photographs. */
export const ASSESSMENT_VERSION = 'phase13-2';

export const DECISION_PASS = 'PASS';
export const DECISION_REVIEW = 'REVIEW';
export const DECISION_BLOCKED = 'BLOCKED';
export const DECISIONS = [DECISION_PASS, DECISION_REVIEW, DECISION_BLOCKED];

/**
 * Conservative default bands.
 *
 * `passIou` is high on purpose: with one genuine sample to calibrate against, a
 * model should have to match CLEARLY before the gate calls it good. Everything
 * between the bands is a human decision, which is the safe direction for an
 * uncalibrated metric.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  passIou: 0.75,
  blockIou: 0.35,
  passAspectError: 0.25,
  blockAspectError: 1.0,
  /** A winner this close to the runner-up means the view choice was a guess. */
  minViewMargin: 0.05,
  minVertices: 60,
  minTriangles: 200,
  maxTriangles: 1_500_000,
  maxDegenerateFraction: 0.02,
  maxBoundaryEdgeFraction: 0.02,
  maxNonManifoldEdges: 200,
  minFlatness: 0.02,
  maxAspectRatio: 50,
  /* ── fragmentation + depth bands (worker-cleanup era) ─────────────────────
   * The worker drops only speck-sized detached components, so a result with
   * many islands (or a surface whose bulk sits in scattered pieces) is a fact
   * about the reconstruction a human must see. `minDepthRatio` is the REVIEW
   * band for 'is this actually a 3D object'; the critical floor stays
   * `minFlatness` for generic products and is lowered only for categories
   * that are genuinely flat (see CATEGORY_DEPTH_BANDS). null = decide from
   * the product's category. */
  maxComponents: 8,
  minLargestComponentShare: 0.6,
  minDepthRatio: null,
  warnBytes: 8 * 1024 * 1024,
  maxBytes: 32 * 1024 * 1024,
  /** Phase 1 confidence below which the accepted cutout is treated as doubtful. */
  referenceMinConfidence: 0.6,
  /** Specks and stray regions are already removed; too many is a warning sign. */
  referenceMaxDroppedFraction: 0.15,
  /** Strict policy: require material maps rather than only warning about them. */
  requireMaterials: false,
  /* ── colour bands (§3 — colour fidelity is judged apart from shape) ─────
   * These measure the colour DATA in the asset, not a screenshot: a model
   * whose colour data collapsed to near-black is dark in EVERY viewer, and a
   * model with no colour source at all is untextured in every viewer. They are
   * deliberately conservative — a colourful-but-malformed mesh still fails on
   * geometry, and a well-shaped dark mesh must not be called finished. */
  /** Fraction of vertices that may sit at true black (linear luminance < 0.01). */
  maxNearBlackFraction: 0.35,
  /** Mean saturation below this means the colour data is effectively grey. */
  minMeanSaturation: 0.04,
});

/** Read a threshold from the environment, falling back to the default band. */
function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve the thresholds in force: defaults ← environment ← explicit overrides.
 * Recorded verbatim in every report so a decision can always be traced back to
 * the numbers that produced it.
 */
export function resolveThresholds(overrides = {}) {
  const fromEnv = {
    passIou: envNumber('THREE_QUALITY_PASS_IOU', DEFAULT_THRESHOLDS.passIou),
    blockIou: envNumber('THREE_QUALITY_BLOCK_IOU', DEFAULT_THRESHOLDS.blockIou),
    passAspectError: envNumber('THREE_QUALITY_PASS_ASPECT_ERROR', DEFAULT_THRESHOLDS.passAspectError),
    blockAspectError: envNumber('THREE_QUALITY_BLOCK_ASPECT_ERROR', DEFAULT_THRESHOLDS.blockAspectError),
    minViewMargin: envNumber('THREE_QUALITY_MIN_VIEW_MARGIN', DEFAULT_THRESHOLDS.minViewMargin),
    maxComponents: envNumber('THREE_QUALITY_MAX_COMPONENTS', DEFAULT_THRESHOLDS.maxComponents),
    minLargestComponentShare: envNumber(
      'THREE_QUALITY_MIN_LARGEST_COMPONENT_SHARE',
      DEFAULT_THRESHOLDS.minLargestComponentShare
    ),
    minDepthRatio: envNumber('THREE_QUALITY_MIN_DEPTH_RATIO', DEFAULT_THRESHOLDS.minDepthRatio),
    requireMaterials:
      process.env.THREE_QUALITY_REQUIRE_MATERIALS === undefined
        ? DEFAULT_THRESHOLDS.requireMaterials
        : process.env.THREE_QUALITY_REQUIRE_MATERIALS === '1',
    maxNearBlackFraction: envNumber(
      'THREE_QUALITY_MAX_NEAR_BLACK_FRACTION',
      DEFAULT_THRESHOLDS.maxNearBlackFraction
    ),
    minMeanSaturation: envNumber(
      'THREE_QUALITY_MIN_MEAN_SATURATION',
      DEFAULT_THRESHOLDS.minMeanSaturation
    ),
  };
  const merged = { ...DEFAULT_THRESHOLDS, ...fromEnv, ...withoutUndefined(overrides) };
  // A caller must not be able to invert the bands into "everything passes".
  if (merged.passIou <= merged.blockIou) {
    throw new ApiError(
      500,
      `Quality thresholds are inconsistent: passIou (${merged.passIou}) must exceed blockIou (${merged.blockIou}).`,
      'QUALITY_THRESHOLDS_INVALID'
    );
  }
  return merged;
}

function withoutUndefined(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined && item !== null) out[key] = item;
  }
  return out;
}

/** The immutable identity of "what was assessed", used to detect staleness. */
export function fingerprintFor({ sha256 = '', referenceIds = [], assessmentVersion = ASSESSMENT_VERSION, settings = {} } = {}) {
  const ids = [...referenceIds].map(String).sort().join(',');
  return `${assessmentVersion}|${sha256}|${ids}|${settings.quality || ''}|${settings.notes || ''}`;
}

/**
 * Decode a stored cutout PNG into a binary mask.
 *
 * `sharp` is already a backend dependency (Phase 1's cutout metrics use it), so
 * no new library is introduced. Every failure is returned as a reason rather
 * than thrown, because "the cutout could not be read" is a REVIEW-grade fact,
 * not a crash.
 */
export async function decodeCutoutMask(buffer) {
  if (!buffer || !buffer.length) return { ok: false, reason: 'The accepted reference carries no silhouette mask.' };
  try {
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const mask = maskFromPixels(data, info.width, info.height, info.channels);
    if (!mask.mask || mask.error) {
      return { ok: false, reason: "The accepted reference's mask contains no subject pixels." };
    }
    return { ok: true, mask, width: info.width, height: info.height, channels: info.channels };
  } catch (err) {
    return { ok: false, reason: `The accepted reference's mask could not be decoded (${err.message}).` };
  }
}

/**
 * Decode a MASK PNG — the worker's 1-bit foreground mask.
 *
 * `decodeCutoutMask` reads ALPHA, which is right for a cutout photograph and
 * catastrophically wrong here: a mask PNG is opaque greyscale, so sharp's
 * `ensureAlpha()` fills alpha with 255 and the "mask" becomes the WHOLE FRAME.
 * That is not a hypothetical — the first Phase 13 reports compared a solid
 * square against the mesh, so every view measured the same IoU. Read the grey
 * level instead, and refuse a mask that covers the entire frame or nothing.
 */
export async function decodeMaskPng(buffer) {
  if (!buffer || !buffer.length) return { ok: false, reason: 'The mask PNG carries no bytes.' };
  try {
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(buffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const total = info.width * info.height;
    const mask = new Uint8Array(total);
    let subject = 0;
    for (let i = 0; i < total; i += 1) {
      if (data[i] > 127) {
        mask[i] = 1;
        subject += 1;
      }
    }
    if (!subject) {
      return { ok: false, reason: 'The supplied mask PNG contains no subject pixels.' };
    }
    const coverage = subject / total;
    if (coverage > 0.98) {
      return {
        ok: false,
        reason: 'The supplied mask PNG covers the whole frame, so it is not a product silhouette.',
      };
    }
    return {
      ok: true,
      mask: { mask, width: info.width, height: info.height, subject, coverage },
      width: info.width,
      height: info.height,
      channels: 1,
    };
  } catch (err) {
    return { ok: false, reason: `The mask PNG could not be decoded (${err.message}).` };
  }
}

/**
 * Judge the accepted reference itself.
 *
 * A cutout that retained background, or that Phase 1 already flagged, is not a
 * trustworthy yardstick. Recording that here is what stops the gate from
 * reporting a contaminated reference as a defective model.
 */
export function judgeReference(reference, thresholds, cleaning) {
  const flags = [];
  if (!reference) {
    flags.push({ code: 'REFERENCE_MISSING', message: 'No accepted reference was available to compare against.' });
  } else {
    if (!reference.cutoutAvailable) {
      flags.push({
        code: 'REFERENCE_MASK_MISSING',
        message:
          'The accepted reference carries no silhouette mask: automatic background removal was removed, and this image has no transparency of its own.',
      });
    }
    if (reference.confidence != null && reference.confidence < thresholds.referenceMinConfidence) {
      flags.push({
        code: 'REFERENCE_LOW_CONFIDENCE',
        message: `Phase 1 reported ${reference.confidence} confidence for this cutout, below the ${thresholds.referenceMinConfidence} working threshold.`,
      });
    }
    for (const warning of reference.warnings || []) {
      flags.push({ code: 'REFERENCE_WARNING', message: warning });
    }
    if (cleaning && cleaning.droppedFraction > thresholds.referenceMaxDroppedFraction) {
      flags.push({
        code: 'REFERENCE_FRAGMENTED',
        message: `${(cleaning.droppedFraction * 100).toFixed(1)}% of the mask's subject pixels were disconnected specks that had to be dropped.`,
      });
    }
  }
  return {
    available: Boolean(reference),
    engine: reference?.engine || '',
    model: reference?.model || '',
    confidence: reference?.confidence ?? null,
    warnings: reference?.warnings || [],
    flagged: flags.length > 0,
    flags,
  };
}

/* ── category-aware depth bands ──────────────────────────────────────────────
 * A greeting card SHOULD be thin; a hamper should not be. One universal
 * thickness number is wrong for both, so the REVIEW band (and the critical
 * floor) come from the product's category, while an explicit threshold or
 * THREE_QUALITY_MIN_DEPTH_RATIO always wins. Bands are provisional, like every
 * number in here, and recorded verbatim on the report. */
const CATEGORY_DEPTH_BANDS = [
  {
    match: ['card', 'print', 'photo', 'frame', 'tag', 'poster', 'coaster', 'note', 'letter', 'stationery', 'envelope', 'bookmark'],
    review: 0.015,
    floor: 0.004,
    label: 'flat paper goods',
  },
  {
    match: ['box', 'hamp', 'basket', 'jar', 'vase', 'bottle', 'candle', 'mug', 'cup', 'pot', 'bouquet', 'posy', 'wreath', 'plush', 'ornament', 'bauble'],
    review: 0.08,
    floor: 0.02,
    label: 'solid three-dimensional goods',
  },
];

export function depthBandFor(category = '', { explicit = false, explicitValue = null } = {}) {
  const value = explicit && explicitValue != null ? Number(explicitValue) : NaN;
  if (Number.isFinite(value) && value > 0) {
    return {
      minDepthRatio: value,
      floor: Math.min(DEFAULT_THRESHOLDS.minFlatness, value),
      source: 'threshold',
      category: '',
      label: 'explicit threshold',
    };
  }
  const key = String(category || '').toLowerCase();
  if (key) {
    for (const band of CATEGORY_DEPTH_BANDS) {
      if (band.match.some((token) => key.includes(token))) {
        return {
          minDepthRatio: band.review,
          floor: band.floor,
          source: 'category',
          category: key,
          label: band.label,
        };
      }
    }
  }
  return {
    minDepthRatio: DEFAULT_THRESHOLDS.minDepthRatio ?? 0.05,
    floor: DEFAULT_THRESHOLDS.minFlatness,
    source: 'default',
    category: key,
    label: 'generic product',
  };
}

/**
 * Describe the worker's per-view mask evidence, and (when projections exist)
 * measure each mask against the best-matching orthographic outline.
 *
 * THE HONEST LIMIT, stated in the result rather than implied away: these are
 * ordinary photographs. Nothing in this repository stores a calibrated camera
 * pose for them, so a mask cannot be compared with "the" camera's projection.
 * The best-matching projection is what can be measured, which makes the number a
 * CONSISTENCY check — it can catch a model that is nothing like the view it was
 * conditioned on, and it can never certify that a view is correct. Only the
 * anchor view (the mask the verdict already uses) counts toward the decision.
 *
 * No mask here is derived from the mesh; each one is the product-only region of
 * one photograph, carried with that photograph's own SHA-256.
 *
 * @param {Array} evidence sanitised entries from `3dAssetService`
 * @param {object} context
 * @param {Array|null} context.projections rasterised outlines, or null
 */
async function describeMaskEvidence(evidence, { projections, canonicalSize, minMargin, referenceIds } = {}) {
  const list = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
  const known = Array.isArray(referenceIds) ? referenceIds.map(String) : [];
  const base = {
    available: list.length > 0,
    alignment:
      'Each mask is the worker\'s own foreground mask of the photograph it conditioned on, compared with the mesh\'s best-matching orthographic outline. No calibrated camera pose exists for these frames, so a non-anchor match is a consistency check, not a camera-resolved measurement.',
    canonicalSize: canonicalSize ?? null,
    versions: [...new Set(list.map((entry) => entry.maskVersion).filter(Boolean))],
    templates: list.map((entry) => ({
      referenceId: String(entry.referenceId || ''),
      slot: String(entry.slot || ''),
      width: entry.width ?? null,
      height: entry.height ?? null,
      inputSha256: String(entry.inputSha256 || ''),
      maskPngSha256: String(entry.maskPngSha256 || ''),
      maskPx: entry.maskPx ?? null,
      maskSource: String(entry.maskSource || ''),
      maskVersion: String(entry.maskVersion || ''),
      /** Whether this mask belongs to a reference id the job was given. */
      scopedToJob: known.length === 0 || known.includes(String(entry.referenceId || '')),
    })),
  };

  if (!list.length) {
    return {
      ...base,
      reason:
        'The worker supplied no per-view mask evidence, so only the accepted reference cutout was available to compare against.',
      views: [],
      viewsMeasured: [],
      viewsUnmeasured: [],
      missingSlots: [],
    };
  }

  const anchorSlot = list.some((entry) => entry.slot === 'front') ? 'front' : String(list[0].slot || '');
  const views = [];
  for (const entry of list) {
    const slot = String(entry.slot || '');
    const anchor = slot === anchorSlot;
    const view = {
      referenceId: String(entry.referenceId || ''),
      slot,
      width: entry.width ?? null,
      height: entry.height ?? null,
      inputSha256: String(entry.inputSha256 || ''),
      maskPngSha256: String(entry.maskPngSha256 || ''),
      maskPx: entry.maskPx ?? null,
      maskSource: String(entry.maskSource || ''),
      maskVersion: String(entry.maskVersion || ''),
      anchor,
      measured: false,
      alignment: anchor ? 'reference-frame' : 'best-match-orthographic',
      countsTowardVerdict: false,
      reason: '',
      projection: null,
      iou: null,
      aspectError: null,
      coverageDelta: null,
      contourDistance: null,
    };
    if (!entry.buffer || !entry.buffer.length) {
      view.reason = 'The mask bytes were not retained, so this view could not be measured.';
      views.push(view);
      continue;
    }
    let decoded = null;
    try {
      decoded = await decodeMaskPng(entry.buffer);
    } catch (err) {
      view.reason = `The mask could not be decoded (${err.message}).`;
      views.push(view);
      continue;
    }
    if (!decoded.ok) {
      view.reason = decoded.reason;
      views.push(view);
      continue;
    }
    const normalised = normaliseMask(decoded.mask, { size: canonicalSize });
    if (!normalised) {
      view.reason = 'The mask is empty, so there was no silhouette to compare.';
      views.push(view);
      continue;
    }
    view.coverage = Number(normalised.coverage.toFixed(4));
    view.maskAspect = normalised.sourceAspect ?? null;
    if (!projections || !projections.length) {
      view.reason = 'The mesh produced no usable projection, so this mask was recorded but not compared.';
      views.push(view);
      continue;
    }
    const chosen = selectBestView(normalised, projections, { size: canonicalSize, minMargin });
    if (!chosen.best) {
      view.reason = 'No projection of the mesh could be compared with this mask.';
      views.push(view);
      continue;
    }
    const projection = projections.find((item) => item.view === chosen.best.view);
    const normalisedProjection = normaliseMask(
      { mask: projection.mask, width: projection.size, height: projection.size },
      { size: canonicalSize }
    );
    if (!normalisedProjection) {
      view.reason = 'The matching projection is empty, so there was no silhouette to compare.';
      views.push(view);
      continue;
    }
    const detail = compareNormalised(normalisedProjection, normalised, { size: canonicalSize });
    view.measured = true;
    view.projection = chosen.best.view;
    view.projectionMargin = chosen.margin ?? null;
    view.iou = detail.iou;
    view.aspectError = detail.aspectError;
    view.coverageDelta = detail.coverageDelta;
    view.contourDistance = detail.contourDistance;
    /* The anchor is the view whose mask IS the verdict's reference, so its
       numbers already enter the decision through `report.silhouette`. */
    view.countsTowardVerdict = anchor && reportUsesAnchor(anchorSlot);
    views.push(view);
  }

  const measured = views.filter((view) => view.measured);
  return {
    ...base,
    views,
    /** Views whose silhouette entered the decision (the anchor only). */
    viewsMeasured: views.filter((view) => view.countsTowardVerdict).map((view) => view.slot),
    /** Measured, but uncalibrated — reported, never decisive. */
    viewsDiagnostic: views
      .filter((view) => view.measured && !view.countsTowardVerdict)
      .map((view) => view.slot),
    /** No pose => no measurement of THIS view's camera; named explicitly. */
    viewsUnmeasured: views.filter((view) => !view.measured).map((view) => ({ slot: view.slot, reason: view.reason })),
    uncalibrated: views
      .filter((view) => !view.countsTowardVerdict)
      .map((view) => ({ slot: view.slot, reason: 'NO_CALIBRATED_CAMERA_POSE' })),
    missingSlots: ['front', 'left', 'back'].filter((slot) => !views.some((view) => view.slot === slot)),
    measuredCount: measured.length,
  };
}

/**
 * Whether the anchor mask is the one the verdict compares. It is when the mask
 * came from the accepted reference cutout or the anchor view's worker mask.
 */
function reportUsesAnchor(anchorSlot) {
  return anchorSlot === 'front';
}

/**
 * Assess a GLB against a reference cutout. Pure with respect to the database: it
 * takes bytes in and returns a report, which is what makes it usable from the
 * approval path, the HTTP surface and a CLI tool alike.
 *
 * @param {object} input
 * @param {Buffer} input.glbBuffer        the stored model bytes
 * @param {Buffer|null} input.cutoutBuffer the accepted reference's prepared cutout
 * @param {object} [input.reference]      provenance of that reference (engine, confidence, warnings)
 * @param {object} [input.thresholds]     overrides
 * @param {string} [input.category]       the product's category, for the depth band
 */
export async function assessGlbBuffer({
  glbBuffer,
  cutoutBuffer = null,
  reference = null,
  thresholds = {},
  referenceIds = [],
  settings = {},
  category = '',
  /* PHASE 9 — the WORKER's own frame measurement for this exact mesh
     (`metrics.orientation`: convention, extents before/after, aspect check).
     Informational: it is surfaced and warned on, never a threshold input. */
  workerOrientation = null,
  /* PHASE 13 — per-view silhouette evidence: the worker's OWN masks of the
     photographs it conditioned on, one bounded PNG each, already validated and
     scoped to reference ids by `3dAssetService`. Every entry is
     {referenceId, slot, width, height, inputSha256, maskSource, maskPngSha256,
      maskPx, maskVersion, buffer}. The FIRST entry for the anchor view is the
     mask the verdict already compares against (`cutoutBuffer`); the others are
     disclosed as UNMEASURED for the verdict because no calibrated camera pose
     exists for them. */
  maskEvidence = [],
  /* How `cutoutBuffer` encodes its silhouette: a photograph cutout carries
     ALPHA, the worker's mask PNG carries GREY LEVELS with no alpha. Reading a
     mask PNG as alpha yields a full frame (see `decodeMaskPng`). */
  cutoutEncoding = 'alpha',
} = {}) {
  const limits = resolveThresholds(thresholds);
  const depthBand = depthBandFor(category, {
    explicit:
      thresholds.minDepthRatio !== undefined ||
      process.env.THREE_QUALITY_MIN_DEPTH_RATIO !== undefined,
    explicitValue: limits.minDepthRatio,
  });
  const reasons = [];
  const warnings = [];
  const note = (list, code, message, metric = null) => list.push({ code, message, metric });
  const critical = (code, message, metric) => note(reasons, code, message, metric);
  const warn = (code, message, metric) => note(warnings, code, message, metric);

  const structural = validateGlb(glbBuffer);
  const report = {
    version: ASSESSMENT_VERSION,
    assessedAt: new Date().toISOString(),
    decision: DECISION_REVIEW,
    structural: {
      ok: Boolean(structural.ok),
      code: structural.code || '',
      message: structural.message || '',
      magic: structural.magic || '',
      gltfVersion: structural.gltfVersion || 0,
      declaredBytes: structural.declaredBytes || 0,
      meshes: structural.meshes || 0,
      materials: structural.materials || 0,
      textures: structural.textures || 0,
    },
    geometry: null,
    /* PHASE 13 — FRAGMENTATION section: the component count AND what the
       components actually are (areas, boxes, share bands). The count alone
       cannot distinguish a bouquet's separate heads from reconstruction
       confetti, which is why the distribution is reported beside it. */
    fragmentation: null,
    silhouette: { available: false, reason: '' },
    /* PHASE 9 — ORIENTATION section: how this model's frame was established
       (worker's measured transform) and which of its views matched the
       reference outline. Reporting only — no threshold reads this. */
    orientation: null,
    materials: null,
    colour: null,
    reference: null,
    reasons,
    warnings,
    thresholds: limits,
    /** The depth band THIS assessment was judged against, and where it came from. */
    depthBand,
    renderer: { kind: 'backend-orthographic', views: VIEW_NAMES, canonicalSize: CANONICAL_SIZE },
    calibration: {
      version: ASSESSMENT_VERSION,
      genuineSamples: 1,
      provisional: true,
      note:
        'Bands are provisional: they were set conservatively against one genuine generated model and synthetic fixtures, so the PASS band is deliberately hard to reach and borderline results require a human.',
    },
  };

  if (!structural.ok) {
    critical('STRUCTURAL_INVALID', `The model is not a usable GLB: ${structural.message}`, structural.code);
    report.decision = DECISION_BLOCKED;
    return report;
  }

  /* ── geometry ─────────────────────────────────────────────────────────── */
  let geometry = null;
  try {
    geometry = measureGeometry(glbBuffer, { fileBytes: glbBuffer.length });
  } catch (err) {
    critical('GEOMETRY_UNREADABLE', `The mesh's geometry could not be read (${err.message}).`, err.code || '');
    report.decision = DECISION_BLOCKED;
    return report;
  }

  report.geometry = {
    fileBytes: geometry.fileBytes,
    meshes: geometry.meshes,
    primitives: geometry.primitives,
    vertices: geometry.vertices,
    triangles: geometry.triangles,
    nonFiniteVertices: geometry.nonFiniteVertices,
    outOfRangeIndices: geometry.outOfRangeIndices,
    degenerateTriangles: geometry.degenerateTriangles,
    degenerateFraction: geometry.triangles ? Number((geometry.degenerateTriangles / geometry.triangles).toFixed(6)) : 0,
    boundaryEdges: geometry.boundaryEdges,
    nonManifoldEdges: geometry.nonManifoldEdges,
    watertight: geometry.watertight,
    bounds: geometry.bounds,
    extents: geometry.extents,
    dimensions: geometry.dimensions,
    flatness: geometry.flatness,
    attributes: geometry.attributes,
    hasNormals: geometry.hasNormals,
    generator: geometry.generator,
    notes: geometry.notes,
    /* Disconnected-component facts (edge-joined triangle islands; null when
       the mesh is too large to analyse safely). The worker drops specks
       BEFORE delivery — a high count HERE means chunks survived it, which is
       exactly what a reviewer must see rather than a silent pass. */
    componentCount: geometry.componentCount ?? null,
    largestComponentShare: geometry.largestComponentShare ?? null,
  };

  const largestExtent = Math.max(...geometry.extents);
  const smallestExtent = Math.min(...geometry.extents);
  const extentRatio = smallestExtent > 0 ? largestExtent / smallestExtent : Infinity;

  report.materials = {
    state: geometry.materialState,
    hasMaterials: geometry.materials > 0,
    hasTextures: geometry.textures > 0,
    hasImages: geometry.images > 0,
    hasUv: geometry.hasUv,
    hasVertexColors: geometry.hasVertexColors,
    materials: geometry.materials,
    textures: geometry.textures,
    images: geometry.images,
    findings: [],
  };
  if (geometry.materialState === 'vertex-colour') {
    report.materials.findings.push({
      code: 'MATERIAL_VERTEX_COLOUR',
      message:
        'Colour is stored per vertex: this model has no material or texture maps, so it is not PBR-textured. It still renders, and material fidelity must not be claimed for it.',
    });
  } else if (geometry.materialState === 'material-only') {
    report.materials.findings.push({
      code: 'MATERIAL_NO_COLOUR_DATA',
      message:
        'A PBR material is present, but there is no texture map and no vertex colour: the surface shows only the material’s own base-colour factor (usually white), so it will not show the product’s colours.',
    });
  } else if (geometry.materialState === 'none') {
    report.materials.findings.push({
      code: 'MATERIAL_NONE',
      message: 'The model carries no material, texture or vertex colour: it will render untextured.',
    });
  }

  /* ── colour (§3 — judged apart from geometry) ─────────────────────────────
   * Colour failure is the failure the review screen kept missing: a model can
   * be watertight, dense and correctly wound and still render as a dark lump.
   * So colour gets its OWN section and its OWN verdict inputs, and the numbers
   * are read from the stored bytes — never from a screenshot. */
  /* Colour findings are REVIEW-grade and land in BOTH lists, exactly like the
     geometry ones: `reasons` drives the decision, `warnings` is what the studio
     renders. Declared here because it must not depend on the geometry helper
     further down. */
  const colourReview = (code, message, metric) => {
    note(reasons, code, message, metric);
    warn(code, message, metric);
  };

  let colourTier = null;
  try {
    colourTier = measureColourTier(glbBuffer);
  } catch (err) {
    // An unreadable colour tier is itself a finding: we cannot claim the model's
    // colour is fine when the colour data cannot be read.
    colourReview('COLOUR_UNREADABLE', `The model's colour data could not be read (${err.message}).`);
  }

  report.colour = colourTier
    ? {
        hasVertexColors: colourTier.hasVertexColors,
        hasBaseColorTexture: colourTier.hasBaseColorTexture,
        hasAuthoredMaterial: colourTier.hasAuthoredMaterial,
        // What a PBR viewer will apply. 1.0 (metal) means the albedo channel is
        // effectively suppressed unless the viewer supplies an environment map.
        effectiveMetallic: colourTier.effectiveMetallic,
        materials: colourTier.materials,
        textures: colourTier.textures,
        images: colourTier.images,
        // No colour source at all is worse than a weak one.
        source: colourTier.hasBaseColorTexture
          ? 'base-colour-texture'
          : colourTier.hasVertexColors
            ? 'vertex-colour'
            : 'none',
        sampledVertices: colourTier.sampledVertices,
        totalVertices: colourTier.totalVertices,
        sampledFully: colourTier.sampledFully,
        metrics: colourTier.stats,
      }
    : { available: false };

  if (colourTier) {
    const m = colourTier.stats;

    // A GLB with NO material is the single most damaging defect for colour: the
    // glTF default is a FULLY METALLIC material, and a metal with no environment
    // to reflect renders dark. That is exactly how a colourful bouquet becomes a
    // black shape in the storefront viewer.
    if (!colourTier.hasAuthoredMaterial && (colourTier.hasVertexColors || colourTier.hasBaseColorTexture)) {
      colourReview(
        'MATERIAL_MISSING_DIELECTRIC',
        'The model carries colour but NO material. glTF viewers fall back to a fully metallic default, which suppresses that colour and renders the model dark. The exporter must write a dielectric PBR material.',
        colourTier.effectiveMetallic
      );
    } else if (colourTier.hasAuthoredMaterial && colourTier.effectiveMetallic >= 0.9 && !colourTier.hasBaseColorTexture) {
      colourReview(
        'MATERIAL_FULLY_METALLIC',
        'The material is fully metallic with no base-colour texture, so its colour comes only from reflections — a flower, leaf, ribbon or paper surface should be dielectric (metallic 0).',
        colourTier.effectiveMetallic
      );
    }

    if (m) {
      if (m.nearBlackFraction > limits.maxNearBlackFraction) {
        colourReview(
          'COLOUR_DARK_COLLAPSE',
          `${(m.nearBlackFraction * 100).toFixed(1)}% of sampled vertices are effectively black (linear luminance < 0.01) — the model will read as a dark shape rather than the photographed product.`,
          m.nearBlackFraction
        );
      }
      if (colourTier.hasVertexColors && m.meanSaturation < limits.minMeanSaturation) {
        colourReview(
          'COLOUR_GREY_COLLAPSE',
          `Mean saturation is ${m.meanSaturation.toFixed(3)} (below ${limits.minMeanSaturation}): the colour data is effectively grey, so the model will not show the product's colours.`,
          m.meanSaturation
        );
      }
      if (m.components === 4 && m.minAlpha < 0.999) {
        colourReview(
          'COLOUR_PARTIAL_ALPHA',
          `Vertex alpha goes down to ${m.minAlpha.toFixed(3)} while the material is opaque, so part of the colour data is being discarded.`,
          m.minAlpha
        );
      }
    }
  }

  /* ── critical structural failures ─────────────────────────────────────── */
  if (geometry.vertices === 0 || geometry.triangles === 0) {
    critical('GEOMETRY_EMPTY', 'The mesh contains no triangles, so there is nothing to show a customer.');
  }
  if (geometry.nonFiniteVertices > 0) {
    critical(
      'GEOMETRY_NON_FINITE',
      `${geometry.nonFiniteVertices} vertex position(s) are not finite numbers, which corrupts any render.`,
      geometry.nonFiniteVertices
    );
  }
  if (geometry.outOfRangeIndices > 0) {
    critical(
      'GEOMETRY_INDEX_OUT_OF_RANGE',
      `${geometry.outOfRangeIndices} triangle(s) index a vertex that does not exist.`,
      geometry.outOfRangeIndices
    );
  }
  if (geometry.triangles < limits.minTriangles) {
    critical(
      'GEOMETRY_TOO_SIMPLE',
      `The mesh has ${geometry.triangles} triangles, below the ${limits.minTriangles} a real reconstruction is expected to carry.`,
      geometry.triangles
    );
  }
  if (geometry.triangles > limits.maxTriangles) {
    critical(
      'GEOMETRY_TOO_DENSE',
      `The mesh has ${geometry.triangles} triangles, above the ${limits.maxTriangles} the viewer is expected to handle.`,
      geometry.triangles
    );
  }
  if (Number.isFinite(largestExtent) && largestExtent <= 0) {
    critical('GEOMETRY_DEGENERATE_BOUNDS', 'The mesh has no extent in any axis.', largestExtent);
  }
  if (geometry.flatness < depthBand.floor) {
    critical(
      'GEOMETRY_FLAT',
      `The mesh is effectively flat (shortest extent is ${(geometry.flatness * 100).toFixed(2)}% of the longest), which is not a 3D product model.`,
      geometry.flatness
    );
  }
  if (extentRatio > limits.maxAspectRatio) {
    critical(
      'GEOMETRY_IMPLAUSIBLE_RATIO',
      `The mesh's extents differ by a factor of ${extentRatio.toFixed(1)}, far beyond a plausible product shape.`,
      Number(extentRatio.toFixed(2))
    );
  }

  /* ── geometry warnings ──────────────────────────────────────────────────
   * Geometry defects are REVIEW-grade, not informational: holes, slivers,
   * flipped normals and no-NORMAL assets all change what a customer sees. They
   * are recorded in BOTH lists, because `reasons` drives the decision while
   * `warnings` is what the studio renders next to the model. */
  const review = (code, message, metric) => {
    note(reasons, code, message, metric);
    warn(code, message, metric);
  };

  /* ── fragmentation: disconnected islands survived delivery ───────────── */
  if (geometry.components) {
    const parts = geometry.components;
    const traceBand = parts.bands[parts.bands.length - 1];
    report.fragmentation = {
      ...parts,
      /* The reading of the numbers, in words, so a reviewer does not have to
         reverse-engineer it — and WITHOUT deciding for them whether a piece is
         a petal: that is a visual question the panel answers, and this text says
         what the numbers can and cannot support. */
      reading: [
        `${parts.count} disconnected piece(s); the largest holds ${((parts.largestShare ?? 0) * 100).toFixed(1)}% of the surface.`,
        parts.counts.substantial > 1
          ? `${parts.counts.substantial} piece(s) are substantial (≥5% of the surface, or a box spanning ≥25% of the model with ≥0.5% of the surface).`
          : 'Only one piece is substantial.',
        traceBand.count
          ? `${traceBand.count} piece(s) are under 0.1% of the surface each, ${(traceBand.areaShare * 100).toFixed(2)}% together.`
          : 'No piece is below 0.1% of the surface.',
        parts.closed.pieces
          ? `${parts.closed.pieces} piece(s) are individually closed (${(parts.closed.areaShare * 100).toFixed(1)}% of the surface); separate closed shells still do not make the union watertight.`
          : 'No piece is individually closed.',
      ].join(' '),
      /* What the analysis CANNOT establish, stated with the section. */
      limits:
        'Measurement cannot name a piece. Whether a separated piece is a bloom, a leaf, a stem or an artefact is decided by looking at the stored model; these numbers say how big it is and where it sits, nothing more.',
    };
  }
  if (geometry.componentCount != null) {
    /* The count is reported WITH its distribution: "the worker drops specks, so
       these must be substantial" was an assumption the measurements do not
       support (the Phase 12 Hunyuan model had 59 pieces and one 99% body). */
    const measured = geometry.components
      ? ` ${geometry.components.counts.substantial} piece(s) are substantial and ${geometry.components.counts.trace} are under 0.1% of the surface; see the fragmentation section.`
      : '';
    if (geometry.componentCount > limits.maxComponents) {
      review(
        'MESH_FRAGMENTED',
        `The mesh is ${geometry.componentCount} disconnected components (more than ${limits.maxComponents}) — scattered islands, not one product.${measured}`,
        geometry.componentCount
      );
    } else if (
      geometry.componentCount > 1 &&
      geometry.largestComponentShare != null &&
      geometry.largestComponentShare < limits.minLargestComponentShare
    ) {
      review(
        'MESH_FRAGMENTED',
        `The largest connected piece holds only ${(geometry.largestComponentShare * 100).toFixed(0)}% of the surface (below ${Math.round(limits.minLargestComponentShare * 100)}%) — the model is split across several sizes of chunk.`,
        geometry.largestComponentShare
      );
    }
  }

  /* ── depth: thin relative to THIS product's category ─────────────────────
   * Above the critical floor but below the category band = suspicious, not
   * fatal: a single-view engine can under-reconstruct depth, and orientation
   * or framing can make a sound model look like a relief. A human inspects the
   * side/three-quarter views; nothing is auto-extruded here. */
  if (geometry.flatness >= depthBand.floor && geometry.flatness < depthBand.minDepthRatio) {
    review(
      'THIN_OUTPUT',
      `The model's thinnest axis is ${(geometry.flatness * 100).toFixed(1)}% of its longest, below the ${(depthBand.minDepthRatio * 100).toFixed(1)}% band for ${
        depthBand.category ? `"${depthBand.category}" (${depthBand.label})` : `a ${depthBand.label}`
      }. Check the stored model's side and three-quarter views: orientation or camera framing can also make a sound model read as a relief.`,
      geometry.flatness
    );
  }

  if (report.geometry.degenerateFraction > limits.maxDegenerateFraction) {
    review(
      'GEOMETRY_DEGENERATE_TRIANGLES',
      `${(report.geometry.degenerateFraction * 100).toFixed(2)}% of triangles are degenerate (zero area) and render as invisible slivers.`,
      report.geometry.degenerateFraction
    );
  }
  if (geometry.boundaryEdges > Math.max(24, geometry.triangles * limits.maxBoundaryEdgeFraction)) {
    review(
      'GEOMETRY_OPEN_SURFACE',
      `The surface is not closed: ${geometry.boundaryEdges} edge(s) belong to a single triangle, so the model has holes.`,
      geometry.boundaryEdges
    );
  }
  if (geometry.nonManifoldEdges > limits.maxNonManifoldEdges) {
    review(
      'GEOMETRY_NON_MANIFOLD',
      `${geometry.nonManifoldEdges} edge(s) are shared by more than two triangles.`,
      geometry.nonManifoldEdges
    );
  }
  if (!geometry.hasNormals) {
    review(
      'GEOMETRY_NO_NORMALS',
      'The mesh stores no NORMAL attribute, so the viewer falls back to flat shading and the surface reads as faceted.'
    );
  }
  if (geometry.fileBytes > limits.warnBytes) {
    review(
      'GEOMETRY_LARGE_FILE',
      `The stored model is ${(geometry.fileBytes / 1024 / 1024).toFixed(1)} MB, which is heavy for a storefront viewer.`,
      geometry.fileBytes
    );
  }
  if (geometry.fileBytes > limits.maxBytes) {
    critical(
      'GEOMETRY_FILE_TOO_LARGE',
      `The stored model is ${(geometry.fileBytes / 1024 / 1024).toFixed(1)} MB, above the ${(limits.maxBytes / 1024 / 1024).toFixed(0)} MB ceiling.`,
      geometry.fileBytes
    );
  }
  if (limits.requireMaterials && !report.materials.hasTextures) {
    critical(
      'MATERIAL_REQUIRED',
      'This deployment requires material or texture maps (THREE_QUALITY_REQUIRE_MATERIALS=1), and this model has none.',
      report.materials.state
    );
  } else {
    /* Material findings are WARNINGS ONLY by default. A vertex-colour model is a
       legitimate generated asset: it must be described honestly (never called
       PBR-textured) and must NOT be held back merely for lacking a UV atlas. A
       deployment that needs texture maps says so explicitly with
       THREE_QUALITY_REQUIRE_MATERIALS=1, which becomes a critical failure above. */
    for (const finding of report.materials.findings) warn(finding.code, finding.message, report.materials.state);
  }

  /* ── silhouette ───────────────────────────────────────────────────────── */
  /** PHASE 13 — the projections built for the verdict, reused by the evidence
   *  section so a three-view comparison costs one rasterisation pass. */
  let silhouetteProjections = null;
  const decoded =
    cutoutEncoding === 'mask-png' ? await decodeMaskPng(cutoutBuffer) : await decodeCutoutMask(cutoutBuffer);
  const referenceJudgement = judgeReference(reference, limits, decoded.ok ? decoded.cleaning : null);

  if (!decoded.ok) {
    report.silhouette = { available: false, reason: decoded.reason };
    note(
      reasons,
      'SILHOUETTE_UNAVAILABLE',
      `${decoded.reason} Without it the shape could not be measured, so the model cannot be passed automatically.`
    );
  } else {
    const referenceNorm = normaliseMask(decoded.mask, { size: CANONICAL_SIZE });
    const referenceCleaning = referenceNorm?.cleaning || null;
    report.reference = {
      ...judgeReference(reference, limits, referenceCleaning),
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
      cutoutAspect: referenceNorm?.sourceAspect ?? null,
      cutoutCoverage: referenceNorm ? Number(referenceNorm.coverage.toFixed(4)) : null,
      cleaning: referenceCleaning,
      frameCentroidOffset: referenceNorm
        ? frameCentroidOffset(decoded.mask.mask, decoded.width, decoded.height)
        : null,
    };

    if (!referenceNorm) {
      report.silhouette = { available: false, reason: "The accepted reference mask is empty." };
      note(reasons, 'SILHOUETTE_UNAVAILABLE', "The accepted reference mask is empty, so no comparison was possible.");
    } else {
      const projections = [];
      for (const view of VIEW_NAMES) {
        try {
          projections.push(rasteriseSilhouette(geometry.positions, geometry.indices, view, { size: 160 }));
        } catch (err) {
          warn('SILHOUETTE_VIEW_FAILED', `The "${view}" projection could not be rendered (${err.message}).`);
        }
      }
      silhouetteProjections = projections;
      const chosen = selectBestView(referenceNorm, projections, {
        size: CANONICAL_SIZE,
        minMargin: limits.minViewMargin,
      });
      const best = chosen.best;

      if (!best) {
        report.silhouette = { available: false, reason: 'No projection of the mesh could be compared.' };
        note(reasons, 'SILHOUETTE_UNAVAILABLE', 'No projection of the mesh could be compared with the reference mask.');
      } else {
        const bestProjection = projections.find((p) => p.view === best.view);
        const normalisedModel = normaliseMask(
          { mask: bestProjection.mask, width: bestProjection.size, height: bestProjection.size },
          { size: CANONICAL_SIZE }
        );
        const detail = compareNormalised(normalisedModel, referenceNorm, { size: CANONICAL_SIZE });

        report.silhouette = {
          available: true,
          reason: '',
          canonicalSize: CANONICAL_SIZE,
          selectedView: best.view,
          selectedViewLabel: best.viewLabel,
          viewAgreement: chosen.agreement,
          viewMargin: chosen.margin,
          /** Views showing an IDENTICAL outline to the winner — usually a mirror. */
          tiedViews: chosen.tiedViews || [],
          distinctSilhouettes: chosen.distinctSilhouettes ?? null,
          orientationCorrected: best.view !== 'front',
          iou: detail.iou,
          aspectError: detail.aspectError,
          modelAspect: detail.modelAspect,
          referenceAspect: detail.referenceAspect,
          modelCoverage: detail.modelCoverage,
          referenceCoverage: detail.referenceCoverage,
          coverageDelta: detail.coverageDelta,
          contourDistancePixels: detail.contourDistancePixels,
          contourDistance: detail.contourDistance,
          modelBoundaryPixels: detail.modelBoundaryPixels,
          referenceBoundaryPixels: detail.referenceBoundaryPixels,
          frameCentroidOffset: frameCentroidOffset(bestProjection.mask, bestProjection.size, bestProjection.size),
          fragmentation: normalisedModel?.cleaning
            ? {
                components: normalisedModel.cleaning.components,
                kept: normalisedModel.cleaning.kept,
                droppedFraction: normalisedModel.cleaning.droppedFraction,
              }
            : null,
          candidates: chosen.candidates.map((c) => ({
            view: c.view,
            viewLabel: c.viewLabel,
            iou: c.iou,
            aspectError: c.aspectError,
            aspect: c.aspect,
            coverage: c.coverage,
          })),
          definitions: {
            iou: 'Intersection over union of the two silhouettes after removing translation and uniform scale.',
            aspectError: '|model aspect − reference aspect| / reference aspect, both from their own trimmed bounding boxes.',
            coverageDelta: 'Absolute difference in the share of the frame each silhouette occupies after the same normalisation.',
            contourDistance: 'Symmetric mean distance between the two silhouette boundaries, in pixels of the canonical grid.',
          },
        };

        if (chosen.agreement === 'ambiguous') {
          note(
            reasons,
            'SILHOUETTE_VIEW_AMBIGUOUS',
            `The best-matching view ("${best.view}") beat the runner-up by only ${(chosen.margin ?? 0).toFixed(3)}, so the orientation is an assumption rather than a fact.`,
            chosen.margin
          );
        }
        if (report.silhouette.fragmentation?.droppedFraction > 0.1) {
          review(
            'SILHOUETTE_FRAGMENTED',
            `${(report.silhouette.fragmentation.droppedFraction * 100).toFixed(1)}% of the model's silhouette was disconnected fragments, which is unusual for a single product.`,
            report.silhouette.fragmentation.droppedFraction
          );
        }

        const severe = detail.iou < limits.blockIou && detail.aspectError > limits.passAspectError;
        const mild = detail.iou < limits.passIou || detail.aspectError > limits.passAspectError;

        if (severe) {
          const doubt = report.reference?.flagged
            ? ' The accepted reference itself carries quality flags, so the reference may be the cause as much as the model.'
            : '';
          if (report.reference?.flagged) {
            note(
              reasons,
              'SILHOUETTE_SEVERE_MISMATCH_DOUBTFUL_REFERENCE',
              `The model's silhouette matches the accepted reference poorly (IoU ${detail.iou}, aspect error ${(detail.aspectError * 100).toFixed(0)}%), but the reference is flagged as doubtful, so this is a review rather than a refusal.${doubt}`,
              detail.iou
            );
          } else {
            critical(
              'SILHOUETTE_SEVERE_MISMATCH',
              `The model's silhouette does not match the accepted product photograph: IoU ${detail.iou} (below ${limits.blockIou}) with an aspect error of ${(detail.aspectError * 100).toFixed(0)}%.${doubt}`,
              detail.iou
            );
          }
        } else if (mild) {
          note(
            reasons,
            'SILHOUETTE_WEAK_MATCH',
            `The model is valid but its silhouette only partially matches the accepted reference (IoU ${detail.iou}, aspect error ${(detail.aspectError * 100).toFixed(0)}%).`,
            detail.iou
          );
        }
      }
    }
  }

  /* ── PHASE 13 — SILHOUETTE EVIDENCE ────────────────────────────────────
   * The worker's own masks of the photographs it conditioned on, disclosed with
   * the facts that identify each one. Only the ANCHOR view (the mask the verdict
   * compares against today) counts; every other view is reported as an
   * uncalibrated consistency check and is explicitly marked as not measured,
   * because no camera pose exists for those frames. */
  report.evidence = await describeMaskEvidence(maskEvidence, {
    projections: silhouetteProjections,
    canonicalSize: CANONICAL_SIZE,
    minMargin: limits.minViewMargin,
    referenceIds,
  });

  if (!report.reference) {
    report.reference = referenceJudgement;
  }

  /* ── PHASE 9 — orientation + coverage section ─────────────────────────── */
  /* Two independent facts, reported side by side:

       workerFrame — the engine-side transform that put the mesh into the glTF
         frame, measured before/after by the worker (never re-derived here);
       viewMatch   — which stored view of the model best matches the reference
         outline, with the margin that made that choice a fact or an assumption.

     Both may only WARN. A single-view engine can legitimately produce an
     uncertain frame or an ambiguous best view; relaxing a threshold to make
     those disappear would hide exactly the doubt a reviewer needs. */
  const sil = report.silhouette?.available ? report.silhouette : null;
  report.orientation = {
    workerFrame: workerOrientation
      ? {
          convention: workerOrientation.convention || '',
          matrix: workerOrientation.matrix || '',
          extentsBefore: Array.isArray(workerOrientation.extentsBefore)
            ? workerOrientation.extentsBefore
            : null,
          extentsAfter: Array.isArray(workerOrientation.extentsAfter)
            ? workerOrientation.extentsAfter
            : null,
          expectedAspect:
            typeof workerOrientation.expectedAspect === 'number'
              ? workerOrientation.expectedAspect
              : null,
          frontAspectRatio:
            typeof workerOrientation.frontAspectRatio === 'number'
              ? workerOrientation.frontAspectRatio
              : null,
          check: workerOrientation.check || 'not-checked',
        }
      : null,
    viewMatch: sil
      ? {
          selectedView: sil.selectedView,
          selectedViewLabel: sil.selectedViewLabel,
          agreement: sil.viewAgreement,
          margin: sil.viewMargin,
          orientationCorrected: sil.orientationCorrected,
          tiedViews: sil.tiedViews || [],
        }
      : null,
    coverage: sil
      ? {
          modelCoverage: sil.modelCoverage,
          referenceCoverage: sil.referenceCoverage,
          delta: sil.coverageDelta,
        }
      : null,
    definitions: {
      workerFrame:
        "The engine's own measured rotation from its native frame into glTF (+Y up), recorded with extents before and after.",
      viewMatch:
        'Which orthographic view of the stored mesh matched the reference outline best, and how far ahead of the runner-up it was.',
      coverage: 'Share of the normalised frame each silhouette occupies, and their absolute difference.',
    },
  };

  if (report.orientation.workerFrame?.check === 'uncertain') {
    warn(
      'ORIENTATION_FRAME_UNCERTAIN',
      `The worker's frame check could not confirm the upright transform against the reference aspect (ratio ${report.orientation.workerFrame.frontAspectRatio}). The model may display rotated — check the Front preset in the viewer before approving.`
    );
  }
  if (report.orientation.workerFrame?.check === 'not-checked') {
    warn(
      'ORIENTATION_FRAME_UNCHECKED',
      'The worker recorded no reference aspect for this job, so the upright transform was applied but not verified against the photograph.'
    );
  }
  if (report.orientation.viewMatch && report.orientation.viewMatch.agreement === 'ambiguous') {
    warn(
      'ORIENTATION_VIEW_AMBIGUOUS',
      'No view of the model clearly matches the reference outline; the reported orientation is an assumption. Inspect the Front and side presets before approving.'
    );
  }

  /* ── decision ─────────────────────────────────────────────────────────── */
  /* The decision is driven by `reasons` ONLY. `warnings` is a separate, purely
     informational channel (material limitations live there), so a described
     limitation cannot quietly become a publication block — and equally, a
     warning cannot be quietly upgraded into a pass either. */
  const CRITICAL_CODES = new Set([
    'STRUCTURAL_INVALID',
    'GEOMETRY_UNREADABLE',
    'GEOMETRY_EMPTY',
    'GEOMETRY_NON_FINITE',
    'GEOMETRY_INDEX_OUT_OF_RANGE',
    'GEOMETRY_TOO_SIMPLE',
    'GEOMETRY_TOO_DENSE',
    'GEOMETRY_DEGENERATE_BOUNDS',
    'GEOMETRY_FLAT',
    'GEOMETRY_IMPLAUSIBLE_RATIO',
    'GEOMETRY_FILE_TOO_LARGE',
    'MATERIAL_REQUIRED',
    'SILHOUETTE_SEVERE_MISMATCH',
  ]);
  const blocked = reasons.some((r) => CRITICAL_CODES.has(r.code));
  report.decision = blocked
    ? DECISION_BLOCKED
    : reasons.length
      ? DECISION_REVIEW
      : DECISION_PASS;

  report.summary =
    report.decision === DECISION_PASS
      ? 'The model is structurally valid and its silhouette matches the accepted reference within the configured bands.'
      : report.decision === DECISION_BLOCKED
        ? 'The model must not be published as it stands: a critical check failed.'
        : 'The model is valid but needs an explicit human review before it can be published.';

  return report;
}

/**
 * Load the accepted references for a product and assess a candidate against them.
 *
 * The reference actually used is the PRIMARY accepted image — the same one
 * `maxInputs: 1` sends to a single-view provider — so the comparison is against
 * the photograph that produced the mesh, not an arbitrary sibling.
 */
export async function loadPrimaryReference(req, referenceIds = [], preferredId = '') {
  const mongoose = (await import('mongoose')).default;
  // `scopeFor` accepts BOTH a staff request (workspace from the session) and
  // the trusted context a deferred agent result carries (workspace from the
  // authoritative job) — the reference is scoped either way.
  const { scopeFor } = await import('../utils/tenancy.js');
  const ProductReferenceImage = mongoose.model('ProductReferenceImage');
  const ids = (Array.isArray(referenceIds) ? referenceIds : [])
    .map((id) => {
      if (!id) return null;
      const str = String(id);
      return mongoose.isValidObjectId(str) ? new mongoose.Types.ObjectId(str) : null;
    })
    .filter(Boolean);
  if (!ids.length) return null;

  // THE PHOTOGRAPH THAT PRODUCED THE MESH wins over the nominal primary: when
  // the worker recorded which candidate it consumed (`inputUsed.id`), THAT is
  // the view to compare against — still inside this job's id set and workspace
  // scope, never an id the caller invented.
  let doc = null;
  const preferred = preferredId ? String(preferredId) : '';
  if (preferred && ids.some((id) => String(id) === preferred)) {
    doc = await ProductReferenceImage.findOne({ ...scopeFor(req), _id: preferred }).catch(() => null);
  }
  if (!doc) {
    doc = await ProductReferenceImage.findOne({
      ...scopeFor(req),
      _id: { $in: ids },
    }).sort({ isPrimary: -1, order: 1 });
  }
  if (!doc) return null;

  // THE MASK SOURCE CHANGED, THE GATE DID NOT.
  //
  // This used to read Phase 1's prepared cutout. Background removal is gone (it
  // destroyed product detail), so the only honest mask left is transparency the
  // SOURCE IMAGE itself carries. A PNG with real alpha still yields a silhouette
  // to compare; an ordinary photograph yields none, which the report states as
  // SILHOUETTE_UNAVAILABLE + REFERENCE_MASK_MISSING — a REVIEW, never a silent
  // pass and never a fabricated mask. `cutout*` names are kept because the
  // stored reports and the audit tooling already speak them; they now mean
  // "reference mask".
  let cutoutBuffer = null;
  const alphaSource = doc.original?.hasAlpha ? doc.original?.storageKey : '';
  if (alphaSource) {
    const { readAsset } = await import('./referenceAssetStorage.js');
    cutoutBuffer = await readAsset(alphaSource).catch(() => null);
  }
  return {
    id: String(doc._id),
    // Provenance of the accepted reference (`processing.engine` is still written
    // by the measurement step, so a legacy row keeps saying what prepared it).
    engine: doc.processing?.engine || '',
    model: doc.processing?.model || '',
    confidence: typeof doc.confidence === 'number' ? doc.confidence : null,
    warnings: Array.isArray(doc.warnings) ? doc.warnings : [],
    status: doc.status || '',
    accepted: Boolean(doc.accepted),
    cutoutAvailable: Boolean(cutoutBuffer?.length),
    cutoutBuffer,
  };
}

/** Assess stored bytes against the product's accepted reference. */
export async function assessCandidate({
  req,
  glbBuffer,
  referenceIds = [],
  settings = {},
  thresholds = {},
  productSlug = '',
  maskOverride = null,
  maskSource = '',
  preferredReferenceId = '',
  /* PHASE 9 — the worker's measured frame facts for this mesh (optional). */
  workerOrientation = null,
  /* PHASE 13 — per-view mask evidence, already validated by `3dAssetService`. */
  maskEvidence = [],
}) {
  const reference = await loadPrimaryReference(req, referenceIds, preferredReferenceId);

  // Category decides the depth band; a lookup failure downgrades to the generic
  // band rather than failing an assessment (a missing catalogue row must not
  // block or unblock a model — the report records which band was used).
  let category = '';
  try {
    if (productSlug) {
      const mongoose = (await import('mongoose')).default;
      const Product = mongoose.model('Product');
      const row = await Product.findOne({ slug: String(productSlug) }).select('category').lean();
      category = row?.category || '';
    }
  } catch {
    category = '';
  }

  // THE MASK HIERARCHY: transparency the source image itself carries wins; the
  // WORKER'S foreground mask of the photograph actually used is the fallback
  // (it is a real, product-only silhouette produced by the current pipeline);
  // with neither, the gate honestly reports SILHOUETTE_UNAVAILABLE +
  // REFERENCE_MASK_MISSING as it does today.
  const workerMask = maskOverride && maskOverride.length ? maskOverride : null;
  const cutoutBuffer = reference?.cutoutBuffer || workerMask;
  const effectiveMaskSource = reference?.cutoutBuffer
    ? 'reference-alpha'
    : workerMask
      ? maskSource || 'worker-foreground-mask'
      : '';

  const report = await assessGlbBuffer({
    glbBuffer,
    cutoutBuffer,
    reference: reference
      ? {
          id: reference.id,
          engine: reference.engine,
          model: reference.model,
          confidence: reference.confidence,
          warnings: reference.warnings,
          cutoutAvailable: Boolean(cutoutBuffer?.length),
          maskSource: effectiveMaskSource,
        }
      : workerMask
        ? {
            id: preferredReferenceId ? String(preferredReferenceId) : null,
            engine: '',
            model: '',
            confidence: null,
            warnings: [],
            cutoutAvailable: true,
            maskSource: effectiveMaskSource,
          }
        : null,
    referenceIds,
    settings,
    thresholds,
    category,
    workerOrientation,
    maskEvidence,
    cutoutEncoding: reference?.cutoutBuffer ? 'alpha' : workerMask ? 'mask-png' : 'alpha',
  });
  report.reference = {
    ...(report.reference || {}),
    id: reference?.id || (preferredReferenceId ? String(preferredReferenceId) : null),
    accepted: reference?.accepted ?? null,
    status: reference?.status || '',
    maskSource: effectiveMaskSource,
  };
  report.category = category;
  return report;
}

export default {
  ASSESSMENT_VERSION,
  DECISION_PASS,
  DECISION_REVIEW,
  DECISION_BLOCKED,
  DECISIONS,
  DEFAULT_THRESHOLDS,
  resolveThresholds,
  fingerprintFor,
  decodeCutoutMask,
  judgeReference,
  assessGlbBuffer,
  assessCandidate,
  loadPrimaryReference,
  describeMaskEvidence,
};
