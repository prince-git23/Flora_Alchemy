/**
 * PHASE 4 §8, §18, §27, §30, §40 — security gates.
 *
 * Every assertion here is a negative one: something must be REFUSED. They are
 * written against the real HTTP surface from inside a real browser context, so
 * they exercise CORS, the auth middleware and the ownership rules together.
 */

import { test, expect } from '@playwright/test';
import {
  SEED,
  freshVisitor,
  observe,
  signInCustomer,
  apiCall,
} from '../support/helpers.js';

const SHOP = 'e2e-botanical-studio';
const SECOND_SHOP = 'e2e-second-atelier';

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('§18 — a customer cannot read another customer’s order, and is not told it exists', async ({ page }) => {
  /* Anonymous first: no token must mean no access at all. */
  const anon = await apiCall(page, 'GET', '/orders/FA-1024');
  expect([401, 403, 404]).toContain(anon.status);

  await signInCustomer(page);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));

  /* FA-1024 belongs to priya.sharma@example.com, not to the signed-in demo
     customer. A 404 (not a 403) is required so existence is not disclosed. */
  const foreign = await apiCall(page, 'GET', '/orders/FA-1024', { token });
  expect(foreign.status, 'another customer’s order was reachable').toBe(404);

  /* The customer's OWN fixture order is reachable — so the 404 above is about
     ownership, not about the endpoint being broken. */
  const own = await apiCall(page, 'GET', '/orders/FA-E2E-1001', { token });
  expect(own.status).toBe(200);
});

/* REAL staff endpoints, taken from the router mounts — not assumed paths. Each
   one answers 401 to an anonymous caller and 403 to a customer token. */
const STAFF_GET_ENDPOINTS = [
  '/admin/reviews',
  '/admin/users',
  '/orders',
  '/inventory',
  '/analytics',
];

test('§18b — staff endpoints refuse an unauthenticated caller', async ({ page }) => {
  for (const path of STAFF_GET_ENDPOINTS) {
    const res = await apiCall(page, 'GET', path);
    expect([401, 403], `${path} answered ${res.status} without a session`).toContain(res.status);
  }
});

test('a customer token cannot open a staff endpoint', async ({ page }) => {
  await signInCustomer(page);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));

  /* JWT scopes are separate: a customer token is not an administrator token,
     and it must not open ANY of the staff reads. */
  for (const path of STAFF_GET_ENDPOINTS) {
    const res = await apiCall(page, 'GET', path, { token });
    expect([401, 403], `a customer token opened ${path} (${res.status})`).toContain(res.status);
  }
});

test('§8 — shop identity is read from the catalogue, never from the client', async ({ page }) => {
  const shops = await apiCall(page, 'GET', '/shops');
  expect(shops.status).toBe(200);
  const slugs = (shops.body?.shops || []).map((s) => s.slug);
  expect(slugs).toContain(SHOP);
  expect(slugs).toContain(SECOND_SHOP);

  /* The public payload must describe shops without leaking internal handles. */
  expect(JSON.stringify(shops.body)).not.toMatch(/workspaceId|primaryAdminId|isBootstrap/);
  expect(JSON.stringify(shops.body)).not.toMatch(/[0-9a-f]{24}/);
});

test('§8b — a second shop cannot claim the first shop’s catalogue', async ({ page }) => {
  /* The public shop page for tenant B must not render tenant A's products. */
  await page.goto(`/shops/${SECOND_SHOP}`);
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/Dusty Rose & Lavender Dream Posy/i);
});

test('§27 — a missing product answers 404 rather than an empty 200', async ({ page }) => {
  const res = await apiCall(page, 'GET', '/products/this-product-does-not-exist-phase4');
  expect(res.status).toBe(404);
  expect(res.body?.success).not.toBe(true);
});

test('§27b — an unknown storefront URL renders the 404 page, not a blank shell', async ({ page }) => {
  const audit = observe(page);
  await page.goto('/this-route-does-not-exist-phase4');
  await expect(page.getByText(/Page Not Found/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('main')).toBeVisible();
  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('§30 — a full journey stores no credentials in the browser', async ({ page }) => {
  await signInCustomer(page);
  await page.goto('/cart');

  const dump = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      out[k] = window.localStorage.getItem(k);
    }
    return out;
  });

  const serialized = JSON.stringify(dump);

  /* Never a password, never a server secret, never a user-supplied card value. */
  expect(serialized).not.toMatch(/passwordHash/i);
  expect(serialized).not.toMatch(/MONGO_URI|JWT_SECRET|razorpay_key_secret|imagekit_private/i);
  expect(serialized).not.toMatch(/\"password\"\s*:/i);
  expect(serialized).not.toMatch(/cardNumber|cvv/i);

  /* The customer token is expected and is the only credential present. */
  expect(dump.flora_alchemy_customer_token).toBeTruthy();
});

test('§40 — the production bundle exposes no development sign-in shortcut', async ({ page }) => {
  await page.goto('/login');

  /* The demo quick-fill is DEV-gated, so it must be absent from the build the
     customers download — presence here would ship fixtures to production. */
  await expect(page.getByRole('button', { name: /demo|quick fill|fill demo/i })).toHaveCount(0);

  const html = await page.content();
  expect(html).not.toMatch(/demo1234|handler1234/);
});
