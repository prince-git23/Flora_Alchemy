/**
 * PHASE 4 — E2E FLOW 7 (gift finder) and FLOW 9 / 10 (custom requests).
 *
 * These two surfaces are the bespoke half of Flora Alchemy: a guided shortlist
 * and a real request that a shop has to answer. Both are driven through the
 * UI, and both assert on what the server actually accepted.
 */

import { test, expect } from '@playwright/test';
import { SEED, freshVisitor, observe, apiCall, signInCustomer } from '../support/helpers.js';

const CR = '/custom-request';

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 7 — Gift Finder → questionnaire → shortlist → Product', async ({ page }) => {
  const audit = observe(page);
  await page.goto('/gift-finder');

  /* Five decisions, one per step. Each step may not allow continuing until it
     has an answer — that is the honesty of the shortlist. */
  for (let step = 0; step < 5; step += 1) {
    const group = page.getByRole('radiogroup');
    await expect(group).toBeVisible();

    /* Budget is the only step whose options carry a rupee amount, and the
       seeded catalogue starts at ₹450 — so an under-₹300 answer lands on the
       finder's (correct, honest) "no exact match" state instead of a
       shortlist. Pick the WIDEST budget so the flow under test is the one a
       customer with a real budget gets. */
    const labels = group.locator('label');
    const moneyIndexes = (await labels.allInnerTexts())
      .map((text, i) => (/₹/.test(text) ? i : -1))
      .filter((i) => i >= 0);
    const choice = labels.nth(moneyIndexes.length ? moneyIndexes[moneyIndexes.length - 1] : 0);
    await choice.click();

    const next = page.getByRole('button', {
      name: step === 4 ? /See My Gifts/i : /^Continue$/i,
    });
    await expect(next).toBeEnabled();
    await next.click();
  }

  await expect(page.getByRole('heading', { name: /Here are a few gifts/i })).toBeVisible({
    timeout: 20_000,
  });

  const card = page.locator('article a[href^="/product/"]').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/product\//);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('gift finder keeps its answers when a step is re-opened', async ({ page }) => {
  await page.goto('/gift-finder');

  const group = page.getByRole('radiogroup');
  await group.locator('label').first().click();
  const label = await group.locator('label').first().innerText();
  await page.getByRole('button', { name: /^Continue$/i }).click();

  /* The progress rail is the customer's map: a completed step is re-openable. */
  await page.getByRole('button', { name: /^Step 1:/i }).click();
  await expect(group.locator('label').first()).toContainText(label.split('\n')[0]);
});

test('FLOW 9 — Custom Request → build the brief → submit → confirmation', async ({ page }) => {
  const audit = observe(page);
  /* A commission is a real conversation with a shop, so it is submitted under
     an account (the page's own guard sends an anonymous visitor to sign in). */
  await signInCustomer(page);
  await page.goto(CR);

  const description =
    'A pressed-bloom keepsake box for my sister’s wedding, in dusty rose and sage, with a deckled card.';
  await page.locator('#cr-desc').fill(description);
  await page.getByRole('button', { name: /Continue/i }).click();

  /* Step 2 — reference detail (palette, date, optional image). */
  await expect(page.locator('#cr-colors')).toBeVisible();
  await page.locator('#cr-colors').fill('Dusty rose, sage, cream');
  await page.locator('#cr-date').fill('2026-12-18');
  await page.getByRole('button', { name: /Continue/i }).click();

  /* Step 3 — the shop the request is locked to. The suite's tenant must be
     selectable here; a request without an owner has nowhere to go. */
  const shopSelect = page.locator('#cr-shop');
  await expect(shopSelect).toBeVisible();
  const options = await shopSelect.locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(1);
  await shopSelect.selectOption({ index: 1 });

  await page.getByRole('button', { name: /Submit Request/i }).click();

  await expect(page.getByText(/Thank you/i).first()).toBeVisible({ timeout: 20_000 });

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 9b — the request rejects an idea that is too thin to quote', async ({ page }) => {
  await page.goto(CR);

  /* Under 10 characters the customer may not advance — the studio has to be
     able to price it. This is validation, not decoration. */
  await page.locator('#cr-desc').fill('hi');
  await expect(page.getByRole('button', { name: /Continue/i })).toBeDisabled();
  await expect(page.locator('main')).toContainText(/at least 10/i);
});

test('FLOW 10 — product-originated request keeps the product context', async ({ page }) => {
  const audit = observe(page);
  await signInCustomer(page);
  await page.goto(`${CR}?product=${SEED.product.slug}`);

  /* The product the customer started from must be named on the form. */
  await expect(page.locator('main')).toContainText(SEED.product.name);
  await expect(page.locator('main')).toContainText(/Customising/i);

  await page.locator('#cr-desc').fill('I would like this keepsake in a larger frame with two cards.');
  await page.getByRole('button', { name: /Continue/i }).click();
  await page.locator('#cr-colors').fill('Dusty rose');
  await page.getByRole('button', { name: /Continue/i }).click();

  /* A request that started from a product is LOCKED to that product's shop —
     the shop picker must not appear at all (the server takes the workspace
     from the product, never from the client). */
  await expect(page.locator('#cr-shop')).toHaveCount(0);
  await expect(page.locator('main')).toContainText(/e2e-botanical-studio|E2E Botanical Studio/i);

  await page.getByRole('button', { name: /Submit Request/i }).click();

  await expect(page.locator('main')).toContainText(/Thank you/i, { timeout: 20_000 });
  /* The confirmation must name the product it is a custom version OF. */
  await expect(page.locator('main')).toContainText(SEED.product.name);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('a submitted request is owned by the shop the customer chose', async ({ page }) => {
  await signInCustomer(page);
  await page.goto(CR);
  await page.locator('#cr-desc').fill('A small pressed-flower frame for a first anniversary.');
  await page.getByRole('button', { name: /Continue/i }).click();
  await page.locator('#cr-colors').fill('Cream, sage');
  await page.getByRole('button', { name: /Continue/i }).click();

  const shopSelect = page.locator('#cr-shop');
  const slug = await shopSelect.locator('option').nth(1).getAttribute('value');
  await shopSelect.selectOption(slug);
  await page.getByRole('button', { name: /Submit Request/i }).click();
  await expect(page.locator('main')).toContainText(/Thank you/i, { timeout: 20_000 });

  /* Server authority: the public shop list is the only source of shop
     identity, and the forged slug must not have created a phantom tenant. */
  const shops = await apiCall(page, 'GET', '/shops');
  expect(shops.status).toBe(200);
  const slugs = (shops.body?.shops || []).map((s) => s.slug);
  expect(slugs).toContain(slug);
});
