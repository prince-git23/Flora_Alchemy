/**
 * 3D STUDIO — PHASE 11 — the CAPTURE SET service.
 *
 * WHAT THIS SERVICE OWNS
 * ----------------------
 * Everything that is a property of a SET of photographs rather than of one image
 * inside the reference studio, or of one generation job:
 *
 *   · coverage — which view angles a capture has, and which required ones are
 *     missing;
 *   · duplicate detection — two rows that are the same bytes is a capture error,
 *     not two views;
 *   · the lifecycle — draft → collecting → validated → submitted → processing →
 *     completed / failed, with transitions enforced HERE so no request payload
 *     can move a set;
 *   · the ONE authoritative submission plan (which exact reference ids, in which
 *     order, go to which engine) and its immutable, append-only audit record.
 *
 * WHAT IT DOES NOT OWN
 * --------------------
 * Uploading/cutting/accepting views stays in the reference studio; pose
 * arithmetic stays in `capturePose.js`; engine contracts stay in
 * `engineCapabilities.js`; provider policy and inference stay in
 * `3dModelProvider.js` / `3dGenerationService.js`. Nothing here edits a
 * photograph, and no upload path writes here — a capture set changes only in
 * response to an explicit request.
 *
 * ENGINE-SPECIFIC BY DESIGN
 * -------------------------
 * There is deliberately NO single `complete` flag that decides everything.
 * `validateCaptureSet()` returns a verdict PER ENGINE, because Meshy accepts
 * unposed photographs and ReLi3D refuses them. A missing pose must block the
 * engine that needs one and must NOT block the engine that does not.
 *
 * THE HONEST-BY-CONSTRUCTION GRAPH (Phase D/D2's lesson)
 * ------------------------------------------------------
 * What failed in the real multi-view run was not the engine's capacity but the
 * INPUT SET: a confirmed 12-panel render sheet whose cells disagreed about
 * framing. The sheet is now provenance and never a view, and this module refuses
 * to submit anything that has not been measured complete for the chosen engine.
 */

import CaptureSet from '../models/CaptureSet.js';
import ProductReferenceImage from '../models/ProductReferenceImage.js';
import Product from '../models/Product.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { isCompletePose, poseConsistency } from './capturePose.js';
import { VIEW_ANGLES } from './referenceViews.js';
import { isSourceSheet } from './referenceImageService.js';
import { workspaceScope, getWorkspaceId } from '../utils/tenancy.js';
import {
  BASE_REQUIRED_VIEWS,
  BASE_RECOMMENDED_VIEWS,
  ENGINE_IDS,
  capabilityFor,
  defaultEngineForProvider,
  evaluateAllEngines,
  inputFingerprint,
  selectInputs,
  ENGINE_CAPABILITIES,
} from './engineCapabilities.js';

/* ── lifecycle ───────────────────────────────────────────────────────────── */

export const LIFECYCLE = [
  'draft',
  'collecting',
  'validated',
  'submitted',
  'processing',
  'completed',
  'failed',
  'archived',
];

/**
 * Legal transitions. `submitted` may be re-entered from `completed`/`failed` so a
 * legitimate re-shoot can be resubmitted — but never from `submitted` or
 * `processing`, which is what makes a double click a no-op instead of a second
 * provider request.
 */
export const TRANSITIONS = {
  draft: ['collecting', 'validated', 'archived'],
  collecting: ['draft', 'validated', 'failed', 'archived'],
  validated: ['collecting', 'draft', 'submitted', 'archived'],
  submitted: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: ['validated', 'collecting', 'submitted', 'archived'],
  failed: ['collecting', 'validated', 'submitted', 'archived'],
  archived: [],
};

/** The states a new submission may start from. */
export const SUBMITTABLE_STATES = ['validated', 'completed', 'failed'];

export function canTransition(from, to) {
  return (TRANSITIONS[String(from || '')] || []).includes(String(to || ''));
}

/**
 * Move a set, or refuse. Every write path goes through here so the stored status
 * is always a state the server chose.
 */
