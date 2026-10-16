/**
 * PHASE 5 — ASSESS A REAL GENERATED MODEL, AND WRITE THE EVIDENCE.
 *
 * This is the honest counterpart to the fixture suite. `3d-quality-smoke.mjs`
 * proves the gate's ARITHMETIC on shapes whose answer is known; this script
 * points the same service at a model a real provider produced and records what
 * it actually scored — including when the answer is unflattering.
 *
 * IT DOES NOT NEED THE DATABASE, THE WORKER, OR A GPU. Everything it measures
 * comes from two files: the GLB and the reference image. That is deliberate —
 * the number must be reproducible by anyone holding those two files, which is
 * what makes it evidence rather than a claim.
 *
 * WHERE THE REFERENCE COMES FROM
 *   --cutout=<png>  a cutout already prepared by Phase 1 (preferred: it is the
 *                   exact mask the model was generated from);
 *   --photo=<jpg>   otherwise, the REAL Phase 1 background-removal engine runs
 *                   on the photograph here, and the report says it did.
 *
 * Usage:
 *   node scripts/3d-quality-report.mjs --glb=<model.glb> --photo=<photo.jpg> [--out=<dir>]
 *   node scripts/3d-quality-report.mjs --glb=<model.glb> --cutout=<cutout.png> [--out=<dir>]
 *
 * Exit codes — the distinction matters, so a caller never reads "could not
 * measure" as "measured badly":
 *   0  the model was assessed (read the decision from the report)
 *   1  the assessment itself failed
 *   2  an input was unavailable (no GLB, no reference, no engine to cut one out)
 *
 * Outputs (into an IGNORED directory — never committed):
 *   <name>.quality.json     the machine-readable report
 *   <name>.silhouette.png   reference | model | overlay, for a human to check
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');

const args = process.argv.slice(2);
const valueOf = (name, fallback = '') => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const GLB_PATH = valueOf('glb');
const CUTOUT_PATH = valueOf('cutout');
const PHOTO_PATH = valueOf('photo');
const OUT_DIR = path.resolve(REPO_ROOT, valueOf('out', 'audit/phase5-quality'));
const LABEL = valueOf('label', '') || path.basename(GLB_PATH || 'model').replace(/\.glb$/i, '');

const log = (message) => console.log(`[quality] ${message}`);
const die = async (code, message) => {
  if (message) console.error(`[quality] ${message}`);
  process.exit(code);
};

dotenv.config({ path: path.join(BACKEND_DIR, '.env'), override: false });

if (!GLB_PATH) await die(2, 'no model given — pass --glb=<path to a .glb>');
if (!CUTOUT_PATH && !PHOTO_PATH) {
  await die(2, 'no reference given — pass --cutout=<png> (preferred) or --photo=<image>');
}

const glbBuffer = await fs.readFile(path.resolve(GLB_PATH)).catch(() => null);
if (!glbBuffer?.length) await die(2, `the model could not be read: ${GLB_PATH}`);

const quality = await import('../services/3dQualityAssessment.js');
const geometry = await import('../services/3dMeshGeometry.js');
const silhouette = await import('../services/3dSilhouetteMetrics.js');

/* ── the reference: an existing cutout, or the real Phase 1 engine ────────── */
let cutoutBuffer = null;
let referenceSource = '';
let referenceEngine = null;
let referenceWarnings = [];
let referenceConfidence = null;

if (CUTOUT_PATH) {
  cutoutBuffer = await fs.readFile(path.resolve(CUTOUT_PATH)).catch(() => null);
  if (!cutoutBuffer?.length) await die(2, `the cutout could not be read: ${CUTOUT_PATH}`);
  referenceSource = 'cutout-file';
  log(`reference: prepared cutout ${CUTOUT_PATH}`);
} else {
  const photoBuffer = await fs.readFile(path.resolve(PHOTO_PATH)).catch(() => null);
  if (!photoBuffer?.length) await die(2, `the photograph could not be read: ${PHOTO_PATH}`);
  log('reference: running the Phase 1 background-removal engine on the photograph');
  const { removeBackground } = await import('../services/bgRemoval/index.js');
  try {
    const result = await removeBackground(photoBuffer, {});
    cutoutBuffer = result.cutout;
    referenceEngine = result.engine;
    referenceWarnings = result.warnings || [];
    referenceConfidence = result.confidence ?? null;
    referenceSource = 'phase1-engine';
    log(`  engine=${result.engine} model=${result.model || '—'} confidence=${result.confidence}`);
  } catch (err) {
    // NOT a failed assessment: nothing was measured, and saying otherwise would
    // be the exact confusion this script exists to avoid.
    await die(2, `no cutout is available and the Phase 1 engine could not produce one (${err.message}). The model was NOT assessed.`);
  }
}

/* ── assess ───────────────────────────────────────────────────────────────── */
const reference = {
  id: LABEL,
  engine: referenceEngine || 'provided-cutout',
  model: '',
  confidence: referenceConfidence,
  warnings: referenceWarnings,
  cutoutAvailable: true,
};

let report;
try {
  report = await quality.assessGlbBuffer({
    glbBuffer,
    cutoutBuffer,
    reference,
    referenceIds: [LABEL],
  });
} catch (err) {
  await die(1, `the assessment failed: ${err.message}`);
}

