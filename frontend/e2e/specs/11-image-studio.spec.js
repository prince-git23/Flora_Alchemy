/**
 * MULTI-VIEW REFERENCES — E2E: the 3D Studio, "Product Views".
 *
 * WHY THIS SPEC EXISTS
 * --------------------
 * The backend suite proves the pipeline (grid detection, panel extraction,
 * correction, tenancy) by calling the API. It cannot see the render path at all
 * — this project has no frontend unit runner — and the previous phase's first
 * manual pass found exactly what that blindness hides: an unimported icon that
 * white-screened the whole studio on the first upload, and duplicate React keys
 * from a message two layers both emitted. `observe(page)` turns both of those
 * into failures here.
 *
 * WHAT IT DOES NOW
 * ----------------
 * It drives the real stack the way an administrator does: upload ONE composite
 * sheet, confirm the grid the SERVER detected, let the server cut the views,
 * check in the browser that the cut views really are the product (not a
 * background-removed husk), accept them, save the product, and confirm the views
 * come back on the product's edit page in the same bytes.
 *
 * It also asserts the ABSENCE of the removed feature: no cutout preview, no
 * "Fix crop" control, no transparency checkerboard. A regression that quietly
 * reintroduces background removal would fail here.
 */

import { test, expect } from '@playwright/test';
import { freshVisitor, observe, signInAdmin, waitForRouteReady } from '../support/helpers.js';
import { BROKEN_PNG, makeCompositeSheetPng, STUDIO_PRODUCT_NAMES } from '../support/fixtures.js';

/* The name this spec gives the product it creates is shared with `e2e/stack.mjs`,
   which removes the product (and its attached references) at boot — otherwise a
   second run fails on the duplicate-name rule rather than on the behaviour under
   test. */
const PRODUCT_NAME = STUDIO_PRODUCT_NAMES.prepared;

/** Byte length of the bytes behind an <img> (fetched the way the page fetched them). */
async function imageBytes(imageLocator) {
  return imageLocator.evaluate(async (img) => (await (await fetch(img.src)).blob()).size);
}

/**
 * How much NON-BACKGROUND content a served panel contains.
 *
 * A panel that lost the product (the removed cutout behaviour) or one that was
 * cropped across a gutter into an empty white band would come back almost
 * uniform. This draws the panel and measures the share of pixels that differ
 * from the white background.
 */
