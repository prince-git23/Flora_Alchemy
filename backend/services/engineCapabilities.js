/**
 * 3D STUDIO — PHASE 11 — THE ENGINE CAPABILITY REGISTRY.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A capture set does not have "a validation flag". It has one verdict PER
 * ENGINE, because the engines disagree about what a valid input even is:
 *
 *   · the shipped TripoSR path takes ONE photograph and ignores the rest;
 *   · Meshy 7.1 takes several ordinary photographs and does not need poses;
 *   · ReLi3D needs `transforms.json` camera-to-world poses and FOV per view;
 *   · Hunyuan3D-2mv takes named views with learned slot embeddings, unposed.
 *
 * The bug this prevents is subtle and expensive: a single `complete: true` on a
 * set with no poses would let a pose-aware engine be handed a set it cannot
 * use, or — worse — invite somebody to "fix" it by inventing camera positions.
 * Here, missing poses make a set ineligible for a pose-requiring engine and
 * leave it perfectly eligible for an engine that does not ask for them.
 *
 * WHAT IS A FACT AND WHAT IS A CLAIM
 * ----------------------------------
 * Every entry carries `evidence`:
 *   · `measured`  — this project ran it and recorded the numbers.
 *   · `verified`  — checked against the provider's own documentation.
 *   · `unverified`— declared from the research, NOT confirmed against a live
 *                   input. An engine in this state is never enabled for
 *                   submission.
 *
 * PURITY
 * ------
 * No database, no network, no environment reads at import time — `enabled` is
 * computed by the caller from the provider facts it already has. That keeps this
 * module unit-testable and keeps the provider policy (never a silent paid
 * fallback) in exactly one place: `3dModelProvider.js`.
 *
 * This module must never be the place a charge is decided. It only says what an
 * engine REQUIRES and what it WOULD receive.
 */

import { VIEW_ANGLES } from './referenceViews.js';
import { isCompletePose, poseConsistency } from './capturePose.js';

/** Stable engine ids — persisted on a capture set and in every submission. */
export const ENGINE_IDS = {
  LOCAL_SINGLE_VIEW: 'local_single_view',
  MESHY_MULTI_IMAGE: 'meshy_multi_image',
  HUNYUAN_2MV: 'hunyuan3d_2mv',
  RELI3D: 'reli3d',
};

/**
 * Deterministic input priority for a multi-view engine.
 *
 * The order is NOT cosmetic: `maxInputs` truncates, so it decides which
 * photographs a metered engine actually receives. Coverage-critical sides come
 * first, then the crown (the structure a bouquet reconstruction loses first),
 * then the obliques, then detail shots that are only ever supporting evidence.
 */
export const VIEW_PRIORITY = [
  'front',
  'back',
  'left',
  'right',
  'top',
  'three-quarter-left',
  'three-quarter-right',
  'bottom',
  'wrapping',
  'detail',
  'texture',
  'other',
];

/** The four sides every capture needs; the crown is recommended, not required. */
export const BASE_REQUIRED_VIEWS = ['front', 'left', 'right', 'back'];
export const BASE_RECOMMENDED_VIEWS = ['top'];

const FORMATS = {
  /** The studio's own accepted upload formats (see referenceImageValidation). */
  studio: ['png', 'jpeg', 'jpg', 'webp'],
};

/**
 * The registry.
 *
 * `installed` means the adapter code exists in THIS build.
 * `enabled` is decided at call time from `providerName` + availability, never
 * hard-coded true, because a capability that claims to be available on a
 * deployment with no provider is a lie the UI will repeat to staff.
 */
