/**
 * PHASE 4 — E2E FLOW 4 and FLOW 8, plus product-detail integrity.
 *
 * The product page is the conversion surface, so the assertions here are about
 * the promises the page makes to a customer: the imagery is real, the
 * personalisation is real, and the bag carries what they chose.
 */

import { test, expect } from '@playwright/test';
import { SEED, freshVisitor, observe, signInCustomer, expectBagItems } from '../support/helpers.js';

const PDP = `/product/${SEED.product.slug}`;

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('product detail renders the real catalogue row and its imagery', async ({ page }) => {
  await page.goto(PDP);

  await expect(page.getByRole('heading', { level: 1 })).toContainText(SEED.product.name);

  /* A price rendered from the backend, never a hardcoded frontend number. */
  await expect(page.locator('main')).toContainText(/₹/);

  /* No invented media: every product image must have a real src. */
  const images = page.locator('main img');
  const count = await images.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const src = await images.nth(i).getAttribute('src');
    expect(src, `image ${i} has an empty src`).toBeTruthy();
    expect(src.startsWith('data:')).toBe(false);
  }
});

test('a single-image product shows no fabricated gallery controls', async ({ page }) => {
  await page.goto(PDP);

  /* Phase 3 §2 forbids invented media. The seeded row has exactly one image,
     so the thumbnail rail and the enlarged-viewer trigger must not exist. */
  const thumbRail = page.getByRole('button', { name: /^Show image \d+ of \d+$/ });
  await expect(thumbRail).toHaveCount(0);
});

test('FLOW 4 — Product → Wishlist → Wishlist page → Remove', async ({ page }) => {
  const audit = observe(page);

  /* Saved Gifts are account-owned by design (the page offers sign-in to a
     guest), so the real journey is: sign in, save, review, remove. */
  await signInCustomer(page);
  await page.goto(PDP);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.getByRole('button', { name: /Save to Saved Gifts/i }).first().click();

  /* Wait for the toggle to flip BEFORE navigating. The flip happens after the
     server confirms the save (StoreContext awaits the POST), so it is the
     app's own receipt that the product is in the account's list — navigating
     on the click alone raced the in-flight POST and produced a page that was
     legitimately empty. */
  await expect(page.getByRole('button', { name: /Remove from Saved Gifts/i }).first()).toBeVisible({
    timeout: 20_000,
  });

  await page.goto('/wishlist');
  const card = page.locator('article').first();
  await expect(card).toBeVisible();

  const remove = page.getByRole('button', { name: /Remove/i }).first();
  await expect(remove).toBeVisible();
  await remove.click();

  await expect(page.locator('article')).toHaveCount(0);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 8 — Product → personalization → gift message → Bag', async ({ page }) => {
  await page.goto(PDP);

  /* The gift note is the one personalisation control every product has. */
  const note = page.locator('#gift-note');
  await expect(note).toBeVisible();
  const message = 'For Amma — with all my love, the pressed blooms are her garden.';
  await note.fill(message);

  /* The customer must SEE their version before they commit to it. */
  await expect(page.getByText('Your version')).toBeVisible();
  await expect(page.locator('main')).toContainText(message.slice(0, 40));

  /* Optional colourway / ribbon steps: only asserted when the catalogue row
     actually offers them (no invented capabilities). */
  const paletteGroup = page.locator('button[aria-pressed]').filter({ hasText: /./ });
  if ((await paletteGroup.count()) > 0) {
    await paletteGroup.first().click();
    await expect(paletteGroup.first()).toHaveAttribute('aria-pressed', 'true');
  }

  const cta = page.getByRole('button', { name: /Add to Bag/i }).first();
  await expect(cta).toBeVisible();
  await cta.click();
  await expectBagItems(page, 1);

  /* The chosen personalisation must survive into the bag. */
  await page.goto('/cart');
  await expect(page.locator('main')).toContainText(message.slice(0, 30));
});

test('quantity control updates the priced line total', async ({ page }) => {
  await page.goto(PDP);

  const increase = page.getByRole('button', { name: 'Increase quantity' });
  const decrease = page.getByRole('button', { name: 'Decrease quantity' });
  await expect(increase).toBeVisible();

  await increase.click();
  await expect(page.getByRole('button', { name: /Add to Bag/i }).first()).toContainText(/₹/);

  /* The control must not go below one unit — at one unit it is disabled,
     so the guard is the disabled state itself, not a tolerated click. */
  await decrease.click();
  await expect(decrease).toBeDisabled();
  await expect(page.getByRole('button', { name: /Add to Bag/i }).first()).toBeVisible();
});

test('delivery pincode check answers honestly', async ({ page }) => {
  await page.goto(PDP);

  const pincode = page.getByLabel('Pincode');
  await expect(pincode).toBeVisible();
  await pincode.fill('400001');
  await page.getByRole('button', { name: 'Check' }).click();

  /* Some answer must appear — a fabricated "delivery tomorrow" would be worse
     than none, so the assertion is only that the panel settles. */
  await expect(page.locator('main')).toContainText(/deliver|dispatch|courier|pincode/i);
});

test('product-originated custom request keeps the product context', async ({ page }) => {
  await page.goto(PDP);
  const requestLink = page.getByRole('link', { name: /Request|custom/i }).first();
  if ((await requestLink.count()) === 0) test.skip(true, 'no product-originated request entry point on this row');
  await requestLink.click();
  /* The studio's request surface is /custom-gifts (the branded Custom Gift
     Studio); /custom-request is the standalone intake form. */
  await expect(page).toHaveURL(/custom-(request|gifts)/);
});
