/**
 * 3D STUDIO — PHASE 5 — THE QUALITY GATE (focused suite).
 *
 * Self-contained: own database (`Flora-Alchemy-Test-3DQuality`) and its own
 * private media roots under the OS temp directory, so nothing here touches dev
 * or production data or files.
 *
 * ═══ WHAT IS REAL, AND WHAT IS A FIXTURE — READ THIS FIRST ═══
 *
 * NO AI INFERENCE RUNS HERE, and no fixture is ever reported as a generated
 * product. The gate does not depend on a provider, so this suite can test it
 * exactly: it uses DETERMINISTIC GEOMETRY whose answer is known in advance
 * (a box IS a box) plus synthetic reference images, and it drives the REAL
 * pipeline around them — real reference rows, real files on disk, real GLB
 * validation, real private storage, real candidate rows, the real assessment
 * service, the real approval gate, and the real controller that parses a request
 * body.
 *
 * The genuine-model half of the evidence is NOT here: it is
 * `scripts/3d-quality-report.mjs`, which points the same service at a model a
 * real worker produced. A GPU is not required to prove the gate, and a gate
 * proven only on a GPU machine would be untestable in CI.
 *
 * What it proves, by section:
 *
 *   §A MEASUREMENT & DECISIONS — a matching model passes, a severely mismatched
 *      one is blocked, an ambiguous or unmeasurable one is a review, an invalid
 *      container is blocked, and the material policy distinguishes a
 *      vertex-colour model (warn) from a deployment that demands texture maps
 *      (block).
 *   §B APPROVAL IS GATED SERVER-SIDE — the shipped approval service refuses a
 *      BLOCKED model, demands an explicit review for a REVIEW one, records the
 *      review and the override (with the verdict it overrode), refuses a
 *      non-administrator override, and never reads a verdict from the request.
 *   §C STALENESS — a report describes exact bytes against exact references, and
 *      changing either invalidates it and forces a re-measurement.
 *   §D THE LIVE MODEL SURVIVES — a blocked or failed replacement cannot take
 *      down an approved model, and a successful one archives it rather than
 *      deleting it.
 *   §E PUBLIC SURFACE — only an approved model is ever public, and a blocked
 *      candidate never becomes the storefront's model.
 *   §F TENANCY — another workspace gets 404s (never 403) on read, assess and
 *      approve.
 *
 * Run: npm run test:3d-quality
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { testMongoUri, loadBackendEnv, pinFilesystemMediaDriver } from './lib/testServer.mjs';
import { buildBoxGlb, buildSphereGlb, buildReferencePng, NOT_A_GLB } from './lib/meshFixtures.mjs';

const DB_NAME = 'Flora-Alchemy-Test-3DQuality';
const stamp = Date.now();

/**
 * Both media stores resolve their root AT MODULE LOAD, so the roots are pointed
 * at a throwaway temp directory BEFORE the storage modules are evaluated.
 */
const MEDIA_DIR = path.join(os.tmpdir(), `flora-3d-quality-${stamp}`);
const THREE_MEDIA_ROOT = path.join(MEDIA_DIR, '3d-media');
const REFERENCE_MEDIA_DIR = path.join(MEDIA_DIR, 'reference-media');
process.env.THREE_MEDIA_ROOT = THREE_MEDIA_ROOT;
process.env.REFERENCE_MEDIA_DIR = REFERENCE_MEDIA_DIR;
// Fixtures live in this suite's temp roots; never inherit a live bucket.
pinFilesystemMediaDriver();

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

// ── Dynamic: these read the media roots at import time. ────────────────────
const referenceStorage = await import('../services/referenceAssetStorage.js');
const assetStorage = await import('../services/3dAssetStorage.js');
const quality = await import('../services/3dQualityAssessment.js');
const assets = await import('../services/3dAssetService.js');
const { publicProduct3d, cacheInvalidate3dDelivery } = await import('../services/product3dPublicResolution.js');
const { approveHandler } = await import('../controllers/3dAssetController.js');
const { ApiError } = await import('../middleware/errorMiddleware.js');
const Workspace = (await import('../models/Workspace.js')).default;
const User = (await import('../models/User.js')).default;
const ProductReferenceImage = (await import('../models/ProductReferenceImage.js')).default;
const GenerationJob = (await import('../models/GenerationJob.js')).default;
const Product3DAsset = (await import('../models/Product3DAsset.js')).default;

