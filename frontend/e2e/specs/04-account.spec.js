/**
 * PHASE 4 — E2E FLOW 11 and FLOW 12, plus §28 (session expiration).
 *
 * Sign-in is driven through the real form; the address book is exercised
 * through the same HTTP contract the UI uses, and every write is then
 * confirmed in the rendered page — so a pass means the two halves agree.
 */

import { test, expect } from '@playwright/test';
import {
  SEED,
  freshVisitor,
  observe,
  signInCustomer,
  apiCall,
} from '../support/helpers.js';

const ACCOUNT_ROUTES = ['/account', '/account/orders', '/account/saved', '/account/settings', '/account/requests'];

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 11 — Customer Login → Account', async ({ page }) => {
  const audit = observe(page);
  await signInCustomer(page);

  await expect(page).toHaveURL(/\/account/);
  await expect(page.locator('main')).not.toContainText(/Sign in to continue/i);

  /* The session the server issued is what makes the account view real. */
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));
  expect(token, 'no customer token was stored after a successful sign-in').toBeTruthy();
  expect(token.split('.')).toHaveLength(3);

  const me = await apiCall(page, 'GET', '/auth/me', { token });
  expect(me.status).toBe(200);
  expect(me.body?.user?.email || me.body?.customer?.email || '').toContain(SEED.customer.email);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('a wrong password is refused without signing anyone in', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(SEED.customer.email);
  await page.locator('input[type="password"]').fill('definitely-not-the-password');
  await page.getByRole('button', { name: /Sign In to Account/i }).click();

  await expect(page).toHaveURL(/\/login/);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));
  expect(token).toBeFalsy();
  /* The failure has to be explained, not silent — and announced, so it is
     discoverable by assistive technology rather than only visible. */
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByRole('alert').first()).toContainText(/incorrect|invalid|wrong|password/i);
});

test('§3 — the sign-in form is programmatically labelled for assistive technology', async ({ page }) => {
  await page.goto('/login');

  /* ASSOCIATION, checked through the accessibility tree. Each visible label must
     resolve to exactly ONE control: an unassociated label renders perfectly and
     reads as nothing, which is the failure this asserts against. Both fields are
     checked here because both were unassociated before Phase 4. */
  /* exact: true on purpose — the password field also has a "Show password"
     toggle, and a substring match would count the toggle as a labelled control
     and invent a second association that does not exist. */
  for (const label of ['Email Address', 'Password']) {
    const control = page.getByLabel(label, { exact: true });
    await expect(control, `${label} is not associated with a control`).toHaveCount(1);
    await expect(control).toBeVisible();
  }

  /* The account-creation surface the same form exposes. */
  await page.getByRole('button', { name: /Create Account/i }).click();
  for (const label of ['Full Name', 'Email Address', 'Phone Number', 'Password', 'Confirm Password']) {
    await expect(page.getByLabel(label, { exact: true }), `${label} (register) is not associated`).toHaveCount(1);
  }

  /* And no field on the form is left without an accessible name at all —
     `labels` reflects the real DOM association, not our intentions. */
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll('form input:not([type="hidden"]):not([type="checkbox"]), form select, form textarea')]
      .filter(
        (el) =>
          !(el.labels && el.labels.length > 0) &&
          !el.getAttribute('aria-label') &&
          !el.getAttribute('aria-labelledby')
      )
      .map((el) => el.name || el.id || el.tagName)
  );
  expect(unnamed, `form fields with no accessible name: ${unnamed.join(', ')}`).toEqual([]);
});