/* ── a diagnostic image a human can actually look at ─────────────────────── */
let diagnosticPath = null;
try {
  const measured = geometry.measureGeometry(glbBuffer, { fileBytes: glbBuffer.length });
  const view = report.silhouette?.selectedView || 'front';
  const projection = geometry.rasteriseSilhouette(measured.positions, measured.indices, view, { size: 160 });
  const modelNorm = silhouette.normaliseMask(
    { mask: projection.mask, width: projection.size, height: projection.size },
    {}
  );
  const decode = await quality.decodeCutoutMask(cutoutBuffer);
  const referenceNorm = decode.ok ? silhouette.normaliseMask(decode.mask, {}) : null;

  if (modelNorm && referenceNorm) {
    const size = referenceNorm.width;
    const scale = 2;
    const panel = size * scale;
    const gap = 8;
    const width = panel * 3 + gap * 2;
    const height = panel;
    const canvas = Buffer.alloc(width * height * 3, 24); // dark background

    const paint = (mask, panelIndex, rgb) => {
      const originX = panelIndex * (panel + gap);
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          if (!mask[y * size + x]) continue;
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              const px = originX + x * scale + dx;
              const py = y * scale + dy;
              const at = (py * width + px) * 3;
              canvas[at] = rgb[0];
              canvas[at + 1] = rgb[1];
              canvas[at + 2] = rgb[2];
            }
          }
        }
      }
    };

    paint(referenceNorm.mask, 0, [90, 170, 120]); // reference
    paint(modelNorm.mask, 1, [120, 150, 220]); // model
    // Overlay: agreement in white, disagreement in the owner's colour.
    const originX = 2 * (panel + gap);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const inRef = referenceNorm.mask[y * size + x];
        const inModel = modelNorm.mask[y * size + x];
        if (!inRef && !inModel) continue;
        const rgb = inRef && inModel ? [245, 245, 245] : inRef ? [90, 170, 120] : [120, 150, 220];
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = originX + x * scale + dx;
            const py = y * scale + dy;
            const at = (py * width + px) * 3;
            canvas[at] = rgb[0];
            canvas[at + 1] = rgb[1];
            canvas[at + 2] = rgb[2];
          }
        }
      }
    }

    const sharp = (await import('sharp')).default;
    await fs.mkdir(OUT_DIR, { recursive: true });
    diagnosticPath = path.join(OUT_DIR, `${LABEL}.silhouette.png`);
    await sharp(canvas, { raw: { width, height, channels: 3 } }).png().toFile(diagnosticPath);
  }
} catch (err) {
  // A diagnostic image is a convenience, not the measurement.
  log(`note: the diagnostic image could not be written (${err.message})`);
}

/* ── the machine-readable evidence ────────────────────────────────────────── */
const sha256 = crypto.createHash('sha256').update(glbBuffer).digest('hex');
const payload = {
  tool: 'scripts/3d-quality-report.mjs',
  toolVersion: quality.ASSESSMENT_VERSION,
  assessedAt: new Date().toISOString(),
  asset: {
    label: LABEL,
    glbPath: path.resolve(GLB_PATH),
    sha256,
    bytes: glbBuffer.length,
    provider: valueOf('provider', 'unknown'),
  },
  reference: {
    source: referenceSource,
    path: path.resolve(CUTOUT_PATH || PHOTO_PATH),
    engine: referenceEngine,
    confidence: referenceConfidence,
    warnings: referenceWarnings,
    // Source dimensions, as the brief asks the report to state.
    width: report.reference?.sourceWidth ?? null,
    height: report.reference?.sourceHeight ?? null,
    aspect: report.reference?.cutoutAspect ?? null,
    cleanedComponents: report.reference?.cleaning?.components ?? null,
    droppedFraction: report.reference?.cleaning?.droppedFraction ?? null,
    flagged: report.reference?.flagged ?? null,
    flags: report.reference?.flags ?? [],
  },
  render: report.renderer,
  silhouette: report.silhouette,
  geometry: report.geometry
    ? {
        vertices: report.geometry.vertices,
        triangles: report.geometry.triangles,
        fileBytes: report.geometry.fileBytes,
        watertight: report.geometry.watertight,
        boundaryEdges: report.geometry.boundaryEdges,
        nonManifoldEdges: report.geometry.nonManifoldEdges,
        degenerateTriangles: report.geometry.degenerateTriangles,
        dimensions: report.geometry.dimensions,
        flatness: report.geometry.flatness,
        attributes: report.geometry.attributes,
        generator: report.geometry.generator,
        notes: report.geometry.notes,
      }
    : null,
  materials: report.materials,
  decision: report.decision,
  summary: report.summary,
  reasons: report.reasons,
  warnings: report.warnings,
  thresholds: report.thresholds,
  calibration: report.calibration,
  diagnosticImage: diagnosticPath,
};

await fs.mkdir(OUT_DIR, { recursive: true });
const jsonPath = path.join(OUT_DIR, `${LABEL}.quality.json`);
await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

log('');
log(`decision      ${report.decision}`);
log(`summary       ${report.summary}`);
if (report.silhouette?.available) {
  log(`silhouette    view=${report.silhouette.selectedView} (${report.silhouette.viewAgreement}) IoU=${report.silhouette.iou} aspectError=${report.silhouette.aspectError} contour=${report.silhouette.contourDistancePixels}px`);
} else {
  log(`silhouette    NOT MEASURED — ${report.silhouette?.reason}`);
}
if (report.geometry) {
  log(`geometry      ${report.geometry.vertices} vertices / ${report.geometry.triangles} triangles / watertight=${report.geometry.watertight} / ${report.geometry.fileBytes} bytes`);
}
if (report.materials) log(`materials     ${report.materials.state}`);
for (const reason of report.reasons) log(`reason        ${reason.code}: ${reason.message}`);
for (const warning of report.warnings) log(`warning       ${warning.code}: ${warning.message}`);
log(`report        ${jsonPath}`);
if (diagnosticPath) log(`diagnostic    ${diagnosticPath}`);

process.exit(0);
