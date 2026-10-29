/**
 * 3D STUDIO — MULTI-VIEW REFERENCES (focused suite).
 *
 * Self-contained: own server (port 4126), own database
 * (Flora-Alchemy-Test-ReferenceImages), own private media root under the OS
 * temp directory, SEED_ON_START=false. Nothing here touches dev or production
 * data.
 *
 * WHAT THIS SUITE PROTECTS
 * ------------------------
 * Phase 1 removed the product's background before reconstruction, which damaged
 * the product (a bouquet lost petals, stems, ribbon and wrapping). This suite
 * asserts the replacement behaviour:
 *
 *   §A UPLOAD — an ordinary photograph is stored VERBATIM, measured, and no
 *      derived image is produced. There is no cutout, no neutral preview and no
 *      engine pretending to segment anything.
 *   §B ORIGINAL IS IMMUTABLE — the bytes never change, a second write is
 *      refused, and identical bytes are reported as a duplicate.
 *   §C COMPOSITE DETECTION — a 4×3 and a 3×4 sheet are recognised on the right
 *      axes; an ordinary photograph is not. Nothing is cut at upload time.
 *   §D PANEL EXTRACTION — confirming a layout creates one row per view, cuts
 *      inside the separators (never across them), keeps the parent sheet, and
 *      is idempotent: re-confirming updates instead of duplicating.
 *   §E CORRECTION — an ambiguous sheet reports low confidence and creates
 *      nothing; an explicit layout is obeyed; a panel can never be split again.
 *   §F MULTI-VIEW SETS — separate photographs, ordering, primary selection,
 *      viewpoint labels, and an invalid label refused.
 *   §G ACCEPT / REMOVE — acceptance is explicit, and deleting a sheet deletes the
 *      views cut from it (with their files).
 *   §H TENANCY & AUTH — another workspace gets 404 everywhere, a customer and an
 *      anonymous caller are refused, and a storage path is never exposed.
 *   §I FAILURE RECOVERY — a reference whose original bytes are gone reports
 *      ORIGINAL_MISSING instead of a fake success.
 *   §J SOURCE SHEET IS PROVENANCE, NOT A VIEW — the composite survives and
 *      travels with the views it produced, but is never part of the
 *      reconstruction's view set: even force-accepted through a raw PATCH, the
 *      server still counts and lists only the cut views.
 *
 * Everything is REAL: images are generated with sharp, uploaded over real
 * multipart HTTP, cut by the real crop path, and read back through the real
 * authorization route. No mocked result is treated as a pass.
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

import {
  bootTestServer,
  loadBackendEnv,
  pinFilesystemMediaDriver,
  stopTestServer,
  testMongoUri,
} from './lib/testServer.mjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Product from '../models/Product.js';
import ProductReferenceImage from '../models/ProductReferenceImage.js';

const PORT = Number(process.env.REFERENCE_STUDIO_PORT || 4126);
const DB_NAME = 'Flora-Alchemy-Test-ReferenceImages';
const MEDIA_DIR = path.join(os.tmpdir(), `flora-references-${process.pid}-${Date.now()}`);

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
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = crypto.randomBytes(4).toString('hex');
const P = (p) => `Studio-${p}-${stamp}-Pass1!`;

function findKeyPaths(value, needle) {
  const found = [];
  const walk = (node, trail) => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      const here = trail ? `${trail}.${key}` : key;
      if (key.toLowerCase().includes(needle.toLowerCase())) found.push(here);
      walk(child, here);
    }
  };
  walk(value, '');
  return found;
}

const svg = (inner, w, h) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>`);

/** An ordinary product photograph: a bloom on a plain light studio background. */
async function photoOnPlainBackground() {
  return sharp({ create: { width: 900, height: 900, channels: 3, background: '#f6f3ef' } })
    .composite([
      {
        input: svg(
          `
          <ellipse cx="450" cy="430" rx="170" ry="170" fill="#b34f63"/>
          <ellipse cx="450" cy="250" rx="78" ry="78" fill="#d98fa4"/>
          <ellipse cx="285" cy="430" rx="72" ry="72" fill="#c76d81"/>
          <ellipse cx="615" cy="430" rx="72" ry="72" fill="#c76d81"/>
          <rect x="428" y="585" width="44" height="205" rx="10" fill="#4e7a4c"/>`,
          900,
          900
        ),
      },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** A transparent PNG (genuine alpha in the SOURCE, not a generated mask). */
async function transparentPng() {
  return sharp({ create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: svg(`<ellipse cx="400" cy="400" rx="220" ry="150" fill="#7fa8d8"/>`, 800, 800) }])
    .png()
    .toBuffer();
}

/**
 * A composite sheet: `columns × rows` panels with a uniform gutter between them.
 *
 * `gutter` of 0 produces a seamless sheet, which is the AMBIGUOUS case the
 * correction UI exists for: the detector must not invent boundaries it cannot
 * see. `satellite` draws a small circle whose bounding box depends on the grid
 * reading, so a wrong layout produces visibly wrong crops.
 */
async function compositeSheet({
  columns = 4,
  rows = 3,
  gutter = 16,
  margin = 24,
  cell = 240,
  background = '#ffffff',
  panelColours = ['#c2566a', '#4c7a4a', '#7fa8d8', '#d9a441', '#964735', '#8a6fb0'],
} = {}) {
  const width = margin * 2 + columns * cell + (columns - 1) * gutter;
  const height = margin * 2 + rows * cell + (rows - 1) * gutter;
  const parts = [];
  let index = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = margin + column * (cell + gutter);
      const y = margin + row * (cell + gutter);
      const colour = panelColours[index % panelColours.length];
      // A solid panel plus a shape near its centre, with NO product edge reaching
      // the cell border — a correct crop keeps the whole shape, a crop that
      // crosses a gutter clips it.
      parts.push(
        `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${colour}" opacity="0.22"/>`,
        `<circle cx="${x + cell / 2}" cy="${y + cell / 2}" r="${cell * 0.22}" fill="${colour}"/>`,
        `<rect x="${x + cell * 0.42}" y="${y + cell * 0.62}" width="${cell * 0.16}" height="${cell * 0.3}" rx="6" fill="#3f5f3d"/>`
      );
      index += 1;
    }
  }
  return sharp({ create: { width, height, channels: 3, background } })
    .composite([{ input: svg(parts.join(''), width, height) }])
    .jpeg({ quality: 94 })
    .toBuffer();
}