test('every account surface renders for a signed-in customer', async ({ page }) => {
  const audit = observe(page);
  await signInCustomer(page);

  for (const route of ACCOUNT_ROUTES) {
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    /* Poll: the route renders its own data before the surface is real, and a
       one-shot read would score the skeleton as an empty page. */
    await expect
      .poll(async () => (await page.locator('main').innerText()).trim().length, {
        message: `${route} rendered an empty page`,
      })
      .toBeGreaterThan(20);
    /* A guard that silently bounces to sign-in is a failure, not a pass. */
    expect(page.url(), `${route} redirected away for a signed-in customer`).not.toContain('/login');
  }

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 12 — address book: add → edit → remove (server-authoritative)', async ({ page }) => {
  await signInCustomer(page);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));

  /* A street this journey alone uses. Checkout legitimately SAVES the address
     it ships to, so a shared street name (or a shared pincode) would make the
     "the old value is gone" assertions below depend on what other journeys
     left in the book. */
  const street = '9 Petal Proof Lane';
  const address = {
    label: 'Studio',
    name: 'Demo Customer',
    address: street,
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400077',
    phone: '+91 98000 00000',
    isDefault: true,
  };

  /* ADD */
  const added = await apiCall(page, 'POST', '/customers/me/addresses', { body: address, token });
  expect([200, 201]).toContain(added.status);
  const created =
    added.body?.address || added.body?.customer?.addresses?.slice(-1)[0] || null;
  expect(created, 'the server did not return the address it stored').toBeTruthy();
  const addressId = created.id || created._id;
  expect(addressId).toBeTruthy();

  /* The rendered account surface must agree with the server. */
  await page.goto('/account/settings');
  await expect(page.locator('main')).toContainText(new RegExp(street), { timeout: 20_000 });

  /* EDIT */
  const edited = await apiCall(page, 'PATCH', `/customers/me/addresses/${addressId}`, {
    body: { ...address, address: '22 Rewritten Rose Road', pincode: '400051' },
    token,
  });
  expect([200, 201]).toContain(edited.status);

  await page.goto('/account/settings');
  await expect(page.locator('main')).toContainText(/22 Rewritten Rose Road/, { timeout: 20_000 });
  await expect(page.locator('main')).not.toContainText(new RegExp(street));

  /* REMOVE */
  const removed = await apiCall(page, 'DELETE', `/customers/me/addresses/${addressId}`, { token });
  expect([200, 204]).toContain(removed.status);

  const list = await apiCall(page, 'GET', '/customers/me/addresses', { token });
  expect(list.status).toBe(200);
  const remaining = list.body?.addresses || list.body?.customer?.addresses || [];
  expect(remaining.some((a) => (a.id || a._id) === addressId)).toBe(false);
});

test('an invalid address is refused with 422 rather than stored', async ({ page }) => {
  await signInCustomer(page);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));

  const bad = await apiCall(page, 'POST', '/customers/me/addresses', {
    body: { address: 'x', city: 'y', state: 'z', pincode: '1' },
    token,
  });
  expect(bad.status).toBe(422);
});

test('FLOW 12b — a customer cannot read another customer’s address book', async ({ page }) => {
  /* No customer route accepts a client-supplied owner id: ownership always
     comes from the token, and a non-owner gets the same answer as a stranger. */
  const anon = await apiCall(page, 'GET', '/customers/me/addresses');
  expect([401, 403]).toContain(anon.status);

  await signInCustomer(page);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));
  const mine = await apiCall(page, 'GET', '/customers/me/addresses', { token });
  expect(mine.status).toBe(200);
  /* A client-supplied customer id in the query must be ignored, not honoured. */
  const forged = await apiCall(page, 'GET', '/customers/me/addresses?customerId=000000000000000000000000', { token });
  expect(forged.status).toBe(200);
  expect(forged.body?.addresses?.length).toBe(mine.body?.addresses?.length);
});

test('§28 — an expired session is cleared and the customer is returned to sign-in', async ({ page }) => {
  const audit = observe(page);

  await page.addInitScript(() => {
    window.localStorage.setItem('flora_alchemy_customer_token', 'expired.token.value');
    window.localStorage.setItem('flora_alchemy_customer_session', JSON.stringify({ email: 'customer@example.com' }));
    window.localStorage.setItem('flora_alchemy_account', JSON.stringify({ email: 'customer@example.com' }));
  });

  await page.goto('/account');

  /* The customer must land somewhere they can act, never on a blank shell. */
  await page.waitForURL(/\/login/, { timeout: 25_000 });
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('main')).toContainText(/sign in|account/i);

  const leftover = await page.evaluate(() => ({
    token: window.localStorage.getItem('flora_alchemy_customer_token'),
  }));
  expect(leftover.token, 'the rejected token was left in storage').toBeFalsy();

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
