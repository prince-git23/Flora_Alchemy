/**
 * PHASE 4 — REAL LOCAL GENERATION, END TO END (opt-in, gated, isolated).
 *
 * This script is the honest answer to "did an AI actually generate a product
 * model?". It drives the SHIPPED pipeline against a REAL local worker and a REAL
 * product photograph:
 *
 *   real catalogue photograph
 *     → Phase 1 reference service (real background-removal engine, real cutout on disk)
 *     → ACCEPTED reference row
 *     → Phase 2 job (real row, real claim, real poll loop)
 *     → the `local_worker` provider over real HTTP to tools/3d-worker/worker.py
 *     → TripoSR inference on the GPU
 *     → real GLB bytes → real container validation → real private storage
 *     → CANDIDATE asset → real approval → real public projection
 *
 * NOTHING HERE IS A FIXTURE. There is no test provider, no synthetic mesh and no
 * copied asset: if the worker is not running, this script SKIPS (exit 0) — and
 * with `--require-worker` it fails instead, so a run that was supposed to prove
 * generation cannot quietly report success without it.
 *
 * ISOLATION — it never touches dev or production data:
 *   · its own disposable database (`Flora-Alchemy-Test-Phase4Gen` by default, and
 *     the shared testDatabase guard refuses any name without a test marker);
 *   · its own private media roots under the OS temp directory;
 *   · it drops its database at the end unless `--keep` is passed (keep leaves the
 *     approved model in place for a browser verification pass, which is what the
 *     Phase 4 report used it for).
 *
 * Usage:
 *   node scripts/3d-real-generation.mjs [--require-worker] [--keep] [--slug=...] [--photo=...]
 *                                      [--review-note="why a human accepts this"]
 *   npm run test:3d-real
 *
 * Exit codes: 0 = generated and approved (or skipped, unless --require-worker) ·
 *             1 = failed · 2 = --require-worker and the worker was not available ·
 *             3 = generated and measured, but the QUALITY GATE refused normal
 *                 approval. The artifacts are still written: a gate decision is a
 *                 result to examine, not a reason to lose the measurements.
 *
 * PHASE 6 — WHY THE ARTIFACTS ARE WRITTEN BEFORE APPROVAL, AND WHY THE CUTOUT IS
 * KEPT. An evaluation run has to leave behind what it measured: the GLB, the
 * accepted cutout it was generated from, the worker's own numbers and the gate's
 * verdict. `scripts/3d-quality-report.mjs --glb=… --cutout=…` re-measures the SAME
 * question from those two files with no database, no GPU and no second Phase 1
 * run deciding a different mask. Writing them first means a REVIEW or BLOCKED
 * verdict still produces evidence; approval is recorded as an outcome of the run
 * rather than as a precondition for having a run at all.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const valueOf = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const stamp = Date.now().toString(36);
const DB_NAME = process.env.THREE_REAL_DB || 'Flora-Alchemy-Test-Phase4Gen';
const WORKER_URL = (process.env.THREE_WORKER_URL || 'http://127.0.0.1:8791').replace(/\/+$/, '');
const PRODUCT_SLUG = valueOf('slug', `heirloom-keepsake-hamper-phase4-${stamp}`);
/* A REVIEW verdict means "a human must look". When one has, this records what they
   said — the same acknowledgement the studio collects. Never `--override`: a
   BLOCKED model is refused on purpose, and this script measures, it does not
   overrule the gate. */
const REVIEW_NOTE = valueOf('review-note', '');
const PHOTO = path.resolve(
  REPO_ROOT,
  valueOf('photo', 'frontend/public/assets/images/flora-asset-10.jpg')
);
const ARTIFACT_DIR = path.join(REPO_ROOT, 'audit', 'phase4-real-generation');
const WORKSPACE_SLUG = `phase4-real-${stamp}`;
const POLL_MS = 3_000;
const JOB_TIMEOUT_MS = Number(process.env.THREE_REAL_TIMEOUT_MS || 15 * 60 * 1000);