export const ENGINE_CAPABILITIES = {
  [ENGINE_IDS.LOCAL_SINGLE_VIEW]: {
    id: ENGINE_IDS.LOCAL_SINGLE_VIEW,
    label: 'Local TripoSR (single photograph)',
    /** Provider policy names that resolve to this engine. */
    providerNames: ['local_worker', 'local_gpu_agent'],
    installed: true,
    multiView: false,
    minInputs: 1,
    maxInputs: 1,
    requiredViews: [],
    recommendedViews: ['front'],
    acceptsUnposed: true,
    requiresPose: false,
    requiresFov: false,
    formats: FORMATS.studio,
    output: { format: 'glb', vertexColours: true, texture: false, materials: 'dielectric (worker-written)' },
    metered: false,
    requiresCredentials: false,
    requiresAuthorisation: false,
    licence: {
      name: 'MIT (TripoSR weights)',
      commercialUse: 'permitted',
      territory: 'worldwide',
      notes: 'Runs on the operator’s own hardware; no product photograph leaves the machine.',
    },
    evidence: {
      source: 'docs/PHASE_10_QUALITY_EVALUATION.md',
      state: 'measured',
      measured: 'Phase 5–10: 1 component, watertight, front silhouette IoU 0.907; the shipped baseline.',
    },
    notes:
      'The working fallback. It selects ONE photograph after masking and does not use the other views jointly — selection, not multi-view.',
  },

  [ENGINE_IDS.MESHY_MULTI_IMAGE]: {
    id: ENGINE_IDS.MESHY_MULTI_IMAGE,
    label: 'Meshy 7.1 (hosted, metered multi-image)',
    providerNames: ['meshy'],
    installed: true,
    multiView: true,
    minInputs: 2,
    maxInputs: 4,
    requiredViews: BASE_REQUIRED_VIEWS,
    recommendedViews: BASE_RECOMMENDED_VIEWS,
    acceptsUnposed: true,
    requiresPose: false,
    requiresFov: false,
    formats: FORMATS.studio,
    output: { format: 'glb', vertexColours: true, texture: 'provider-dependent', materials: 'provider' },
    metered: true,
    requiresCredentials: true,
    requiresAuthorisation: true,
    licence: {
      name: 'Meshy commercial terms (hosted)',
      commercialUse: 'per output ownership terms — verify in the Meshy account before customer delivery',
      territory: 'per agreement',
      notes:
        'Images are TRANSMITTED TO A THIRD PARTY and their retention is governed by Meshy, not by this repository.',
    },
    evidence: {
      source: 'adapters/3dModelProvider.meshySubmit',
      state: 'unverified',
      measured: 'The adapter exists and is opt-in behind THREE_D_PROVIDER=meshy + MESHY_API_KEY. It has NEVER been executed here: no credentials were configured and no charge was authorised.',
    },
    notes:
      'Opt-in and metered. Enabling it requires BOTH provider flags and an explicit authorisation step, so no upload can ever turn into a bill.',
  },

  [ENGINE_IDS.HUNYUAN_2MV]: {
    id: ENGINE_IDS.HUNYUAN_2MV,
    label: 'Hunyuan3D-2mv (local, experimental)',
    providerNames: [],
    installed: false,
    multiView: true,
    minInputs: 2,
    maxInputs: 4,
    requiredViews: BASE_REQUIRED_VIEWS,
    recommendedViews: BASE_RECOMMENDED_VIEWS,
    acceptsUnposed: true,
    requiresPose: false,
    requiresFov: false,
    formats: FORMATS.studio,
    output: { format: 'glb', vertexColours: false, texture: false, materials: 'none' },
    metered: false,
    requiresCredentials: false,
    requiresAuthorisation: true,
    licence: {
      name: 'Tencent Hunyuan Community Licence',
      commercialUse: 'restricted',
      territory: 'excludes the EU, United Kingdom and South Korea',
      notes:
        'Above 1,000,000 MAU a separate written Tencent licence is required. The texture stage needs 16 GB VRAM (shape alone needs 6 GB).',
    },
    evidence: {
      source: 'phaseD/PHASE_D2_REPORT.md',
      state: 'measured',
      measured:
        'Run twice on the RTX 4050. Three views were WORSE than one: aspect 0.82 → 0.60 (a slab), components 1274 → 1333, peak device VRAM 5708 MiB, GLB 10.96 MB, POSITION-only export (no normals/UV/material/texture). The quality gate could not score it at all (no alpha ⇒ no silhouette).',
    },
    notes:
      'Not integrated, and the measurement above is why. The input set — not the model — was the failure: the sheet’s cells disagreed about framing.',
  },

  [ENGINE_IDS.RELI3D]: {
    id: ENGINE_IDS.RELI3D,
    label: 'ReLi3D (local, pose-required)',
    providerNames: [],
    installed: false,
    multiView: true,
    minInputs: 3,
    maxInputs: 8,
    requiredViews: BASE_REQUIRED_VIEWS,
    recommendedViews: BASE_RECOMMENDED_VIEWS,
    acceptsUnposed: false,
    requiresPose: true,
    requiresFov: true,
    formats: FORMATS.studio,
    output: { format: 'glb', vertexColours: true, texture: 'unverified', materials: 'unverified' },
    metered: false,
    requiresCredentials: false,
    requiresAuthorisation: true,
    licence: {
      name: 'Stability AI model licence',
      commercialUse: 'verify before any integration',
      territory: 'per licence text',
      notes: 'Not evaluated for this repository beyond its input contract.',
    },
    evidence: {
      source: 'external research, not measured',
      state: 'unverified',
      measured:
        'Never run here. Its contract asks for camera-to-world poses plus FOV per view (a `transforms.json`), which no capture in this repository has ever carried.',
    },
    notes:
      'Declared so a set can be tested against its REAL requirements. There is no adapter and none may be claimed to work.',
  },
};