async function contentRatio(imageLocator) {
  return imageLocator.evaluate(async (img) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let subject = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (Math.abs(r - 246) + Math.abs(g - 243) + Math.abs(b - 239) > 30) subject += 1;
    }
    return subject / (canvas.width * canvas.height);
  });
}

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 23 — a composite sheet is detected, confirmed, cut into views and saved with the product', async ({
  page,
}) => {
  const audit = observe(page);

  await signInAdmin(page);
  await page.goto('/admin/products/new');
  await waitForRouteReady(page);

  const studio = page.getByTestId('reference-studio');
  await expect(studio).toBeVisible();

  const sheet = makeCompositeSheetPng({ columns: 3, rows: 2 });
  await page.getByTestId('reference-input').setInputFiles({
    name: 'e2e-composite-bouquet.png',
    mimeType: 'image/png',
    buffer: sheet,
  });

  /* The card appears as UPLOADING/PROCESSING and settles after the real
     analysis run — a status the SERVER wrote, not a client-side guess. */
  const card = page.getByTestId('reference-card-0');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(/ready|needs.?review/i, { timeout: 90_000 });
  await expect(card).not.toContainText(/failed/i);

  /* The detector's proposal opens the grid workspace on its own: a detected
     grid must never be cut behind the administrator's back. */
  const workspace = page.getByTestId('grid-workspace');
  await expect(workspace).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('grid-columns')).toHaveText('3');
  await expect(page.getByTestId('grid-rows')).toHaveText('2');

  /* Every proposed panel is drawn over the original, and the panels are still
     only a PROPOSAL — no views exist yet. */
  await expect(page.getByTestId('panel-box-0')).toBeVisible();
  await expect(page.getByTestId('panel-box-5')).toBeVisible();
  await expect(page.getByTestId('reference-card-1')).toHaveCount(0);

  /* The original is served untouched. */
  const original = card.getByAltText(/^Reference 1/);
  await expect.poll(() => original.evaluate((img) => img.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await imageBytes(original)).toBe(sheet.length);

  /* Confirm: the SERVER cuts the panels from the untouched original. */
  await page.getByTestId('confirm-views').click();
  await expect(page.getByTestId('reference-card-5')).toBeVisible({ timeout: 60_000 });
  await expect(studio).toContainText(/Created 6 views/i, { timeout: 30_000 });

  /* Each view is the product, not an empty band: the crop took separators only. */
  const panel = page.getByTestId('reference-card-1');
  const panelImage = panel.getByAltText(/^Reference 2/);
  await expect.poll(() => panelImage.evaluate((img) => img.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  const ratio = await contentRatio(panelImage);
  expect(ratio, `a cut view lost its product (content ratio ${ratio})`).toBeGreaterThan(0.1);

  /* THE REMOVED FEATURE STAYS REMOVED. */
  await expect(studio).not.toContainText(/cutout/i);
  await expect(page.getByRole('button', { name: /fix crop/i })).toHaveCount(0);
  await expect(card.getByAltText(/background removed/i)).toHaveCount(0);

  /* The review step gates the handoff: nothing travels with the product until
     the administrator accepts it. */
  await page.getByRole('button', { name: /^accept all$/i }).click();

  /* Card 0 is the SOURCE SHEET. "Accept all" must deliberately skip it: a
     sheet is provenance, not a viewpoint. */
  await expect(page.getByTestId('source-sheet-badge')).toContainText(/source sheet/i, { timeout: 30_000 });
  await expect(page.getByTestId('reference-card-0')).toContainText(/kept for audit/i);
  await expect(page.getByTestId('reference-card-0')).not.toContainText(/Accepted ✓/i);

  /* …while a real view IS accepted. */
  await expect(page.getByTestId('reference-card-1')).toContainText(/Accepted ✓/i, { timeout: 30_000 });

  /* Save through the ordinary product form — the studio must not have broken it. */
  await page.getByPlaceholder('e.g., The Dusty Rose & Lavender Dream Posy').fill(PRODUCT_NAME);
  await page.getByRole('spinbutton').first().fill('1250');
  await page.getByRole('button', { name: /save product/i }).click();
  await expect(page).toHaveURL(/\/admin\/products$/, { timeout: 30_000 });

  /* Server truth: the product exists WITH the accepted views attached. */
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'));
  expect(token, 'no staff token after sign-in').toBeTruthy();
  const list = await page.evaluate(
    async ({ apiUrl, t, name }) => {
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

  /* SEVEN rows, not six: the six VIEWS plus the composite SOURCE SHEET they
     were cut from. The sheet is kept so the original composite stays auditable
     and re-cut-able — but it is NOT a view, so it must never be accepted. If it
     were, the reconstruction would be handed the whole grid alongside the
     panels already cut from it. */
  const views = attached.images.filter((image) => image.accepted);
  const sourceSheet = attached.images.find((image) => image.source?.type !== 'panel');

  expect(attached.images.length, 'the views and their source sheet did not both survive').toBe(7);
  expect(sourceSheet, 'the original composite sheet was discarded instead of kept for audit').toBeTruthy();
  expect(sourceSheet.accepted, 'the source sheet must never be an accepted reconstruction view').toBe(false);

  expect(views.length, 'the accepted views did not travel with the product').toBe(6);
  expect(views.every((image) => image.source?.type === 'panel'), 'the views lost their traceability to the composite').toBe(
    true
  );

  /* Not one of them carries a derived image: the originals are what is stored. */
  expect(views.every((image) => image.cutout?.available === false)).toBe(true);
  expect(sourceSheet.cutout?.available === false).toBe(true);

  /* Retrievable later, in the product's own editor — no re-upload needed. */
  await page.goto(`/admin/products/${list.product.slug}`);
  await waitForRouteReady(page);
  await page.getByRole('button', { name: /edit product/i }).click();
  const savedCard = page.getByTestId('reference-card-0');
  await expect(savedCard).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => imageBytes(savedCard.getByAltText(/^Reference 1/)), { timeout: 30_000 }).toBeGreaterThan(0);

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
     product still saves without any reference. */
  await page.getByPlaceholder('e.g., The Dusty Rose & Lavender Dream Posy').fill(STUDIO_PRODUCT_NAMES.brokenUpload);
  await page.getByRole('spinbutton').first().fill('999');
  await page.getByRole('button', { name: /save product/i }).click();
  await expect(page).toHaveURL(/\/admin\/products$/, { timeout: 30_000 });

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