export async function transition(set, to, extra = {}) {
  if (!set) throw new ApiError(404, 'No capture set.', 'CAPTURE_SET_NOT_FOUND');
  if (!LIFECYCLE.includes(to)) {
    throw new ApiError(500, `"${to}" is not a capture-set state.`, 'CAPTURE_SET_STATE_INVALID');
  }
  if (set.status === to) return set;
  if (!canTransition(set.status, to)) {
    throw new ApiError(
      409,
      `A capture set cannot go from ${set.status} to ${to}.`,
      'CAPTURE_SET_TRANSITION_REFUSED'
    );
  }
  set.status = to;
  for (const [key, value] of Object.entries(extra)) set[key] = value;
  await set.save();
  return set;
}

/* ── observability helpers ───────────────────────────────────────────────── */

const issue = (code, message, extra = {}) => ({ code, message, ...extra });
const referenceIdOf = (row) => String(row?._id || row?.id || '');
const fileNameOf = (row) => String(row?.original?.fileName || row?.label || 'reference');

/**
 * Same rule the reference studio uses to present a set: only rows the
 * administrator ACCEPTED are candidate inputs, and a confirmed composite sheet is
 * provenance rather than a view.
 */
export function candidateRows(rows = []) {
  const viewRows = [];
  const sheets = [];
  for (const row of rows || []) {
    if (!row) continue;
    if (isSourceSheet(row)) {
      sheets.push(row);
      continue;
    }
    viewRows.push(row);
  }
  return { viewRows, sheets };
}

/* ── validation ──────────────────────────────────────────────────────────── */

/**
 * Structural validation — facts about the SET that are true whatever engine is
 * chosen. Unknown view labels, duplicate bytes, an unlabelled photograph and a
 * sheet masquerading as coverage are capture errors, not engine opinions.
 */
export function structuralValidation(rows = []) {
  const { viewRows, sheets } = candidateRows(rows);
  const errors = [];
  const warnings = [];

  // Duplicate BYTES: two rows with the same sha256 are one photograph filed
  // twice, not two viewpoints.
  const byHash = new Map();
  for (const row of viewRows) {
    const hash = String(row?.original?.sha256 || '');
    if (!hash) continue;
    if (byHash.has(hash)) {
      errors.push(
        issue(
          'DUPLICATE_IMAGE',
          'This reference is the same bytes as an already-present reference — one photograph filed under two rows. Remove one copy before submitting.',
          { referenceId: referenceIdOf(row) }
        )
      );
    } else {
      byHash.set(hash, row);
    }
  }

  // Coverage: a row's viewAngle is the ONLY coverage fact (never inferred).
  const perView = new Map(VIEW_ANGLES.map((view) => [view, []]));
  for (const row of viewRows) {
    const view = String(row?.viewAngle || '');
    if (view === '') {
      warnings.push(
        issue('VIEW_UNLABELLED', `${fileNameOf(row)} has no view-angle label yet, so its coverage cannot be counted. Label it in the studio.`, {
          referenceId: referenceIdOf(row),
        })
      );
      continue;
    }
    if (!perView.has(view)) {
      errors.push(
        issue('VIEW_UNKNOWN', `The label "${view}" is not one of the capture vocabulary entries.`, {
          referenceId: referenceIdOf(row),
          view,
        })
      );
      continue;
    }
    perView.get(view).push(referenceIdOf(row));
  }

  const coverage = VIEW_ANGLES.map((view) => {
    const ids = (perView.get(view) || []).filter(Boolean);
    return {
      view,
      required: BASE_REQUIRED_VIEWS.includes(view),
      recommended: BASE_RECOMMENDED_VIEWS.includes(view),
      present: ids.length > 0,
      ids,
    };
  });

  for (const entry of coverage) {
    if (entry.ids.length > 1) {
      warnings.push(
        issue('DUPLICATE_VIEW', `${entry.view} is labelled on ${entry.ids.length} rows; one of them is probably a re-shoot, and only the highest-priority one is sent.`, {
          view: entry.view,
        })
      );
    }
  }

  const missing = coverage.filter((entry) => entry.required && !entry.present).map((entry) => entry.view);

  // A sheet is PROVENANCE. Its presence is fine and is stated as a fact, never
  // counted as a viewpoint.
  for (const sheet of sheets) {
    warnings.push(
      issue(
        'SHEET_EXCLUDED_FROM_VIEWS',
        `The confirmed composite sheet "${fileNameOf(sheet)}" is kept as PROVENANCE only — its views were cut into separate rows and the sheet itself is never a reconstruction input.`,
        { referenceId: referenceIdOf(sheet) }
      )
    );
  }

  const completePoses = viewRows.filter((row) => isCompletePose(row.pose));
  const poseFacts = poseConsistency(viewRows.map((row) => row.pose));

  return {
    viewRows,
    sheets,
    coverage,
    missing,
    errors,
    warnings,
    counts: {
      totalRows: (rows || []).length,
      views: viewRows.length,
      sheets: sheets.length,
      requiredPresent: coverage.filter((entry) => entry.required && entry.present).length,
      requiredTotal: BASE_REQUIRED_VIEWS.length,
      optionalPresent: coverage.filter((entry) => !entry.required && entry.present).length,
      labelled: coverage.reduce((sum, entry) => sum + (entry.present ? 1 : 0), 0),
      posesRecorded: completePoses.length,
    },
    poseConsistency: poseFacts,
    posesComplete: completePoses.length === viewRows.length && viewRows.length > 0,
  };
}