/** All engine ids in registry order (stable for UI + tests). */
export const ENGINE_ORDER = Object.keys(ENGINE_CAPABILITIES);

/**
 * The engines a resolved provider name can run.
 * An unknown/unavailable provider maps to nothing — never to a default engine.
 */
export function enginesForProvider(providerName) {
  const name = String(providerName || '').toLowerCase();
  if (!name) return [];
  return ENGINE_ORDER.filter((id) => ENGINE_CAPABILITIES[id].providerNames.includes(name));
}

/**
 * The engine the operator should be offered for the CURRENT provider, or null.
 * Deliberately narrow: a provider with no capability entry yields null rather
 * than being guessed into the single-view bucket, so the UI cannot imply a
 * multi-view engine it does not have.
 */
export function defaultEngineForProvider(providerName) {
  const matches = enginesForProvider(providerName);
  if (matches.length === 0) return null;
  // Exactly one engine per provider today; if that ever changes, prefer the
  // one that can use the most inputs (the point of a capture set).
  return matches.sort((a, b) => ENGINE_CAPABILITIES[b].maxInputs - ENGINE_CAPABILITIES[a].maxInputs)[0];
}

/**
 * The registry entry for an id, or a refusal.
 * Exported as a getter rather than free access so an unknown id is a clear
 * error instead of `undefined` flowing into a persisted record.
 */
export function capabilityFor(engineId) {
  const capability = ENGINE_CAPABILITIES[String(engineId || '')];
  if (!capability) {
    throw Object.assign(new Error(`Unknown reconstruction engine "${engineId}".`), {
      code: 'ENGINE_UNKNOWN',
      status: 422,
    });
  }
  return capability;
}

/**
 * Deterministic input selection.
 *
 * Ordering is total and indifferent to input order: view priority first, then the
 * studio's own `order`, then the row id as the final tie-break. Two calls on the
 * same rows therefore return the same list — which is what makes a persisted
 * submission snapshot checkable against what the provider was sent.
 */
export function selectInputs(rows = [], capability) {
  const views = (rows || []).filter((row) => row && !row.__excluded);
  const priority = new Map(VIEW_PRIORITY.map((view, index) => [view, index]));
  const ranked = [...views].sort((a, b) => {
    const pa = priority.has(a.viewAngle) ? priority.get(a.viewAngle) : VIEW_PRIORITY.length;
    const pb = priority.has(b.viewAngle) ? priority.get(b.viewAngle) : VIEW_PRIORITY.length;
    if (pa !== pb) return pa - pb;
    const oa = Number(a.order || 0);
    const ob = Number(b.order || 0);
    if (oa !== ob) return oa - ob;
    return String(a._id || a.id || '').localeCompare(String(b._id || b.id || ''));
  });
  const max = Number(capability?.maxInputs || 0);
  const selected = max > 0 ? ranked.slice(0, max) : [];
  return {
    selected,
    unused: ranked.slice(selected.length),
    ranked,
  };
}

/** A stable, order-independent fingerprint of the exact input set. */
export function inputFingerprint(inputs = []) {
  const parts = (inputs || []).map((input) =>
    [String(input.id || ''), String(input.viewAngle || ''), String(input.sha256 || '')].join(':')
  );
  // Deliberately not a hash: this value is persisted and shown to a reviewer, so
  // a readable digest is more useful than an opaque one. It changes when the set
  // or its order changes, which is the only property it needs.
  return parts.join('|');
}

/**
 * Evaluate a capture set against ONE engine.
 *
 * Returns the verdict for that engine only. `valid` is about this engine's
 * contract; the set's own lifecycle status is a separate fact owned by the
 * service (a set can be VALIDATED and still ineligible for ReLi3D).
 */
