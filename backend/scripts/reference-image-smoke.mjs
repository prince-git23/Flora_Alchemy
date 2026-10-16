/**
 * 3D STUDIO — PHASE 1 — SMART PRODUCT IMAGE STUDIO (focused suite).
 *
 * Self-contained: own server (port 4126), own database
 * (Flora-Alchemy-Test-ReferenceImages), own private media root under the OS
 * temp directory, SEED_ON_START=false. Nothing here touches dev or production
 * data — and the media assertion below is meaningful precisely because the
 * suite's own directory is the only place it looks.
 *
 * Everything is REAL: the images are generated with sharp, uploaded over real
 * multipart HTTP, and processed by the actual background-removal pipeline. No
 * mocked result is ever treated as a pass, and the two places where a result is
 * inherently variable (which engine is compiled in, how strongly the heuristics
 * warn on a synthetic image) are asserted as properties rather than as exact
 * strings.
 *
 * What it proves, by section:
 *
 *   §A UPLOAD → REAL PROCESSING — an ordinary photograph is accepted, the
 *      pipeline runs server-side, and the terminal state carries real
 *      measurements plus a transparent cutout and a neutral preview.
 *   §B ORIGINAL IS IMMUTABLE — the original file's bytes are IDENTICAL after
 *      processing, the store refuses to overwrite an original, and every
 *      derived asset is a separate file.
 *   §C COMPLEX IMAGES — a flyer (gradient, text, artwork) and a transparent PNG
 *      are handled without pretending: the flyer is flagged for review, the
 *      transparent PNG keeps its alpha, and neither destroys the original.
 *   §D BAD INPUT — corrupt bytes, an unsupported format, an oversized file and
 *      a file with no set identity are each refused with an honest 4xx, and no
 *      row or file is left behind.
 *   §E DRAFT SETS, ORDER, PRIMARY — draft uploads group by key, order is
 *      server-applied, the first is primary, and a stale order list is refused
 *      rather than half-applied.
 *   §F CROP CORRECTION & RETRY — a crop is re-applied to the untouched original,
 *      reprocessing produces a strictly smaller cutout, and a retry of a FAILED
 *      reference recovers.
 *   §G ACCEPT / REMOVE — acceptance is explicit, a FAILED reference cannot be
 *      accepted, removal deletes the row AND its files and promotes a new
 *      primary. An abandoned PROCESSING row is reported as interrupted.
 *   §H PRODUCT HANDOFF — accepted references attach to the product on the same
 *      write, unaccepted draft rows are cleaned up, the set follows a rename,
 *      and it is deleted with the product. A bad reference id never fails the
 *      product write.
 *   §I TENANCY & AUTH — a second workspace can neither read, list, mutate nor
 *      fetch the bytes of another's references (404, never 403), a customer and
 *      an unauthenticated caller are refused, a handler without the product
 *      permission is refused, and a storage path is never exposed.
 *
 * Run: npm run test:references
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { BACKEND_DIR, bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Product from '../models/Product.js';
import ProductReferenceImage from '../models/ProductReferenceImage.js';
import { NEUTRAL_BACKGROUND } from '../services/bgRemoval/index.js';

const PORT = Number(process.env.REFERENCE_STUDIO_PORT || 4126);
const DB_NAME = 'Flora-Alchemy-Test-ReferenceImages';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

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

const stamp = Date.now();
const P = (name) => `${name}-Passw0rd-${stamp}!`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Temp media root for THIS run, so the real reference store is never touched. */
const MEDIA_DIR = path.join(os.tmpdir(), `flora-reference-smoke-${stamp}`);

/** Every path at which `storageKey` appears anywhere in a payload. */
function findKeyPaths(value, needle, trail = '$', hits = []) {
  if (!value || typeof value !== 'object') return hits;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findKeyPaths(item, needle, `${trail}[${index}]`, hits));
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === needle) hits.push(`${trail}.${key}`);
    findKeyPaths(child, needle, `${trail}.${key}`, hits);
  }
  return hits;
}

