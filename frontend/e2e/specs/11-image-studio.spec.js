/**
 * PHASE 1 — E2E: the 3D Studio, "Prepare Images".
 *
 * WHY THIS SPEC EXISTS
 * --------------------
 * The backend suite proves the pipeline (engines, licence guard, tenancy) by
 * calling the API. It cannot see the render path at all — this project has no
 * frontend unit runner — and the phase's first manual pass found exactly what
 * that blindness hides: an unimported icon that white-screened the whole studio
 * on the first upload, and duplicate React keys from a message two layers both
 * emitted. `observe(page)` turns both of those into failures here.
 *
 * So this spec drives the real stack the way an administrator does: sign in,
 * upload a genuinely decodable photograph through the file input, wait for the
 * SERVER to segment it, check in the browser that the cutout really has
 * transparent pixels, accept it, save the product, and confirm the accepted set
 * comes back on the product's edit page in the same bytes.
 */

import { test, expect } from '@playwright/test';
import { freshVisitor, observe, signInAdmin, waitForRouteReady } from '../support/helpers.js';
import { BROKEN_PNG, makeProductPng, STUDIO_PRODUCT_NAMES } from '../support/fixtures.js';

/* The name this spec gives the product it creates is shared with `e2e/stack.mjs`,
   which removes the product (and its attached reference) at boot — otherwise a
   second run fails on the duplicate-name rule rather than on the behaviour
   under test. */
const PRODUCT_NAME = STUDIO_PRODUCT_NAMES.prepared;

/** Alpha below this counts as transparent — the same threshold the UI implies. */
const ALPHA_CUTOFF = 8;

/** Draw the served cutout into a canvas and report how much of it is see-through. */
async function transparentRatio(imageLocator) {
  return imageLocator.evaluate(async (img, cutoff) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < cutoff) transparent += 1;
    return transparent / (canvas.width * canvas.height);
  }, ALPHA_CUTOFF);
}