export function evaluateForEngine({ rows = [], profile = {}, capability, enabled = false, reason = '' } = {}) {
  const cap = capabilityFor(capability?.id || capability);
  const errors = [];
  const warnings = [];

  const views = (rows || []).filter(Boolean);
  const completePoses = views.filter((row) => isCompletePose(row.pose));
  const poseFacts = poseConsistency(views.map((row) => row.pose));

  const presentViews = new Set(views.map((row) => row.viewAngle).filter(Boolean));
  const missingViews = (cap.requiredViews || []).filter((view) => !presentViews.has(view));
  const recommendedMissing = (cap.recommendedViews || []).filter((view) => !presentViews.has(view));

  if (!enabled) {
    errors.push({
      code: 'ENGINE_DISABLED',
      message:
        reason ||
        `${cap.label} is not enabled on this deployment, so nothing can be submitted to it.`,
    });
  }
  if (!cap.installed) {
    errors.push({
      code: 'ENGINE_NOT_INSTALLED',
      message: `${cap.label} has no adapter in this build; a capture set can be evaluated against its contract but never submitted to it.`,
    });
  }

  if (views.length < cap.minInputs) {
    errors.push({
      code: 'ENGINE_TOO_FEW_INPUTS',
      message: `${cap.label} needs at least ${cap.minInputs} view${cap.minInputs === 1 ? '' : 's'}; this set has ${views.length}.`,
    });
  }

  for (const view of missingViews) {
    errors.push({
      code: 'VIEW_MISSING',
      message: `${cap.label} requires a "${view}" view and this set has none.`,
      view,
    });
  }

  for (const view of recommendedMissing) {
    warnings.push({
      code: 'VIEW_RECOMMENDED_MISSING',
      message: `No "${view}" view. ${cap.label} can run without it, but that structure is the least constrained.`,
      view,
    });
  }

  // Poses: required by this engine, or merely reported.
  if (cap.requiresPose) {
    if (completePoses.length < views.length) {
      errors.push({
        code: 'POSE_REQUIRED',
        message: `${cap.label} needs a recorded camera pose and field of view for EVERY view; ${completePoses.length} of ${views.length} have one. Record them — a pose is never inferred here.`,
      });
    }
    if (cap.requiresFov && views.some((row) => !Number.isFinite(Number(row.pose?.fov)))) {
      errors.push({
        code: 'FOV_REQUIRED',
        message: `${cap.label} needs a field of view per view; a pose without one is not a calibrated pose.`,
      });
    }
  } else if (completePoses.length > 0 && completePoses.length < views.length) {
    warnings.push({
      code: 'POSE_PARTIAL_COVERAGE',
      message: `${completePoses.length} of ${views.length} views carry a recorded pose. ${cap.label} does not need them, but a future pose-aware engine would refuse this set.`,
    });
  }

  if (!cap.acceptsUnposed && completePoses.length === 0) {
    errors.push({
      code: 'NO_POSES',
      message: `${cap.label} does not accept unposed photographs.`,
    });
  }

  if (poseFacts.fovInconsistent) {
    warnings.push({
      code: 'POSE_FOV_SPREAD',
      message: `The recorded poses range over ${poseFacts.fovSpread.toFixed(1)}° of field of view — this looks like two capture sessions or two lenses.`,
    });
  }
  if (poseFacts.distanceInconsistent) {
    warnings.push({
      code: 'POSE_DISTANCE_SPREAD',
      message: `The recorded camera distances spread ${(poseFacts.distanceSpread * 100).toFixed(0)}% of their mean — the camera probably moved between views.`,
    });
  }

  const formatIssues = [];
  for (const row of views) {
    const format = String(row?.original?.format || '').toLowerCase();
    if (!format) continue; // unmeasured format is reported by the upload path
    if (!cap.formats.includes(format)) {
      formatIssues.push({
        code: 'FORMAT_UNSUPPORTED',
        message: `${row?.original?.fileName || 'A reference'} is ${format}; ${cap.label} accepts ${cap.formats.join(', ')}.`,
        referenceId: String(row._id || row.id || ''),
      });
    }
  }
  errors.push(...formatIssues);

  const selection = selectInputs(views, cap);
  const inputs = selection.selected.map((row) => ({
    id: String(row._id || row.id || ''),
    viewAngle: String(row.viewAngle || ''),
    sha256: String(row?.original?.sha256 || ''),
    order: Number(row.order || 0),
    hasPose: isCompletePose(row.pose),
    pose: row.pose
      ? {
          position: row.pose.position,
          target: row.pose.target,
          fov: row.pose.fov,
          distance: row.pose.distance,
          source: row.pose.source,
        }
      : null,
  }));

  const valid = errors.length === 0;

  /**
   * CAPTURE completeness, separated from DEPLOYMENT availability.
   *
   * `ENGINE_DISABLED` / `ENGINE_NOT_INSTALLED` are facts about this build and this
   * deployment, not about the photographs. A five-view capture is a complete
   * capture whether or not an engine happens to be configured today, and saying
   * otherwise makes the studio report "collecting" forever on a deployment with
   * no provider — which is exactly the state a default install is in.
   */
  const DEPLOYMENT_ONLY_CODES = new Set(['ENGINE_DISABLED', 'ENGINE_NOT_INSTALLED']);
  const captureErrors = errors.filter((entry) => !DEPLOYMENT_ONLY_CODES.has(entry.code));
  const captureValid = captureErrors.length === 0;

  return {
    engineId: cap.id,
    label: cap.label,
    installed: cap.installed,
    enabled: Boolean(enabled),
    valid,
    /** True when the PHOTOGRAPHS satisfy this engine's contract, regardless of
     *  whether the engine is installed or enabled on this deployment. */
    captureValid,
    captureErrors,
    errors,
    warnings,
    missingViews,
    recommendedMissing,
    posesRecorded: completePoses.length,
    posesUsable: cap.requiresPose
      ? completePoses.length === views.length && views.length > 0 && !poseFacts.fovInconsistent
      : completePoses.length > 0 && completePoses.length === views.length,
    poseConsistency: poseFacts,
    maxInputs: cap.maxInputs,
    minInputs: cap.minInputs,
    viewsAccepted: views.length,
    selectedImages: inputs.map((input) => input.id),
    inputs,
    unusedViews: selection.unused.length,
    acceptsUnposed: cap.acceptsUnposed,
    requiresPose: cap.requiresPose,
    metered: cap.metered,
    requirements: {
      minInputs: cap.minInputs,
      maxInputs: cap.maxInputs,
      requiredViews: cap.requiredViews,
      recommendedViews: cap.recommendedViews,
      requiresPose: cap.requiresPose,
      requiresFov: cap.requiresFov,
      acceptsUnposed: cap.acceptsUnposed,
      formats: cap.formats,
    },
    evidence: cap.evidence,
    licence: cap.licence,
    notes: cap.notes,
    validationTimestamp: new Date().toISOString(),
  };
}