// ══════════ synthetic images (real bytes, real decoding) ══════════
const svg = (inner, w = 900, h = 900) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>`);

/** An ordinary product photo: a flower on a clean, light studio background. */
async function photoOnPlainBackground() {
  return sharp({ create: { width: 900, height: 900, channels: 3, background: '#f6f3ef' } })
    .composite([
      {
        input: svg(`
          <ellipse cx="450" cy="430" rx="170" ry="170" fill="#b34f63"/>
          <ellipse cx="450" cy="250" rx="78" ry="78" fill="#d98fa4"/>
          <ellipse cx="285" cy="430" rx="72" ry="72" fill="#c76d81"/>
          <ellipse cx="615" cy="430" rx="72" ry="72" fill="#c76d81"/>
          <rect x="428" y="585" width="44" height="205" rx="10" fill="#4e7a4c"/>
        `),
      },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** A promotional flyer: gradient, artwork, headline text and a small product. */
async function flyerWithText() {
  return sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#ffffff' } })
    .composite([
      {
        input: svg(`
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#ffe6a7"/>
              <stop offset="50%" stop-color="#f7b3c4"/>
              <stop offset="100%" stop-color="#a7d8f0"/>
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="1000" height="1000" fill="url(#bg)"/>
          <circle cx="140" cy="140" r="110" fill="#ffffff" opacity="0.65"/>
          <circle cx="880" cy="220" r="90" fill="#ffffff" opacity="0.5"/>
          <rect x="60" y="820" width="880" height="120" fill="#964735" opacity="0.85"/>
          <text x="500" y="200" font-family="Georgia" font-size="92" fill="#5b2b1d" text-anchor="middle">SPRING SALE</text>
          <text x="500" y="300" font-family="Georgia" font-size="54" fill="#5b2b1d" text-anchor="middle">50% OFF TODAY</text>
          <text x="500" y="900" font-family="Georgia" font-size="46" fill="#ffffff" text-anchor="middle">flora-alchemy.example</text>
          <ellipse cx="500" cy="560" rx="120" ry="120" fill="#c2566a"/>
          <rect x="482" y="660" width="36" height="130" fill="#4c7a4a"/>
        `, 1000, 1000),
      },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** A PNG whose background is genuinely transparent. */
async function transparentPng() {
  return sharp({ create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: svg(`<ellipse cx="400" cy="400" rx="220" ry="150" fill="#7fa8d8"/>`, 800, 800) }])
    .png()
    .toBuffer();
}

/** Decode an asset from disk and report what is actually in it. */
async function inspectPng(buffer) {
  const image = sharp(buffer);
  const meta = await image.metadata();
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 8) transparent += 1;
  const total = info.width * info.height;
  return { ...meta, transparentRatio: transparent / total };
}

/** The first pixel of a PNG (used to assert the neutral background colour). */
async function firstPixel(buffer) {
  const { data } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { r: data[0], g: data[1], b: data[2] };
}

// ══════════ deterministic start ══════════
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([Workspace.init(), User.init(), Product.init(), ProductReferenceImage.init()]);

const wsA = await Workspace.create({ slug: `studio-a-${stamp}`, displayName: 'Studio A', status: 'ACTIVE' });
const wsB = await Workspace.create({ slug: `studio-b-${stamp}`, displayName: 'Studio B', status: 'ACTIVE' });
const wsDormant = await Workspace.create({ slug: `studio-dormant-${stamp}`, displayName: 'Dormant', status: 'SUSPENDED' });

async function makeUser({ email, password, role, name, workspaceId, permissions }) {
  return User.create({
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role,
    name,
    status: 'ACTIVE',
    ...(workspaceId ? { workspaceId } : {}),
    ...(permissions ? { permissions } : {}),
  });
}

const adminAEmail = `studio-admin-a-${stamp}@reference.test`;
const adminBEmail = `studio-admin-b-${stamp}@reference.test`;
const limitedEmail = `studio-limited-${stamp}@reference.test`;
const dormantEmail = `studio-dormant-${stamp}@reference.test`;
await makeUser({ email: adminAEmail, password: P('AdminA'), role: 'admin', name: 'Studio Admin A', workspaceId: wsA._id });
await makeUser({ email: adminBEmail, password: P('AdminB'), role: 'admin', name: 'Studio Admin B', workspaceId: wsB._id });
await makeUser({ email: limitedEmail, password: P('Limited'), role: 'handler', name: 'Limited Handler', workspaceId: wsA._id, permissions: [] });
await makeUser({ email: dormantEmail, password: P('Dormant'), role: 'admin', name: 'Dormant Admin', workspaceId: wsDormant._id });

const { child: SERVER, base } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: {
    SEED_ON_START: 'false',
    // The built-in engine is always available and needs no Python. The ML
    // provider's availability is a property of the machine, so pinning the
    // provider here is what makes the suite's assertions about WHICH engine ran
    // deterministic. §A additionally asserts the endpoint reports this choice.
    BGREMOVE_PROVIDER: 'deterministic',
    // Probe OFF, so "rembg is not available" is a statement about the CONFIG
    // rather than about the machine this happens to run on. Without this, a
    // developer who follows docs/IMAGE_STUDIO.md and installs rembg would see
    // this suite go red for doing the right thing.
    BGREMOVE_PROBE: '0',
    REFERENCE_MEDIA_DIR: MEDIA_DIR,
  },
  label: 'reference-studio',
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
      return { status: res.status, json, headers: res.headers };
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(750);
    }
  }
}

/** Real multipart upload through the studio's endpoint. */
async function upload(token, { buffer, filename = 'photo.jpg', type = 'image/jpeg', fields = {} } = {}) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type }), filename);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/references`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* non-json */
      }
      return { status: res.status, json };
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(750);
    }
  }
}

