/**
 * PHASE 4 — E2E FLOW 19, 20, 21, 22: customer reviews and moderation.
 *
 * Reviews are the trust layer, so the whole chain is exercised in one place:
 * a real customer with a real delivered order shares a real photo, the public
 * page shows it, staff hide it, the public page loses it, staff restore it,
 * and the public page gets it back. Moderation is driven through the real
 * admin API with a real admin token — the browser is only the observer, which
 * is exactly the property being verified (server authority).
 */

import { test, expect } from '@playwright/test';
import {
  SEED,
  freshVisitor,
  observe,
  signInCustomer,
  apiCall,
} from '../support/helpers.js';

const PDP = `/product/${SEED.product.slug}`;

/* A 1×1 PNG — a genuinely valid image, so nothing about the test depends on a
   lenient validator. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

const REVIEW_TEXT = 'The pressed blooms arrived exactly as promised, and the card was hand-inscribed.';

async function adminToken(page) {
  const res = await page.evaluate(
    async ({ apiUrl, email, password }) => {
      const r = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, portal: 'admin' }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { apiUrl: process.env.E2E_API_URL || 'http://127.0.0.1:4000/api', ...SEED.admin }
  );
  expect(res.status, `admin sign-in failed: ${JSON.stringify(res.body)}`).toBe(200);
  const token = res.body?.token || res.body?.adminToken;
  expect(token, 'admin sign-in returned no token').toBeTruthy();
  return token;
}

async function findReview(page, token, needle) {
  const list = await apiCall(page, 'GET', '/admin/reviews?tab=published', { token });
  expect(list.status).toBe(200);
  const rows = list.body?.reviews || [];
  return rows.find((r) => String(r.comment || '').includes(needle)) || null;
}

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 19 + 21 — a customer shares a review with a photo and can open the media', async ({ page }) => {
  const audit = observe(page);
  await signInCustomer(page);
  await page.goto(PDP);

  await page.getByRole('button', { name: /Share your experience/i }).click();

  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();

  /* The rating control must expose its meaning, not just its shape. */
  await dialog.getByRole('button', { name: '5 hearts' }).click();
  await expect(dialog.getByRole('button', { name: '5 hearts' })).toHaveAttribute('aria-pressed', 'true');

  await dialog.locator('#review-title').fill('Even lovelier in person');
  await dialog.locator('#review-comment').fill(REVIEW_TEXT);
  await dialog.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'keepsake.png',
    mimeType: 'image/png',
    buffer: PNG,
  });

  await dialog.locator('button[type="submit"]').click();
  await expect(page.getByRole('dialog', { name: /Review shared/i })).toBeVisible({ timeout: 30_000 });

  /* Reload as a VISITOR: the review must be public without any moderator. */
  await page.goto(PDP);
  await expect(page.locator('main')).toContainText(REVIEW_TEXT, { timeout: 20_000 });

  /* FLOW 21 — the media viewer. */
  const media = page.getByRole('button', { name: /Open customer photo/i }).first();
  await expect(media).toBeVisible();
  await media.click();

  const viewer = page.getByRole('button', { name: 'Close media viewer' });
  await expect(viewer).toBeVisible();

  /* Escape closes it and focus returns to the control that opened it. */
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  const returned = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
  expect(returned, 'focus did not return to the media trigger').toMatch(/Open customer photo/i);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 20 — the video path is offered with the formats the studio accepts', async ({ page }) => {
  await signInCustomer(page);
  await page.goto(PDP);
  await page.getByRole('button', { name: /Share your experience/i }).click();

  const dialog = page.locator('[role="dialog"]');
  const video = dialog.locator('input[type="file"][accept*="video"]');
  await expect(video).toHaveCount(1);
  const accept = await video.getAttribute('accept');
  /* The advertised formats are the ones the server's own whitelist enforces. */
  expect(accept).toMatch(/video\/mp4/);
  expect(accept).toMatch(/video\/webm/);
  expect(accept).toMatch(/video\/quicktime/);

  /* The documented ceiling is stated to the customer, not hidden until a
     failed upload. */
  await expect(dialog).toContainText(/25(\.0)? MB/);

  /* A format the studio does not publish is refused, and the reason is shown.
     (A file merely DECLARING an accepted MIME type is a different matter: the
     pipeline validates the declared type, which is the documented policy, so
     this asserts the refusal that policy actually produces.) */
  await video.setInputFiles({
    name: 'clip.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from('GIF89a'),
  });
  await expect(dialog).toContainText(/must be MP4, WebM or MOV/i, { timeout: 20_000 });

  /* An oversized clip is refused before a byte leaves the browser. */
  await video.setInputFiles({
    name: 'too-long.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.alloc(26 * 1024 * 1024),
  });
  await expect(dialog).toContainText(/25 MB or smaller/i, { timeout: 20_000 });
});