/** Byte length of the bytes behind an <img> (fetched the way the page fetched them). */
async function imageBytes(imageLocator) {
  return imageLocator.evaluate(async (img) => (await (await fetch(img.src)).blob()).size);
}

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 23 — 3D Studio: upload a photo, get a real transparent cutout, accept and save it with the product', async ({
  page,
}) => {
  const audit = observe(page);

  await signInAdmin(page);
  await page.goto('/admin/products/new');
  await waitForRouteReady(page);

  const studio = page.getByTestId('reference-studio');
  await expect(studio).toBeVisible();

  const png = makeProductPng();
  await page.getByTestId('reference-input').setInputFiles({
    name: 'e2e-studio-posy.png',
    mimeType: 'image/png',
    buffer: png,
  });

  /* The card appears as UPLOADING/PROCESSING and settles after the real
     segmentation run — a status the SERVER wrote, not a client-side guess. */
  /* The status vocabulary is rendered in caps by CSS, so match the TEXT, not
     the styling (`Ready`, `Needs review`, `Failed`). */
  const card = page.getByTestId('reference-card-0');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(/ready|needs.?review/i, { timeout: 90_000 });
  await expect(card).not.toContainText(/failed/i);

  /* Both previews are private assets served through the API, so "loaded" means
     the admin token was accepted and the bytes were real. */
  const original = card.getByAltText('Original upload 1');
  const cutout = card.getByAltText('Background removed 1');
  await expect.poll(() => original.evaluate((img) => img.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => cutout.evaluate((img) => img.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);

  /* The whole point of the feature: the background is actually gone. */
  const ratio = await transparentRatio(cutout);
  expect(ratio, `the cutout was not transparent (ratio ${ratio})`).toBeGreaterThan(0.05);

  /* And the ORIGINAL is served untouched — same bytes as were uploaded. */
  expect(await imageBytes(original)).toBe(png.length);

  /* The review step gates the handoff: nothing travels with the product until
     the administrator accepts it. */
  const accepted = page
    .locator('[data-testid="reference-grid"]')
    .getByRole('button', { name: /^accept$/i })
    .first();
  await accepted.click();
  await expect(card).toContainText(/accepted/i, { timeout: 30_000 });

  /* Save through the ordinary product form — the studio must not have broken it. */
  await page.getByPlaceholder('e.g., The Dusty Rose & Lavender Dream Posy').fill(PRODUCT_NAME);
  await page.getByRole('spinbutton').first().fill('1250');
  await page.getByRole('button', { name: /save product/i }).click();
  await expect(page).toHaveURL(/\/admin\/products$/, { timeout: 30_000 });

  /* Server truth: the product exists WITH the reference attached. */
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'));
  expect(token, 'no staff token after sign-in').toBeTruthy();
  const list = await page.evaluate(
    async ({ apiUrl, t, name }) => {
      /* GET /products is workspace-scoped for a staff caller and returns the
         whole set (it caps at 500 rows), so the product just created is in it. */
      const r = await fetch(`${apiUrl}/products`, { headers: { Authorization: `Bearer ${t}` } });
      const body = await r.json().catch(() => null);
      return { status: r.status, product: (body?.products || []).find((p) => p.name === name) || null };
    },
    { apiUrl: process.env.E2E_API_URL || 'http://127.0.0.1:4000/api', t: token, name: PRODUCT_NAME }
  );
  expect(list.status).toBe(200);
  expect(list.product, 'the product created through the form was not saved').toBeTruthy();

  const attached = await page.evaluate(
    async ({ apiUrl, t, slug }) => {
      const r = await fetch(`${apiUrl}/references?productSlug=${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      const body = await r.json().catch(() => null);
      return { status: r.status, images: body?.images || [] };
    },
    { apiUrl: process.env.E2E_API_URL || 'http://127.0.0.1:4000/api', t: token, slug: list.product.slug }
  );
  expect(attached.status).toBe(200);
  expect(attached.images.length, 'the accepted reference did not travel with the product').toBe(1);
  expect(attached.images[0].accepted).toBe(true);
  expect(attached.images[0].status).toBe('READY');

  /* Retrievable later, in the product's own editor — no re-upload needed. */
  await page.goto(`/admin/products/${list.product.slug}`);
  await waitForRouteReady(page);
  await page.getByRole('button', { name: /edit product/i }).click();
  const savedCard = page.getByTestId('reference-card-0');
  await expect(savedCard).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => imageBytes(savedCard.getByAltText('Original upload 1')), { timeout: 30_000 }).toBe(png.length);

  /* The render path stayed clean: no uncaught error and no React key collision. */
  const { pageErrors, consoleErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  const reactErrors = consoleErrors.filter((m) => /same key|not defined|Cannot read/i.test(m));
  expect(reactErrors, `React render errors: ${reactErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 24 — a file that only claims to be an image is refused, and product editing still works', async ({
  page,
}) => {
  const audit = observe(page);

  await signInAdmin(page);
  await page.goto('/admin/products/new');
  await waitForRouteReady(page);

  const studio = page.getByTestId('reference-studio');
  await expect(studio).toBeVisible();

  await page.getByTestId('reference-input').setInputFiles({
    name: 'e2e-broken.png',
    mimeType: 'image/png',
    buffer: BROKEN_PNG,
  });

  /* The upload is rejected on its CONTENT (the MIME claim is not trusted) and
     the reason is shown to the administrator. */
  await expect(studio).toContainText(/not a readable image|failed|corrupt/i, { timeout: 30_000 });
  await expect(page.getByTestId('reference-grid')).toHaveCount(0);
  /* A rejected file must not leave the studio claiming to be busy: the product
     form disables Save while it is, and a corrupt image would then make the
     whole product unsavable. */
  await expect(page.getByRole('button', { name: /save product/i })).toBeEnabled({ timeout: 30_000 });

  /* The failure stayed inside the studio: the form is still usable and the
     product still saves without any prepared image. */
  await page.getByPlaceholder('e.g., The Dusty Rose & Lavender Dream Posy').fill(STUDIO_PRODUCT_NAMES.brokenUpload);
  await page.getByRole('spinbutton').first().fill('999');
  await page.getByRole('button', { name: /save product/i }).click();
  await expect(page).toHaveURL(/\/admin\/products$/, { timeout: 30_000 });

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