// ══════════ harness ══════════
let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u2714 ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \u2718 ${name} ${String(detail).slice(0, 300)}`.trimEnd());
  }
}
const section = (title) => console.log(`\n\u2014 ${title} \u2014`);

/** Capture the error an async call raises, or null when it succeeds. */
async function errorFrom(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

const codeOf = (err) => (err instanceof ApiError ? err.code : `NOT_API_ERROR:${err?.message}`);

/** Does this path still exist? (Used to prove the suite cleaned up after itself.) */
const exists = (target) => fs.stat(target).then(() => true, () => false);

// ══════════ database ══════════
console.log(`[3d-quality] test database: ${DB_NAME}`);
await mongoose.connect(TEST_URI);
await Promise.all([Workspace.init(), User.init(), ProductReferenceImage.init(), Product3DAsset.init()]);
console.log(`[3d-quality] private media roots under ${MEDIA_DIR}`);
console.log('[3d-quality] geometry: DETERMINISTIC FIXTURES (no inference, no provider)');

const wsA = await Workspace.create({ slug: `quality-a-${stamp}`, displayName: 'Quality A', status: 'ACTIVE' });
const wsB = await Workspace.create({ slug: `quality-b-${stamp}`, displayName: 'Quality B', status: 'ACTIVE' });

async function makeUser({ email, role, name, workspaceId }) {
  return User.create({
    email,
    passwordHash: await bcrypt.hash('Quality-Test-Passphrase-1', 12),
    role,
    name,
    status: 'ACTIVE',
    ...(workspaceId ? { workspaceId } : {}),
  });
}

const adminA = await makeUser({ email: `quality-admin-${stamp}@three.test`, role: 'admin', name: 'Quality Admin', workspaceId: wsA._id });
const handlerA = await makeUser({ email: `quality-handler-${stamp}@three.test`, role: 'handler', name: 'Quality Handler', workspaceId: wsA._id });
const adminB = await makeUser({ email: `quality-admin-b-${stamp}@three.test`, role: 'admin', name: 'Quality Admin B', workspaceId: wsB._id });

const reqFor = (user, workspaceSlug) => ({ user, workspaceSlug, user_id: String(user._id) });
const reqA = reqFor(adminA, wsA.slug);
const reqB = reqFor(adminB, wsB.slug);

/** An ACCEPTED reference row with a REAL cutout file on disk. */
async function makeReference({ workspace, productSlug, cutoutPng, primary = true, order = 0, confidence = 0.9, warnings = [], withCutout = true }) {
  const doc = await ProductReferenceImage.create({
    workspaceId: workspace._id,
    productSlug,
    status: 'READY',
    accepted: true,
    isPrimary: primary,
    order,
    label: `view ${order}`,
    processing: { engine: 'fixture-engine', model: 'fixture-model' },
    confidence,
    warnings,
    original: { fileName: 'original.png', format: 'png', hasAlpha: true },
    cutout: { format: 'png', hasAlpha: true },
  });
  if (withCutout) {
    const written = await referenceStorage.writeAsset({
      imageId: doc._id,
      workspaceSlug: workspace.slug,
      kind: 'cutout',
      buffer: cutoutPng,
      format: 'png',
    });
    doc.cutout.storageKey = written.storageKey;
    doc.cutout.bytes = written.bytes;
    await doc.save();
  }
  return doc;
}

/** A job-shaped object: enough for `createCandidateFromGeneration` to work. */
const jobFor = (productSlug, referenceIds) => ({
  _id: new mongoose.Types.ObjectId(),
  productSlug,
  source: { referenceIds: referenceIds.map(String), viewCount: referenceIds.length, label: 'quality test' },
  settings: { quality: 'standard', notes: '' },
  provider: 'fixture-provider',
  providerModel: 'fixture-model',
  providerModelVersion: '1',
});

/** Create a reference + a candidate in one step, as the pipeline does. */
async function makeCandidate({
  workspace = wsA,
  req = reqA,
  productSlug,
  glb,
  referencePng,
  withCutout = true,
  confidence = 0.9,
  warnings = [],
}) {
  const ref = await makeReference({
    workspace,
    productSlug,
    cutoutPng: referencePng,
    withCutout,
    confidence,
    warnings,
  });
  const asset = await assets.createCandidateFromGeneration(req, {
    job: jobFor(productSlug, [ref._id]),
    glbBuffer: glb,
  });
  return { asset, ref };
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a7A MEASUREMENT & DECISIONS \u2014 fixtures whose answer is known');
// ══════════════════════════════════════════════════════════════════════════

const boxTall = buildBoxGlb({ width: 1, height: 4, depth: 0.5, segments: 5 });
const rectTall = await buildReferencePng({ width: 50, height: 200 });
const boxWide = buildBoxGlb({ width: 1, height: 8, depth: 1, segments: 5 });
const rectWide = await buildReferencePng({ width: 200, height: 50 });
const sphere = buildSphereGlb({});
const disc = await buildReferencePng({ width: 120, height: 120, shape: 'disc' });

const passReport = await quality.assessGlbBuffer({
  glbBuffer: boxTall,
  cutoutBuffer: rectTall,
  reference: { engine: 'fixture-engine', confidence: 0.9, warnings: [], cutoutAvailable: true },
});
check('a box whose projection matches the reference PASSES', passReport.decision === 'PASS', passReport.decision);
check('  \u2026 with a high overlap and no aspect error', passReport.silhouette.iou > 0.9 && passReport.silhouette.aspectError < 0.05, JSON.stringify({ iou: passReport.silhouette.iou, aspectError: passReport.silhouette.aspectError }));
check('  \u2026 and its mirror view is reported as a TIE, not as doubt', passReport.silhouette.viewAgreement === 'clear' && passReport.silhouette.tiedViews.includes('back'), JSON.stringify(passReport.silhouette.tiedViews));
check('  \u2026 and the mirror tie does not create a review reason', !passReport.reasons.some((r) => r.code === 'SILHOUETTE_VIEW_AMBIGUOUS'));

const blockedReport = await quality.assessGlbBuffer({
  glbBuffer: boxWide,
  cutoutBuffer: rectWide,
  reference: { engine: 'fixture-engine', confidence: 0.9, warnings: [], cutoutAvailable: true },
});
check('a severely mismatched model is BLOCKED', blockedReport.decision === 'BLOCKED', blockedReport.decision);
check('  \u2026 naming the severe mismatch', blockedReport.reasons.some((r) => r.code === 'SILHOUETTE_SEVERE_MISMATCH'));

const sphereReport = await quality.assessGlbBuffer({
  glbBuffer: sphere,
  cutoutBuffer: disc,
  reference: { engine: 'fixture-engine', confidence: 0.9, warnings: [], cutoutAvailable: true },
});
check('a rotationally symmetric model is a REVIEW, not a pass', sphereReport.decision === 'REVIEW', sphereReport.decision);
check('  \u2026 because the view choice was an assumption', sphereReport.silhouette.viewAgreement === 'ambiguous', JSON.stringify({ margin: sphereReport.silhouette.viewMargin, distinct: sphereReport.silhouette.distinctSilhouettes }));

const noCutoutReport = await quality.assessGlbBuffer({
  glbBuffer: boxTall,
  cutoutBuffer: null,
  reference: null,
});
check('a missing source cutout is a REVIEW, never a silent pass', noCutoutReport.decision === 'REVIEW');
check('  \u2026 and it says the shape could not be measured', noCutoutReport.silhouette.available === false && noCutoutReport.reasons.some((r) => r.code === 'SILHOUETTE_UNAVAILABLE'));

const invalidReport = await quality.assessGlbBuffer({ glbBuffer: NOT_A_GLB, cutoutBuffer: rectTall });
check('an invalid GLB is BLOCKED structurally', invalidReport.decision === 'BLOCKED' && invalidReport.structural.code === 'GLB_BAD_MAGIC', invalidReport.structural.code);

const vcReport = await quality.assessGlbBuffer({
  glbBuffer: buildBoxGlb({ width: 1, height: 4, depth: 0.5, segments: 5, vertexColors: true }),
  cutoutBuffer: rectTall,
  reference: { engine: 'fixture-engine', confidence: 0.9, warnings: [], cutoutAvailable: true },
});
check('a vertex-colour model is NOT rejected for lacking texture maps', vcReport.decision === 'PASS', vcReport.decision);
check('  \u2026 but it IS described honestly, as a warning', vcReport.materials.state === 'vertex-colour' && vcReport.warnings.some((w) => w.code === 'MATERIAL_VERTEX_COLOUR'));
check('  \u2026 and the description never enters the blocking reasons', !vcReport.reasons.some((r) => r.code.startsWith('MATERIAL_')));

const strictReport = await quality.assessGlbBuffer({
  glbBuffer: buildBoxGlb({ width: 1, height: 4, depth: 0.5, segments: 5, vertexColors: true }),
  cutoutBuffer: rectTall,
  reference: { engine: 'fixture-engine', confidence: 0.9, warnings: [], cutoutAvailable: true },
  thresholds: { requireMaterials: true },
});
check('a deployment that DEMANDS texture maps blocks one, by policy', strictReport.decision === 'BLOCKED' && strictReport.reasons.some((r) => r.code === 'MATERIAL_REQUIRED'));

const sideReport = await quality.assessGlbBuffer({
  glbBuffer: buildBoxGlb({ width: 0.5, height: 4, depth: 1, segments: 5 }),
  cutoutBuffer: await buildReferencePng({ width: 100, height: 200 }),
  reference: { engine: 'fixture-engine', confidence: 0.9, warnings: [], cutoutAvailable: true },
});
check('a model whose matching view is a SIDE view is recognised, not condemned', sideReport.decision === 'PASS' && sideReport.silhouette.orientationCorrected === true, JSON.stringify({ view: sideReport.silhouette.selectedView, decision: sideReport.decision }));

check('geometry facts come from the BYTES, not a provider summary', passReport.geometry.vertices === 152 && passReport.geometry.triangles === 300 && passReport.geometry.watertight === true, JSON.stringify(passReport.geometry && { v: passReport.geometry.vertices, t: passReport.geometry.triangles }));
check('every metric carries its own definition', Boolean(passReport.silhouette.definitions?.iou && passReport.silhouette.definitions?.aspectError));
check('the report states its thresholds', passReport.thresholds.passIou === 0.75 && passReport.thresholds.blockIou === 0.35);
check('the report admits its calibration is provisional', passReport.calibration.provisional === true && passReport.calibration.genuineSamples === 1);
check('inconsistent thresholds are refused rather than honoured', codeOf(await errorFrom(() => quality.resolveThresholds({ passIou: 0.2, blockIou: 0.4 }))) === 'QUALITY_THRESHOLDS_INVALID');
check('the assessment version is stamped on every report', passReport.version === quality.ASSESSMENT_VERSION);

// A reference Phase 1 itself doubted must not condemn the model.
const doubtfulReference = await quality.assessGlbBuffer({
  glbBuffer: boxWide,
  cutoutBuffer: rectWide,
  reference: { engine: 'rembg', confidence: 0.41, warnings: ['The background is not uniform — the cutout may include detail that is not the product.'], cutoutAvailable: true },
});
check('a severe mismatch against a DOUBTFUL reference is a review, not a refusal', doubtfulReference.decision === 'REVIEW' && doubtfulReference.reasons.some((r) => r.code === 'SILHOUETTE_SEVERE_MISMATCH_DOUBTFUL_REFERENCE'), doubtfulReference.decision);
check('  \u2026 and the doubt is recorded with the flags that caused it', doubtfulReference.reference.flagged === true && doubtfulReference.reference.flags.length >= 2);

// ══════════════════════════════════════════════════════════════════════════
section('\u00a7B APPROVAL IS GATED SERVER-SIDE');
// ══════════════════════════════════════════════════════════════════════════

const slugPass = `quality-pass-${stamp}`;
const passCandidate = await makeCandidate({ productSlug: slugPass, glb: boxTall, referencePng: rectTall });
check('creating a candidate ASSESSES it before anyone can approve it', passCandidate.asset.quality.decision === 'PASS', passCandidate.asset.quality.decision);
check('  \u2026 and stores the report on the asset row itself', Boolean(passCandidate.asset.quality.fingerprint) && Boolean(passCandidate.asset.quality.report?.silhouette));

const approved = await assets.approveAsset(reqA, passCandidate.asset._id);
check('a PASS candidate approves with no extra ceremony', approved.asset.status === 'APPROVED');

const slugBlocked = `quality-blocked-${stamp}`;
const blockedCandidate = await makeCandidate({ productSlug: slugBlocked, glb: boxWide, referencePng: rectWide });
check('a blocked candidate is created but flagged BLOCKED', blockedCandidate.asset.quality.decision === 'BLOCKED');

const blockedApproval = await errorFrom(() => assets.approveAsset(reqA, blockedCandidate.asset._id));
check('approving a BLOCKED candidate is refused', codeOf(blockedApproval) === 'QUALITY_BLOCKED', codeOf(blockedApproval));
check('  \u2026 and the refusal quotes the measurement', /IoU/.test(blockedApproval?.message || ''), blockedApproval?.message);
check('  \u2026 and the asset is still a candidate', (await Product3DAsset.findById(blockedCandidate.asset._id)).status === 'CANDIDATE');

const handlerOverride = await errorFrom(() => assets.approveAsset(reqFor(handlerA, wsA.slug), blockedCandidate.asset._id, { override: true, overrideReason: 'publishing anyway' }));
check('a handler cannot override a blocked verdict', codeOf(handlerOverride) === 'QUALITY_OVERRIDE_FORBIDDEN', codeOf(handlerOverride));

const noReasonOverride = await errorFrom(() => assets.approveAsset(reqA, blockedCandidate.asset._id, { override: true }));
check('an override without a reason is refused', codeOf(noReasonOverride) === 'QUALITY_OVERRIDE_REASON_REQUIRED', codeOf(noReasonOverride));

const overridden = await assets.approveAsset(reqA, blockedCandidate.asset._id, { override: true, overrideReason: 'Owner accepted the mismatch for a seasonal placeholder.' });
const overriddenDoc = await Product3DAsset.findById(blockedCandidate.asset._id);
check('an administrator override with a reason approves it', overridden.asset.status === 'APPROVED');
check('  \u2026 and the audit keeps the verdict it overrode', overriddenDoc.quality.override.previousDecision === 'BLOCKED' && String(overriddenDoc.quality.override.by) === String(adminA._id));
check('  \u2026 and the reason the administrator gave', /seasonal placeholder/.test(overriddenDoc.quality.override.reason));
check('  \u2026 and the original BLOCKED report is still on the row', overriddenDoc.quality.report.decision === 'BLOCKED');

const slugReview = `quality-review-${stamp}`;
const reviewCandidate = await makeCandidate({ productSlug: slugReview, glb: sphere, referencePng: disc });
check('an uncertain model is a REVIEW candidate', reviewCandidate.asset.quality.decision === 'REVIEW');

const reviewRefusal = await errorFrom(() => assets.approveAsset(reqA, reviewCandidate.asset._id));
check('approving a REVIEW candidate needs an explicit decision', codeOf(reviewRefusal) === 'QUALITY_REVIEW_REQUIRED', codeOf(reviewRefusal));
check('  \u2026 and says what was measured', /IoU/.test(reviewRefusal?.message || ''), reviewRefusal?.message);

const tooShortNote = await errorFrom(() => assets.approveAsset(reqA, reviewCandidate.asset._id, { reviewNote: 'ok' }));
check('a one-word acknowledgement is not a review', codeOf(tooShortNote) === 'QUALITY_REVIEW_REQUIRED');

const reviewed = await assets.approveAsset(reqA, reviewCandidate.asset._id, { reviewNote: 'Compared with the photograph: proportions acceptable for a keepsake.' });
const reviewedDoc = await Product3DAsset.findById(reviewCandidate.asset._id);
check('a REVIEW candidate approves once a human stands behind it', reviewed.asset.status === 'APPROVED');
check('  \u2026 and the review is recorded with actor and time', String(reviewedDoc.quality.review.acknowledgedBy) === String(adminA._id) && Boolean(reviewedDoc.quality.review.acknowledgedAt));
check('  \u2026 and the note is stored', /proportions acceptable/.test(reviewedDoc.quality.review.note));

// A client cannot supply a verdict: the controller never reads one.
const slugFabricate = `quality-fabricate-${stamp}`;
const fabricateCandidate = await makeCandidate({ productSlug: slugFabricate, glb: boxWide, referencePng: rectWide });
const fabricateJob = await GenerationJob.create({
  workspaceId: wsA._id,
  productSlug: slugFabricate,
  status: 'READY_FOR_REVIEW',
  source: { referenceIds: [fabricateCandidate.ref._id], viewCount: 1, label: 'quality test' },
});
let fabricateError = null;
const fabricateRes = {
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
};
await approveHandler(
  {
    user: adminA,
    workspaceSlug: wsA.slug,
    params: { jobId: String(fabricateJob._id) },
    body: {
      assetId: String(fabricateCandidate.asset._id),
      // Everything a client might try in order to fabricate a pass.
      quality: { decision: 'PASS', iou: 0.99, fingerprint: 'forged' },
      decision: 'PASS',
      overrideQuality: false,
    },
  },
  fabricateRes,
  (err) => {
    fabricateError = err;
  }
);
const fabricateDoc = await Product3DAsset.findById(fabricateCandidate.asset._id);
check('a submitted quality verdict is ignored by the approve route', codeOf(fabricateError) === 'QUALITY_BLOCKED', codeOf(fabricateError));
check('  \u2026 and the stored report is still the measured one', fabricateDoc.quality.decision === 'BLOCKED' && fabricateDoc.quality.fingerprint !== 'forged');
check('  \u2026 and the asset did not become approved', fabricateDoc.status === 'CANDIDATE');

// ══════════════════════════════════════════════════════════════════════════
section('\u00a7C STALENESS \u2014 a report describes exact bytes and references');
// ══════════════════════════════════════════════════════════════════════════

// A reference whose cutout file is missing entirely: the gate cannot measure the
// shape, so the only honest verdict is a review.
const slugNoCutout = `quality-nocutout-${stamp}`;
const noCutoutCandidate = await makeCandidate({
  productSlug: slugNoCutout,
  glb: boxTall,
  referencePng: rectTall,
  withCutout: false,
});
check('an accepted reference with no cutout file yields a REVIEW', noCutoutCandidate.asset.quality.decision === 'REVIEW', noCutoutCandidate.asset.quality.decision);
check('  \u2026 saying the shape could not be measured', noCutoutCandidate.asset.quality.report.silhouette.available === false);
const noCutoutApproval = await errorFrom(() => assets.approveAsset(reqA, noCutoutCandidate.asset._id));
check('  \u2026 so it cannot be approved without a human decision', codeOf(noCutoutApproval) === 'QUALITY_REVIEW_REQUIRED', codeOf(noCutoutApproval));

const slugStale = `quality-stale-${stamp}`;
const staleCandidate = await makeCandidate({ productSlug: slugStale, glb: boxTall, referencePng: rectTall });
const firstFingerprint = staleCandidate.asset.quality.fingerprint;
check('a fresh report is current for its own bytes', assets.qualityIsCurrent(staleCandidate.asset) === true);

// A second, better reference arrives and the accepted set changes.
const secondRef = await makeReference({ workspace: wsA, productSlug: slugStale, cutoutPng: rectTall, primary: false, order: 1 });
staleCandidate.asset.source.referenceIds = [staleCandidate.ref._id, secondRef._id];
await staleCandidate.asset.save();
check('changing the reference set makes the stored report STALE', assets.qualityIsCurrent(staleCandidate.asset) === false);

const reassessed = await assets.ensureQualityReport(reqA, staleCandidate.asset);
check('an approval path re-measures a stale candidate instead of trusting it', reassessed.reassessed === true);
check('  \u2026 against the new fingerprint', staleCandidate.asset.quality.fingerprint !== firstFingerprint && assets.qualityIsCurrent(staleCandidate.asset) === true);
check('  \u2026 and the new report names the whole reference set', staleCandidate.asset.quality.report.reference.id !== null);

const slugStaleReview = `quality-stale-review-${stamp}`;
const staleReview = await makeCandidate({ productSlug: slugStaleReview, glb: sphere, referencePng: disc });
await assets.approveAsset(reqA, staleReview.asset._id, { reviewNote: 'Accepted after looking at it carefully.' });
const beforeChange = await Product3DAsset.findById(staleReview.asset._id);
check('a review acknowledgement is recorded on the approved asset', Boolean(beforeChange.quality.review.acknowledgedAt));

// Re-assessing different content must not inherit the old acknowledgement.
const otherRef = await makeReference({ workspace: wsA, productSlug: `quality-stale-other-${stamp}`, cutoutPng: rectTall });
beforeChange.source.referenceIds = [otherRef._id];
await beforeChange.save();
await assets.reassessAsset(reqA, beforeChange._id);
const afterReassess = await Product3DAsset.findById(beforeChange._id);
check('a re-measurement against different references clears the old acknowledgement', afterReassess.quality.review.acknowledgedBy === null && afterReassess.quality.review.note === '');
check('  \u2026 so a stale review can never be inherited by a different model', afterReassess.quality.fingerprint !== beforeChange.quality.fingerprint);

/* PHASE 6 REGRESSION — re-assessing a model that has NOT changed. That is what
   `POST /api/3d/assets/:assetId/assess` does on demand, and it used to throw:
   the carried-over review/override were re-assigned as HYDRATED subdocuments,
   which made Mongoose's nested casting write `undefined` into those paths and
   fail validation, so the endpoint answered 500. Every earlier check in this
   suite changed something first, which is why none of them caught it — the
   browser fixture for the failed-assessment state did. */
const reassessedUnchanged = await assets.reassessAsset(reqA, afterReassess._id);
const stillSame = await Product3DAsset.findById(afterReassess._id);
check('re-assessing an UNCHANGED model succeeds instead of failing validation', reassessedUnchanged.asset.id === String(afterReassess._id), String(reassessedUnchanged.asset.id));
check('  \u2026 keeping the same verdict and fingerprint', stillSame.quality.fingerprint === afterReassess.quality.fingerprint && stillSame.quality.decision === afterReassess.quality.decision, stillSame.quality.decision);
check('  \u2026 and still reporting the report as current', assets.qualityIsCurrent(stillSame) === true);
check('  \u2026 with the carried-over fields present rather than undefined', Boolean(stillSame.quality.review) && Boolean(stillSame.quality.override));

const reassessMissing = await errorFrom(() => assets.reassessAsset(reqA, new mongoose.Types.ObjectId()));
check('re-assessing an unknown asset is a 404', codeOf(reassessMissing) === 'ASSET_NOT_FOUND', codeOf(reassessMissing));

// ══════════════════════════════════════════════════════════════════════════
section('\u00a7D THE LIVE MODEL SURVIVES A FAILED OR BLOCKED REPLACEMENT');
// ══════════════════════════════════════════════════════════════════════════

const slugLive = `quality-live-${stamp}`;
const liveFirst = await makeCandidate({ productSlug: slugLive, glb: boxTall, referencePng: rectTall });
await assets.approveAsset(reqA, liveFirst.asset._id);
check('a product has an approved model to protect', (await assets.findApproved(reqA, slugLive)).status === 'APPROVED');

const badReplacement = await makeCandidate({ productSlug: slugLive, glb: boxWide, referencePng: rectWide });
const refusedReplacement = await errorFrom(() => assets.approveAsset(reqA, badReplacement.asset._id));
const stillLive = await assets.findApproved(reqA, slugLive);
check('a BLOCKED replacement is refused', codeOf(refusedReplacement) === 'QUALITY_BLOCKED');
check('  \u2026 and the live model is untouched', String(stillLive._id) === String(liveFirst.asset._id) && stillLive.status === 'APPROVED');

const rejectedReplacement = await makeCandidate({ productSlug: slugLive, glb: boxesSafe(), referencePng: rectTall });
await assets.rejectAsset(reqA, rejectedReplacement.asset._id, 'not what we wanted');
const afterReject = await assets.findApproved(reqA, slugLive);
check('a REJECTED replacement also leaves the live model alone', String(afterReject._id) === String(liveFirst.asset._id));

function boxesSafe() {
  return buildBoxGlb({ width: 1.05, height: 4, depth: 0.5, segments: 5 });
}

const goodReplacement = await makeCandidate({ productSlug: slugLive, glb: boxesSafe(), referencePng: rectTall });
const replaced = await assets.approveAsset(reqA, goodReplacement.asset._id);
const archived = await Product3DAsset.findById(liveFirst.asset._id);
check('a good replacement becomes live and ARCHIVES the old model', replaced.asset.status === 'APPROVED' && archived.status === 'DEPRECATED');
check('  \u2026 recording what replaced it', String(archived.approval.replacedBy) === String(goodReplacement.asset._id));
const archivedBytes = await assetStorage.readAsset(archived.storage.glb.storageKey);
check('  \u2026 and the old model\u2019s bytes survive on disk', archivedBytes?.length === archived.storage.glb.bytes);

// ══════════════════════════════════════════════════════════════════════════
section('\u00a7E PUBLIC SURFACE \u2014 only an approved model is ever public');
// ══════════════════════════════════════════════════════════════════════════

const slugPublic = `quality-public-${stamp}`;
const publicFirst = await makeCandidate({ productSlug: slugPublic, glb: boxTall, referencePng: rectTall });
check('a candidate with no approval is NOT public', (await publicProduct3d(slugPublic, { workspaceId: wsA._id })) === null);

await assets.approveAsset(reqA, publicFirst.asset._id);
const publicApproved = await publicProduct3d(slugPublic, { workspaceId: wsA._id });
check('the approved model IS public', publicApproved?.id === String(publicFirst.asset._id));

const publicBlocked = await makeCandidate({ productSlug: slugPublic, glb: boxWide, referencePng: rectWide });
await errorFrom(() => assets.approveAsset(reqA, publicBlocked.asset._id));
const stillPublic = await publicProduct3d(slugPublic, { workspaceId: wsA._id });
check('a BLOCKED candidate never replaces the public model', stillPublic?.id === String(publicFirst.asset._id));
check('  \u2026 and the public projection carries no quality internals', stillPublic?.quality === undefined && stillPublic?.storage === undefined, JSON.stringify(Object.keys(stillPublic || {})));

const publicReviewCandidate = await makeCandidate({ productSlug: slugPublic, glb: spheresTiny(), referencePng: disc });
const publicReviewPublic = await publicProduct3d(slugPublic, { workspaceId: wsA._id });
check('a REVIEW candidate is not public either', publicReviewPublic?.id === String(publicFirst.asset._id));

function spheresTiny() {
  return buildSphereGlb({ radius: 1.4, segments: 16, rings: 12 });
}

// The delivery route's own rule: only APPROVED or CANDIDATE may be streamed.
const deprecatedRead = await errorFrom(() => assets.readPublishedAssetBytes(reqA, slugLive, liveFirst.asset._id, 'glb'));
check('a deprecated model is no longer reachable from a product page', codeOf(deprecatedRead) === 'ASSET_NOT_FOUND', codeOf(deprecatedRead));

// ══════════════════════════════════════════════════════════════════════════
section('\u00a7F TENANCY \u2014 a mismatch is a 404, never a 403');
// ══════════════════════════════════════════════════════════════════════════

const foreignRead = await errorFrom(() => assets.getAsset(reqB, passCandidate.asset._id));
const foreignApprove = await errorFrom(() => assets.approveAsset(reqB, blockedCandidate.asset._id));
const foreignAssess = await errorFrom(() => assets.reassessAsset(reqB, passCandidate.asset._id));
const foreignList = await assets.listAssetsForProduct(reqB, slugPass);
check('another workspace cannot read this workspace\u2019s asset', codeOf(foreignRead) === 'ASSET_NOT_FOUND', codeOf(foreignRead));
check('another workspace cannot approve it', codeOf(foreignApprove) === 'ASSET_NOT_FOUND', codeOf(foreignApprove));
check('another workspace cannot re-assess it', codeOf(foreignAssess) === 'ASSET_NOT_FOUND', codeOf(foreignAssess));
check('another workspace cannot list a product\u2019s assets', Array.isArray(foreignList) && foreignList.length === 0);
check('the 404 is a 404 and not a 403', foreignRead?.status === 404 && foreignApprove?.status === 404);

const foreignPublic = await publicProduct3d(slugPass, { workspaceId: wsB._id });
check('the public read is scoped to the product\u2019s workspace', foreignPublic === null);

// ══════════════════════════════════════════════════════════════════════════
section('CLEANUP');
// ══════════════════════════════════════════════════════════════════════════

cacheInvalidate3dDelivery(slugPublic);
await Product3DAsset.deleteMany({ productSlug: { $regex: `-${stamp}$` } });
await ProductReferenceImage.deleteMany({ productSlug: { $regex: `-${stamp}$` } });
await GenerationJob.deleteMany({ productSlug: { $regex: `-${stamp}$` } });
await User.deleteMany({ email: { $regex: `${stamp}@three\\.test$` } });
await Workspace.deleteMany({ _id: { $in: [wsA._id, wsB._id] } });
await fs.rm(MEDIA_DIR, { recursive: true, force: true });
check('the suite cleaned up its own private media roots', (await exists(MEDIA_DIR)) === false);
check('the suite removed its own database rows', (await Product3DAsset.countDocuments({ productSlug: { $regex: `-${stamp}$` } })) === 0);

await mongoose.connection.db.dropDatabase().catch(() => {});
await mongoose.disconnect();

// ══════════ summary ══════════
console.log('\n' + '='.repeat(52));
console.log(`3D QUALITY RESULT: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('failed checks:');
  for (const name of failures) console.log(`  - ${name}`);
}
console.log('='.repeat(52));
process.exit(failed ? 1 : 0);