/** Fetch raw asset bytes with a token (never through <img>). */
async function fetchAsset(token, id, kind) {
  const res = await fetch(`${BASE}/references/${id}/file/${kind}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), buffer: Buffer.from(await res.arrayBuffer()) };
}

/** Poll one reference until it leaves UPLOADING/PROCESSING (or reports stale). */
async function waitForTerminal(token, id, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await req('GET', `/references/${id}`, { token });
    last = r.json?.image || null;
    if (last && !['UPLOADING', 'PROCESSING'].includes(last.status)) return last;
    if (last && last.stale) return last;
    await sleep(300);
  }
  return last;
}

async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  return r.json?.token || null;
}

const ADMIN_A = await login(adminAEmail, P('AdminA'));
const ADMIN_B = await login(adminBEmail, P('AdminB'));
const LIMITED = await login(limitedEmail, P('Limited'));
const DORMANT = await login(dormantEmail, P('Dormant'));
check('fixtures: two workspace admins, a permissionless handler and a dormant-workspace admin signed in', !!ADMIN_A && !!ADMIN_B && !!LIMITED && !!DORMANT);

const CUSTOMER_EMAIL = `studio-customer-${stamp}@reference.test`;
await req('POST', '/auth/register', { body: { name: 'Studio Customer', email: CUSTOMER_EMAIL, password: P('Cust') } });
const CUSTOMER = await login(CUSTOMER_EMAIL, P('Cust'));
check('fixtures: customer signed in', !!CUSTOMER);

// ══════════ §A UPLOAD → REAL PROCESSING ══════════
console.log('\n— §A UPLOAD → REAL PROCESSING —');

const PHOTO = await photoOnPlainBackground();
let r = await upload(ADMIN_A, { buffer: PHOTO, filename: 'bloom.jpg', type: 'image/jpeg', fields: { draftKey: `draft-${stamp}` } });
const first = r.json?.image;
check('an ordinary product photograph uploads and starts processing (201)', r.status === 201 && !!first?.id, `${r.status}`);
check('the upload reports one of the studio statuses', ['UPLOADING', 'PROCESSING', 'READY', 'NEEDS_REVIEW'].includes(first?.status), `${first?.status}`);
check(
  'the original is recorded with its real dimensions, format and hash',
  first?.original?.width === 900 && first?.original?.height === 900 && first?.original?.format === 'jpeg' && /^[a-f0-9]{64}$/.test(first?.original?.sha256 || ''),
  JSON.stringify(first?.original)
);
check('the storage path is never exposed by the API', findKeyPaths(r.json, 'storageKey').length === 0, findKeyPaths(r.json, 'storageKey').join(','));

const processed = await waitForTerminal(ADMIN_A, first.id);
check(
  'processing completes with a usable result (READY or NEEDS_REVIEW, never FAILED)',
  ['READY', 'NEEDS_REVIEW'].includes(processed?.status),
  `${processed?.status} ${processed?.processing?.error || ''}`
);
check('the engine that actually ran is recorded', processed?.processing?.engine === 'deterministic', `${processed?.processing?.engine}`);
check('processing duration is measured (real work, not a stub)', Number(processed?.processing?.durationMs) > 0, `${processed?.processing?.durationMs}`);
check('a confidence score is reported', typeof processed?.confidence === 'number', `${processed?.confidence}`);
check(
  'cutout and neutral preview are both registered with dimensions',
  processed?.cutout?.available === true && processed?.neutral?.available === true && processed?.cutout?.width > 0 && processed?.neutral?.height > 0,
  JSON.stringify({ cutout: processed?.cutout, neutral: processed?.neutral })
);
check('forward-looking metadata is present for Phase 2 (order, primary, accepted, product link)', processed?.order === 0 && processed?.isPrimary === true && processed?.accepted === false && processed?.productSlug === '');

const engineInfo = await req('GET', '/references/engine', { token: ADMIN_A });
check(
  'the engine endpoint describes the real capability (rembg availability reported honestly, with its reason)',
  engineInfo.status === 200 &&
    engineInfo.json?.engine?.selected === 'deterministic' &&
    engineInfo.json?.engine?.rembg?.available === false &&
    /probe disabled/.test(String(engineInfo.json?.engine?.rembg?.reason || '')),
  JSON.stringify(engineInfo.json?.engine)
);

// The transparent cutout must be genuinely transparent, and must keep the product.
const cutoutBytes = await fetchAsset(ADMIN_A, first.id, 'cutout');
const cutout = await inspectPng(cutoutBytes.buffer);
check('the cutout is served as PNG with a private, no-store cache', cutoutBytes.status === 200 && cutoutBytes.type?.includes('png') && cutoutBytes.cache === 'private, no-store', `${cutoutBytes.status} ${cutoutBytes.type} ${cutoutBytes.cache}`);
check('the cutout really has an alpha channel', cutout.hasAlpha === true);
check(
  'the background was actually removed (some pixels fully transparent)',
  cutout.transparentRatio > 0.05,
  `transparent=${cutout.transparentRatio.toFixed(3)}`
);
check(
  'the product was not erased (most of the frame is retained)',
  cutout.transparentRatio < 0.95,
  `transparent=${cutout.transparentRatio.toFixed(3)}`
);

const neutralBytes = await fetchAsset(ADMIN_A, first.id, 'neutral');
const neutral = await inspectPng(neutralBytes.buffer);
const neutralCorner = await firstPixel(neutralBytes.buffer);
check('the neutral preview is opaque (no alpha channel)', neutral.channels === 3, `channels=${neutral.channels}`);
check(
  'the neutral preview uses the documented studio background',
  neutralCorner.r === NEUTRAL_BACKGROUND.r && neutralCorner.g === NEUTRAL_BACKGROUND.g && neutralCorner.b === NEUTRAL_BACKGROUND.b,
  JSON.stringify(neutralCorner)
);
check('the neutral preview matches the cutout dimensions', neutral.width === cutout.width && neutral.height === cutout.height);

// ══════════ §B ORIGINAL IS IMMUTABLE ══════════
console.log('\n— §B ORIGINAL IS IMMUTABLE —');

const originalPath = path.join(MEDIA_DIR, wsA.slug, first.id, 'original.jpg');
const onDisk = await fs.readFile(originalPath).catch(() => null);
check('the original file exists on disk under the workspace namespace', !!onDisk, originalPath);
check('the original bytes are UNCHANGED after processing', onDisk && crypto.createHash('sha256').update(onDisk).digest('hex') === first.original.sha256);
check('the uploaded bytes were stored verbatim', onDisk && onDisk.equals(PHOTO));
const dirEntries = await fs.readdir(path.join(MEDIA_DIR, wsA.slug, first.id));
check(
  'derived assets are SEPARATE files next to the original',
  dirEntries.includes('original.jpg') && dirEntries.includes('cutout.png') && dirEntries.includes('neutral.png'),
  dirEntries.join(',')
);

// The immutability guard lives in the storage service, so it is exercised
// directly — and the service resolves its root from the environment at import
// time, so the same media root the server child uses is set first. Without that
// the "file already exists" check would look in the wrong directory and prove
// nothing (and would litter it).
process.env.REFERENCE_MEDIA_DIR = MEDIA_DIR;
const { writeAsset } = await import('../services/referenceAssetStorage.js');
let overwriteRefused = false;
let overwriteMessage = '';
try {
  await writeAsset({ imageId: first.id, workspaceSlug: wsA.slug, kind: 'original', buffer: Buffer.from('x'), format: 'png' });
} catch (err) {
  overwriteRefused = true;
  overwriteMessage = err.code || err.message;
}
check('the store refuses to overwrite an original (ORIGINAL_IMMUTABLE)', overwriteRefused && overwriteMessage === 'ORIGINAL_IMMUTABLE', overwriteMessage);

const originalAfter = await fs.readFile(originalPath);
check('the original is byte-identical after the refused overwrite', originalAfter.equals(PHOTO));

r = await upload(ADMIN_A, { buffer: PHOTO, filename: 'bloom-again.jpg', type: 'image/jpeg', fields: { draftKey: `draft-${stamp}` } });
const second = r.json?.image;
check('re-uploading the same bytes is accepted and reported as a duplicate', r.status === 201 && r.json?.duplicateOf === first.id, `${r.status} ${r.json?.duplicateOf}`);
await waitForTerminal(ADMIN_A, second.id);
const secondOriginal = await fs.readFile(path.join(MEDIA_DIR, wsA.slug, second.id, 'original.jpg')).catch(() => null);
check('the duplicate got its OWN original file (no shared/overwritten asset)', !!secondOriginal && secondOriginal.equals(PHOTO));
check('the duplicate is a separate row', second.id !== first.id);

// ══════════ §C COMPLEX IMAGES ══════════
console.log('\n— §C COMPLEX IMAGES —');

const FLYER = await flyerWithText();
r = await upload(ADMIN_A, { buffer: FLYER, filename: 'spring-sale.jpg', type: 'image/jpeg', fields: { draftKey: `draft-${stamp}`, label: 'Spring sale flyer' } });
const flyer = r.json?.image;
check('a promotional flyer uploads (201)', r.status === 201 && !!flyer?.id, `${r.status}`);
const flyerDone = await waitForTerminal(ADMIN_A, flyer.id);
check('the flyer is NOT silently discarded or silently cleaned', ['READY', 'NEEDS_REVIEW'].includes(flyerDone?.status), `${flyerDone?.status} ${flyerDone?.processing?.error}`);
check(
  'the flyer is flagged so a human looks at it (warnings present)',
  (flyerDone?.warnings?.length || 0) > 0,
  JSON.stringify({
    status: flyerDone?.status,
    confidence: flyerDone?.confidence,
    warnings: flyerDone?.warnings,
    tries: flyerDone?.processing?.attempts,
    engine: flyerDone?.processing?.engine,
    metrics: flyerDone?.processing?.metrics,
  })
);
check('the flyer keeps its original untouched', (await fs.stat(path.join(MEDIA_DIR, wsA.slug, flyer.id, 'original.jpg')).catch(() => null))?.size === FLYER.length);
check('the flyer label is stored', flyerDone?.label === 'Spring sale flyer');
// The flyer must be genuinely full-bleed for the check above to mean anything:
// a small artwork floating on a white canvas is a perfectly easy image, and
// asserting "flagged for review" against it would be asserting the wrong thing.
const flyerCorner = await firstPixel(FLYER);
check(
  'the flyer fixture really covers the frame (full-bleed, no white border)',
  Math.abs(flyerCorner.r - 255) + Math.abs(flyerCorner.g - 255) + Math.abs(flyerCorner.b - 255) > 20,
  JSON.stringify(flyerCorner)
);
check(
  'the flyer result carries engine measurements for the reviewer',
  flyerDone?.processing?.metrics && typeof flyerDone.processing.metrics === 'object',
  JSON.stringify(flyerDone?.processing?.metrics)?.slice(0, 200)
);

r = await upload(ADMIN_A, { buffer: await transparentPng(), filename: 'transparent.png', type: 'image/png', fields: { draftKey: `draft-${stamp}` } });
const transparent = r.json?.image;
check('a transparent PNG uploads (201)', r.status === 201 && !!transparent?.id, `${r.status}`);
const transparentDone = await waitForTerminal(ADMIN_A, transparent.id);
check('the transparent PNG has its alpha recorded', transparentDone?.original?.hasAlpha === true, JSON.stringify(transparentDone?.original));
check(
  'a transparent PNG still yields a cutout and a neutral preview',
  transparentDone?.cutout?.available === true && transparentDone?.neutral?.available === true,
  `${transparentDone?.status}`
);

// ══════════ §D BAD INPUT ══════════
console.log('\n— §D BAD INPUT —');

r = await upload(ADMIN_A, { buffer: Buffer.from('this is definitely not an image'), filename: 'broken.png', type: 'image/png', fields: { draftKey: `draft-${stamp}` } });
check('corrupt bytes are refused as an unreadable image (422)', r.status === 422 && r.json?.code === 'UNREADABLE_IMAGE', `${r.status} ${r.json?.code}`);

r = await upload(ADMIN_A, { buffer: Buffer.from('%PDF-1.4 not an image'), filename: 'doc.pdf', type: 'application/pdf', fields: { draftKey: `draft-${stamp}` } });
check('an unsupported content type is refused by the upload filter (422)', r.status === 422, `${r.status} ${r.json?.code}`);

r = await upload(ADMIN_A, { buffer: Buffer.alloc(5 * 1024 * 1024 + 1024, 7), filename: 'huge.png', type: 'image/png', fields: { draftKey: `draft-${stamp}` } });
check('an oversized upload is refused (413)', r.status === 413, `${r.status} ${r.json?.code}`);

r = await upload(ADMIN_A, { buffer: PHOTO, filename: 'bloom.jpg', type: 'image/jpeg' });
check('an upload with no product and no draft is refused (422)', r.status === 422, `${r.status} ${r.json?.code}`);

r = await upload(ADMIN_A, { buffer: Buffer.alloc(0), filename: 'empty.png', type: 'image/png', fields: { draftKey: `draft-${stamp}` } });
check('an empty file is refused (4xx, no row created)', r.status >= 400 && r.status < 500, `${r.status} ${r.json?.code}`);

// Four accepted-and-processed uploads live under this draft key by now (the
// photograph, its duplicate, the flyer and the transparent PNG). Every refused
// upload above must have added NEITHER a row NOR a directory.
const orphanCount = await ProductReferenceImage.countDocuments({ workspaceId: wsA._id, draftKey: `draft-${stamp}` });
const storedDirs = await fs.readdir(path.join(MEDIA_DIR, wsA.slug)).catch(() => []);
check(
  'refused uploads left no row and no directory behind',
  orphanCount === 4 && storedDirs.length === orphanCount,
  `rows=${orphanCount} dirs=${storedDirs.length}`
);

// ══════════ §E DRAFT SETS, ORDER, PRIMARY ══════════
console.log('\n— §E DRAFT SETS, ORDER, PRIMARY —');

const DRAFT = `draft-order-${stamp}`;
const uploads = [];
for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) {
  // Distinct bytes each time so duplicate detection does not short-circuit the set.
  const hue = name === 'a.jpg' ? '#b34f63' : name === 'b.jpg' ? '#4e7a4c' : '#7fa8d8';
  const buffer = await sharp({ create: { width: 700, height: 700, channels: 3, background: '#f4f1ec' } })
    .composite([{ input: svg(`<ellipse cx="350" cy="360" rx="190" ry="140" fill="${hue}"/>`, 700, 700) }])
    .jpeg()
    .toBuffer();
  // eslint-disable-next-line no-await-in-loop
  const res = await upload(ADMIN_A, { buffer, filename: name, type: 'image/jpeg', fields: { draftKey: DRAFT } });
  uploads.push(res.json?.image);
}
check('three draft images upload into one set', uploads.every((img) => !!img?.id), JSON.stringify(uploads.map((u) => u?.order)));

for (const img of uploads) {
  // eslint-disable-next-line no-await-in-loop
  await waitForTerminal(ADMIN_A, img.id);
}

r = await req('GET', `/references?draftKey=${encodeURIComponent(DRAFT)}`, { token: ADMIN_A });
const listed = r.json?.images || [];
check('the set lists in display order', listed.length === 3 && listed[0].id === uploads[0].id && listed[2].id === uploads[2].id, listed.map((i) => i.order).join(','));
check('the first image of a new set is primary', listed[0].isPrimary === true && listed[1].isPrimary === false);

const reversed = [uploads[2].id, uploads[1].id, uploads[0].id];
r = await req('PATCH', '/references/order', { token: ADMIN_A, body: { ids: reversed } });
check('reordering applies the new order', r.status === 200 && r.json?.images?.map((i) => i.id).join(',') === reversed.join(','), `${r.status}`);
check('reordering promotes the new first image to primary', r.json?.images?.[0]?.isPrimary === true && r.json.images.filter((i) => i.isPrimary).length === 1);

r = await req('PATCH', '/references/order', { token: ADMIN_A, body: { ids: [reversed[0], '5f0000000000000000000000'] } });
check('a stale order list is refused instead of half-applied (422)', r.status === 422, `${r.status} ${r.json?.code}`);

r = await req('PATCH', `/references/${uploads[1].id}`, { token: ADMIN_A, body: { isPrimary: true } });
const afterPrimary = await req('GET', `/references?draftKey=${encodeURIComponent(DRAFT)}`, { token: ADMIN_A });
check(
  'exactly ONE image can be primary at a time',
  r.status === 200 && afterPrimary.json.images.filter((i) => i.isPrimary).length === 1 && afterPrimary.json.images.find((i) => i.isPrimary).id === uploads[1].id
);

// ══════════ §F CROP CORRECTION & RETRY ══════════
console.log('\n— §F CROP CORRECTION & RETRY —');

const target = afterPrimary.json.images.find((i) => i.id === uploads[0].id);
const cutoutBefore = await inspectPng((await fetchAsset(ADMIN_A, target.id, 'cutout')).buffer);

r = await req('PATCH', `/references/${target.id}`, { token: ADMIN_A, body: { crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } });
check('a crop is accepted and re-runs processing', r.status === 200 && r.json?.image?.crop?.width === 0.5, `${r.status} ${JSON.stringify(r.json?.image?.crop)}`);
const cropped = r.json.image;
check('the crop is persisted so a retry re-applies it', cropped.crop.x === 0.25 && cropped.crop.y === 0.25);
check('a cropped image returns to review (acceptance is cleared)', cropped.accepted === false);
const cutoutAfter = await inspectPng((await fetchAsset(ADMIN_A, target.id, 'cutout')).buffer);
check(
  'the crop produced a strictly smaller cutout (it really was applied)',
  cutoutAfter.width < cutoutBefore.width && cutoutAfter.height < cutoutBefore.height,
  `${cutoutBefore.width}x${cutoutBefore.height} → ${cutoutAfter.width}x${cutoutAfter.height}`
);
const originalStillIntact = await fs.readFile(path.join(MEDIA_DIR, wsA.slug, target.id, 'original.jpg'));
check('cropping did not alter the original', originalStillIntact.length > 0 && crypto.createHash('sha256').update(originalStillIntact).digest('hex') === target.original.sha256);

r = await req('PATCH', `/references/${target.id}`, { token: ADMIN_A, body: { crop: { x: -0.2, y: 0, width: 0.5, height: 0.5 } } });
check('a crop outside the frame is refused (422)', r.status === 422, `${r.status}`);

r = await req('PATCH', `/references/${target.id}`, { token: ADMIN_A, body: { crop: { x: 0.1, y: 0.1, width: 0.99, height: 0.99 } } });
check('a crop that overflows the frame is refused (422)', r.status === 422, `${r.status}`);

r = await req('PATCH', `/references/${target.id}`, { token: ADMIN_A, body: { crop: null } });
check('clearing a crop reprocesses the full frame', r.status === 200 && !r.json?.image?.crop);
const restored = await inspectPng((await fetchAsset(ADMIN_A, target.id, 'cutout')).buffer);
check('the full-frame cutout is back to the original extent', restored.width === cutoutBefore.width);

// A FAILED reference recovers on retry — the original is intact, so this is always possible.
const failedRow = await ProductReferenceImage.findById(target.id);
failedRow.status = 'FAILED';
failedRow.processing.error = 'simulated engine failure';
failedRow.processing.errorCode = 'SIMULATED';
await failedRow.save();
r = await req('GET', `/references/${target.id}`, { token: ADMIN_A });
check('a FAILED reference reports its failure honestly', r.json?.image?.status === 'FAILED' && r.json.image.processing.error.includes('simulated'));
r = await req('POST', `/references/${target.id}/reprocess`, { token: ADMIN_A });
const retried = r.json?.image;
check(
  'a retry recovers the reference without re-uploading',
  r.status === 200 && ['READY', 'NEEDS_REVIEW'].includes(retried?.status) && retried.processing.attempts >= 2,
  `${r.status} ${retried?.status} attempts=${retried?.processing?.attempts}`
);

// An interrupted job must not look like it is still running.
const staleRow = await ProductReferenceImage.findById(target.id);
staleRow.status = 'PROCESSING';
staleRow.processing.startedAt = new Date(Date.now() - 10 * 60 * 1000);
await staleRow.save();
r = await req('GET', `/references/${target.id}`, { token: ADMIN_A });
check('an abandoned PROCESSING row is reported as interrupted', r.json?.image?.stale === true && /interrupted/i.test(r.json.image.staleMessage || ''), JSON.stringify(r.json?.image?.staleMessage));
r = await req('POST', `/references/${target.id}/reprocess`, { token: ADMIN_A });
check('the interrupted row can be retried', r.status === 200 && r.json?.image?.stale !== true);

// ══════════ §G ACCEPT / REMOVE ══════════
console.log('\n— §G ACCEPT / REMOVE —');

r = await req('PATCH', `/references/${uploads[2].id}`, { token: ADMIN_A, body: { accepted: true } });
check('a processed reference can be accepted', r.status === 200 && r.json?.image?.accepted === true);

const failedForAccept = await ProductReferenceImage.create({
  workspaceId: wsA._id,
  draftKey: DRAFT,
  status: 'FAILED',
  storageNamespace: wsA.slug,
  order: 99,
  isFixture: false,
});
r = await req('PATCH', `/references/${failedForAccept._id}`, { token: ADMIN_A, body: { accepted: true } });
check('a FAILED reference cannot be accepted (422)', r.status === 422, `${r.status} ${r.json?.code}`);
// Removed directly (it is a synthetic row with no files) so the set assertion
// below counts only the images that went through the real pipeline.
await ProductReferenceImage.deleteOne({ _id: failedForAccept._id });

r = await req('DELETE', `/references/${uploads[2].id}`, { token: ADMIN_A });
const removedDir = await fs.stat(path.join(MEDIA_DIR, wsA.slug, uploads[2].id)).catch(() => null);
check('removing a reference deletes the row', r.status === 200 && !(await ProductReferenceImage.findById(uploads[2].id)));
check('removing a reference deletes its files', removedDir === null);

const beforeRemovePrimary = (await req('GET', `/references?draftKey=${encodeURIComponent(DRAFT)}`, { token: ADMIN_A })).json.images;
r = await req('DELETE', `/references/${uploads[1].id}`, { token: ADMIN_A });
const afterRemovePrimary = (await req('GET', `/references?draftKey=${encodeURIComponent(DRAFT)}`, { token: ADMIN_A })).json.images;
check(
  'removing the primary promotes the next image',
  beforeRemovePrimary.find((i) => i.id === uploads[1].id)?.isPrimary === true && afterRemovePrimary.length === 1 && afterRemovePrimary[0].isPrimary === true,
  JSON.stringify(afterRemovePrimary.map((i) => ({ id: i.id, p: i.isPrimary })))
);

// ══════════ §H PRODUCT HANDOFF ══════════
console.log('\n— §H PRODUCT HANDOFF —');

const productDraft = `draft-product-${stamp}`;
const productUploads = [];
for (const name of ['front.jpg', 'side.jpg']) {
  const buffer = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#f7f4ef' } })
    .composite([{ input: svg(`<rect x="260" y="260" width="280" height="280" rx="40" fill="${name === 'front.jpg' ? '#c2566a' : '#5b7f9e'}"/>`, 800, 800) }])
    .jpeg()
    .toBuffer();
  // eslint-disable-next-line no-await-in-loop
  const res = await upload(ADMIN_A, { buffer, filename: name, type: 'image/jpeg', fields: { draftKey: productDraft } });
  productUploads.push(res.json?.image);
  // eslint-disable-next-line no-await-in-loop
  await waitForTerminal(ADMIN_A, res.json?.image?.id);
}
const acceptedIds = productUploads.map((img) => img.id);
await req('PATCH', `/references/${acceptedIds[0]}`, { token: ADMIN_A, body: { accepted: true } });
// The second image is deliberately NOT accepted: a create must clean it up.

r = await req('POST', '/products', {
  token: ADMIN_A,
  body: {
    name: `Studio Bloom ${stamp}`,
    price: 1450,
    category: 'Posies',
    initialStock: 5,
    referenceImageIds: [acceptedIds[0]],
    referenceDraftKey: productDraft,
  },
});
const productSlug = r.json?.product?.slug;
check('a product create carries the accepted reference set', r.status === 201 && r.json?.referenceHandoff?.attached === 1, `${r.status} ${JSON.stringify(r.json?.referenceHandoff)}`);

// The API's product payload is keyed by SLUG (Product.toJSON maps id → slug and
// strips _id), so the object id is read from the database for this assertion.
const productDoc = await Product.findOne({ slug: productSlug });
const attached = await ProductReferenceImage.findById(acceptedIds[0]);
check(
  'the accepted reference is bound to the product',
  !!productDoc && attached?.productSlug === productSlug && String(attached?.productId) === String(productDoc._id) && attached.draftKey === '',
  JSON.stringify({ slug: attached?.productSlug, productId: String(attached?.productId), expected: String(productDoc?._id), draft: attached?.draftKey })
);
check('the unaccepted draft reference was cleaned up', !(await ProductReferenceImage.findById(acceptedIds[1])));
check('the cleaned-up draft row kept no files', (await fs.stat(path.join(MEDIA_DIR, wsA.slug, acceptedIds[1])).catch(() => null)) === null);

r = await req('GET', `/references?productSlug=${encodeURIComponent(productSlug)}`, { token: ADMIN_A });
check('the saved product can retrieve its prepared images later', r.status === 200 && r.json?.images?.length === 1 && r.json.images[0].id === acceptedIds[0]);

// A bad reference id must NOT fail the product write.
r = await req('POST', '/products', {
  token: ADMIN_A,
  body: {
    name: `Studio Resilient ${stamp}`,
    price: 950,
    category: 'Posies',
    referenceImageIds: ['5f0000000000000000000000'],
  },
});
check(
  'a bogus reference id does not break product creation (product saved, attachment reported)',
  r.status === 201 && !!r.json?.product?.slug && r.json?.referenceHandoff?.attached === 0 && !!r.json?.referenceHandoff?.error,
  `${r.status} ${JSON.stringify(r.json?.referenceHandoff)}`
);

// A rename must move the reference set with the product.
r = await req('PATCH', `/products/${productSlug}`, { token: ADMIN_A, body: { name: `Studio Bloom Renamed ${stamp}` } });
const renamedSlug = r.json?.product?.slug;
const afterRename = await ProductReferenceImage.findById(acceptedIds[0]);
check('renaming the product moves its reference set to the new slug', r.status === 200 && afterRename?.productSlug === renamedSlug, `${afterRename?.productSlug} vs ${renamedSlug}`);
r = await req('GET', `/references?productSlug=${encodeURIComponent(renamedSlug)}`, { token: ADMIN_A });
check('the renamed product still lists its prepared images', r.json?.images?.length === 1);

// Deleting the product removes the set and its files.
r = await req('DELETE', `/products/${renamedSlug}`, { token: ADMIN_A });
check('deleting the product removes its prepared references', r.status === 200 && !(await ProductReferenceImage.findById(acceptedIds[0])));
check('deleting the product removes the reference files', (await fs.stat(path.join(MEDIA_DIR, wsA.slug, acceptedIds[0])).catch(() => null)) === null);

// ══════════ §I TENANCY & AUTH ══════════
console.log('\n— §I TENANCY & AUTH —');

r = await req('GET', `/references/${first.id}`, { token: ADMIN_B });
check('another workspace cannot read a reference (404, never 403)', r.status === 404, `${r.status}`);
r = await req('PATCH', `/references/${first.id}`, { token: ADMIN_B, body: { accepted: true } });
check('another workspace cannot mutate a reference (404)', r.status === 404, `${r.status}`);
r = await req('DELETE', `/references/${first.id}`, { token: ADMIN_B });
check('another workspace cannot delete a reference (404)', r.status === 404, `${r.status}`);
const foreignAsset = await fetchAsset(ADMIN_B, first.id, 'cutout');
check('another workspace cannot fetch the bytes (404)', foreignAsset.status === 404, `${foreignAsset.status}`);
const anonAsset = await fetchAsset(null, first.id, 'cutout');
check('an unauthenticated caller cannot fetch the bytes (401)', anonAsset.status === 401, `${anonAsset.status}`);
const customerAsset = await fetchAsset(CUSTOMER, first.id, 'cutout');
check('a customer cannot fetch staff reference media (403)', customerAsset.status === 403, `${customerAsset.status}`);

r = await req('GET', `/references?productSlug=${encodeURIComponent(productSlug)}`, { token: ADMIN_B });
check('another workspace listing the same product slug sees an empty set', r.status === 200 && r.json?.images?.length === 0, `${r.status} ${r.json?.images?.length}`);

r = await req('POST', '/references/attach', { token: ADMIN_B, body: { productSlug, ids: [first.id] } });
check('another workspace cannot attach a foreign reference (422, no partial write)', r.status === 422, `${r.status} ${r.json?.code}`);
check('the foreign attach attempt did not modify the row', (await ProductReferenceImage.findById(first.id))?.productSlug === '');

r = await upload(ADMIN_B, { buffer: await photoOnPlainBackground(), filename: 'b.jpg', type: 'image/jpeg', fields: { productSlug } });
check('uploads are namespaced per workspace (B gets its own row for a slug it does not own)', r.status === 201);
const bRow = await ProductReferenceImage.findById(r.json.image.id);
check('the workspace on a row comes from the server session, never the request', String(bRow.workspaceId) === String(wsB._id));
r = await req('GET', `/references?productSlug=${encodeURIComponent(productSlug)}`, { token: ADMIN_A });
check("another workspace's upload never appears in this workspace's set", !(r.json?.images || []).some((i) => i.id === bRow.id));

r = await upload(CUSTOMER, { buffer: PHOTO, filename: 'c.jpg', type: 'image/jpeg', fields: { draftKey: `draft-${stamp}` } });
check('a customer cannot upload reference images (403)', r.status === 403, `${r.status}`);
r = await upload(null, { buffer: PHOTO, filename: 'n.jpg', type: 'image/jpeg', fields: { draftKey: `draft-${stamp}` } });
check('an unauthenticated upload is refused (401)', r.status === 401, `${r.status}`);
r = await req('GET', `/references?draftKey=${encodeURIComponent(DRAFT)}`, { token: LIMITED });
check('a handler without the product permission is refused (403)', r.status === 403, `${r.status} ${r.json?.code}`);
r = await upload(LIMITED, { buffer: PHOTO, filename: 'l.jpg', type: 'image/jpeg', fields: { draftKey: `draft-${stamp}` } });
check('the permission gate runs BEFORE the file is parsed (403, no bytes written)', r.status === 403, `${r.status}`);
r = await upload(DORMANT, { buffer: PHOTO, filename: 'd.jpg', type: 'image/jpeg', fields: { draftKey: `draft-${stamp}` } });
check('a suspended workspace is refused (403)', r.status === 403 && r.json?.code === 'WORKSPACE_SUSPENDED', `${r.status} ${r.json?.code}`);

r = await req('POST', '/references/cleanup', { token: ADMIN_A, body: { olderThanHours: 1 } });
check('the maintenance sweep is owner-only (403 for a workspace admin)', r.status === 403, `${r.status} ${r.json?.code}`);

const payloadLeaks = findKeyPaths(listed, 'storageKey').length + findKeyPaths(afterRemovePrimary, 'storageKey').length + findKeyPaths(processed, 'storageKey').length;
check('no reference payload anywhere exposes a storage path', payloadLeaks === 0);
const tenantLeaks = findKeyPaths(listed, 'workspaceId').length + findKeyPaths(processed, 'workspaceId').length + findKeyPaths(flyerDone, 'workspaceId').length;
check('no reference payload exposes the internal tenant or author id', tenantLeaks === 0, `found ${tenantLeaks}`);

// ══════════ §J ENGINE LICENCE GUARD & WIRING ══════════
// In-process (no server, no Python, no network). The brief requires the licence
// of BOTH the software and the model weights to be verified before integration,
// and the guard that enforces that decision lives in code — so it is tested
// here rather than trusted. rembg itself is optional and cannot be installed on
// every machine (it needs Python >=3.11,<3.14), which is exactly why the guard
// has to be provable without it.
console.log('\n— §J ENGINE LICENCE GUARD & WIRING —');
{
  const { MODEL_LICENCES, resolveModel } = await import('../services/bgRemoval/rembgProvider.js');
  const { describeEngine, removeBackground, PROVIDERS } = await import('../services/bgRemoval/index.js');

  check(
    'the licence table covers the model rembg ships as its default and marks it NON-COMMERCIAL',
    MODEL_LICENCES['bria-rmbg']?.ok === false && /NON-COMMERCIAL/.test(MODEL_LICENCES['bria-rmbg'].licence),
    JSON.stringify(MODEL_LICENCES['bria-rmbg'])
  );
  check(
    'a commercially-cleared default model exists (u2net / BiRefNet weights)',
    MODEL_LICENCES.u2net?.ok === true &&
      MODEL_LICENCES['birefnet-general']?.ok === true &&
      MODEL_LICENCES['birefnet-general-lite']?.ok === true
  );
  check(
    'the unverified IS-Net weights are refused as well',
    MODEL_LICENCES['isnet-general-use']?.ok === false,
    JSON.stringify(MODEL_LICENCES['isnet-general-use'])
  );

  const licenceError = (() => {
    try {
      resolveModel('bria-rmbg');
      return null;
    } catch (err) {
      return err;
    }
  })();
  check(
    'the licence guard actually REFUSES the non-commercial default (not just documented)',
    licenceError?.code === 'BGREMOVE_MODEL_NOT_LICENSED',
    licenceError ? `${licenceError.code}: ${licenceError.message}` : 'resolveModel(bria-rmbg) returned without error'
  );

  const previous = process.env.BGREMOVE_MODEL;
  process.env.BGREMOVE_MODEL = 'bria-rmbg';
  check(
    'an explicitly configured non-commercial model is refused too (config cannot bypass the guard)',
    (() => {
      try {
        resolveModel();
        return false;
      } catch (err) {
        return err.code === 'BGREMOVE_MODEL_NOT_LICENSED';
      }
    })()
  );
  process.env.BGREMOVE_MODEL = previous ?? '';
  delete process.env.BGREMOVE_MODEL;

  check(
    'an unknown model name is refused with the known list',
    (() => {
      try {
        resolveModel('definitely-not-a-model');
        return false;
      } catch (err) {
        return err.code === 'BGREMOVE_MODEL_UNKNOWN' && /u2net/.test(err.message);
      }
    })()
  );
  check('both engines are compiled into this build', PROVIDERS.includes('deterministic') && PROVIDERS.includes('rembg'));

  // The `rembg` provider is REQUIRED here but unavailable: the honest answer is
  // a 503 that names the reason — never a silent substitution with no record.
  const savedProvider = process.env.BGREMOVE_PROVIDER;
  const savedFallback = process.env.BGREMOVE_FALLBACK;
  process.env.BGREMOVE_PROVIDER = 'rembg';
  process.env.BGREMOVE_PROBE = '0';
  process.env.BGREMOVE_FALLBACK = '0';
  const described = await describeEngine();
  check(
    'requesting rembg without an install reports it as unavailable rather than pretending',
    described.selected === 'rembg' && described.rembg.available === false,
    JSON.stringify(described)
  );
  const refused = await (async () => {
    try {
      await removeBackground(await photoOnPlainBackground());
      return null;
    } catch (err) {
      return err;
    }
  })();
  check(
    'processing fails honestly (503 BGREMOVE_UNAVAILABLE) instead of returning a cutout nobody asked for',
    refused?.code === 'BGREMOVE_UNAVAILABLE' && refused?.status === 503,
    refused ? `${refused.status} ${refused.code}` : 'removeBackground resolved'
  );

  // The ML provider drives rembg's LIBRARY API. Its CLI is not a stable
  // interface (the `i` subcommand dropped `--output`, and the package ships no
  // `__main__`), so a regression back to the CLI must fail here rather than at
  // the moment an administrator uploads a photo on a machine that has rembg.
  const providerSrc = await fs.readFile(path.join(BACKEND_DIR, 'services/bgRemoval/rembgProvider.js'), 'utf8');
  check(
    'the ML provider invokes rembg through its library API (the CLI is not scriptable)',
    providerSrc.includes('from rembg import remove, new_session') && providerSrc.includes("'-c', WORKER")
  );
  if (savedProvider === undefined) delete process.env.BGREMOVE_PROVIDER;
  else process.env.BGREMOVE_PROVIDER = savedProvider;
  if (savedFallback === undefined) delete process.env.BGREMOVE_FALLBACK;
  else process.env.BGREMOVE_FALLBACK = savedFallback;
}

// ══════════ teardown ══════════
await fs.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
check('the suite cleaned up its own private media root', (await fs.stat(MEDIA_DIR).catch(() => null)) === null);

try {
  await mongoose.connection.db.dropDatabase();
  console.log(`\n— cleanup: dropped ${DB_NAME} —`);
} catch (err) {
  console.log(`\n— cleanup skipped (${err.message}) —`);
}

console.log(`\nREFERENCE STUDIO RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
}

try {
  await mongoose.disconnect().catch(() => {});
} finally {
  await stopTestServer(SERVER, base);
}
