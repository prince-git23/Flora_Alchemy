/**
 * three-readiness-report — read-only operational status of the 3D product
 * model feature. Answers four DIFFERENT questions that are easy to conflate:
 *
 *   1. is the feature implemented?         (code + routes present)
 *   2. is a generation provider reachable? (loopback worker / opt-in Meshy)
 *   3. is private media storage durable?   (a mounted disk, not the app tree)
 *   4. does any product actually have an approved, readable GLB?
 *
 * Usage (from backend/):
 *   node scripts/three-readiness-report.mjs                 # configured MONGO_URI
 *   node scripts/three-readiness-report.mjs --db=Flora-Alchemy
 *
 * It never writes, never spends credits, never prints credentials — provider
 * keys are reported as set/unset only, and the worker is probed on loopback.
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import { loadBackendEnv } from './lib/testServer.mjs';
import { classifyDatabase } from '../utils/environmentGuard.js';
import { mediaRootInfo as referenceRootInfo } from '../services/referenceAssetStorage.js';
import { mediaRootInfo as threeRootInfo } from '../services/3dAssetStorage.js';

loadBackendEnv();

const argv = process.argv.slice(2);
const dbArg = argv.find((a) => a.startsWith('--db='));
const targetDb = dbArg ? dbArg.slice(5) : null;

const rows = [];
const row = (stage, status, detail) => rows.push({ stage, status, detail });

// ── 1. implemented? (static evidence from this checkout) ──────────────────
{
  const backend = [
    'services/referenceImageService.js', 'services/bgRemoval/index.js',
    'services/3dModelProvider.js', 'services/3dLocalWorkerProvider.js',
    'services/3dGenerationService.js', 'services/3dAssetService.js',
    'services/3dModelValidation.js', 'services/3dAssetStorage.js',
    'services/3dQualityAssessment.js', 'services/product3dPublicResolution.js',
    'routes/referenceImageRoutes.js', 'routes/3dModelRoutes.js', 'routes/3dPublicRoutes.js',
  ];
  const frontend = [
    '../frontend/src/components/admin/ReferenceImageStudio.jsx',
    '../frontend/src/components/admin/GenerationJobsForProduct.jsx',
    '../frontend/src/components/admin/ThreeGlbPreview.jsx',
    '../frontend/src/components/Product3dViewer.jsx',
  ];
  const missing = [...backend, ...frontend].filter((p) => !fs.existsSync(new URL(`../${p}`, import.meta.url)));
  row('implemented (code)', missing.length ? 'partial' : 'yes',
    missing.length ? `missing: ${missing.join(', ')}` : `${backend.length} backend + ${frontend.length} frontend modules present`);
}

// ── 2. provider reachable? ────────────────────────────────────────────────
{
  const provider = String(process.env['3D_PROVIDER'] || '').trim() || '(unset → local_unavailable, generation disabled)';
  const meshyKeySet = Boolean(String(process.env.MESHY_API_KEY || '').trim());
  const workerUrl = String(process.env.THREE_WORKER_URL || 'http://127.0.0.1:8791');
  let reachable = false;
  let reason = '';
  try {
    const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(2500) });
    reachable = res.ok;
    reason = `HTTP ${res.status}`;
  } catch (e) {
    reason = `no answer at ${workerUrl} (${e.cause?.code || e.name || 'error'})`;
  }
  const operational = reachable || (provider === 'meshy' && meshyKeySet);
  row('generation provider', operational ? 'available' : 'unavailable',
    `3D_PROVIDER=${provider} · local worker: ${reason} · MESHY_API_KEY set: ${meshyKeySet}`);
}

// ── 3. private storage durable? ───────────────────────────────────────────
{
  const ref = referenceRootInfo();
  const three = threeRootInfo();
  const fmt = (r) => `${r.configured ? 'configured' : 'NOT configured'}${r.durable ? ' · durable' : ' · EPHEMERAL (inside the app tree)'}`;
  const durable = Boolean(ref.durable && three.durable);
  row('private media storage', durable ? 'durable' : 'not durable',
    `reference: ${fmt(ref)} · 3d: ${fmt(three)}`);
}

// ── 4. does any product actually have an approved, readable GLB? ──────────
{
  const uri = process.env.MONGO_URI;
  const cls = classifyDatabase(uri);
  const dbName = targetDb || cls.dbName;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 12000 });
    const db = mongoose.connection.useDb(dbName, { noStore: true }).db;
    const assets = db.collection('product3dassets');
    const refs = db.collection('productreferenceimages');
    const jobs = db.collection('generationjobs');
    const products = await db.collection('products').countDocuments({});
    const approved = await assets.countDocuments({ status: 'approved' });
    const withBytes = await assets.countDocuments({ status: 'approved', 'file.storageKey': { $exists: true } });
    const readable = await assets.countDocuments({ status: 'approved', 'validation.valid': true });
    const refImages = await refs.countDocuments({});
    const jobCount = await jobs.countDocuments({});
    let missingFiles = 0;
    const root = threeRootInfo().root;
    for (const a of await assets.find({ status: 'approved' }).project({ 'file.storageKey': 1 }).toArray()) {
      const key = a.file?.storageKey;
      if (!key || !fs.existsSync(`${root}/${key}`)) missingFiles += 1;
    }
    row('approved models on the live data', approved > 0 && readable > 0 ? 'present' : 'none',
      `database "${dbName}": products=${products} · approved assets=${approved} ` +
      `(with storage key: ${withBytes}, validation valid: ${readable}, bytes missing on disk: ${missingFiles}) · ` +
      `reference images=${refImages} · generation jobs=${jobCount}`);
  } catch (e) {
    row('approved models on the live data', 'unknown', `could not read "${dbName}": ${e.codeName || e.message}`);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

console.log('\n3D PRODUCT MODEL — OPERATIONAL READINESS');
console.log('─────────────────────────────────────────────────────────────');
for (const r of rows) console.log(`  ${r.stage.padEnd(30)} ${r.status.padEnd(12)} ${r.detail}`);
console.log('─────────────────────────────────────────────────────────────');
console.log('  note: "implemented" describes this checkout; "available" describes THIS machine.');
console.log('  A production deploy cannot reach a loopback worker — enabling generation there');
console.log('  needs a deliberate 3D_PROVIDER decision (see docs/IMAGE_STUDIO.md).');
process.exit(0);
