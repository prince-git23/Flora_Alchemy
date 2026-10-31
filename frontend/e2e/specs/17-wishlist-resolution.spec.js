/**
 * WISHLIST RESOLUTION — E2E regression for the CI failure that rendered a SAVED,
 * AVAILABLE product as "This creation was retired from the collection."
 *
 * WHY THIS SPEC EXISTS
 * --------------------
 * FLOW 4 failed in CI with `locator('article').first()` not found, while the
 * network trace showed the opposite of a backend problem: `GET /api/products`
 * returned the product, `POST /api/wishlist/<slug>` returned it with
 * `unavailableIds: []`, and `GET /api/wishlist` returned it again. The product
 * was saved and live — and the page still classified it as retired.
 *
 * The cause was frontend-only: `resolveWishlist(ids)` looked the saved ids up in
 * the LOCAL CATALOGUE only, so a catalogue read that had not hydrated (or a
 * slice this page never fetched) turned a live product into a false retirement
 * notice. The fix makes the SERVER's wishlist projection authoritative and the
 * local catalogue a fallback, and adds a stale-response guard so a slow GET
 * cannot undo a newer mutation.
 *
 * WHAT THIS COVERS
 * ----------------
 * FLOW 59 — with the catalogue deliberately EMPTY, a saved product still renders
 *           from the server projection, and Remove still reaches the backend.
 * FLOW 60 — a product that is genuinely deleted is reported as retired BY THE
 *           SERVER, even though the browser's catalogue cache still holds it.
 * FLOW 61 — the shipped resolution rule and stale guard, exercised directly:
 *           saved order, server-first, retirement authority, cache-miss is not
 *           retirement, and a superseded response may not commit.
 *
 * It never mocks the wishlist API: every request goes to the real isolated
 * backend. Only the CATALOGUE read is intercepted in FLOW 59 — that is the bug's
 * precondition, not a substitute for it.
 */

import { test, expect } from '@playwright/test';
import { SEED, freshVisitor, observe, signInAdmin, signInCustomer } from '../support/helpers.js';
import { resolveWishlistRows, createWishlistRequestGuard } from '../../src/services/wishlistResolution.js';

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000/api';
const CUSTOMER_TOKEN = 'flora_alchemy_customer_token';
const ADMIN_TOKEN = 'flora_alchemy_admin_token';
const PDP = `/product/${SEED.product.slug}`;

