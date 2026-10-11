/**
 * PHASE 4 — E2E FLOW 1, 2, 3, 6.
 *
 * Discovery → desire → bag. Every assertion is made against the real seeded
 * catalogue served by the isolated backend; nothing is stubbed, so a pass
 * means the deployed application actually works.
 */

import { test, expect } from '@playwright/test';
import {
  SEED,
  freshVisitor,
  observe,
  addSeededProductToBag,
  expectBagItems,
} from '../support/helpers.js';

/** The tenant the E2E stack provisions (see e2e/stack.mjs). */
const SHOP_SLUG = 'e2e-botanical-studio';

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 1 — Home → Shop → Product → Add to Bag', async ({ page }) => {
  const audit = observe(page);

  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  /* The storefront only counts as loaded when its own hero copy is on screen. */
  await expect(page.getByRole('link', { name: /Explore the Catalogue/i })).toBeVisible();

  await page.getByRole('link', { name: /Explore the Catalogue/i }).click();
  await expect(page).toHaveURL(/\/shop/);

  const firstCard = page.locator('article a[href^="/product/"]').first();
  await expect(firstCard).toBeVisible();
  await firstCard.click();
  await expect(page).toHaveURL(/\/product\//);

  /* Wait for the real catalogue row — the route alone proves nothing. */
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  const cta = page.getByRole('button', { name: /Add to Bag/i }).first();
  await expect(cta).toBeVisible();
  await cta.click();
  await expectBagItems(page, 1);

  /* The bag is the proof: the app must carry the line through to /cart. */
  await page.goto('/cart');
  await expect(page.locator('[data-checkout-shop]').first()).toBeVisible();

  const { pageErrors, consoleErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 2 — Shop → filter → sort → Product', async ({ page }) => {
  await page.goto('/shop');
  await expect(page.locator('article a[href^="/product/"]').first()).toBeVisible();

  const before = await page.locator('article a[href^="/product/"]').count();
  expect(before).toBeGreaterThan(0);

  /* Category filter: the chips are a labelled group with a pressed state. */
  const group = page.getByRole('group', { name: 'Filter by category' });
  await expect(group).toBeVisible();
  const chips = group.getByRole('button');
  const chipCount = await chips.count();
  expect(chipCount).toBeGreaterThan(1);
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');

  /* Sorting is a native select — keyboard/SR accessible by construction. */
  const sort = page.getByLabel('Sort products');
  await expect(sort).toBeVisible();
  const values = await sort.locator('option').evaluateAll((opts) => opts.map((o) => o.value));
  expect(values.length).toBeGreaterThan(1);
  await sort.selectOption(values[1]);

  const after = page.locator('article a[href^="/product/"]');
  await expect(after.first()).toBeVisible();
  await after.first().click();
  await expect(page).toHaveURL(/\/product\//);
  await expect(page.getByRole('button', { name: /Add to Bag|Out of Stock/i }).first()).toBeVisible();
});

test('FLOW 2b (PHASE 6) — the catalogue you come back to is the one you left', async ({ page }) => {
  await page.goto('/shop');
  const cards = page.locator('article a[href^="/product/"]');
  await expect(cards.first()).toBeVisible();

  /* ── 1. The place on the page — scrolled with REAL wheel input, which is both
     the movement a customer makes and the input the app tracks its position
     from (a programmatic jump can outrun the browser's own scroll event, so
     it would measure the harness rather than the behaviour). */
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(400);

  const reading = await page.evaluate(() => {
    const vh = window.innerHeight;
    const link = [...document.querySelectorAll('article a[href^="/product/"]')]
      .find((a) => {
        const r = a.getBoundingClientRect();
        return r.top > 60 && r.bottom < vh - 60;
      });
    if (!link) return null;
    const r = link.getBoundingClientRect();
    return {
      y: Math.round(window.scrollY),
      x: Math.round(r.left + r.width / 2),
      pointY: Math.round(r.top + r.height / 2),
    };
  });
  expect(reading, 'no product card was in view after scrolling').not.toBeNull();
  expect(reading.y, 'the catalogue is too short to prove scroll restoration').toBeGreaterThan(200);

  /* Clicked at the measured point: a locator click would first scroll a
     partially hidden card into view, and the page would then be left from a
     different position than the one recorded here. */
  await page.mouse.click(reading.x, reading.pointY);
  await expect(page).toHaveURL(/\/product\//);

  await page.goBack();

  await expect(page).toHaveURL(/\/shop/);
  await expect
    .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - reading.y) <= 80, {
      message: 'Back did not restore the reading position',
    })
    .toBe(true);

  /* ── 2. The query and the order. A term taken from a REAL seeded product
     name, so the search matches by construction instead of guessing what the
     catalogue holds. */
  const term = (await page.locator('article h3').first().innerText()).trim().split(/\s+/)[0];
  await page.getByLabel('Search gifts').fill(term);
  await page.getByLabel('Sort products').selectOption('price-asc');

  /* The whole query now lives in the address bar — which is exactly what lets
     Back return to it, rather than to a bare /shop. */
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(term);
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('price-asc');

  await cards.first().click();
  await expect(page).toHaveURL(/\/product\//);

  await page.goBack();

  /* Same catalogue, same result set, same order. */
  await expect(page).toHaveURL(/\/shop/);
  await expect(page.getByLabel('Search gifts')).toHaveValue(term);
  await expect(page.getByLabel('Sort products')).toHaveValue('price-asc');

  /* And the chrome still means what it says: a link to the bare catalogue opens
     the UNFILTERED catalogue instead of leaving a filtered grid under an
     empty URL. (The footer link, because the navbar's lives in a menu.) */
  await page.locator('footer').getByRole('link', { name: 'All Gifts', exact: true }).first().click();
  await expect(page.getByLabel('Search gifts')).toHaveValue('');
  await expect(page.getByLabel('Sort products')).toHaveValue('featured');
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

test('FLOW 3 — Search → Product → Bag', async ({ page }) => {
  await page.goto('/search?q=rose');

  const input = page.getByLabel('Search the catalogue');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('rose');

  const results = page.locator('article');
  await expect(results.first()).toBeVisible({ timeout: 20_000 });

  /* Every rendered result must be a real catalogue row, not a fabricated card. */
  const link = results.first().locator('a[href^="/product/"]').first();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/product\/.+/);

  await link.click();
  await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await page.getByRole('button', { name: /Add to Bag/i }).first().click();
  await expectBagItems(page, 1);
  await page.goto('/cart');
  await expect(page.locator('[data-checkout-shop]').first()).toBeVisible();
  await expect(page.locator('main')).toContainText(/₹/);
});

test('FLOW 6 — Collections → Product', async ({ page }) => {
  await page.goto('/collections');

  /* Collections are an editorial index: entries must link somewhere real. */
  const entry = page.locator('a[href^="/shop"], a[href^="/collections/"]').first();
  await expect(entry).toBeVisible();
  const href = await entry.getAttribute('href');

  await entry.click();
  await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const card = page.locator('article a[href^="/product/"]').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/product\//);
});

test('FLOW 5 — public shop address renders the real shop and its catalogue', async ({ page }) => {
  const audit = observe(page);

  /* The ACTIVE tenant created by the E2E stack, reached by its public address. */
  await page.goto(`/shops/${SHOP_SLUG}`);
  await expect(page.locator('article a[href^="/product/"]').first()).toBeVisible({ timeout: 20_000 });

  /* Attribution must name the shop without leaking its internal ids. */
  const body = await page.locator('body').innerText();
  expect(body).toMatch(/E2E Botanical Studio/i);
  expect(body).not.toMatch(/[0-9a-f]{24}/, 'a raw ObjectId leaked into the storefront');
  expect(body).not.toMatch(/workspaceId/i);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 5b — an unknown workspace slug collapses to the storefront 404', async ({ page }) => {
  /* The gate may not leak whether a slug merely exists, so the answer is the
     storefront's own indistinguishable 404. */
  await page.goto('/shops/this-workspace-does-not-exist-phase4');
  await expect(page.getByText(/Page Not Found/i).first()).toBeVisible({ timeout: 20_000 });
});

test('the product page carries real shop attribution', async ({ page }) => {
  await page.goto(`/product/${SEED.product.slug}`);
  /* Read the page only once the catalogue row has actually rendered. */
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const body = await page.locator('body').innerText();
  expect(body).toMatch(/E2E Botanical Studio/i);
  expect(body).not.toMatch(/[0-9a-f]{24}/, 'a raw ObjectId leaked onto the product page');
});

test('quick-add from a catalogue card reaches the bag', async ({ page }) => {
  await page.goto('/shop');
  const quickAdd = page.getByRole('button', { name: /Add .* to bag/i }).first();
  await expect(quickAdd).toBeVisible();
  await quickAdd.click();
  await expectBagItems(page, 1);
  await page.goto('/cart');
  await expect(page.locator('[data-checkout-shop]').first()).toBeVisible();
});

test('seeded product detail is reachable directly by slug', async ({ page }) => {
  await addSeededProductToBag(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(SEED.product.name);
  await expectBagItems(page, 1);
});