const log = (msg) => console.log(`[phase4] ${msg}`);
const die = async (code, msg, err) => {
  if (msg) console.error(`[phase4] ${msg}`);
  if (err) console.error(err?.stack || String(err));
  process.exit(code);
};

/* ── environment must be pinned BEFORE the services resolve their roots ───── */
dotenv.config({ path: path.join(BACKEND_DIR, '.env'), override: false });
process.env.NODE_ENV = 'development';
process.env.REFERENCE_MEDIA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-refs-'));
process.env.THREE_MEDIA_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-3d-'));
// Real generation writes its evidence into those temp roots and reads it back
// from disk, so the object driver must be the filesystem one even when .env
// carries live Supabase credentials (those belong to the deployed API).
process.env.MEDIA_STORAGE_DRIVER = 'filesystem';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_STORAGE_BUCKET = '';
process.env.SUPABASE_SECRET_KEY = '';
process.env['THREE_D_PROVIDER'] = 'local_worker';
process.env.THREE_WORKER_URL = WORKER_URL;

const mongoose = (await import('mongoose')).default;
const { testMongoUri } = await import('./lib/testServer.mjs');
const { default: Workspace } = await import('../models/Workspace.js');
const { default: User } = await import('../models/User.js');
const { default: Product } = await import('../models/Product.js');
const { default: ProductReferenceImage } = await import('../models/ProductReferenceImage.js');
const { default: GenerationJob } = await import('../models/GenerationJob.js');
const { default: Product3DAsset } = await import('../models/Product3DAsset.js');
const refs = await import('../services/referenceImageService.js');
const generation = await import('../services/3dGenerationService.js');
const assets = await import('../services/3dAssetService.js');
const { publicProduct3d } = await import('../services/product3dPublicResolution.js');
const { validateGlb } = await import('../services/3dModelValidation.js');
const provider = await import('../services/3dModelProvider.js');
const bcrypt = (await import('bcryptjs')).default;

/* ── worker availability (the gate) ──────────────────────────────────────── */
async function workerHealth() {
  try {
    const res = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: Boolean(body.ready), detail: body.detail || '', health: body };
  } catch (err) {
    return { ok: false, detail: err?.message || String(err) };
  }
}