/**
 * The full validation: structural facts plus a verdict PER ENGINE.
 *
 * `provider` is the CALLER's already-resolved provider fact set
 * (`{ name, available }`), passed in so this module never reads the environment
 * and so a test can describe any deployment honestly.
 */
export function validateCaptureSet({
  rows = [],
  profile = {},
  provider = {},
  meshyAuthorised = false,
} = {}) {
  const structural = structuralValidation(rows);
  const providerName = String(provider?.name || '');
  const providerAvailable = Boolean(provider?.available);

  const { defaultEngine, verdicts } = evaluateAllEngines({
    rows: structural.viewRows,
    profile,
    providerName,
    providerAvailable,
    meshyAuthorised,
  });

  const engines = Object.values(verdicts);
  // `complete` is a statement about the PHOTOGRAPHS: some engine's input contract
  // is satisfied by them. Whether that engine is installed or enabled on this
  // deployment is a SEPARATE fact (`readyFor`), so an unconfigured install does
  // not report a complete capture as "collecting".
  const validFor = engines.filter((verdict) => verdict.captureValid).map((v) => v.engineId);
  const readyFor = engines.filter((verdict) => verdict.valid && verdict.enabled).map((v) => v.engineId);
  const complete = structural.errors.length === 0 && structural.missing.length === 0 && validFor.length > 0;

  const errors = [...structural.errors];
  const warnings = [...structural.warnings];
  if (defaultEngine && verdicts[defaultEngine]) {
    // Surface the current engine's refusals at the top level, because that is
    // the one the operator can act on right now.
    errors.push(...verdicts[defaultEngine].errors.filter((e) => e.code !== 'ENGINE_DISABLED'));
    warnings.push(...verdicts[defaultEngine].warnings);
  }

  return {
    complete,
    validFor,
    /** Engines that could be submitted to RIGHT NOW on this deployment. */
    readyFor,
    defaultEngineId: defaultEngine || '',
    structural,
    engines: verdicts,
    engineList: engines,
    missing: structural.missing,
    errors: dedupeIssues(errors),
    warnings: dedupeIssues(warnings),
    coverage: structural.coverage,
    counts: structural.counts,
    poseConsistency: structural.poseConsistency,
    posesUsable: engines.some((verdict) => verdict.installed && verdict.posesUsable),
    referenceIds: structural.viewRows.map(referenceIdOf).filter(Boolean),
    checkedAt: new Date(),
  };
}