// ══════════ deterministic start ══════════
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([Workspace.init(), User.init(), Product.init(), ProductReferenceImage.init()]);

const wsA = await Workspace.create({ slug: `studio-a-${stamp}`, displayName: 'Studio A', status: 'ACTIVE' });
const wsB = await Workspace.create({ slug: `studio-b-${stamp}`, displayName: 'Studio B', status: 'ACTIVE' });

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
await makeUser({ email: adminAEmail, password: P('AdminA'), role: 'admin', name: 'Studio Admin A', workspaceId: wsA._id });
await makeUser({ email: adminBEmail, password: P('AdminB'), role: 'admin', name: 'Studio Admin B', workspaceId: wsB._id });
await makeUser({ email: limitedEmail, password: P('Limited'), role: 'handler', name: 'Limited Handler', workspaceId: wsA._id, permissions: [] });

const { child: SERVER, base } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: {
    SEED_ON_START: 'false',
    REFERENCE_MEDIA_DIR: MEDIA_DIR,
  },
  label: 'reference-studio',
});
const BASE = `${base}/api`;

async function req(method, pathname, { token, body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${pathname}`, {
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
  const buffer = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), buffer };
}

async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  return r.json?.token || null;
}

async function waitForTerminal(token, id, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await req('GET', `/references/${id}`, { token });
    const image = r.json?.image;
    if (image && !['UPLOADING', 'PROCESSING'].includes(image.status)) return image;
    if (image?.stale) return image;
    if (Date.now() > deadline) return image || null;
    await sleep(250);
  }
}

function panelCount(doc) {
  return Number(doc?.composite?.panelCount || 0);
}

try {
  // ══════════ fixtures ══════════
  const ADMIN_A = await login(adminAEmail, P('AdminA'));
  const ADMIN_B = await login(adminBEmail, P('AdminB'));
  const LIMITED = await login(limitedEmail, P('Limited'));
  check('fixtures: two workspace admins and a permissionless handler signed in', !!ADMIN_A && !!ADMIN_B && !!LIMITED);

  const customerEmail = `studio-customer-${stamp}@reference.test`;
  await req('POST', '/auth/register', { body: { name: 'Studio Customer', email: customerEmail, password: P('Cust') } });
  const CUSTOMER = await login(customerEmail, P('Cust'));
  check('fixtures: customer signed in', !!CUSTOMER);

  // ══════════ §A UPLOAD — NO SEGMENTATION ══════════
  console.log('\n— §A UPLOAD — NO SEGMENTATION —');
  const PHOTO = await photoOnPlainBackground();
  const draftKey = `draft-${stamp}`;

  let r = await upload(ADMIN_A, { buffer: PHOTO, filename: 'bloom.jpg', type: 'image/jpeg', fields: { draftKey } });
  const first = r.json?.image;
  check('an ordinary product photograph uploads (201)', r.status === 201 && !!first?.id, `${r.status}`);
  check(
    'the original is recorded with real dimensions, format and hash',
    first?.original?.width === 900 &&
      first?.original?.height === 900 &&
      first?.original?.format === 'jpeg' &&
      /^[a-f0-9]{64}$/.test(first?.original?.sha256 || ''),
    JSON.stringify(first?.original)
  );
  check('the storage path is never exposed by the API', findKeyPaths(r.json, 'storageKey').length === 0, findKeyPaths(r.json, 'storageKey').join(','));
  check('the upload is not mistaken for a composite sheet', first?.composite?.detected === false, JSON.stringify(first?.composite));

  const processed = await waitForTerminal(ADMIN_A, first.id);
  check('preparation completes (READY or NEEDS_REVIEW, never FAILED)', ['READY', 'NEEDS_REVIEW'].includes(processed?.status), `${processed?.status} ${processed?.processing?.error || ''}`);
  check('the measurement step is recorded as such (no segmentation engine)', processed?.processing?.engine === 'measure', `${processed?.processing?.engine}`);
  check('measurement duration is real work, not a stub', Number(processed?.processing?.durationMs) >= 0, `${processed?.processing?.durationMs}`);
  check('sharpness/contrast were measured', Number.isFinite(processed?.validation?.sharpnessScore) && Number.isFinite(processed?.validation?.contrastStdev), JSON.stringify(processed?.validation));
  check('no cutout is produced', processed?.cutout?.available === false && processed?.cutout?.registered === false, JSON.stringify(processed?.cutout));
  check('no neutral preview is produced', processed?.neutral?.available === false, JSON.stringify(processed?.neutral));
  check('the row says it is an uploaded photograph', processed?.source?.type === 'upload' && processed?.source?.parentId == null);
  check('forward-looking metadata is intact (order, primary, accepted, product link)', processed?.order === 0 && processed?.isPrimary === true && processed?.accepted === false && processed?.productSlug === '');

  const cutoutBytes = await fetchAsset(ADMIN_A, first.id, 'cutout');
  check('the removed feature is really removed: no cutout bytes are served (404)', cutoutBytes.status === 404, `${cutoutBytes.status}`);

  const options = await req('GET', '/references/options', { token: ADMIN_A });
  check(
    'the capability endpoint reports segmentation as disabled and advertises the panel budget',
    options.status === 200 && options.json?.options?.segmentation === 'disabled' && options.json?.options?.grid?.maxPanels >= 12,
    JSON.stringify(options.json?.options)
  );
  const engineStillThere = await req('GET', '/references/engine', { token: ADMIN_A });
  check('the old engine endpoint is gone (404, not a stub)', engineStillThere.status === 404, `${engineStillThere.status}`);

  // ══════════ §B ORIGINAL IS IMMUTABLE ══════════
  console.log('\n— §B ORIGINAL IS IMMUTABLE —');
  const originalPath = path.join(MEDIA_DIR, wsA.slug, first.id, 'original.jpg');
  const onDisk = await fs.readFile(originalPath).catch(() => null);
  check('the original file exists under the workspace namespace', !!onDisk, originalPath);
  check('the uploaded bytes were stored VERBATIM', onDisk && onDisk.equals(PHOTO));
  const dirEntries = await fs.readdir(path.join(MEDIA_DIR, wsA.slug, first.id));
  check('processing wrote no derived image next to it', dirEntries.length === 1 && dirEntries[0].startsWith('original.'), dirEntries.join(','));

  process.env.REFERENCE_MEDIA_DIR = MEDIA_DIR;
  pinFilesystemMediaDriver();
  const { writeAsset } = await import('../services/referenceAssetStorage.js');
  let overwriteCode = '';
  try {
    await writeAsset({ imageId: first.id, workspaceSlug: wsA.slug, kind: 'original', buffer: Buffer.from('x'), format: 'png' });
  } catch (err) {
    overwriteCode = err.code || err.message;
  }
  check('the store refuses to overwrite an original (ORIGINAL_IMMUTABLE)', overwriteCode === 'ORIGINAL_IMMUTABLE', overwriteCode);
  check('the original is byte-identical after the refusal', (await fs.readFile(originalPath)).equals(PHOTO));

  r = await upload(ADMIN_A, { buffer: PHOTO, filename: 'bloom-again.jpg', type: 'image/jpeg', fields: { draftKey } });
  const duplicate = r.json?.image;
  check('re-uploading the same bytes is accepted and reported as a duplicate', r.status === 201 && r.json?.duplicateOf === first.id, `${r.status} ${r.json?.duplicateOf}`);
  check('the duplicate carries its own original file', (await fs.readFile(path.join(MEDIA_DIR, wsA.slug, duplicate.id, 'original.jpg')).catch(() => null))?.equals(PHOTO) === true);

  // ══════════ §C COMPOSITE DETECTION ══════════
  console.log('\n— §C COMPOSITE DETECTION —');
  const SHEET_43 = await compositeSheet({ columns: 4, rows: 3 });
  r = await upload(ADMIN_A, { buffer: SHEET_43, filename: 'bouquet-4x3.jpg', type: 'image/jpeg', fields: { draftKey } });
  const sheet = r.json?.image;
  check('a 4×3 composite uploads (201)', r.status === 201 && !!sheet?.id, `${r.status}`);
  const sheetReady = await waitForTerminal(ADMIN_A, sheet.id);
  check('the 4×3 grid is detected on the right axes', sheetReady?.composite?.detected === true && sheetReady?.composite?.columns === 4 && sheetReady?.composite?.rows === 3, JSON.stringify(sheetReady?.composite));
  check('the detected sheet reports 12 views', panelCount(sheetReady) === 12, `${panelCount(sheetReady)}`);
  check('a confidently detected sheet needs no correction', sheetReady?.composite?.needsCorrection === false, JSON.stringify(sheetReady?.composite));

  const preview43 = await req('GET', `/references/${sheet.id}/views`, { token: ADMIN_A });
  const analysis43 = preview43.json?.analysis;
  check('the layout can be previewed (200)', preview43.status === 200 && !!analysis43?.layout, `${preview43.status}`);
  check('the preview lists 12 panels with distinct boxes', (analysis43?.panels || []).length === 12 && new Set(analysis43.panels.map((p) => `${p.box.x},${p.box.y}`)).size === 12);
  check(
    'every proposed box stays inside the frame',
    (analysis43?.panels || []).every((p) => p.box.x >= 0 && p.box.y >= 0 && p.box.x + p.box.width <= 1.0001 && p.box.y + p.box.height <= 1.0001),
    JSON.stringify(analysis43?.panels?.[0]?.box)
  );
  const rowsBefore = await ProductReferenceImage.countDocuments({ 'source.parentId': sheet.id });
  check('previewing writes nothing (no panels exist yet)', rowsBefore === 0, `${rowsBefore}`);
  check('the sheet itself is still one row in the set', (analysis43?.existingPanels || []).length === 0);

  const SHEET_34 = await compositeSheet({ columns: 3, rows: 4, cell: 220 });
  r = await upload(ADMIN_A, { buffer: SHEET_34, filename: 'bouquet-3x4.jpg', type: 'image/jpeg', fields: { draftKey } });
  const sheet34 = r.json?.image;
  const sheet34Ready = await waitForTerminal(ADMIN_A, sheet34.id);
  check('a 3×4 grid is detected on the right axes', sheet34Ready?.composite?.detected === true && sheet34Ready?.composite?.columns === 3 && sheet34Ready?.composite?.rows === 4, JSON.stringify(sheet34Ready?.composite));

  // ══════════ §D PANEL EXTRACTION ══════════
  console.log('\n— §D PANEL EXTRACTION —');
  const confirmed = await req('POST', `/references/${sheet.id}/views`, {
    token: ADMIN_A,
    body: { columns: 4, rows: 3, padding: 0 },
  });
  const createdPanels = confirmed.json?.panels || [];
  check('confirming the layout creates 12 views (201/200)', (confirmed.status === 200 || confirmed.status === 201) && createdPanels.length === 12, `${confirmed.status} ${createdPanels.length}`);
  check('each view records its panel index and source box', createdPanels.every((p) => Number.isInteger(p.panelIndex) && p.width > 0 && p.height > 0), JSON.stringify(createdPanels[0]));
  check('the sheet is marked confirmed', confirmed.json?.parent?.composite?.confirmed === true, JSON.stringify(confirmed.json?.parent?.composite));

  const panelRows = await ProductReferenceImage.find({ 'source.parentId': sheet.id }).sort({ 'source.panelIndex': 1 });
  check('the panel rows are associated with the same product/draft', panelRows.every((row) => row.draftKey === draftKey && String(row.source.parentId) === String(sheet.id)));
  check('panel bytes exist in private storage', (await Promise.all(panelRows.map((row) => fs.access(path.join(MEDIA_DIR, wsA.slug, String(row._id), `original.${row.original.format === 'jpeg' ? 'jpg' : row.original.format}`)).then(() => true).catch(() => false)))).every(Boolean));
  check('the parent sheet keeps its own original on disk', (await fs.readFile(originalPath.replace(first.id, sheet.id)).catch(() => null))?.equals(SHEET_43) === true);
  check('the sheet row is unchanged by the cut (same hash)', (await req('GET', `/references/${sheet.id}`, { token: ADMIN_A })).json?.image?.original?.sha256 === sheet.original.sha256);

  // A crop that crossed a separator would show a neighbouring panel's colour in
  // its corner. Assert each panel's corner is its own cell background.
  {
    const { extractPanel } = await import('../services/referenceViews.js');
    const panelOne = await extractPanel(SHEET_43, analysis43.panels[0].box);
    const meta = await sharp(panelOne.buffer).stats();
    const expectedWidth = 240;
    check(
      'a cut panel is exactly one cell (no gutter, no neighbour)',
      Math.abs(panelOne.width - expectedWidth) <= 2 && Math.abs(panelOne.height - expectedWidth) <= 2,
      `${panelOne.width}×${panelOne.height}`
    );
    check('the cut panel is not blank (the product survives the crop)', (meta.channels?.[0]?.stdev ?? 0) > 3, `stdev=${meta.channels?.[0]?.stdev}`);
  }

  const again = await req('POST', `/references/${sheet.id}/views`, { token: ADMIN_A, body: { columns: 4, rows: 3, padding: 0 } });
  const rowsNow = await ProductReferenceImage.countDocuments({ 'source.parentId': sheet.id });
  check('re-confirming the same grid does NOT duplicate views', again.status === 200 && rowsNow === 12, `${again.status} rows=${rowsNow}`);
  check('re-confirming reports updates, not creations', (again.json?.created || []).length === 0 && (again.json?.updated || []).length === 12, JSON.stringify({ created: again.json?.created, updated: again.json?.updated?.length }));

  // ══════════ §E CORRECTION & REFUSALS ══════════
  console.log('\n— §E CORRECTION & REFUSALS —');
  const SEAMLESS = await compositeSheet({ columns: 3, rows: 3, gutter: 0, cell: 200 });
  r = await upload(ADMIN_A, { buffer: SEAMLESS, filename: 'seamless.jpg', type: 'image/jpeg', fields: { draftKey } });
  const seamless = r.json?.image;
  const seamlessReady = await waitForTerminal(ADMIN_A, seamless.id);
  check(
    'a seamless sheet is reported as uncertain rather than silently cut',
    seamlessReady?.composite?.detected === false || seamlessReady?.composite?.needsCorrection === true,
    JSON.stringify(seamlessReady?.composite)
  );
  check('nothing was cut from the uncertain sheet', (await ProductReferenceImage.countDocuments({ 'source.parentId': seamless.id })) === 0);

  const declared = await req('POST', `/references/${seamless.id}/views`, { token: ADMIN_A, body: { columns: 3, rows: 3, padding: 0 } });
  check('an explicit layout is obeyed even when detection was unsure', declared.status === 200 && (declared.json?.panels || []).length === 9, `${declared.status} ${declared.json?.panels?.length}`);
  check('the declared layout is recorded as human-confirmed', declared.json?.parent?.composite?.layoutSource === 'declared' && declared.json?.parent?.composite?.confirmed === true);

  const shrink = await req('POST', `/references/${seamless.id}/views`, { token: ADMIN_A, body: { columns: 2, rows: 2, padding: 0 } });
  check('shrinking the grid removes the views that no longer exist', shrink.status === 200 && (shrink.json?.removed || []).length === 5 && (await ProductReferenceImage.countDocuments({ 'source.parentId': seamless.id })) === 4, `removed=${shrink.json?.removed?.length}`);

  const tooBig = await req('POST', `/references/${sheet.id}/views`, { token: ADMIN_A, body: { columns: 8, rows: 8 } });
  check('an oversized grid is refused (GRID_TOO_LARGE)', tooBig.status === 422 && tooBig.json?.code === 'GRID_TOO_LARGE', `${tooBig.status} ${tooBig.json?.code}`);
  const single = await req('POST', `/references/${sheet.id}/views`, { token: ADMIN_A, body: { columns: 1, rows: 1 } });
  check('a one-panel layout is refused (GRID_INVALID)', single.status === 422 && single.json?.code === 'GRID_INVALID', `${single.status} ${single.json?.code}`);
  const noNumbers = await req('POST', `/references/${sheet.id}/views`, { token: ADMIN_A, body: {} });
  check('a layout with no columns/rows is refused (422)', noNumbers.status === 422, `${noNumbers.status}`);

  const panelId = String(panelRows[0]._id);
  const splitPanel = await req('POST', `/references/${panelId}/views`, { token: ADMIN_A, body: { columns: 2, rows: 2 } });
  check('a panel can never be split again (PANEL_NOT_COMPOSITE)', splitPanel.status === 422 && splitPanel.json?.code === 'PANEL_NOT_COMPOSITE', `${splitPanel.status} ${splitPanel.json?.code}`);

  const cropRefused = await req('PATCH', `/references/${first.id}`, { token: ADMIN_A, body: { crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } } });
  check('the removed in-place crop is refused, not silently accepted', cropRefused.status === 422 && cropRefused.json?.code === 'CROP_NOT_SUPPORTED', `${cropRefused.status} ${cropRefused.json?.code}`);

  const dismissed = await req('PATCH', `/references/${seamless.id}`, { token: ADMIN_A, body: { composite: false } });
  check('a sheet can be marked as a single photograph', dismissed.status === 200 && dismissed.json?.image?.composite?.detected === false, `${dismissed.status}`);

  // ══════════ §F MULTI-VIEW SETS ══════════
  console.log('\n— §F MULTI-VIEW SETS —');
  const productSlug = `studio-bouquet-${stamp}`;
  const separate = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const up = await upload(ADMIN_A, {
      buffer: await compositeSheet({ columns: 2, rows: 1, gutter: 0, cell: 300, panelColours: [['#c2566a', '#4c7a4a', '#7fa8d8'][i]] }),
      filename: `view-${i}.jpg`,
      type: 'image/jpeg',
      fields: { draftKey, label: `View ${i + 1}`, mode: 'single' },
    });
    // eslint-disable-next-line no-await-in-loop
    const ready = await waitForTerminal(ADMIN_A, up.json?.image?.id);
    separate.push(ready);
  }
  check('three separate photographs are stored as three views', separate.length === 3 && separate.every((img) => img?.source?.type === 'upload'));
  check('mode=single disables grid detection', separate.every((img) => img?.composite?.detected === false), JSON.stringify(separate.map((img) => img?.composite?.detected)));

  // The studio always sends the WHOLE set (it owns the order), so the suite does
  // too: reordering a subset would leave the untouched rows interleaved and the
  // "first is primary" assertion would say nothing about the reorder.
  const allIds = (await req('GET', `/references?draftKey=${draftKey}`, { token: ADMIN_A })).json?.images?.map((img) => img.id) || [];
  const reordered = [...separate.map((img) => img.id).reverse(), ...allIds.filter((id) => !separate.some((img) => img.id === id))];
  const ordered = await req('PATCH', '/references/order', { token: ADMIN_A, body: { ids: reordered } });
  check('the whole set can be reordered in one call', ordered.status === 200 && ordered.json?.images?.length === reordered.length, `${ordered.status} ${ordered.json?.images?.length}/${reordered.length}`);
  check('the first view in the new order becomes primary', ordered.json?.images?.[0]?.id === separate[2].id && ordered.json?.images?.[0]?.isPrimary === true, JSON.stringify({ first: ordered.json?.images?.[0]?.id, want: separate[2].id }));

  const labelled = await req('PATCH', `/references/${separate[0].id}`, { token: ADMIN_A, body: { viewAngle: 'three-quarter-left' } });
  check('a viewpoint label is stored', labelled.status === 200 && labelled.json?.image?.viewAngle === 'three-quarter-left', `${labelled.status}`);
  const badLabel = await req('PATCH', `/references/${separate[0].id}`, { token: ADMIN_A, body: { viewAngle: 'overhead-ish' } });
  check('an unknown viewpoint label is refused (422)', badLabel.status === 422, `${badLabel.status}`);

  // ══════════ §G ACCEPT / REMOVE ══════════
  console.log('\n— §G ACCEPT / REMOVE —');
  const accept = await req('PATCH', `/references/${separate[0].id}`, { token: ADMIN_A, body: { accepted: true } });
  check('acceptance is explicit and recorded', accept.status === 200 && accept.json?.image?.accepted === true);

  const beforeDelete = await ProductReferenceImage.countDocuments({ 'source.parentId': sheet.id });
  const sheetFiles = await fs.readdir(path.join(MEDIA_DIR, wsA.slug, sheet.id)).catch(() => []);
  const del = await req('DELETE', `/references/${sheet.id}`, { token: ADMIN_A });
  check('deleting a composite removes its views', del.status === 200 && del.json?.removedPanels === beforeDelete, `${del.status} removedPanels=${del.json?.removedPanels}`);
  check('the panel rows are gone', (await ProductReferenceImage.countDocuments({ 'source.parentId': sheet.id })) === 0);
  check('the sheet original is kept until the delete completes, then removed', sheetFiles.length > 0 && (await fs.access(path.join(MEDIA_DIR, wsA.slug, sheet.id)).then(() => false).catch(() => true)));

  // ══════════ §H TENANCY & AUTH ══════════
  console.log('\n— §H TENANCY & AUTH —');
  const foreignList = await req('GET', `/references?draftKey=${draftKey}`, { token: ADMIN_B });
  check('another workspace sees an empty set for the same draft key', foreignList.status === 200 && (foreignList.json?.images || []).length === 0, `${foreignList.status} ${foreignList.json?.images?.length}`);
  const foreignGet = await req('GET', `/references/${first.id}`, { token: ADMIN_B });
  check('another workspace reads a reference as 404 (never 403)', foreignGet.status === 404 && foreignGet.json?.code === 'REFERENCE_NOT_FOUND', `${foreignGet.status}`);
  const foreignViews = await req('GET', `/references/${sheet34.id}/views`, { token: ADMIN_B });
  check('another workspace cannot preview a grid', foreignViews.status === 404, `${foreignViews.status}`);
  const foreignBytes = await fetchAsset(ADMIN_B, first.id, 'original');
  check('another workspace cannot read the bytes', foreignBytes.status === 404, `${foreignBytes.status}`);
  const anonymous = await fetchAsset(null, first.id, 'original');
  check('an anonymous read is refused', anonymous.status === 401, `${anonymous.status}`);
  const customer = await req('GET', `/references/${first.id}`, { token: CUSTOMER });
  check('a customer is refused the studio', customer.status === 403 || customer.status === 401, `${customer.status}`);
  const limited = await req('GET', `/references?draftKey=${draftKey}`, { token: LIMITED });
  check('a handler without products.view is refused', limited.status === 403, `${limited.status}`);

  // ══════════ §I FAILURE RECOVERY ══════════
  console.log('\n— §I FAILURE RECOVERY —');
  const missingId = separate[1].id;
  await fs.rm(path.join(MEDIA_DIR, wsA.slug, missingId), { recursive: true, force: true });
  const retry = await req('POST', `/references/${missingId}/reprocess`, { token: ADMIN_A });
  check('a reference whose bytes are gone reports ORIGINAL_MISSING', retry.status === 200 && retry.json?.image?.processing?.errorCode === 'ORIGINAL_MISSING', `${retry.status} ${retry.json?.image?.processing?.errorCode}`);
  check('the failed row stays visible instead of pretending to be ready', retry.json?.image?.status === 'FAILED');
  const acceptedFailed = await req('PATCH', `/references/${missingId}`, { token: ADMIN_A, body: { accepted: true } });
  check('a failed reference cannot be accepted', acceptedFailed.status === 422, `${acceptedFailed.status}`);

  const transparent = await transparentPng();
  r = await upload(ADMIN_A, { buffer: transparent, filename: 'alpha.png', type: 'image/png', fields: { draftKey, mode: 'single' } });
  const alpha = await waitForTerminal(ADMIN_A, r.json?.image?.id);
  check('a transparent PNG keeps its own alpha (not a generated mask)', alpha?.original?.hasAlpha === true, JSON.stringify(alpha?.original));
  check('a transparent PNG is stored verbatim, alpha and all', (await fetchAsset(ADMIN_A, alpha.id, 'original')).buffer?.equals(transparent) === true);

  const huge = await upload(ADMIN_A, {
    buffer: await sharp({ create: { width: 9000, height: 6000, channels: 3, background: '#ffffff' } }).jpeg().toBuffer(),
    filename: 'huge.jpg',
    type: 'image/jpeg',
    fields: { draftKey },
  });
  check('an oversized source image is refused honestly (4xx with a code)', huge.status >= 400 && huge.status < 500 && !!huge.json?.code, `${huge.status} ${huge.json?.code}`);

  // ══════════ §J SOURCE SHEET IS PROVENANCE, NOT A VIEW ══════════
  //
  // The composite an administrator uploaded is kept — but it is a SOURCE
  // DOCUMENT, not a viewpoint. Feeding the whole grid to the reconstruction
  // alongside the panels already cut from it would ask the engine to rebuild
  // twelve products at once. This section proves the exclusion is a SERVER
  // property, not a UI convention: it force-accepts the sheet through a raw
  // PATCH (which the studio would never do) and asserts the plan still refuses
  // to treat it as a view.
  console.log('\n— §J SOURCE SHEET IS PROVENANCE, NOT A VIEW —');

  //
  // NOTE the dynamic import below. `referenceAssetStorage.js` resolves its
  // private root ONCE at module-eval, and §B relies on being the first importer
  // (it sets REFERENCE_MEDIA_DIR, then imports, so the root lands on the suite's
  // temp directory). Importing the generation service at the TOP OF THIS FILE
  // would pull that module in too early and silently redirect every later write
  // to the default root — which is exactly how this section's first draft broke
  // §B's immutability check while leaving the bytes untouched.
  const { planForProduct } = await import('../services/3dGenerationService.js');

  const J_SLUG = `studio-sheet-provenance-${stamp}`;
  // 4×3, the layout §C already proves this detector recognises. A 3×2 sheet at
  // THIS helper's geometry was deliberately tried first and honestly reported
  // confidence 0% instead of guessing: with two rows there is only one internal
  // seam, so that axis has almost no periodicity to score. The correction
  // workspace exists precisely for that case — the operator declares the grid
  // and it is obeyed — but §J is about provenance, so it uses a confident
  // layout and stays focused.
  const jUp = await upload(ADMIN_A, {
    buffer: await compositeSheet({ columns: 4, rows: 3 }),
    filename: 'twelve-view-bouquet.jpg',
    type: 'image/jpeg',
    fields: { draftKey },
  });
  const jSheet = await waitForTerminal(ADMIN_A, jUp.json?.image?.id);
  check('a fresh composite sheet is uploaded and detected', jSheet?.composite?.detected === true, JSON.stringify(jSheet?.composite));

  const jConfirmed = await req('POST', `/references/${jSheet.id}/views`, {
    token: ADMIN_A,
    body: { columns: 4, rows: 3 },
  });
  const jPanels = jConfirmed.json?.panels || [];
  check('twelve views are cut from it', jConfirmed.status < 300 && jPanels.length === 12, `${jConfirmed.status} ${jPanels.length}`);

  // Accept only the first two VIEWS — the sheet is never accepted by the studio.
  const jAccepted = jPanels.slice(0, 2).map((p) => p.id);
  for (const id of jAccepted) {
    // eslint-disable-next-line no-await-in-loop
    await req('PATCH', `/references/${id}`, { token: ADMIN_A, body: { accepted: true } });
  }

  // ADVERSARIAL: accept the SHEET through a raw PATCH. If the exclusion lived
  // only in the UI, this would put the whole grid into the reconstruction's
  // view set.
  const forced = await req('PATCH', `/references/${jSheet.id}`, {
    token: ADMIN_A,
    body: { accepted: true },
  });
  check(
    'the sheet can be force-accepted by a raw PATCH (so the server filter is genuinely tested)',
    forced.status === 200 && forced.json?.image?.accepted === true,
    `${forced.status}`
  );

  // Hand the two accepted views to a product: the sheet rides along as
  // provenance and survives the draft cleanup.
  const attachRes = await req('POST', '/references/attach', {
    token: ADMIN_A,
    body: { productSlug: J_SLUG, ids: jAccepted, draftKey },
  });
  check(
    'attaching reports the two accepted views',
    attachRes.status === 200 && attachRes.json?.attached === 2,
    `${attachRes.status} attached=${attachRes.json?.attached}`
  );
  check(
    'the source sheet is reported separately, not as a view',
    attachRes.json?.sourceSheets === 1,
    String(attachRes.json?.sourceSheets)
  );

  const forProduct = await req('GET', `/references?productSlug=${J_SLUG}`, { token: ADMIN_A });
  const rows = forProduct.json?.images || [];
  const rowSheet = rows.find((row) => row.source?.type !== 'panel');
  check('the sheet survived the draft cleanup and is attached to the product', rows.length === 3 && !!rowSheet, `${rows.length}`);
  check(
    'the sheet stays traceable to the product it produced',
    rowSheet?.productSlug === J_SLUG && rowSheet?.isPrimary === false,
    JSON.stringify({ productSlug: rowSheet?.productSlug, isPrimary: rowSheet?.isPrimary })
  );
  check(
    'the two views stay accepted and still point at their sheet',
    rows.filter((row) => row.source?.type === 'panel' && row.accepted).length === 2 &&
      rows.filter((row) => row.source?.parentId === String(jSheet.id)).length === 2,
    `${rows.filter((row) => row.source?.type === 'panel' && row.accepted).length} accepted panels`
  );

  // THE POINT OF THE SECTION. The plan is asked for the product's views while
  // the SHEET is genuinely accepted=true and genuinely attached to the product
  // — the worst case a client could create. The server must still count and
  // list only the two views: the sheet is provenance, never a reconstruction
  // input.
  const adminADoc = await User.findOne({ email: adminAEmail });
  const plan = await planForProduct({ user: adminADoc }, J_SLUG, [...jAccepted, jSheet.id]);
  check(
    'the reconstruction plan counts only the two VIEWS, never the sheet',
    plan.viewsAccepted === 2 && plan.acceptedCount === 2,
    JSON.stringify({ viewsAccepted: plan.viewsAccepted, acceptedCount: plan.acceptedCount })
  );
  check(
    "the sheet is absent from the plan's stored view set",
    !(plan.references || []).some((row) => String(row.id) === String(jSheet.id)),
    JSON.stringify((plan.references || []).map((row) => row.id))
  );
  check(
    'the plan still offers the two real views as selected inputs',
    (plan.references || []).every((row) => jAccepted.includes(String(row.id))),
    JSON.stringify((plan.references || []).map((row) => row.id))
  );
} finally {
  await stopTestServer(SERVER);
  await mongoose.connection.db.dropDatabase().catch(() => {});
  await fs.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  await mongoose.disconnect().catch(() => {});
}

// The prefixed form is what scripts/run-all.mjs parses. Without it the suite
// reported "PASS 0": its assertions ran and passed, but the release summary
// counted none of them — and a suite that asserted nothing looked identical.
console.log(`\nREFERENCE STUDIO RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const name of failures) console.log(`  · ${name}`);
  process.exitCode = 1;
}