/**
 * Every engine, evaluated against the same rows.
 *
 * This is what lets the studio say "this set is ready for Meshy and not for
 * ReLi3D" without the operator guessing, and it is why `complete` can no longer
 * be a single global boolean.
 */
export function evaluateAllEngines({ rows = [], profile = {}, providerName = '', providerAvailable = false, meshyAuthorised = false } = {}) {
  const defaultEngine = defaultEngineForProvider(providerName);
  const verdicts = {};
  for (const engineId of ENGINE_ORDER) {
    const cap = ENGINE_CAPABILITIES[engineId];
    const isCurrent = defaultEngine === engineId;
    const enabled = cap.installed && isCurrent && Boolean(providerAvailable);
    let reason = '';
    if (!cap.installed) {
      reason = `${cap.label} has no adapter in this build.`;
    } else if (!isCurrent) {
      reason = `This deployment is configured for ${providerName || 'no provider'}, not ${cap.label}.`;
    } else if (!providerAvailable) {
      reason = `${cap.label} is selected but not available: its credentials or worker are not configured.`;
    } else if (cap.metered && !meshyAuthorised) {
      reason = `${cap.label} is metered: submission needs an explicit authorisation, so it is not enabled here.`;
    }
    verdicts[engineId] = evaluateForEngine({
      rows,
      profile,
      capability: cap,
      enabled: enabled && (!cap.metered || meshyAuthorised),
      reason,
    });
  }
  return { defaultEngine, verdicts };
}

/** A narrow projection for the studio — never the whole registry with internals. */
export function engineSummaries() {
  return ENGINE_ORDER.map((id) => {
    const cap = ENGINE_CAPABILITIES[id];
    return {
      id: cap.id,
      label: cap.label,
      installed: cap.installed,
      multiView: cap.multiView,
      minInputs: cap.minInputs,
      maxInputs: cap.maxInputs,
      requiresPose: cap.requiresPose,
      acceptsUnposed: cap.acceptsUnposed,
      metered: cap.metered,
      evidence: cap.evidence.state,
      licence: cap.licence.name,
    };
  });
}

export default {
  ENGINE_IDS,
  ENGINE_CAPABILITIES,
  ENGINE_ORDER,
  VIEW_PRIORITY,
  BASE_REQUIRED_VIEWS,
  BASE_RECOMMENDED_VIEWS,
  enginesForProvider,
  defaultEngineForProvider,
  capabilityFor,
  selectInputs,
  inputFingerprint,
  evaluateForEngine,
  evaluateAllEngines,
  engineSummaries,
};

/** Guard: every priority entry must be a real studio viewpoint label. */
for (const view of VIEW_PRIORITY) {
  if (!VIEW_ANGLES.includes(view)) {
    throw new Error(`VIEW_PRIORITY contains "${view}", which is not a studio view label.`);
  }
}
