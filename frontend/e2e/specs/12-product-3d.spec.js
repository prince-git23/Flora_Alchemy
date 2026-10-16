/**
 * PHASE 3 — E2E: the customer-facing 3D product experience.
 *
 * WHY THIS SPEC EXISTS
 * --------------------
 * The backend suite (`scripts/3d-studio-smoke.mjs`, §J) proves the public
 * delivery CONTRACT by calling the API: only an approved model is projected,
 * candidate/rejected/deprecated assets are 404, an unpublished product loses its
 * model, and a replacement follows. It cannot see the render path at all — this
 * project has no frontend unit runner — so nothing there can tell us whether
 * three.js actually parses the bytes, whether the viewer is lazy, or whether the
 * gallery still works when a model is gone.
 *
 * So this spec drives the real stack the way a customer does: open the product,
 * see the photographs, choose 3D View, watch the real GLB load in a real
 * browser, come back to the photographs and add to bag — plus the two honest
 * failure paths (a withdrawn model, a browser without WebGL) and a phone-sized
 * layout.
 *
 * WHICH MODEL IT RUNS AGAINST, DECLARED EITHER WAY. By default `e2e/stack.mjs`
 * writes an APPROVED asset plus a genuine glTF Binary container (`makeGlb`) into
 * the private 3D root, because generation needs a GPU provider a browser suite
 * cannot assume — what that proves is the whole CUSTOMER path against real
 * bytes: approval gate → public route → lazy viewer → three.js parse → pixels,
 * but NOT that a provider can produce a good mesh.
 *
 * PHASE 4 CLOSES THAT GAP WHEN A REAL MODEL IS AVAILABLE: set
 * `THREE_E2E_REAL_GLB=<path>` (see `backend/scripts/3d-real-generation.mjs`) and
 * the stack publishes the bytes a REAL TripoSR worker generated, the asset row
 * records `provider: 'local_worker'`, and FLOW 25 additionally asserts that the
 * bytes the CUSTOMER downloaded are byte-identical in length to that file. The
 * run says which mode it was in, in the log and in the screenshot it leaves
 * behind, so neither result can be mistaken for the other.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED, freshVisitor, observe, expectBagItems } from '../support/helpers.js';

/** The FRONTEND root (this file lives in frontend/e2e/specs). */
const FRONTEND_DIR = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const REPO_ROOT = path.resolve(FRONTEND_DIR, '..');

/** Phase 4: the genuinely generated model, when one was handed to this run. */
const REAL_GLB = String(process.env.THREE_E2E_REAL_GLB || '').trim()
  ? path.resolve(String(process.env.THREE_E2E_REAL_GLB).trim())
  : '';
const EVIDENCE_DIR = path.join(REPO_ROOT, 'audit', 'phase4-real-generation');

/* `dusty-rose-lavender-posy` is the product the stack approves a model for;
   `vintage-peony-eucalyptus-posy` is a real seeded row with NO model, which is
   the case that must behave exactly as it did before Phase 3. */
const WITH_MODEL = SEED.product.slug;
const WITHOUT_MODEL = SEED.productAlt.slug;

