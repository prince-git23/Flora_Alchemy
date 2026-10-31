/**
 * 3D STUDIO — PHASE 11 — MULTI-VIEW CAPTURE (focused suite).
 *
 * Self-contained: own database (Flora-Alchemy-Test-CaptureSet) and its own
 * private media roots under the OS temp directory, so nothing here touches dev
 * or production data or files.
 *
 * ═══ WHAT IS REAL, AND WHAT IS A TEST DOUBLE — READ THIS FIRST ═══
 *
 * NO INFERENCE HAPPENS AND NO PROVIDER IS CONTACTED. The hosted adapter is
 * metered, so requiring it would make this suite a bill; the provider
 * IMPLEMENTATION is substituted with an explicit double
 * (`registerTestProvider`), exactly as `3d-studio-smoke.mjs` does, and the
 * transport itself is replaced so no network call can occur. The bytes the double
 * "downloads" are a genuine GLB container this suite builds.
 *
 * Everything else is real: real reference rows with real files on disk, the real
 * pose field and PATCH route, the real capture-set model and lifecycle, the real
 * engine registry, the real submission plan, the real HTTP routes and their gates.
 *
 * What it proves, by section:
 *
 *   §A ENGINE REGISTRY — the contracts are declared once, with an explicit
 *      evidence state, and nothing claims to be installed that is not.
 *   §B ENGINE-SPECIFIC VALIDATION — the SAME rows are valid for an engine that
 *      accepts unposed photographs and invalid for one that requires poses.
 *      Missing views, duplicate bytes, composite sheets and truncation are
 *      reported per engine, never as one global flag.
 *   §C POSE CONTRACT — a pose is recorded, never inferred: partial, fabricated and
 *      degenerate poses are refused, and a drifting rig is warned about.
 *   §D LIFECYCLE — transitions are enforced server-side; a request cannot set a
 *      status.
 *   §E PERSISTENCE — the pose really is stored on the reference row, the
 *      validation snapshot is persisted, and submission history is APPEND-ONLY.
 *   §F SUBMISSION PLAN — the plan's ids ARE the ids the provider is handed, and a
 *      double claim cannot submit twice.
 *   §G HTTP SURFACE — authentication, staff role, workspace and permission gates;
 *      a status cannot be forced; a metered submission is refused without an
 *      explicit authorisation.
 *   §H REAL SUBMISSION — through the double, the recorded input ids equal the
 *      plan's, the job exists, and a second immediate submit is refused.
 *
 * Run: npm run test:capture
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import {
  BACKEND_DIR,
  bootTestServer,
  stopTestServer,
  testMongoUri,
  loadBackendEnv,
  pinFilesystemMediaDriver,
} from './lib/testServer.mjs';
import { buildGlb } from './lib/glbFixture.mjs';
import { buildReferencePng } from './lib/meshFixtures.mjs';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Product from '../models/Product.js';
import ProductReferenceImage from '../models/ProductReferenceImage.js';
import GenerationJob, { JOB_STATUSES_ACTIVE } from '../models/GenerationJob.js';
import Product3DAsset from '../models/Product3DAsset.js';
import CaptureSet from '../models/CaptureSet.js';

const PORT = Number(process.env.CAPTURE_SET_PORT || 4131);
const DB_NAME = 'Flora-Alchemy-Test-CaptureSet';

const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a REAL generation job to leave the active states.
 *
 * WHY THIS EXISTS: `startGeneration` deliberately returns an ACCEPTED job and
 * runs the provider detached (`void runJob(...)`), so "the call returned" says
 * nothing about whether the provider has been contacted. Measuring provider
 * calls at that instant is a RACE: it passed on a fast developer machine and
 * failed in CI reading 0 submissions, while a later assertion in the same test
 * read 1. The fix is to measure after the job is terminal, not after acceptance.
 *
 * This polls the SHIPPED `getJob()` — the same read the studio uses — and fails
 * with everything needed to diagnose a stuck job.
 */
async function waitForJobTerminal(req, jobId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await generation.getJob(req, jobId);
    if (!JOB_STATUSES_ACTIVE.includes(last.status)) return last;
    await sleep(400);
  }
  throw new Error(
    `job ${jobId} never left an active state within ${timeoutMs} ms ` +
      `(last: ${last?.status}, providerTaskId: ${last?.providerTaskId || 'none'}, ` +
      `failure: ${last?.failure?.message || 'none'})`
  );
}

/** Both stores resolve their roots AT IMPORT, so pin them before importing them. */
const MEDIA_DIR = path.join(os.tmpdir(), `flora-capture-${stamp}`);
const THREE_MEDIA_ROOT = path.join(MEDIA_DIR, '3d-media');
const REFERENCE_MEDIA_DIR = path.join(MEDIA_DIR, 'reference-media');
process.env.THREE_MEDIA_ROOT = THREE_MEDIA_ROOT;
process.env.REFERENCE_MEDIA_DIR = REFERENCE_MEDIA_DIR;
pinFilesystemMediaDriver();

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

const referenceStorage = await import('../services/referenceAssetStorage.js');
const provider = await import('../services/3dModelProvider.js');
const generation = await import('../services/3dGenerationService.js');
const capture = await import('../services/captureSetService.js');
const engines = await import('../services/engineCapabilities.js');
const poses = await import('../services/capturePose.js');