async function main() {
  const worker = await workerHealth();
  if (!worker.ok) {
    const line =
      `the local 3D worker at ${WORKER_URL} is not ready (${worker.detail}). ` +
      'Start it with tools/3d-worker/worker.py, then run this again.';
    if (hasFlag('require-worker')) {
      await die(2, `REQUIRED WORKER UNAVAILABLE — ${line}`);
    }
    log(`SKIPPED — ${line}`);
    log('No generation was attempted, so nothing here is evidence of a generated model.');
    return 0;
  }

  log(`worker ready: ${worker.health?.model} ${worker.health?.modelVersion} on ${worker.health?.device}`);
  log(`  GPU: ${worker.health?.gpuName} (${worker.health?.vramTotalMb} MB VRAM), marching cubes: ${worker.health?.marchingCubes}`);
  log(`  torch ${worker.health?.torch} · python ${worker.health?.python} · licence ${worker.health?.modelLicense}`);

  /* ── database ──────────────────────────────────────────────────────────── */
  const uri = testMongoUri(process.env.MONGO_URI, DB_NAME);
  if (!uri) await die(1, 'MONGO_URI is not configured (backend/.env); refusing to run without an isolated database.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });
  const dbName = mongoose.connection.db.databaseName;
  try {
    await mongoose.connection.db.dropDatabase();
    await Promise.all([
      Workspace.init(), User.init(), Product.init(),
      ProductReferenceImage.init(), GenerationJob.init(), Product3DAsset.init(),
    ]);

    const workspace = await Workspace.create({
      slug: WORKSPACE_SLUG, displayName: 'Phase 4 Real Generation', status: 'ACTIVE',
    });
    const user = await User.create({
      email: `phase4-real-${stamp}@three.test`,
      passwordHash: await bcrypt.hash(`Phase4-${stamp}!,`, 10),
      role: 'admin', name: 'Phase 4 Admin', status: 'ACTIVE', workspaceId: workspace._id,
    });
    // A request-shaped identity: exactly what the services consume.
    const req = { user, workspaceSlug: workspace.slug };

    /* ── 1. the real photograph, through the real Phase 1 pipeline ───────── */
    const photo = await fs.readFile(PHOTO);
    log(`1/6 photograph: ${path.relative(REPO_ROOT, PHOTO)} (${(photo.length / 1024).toFixed(0)} KB, sha256 ${crypto.createHash('sha256').update(photo).digest('hex').slice(0, 12)}…)`);
    await Product.create({
      slug: PRODUCT_SLUG, name: 'Heirloom Keepsake Wooden Hamper Box (Phase 4)', price: 3450,
      sku: `FA-P4-${stamp}`, category: 'Custom Gifts & Hampers', workspaceId: workspace._id,
      image: '/assets/images/flora-asset-10.jpg', images: ['/assets/images/flora-asset-10.jpg'],
    });

    const created = await refs.createReferenceImage(req, {
      file: { buffer: photo, originalname: path.basename(PHOTO), mimetype: 'image/jpeg' },
      productSlug: PRODUCT_SLUG, label: 'catalogue photograph',
    });
    // The service returns the row plus the upload's notes and any duplicate it
    // recognised; the id is the row's own.
    const referenceId = created?.doc?._id ? String(created.doc._id) : '';
    if (!referenceId) await die(1, 'the reference service returned no row id');
    if (created.duplicateOf) await die(1, `the photograph was rejected as a duplicate of ${created.duplicateOf}`);

    let ref = null;
    const refDeadline = Date.now() + 120_000;
    while (Date.now() < refDeadline) {
      ref = await refs.getReferenceImage(req, referenceId);
      if (['READY', 'NEEDS_REVIEW', 'FAILED'].includes(ref?.status)) break;
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (!ref || ref.status === 'FAILED') await die(1, `Phase 1 processing did not complete (status ${ref?.status})`);

    const raw = await ProductReferenceImage.findOne({ _id: referenceId }).lean();
    log(
      `2/6 Phase 1 cutout: engine=${raw.processing?.engine} model=${raw.processing?.model || 'n/a'} ` +
        `status=${ref.status} confidence=${ref.confidence} ${raw.cutout?.width}x${raw.cutout?.height} ` +
        `(${(raw.cutout?.bytes / 1024).toFixed(0)} KB)`
    );
    await refs.updateReferenceImage(req, referenceId, { accepted: true, isPrimary: true });
    log('     reference ACCEPTED (nothing is generated from material a person did not accept)');

    /* ── 3. the real job, through the real provider ───────────────────────── */
    const plan = await generation.planForProduct(req, PRODUCT_SLUG);
    log(`3/6 plan: provider=${plan.provider} model=${plan.model} ${plan.modelVersion} available=${plan.available} inputs=${plan.maxInputs} view=${plan.viewCount}`);
    const started = Date.now();
    const { job } = await generation.startGeneration(req, {
      productSlug: PRODUCT_SLUG,
      referenceIds: [referenceId],
      quality: 'standard',
      notes: 'Phase 4 real local generation',
    });
    log(`     job ${job.id} created and claimed (provider ${job.provider} ${job.providerModel || ''})`);

    let current = job;
    let lastStage = '';
    while (Date.now() - started < JOB_TIMEOUT_MS) {
      current = await generation.getJob(req, job.id);
      const stage = `${current.status}${current.providerExtra?.providerTaskStatus ? `/${current.providerExtra.providerTaskStatus}` : ''}${current.providerExtra?.progress != null ? ` ${current.providerExtra.progress}%` : ''}`;
      if (stage !== lastStage) {
        log(`     ${stage} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
        lastStage = stage;
      }
      if (['READY_FOR_REVIEW', 'FAILED', 'CANCELLED'].includes(current.status)) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    const jobSeconds = (Date.now() - started) / 1000;
    if (current.status !== 'READY_FOR_REVIEW') {
      await die(1, `the job ended in ${current.status}: ${current.error?.code || ''} ${current.error?.message || ''}`);
    }
    log(`     job READY_FOR_REVIEW after ${jobSeconds.toFixed(1)}s (providerTaskId ${current.providerTaskId})`);

    /* ── 4. the candidate, its bytes and its measured quality ─────────────── */
    const assetList = await assets.listAssetsForProduct(req, PRODUCT_SLUG);
    const candidate = assetList.find((a) => a.status === 'CANDIDATE' && String(a.id));
    if (!candidate) await die(1, 'no CANDIDATE asset was produced');
    if (candidate.provider !== 'local_worker') await die(1, `the candidate records provider "${candidate.provider}", not local_worker`);

    const bytes = await assets.readAssetBytes(req, candidate.id, 'glb');
    const fileSha = crypto.createHash('sha256').update(bytes.buffer).digest('hex');
    const container = validateGlb(bytes.buffer);
    if (!container.ok) await die(1, `the stored GLB does not validate: ${container.code} ${container.message}`);

    // What the worker reported for the SAME task, so the shipped bytes can be tied
    // back to one specific inference rather than to "some run".
    let taskMetrics = null;
    let taskMeta = null;
    try {
      const res = await fetch(`${WORKER_URL}/tasks/${current.providerTaskId}`, { signal: AbortSignal.timeout(15_000) });
      const task = await res.json();
      taskMetrics = task?.result || null;
      taskMeta = task;
    } catch { /* the artifact below simply records it as unavailable */ }

    log(`4/6 candidate ${candidate.id} v${candidate.version}: ${container.meshes} mesh, ${container.materials} material, ${container.textures} texture, ${(bytes.buffer.length / 1024).toFixed(0)} KB`);
    if (taskMetrics) {
      log(
        `     worker: ${taskMetrics.vertices} verts / ${taskMetrics.faces} faces, watertight=${taskMetrics.watertight}, ` +
          `vertexColours=${taskMetrics.vertexColors}, vramPeak=${taskMetrics.vramPeakMb} MB, resolution=${taskMetrics.resolution}, ` +
          `inference wall ${((taskMeta?.durationMs ?? taskMetrics.durationMs ?? 0) / 1000).toFixed(1)}s`
      );
      if (taskMetrics.sha256 && taskMetrics.sha256 !== fileSha) {
        await die(1, `the stored bytes do not match the worker's own sha256 (${taskMetrics.sha256.slice(0, 12)} vs ${fileSha.slice(0, 12)})`);
      }
    }

    // The GLB's own attribute set: three.js needs NORMAL (or it shades flat) and
    // COLOR_0 is how TripoSR's texture reaches the customer when no UV atlas exists.
    const jsonLen = bytes.buffer.readUInt32LE(12);
    const gltf = JSON.parse(bytes.buffer.subarray(20, 20 + jsonLen).toString('utf8'));
    const attributes = [...new Set((gltf.meshes || []).flatMap((m) => (m.primitives || []).flatMap((p) => Object.keys(p.attributes || {}))))].sort();
    log(`     glTF attributes: ${attributes.join(', ') || 'none'} · generator "${gltf.asset?.generator || ''}"`);

    /* ── 5. THE EVIDENCE, written before any decision ───────────────────────
       The model itself, the accepted cutout it came from, and the gate's own
       verdict. This happens BEFORE approval on purpose: a verdict that refuses
       approval is one of the outcomes this run exists to record, and a run that
       dies first would leave no model to examine. */
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });

    // THE MODEL ITSELF, kept beside the report. Without it the run leaves only
    // a hash, and the browser pass (`THREE_E2E_REAL_GLB=<path>`) would have to
    // regenerate to get bytes to publish. This is the exact file that was
    // approved below — written from the STORED bytes, so a mismatch would be
    // impossible to hide. `/audit/` is gitignored, so no generated model can be
    // committed by accident.
    const glbPath = path.join(ARTIFACT_DIR, `${PRODUCT_SLUG}.glb`);
    await fs.writeFile(glbPath, bytes.buffer);

    /* THE ACCEPTED SOURCE REFERENCE, kept beside the model it generated: the
       exact cutout Phase 1 prepared and a human accepted, not a re-derivation.
       `scripts/3d-quality-report.mjs --glb=<glb> --cutout=<this>` therefore
       re-measures the identical question later, from two files, without a
       database, a GPU or a second engine run choosing a different mask. */
    const { readAsset: readReferenceAsset } = await import('../services/referenceAssetStorage.js');
    const cutoutBuffer = raw.cutout?.storageKey
      ? await readReferenceAsset(raw.cutout.storageKey).catch(() => null)
      : null;
    const cutoutPath = cutoutBuffer?.length
      ? path.join(ARTIFACT_DIR, `${PRODUCT_SLUG}-reference-cutout.png`)
      : null;
    if (cutoutPath) await fs.writeFile(cutoutPath, cutoutBuffer);
    else await die(1, 'the accepted cutout could not be read back, so this run cannot be re-measured');
    const cutoutSha = crypto.createHash('sha256').update(cutoutBuffer).digest('hex');
    log(
      `5/6 evidence: ${path.relative(REPO_ROOT, glbPath)} (${(bytes.buffer.length / 1024).toFixed(0)} KB) ` +
        `+ accepted cutout ${path.relative(REPO_ROOT, cutoutPath)} (sha256 ${cutoutSha.slice(0, 12)}…)`
    );

    /* The gate's verdict, measured server-side from the stored bytes and this
       reference — recorded even when it is unflattering. */
    const quality = {
      version: candidate.quality?.version || '',
      decision: candidate.quality?.decision || '',
      stale: candidate.quality?.stale ?? null,
      fingerprint: candidate.quality?.fingerprint || '',
      summary: candidate.quality?.summary || '',
      iou: candidate.quality?.silhouette?.iou ?? null,
      aspectError: candidate.quality?.silhouette?.aspectError ?? null,
      selectedView: candidate.quality?.silhouette?.selectedView || '',
      viewAgreement: candidate.quality?.silhouette?.viewAgreement || '',
      viewMargin: candidate.quality?.silhouette?.viewMargin ?? null,
      reasons: (candidate.quality?.reasons || []).map((r) => r.code),
      warnings: (candidate.quality?.warnings || []).map((w) => w.code),
      materialState: candidate.quality?.materials?.state || '',
      triangles: candidate.quality?.geometry?.triangles ?? null,
      calibration: candidate.quality?.calibration || null,
    };
    log(
      `     quality gate: ${quality.decision || '<none>'} (IoU ${quality.iou ?? 'n/a'}, ` +
        `view ${quality.selectedView || 'n/a'}/${quality.viewAgreement || 'n/a'})` +
        `${quality.reasons.length ? ` · reasons ${quality.reasons.join(', ')}` : ''}`
    );

    /* ── 6. approval through the shipped approval path ────────────────────── */
    let approvalOutcome = { approved: false, code: '', message: '' };
    let approved = null;
    let projection = null;
    try {
      const approval = await generation.approveJobCandidate(
        req,
        job.id,
        candidate.id,
        REVIEW_NOTE ? { reviewNote: REVIEW_NOTE } : {}
      );
      approved = await assets.findApproved(req, PRODUCT_SLUG);
      if (!approved) await die(1, 'approval did not produce an approved model');
      approvalOutcome = {
        approved: true,
        code: '',
        message: '',
        replacedAssetId: approval.replacedAssetId || '',
        reviewNote: REVIEW_NOTE,
        acknowledgedBy: approved.quality?.review?.acknowledgedBy ? String(approved.quality.review.acknowledgedBy) : '',
        gateDecision: approved.quality?.decision || '',
      };
      log(
        `6/6 APPROVED by the shipped service (replaced ${approval.replacedAssetId || 'nothing — first model'})` +
          `${REVIEW_NOTE ? ' after a human review note' : ''}`
      );

      projection = await publicProduct3d(PRODUCT_SLUG, { workspaceId: workspace._id });
      if (!projection) await die(1, 'the public projection is empty for an approved model');
      log(`     public projection: id=${projection.id} v${projection.version} provider="${projection.provider}" bytes=${projection.bytes} url=${projection.delivery?.glb}`);
    } catch (err) {
      /* A refusal is an OUTCOME here, not a crash. The message is the gate's own,
         so the reason a real model was not published is the server's wording. */
      approvalOutcome = {
        approved: false,
        code: err?.code || err?.name || 'APPROVAL_REFUSED',
        message: err?.message || String(err),
        reviewNote: REVIEW_NOTE,
      };
      log(`6/6 the quality gate refused approval: [${approvalOutcome.code}] ${approvalOutcome.message}`);
    }

    let previewSaved = null;
    if (taskMeta?.result?.previewAvailable) {
      try {
        const res = await fetch(`${WORKER_URL}/tasks/${current.providerTaskId}/preview`, { signal: AbortSignal.timeout(30_000) });
        if (res.ok) {
          previewSaved = path.join(ARTIFACT_DIR, `${PRODUCT_SLUG}-worker-render.png`);
          await fs.writeFile(previewSaved, Buffer.from(await res.arrayBuffer()));
        }
      } catch { /* evidence is best-effort; the numbers above are not */ }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      photo: { path: path.relative(REPO_ROOT, PHOTO), bytes: photo.length, sha256: crypto.createHash('sha256').update(photo).digest('hex') },
      phase1: {
        engine: raw.processing?.engine || '', model: raw.processing?.model || '',
        cutout: { width: raw.cutout?.width, height: raw.cutout?.height, bytes: raw.cutout?.bytes },
        confidence: ref.confidence ?? null, durationMs: raw.processing?.durationMs ?? null,
      },
      reference: {
        accepted: true,
        artifact: path.relative(REPO_ROOT, cutoutPath),
        sha256: cutoutSha,
        bytes: cutoutBuffer.length,
        engine: raw.processing?.engine || '',
        engineModel: raw.processing?.model || '',
        confidence: ref.confidence ?? null,
        width: raw.cutout?.width,
        height: raw.cutout?.height,
      },
      quality,
      approval: approvalOutcome,
      worker: worker.health || null,
      job: {
        id: String(job.id), provider: current.provider, providerModel: current.providerModel,
        providerTaskId: current.providerTaskId, seconds: Number(jobSeconds.toFixed(2)),
        workerTask: taskMeta ? { durationMs: taskMeta.durationMs, stage: taskMeta.stage, status: taskMeta.status } : null,
      },
      task: taskMetrics,
      asset: {
        id: candidate.id, version: candidate.version, bytes: bytes.buffer.length, sha256: fileSha,
        container, attributes, gltfGenerator: gltf.asset?.generator || '',
        glbArtifact: path.relative(REPO_ROOT, glbPath),
      },
      approvedAssetId: approved ? String(approved.id) : null,
      publicProjection: projection,
      database: dbName,
      previewSaved: previewSaved ? path.relative(REPO_ROOT, previewSaved) : null,
    };
    const reportPath = path.join(ARTIFACT_DIR, `${PRODUCT_SLUG}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

    log(`     artifacts: ${path.relative(REPO_ROOT, reportPath)}, ${path.relative(REPO_ROOT, glbPath)}, ${path.relative(REPO_ROOT, cutoutPath)}${previewSaved ? ` and ${path.relative(REPO_ROOT, previewSaved)}` : ''}`);
    log(`     re-measure any time: node scripts/3d-quality-report.mjs --glb="${glbPath}" --cutout="${cutoutPath}"`);
    log(`     browser pass: THREE_E2E_REAL_GLB="${glbPath}"`);

    if (!approvalOutcome.approved) {
      console.log('\n════════ PHASE 4 REAL GENERATION: GENERATED, MEASURED, NOT APPROVED ════════');
      console.log(`  model       ${current.providerModel} (${taskMetrics?.modelVersion || 'n/a'}) via ${current.provider} — a REAL generated model`);
      console.log(`  mesh        ${taskMetrics?.vertices ?? '?'} vertices / ${taskMetrics?.faces ?? '?'} faces · ${(bytes.buffer.length / 1024).toFixed(0)} KB GLB`);
      console.log(`  gate        ${quality.decision || '<none>'} · IoU ${quality.iou ?? 'n/a'} · view ${quality.selectedView || 'n/a'}/${quality.viewAgreement || 'n/a'}`);
      console.log(`  refused     [${approvalOutcome.code}] ${approvalOutcome.message}`);
      console.log('  The artifacts above are the evidence. This is the gate working, not a broken run.');
      console.log('  Publishing a REVIEW verdict needs a human review note (--review-note="…");');
      console.log('  a BLOCKED verdict needs an administrator override through the portal.');
      return 3;
    }

    console.log('\n════════ PHASE 4 REAL GENERATION: SUCCEEDED ════════');
    console.log(`  model       ${current.providerModel} (${taskMetrics?.modelVersion || 'n/a'}) via ${current.provider}`);
    console.log(`  device      ${taskMetrics?.device || 'n/a'} ${taskMetrics?.gpuName || ''} · peak VRAM ${taskMetrics?.vramPeakMb ?? '?'} MB`);
    console.log(`  mesh        ${taskMetrics?.vertices ?? '?'} vertices / ${taskMetrics?.faces ?? '?'} faces · ${(bytes.buffer.length / 1024).toFixed(0)} KB GLB`);
    console.log(`  timing      job ${jobSeconds.toFixed(1)}s (worker task ${((taskMeta?.durationMs ?? 0) / 1000).toFixed(1)}s, model load ${worker.health?.loadSeconds}s) · total run ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`  approval    ${candidate.id} → APPROVED ${approved.approval?.approvedAt ? new Date(approved.approval.approvedAt).toISOString() : ''}`);
    console.log(`  public URL  ${projection.delivery?.glb}`);
    console.log(`  database    ${dbName}${hasFlag('keep') ? ' (kept for the browser pass)' : ' (dropping)'}`);

    if (hasFlag('keep')) {
      // The DATABASE and the MEDIA have to be kept TOGETHER: keeping the row and
      // deleting the bytes would leave a product whose approved model 404s, which
      // is exactly the state a browser pass must not be given.
      log(`--keep: leaving ${dbName} plus its media in place for a browser pass.`);
      log(`  private 3D media root : ${process.env.THREE_MEDIA_ROOT}`);
      log(`  reference media root  : ${process.env.REFERENCE_MEDIA_DIR}`);
      log(`  start the backend with both variables set to those paths, e.g.:`);
      log(`    THREE_MEDIA_ROOT="${process.env.THREE_MEDIA_ROOT}" REFERENCE_MEDIA_DIR="${process.env.REFERENCE_MEDIA_DIR}" MONGO_URI=<.../${dbName}> node server.js`);
    }
    return 0;
  } finally {
    if (!hasFlag('keep')) {
      await mongoose.connection.db.dropDatabase().catch(() => {});
      log(`dropped ${DB_NAME}`);
      await fs.rm(process.env.REFERENCE_MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
      await fs.rm(process.env.THREE_MEDIA_ROOT, { recursive: true, force: true }).catch(() => {});
    }
    await mongoose.disconnect().catch(() => {});
  }
}

const code = await main().catch(async (err) => {
  await die(1, 'the run threw', err);
});
process.exit(code ?? 0);