test('FLOW 22 — hiding a review removes it from the public page, restoring brings it back', async ({ page }) => {
  await signInCustomer(page);
  const customerToken = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));
  const admin = await adminToken(page);

  /* A product this customer has NOT reviewed anywhere else in the suite: the
     review-creation rule is one per (product, customer), so sharing a product
     with another journey would make this journey depend on test order. */
  const submitted = await apiCall(page, 'POST', `/products/${SEED.productAlt.slug}/reviews`, {
    token: customerToken,
    body: { rating: 5, title: 'Moderation target', comment: REVIEW_TEXT },
  });
  expect([200, 201, 409]).toContain(submitted.status);

  const review = await findReview(page, admin, REVIEW_TEXT);
  expect(review, 'the review never reached the moderation ledger').toBeTruthy();
  const reviewId = review.id || review._id;

  await page.goto(`/product/${SEED.productAlt.slug}`);
  await expect(page.locator('main')).toContainText(REVIEW_TEXT, { timeout: 20_000 });

  /* HIDE */
  const hidden = await apiCall(page, 'PATCH', `/admin/reviews/${reviewId}/status`, {
    token: admin,
    body: { status: 'HIDDEN' },
  });
  expect([200, 201]).toContain(hidden.status);

  await page.goto(`/product/${SEED.productAlt.slug}`);
  await expect(page.locator('main')).not.toContainText(REVIEW_TEXT, { timeout: 20_000 });

  /* RESTORE */
  const restored = await apiCall(page, 'PATCH', `/admin/reviews/${reviewId}/status`, {
    token: admin,
    body: { status: 'PUBLISHED' },
  });
  expect([200, 201]).toContain(restored.status);

  await page.goto(`/product/${SEED.productAlt.slug}`);
  await expect(page.locator('main')).toContainText(REVIEW_TEXT, { timeout: 20_000 });
});

test('§34 — moderation refuses an invalid status, an unknown id and a customer token', async ({ page }) => {
  await signInCustomer(page);
  const customerToken = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));
  const admin = await adminToken(page);

  /* An invalid status is rejected by the server, not normalised by it. */
  const bad = await apiCall(page, 'PATCH', '/admin/reviews/000000000000000000000000/status', {
    token: admin,
    body: { status: 'ABSOLUTELY_NOT_A_STATUS' },
  });
  expect(bad.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(bad.body || {})).not.toMatch(/success":true/);

  /* An unknown review id is a 404. */
  const missing = await apiCall(page, 'PATCH', '/admin/reviews/000000000000000000000000/status', {
    token: admin,
    body: { status: 'HIDDEN' },
  });
  expect(missing.status).toBe(404);

  /* A customer token cannot moderate anything. */
  const refused = await apiCall(page, 'PATCH', '/admin/reviews/000000000000000000000000/status', {
    token: customerToken,
    body: { status: 'HIDDEN' },
  });
  expect([401, 403]).toContain(refused.status);

  const ledger = await apiCall(page, 'GET', '/admin/reviews', { token: customerToken });
  expect([401, 403]).toContain(ledger.status);
});

test('§38 — the verified badge is derived from the customer’s own orders, never asserted', async ({ page }) => {
  await signInCustomer(page);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));

  /* REVIEWS ARE OPEN, THE BADGE IS NOT. Any signed-in customer may write about
     any published product, but `verified` is computed from THEIR OWN order
     history — so the forged claim below must come back false. (Claiming to have
     bought something is a lie the page would print next to a customer's name,
     which is exactly why it is server-derived.) */
  const forgedTitle = 'Forged purchase claim';
  const forged = await apiCall(page, 'POST', '/products/heirloom-keepsake-hamper/reviews', {
    token,
    body: {
      rating: 5,
      title: forgedTitle,
      comment: 'I never bought this but say I did.',
      verified: true,
      status: 'PUBLISHED',
      customerId: '000000000000000000000000',
    },
  });
  /* 409 = this customer already shared one for this product in an earlier run,
     which is itself the duplicate rule being enforced server-side. */
  expect([200, 201, 409]).toContain(forged.status);
  if (forged.status === 200 || forged.status === 201) {
    expect(forged.body?.review?.verified, 'a forged verified flag was honoured').toBe(false);
  }

  /* The SAME derived field on the product this customer really did buy (their
     delivered fixture order contains it) must come back true — so the false
     above is about the purchase, not about a field that is never set.
     The duplicate rule is one review per (product, customer), so the row is
     LOOKED UP rather than re-created: a 409 here is the rule working, and the
     public list is polled because public reads are cached with a short TTL. */
  await apiCall(page, 'POST', `/products/${SEED.product.slug}/reviews`, {
    token,
    body: { rating: 4, title: 'Server authority check', comment: 'A real eligible purchase.', verified: false },
  });

  let mine = null;
  for (let attempt = 0; attempt < 12 && !mine; attempt += 1) {
    const listed = await apiCall(page, 'GET', `/products/${SEED.product.slug}/reviews`);
    expect(listed.status).toBe(200);
    mine =
      (listed.body?.reviews || []).find((r) => /demo customer/i.test(String(r.customerName || ''))) || null;
    if (!mine) await page.waitForTimeout(2_500);
  }
  expect(mine, `no published review by this customer for ${SEED.product.slug}`).toBeTruthy();
  expect(mine.verified, 'a real purchase was not marked verified').toBe(true);

  const forgedPublic = await apiCall(page, 'GET', '/products/heirloom-keepsake-hamper/reviews');
  const forgedRow = (forgedPublic.body?.reviews || []).find((r) => String(r.title) === forgedTitle);
  if (forgedRow) {
    expect(forgedRow.verified, 'the public row claims a purchase that never happened').toBe(false);
  }
});