const GLB_REQUEST_RE = /\/3d\/products\/[^/]+\/model\/[^/]+\/glb/;

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 25 — an approved model: photographs stay the default, the lazy viewer draws a real GLB, and the bag still works', async ({
  page,
}) => {
  const audit = observe(page);

  /* Every request for model bytes, recorded from before the first navigation. */
  const glbRequests = [];
  page.on('request', (request) => {
    if (GLB_REQUEST_RE.test(request.url())) glbRequests.push(request.url());
  });



  await page.goto(`/product/${WITH_MODEL}`);

  const gallery = page.locator('[data-gallery]');
  await expect(gallery).toBeVisible();

  /* The 3D option exists — this product has an administrator-approved model. */
  const threeDTab = page.getByTestId('gallery-tab-3d');
  await expect(threeDTab).toBeVisible();

  /* …and the DEFAULT is still the photographs: no viewer mounted, and — the
     point of the whole loading policy — no model bytes downloaded. */
  await expect(page.getByTestId('product-3d-view')).toHaveCount(0);
  await expect(gallery.locator('img[fetchpriority="high"]')).toBeVisible();
  expect(glbRequests, 'opening the product page must not download the model').toEqual([]);

  await threeDTab.click();

  const view = page.getByTestId('product-3d-view');
  await expect(view).toBeVisible();

  /* `data-state="ready"` is set only after three.js has PARSED the fetched
     bytes and found drawable geometry — the app's own receipt that a real GLB
     arrived, not a client-side guess. */
  const preview = page.getByTestId('glb-preview');
  await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(view.locator('canvas')).toHaveCount(1);

  /* The bytes came from the PUBLIC delivery path, unauthenticated. */
  expect(glbRequests.length, 'the viewer fetched no model').toBeGreaterThan(0);
  for (const url of glbRequests) {
    const parsed = new URL(url);
    expect(parsed.pathname).toMatch(/^\/api\/3d\/products\/[^/]+\/model\/[^/]+\/glb$/);
  }

  /* A live viewport: the canvas is really sized, and the orbit controls offer
     the reset-view affordance (drag/zoom themselves are gesture-driven). */
  const canvasBox = await view.locator('canvas').boundingBox();
  expect(canvasBox?.width || 0).toBeGreaterThan(100);
  expect(canvasBox?.height || 0).toBeGreaterThan(100);
  await expect(page.getByRole('button', { name: /reset the 3d view/i })).toBeVisible();

  /* Evidence for the Phase 4 report: the rendered view, labelled by provenance.
     Taken BEFORE the byte assertion below so a failed assertion still leaves a
     picture of what the customer saw. */
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, `customer-3d-view-${REAL_GLB ? 'generated' : 'fixture'}-desktop.png`),
      fullPage: false,
    });
  } catch (err) {
    console.warn(`[phase4] evidence screenshot skipped: ${err.message}`);
  }

  /* PHASE 4 — when this run published a genuinely generated model, prove the
     customer was served THAT model. Rather than reading a recorded response body
     (which a streaming fetch can leave empty), this re-requests the exact URL the
     real viewer used, unauthenticated, and compares its byte length to the
     generated file: a fixture can never satisfy it, and it also re-proves that
     the public delivery route needs no credentials. In an ordinary fixture run
     the assertion is skipped — and the log line says so — rather than softened. */
  let servedBytes = null;
  if (REAL_GLB && existsSync(REAL_GLB)) {
    const generatedBytes = readFileSync(REAL_GLB).length;
    servedBytes = await page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: 'omit' });
      const buffer = await res.arrayBuffer();
      return { status: res.status, bytes: buffer.byteLength };
    }, glbRequests[glbRequests.length - 1]);
    expect(servedBytes.status, 'the public delivery route must serve the model without credentials').toBe(200);
    expect(
      servedBytes.bytes,
      `the public route served ${servedBytes.bytes} bytes; the generated model is ${generatedBytes}`
    ).toBe(generatedBytes);
  }
  console.log(
    `[phase4] FLOW 25 rendered the ${REAL_GLB && existsSync(REAL_GLB) ? 'REAL GENERATED model' : 'deterministic fixture'}` +
      (servedBytes ? ` and the public route served ${servedBytes.bytes} generated bytes` : '')
  );

  /* Back to the photographs: the viewer unmounts (which is where its GPU
     resources and object URL are released) and the photograph returns. */
  await page.getByTestId('back-to-photos').click();
  await expect(page.getByTestId('product-3d-view')).toHaveCount(0);
  await expect(gallery.locator('img[fetchpriority="high"]')).toBeVisible();
  await expect(page.getByTestId('gallery-tab-photos')).toHaveAttribute('aria-pressed', 'true');

  /* The rest of the page is untouched by any of this. */
  const cta = page.getByRole('button', { name: /Add to Bag/i }).first();
  await expect(cta).toBeEnabled();
  await cta.click();
  await expectBagItems(page, 1);

  /* PHASE 4 acceptance — the model is still functional after a RELOAD.
     Nothing the viewer fetched is remembered: the product page re-resolves the
     public projection and the browser fetches the GLB again, so a customer who
     refreshes gets the live approved model rather than a blank viewport. */
  await page.reload();
  await page.getByTestId('gallery-tab-3d').click();
  await expect(page.getByTestId('glb-preview')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(page.getByTestId('product-3d-view').locator('canvas')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /reset the 3d view/i })).toBeVisible();

  const { pageErrors, consoleErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  const reactErrors = consoleErrors.filter((m) => /same key|not defined|Cannot read/i.test(m));
  expect(reactErrors, `React render errors: ${reactErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 26 — a product with NO approved model behaves exactly as before: no 3D control at all', async ({ page }) => {
  await page.goto(`/product/${WITHOUT_MODEL}`);

  const gallery = page.locator('[data-gallery]');
  await expect(gallery).toBeVisible();
  await expect(gallery.locator('img[fetchpriority="high"]')).toBeVisible();

  /* Not a disabled button and not a "coming soon" badge — the option simply
     does not exist, because this product has nothing to show. */
  await expect(page.getByTestId('gallery-tab-3d')).toHaveCount(0);
  await expect(page.getByTestId('gallery-tab-photos')).toHaveCount(0);
  await expect(page.getByTestId('product-3d-view')).toHaveCount(0);

  /* And the ordinary gallery still behaves: product identity, price, bag. */
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('main')).toContainText(/₹/);
  const cta = page.getByRole('button', { name: /Add to Bag/i }).first();
  await expect(cta).toBeEnabled();
  await cta.click();
  await expectBagItems(page, 1);
});

test('FLOW 27 — three.js is NOT in the storefront entry bundle (it is a lazy chunk)', async () => {
  const distDir = path.join(FRONTEND_DIR, 'dist');
  const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');

  /* Everything `index.html` loads up front IS the entry bundle. */
  const initialScripts = [...html.matchAll(/assets\/[^"']+\.js/g)].map((m) => m[0]);
  expect(initialScripts.length, 'index.html exposes no script to check — the guard would be vacuous').toBeGreaterThan(0);

  for (const rel of initialScripts) {
    const src = readFileSync(path.join(distDir, rel), 'utf8');
    expect(
      /WebGLRenderer|GLTFLoader|OrbitControls|three\.module/.test(src),
      `${rel} is loaded on first paint and must not carry three.js`
    ).toBe(false);
  }

  /* …and the renderer really is shipped as its own chunk, so the check above
     proves lazy loading rather than a missing dependency. */
  const assets = readdirSync(path.join(distDir, 'assets'));
  expect(assets.some((f) => /^three\.module.*\.js$/.test(f))).toBe(true);
  expect(assets.some((f) => /^Product3dViewer.*\.js$/.test(f))).toBe(true);
});

test('FLOW 28 — a model that is no longer available falls back to the photographs, not to a broken page', async ({
  page,
}) => {
  /* The asset was withdrawn between the page load and the click (an
     administrator replaced or unpublished it): the public route answers 404. */
  await page.route('**/3d/products/**/model/**/glb', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, message: 'Asset not found.', code: 'ASSET_NOT_FOUND' }),
    })
  );

  await page.goto(`/product/${WITH_MODEL}`);
  await page.getByTestId('gallery-tab-3d').click();

  await expect(page.getByTestId('glb-preview')).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  const error = page.getByTestId('product-3d-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/no longer available|could not/i);

  /* The documented escape, independent of the viewport's own state. */
  await page.getByTestId('back-to-photos').click();
  await expect(page.getByTestId('product-3d-view')).toHaveCount(0);
  await expect(page.locator('[data-gallery] img[fetchpriority="high"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /Add to Bag/i }).first()).toBeEnabled();
});

test('FLOW 29 — a browser without WebGL keeps the photographs usable', async ({ page }) => {
  const audit = observe(page);

  /* Simulate the honest worst case the fallback exists for: a context that
     cannot be created (old device, blocked GPU, software rendering disabled). */
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
      if (String(type).toLowerCase().includes('webgl')) return null;
      return original.call(this, type, ...rest);
    };
  });

  await page.goto(`/product/${WITH_MODEL}`);
  await page.getByTestId('gallery-tab-3d').click();

  /* The viewer reports the failure instead of crashing the page. */
  await expect(page.getByTestId('glb-preview')).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(page.getByTestId('back-to-photos')).toBeVisible();

  await page.getByTestId('back-to-photos').click();
  await expect(page.locator('[data-gallery] img[fetchpriority="high"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /Add to Bag/i }).first()).toBeEnabled();

  /* A refused WebGL context must not surface as an uncaught error either. */
  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 30 — on a phone-sized viewport the 3D view fits and the page still scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/product/${WITH_MODEL}`);
  await page.getByTestId('gallery-tab-3d').click();
  await expect(page.getByTestId('glb-preview')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });

  /* No horizontal overflow: the model box and its controls stay inside the
     viewport (a 3D canvas is a classic source of a stray horizontal scrollbar). */
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'the 3D view introduced horizontal overflow').toBeLessThanOrEqual(1);

  /* The exit control is reachable, and the page can be scrolled with a gesture
     that starts OUTSIDE the viewport (inside it, wheel/touch belongs to the
     model's zoom — which is why the viewer disables its own touch-action). */
  await expect(page.getByTestId('back-to-photos')).toBeVisible();
  await page.mouse.move(195, 820);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await expect(page.getByRole('button', { name: /Add to Bag/i }).first()).toBeEnabled();
});