// ══════════ harness ══════════
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✘ ${name} ${detail}`.trimEnd());
  }
}
const section = (title) => console.log(`\n— ${title} —`);

function containsValue(value, needle, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.includes(needle);
  if (typeof value !== 'object') return false;
  return Object.values(value).some((child) => containsValue(child, needle, depth + 1));
}

async function refusal(fn) {
  try {
    await fn();
    return 'no refusal';
  } catch (err) {
    return `${err.status || ''}:${err.code || err.message}`;
  }
}

await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  Workspace.init(),
  User.init(),
  Product.init(),
  ProductReferenceImage.init(),
  GenerationJob.init(),
  CaptureSet.init(),
]);

const wsA = await Workspace.create({ slug: `capture-a-${stamp}`, displayName: 'Capture A', status: 'ACTIVE' });
const wsB = await Workspace.create({ slug: `capture-b-${stamp}`, displayName: 'Capture B', status: 'ACTIVE' });

const P = (name) => `${name}-Passw0rd-${stamp}!`;
const makeUser = ({ email, password, role, name, workspaceId, permissions }) =>
  User.create({
    email,
    passwordHash: bcrypt.hashSync(password, 10),
    role,
    name,
    status: 'ACTIVE',
    ...(workspaceId ? { workspaceId } : {}),
    ...(permissions ? { permissions } : {}),
  });

const adminAEmail = `capture-admin-a-${stamp}@capture.test`;
const adminBEmail = `capture-admin-b-${stamp}@capture.test`;
const limitedEmail = `capture-limited-${stamp}@capture.test`;
const orphanEmail = `capture-orphan-${stamp}@capture.test`;
const userA = await makeUser({ email: adminAEmail, password: P('AdminA'), role: 'admin', name: 'Capture Admin A', workspaceId: wsA._id });
const userB = await makeUser({ email: adminBEmail, password: P('AdminB'), role: 'admin', name: 'Capture Admin B', workspaceId: wsB._id });
await makeUser({ email: limitedEmail, password: P('Limited'), role: 'handler', name: 'No Permission Handler', workspaceId: wsA._id, permissions: [] });
await makeUser({ email: orphanEmail, password: P('Orphan'), role: 'admin', name: 'Workspace-less Admin' });

const slugA = `capture-product-a-${stamp}`;
const slugB = `capture-product-b-${stamp}`;
await Product.create({ slug: slugA, name: 'Capture Product A', price: 1400, workspaceId: wsA._id });
await Product.create({ slug: slugB, name: 'Capture Product B', price: 950, workspaceId: wsB._id });

const reqA = { user: userA, workspaceSlug: wsA.slug };
const reqB = { user: userB, workspaceSlug: wsB.slug };

console.log(`[capture] test database: ${DB_NAME}`);
console.log(`[capture] private media root: ${REFERENCE_MEDIA_DIR}`);
console.log('[capture] provider: EXPLICIT TEST DOUBLE (no inference, no network)');

// ══════════ §A ══════════
section('§A ENGINE REGISTRY — declared once, with an explicit evidence state');

check('every engine declares an id, input limits and an evidence state', engines.ENGINE_ORDER.every((id) => {
  const cap = engines.ENGINE_CAPABILITIES[id];
  return cap.id === id && Number.isFinite(cap.minInputs) && Number.isFinite(cap.maxInputs) && ['measured', 'verified', 'unverified'].includes(cap.evidence.state);
}));
check('an engine with no adapter in this build says so (Hunyuan 2mv, ReLi3D)', !engines.ENGINE_CAPABILITIES.hunyuan3d_2mv.installed && !engines.ENGINE_CAPABILITIES.reli3d.installed);
check('the shipped TripoSR path and the hosted adapter ARE installed', engines.ENGINE_CAPABILITIES.local_single_view.installed && engines.ENGINE_CAPABILITIES.meshy_multi_image.installed);
check('only the hosted engine is metered', engines.ENGINE_ORDER.filter((id) => engines.ENGINE_CAPABILITIES[id].metered).join(',') === 'meshy_multi_image');
check('only ReLi3D requires camera poses', engines.ENGINE_ORDER.filter((id) => engines.ENGINE_CAPABILITIES[id].requiresPose).join(',') === 'reli3d');
check('the local worker provider maps to the single-view engine', engines.defaultEngineForProvider('local_worker') === 'local_single_view');
check('the meshy provider maps to the multi-image engine', engines.defaultEngineForProvider('meshy') === 'meshy_multi_image');
check('an unavailable provider maps to NO engine (never a guessed default)', engines.defaultEngineForProvider('local_unavailable') === null);
check('an unknown engine id is refused, not silently undefined', (await refusal(() => engines.capabilityFor('trellis2'))) === '422:ENGINE_UNKNOWN');
check('the measured Hunyuan run is recorded as a WORSE three-view result, not a success', /worse/i.test(engines.ENGINE_CAPABILITIES.hunyuan3d_2mv.evidence.measured));
check('the registry never claims ReLi3D was run here', /never run/i.test(engines.ENGINE_CAPABILITIES.reli3d.evidence.measured));
check('the hosted adapter is recorded as NEVER executed', /never been executed/i.test(engines.ENGINE_CAPABILITIES.meshy_multi_image.evidence.measured));
check('the Hunyuan licence limitation is stated (territory + MAU trigger)', /excludes the EU/i.test(engines.ENGINE_CAPABILITIES.hunyuan3d_2mv.licence.territory) && /1,000,000/.test(engines.ENGINE_CAPABILITIES.hunyuan3d_2mv.licence.notes));
check('every priority view is a real studio label', engines.VIEW_PRIORITY.every((view) => ['front', 'back', 'left', 'right', 'top', 'bottom', 'three-quarter-left', 'three-quarter-right', 'detail', 'texture', 'wrapping', 'other'].includes(view)));

// ══════════ §B ══════════
section('§B ENGINE-SPECIFIC VALIDATION — one set, different verdicts');

const poseFor = (x, z) => ({
  position: { x, y: 0, z },
  target: { x: 0, y: 0, z: 0 },
  fov: 40,
  distance: Math.hypot(x, z),
  source: 'manual',
});
const rowOf = (id, viewAngle, hash, extra = {}) => ({
  _id: id,
  id,
  viewAngle,
  order: 0,
  accepted: true,
  original: { sha256: hash, fileName: `${viewAngle}.png`, format: 'png' },
  ...extra,
});

const fourViews = [
  rowOf('r-front', 'front', 'hash-front', { pose: poseFor(0, 2), order: 0 }),
  rowOf('r-back', 'back', 'hash-back', { pose: poseFor(0, -2), order: 1 }),
  rowOf('r-left', 'left', 'hash-left', { pose: poseFor(-2, 0), order: 2 }),
  rowOf('r-right', 'right', 'hash-right', { pose: poseFor(2, 0), order: 3 }),
];

const meshyVerdict = engines.evaluateForEngine({ rows: fourViews, capability: 'meshy_multi_image', enabled: true });
const reliVerdict = engines.evaluateForEngine({ rows: fourViews, capability: 'reli3d', enabled: true });
const singleVerdict = engines.evaluateForEngine({ rows: fourViews, capability: 'local_single_view', enabled: true });

check('four labelled side views are VALID for the multi-image engine', meshyVerdict.valid, JSON.stringify(meshyVerdict.errors.map((e) => e.code)));
check('the same rows are refused by ReLi3D only because it has no adapter here', reliVerdict.errors.some((e) => e.code === 'ENGINE_NOT_INSTALLED'));
check('no refusal of the multi-image engine is about poses', !meshyVerdict.errors.some((e) => /POSE|FOV/.test(e.code)));
check('the single-view engine accepts the same set and sends exactly ONE image', singleVerdict.valid && singleVerdict.selectedImages.length === 1);
check('the single-view engine reports the other three views as unused', singleVerdict.unusedViews === 3, String(singleVerdict.unusedViews));
check('the single-view engine has inputMode single_view and the multi-image one multi_view',
  engines.ENGINE_CAPABILITIES.local_single_view.multiView === false && engines.ENGINE_CAPABILITIES.meshy_multi_image.multiView === true);

const unposed = fourViews.map((row) => ({ ...row, pose: null }));
const reliUnposed = engines.evaluateForEngine({ rows: unposed, capability: 'reli3d', enabled: true });
const meshyUnposed = engines.evaluateForEngine({ rows: unposed, capability: 'meshy_multi_image', enabled: true });
check('STRIPPING the poses makes the pose-requiring engine refuse (POSE_REQUIRED)', reliUnposed.errors.some((e) => e.code === 'POSE_REQUIRED'));
check('STRIPPING the poses does NOT block the engine that needs none', meshyUnposed.valid, JSON.stringify(meshyUnposed.errors.map((e) => e.code)));
check('a pose-less set states posesUsable=false for the pose-requiring engine', reliUnposed.posesUsable === false);
check('a pose-less set does not claim poses are usable for the multi-image engine either', meshyUnposed.posesUsable === false);

const missingBack = fourViews.filter((row) => row.viewAngle !== 'back');
const meshyMissing = engines.evaluateForEngine({ rows: missingBack, capability: 'meshy_multi_image', enabled: true });
check('a missing required view is reported BY NAME', meshyMissing.missingViews.join(',') === 'back', meshyMissing.missingViews.join(','));
check('a missing required view makes the set invalid for that engine', meshyMissing.valid === false && meshyMissing.errors.some((e) => e.code === 'VIEW_MISSING'));

const withoutTop = engines.evaluateForEngine({ rows: fourViews, capability: 'meshy_multi_image', enabled: true });
check('a missing TOP view is a recommendation, never an error', withoutTop.valid && withoutTop.warnings.some((w) => w.code === 'VIEW_RECOMMENDED_MISSING'));

const structuralDup = capture.structuralValidation([
  rowOf('d1', 'front', 'same-hash'),
  rowOf('d2', 'back', 'same-hash'),
  rowOf('d3', 'left', 'other-hash'),
  rowOf('d4', 'right', 'third-hash'),
]);
check('two rows with the same BYTES are a duplicate-image error', structuralDup.errors.some((e) => e.code === 'DUPLICATE_IMAGE'));

const sheetRow = rowOf('sheet', '', 'sheet-hash', { composite: { confirmed: true, panelCount: 12 } });
const structuralSheet = capture.structuralValidation([...fourViews, sheetRow]);
check('a confirmed composite sheet is EXCLUDED from view coverage', structuralSheet.viewRows.length === 4 && structuralSheet.sheets.length === 1);
check('the sheet is reported as provenance, not silently ignored', structuralSheet.warnings.some((w) => w.code === 'SHEET_EXCLUDED_FROM_VIEWS'));
check('the sheet does not count as a labelled view', !structuralSheet.coverage.some((entry) => entry.ids.includes('sheet')));

const unlabelled = capture.structuralValidation([...fourViews, rowOf('n1', '', 'unlabelled-hash')]);
check('an unlabelled photograph is a warning, not coverage', unlabelled.warnings.some((w) => w.code === 'VIEW_UNLABELLED'));
check('an unknown label is an ERROR (it cannot be counted at all)', capture.structuralValidation([rowOf('x1', 'sideways', 'h-x')]).errors.some((e) => e.code === 'VIEW_UNKNOWN'));

const fiveViews = [...fourViews, rowOf('r-top', 'top', 'hash-top', { order: 4 })];
const meshyFive = engines.evaluateForEngine({ rows: fiveViews, capability: 'meshy_multi_image', enabled: true });
check('selection truncates to the engine input limit', meshyFive.selectedImages.length === 4, meshyFive.selectedImages.join(','));
check('the truncated view is reported as unused rather than dropped silently', meshyFive.unusedViews === 1);
check('priority keeps the four sides before the crown when truncating', meshyFive.selectedImages.join(',') === 'r-front,r-back,r-left,r-right', meshyFive.selectedImages.join(','));

const reversed = [...fiveViews].reverse();
const meshyReversed = engines.evaluateForEngine({ rows: reversed, capability: 'meshy_multi_image', enabled: true });
check('selection is DETERMINISTIC regardless of input order', meshyReversed.selectedImages.join(',') === meshyFive.selectedImages.join(','), meshyReversed.selectedImages.join(','));

const badFormat = engines.evaluateForEngine({
  rows: [rowOf('f1', 'front', 'h-f1', { original: { sha256: 'h-f1', fileName: 'f.heic', format: 'heic' } })],
  profile: {},
  capability: 'meshy_multi_image',
  enabled: true,
});
check('an unsupported image format is refused with its filename', badFormat.errors.some((e) => e.code === 'FORMAT_UNSUPPORTED' && /heic/.test(e.message)));

const disabledVerdict = engines.evaluateForEngine({ rows: fourViews, capability: 'meshy_multi_image', enabled: false, reason: 'not configured here' });
check('an unavailable engine is reported as such, with the reason', disabledVerdict.valid === false && disabledVerdict.errors.some((e) => e.code === 'ENGINE_DISABLED' && /not configured here/.test(e.message)));

const allEngines = engines.evaluateAllEngines({ rows: fourViews, providerName: 'meshy', providerAvailable: true, meshyAuthorised: false });
check('evaluateAllEngines returns a verdict per engine', Object.keys(allEngines.verdicts).length === engines.ENGINE_ORDER.length);
check('the meshy verdict is NOT enabled without an explicit metered authorisation', allEngines.verdicts.meshy_multi_image.enabled === false);
check(
  'an INSTALLED engine that is not the selected one says so (rather than pretending)',
  /configured for/.test(allEngines.verdicts.local_single_view.errors.find((e) => e.code === 'ENGINE_DISABLED')?.message || '')
);
check(
  'an engine with no adapter says THAT instead of blaming the deployment',
  /no adapter in this build/.test(allEngines.verdicts.reli3d.errors.find((e) => e.code === 'ENGINE_DISABLED')?.message || '')
);

// ══════════ §C ══════════
section('§C POSE CONTRACT — recorded, never inferred');

check('a complete pose is accepted and its distance is DERIVED', (() => {
  const pose = poses.normalisePose({ position: { x: 0, y: 0, z: 3 }, target: { x: 0, y: 0, z: 0 }, fov: 35 });
  return pose.distance === 3 && pose.source === 'manual';
})());
check('a pose without a field of view is refused (POSE_INCOMPLETE)', (await refusal(() => poses.normalisePose({ position: { x: 0, y: 0, z: 2 }, target: { x: 0, y: 0, z: 0 } }))) === '422:POSE_INCOMPLETE');
check('a partially specified position is refused', (await refusal(() => poses.normalisePose({ position: { x: 0, y: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 40 }))) === '422:POSE_INVALID');
check('a non-finite coordinate is refused', (await refusal(() => poses.normalisePose({ position: { x: 'abc', y: 0, z: 2 }, target: { x: 0, y: 0, z: 0 }, fov: 40 }))) === '422:POSE_INVALID');
check('a fabricated provenance ("inferred") is refused', (await refusal(() => poses.normalisePose({ position: { x: 0, y: 0, z: 2 }, target: { x: 0, y: 0, z: 0 }, fov: 40, source: 'inferred' }))) === '422:POSE_SOURCE_INVALID');
check('an imported provenance IS accepted', poses.normalisePose({ position: { x: 0, y: 0, z: 2 }, target: { x: 0, y: 0, z: 0 }, fov: 40, source: 'imported' }).source === 'imported');
check('a degenerate pose (camera at its target) is refused', (await refusal(() => poses.normalisePose({ position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 40 }))) === '422:POSE_DEGENERATE');
check('an absurd field of view is refused', (await refusal(() => poses.normalisePose({ position: { x: 0, y: 0, z: 2 }, target: { x: 0, y: 0, z: 0 }, fov: 400 }))) === '422:POSE_OUT_OF_RANGE');
check('null clears a pose explicitly', poses.normalisePose(null) === null);
check('isCompletePose rejects a pose with no source', poses.isCompletePose({ position: { x: 0, y: 0, z: 2 }, target: { x: 0, y: 0, z: 0 }, fov: 40, distance: 2 }) === false);

const driftConsistency = poses.poseConsistency([
  { ...poseFor(0, 2), fov: 40 },
  { ...poseFor(0, 3), fov: 62 },
]);
check('a field-of-view spread across views is detected as two rigs', driftConsistency.fovInconsistent === true, JSON.stringify(driftConsistency));
check('a camera-distance spread is detected as a moved camera', driftConsistency.distanceInconsistent === true);
check('a single pose cannot be inconsistent', poses.poseConsistency([poseFor(0, 2)]).fovInconsistent === false);

// ══════════ §D ══════════
section('§D LIFECYCLE — the server decides the state');

check('a new set starts in draft', (await (async () => {
  const set = await capture.ensureCaptureSet({ user: userA, productSlug: slugA });
  return set.status === 'draft';
})()) === true);
const lifecycleSet = await capture.ensureCaptureSet({ user: userA, productSlug: slugA });
check('draft → submitted is refused (validation cannot be skipped)', (await refusal(() => capture.transition(lifecycleSet, 'submitted'))) === '409:CAPTURE_SET_TRANSITION_REFUSED');
check('draft → collecting is allowed', (await (async () => { await capture.transition(lifecycleSet, 'collecting'); return lifecycleSet.status === 'collecting'; })()));
check('archived is terminal', (await refusal(() => capture.transition({ ...lifecycleSet.toObject(), status: 'archived' }, 'collecting'))) === '409:CAPTURE_SET_TRANSITION_REFUSED');
check('an unknown state is refused outright', (await refusal(() => capture.transition(lifecycleSet, 'approved'))) === '500:CAPTURE_SET_STATE_INVALID');
check('only the submit path may start from validated/completed/failed', capture.SUBMITTABLE_STATES.join(',') === 'validated,completed,failed');

// ══════════ §E ══════════
section('§E PERSISTENCE — the pose lives on the row, history is append-only');

const acceptedPng = await buildReferencePng({ width: 96, height: 96 });
async function makeReference(workspace, productSlug, viewAngle, order, width = 96) {
  const doc = await ProductReferenceImage.create({
    workspaceId: workspace._id,
    productSlug,
    status: 'READY',
    accepted: true,
    order,
    label: viewAngle,
    viewAngle,
    original: { fileName: `${viewAngle}.png`, format: 'png', hasAlpha: true },
  });
  const buffer = width === 96 ? acceptedPng : await buildReferencePng({ width, height: width });
  const written = await referenceStorage.writeAsset({
    imageId: doc._id,
    workspaceSlug: workspace.slug,
    kind: 'original',
    buffer,
    format: 'png',
  });
  doc.original = { ...(doc.original.toObject?.() ?? {}), storageKey: written.storageKey, bytes: written.bytes, sha256: written.sha256 };
  await doc.save();
  return doc;
}

const refFront = await makeReference(wsA, slugA, 'front', 0, 96);
const refBack = await makeReference(wsA, slugA, 'back', 1, 97);
const refLeft = await makeReference(wsA, slugA, 'left', 2, 98);
const refRight = await makeReference(wsA, slugA, 'right', 3, 99);
const refTop = await makeReference(wsA, slugA, 'top', 4, 100);
const refB1 = await makeReference(wsB, slugB, 'front', 0, 101);

const refs = await import('../services/referenceImageService.js');
const posedRow = await refs.updateReferenceImage(reqA, String(refFront._id), {
  pose: { position: { x: 0, y: 0, z: 2 }, target: { x: 0, y: 0, z: 0 }, fov: 40, source: 'manual' },
});
check('a pose is persisted on the reference row itself', posedRow.pose?.fov === 40 && posedRow.pose?.distance === 2);
check('the pose records WHO recorded it', String(posedRow.pose?.recordedBy || '') === String(userA._id));
check('the pose records when it was recorded', posedRow.pose?.recordedAt instanceof Date);
check('the original hash is untouched by a pose write', posedRow.original.sha256 === refFront.original.sha256);
check(
  'a partial pose cannot overwrite a valid one (refused, and the good pose survives)',
  /^422:POSE_(INVALID|INCOMPLETE)$/.test(
    await refusal(() => refs.updateReferenceImage(reqA, String(refFront._id), { pose: { position: { x: 0, y: 0, z: 1 } } }))
  )
);
check('the still-stored pose is the VALID one', (await ProductReferenceImage.findById(refFront._id)).pose?.fov === 40);
check('an explicit null clears the pose', (await refs.updateReferenceImage(reqA, String(refLeft._id), { pose: null })).pose === null);
check('another workspace cannot write a pose on this row', (await refusal(() => refs.updateReferenceImage(reqB, String(refFront._id), { pose: { position: { x: 1, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 40 } }))) === '404:REFERENCE_NOT_FOUND');

// Re-record the poses so the set below is fully posed.
for (const [doc, position] of [
  [refBack, { x: 0, y: 0, z: -2 }],
  [refLeft, { x: -2, y: 0, z: 0 }],
  [refRight, { x: 2, y: 0, z: 0 }],
  [refTop, { x: 0, y: 2.2, z: 0.1 }],
]) {
  await refs.updateReferenceImage(reqA, String(doc._id), {
    pose: { position, target: { x: 0, y: 0, z: 0 }, fov: 40, source: 'manual' },
  });
}

const ownedSet = await capture.ensureCaptureSet({ user: userA, productSlug: slugA });
const refreshed = await capture.refreshCaptureSet({
  user: userA,
  set: ownedSet,
  provider: { name: 'meshy', available: true },
  meshyAuthorised: true,
});
check('five labelled views validate for the embedded engine', refreshed.validation.complete, JSON.stringify(refreshed.validation.missing));
check('the snapshot is PERSISTED on the set', (await CaptureSet.findById(ownedSet._id)).validation.checkedAt instanceof Date);
check('the persisted snapshot stores issues under `issues` (Mongoose reserves `errors`)', Array.isArray((await CaptureSet.findById(ownedSet._id)).toObject().validation.issues));
check('the snapshot carries a verdict per engine', (await CaptureSet.findById(ownedSet._id)).validation.engines.length === engines.ENGINE_ORDER.length);
check('the set moved to validated because an installed engine accepts it', (await CaptureSet.findById(ownedSet._id)).status === 'validated', (await CaptureSet.findById(ownedSet._id)).status);
check('the sheet-free view rows are the set’s reference ids', refreshed.validation.referenceIds.length === 5);

const draftSet = await capture.ensureCaptureSet({ user: userA, draftKey: `draft-none-${stamp}` }).catch((err) => err);
check('an EMPTY draft key cannot create a set (ownership proof required)', draftSet?.code === 'CAPTURE_SET_DRAFT_NOT_FOUND');
const foreignSlug = await capture.ensureCaptureSet({ user: userA, productSlug: slugB }).catch((err) => err);
check('a product in another workspace cannot be adopted', foreignSlug?.code === 'CAPTURE_SET_PRODUCT_NOT_FOUND');

// Append-only history
const planForA = capture.buildSubmissionPlan({
  rows: await capture.loadRowsForSet(userA, ownedSet),
  profile: ownedSet.profile || {},
  engineId: 'meshy_multi_image',
  provider: { name: 'meshy', available: true },
  meshyAuthorised: true,
});
check('the plan selects at most the engine input limit', planForA.inputIds.length <= 4);
check('the plan carries a readable fingerprint of its exact inputs', /:/.test(planForA.payloadFingerprint) && planForA.payloadFingerprint.split('|').length === planForA.inputIds.length);
check('the plan reports the views it leaves out', planForA.unusedViews === Math.max(0, 5 - planForA.inputIds.length));

await capture.appendSubmission({ set: ownedSet, plan: planForA, user: userA, jobId: 'job-one', outcome: 'accepted' });
await capture.appendSubmission({ set: ownedSet, plan: planForA, user: userA, jobId: 'job-two', outcome: 'accepted' });
const withHistory = await CaptureSet.findById(ownedSet._id);
check('submission history APPENDS (a previous entry is never rewritten)', withHistory.submissions.length === 2 && withHistory.submissions[0].jobId === 'job-one' && withHistory.submissions[1].jobId === 'job-two');
check('each entry records the exact input ids', withHistory.submissions[0].inputIds.join(',') === planForA.inputIds.join(','));
check('each entry records the input order and hashes', withHistory.submissions[0].inputs.every((input) => input.sha256 && Number.isFinite(input.order)));

// ══════════ §F ══════════
section('§F SUBMISSION PLAN — the ids written are the ids sent');

const singlePlan = capture.buildSubmissionPlan({
  rows: await capture.loadRowsForSet(userA, ownedSet),
  profile: {},
  engineId: 'local_single_view',
  provider: { name: 'local_worker', available: true },
  meshyAuthorised: false,
});
check('the single-view plan sends ONE image', singlePlan.inputIds.length === 1, String(singlePlan.inputIds.length));
check('it reports the other accepted views as unused', singlePlan.unusedViews === 4, String(singlePlan.unusedViews));
check('it declares its own input mode honestly', singlePlan.inputMode === 'single_view');
check('the plan ids and the input records agree', singlePlan.inputIds.join(',') === singlePlan.inputs.map((i) => i.id).join(','));

const planRefusalNoEngine = await refusal(() => capture.buildSubmissionPlan({ rows: fourViews, engineId: 'reli3d', provider: { name: 'meshy', available: true }, meshyAuthorised: true }));
check('a plan for an engine with no adapter is refused', /ENGINE_NOT_INSTALLED/.test(planRefusalNoEngine), planRefusalNoEngine);
const planRefusalMetered = await refusal(() =>
  capture.buildSubmissionPlan({ rows: fourViews, engineId: 'meshy_multi_image', provider: { name: 'meshy', available: true }, meshyAuthorised: false })
);
check('a metered plan without authorisation says SO (not a generic refusal)', /ENGINE_NOT_AUTHORISED/.test(planRefusalMetered), planRefusalMetered);

const claimTarget = await CaptureSet.create({ workspaceId: wsA._id, productSlug: `claim-${stamp}`, status: 'validated' });
const claimedOnce = await capture.claimForSubmission({ user: userA, set: claimTarget, plan: planForA });
check('a validated set can be claimed exactly once', claimedOnce.status === 'submitted');
check('a second claim is refused (no double billing)', (await refusal(() => capture.claimForSubmission({ user: userA, set: claimTarget, plan: planForA }))) === '409:CAPTURE_SET_BUSY');
await capture.recordFailure({ set: claimedOnce, code: 'TEST_FAILURE', message: 'simulated provider refusal' });
const failedSet = await CaptureSet.findById(claimTarget._id);
check('a failure is recorded with its code and message', failedSet.failure.code === 'TEST_FAILURE' && failedSet.status === 'failed');
check('a failed set can be submitted again (a re-shoot is legitimate)', capture.canTransition('failed', 'submitted'));

// ══════════ §G ══════════
section('§G HTTP SURFACE — gates, refusals and no forced states');

const LEAK_SENTINEL = `capture-sentinel-${stamp}`;
const { child: SERVER, base } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: {
    SEED_ON_START: 'false',
    REFERENCE_MEDIA_DIR,
    THREE_MEDIA_ROOT,
    // NO provider is selected in the child, so NO network call is possible from
    // it: "a default deployment cannot submit" is therefore a statement about
    // the code, not about whatever backend/.env happens to hold.
    THREE_D_PROVIDER: '',
    '3D_PROVIDER': '',
    // A sentinel credential is deliberately PRESENT and must never be echoed by
    // any capture-set response.
    MESHY_API_KEY: LEAK_SENTINEL,
    // The deployment switch is ON for this child: the point is that the switch
    // ALONE is not enough, because no engine is enabled.
    THREE_D_METERED_SUBMIT: 'true',
  },
  label: 'capture',
});
const BASE = `${base}/api`;

async function req(method, path_, { token, body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${path_}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* non-json body */
      }
      return { status: res.status, json };
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(750);
    }
  }
}

const login = async (email, password) => (await req('POST', '/auth/login', { body: { email, password } })).json?.token || null;
const ADMIN_A = await login(adminAEmail, P('AdminA'));
const ADMIN_B = await login(adminBEmail, P('AdminB'));
const LIMITED = await login(limitedEmail, P('Limited'));
const ORPHAN = await login(orphanEmail, P('Orphan'));
const CUSTOMER_EMAIL = `capture-customer-${stamp}@capture.test`;
await req('POST', '/auth/register', { body: { name: 'Capture Customer', email: CUSTOMER_EMAIL, password: P('Cust') } });
const CUSTOMER = await login(CUSTOMER_EMAIL, P('Cust'));
check('fixtures: staff, limited handler, workspace-less admin and customer signed in', Boolean(ADMIN_A && ADMIN_B && LIMITED && ORPHAN && CUSTOMER));

check('the capture-set surface requires authentication', (await req('GET', `/capture-sets?productSlug=${slugA}`)).status === 401);
check('a customer is refused', (await req('GET', `/capture-sets?productSlug=${slugA}`, { token: CUSTOMER })).status === 403);
check('a permissionless handler is refused', (await req('GET', `/capture-sets?productSlug=${slugA}`, { token: LIMITED })).status === 403);
check('an identity with no workspace is refused by the workspace gate', (await req('GET', `/capture-sets?productSlug=${slugA}`, { token: ORPHAN })).status >= 400);

const enginesRes = await req('GET', '/capture-sets/engines', { token: ADMIN_A });
check('the engines endpoint answers the registry', enginesRes.status === 200 && Array.isArray(enginesRes.json.engines) && enginesRes.json.engines.length === engines.ENGINE_ORDER.length);
check('it NEVER echoes the provider credential', !containsValue(enginesRes.json, LEAK_SENTINEL));
check('it reports the deployment’s metered switch honestly', enginesRes.json.meteredAuthorised === true);
check('it reports that NO provider is available in this child', enginesRes.json.provider?.available === false);

const missingScope = await req('GET', '/capture-sets', { token: ADMIN_A });
check('a request with no product or draft scope is refused', missingScope.status === 422 && missingScope.json?.code === 'CAPTURE_SET_SCOPE_REQUIRED');

const notStarted = await req('GET', `/capture-sets?productSlug=${slugA}`, { token: ADMIN_B });
check('another workspace sees NO capture set for this product (a 404, not a 403)', notStarted.status === 404 && notStarted.json?.code === 'CAPTURE_SET_NOT_FOUND');

const startRes = await req('POST', '/capture-sets', { token: ADMIN_A, body: { productSlug: slugA } });
check('starting a set returns 201 with live state', startRes.status === 201 && startRes.json?.captureSet?.id);
check('the live state carries a verdict per engine', (startRes.json.captureSet.live.engines || []).length === engines.ENGINE_ORDER.length);
check('the live state reports the real accepted view count', startRes.json.captureSet.live.counts.views === 5, String(startRes.json.captureSet.live.counts.views));
check('the live state never leaks a storage key', !containsJSONKey(startRes.json, 'storageKey'));

const setId = startRes.json.captureSet.id;
const statusForced = await req('PATCH', `/capture-sets/${setId}`, { token: ADMIN_A, body: { productSlug: slugA, status: 'completed' } });
check('a request cannot set the capture-set STATUS', statusForced.status === 422 && statusForced.json?.code === 'CAPTURE_SET_STATUS_READ_ONLY');

const badEngine = await req('PATCH', `/capture-sets/${setId}`, { token: ADMIN_A, body: { productSlug: slugA, engineId: 'reli3d' } });
check('an engine with no adapter cannot be selected', badEngine.status === 422 && badEngine.json?.code === 'ENGINE_NOT_INSTALLED');

const profileRes = await req('PATCH', `/capture-sets/${setId}`, {
  token: ADMIN_A,
  body: { productSlug: slugA, engineId: 'meshy_multi_image', profile: { rig: 'tripod', distanceMetres: 1.2, fovDegrees: 40, background: 'plain-seamless' } },
});
check('the capture profile is saved', profileRes.status === 200 && profileRes.json.captureSet.profile.rig === 'tripod' && profileRes.json.captureSet.profile.distanceMetres === 1.2);
const badProfile = await req('PATCH', `/capture-sets/${setId}`, { token: ADMIN_A, body: { productSlug: slugA, profile: { distanceMetres: -4 } } });
check('a negative physical measurement is refused', badProfile.status === 422 && badProfile.json?.code === 'PROFILE_INVALID');

// On a provider-free deployment the dry run refuses for the SAME reason a
// submission would — and, crucially, it writes nothing.
const planRes = await req('POST', `/capture-sets/${setId}/plan`, { token: ADMIN_A, body: { productSlug: slugA, engineId: 'meshy_multi_image' } });
check('the dry run refuses when the engine is not enabled here', planRes.status === 422 && planRes.json?.code === 'ENGINE_DISABLED', `${planRes.status} ${planRes.json?.code}`);
check('the dry run does NOT create a job', (await GenerationJob.countDocuments({ workspaceId: wsA._id, productSlug: slugA })) === 0);
const planNoProvider = await capture.loadRowsForSet(userA, await CaptureSet.findById(setId));
check('the plan builder itself cannot select inputs for a disabled engine', (await refusal(() => capture.buildSubmissionPlan({ rows: planNoProvider, engineId: 'meshy_multi_image', provider: { name: '', available: false }, meshyAuthorised: true }))).startsWith('422:'));

const submitNoAck = await req('POST', `/capture-sets/${setId}/submit`, { token: ADMIN_A, body: { productSlug: slugA, engineId: 'meshy_multi_image' } });
check('a metered submission without an explicit acknowledgement is REFUSED', submitNoAck.status === 422 && submitNoAck.json?.code === 'ENGINE_NOT_AUTHORISED');
check('nothing was billed and no job was created', (await GenerationJob.countDocuments({ workspaceId: wsA._id, productSlug: slugA })) === 0);

const crossTenant = await req('POST', `/capture-sets/${setId}/submit`, { token: ADMIN_B, body: { productSlug: slugB, engineId: 'meshy_multi_image', acknowledgeMetered: true } });
check('another workspace cannot submit this set', crossTenant.status === 404);

// The child has the metered switch ON and a credential present, but NO engine is
// enabled. This is the honest default-deployment answer, and it is also the proof
// that no request reaches a provider from a server that has none.
const jobsBefore = await GenerationJob.countDocuments({ workspaceId: wsA._id, productSlug: slugA });
const submitNoEngine = await req('POST', `/capture-sets/${setId}/submit`, {
  token: ADMIN_A,
  body: { productSlug: slugA, engineId: 'meshy_multi_image', acknowledgeMetered: true },
});
check('even with the switch on, a deployment with no provider refuses the submission', submitNoEngine.status === 422 && submitNoEngine.json?.code === 'ENGINE_DISABLED', `${submitNoEngine.status} ${submitNoEngine.json?.code}`);
check('the refusal says WHY (which provider this deployment is configured for)', /configured for|not available|not enabled|no adapter/i.test(submitNoEngine.json?.message || ''), submitNoEngine.json?.message);
check('no generation job was created by the refused submission', (await GenerationJob.countDocuments({ workspaceId: wsA._id, productSlug: slugA })) === jobsBefore);
check('the set was NOT moved to submitted by a refused submission', (await CaptureSet.findById(setId)).status === 'validated', (await CaptureSet.findById(setId)).status);

// ══════════ §H ══════════
section('§H REAL SUBMISSION — orchestration through an explicit provider double');

const fakeCalls = { submits: 0, statuses: 0, downloads: 0, lastInputs: [] };
const fakeDownload = buildGlb({ meshes: 1 });
const fakeProvider = {
  name: 'meshy',
  submit: async (inputs) => {
    fakeCalls.submits += 1;
    fakeCalls.lastInputs = inputs.map((input) => ({ bytes: input.buffer?.length || 0, kind: input.kind }));
    return { providerTaskId: `capture-task-${stamp}-${fakeCalls.submits}` };
  },
  status: async () => {
    fakeCalls.statuses += 1;
    return { status: 'ready', providerTaskStatus: 'SUCCEEDED', progress: 100 };
  },
  download: async () => {
    fakeCalls.downloads += 1;
    return { buffer: fakeDownload, contentType: 'model/gltf-binary' };
  },
  cancel: async () => true,
  health: async () => ({ ok: true, detail: 'test double — no network' }),
};

// The provider is selected in THIS process only, and the transport is replaced.
const savedEnv = { provider: process.env.THREE_D_PROVIDER, legacy: process.env['3D_PROVIDER'], key: process.env.MESHY_API_KEY };
process.env.THREE_D_PROVIDER = 'meshy';
process.env['3D_PROVIDER'] = '';
process.env.MESHY_API_KEY = `test-key-${stamp}`;
const restoreProvider = provider.registerTestProvider('meshy', fakeProvider);

const inProcessSet = await CaptureSet.findById(setId);

// The plan shape, measured where an engine IS available.
const inProcessPlan = capture.buildSubmissionPlan({
  rows: await capture.loadRowsForSet(userA, inProcessSet),
  profile: inProcessSet.profile || {},
  engineId: 'meshy_multi_image',
  provider: { name: 'meshy', available: true },
  meshyAuthorised: true,
});
check('the plan names the engine and its input mode', inProcessPlan.engineId === 'meshy_multi_image' && inProcessPlan.inputMode === 'multi_view');
check('the plan selects at most the engine input limit', inProcessPlan.inputIds.length > 0 && inProcessPlan.inputIds.length <= 4, String(inProcessPlan.inputIds.length));
check('the plan reports how many views are left out', inProcessPlan.unusedViews === 5 - inProcessPlan.inputIds.length, String(inProcessPlan.unusedViews));
check('the plan never selects a composite sheet as a view', !inProcessPlan.inputs.some((input) => input.sha256 === 'sheet-hash'));

let submissionResult = null;
let submissionError = null;
let acceptedSnapshot = null;

try {
  submissionResult = await capture.executeSubmission({
    user: userA,
    set: inProcessSet,
    engineId: 'meshy_multi_image',
    acknowledgeMetered: true,
    meteredAuthorised: true,
    provider: { name: 'meshy', available: true },
    startGeneration: async (options) => {
      const started = await generation.startGeneration(reqA, options);
      // Snapshot taken the INSTANT the service hands control back — this is the
      // deterministic proof that acceptance is not completion.
      acceptedSnapshot = { status: started?.job?.status, taskId: started?.job?.providerTaskId || '' };
      return started;
    },
  });
} catch (err) {
  submissionError = err;
}

check('an authorised submission runs end to end', Boolean(submissionResult) && !submissionError, submissionError?.message);
check(
  'acceptance returns BEFORE the provider finishes (the job is still active)',
  Boolean(acceptedSnapshot) && JOB_STATUSES_ACTIVE.includes(acceptedSnapshot.status),
  acceptedSnapshot?.status
);
check(
  'the ids recorded in the audit ARE the ids the plan selected',
  Boolean(submissionResult) && submissionResult.submission.inputIds.join(',') === submissionResult.plan.inputIds.join(','),
  `${submissionResult?.submission?.inputIds?.join(',')} vs ${submissionResult?.plan?.inputIds?.join(',')}`
);
check('the submission records a fingerprint of what was sent', Boolean(submissionResult?.submission?.payloadFingerprint));

/* ── WAIT FOR THE REAL ORCHESTRATION ───────────────────────────────────────
   Everything provider-shaped below is measured only once the detached job is
   TERMINAL. Reading it right after `executeSubmission` returned is the race
   that failed CI: the assertion could observe 0 submissions. */
const submittedJobId = String(submissionResult?.submission?.jobId || '');
check('the submission records the generation job it started', Boolean(submittedJobId), submittedJobId);

const finishedJob = submittedJobId ? await waitForJobTerminal(reqA, submittedJobId) : null;
check(
  'the detached job reached a TERMINAL state',
  Boolean(finishedJob) && !JOB_STATUSES_ACTIVE.includes(finishedJob.status),
  finishedJob?.status
);
check(
  'the generation finished at human review (READY_FOR_REVIEW), not approved',
  finishedJob?.status === 'READY_FOR_REVIEW',
  `${finishedJob?.status} ${finishedJob?.failure?.message || ''}`.trim()
);
check('the provider double was called exactly once (no silent retry)', fakeCalls.submits === 1, String(fakeCalls.submits));
check('the provider task was POLLED for its status', fakeCalls.statuses >= 1, String(fakeCalls.statuses));
check('the finished GLB was DOWNLOADED from the provider', fakeCalls.downloads === 1, String(fakeCalls.downloads));
check('a generation job exists for the product', (await GenerationJob.countDocuments({ workspaceId: wsA._id, productSlug: slugA })) === 1);
check('the provider received exactly the planned number of images', fakeCalls.lastInputs.length === (submissionResult?.plan?.inputIds?.length ?? -1), String(fakeCalls.lastInputs.length));
check('the set left validated', ['submitted', 'processing'].includes((await CaptureSet.findById(setId)).status), (await CaptureSet.findById(setId)).status);

/* The downloaded bytes must be a REVIEWABLE CANDIDATE — and a candidate is not
   an approved model. Approval is a human act and must still be outstanding. */
const candidateAssetId = finishedJob?.providerExtra?.assetId || '';
const candidate = candidateAssetId ? await Product3DAsset.findById(candidateAssetId) : null;
check('the downloaded GLB became a stored candidate asset', Boolean(candidate) && Number(candidate?.storage?.glb?.bytes || 0) > 0, candidate ? String(candidate.storage?.glb?.bytes) : 'no asset');
check(
  'the candidate is linked to the job that produced it',
  String(candidate?.jobId || '') === submittedJobId,
  `${candidate?.jobId || 'none'} vs ${submittedJobId}`
);
check(
  'the candidate is NOT automatically approved (approval stays human)',
  candidate?.status === 'CANDIDATE' && !candidate?.approval?.approvedAt,
  `${candidate?.status} approvedAt=${candidate?.approval?.approvedAt || 'null'}`
);
check(
  'the quality gate MEASURED the candidate before review',
  ['PASS', 'REVIEW', 'BLOCKED'].includes(String(candidate?.quality?.decision || '')),
  candidate?.quality?.decision
);

const secondClaim = await refusal(() =>
  capture.executeSubmission({
    user: userA,
    set: inProcessSet,
    engineId: 'meshy_multi_image',
    acknowledgeMetered: true,
    meteredAuthorised: true,
    provider: { name: 'meshy', available: true },
    startGeneration: (options) => generation.startGeneration(reqA, options),
  })
);
check('an immediate second submission is refused (no double billing)', /CAPTURE_SET_BUSY/.test(secondClaim), secondClaim);
check('the provider double was still called exactly once', fakeCalls.submits === 1, String(fakeCalls.submits));
check('the refused second submission downloaded nothing more', fakeCalls.downloads === 1, String(fakeCalls.downloads));

const storedSet = await CaptureSet.findById(setId);
const lastStored = storedSet.submissions[storedSet.submissions.length - 1];
check('the submission history on the stored set ends with what just ran', lastStored?.jobId === String(submissionResult?.submission?.jobId));
check('the earlier audit entries were NOT rewritten by the new submission', storedSet.submissions.length >= 3 && storedSet.submissions[0].jobId === 'job-one');

restoreProvider();
if (savedEnv.provider === undefined) delete process.env.THREE_D_PROVIDER; else process.env.THREE_D_PROVIDER = savedEnv.provider;
if (savedEnv.legacy === undefined) delete process.env['3D_PROVIDER']; else process.env['3D_PROVIDER'] = savedEnv.legacy;
if (savedEnv.key === undefined) delete process.env.MESHY_API_KEY; else process.env.MESHY_API_KEY = savedEnv.key;
check(
  'the test double and the temporary provider selection were removed',
  provider.resolveProvider() !== 'meshy' && process.env.MESHY_API_KEY === savedEnv.key
);

// A set with no accepted rows must not be submittable.
const emptySlug = `capture-empty-${stamp}`;
await Product.create({ slug: emptySlug, name: 'Empty Capture Product', price: 500, workspaceId: wsA._id });
const emptyStart = await req('POST', '/capture-sets', { token: ADMIN_A, body: { productSlug: emptySlug } });
check('a product with no accepted photographs starts in draft', emptyStart.json?.captureSet?.status === 'draft');
const emptySubmit = await req('POST', `/capture-sets/${emptyStart.json.captureSet.id}/submit`, {
  token: ADMIN_A,
  body: { productSlug: emptySlug, engineId: 'meshy_multi_image', acknowledgeMetered: true },
});
check('an empty set cannot be submitted', [422, 409].includes(emptySubmit.status), `${emptySubmit.status} ${emptySubmit.json?.code}`);

// ══════════ summary ══════════
await fs.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
check('the suite cleaned up its own private media root', (await fs.stat(MEDIA_DIR).catch(() => null)) === null);

try {
  await mongoose.connection.db.dropDatabase();
  console.log(`\n— cleanup: dropped ${DB_NAME} —`);
} catch (err) {
  console.log(`\n— cleanup skipped (${err.message}) —`);
}

console.log(`\nCAPTURE SET RESULT: ${passed} passed, ${failed} failed`);
console.log('NOTE: no AI inference was performed. The provider was an explicit test double;');
console.log('      the pose field, capture-set model, lifecycle, plan and every HTTP gate were real.');
if (failed > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
}

try {
  await mongoose.disconnect().catch(() => {});
} finally {
  await stopTestServer(SERVER, base);
}

/** Deep key search for a leaked storage path. */
function containsJSONKey(value, needle, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return false;
  if (Array.isArray(value)) return value.some((item) => containsJSONKey(item, needle, depth + 1));
  return Object.entries(value).some(([key, child]) => key === needle || containsJSONKey(child, needle, depth + 1));
}