/** Call the real API from the page context with the stored session for that scope. */
async function call(page, tokenKey, method, path, body = null) {
  const token = await page.evaluate((key) => window.localStorage.getItem(key), tokenKey);
  expect(token, `no session token at ${tokenKey}`).toBeTruthy();
  return page.evaluate(
    async ({ apiUrl, method: m, path: p, t, body: b }) => {
      const r = await fetch(`${apiUrl}${p}`, {
        method: m,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        ...(b ? { body: JSON.stringify(b) } : {}),
      });
      const payload = await r.json().catch(() => null);
      return { status: r.status, body: payload };
    },
    { apiUrl: API, method, path, t: token, body }
  );
}

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 59 — a saved product renders from the SERVER projection even when the catalogue is empty', async ({
  page,
}) => {
  const audit = observe(page);

  await signInCustomer(page);
  await page.goto(PDP);
  await page.getByRole('button', { name: /Save to Saved Gifts/i }).first().click();
  /* The flip is the app's own receipt that the POST committed. */
  await expect(page.getByRole('button', { name: /Remove from Saved Gifts/i }).first()).toBeVisible({
    timeout: 20_000,
  });

  /* THE PRECONDITION OF THE CI BUG: the catalogue this page hydrates carries no
     product at all. A cache miss is not evidence that a product was retired. */
  await page.route('**/api/products**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, products: [] }),
    })
  );

  await page.goto('/wishlist');

  const card = page.locator('article').first();
  await expect(card, 'a saved, live product was rendered as unavailable').toBeVisible();
  await expect(card).toContainText(SEED.product.name);

  /* The false-retirement copy must not appear at all. */
  await expect(page.getByText(/No longer available/i)).toHaveCount(0);
  await expect(page.getByText(/retired from the collection/i)).toHaveCount(0);

  /* Remove works from the server-projected card and is persisted. */
  await card.getByRole('button', { name: /Remove/i }).first().click();
  await expect(page.locator('article')).toHaveCount(0);

  const after = await call(page, CUSTOMER_TOKEN, 'GET', '/wishlist');
  expect(after.status).toBe(200);
  expect(after.body?.wishlist?.productIds || [], 'the removal did not reach the backend').toEqual([]);
  expect(after.body?.wishlist?.unavailableIds || []).toEqual([]);

  await page.unroute('**/api/products**');

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 60 — a genuinely deleted product is retired by the SERVER, not by a cache miss', async ({ page }) => {
  const audit = observe(page);

  /* An admin creates a throwaway piece; the customer saves it; the admin deletes
     it. Nothing here touches a seeded product, and the probe is removed even if
     an assertion fails. */
  await signInAdmin(page);
  const stamp = Date.now();
  const created = await call(page, ADMIN_TOKEN, 'POST', '/products', {
    name: `E2E Wishlist Retirement Probe ${stamp}`,
    price: 499,
    stockTracked: false,
  });
  expect(created.status, JSON.stringify(created.body).slice(0, 200)).toBe(201);
  const probeSlug = created.body?.product?.slug;
  expect(probeSlug).toBeTruthy();

  try {
    await signInCustomer(page);
    const saved = await call(page, CUSTOMER_TOKEN, 'POST', `/wishlist/${encodeURIComponent(probeSlug)}`);
    expect(saved.status).toBe(200);

    /* First pass: it is LIVE, and it renders as a product card. This also puts
       the probe into the browser's catalogue cache — which is what makes the
       second pass a real test of the retirement authority. */
    await page.goto('/wishlist');
    await expect(page.locator('article').first()).toContainText(`Retirement Probe ${stamp}`);
    await expect(page.getByText(/No longer available/i)).toHaveCount(0);

    /* Now retire it for real. */
    const deleted = await call(page, ADMIN_TOKEN, 'DELETE', `/products/${encodeURIComponent(probeSlug)}`);
    expect([200, 204]).toContain(deleted.status);

    await page.goto('/wishlist');

    /* The cache still holds the product; the SERVER says it is gone. The server
       wins, the card disappears, and the customer can clear the entry. */
    await expect(page.getByText(/No longer available/i).first()).toBeVisible();
    await expect(page.getByText(/retired from the collection/i).first()).toBeVisible();
    await expect(page.locator('article')).toHaveCount(0);

    await page.getByRole('button', { name: /Remove/i }).first().click();

    /* The receipt is the UI: the retired card only disappears after the server
       confirms the removal. Reading the API straight after `.click()` raced the
       in-flight DELETE — a click resolving is not a request completing. */
    await expect(page.locator('[data-wishlist-card]')).toHaveCount(0);

    const cleared = await call(page, CUSTOMER_TOKEN, 'GET', '/wishlist');
    expect(cleared.body?.wishlist?.productIds || []).toEqual([]);
    expect(cleared.body?.wishlist?.unavailableIds || []).toEqual([]);
  } finally {
    /* Best effort: the product is already gone when the test passed. */
    await call(page, ADMIN_TOKEN, 'DELETE', `/products/${encodeURIComponent(probeSlug)}`).catch(() => {});
  }

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 61 — the shipped resolution rule and stale guard', async () => {
  /* The rule itself, exercised on the module the provider actually imports —
     no React, no DOM, so it can be asserted directly. */

  /* 1. Saved ORDER is preserved, and a server row is enough on its own. */
  const ordered = resolveWishlistRows({
    productIds: ['b', 'a'],
    products: [
      { slug: 'a', name: 'A' },
      { slug: 'b', name: 'B' },
    ],
    catalog: [],
  });
  expect(ordered.rows.map((row) => row.id)).toEqual(['b', 'a']);
  expect(ordered.rows.every((row) => row.from === 'server')).toBe(true);
  expect(ordered.unavailable).toEqual([]);

  /* 2. The SERVER's retirement beats a catalogue row that still exists. */
  const retired = resolveWishlistRows({
    productIds: ['a'],
    products: [{ slug: 'a', name: 'A' }],
    unavailableIds: ['a'],
    catalog: [{ id: 'a', name: 'A' }],
  });
  expect(retired.rows).toEqual([]);
  expect(retired.unavailable).toEqual(['a']);

  /* 3. A genuine miss in BOTH sources is still reported, so it stays removable. */
  const missing = resolveWishlistRows({ productIds: ['gone'], products: [], catalog: [] });
  expect(missing.unavailable).toEqual(['gone']);

  /* 4. An older response shape (no products) still falls back to the catalogue. */
  const fallback = resolveWishlistRows({ productIds: ['a'], products: [], catalog: [{ id: 'a', name: 'A' }] });
  expect(fallback.rows).toHaveLength(1);
  expect(fallback.rows[0]).toMatchObject({ id: 'a', from: 'catalog' });
  expect(fallback.unavailable).toEqual([]);

  /* 5. A retired id the server reported outside `productIds` is not lost. */
  const orphan = resolveWishlistRows({ productIds: [], unavailableIds: ['old'] });
  expect(orphan.unavailable).toEqual(['old']);

  /* 6. STALE-RESPONSE GUARD: a delayed response that a newer call superseded may
     not commit. This is the mechanism that keeps a slow GET from undoing a
     removal that the server already confirmed. */
  const guard = createWishlistRequestGuard();
  const stale = guard.begin(); // e.g. the GET that started on mount
  const fresh = guard.begin(); // e.g. the removal the customer just made
  expect(guard.isCurrent(stale), 'a superseded wishlist response would have overwritten newer state').toBe(false);
  expect(guard.isCurrent(fresh)).toBe(true);
  expect(guard.isCurrent(undefined)).toBe(false);
});