function dedupeIssues(list = []) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry || !entry.code) continue;
    const key = `${entry.code}:${entry.referenceId || ''}:${entry.view || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/* ── records ─────────────────────────────────────────────────────────────── */

/**
 * Find or create the set for a product slug or a DRAFT key inside a workspace.
 *
 * A draft key is never trusted on its own: the caller must already own reference
 * rows filed under it in the same workspace, which is what stops a guessed key
 * from being adopted. A slug must resolve to a real product or to reference rows
 * the caller owns.
 */
export async function ensureCaptureSet({ user, productSlug = '', draftKey = '', engineId = '' } = {}) {
  const scope = workspaceScope(user);
  const slug = String(productSlug || '');
  const draft = String(draftKey || '');

  if (!slug && !draft) {
    throw new ApiError(422, 'A capture set needs a product slug or a draft key.', 'CAPTURE_SET_SCOPE_REQUIRED');
  }

  const query = slug ? { ...scope, productSlug: slug } : { ...scope, draftKey: draft };
  const existing = await CaptureSet.findOne(query);
  if (existing) {
    if (engineId && existing.engineId !== engineId) {
      existing.engineId = engineId;
      await existing.save();
    }
    return existing;
  }

  // Ownership proof BEFORE creating the record.
  const ownedRows = await ProductReferenceImage.countDocuments(
    slug ? { ...scope, productSlug: slug } : { ...scope, draftKey: draft }
  );
  if (ownedRows === 0) {
    if (slug) {
      const product = await Product.findOne({ slug }).select('_id workspaceId').lean();
      const callerWorkspace = getWorkspaceId(user);
      const sameWorkspace =
        product && (!product.workspaceId || !callerWorkspace || String(product.workspaceId) === String(callerWorkspace));
      if (!product || !sameWorkspace) {
        throw new ApiError(404, 'No such product in this workspace.', 'CAPTURE_SET_PRODUCT_NOT_FOUND');
      }
    } else {
      // Fail closed: an empty, guessed draft key must not create a record.
      throw new ApiError(
        404,
        'No reference images are filed under that draft, so there is nothing to capture.',
        'CAPTURE_SET_DRAFT_NOT_FOUND'
      );
    }
  }

  let productId = null;
  if (slug) {
    const product = await Product.findOne({ slug }).select('_id').lean();
    productId = product?._id || null;
  }

  try {
    return await CaptureSet.create({
      ...scope,
      productSlug: slug,
      draftKey: draft,
      productId,
      engineId,
      status: 'draft',
      createdBy: user?._id ?? null,
    });
  } catch (err) {
    // Unique index race: another request created it first — read it back.
    if (err?.code === 11000) {
      const raced = await CaptureSet.findOne(query);
      if (raced) return raced;
    }
    throw err;
  }
}

export async function getCaptureSet({ user, productSlug = '', draftKey = '' } = {}) {
  const scope = workspaceScope(user);
  const slug = String(productSlug || '');
  const draft = String(draftKey || '');
  if (!slug && !draft) {
    throw new ApiError(422, 'A capture set needs a product slug or a draft key.', 'CAPTURE_SET_SCOPE_REQUIRED');
  }
  const set = await CaptureSet.findOne(slug ? { ...scope, productSlug: slug } : { ...scope, draftKey: draft });
  if (!set) throw new ApiError(404, 'No capture set has been started for this product yet.', 'CAPTURE_SET_NOT_FOUND');
  return set;
}

/** The rows a set is measuring. Only the caller's workspace can contribute. */
export async function loadRowsForSet(user, set) {
  const scope = workspaceScope(user);
  const filter = set.productSlug ? { ...scope, productSlug: set.productSlug } : { ...scope, draftKey: set.draftKey };
  const rows = await ProductReferenceImage.find({ ...filter, accepted: true })
    .sort({ order: 1, createdAt: 1 })
    .lean({ virtuals: false });
  return rows.map((row) => ({ ...row, id: String(row._id) }));
}

/**
 * Persist the validation this server just performed and move the set to the
 * state that validation implies. `validated` means "an INSTALLED engine accepts
 * this set" — never "the operator said so".
 */
export async function refreshCaptureSet({ user, set, provider = {}, meshyAuthorised = false, profilePatch } = {}) {
  if (profilePatch) await applyProfile({ set, profilePatch, updatedBy: user?._id });

  const rows = await loadRowsForSet(user, set);
  const validation = validateCaptureSet({
    rows,
    profile: set.profile || {},
    provider,
    meshyAuthorised,
  });

  set.validation = {
    complete: validation.complete,
    checkedAt: validation.checkedAt,
    missing: validation.missing,
    // Stored as `issues` (Mongoose reserves `errors`); the API projects it back.
    issues: validation.errors,
    warnings: validation.warnings,
    coverage: validation.coverage,
    counts: validation.counts,
    engines: Object.values(validation.engines).map((verdict) => ({
      engineId: verdict.engineId,
      label: verdict.label,
      installed: verdict.installed,
      enabled: verdict.enabled,
      valid: verdict.valid,
      missingViews: verdict.missingViews,
      recommendedMissing: verdict.recommendedMissing,
      posesRecorded: verdict.posesRecorded,
      posesUsable: verdict.posesUsable,
      selectedImages: verdict.selectedImages,
      unusedViews: verdict.unusedViews,
      maxInputs: verdict.maxInputs,
      issues: verdict.errors,
      warnings: verdict.warnings,
    })),
    referenceIds: validation.referenceIds,
  };
  set.engineId = set.engineId || validation.defaultEngineId || '';
  set.markModified('validation');

  // State follows measurement. `submitted`/`processing` are owned by the submit
  // path and must not be reset by a read-triggered refresh.
  if (!['submitted', 'processing'].includes(set.status)) {
    if (rows.length === 0) {
      if (canTransition(set.status, 'draft')) set.status = 'draft';
    } else if (validation.complete) {
      if (canTransition(set.status, 'validated')) set.status = 'validated';
      else if (set.status === 'validated') set.status = 'validated';
    } else if (canTransition(set.status, 'collecting')) {
      set.status = 'collecting';
    }
  }

  await set.save();
  return { set, validation, rows };
}

/* ── profile ─────────────────────────────────────────────────────────────── */

export const PROFILE_TEXT_FIELDS = ['rig', 'camera', 'lens', 'lighting', 'notes'];
export const PROFILE_NUMERIC_FIELDS = ['distanceMetres', 'fovDegrees'];
export const PROFILE_BACKGROUNDS = ['', 'plain-seamless', 'transparent', 'studio-white', 'other'];

/**
 * A capture set's PROFILE: facts about the RIG. Every write goes through here so
 * a client cannot smuggle a computed field (`distance`, `posesUsable`) in
 * alongside the human-recorded ones.
 */
export function normaliseProfile(input = {}) {
  const profile = {};
  for (const key of PROFILE_TEXT_FIELDS) {
    if (input[key] === undefined) continue;
    const value = String(input[key] ?? '');
    if (value.length > 400) {
      throw new ApiError(422, `profile.${key} is over 400 characters.`, 'PROFILE_INVALID');
    }
    profile[key] = value;
  }
  for (const key of PROFILE_NUMERIC_FIELDS) {
    if (input[key] === undefined) continue;
    if (input[key] === null || input[key] === '') {
      profile[key] = null;
      continue;
    }
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value <= 0 || value > 10000) {
      throw new ApiError(422, `profile.${key} must be a positive physical measurement.`, 'PROFILE_INVALID');
    }
    profile[key] = value;
  }
  if (input.background !== undefined) {
    const background = String(input.background ?? '');
    if (!PROFILE_BACKGROUNDS.includes(background)) {
      throw new ApiError(422, 'profile.background must be one of the catalogue values.', 'PROFILE_INVALID');
    }
    profile.background = background;
  }
  return profile;
}

export async function applyProfile({ set, profilePatch = {}, updatedBy = null }) {
  set.profile = {
    ...(set.profile?.toObject ? set.profile.toObject() : set.profile || {}),
    ...normaliseProfile(profilePatch),
    updatedAt: new Date(),
    updatedBy: updatedBy ?? null,
  };
  set.markModified('profile');
  await set.save();
  return set;
}

/* ── the submission plan ─────────────────────────────────────────────────── */

/**
 * THE authoritative plan. One function decides which exact reference ids are
 * sent, in which order, to which engine.
 *
 * The bug this closes: the earlier draft returned every view id while the
 * provider adapter truncated to `maxInputs`, so the audit record and the actual
 * request could disagree. Here the same `selectInputs()` used by validation
 * produces the ids that are returned AND persisted AND handed to the generator.
 */
export function buildSubmissionPlan({
  rows = [],
  profile = {},
  engineId = '',
  provider = {},
  meshyAuthorised = false,
} = {}) {
  const capability = capabilityFor(engineId);
  const validation = validateCaptureSet({ rows, profile, provider, meshyAuthorised });
  const verdict = validation.engines[capability.id];

  if (!verdict) {
    throw new ApiError(422, `No verdict could be produced for ${capability.label}.`, 'ENGINE_UNKNOWN');
  }
  if (!verdict.installed) {
    throw new ApiError(
      422,
      `${capability.label} has no adapter in this build, so it cannot be submitted to.`,
      'ENGINE_NOT_INSTALLED'
    );
  }
  // ORDER MATTERS: a metered engine that is merely un-authorised must say THAT,
  // not "disabled". The operator can act on "authorise the charge"; they cannot
  // act on a generic refusal.
  if (verdict.metered && !meshyAuthorised) {
    throw new ApiError(
      422,
      `${capability.label} is metered and this submission was not authorised. Confirm the charge explicitly to submit, so an upload can never turn into a bill.`,
      'ENGINE_NOT_AUTHORISED'
    );
  }
  if (!verdict.enabled) {
    throw new ApiError(422, verdict.errors.find((e) => e.code === 'ENGINE_DISABLED')?.message || `${capability.label} is not enabled on this deployment.`, 'ENGINE_DISABLED');
  }
  if (!verdict.valid) {
    throw new ApiError(
      422,
      `${capability.label} would refuse this set: ${verdict.errors.map((e) => e.message).join(' ')}`,
      'CAPTURE_SET_INVALID_FOR_ENGINE'
    );
  }

  const plan = {
    engineId: capability.id,
    engineLabel: capability.label,
    inputMode: capability.multiView ? 'multi_view' : 'single_view',
    metered: capability.metered,
    inputs: verdict.inputs,
    inputIds: verdict.selectedImages,
    viewsSent: verdict.inputs.length,
    unusedViews: verdict.unusedViews,
    payloadFingerprint: inputFingerprint(verdict.inputs),
    warnings: verdict.warnings,
    validation,
  };

  // A plan that silently dropped views is reported, never hidden.
  if (plan.inputIds.length === 0) {
    throw new ApiError(422, 'The plan selected no images.', 'PLAN_EMPTY');
  }
  return plan;
}

/* ── submission audit (append-only) ──────────────────────────────────────── */

/**
 * Atomically claim a set for ONE submission.
 *
 * The state guard is the concurrency control: two simultaneous submits see
 * `validated` at most once, so a double click can never bill twice. It re-reads
 * and re-plans inside the claim so the ids written to the audit are the ids the
 * caller is about to send.
 */
export async function claimForSubmission({ user, set, plan }) {
  const claimed = await CaptureSet.findOneAndUpdate(
    {
      _id: set._id,
      ...workspaceScope(user),
      status: { $in: SUBMITTABLE_STATES },
      activeJobId: '',
    },
    { $set: { status: 'submitted', engineId: plan.engineId, activeJobId: `pending-${plan.payloadFingerprint.slice(0, 24)}` } },
    { new: true }
  );

  if (!claimed) {
    const current = await CaptureSet.findById(set._id);
    throw new ApiError(
      409,
      current && !SUBMITTABLE_STATES.includes(current.status)
        ? `This capture set is ${current?.status}, so it cannot be submitted again right now. Re-validate it first.`
        : 'Another submission for this capture set is already in flight.',
      'CAPTURE_SET_BUSY'
    );
  }
  return claimed;
}

/**
 * Append the audit record of a submission the caller executed. Append-only by
 * construction: nothing here updates a previous entry, so history survives edits.
 */
export async function appendSubmission({ set, plan, user, jobId = '', providerTaskId = '', outcome = 'requested', note = '' }) {
  const entry = {
    at: new Date(),
    by: user?._id ?? null,
    engineId: plan.engineId,
    engineLabel: plan.engineLabel,
    inputMode: plan.inputMode,
    inputs: plan.inputs.map((input) => ({
      referenceId: input.id,
      viewAngle: input.viewAngle,
      sha256: input.sha256,
      order: input.order,
      hasPose: input.hasPose,
      pose: input.pose || null,
    })),
    inputIds: plan.inputIds,
    viewsSent: plan.viewsSent,
    unusedViews: plan.unusedViews,
    payloadFingerprint: plan.payloadFingerprint,
    providerTaskId: providerTaskId || '',
    jobId: jobId || '',
    outcome,
    note: note || '',
  };

  set.submissions.push(entry);
  await set.save();
  return set.submissions[set.submissions.length - 1];
}

/** Settle a claimed submission: link the job, or record the failure honestly. */
export async function settleSubmission({ set, plan, user, jobId, providerTaskId, outcome, note, nextStatus }) {
  set.activeJobId = jobId || '';
  if (nextStatus && canTransition(set.status, nextStatus)) set.status = nextStatus;
  if (!jobId) set.activeJobId = '';
  await set.save();
  return appendSubmission({ set, plan, user, jobId, providerTaskId, outcome, note });
}

/**
 * Execute a submission end to end: plan → claim → generate → append.
 *
 * This lives in the SERVICE rather than the controller for two reasons: the
 * ordering is business logic (a claim that is never settled leaves a set stuck),
 * and it is the only way to test the real sequence without an HTTP round trip.
 *
 * `startGeneration` is injected so a suite can keep every other stage real while
 * substituting the provider, exactly as `3d-studio-smoke.mjs` does.
 */
export async function executeSubmission({
  user,
  set,
  engineId = '',
  acknowledgeMetered = false,
  meteredAuthorised = false,
  provider = {},
  notes = '',
  label = '',
  startGeneration,
} = {}) {
  if (typeof startGeneration !== 'function') {
    throw new ApiError(500, 'executeSubmission needs a startGeneration function.', 'SUBMISSION_WIRING');
  }

  const capability = capabilityFor(engineId || set?.engineId || '');

  if (capability.metered && acknowledgeMetered !== true) {
    throw new ApiError(
      422,
      `${capability.label} is a metered provider. Confirm the charge explicitly before submitting.`,
      'ENGINE_NOT_AUTHORISED'
    );
  }

  if (!set?.productSlug) {
    throw new ApiError(
      422,
      'Generation runs against a saved product, so finish creating the product before submitting this set.',
      'CAPTURE_SET_NEEDS_PRODUCT'
    );
  }

  const rows = await loadRowsForSet(user, set);
  const plan = buildSubmissionPlan({
    rows,
    profile: set.profile || {},
    engineId: capability.id,
    provider,
    meshyAuthorised: meteredAuthorised,
  });

  const claimed = await claimForSubmission({ user, set, plan });

  let started;
  try {
    started = await startGeneration({
      productSlug: set.productSlug,
      referenceIds: plan.inputIds,
      quality: 'standard',
      notes: String(notes || '').slice(0, 1000),
      label: String(label || `Capture set — ${plan.viewsSent} view(s)`).slice(0, 200),
    });
  } catch (err) {
    await recordFailure({
      set: claimed,
      code: err?.code || 'SUBMISSION_FAILED',
      message: err?.message || 'The generation could not be started.',
    });
    await appendSubmission({
      set: claimed,
      plan,
      user,
      outcome: 'failed',
      note: err?.message || 'The generation could not be started.',
    });
    throw err;
  }

  const job = started?.job || started;
  const jobId = String(job?.jobId || job?.id || started?.jobId || '');
  const submission = await settleSubmission({
    set: claimed,
    plan,
    user,
    jobId,
    providerTaskId: String(job?.providerTaskId || ''),
    outcome: jobId ? 'accepted' : 'requested',
    nextStatus: 'processing',
  });

  return { set: claimed, plan, submission, rows };
}

export async function recordFailure({ set, code, message }) {
  set.failure = { code: String(code || ''), message: String(message || ''), at: new Date() };
  set.activeJobId = '';
  if (canTransition(set.status, 'failed')) set.status = 'failed';
  await set.save();
  return set;
}

export async function archiveCaptureSet(set) {
  return transition(set, 'archived', { archivedAt: new Date() });
}

/* ── read models ─────────────────────────────────────────────────────────── */

/**
 * The studio's view of a set. Live-recomputed validation is returned alongside
 * the stored one so a stale snapshot can be seen as stale.
 */
export function presentCaptureSet(set, { validation, rows = [] } = {}) {
  const json = typeof set.toJSON === 'function' ? set.toJSON() : { ...set };
  delete json.workspaceId;
  delete json.createdBy;
  return {
    ...json,
    // Project the stored `issues` back to the client vocabulary (`errors`).
    validation: json.validation
      ? {
          ...json.validation,
          errors: json.validation.issues || [],
          engines: (json.validation.engines || []).map((engine) => ({
            ...engine,
            errors: engine.issues || [],
          })),
          issues: undefined,
        }
      : {},
    live: validation
      ? {
          complete: validation.complete,
          validFor: validation.validFor,
          readyFor: validation.readyFor,
          defaultEngineId: validation.defaultEngineId,
          missing: validation.missing,
          errors: validation.errors,
          warnings: validation.warnings,
          coverage: validation.coverage,
          counts: validation.counts,
          posesUsable: validation.posesUsable,
          engines: Object.values(validation.engines).map((verdict) => ({
            engineId: verdict.engineId,
            label: verdict.label,
            installed: verdict.installed,
            enabled: verdict.enabled,
            valid: verdict.valid,
            missingViews: verdict.missingViews,
            recommendedMissing: verdict.recommendedMissing,
            posesRecorded: verdict.posesRecorded,
            posesUsable: verdict.posesUsable,
            selectedImages: verdict.selectedImages,
            unusedViews: verdict.unusedViews,
            maxInputs: verdict.maxInputs,
            requirements: verdict.requirements,
            evidence: verdict.evidence,
            licence: verdict.licence,
            notes: verdict.notes,
            errors: verdict.errors,
            warnings: verdict.warnings,
          })),
          checkedAt: validation.checkedAt,
        }
      : null,
    liveRowCount: (rows || []).length,
  };
}

/**
 * Where the POSE of a row is stored — on the row itself, NOT here. A view's pose
 * is a property of that photograph, so it lives on ProductReferenceImage, the
 * same document that holds its label. The write path is
 * `PATCH /api/references/:id` with `{ pose }`.
 */
export const POSE_STORAGE_NOTE = {
  storedOn: 'ProductReferenceImage.pose',
  writtenBy: 'PATCH /api/references/:id',
  sources: ['manual', 'imported'],
  readBy: ['capture-set validation', 'submission plan', 'reconstruction export'],
};

export {
  BASE_REQUIRED_VIEWS as REQUIRED_VIEWS,
  BASE_RECOMMENDED_VIEWS as RECOMMENDED_VIEWS,
  ENGINE_CAPABILITIES,
  ENGINE_IDS,
  defaultEngineForProvider,
  selectInputs,
  capabilityFor,
};

export default {
  LIFECYCLE,
  TRANSITIONS,
  SUBMITTABLE_STATES,
  canTransition,
  transition,
  structuralValidation,
  validateCaptureSet,
  ensureCaptureSet,
  getCaptureSet,
  loadRowsForSet,
  refreshCaptureSet,
  normaliseProfile,
  applyProfile,
  buildSubmissionPlan,
  executeSubmission,
  claimForSubmission,
  appendSubmission,
  settleSubmission,
  recordFailure,
  archiveCaptureSet,
  presentCaptureSet,
  POSE_STORAGE_NOTE,
};
