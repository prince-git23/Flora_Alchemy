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
import { measureGeometry, rasteriseSilhouette, VIEW_NAMES } from './3dMeshGeometry.js';
import {
  CANONICAL_SIZE,
  compareNormalised,
  frameCentroidOffset,
  maskFromPixels,
  normaliseMask,
  selectBestView,
} from './3dSilhouetteMetrics.js';
import { validateGlb } from './3dModelValidation.js';

/** Bumped whenever the MEANING of a report changes, so stale reports are visible. */
export const ASSESSMENT_VERSION = 'phase5-1';

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
  warnBytes: 8 * 1024 * 1024,
  maxBytes: 32 * 1024 * 1024,
  /** Phase 1 confidence below which the accepted cutout is treated as doubtful. */
  referenceMinConfidence: 0.6,
  /** Specks and stray regions are already removed; too many is a warning sign. */
  referenceMaxDroppedFraction: 0.15,
  /** Strict policy: require material maps rather than only warning about them. */
  requireMaterials: false,
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
    requireMaterials:
      process.env.THREE_QUALITY_REQUIRE_MATERIALS === undefined
        ? DEFAULT_THRESHOLDS.requireMaterials
        : process.env.THREE_QUALITY_REQUIRE_MATERIALS === '1',
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
  if (!buffer || !buffer.length) return { ok: false, reason: 'The accepted cutout has no bytes.' };
  try {
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const mask = maskFromPixels(data, info.width, info.height, info.channels);
    if (!mask.mask || mask.error) {
      return { ok: false, reason: 'The accepted cutout contains no subject pixels.' };
    }
    return { ok: true, mask, width: info.width, height: info.height, channels: info.channels };
  } catch (err) {
    return { ok: false, reason: `The accepted cutout could not be decoded (${err.message}).` };
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
      flags.push({ code: 'REFERENCE_CUTOUT_MISSING', message: 'The accepted reference has no prepared cutout on disk.' });
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
        message: `${(cleaning.droppedFraction * 100).toFixed(1)}% of the cutout's subject pixels were disconnected specks that had to be dropped.`,
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
 */
export async function assessGlbBuffer({
  glbBuffer,
  cutoutBuffer = null,
  reference = null,
  thresholds = {},
  referenceIds = [],
  settings = {},
} = {}) {
  const limits = resolveThresholds(thresholds);
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
    silhouette: { available: false, reason: '' },
    materials: null,
    reference: null,
    reasons,
    warnings,
    thresholds: limits,
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
  } else if (geometry.materialState === 'none') {
    report.materials.findings.push({
      code: 'MATERIAL_NONE',
      message: 'The model carries no material, texture or vertex colour: it will render untextured.',
    });
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
  if (geometry.flatness < limits.minFlatness) {
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
  const decoded = await decodeCutoutMask(cutoutBuffer);
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
      report.silhouette = { available: false, reason: 'The accepted cutout produced an empty mask.' };
      note(reasons, 'SILHOUETTE_UNAVAILABLE', 'The accepted cutout produced an empty mask, so no comparison was possible.');
    } else {
      const projections = [];
      for (const view of VIEW_NAMES) {
        try {
          projections.push(rasteriseSilhouette(geometry.positions, geometry.indices, view, { size: 160 }));
        } catch (err) {
          warn('SILHOUETTE_VIEW_FAILED', `The "${view}" projection could not be rendered (${err.message}).`);
        }
      }
      const chosen = selectBestView(referenceNorm, projections, {
        size: CANONICAL_SIZE,
        minMargin: limits.minViewMargin,
      });
      const best = chosen.best;

      if (!best) {
        report.silhouette = { available: false, reason: 'No projection of the mesh could be compared.' };
        note(reasons, 'SILHOUETTE_UNAVAILABLE', 'No projection of the mesh could be compared with the cutout.');
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
            ? ' The accepted cutout itself carries quality flags, so the reference may be the cause as much as the model.'
            : '';
          if (report.reference?.flagged) {
            note(
              reasons,
              'SILHOUETTE_SEVERE_MISMATCH_DOUBTFUL_REFERENCE',
              `The model's silhouette matches the accepted cutout poorly (IoU ${detail.iou}, aspect error ${(detail.aspectError * 100).toFixed(0)}%), but the cutout is flagged as doubtful, so this is a review rather than a refusal.${doubt}`,
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
            `The model is valid but its silhouette only partially matches the accepted cutout (IoU ${detail.iou}, aspect error ${(detail.aspectError * 100).toFixed(0)}%).`,
            detail.iou
          );
        }
      }
    }
  }

  if (!report.reference) {
    report.reference = referenceJudgement;
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
export async function loadPrimaryReference(req, referenceIds = []) {
  const mongoose = (await import('mongoose')).default;
  const { workspaceScope } = await import('../utils/tenancy.js');
  const ProductReferenceImage = mongoose.model('ProductReferenceImage');
  const ids = (Array.isArray(referenceIds) ? referenceIds : [])
    .map((id) => {
      if (!id) return null;
      const str = String(id);
      return mongoose.isValidObjectId(str) ? new mongoose.Types.ObjectId(str) : null;
    })
    .filter(Boolean);
  if (!ids.length) return null;

  const doc = await ProductReferenceImage.findOne({
    ...workspaceScope(req.user),
    _id: { $in: ids },
  }).sort({ isPrimary: -1, order: 1 });
  if (!doc) return null;

  let cutoutBuffer = null;
  const key = doc.cutout?.storageKey || '';
  if (key) {
    const { readAsset } = await import('./referenceAssetStorage.js');
    cutoutBuffer = await readAsset(key).catch(() => null);
  }
  return {
    id: String(doc._id),
    // The engine that produced the cutout lives on `processing`, which is how
    // Phase 1 records provenance; `confidence` and `warnings` are top level.
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
export async function assessCandidate({ req, glbBuffer, referenceIds = [], settings = {}, thresholds = {} }) {
  const reference = await loadPrimaryReference(req, referenceIds);
  const report = await assessGlbBuffer({
    glbBuffer,
    cutoutBuffer: reference?.cutoutBuffer || null,
    reference: reference
      ? {
          id: reference.id,
          engine: reference.engine,
          model: reference.model,
          confidence: reference.confidence,
          warnings: reference.warnings,
          cutoutAvailable: reference.cutoutAvailable,
        }
      : null,
    referenceIds,
    settings,
    thresholds,
  });
  report.reference = {
    ...(report.reference || {}),
    id: reference?.id || null,
    accepted: reference?.accepted ?? null,
    status: reference?.status || '',
  };
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
};
