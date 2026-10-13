/**
 * PHASE 21.1 + pre-merge audit — the portal logins must survive their OWN
 * session hand-over.
 *
 * The audit found a real defect here, and only here: when an identity signed in
 * at a portal the policy *permits but does not own* (an administrator at the
 * Owner portal), the page correctly rendered a mismatch notice and scheduled a
 * hand-over ~2.2s later — and committing the session triggered an `auth`
 * re-hydration that swapped the whole login screen for the bootstrap skeleton.
 * The page was unmounted in the same commit that should have shown the notice,
 * `setMismatch` was dropped, the deferred `navigate()` was cancelled by the
 * page's unmount cleanup, and an authenticated operator was left on a silent
 * login form: no notice, no hand-over, no error.
 *
 * These are the assertions that would have caught it. They drive the REAL form
 * against the REAL stack (no mocked API), because the defect lived in the
 * interaction between a successful sign-in and the route gate, not in either
 * one alone.
 *
 * What is asserted, and why each one is the right probe:
 *   · the notice APPEARS — proving the gate did not unmount the screen;
 *   · the hand-over COMPLETES — proving the deferred navigation was not
 *     cancelled (the pre-fix run left the visitor on /admin/login forever);
 *   · the portal's own shell is NEVER rendered for an identity that does not
 *     belong to it — this is routing, and the server still authorizes every
 *     request behind it;
 *   · refusals (wrong portal, wrong password, dead token) stay explained and
 *     never sign anyone in.
 *
 * The mismatch case needs the OWNER identity (`ownerCredentials()`), because the
 * server only ACCEPTS a cross-portal sign-in where the policy allows it: the
 * admin portal admits any administrator (the owner included) and the owner's
 * home portal is the Owner Portal, so `landed !== portal`. The other two
 * directions are hard refusals by design — the Owner Portal is owner-only and
 * the Staff Portal is handler-only — and both are asserted below as refusals.
 */

import { test, expect } from '@playwright/test';
import { SEED, freshVisitor, observe, ownerCredentials } from '../support/helpers.js';

/* The portal login form, addressed the way the app exposes it: `#portal-email`
   / `#portal-password` are the shared ids PortalLoginLayout renders for all
   three portals, and `[data-login-state]` records which state was reached. */
async function submitPortalLogin(page, path, email, password) {
  await page.goto(path);
  await expect(page.locator('#portal-email')).toBeVisible({ timeout: 25_000 });
  await page.locator('#portal-email').fill(email);
  await page.locator('#portal-password').fill(password);
  await page.locator('button[type="submit"]').first().click();
}

/** The route gate's loading skeleton. Its persistence is the pre-fix symptom. */
const loadingSkeleton = (page) => page.locator('[aria-label="Loading page content"]');

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('the owner signing in at the Administrator portal is told, then handed over — never left on a silent form', async ({ page }) => {
  const audit = observe(page);

  /* The audited case: the admin portal ACCEPTS an administrator — the owner is
     one, with isOwner=true — but the account belongs to the Owner Portal, so
     the page must say so and hand the operator over. */
  const owner = ownerCredentials();
  await submitPortalLogin(page, '/admin/login', owner.email, owner.password);

  const notice = page.locator('#portal-login-mismatch');
  await expect(
    notice,
    'the portal-mismatch notice never rendered — the login screen was replaced (or unmounted) before it could'
  ).toBeVisible({ timeout: 25_000 });
  await expect(notice).toContainText(/Owner Portal/i);
  await expect(notice).toContainText(/signed in/i);

  /* The screen the visitor is standing on must never become the Administrator
     shell: the hand-over is the only correct outcome. */
  await expect(page.locator('[data-portal-shell="admin"]')).toHaveCount(0);

  /* The deferred hand-over must actually complete — this is the assertion the
     pre-fix skeleton swap cancelled, leaving the operator on /admin/login. */
  await page.waitForURL(/\/owner\/dashboard/, { timeout: 25_000 });

  /* …and it completed as a real, usable session, not just a navigation. */
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'));
  expect(token, 'the handed-over session stored no staff token').toBeTruthy();

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('the owner signing in at its OWN portal enters directly, with no mismatch notice', async ({ page }) => {
  /* The positive control for the case above: the same identity, the portal it
     belongs to — no notice, straight into the Owner Portal. */
  const owner = ownerCredentials();
  await submitPortalLogin(page, '/owner/login', owner.email, owner.password);

  await page.waitForURL(/\/owner\/dashboard/, { timeout: 25_000 });
  await expect(page.locator('#portal-login-mismatch')).toHaveCount(0);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'));
  expect(token).toBeTruthy();
});

test('a plain administrator is refused at the Owner portal — explained, and with no session', async ({ page }) => {
  /* The Owner Portal is owner-only. Valid credentials for an administrator must
     NOT become access: the refusal has to say which portal the account belongs
     to, and store nothing. */
  await submitPortalLogin(page, '/owner/login', SEED.admin.email, SEED.admin.password);

  const error = page.locator('#portal-login-error');
  await expect(error).toBeVisible({ timeout: 25_000 });
  await expect(error).toContainText(/not the business owner/i);
  await expect(page).toHaveURL(/\/owner\/login/);
  expect(await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'))).toBeFalsy();
  await expect(page.locator('[data-portal-shell]')).toHaveCount(0);
});

test('an administrator is refused at the Staff portal — explained, and with no session', async ({ page }) => {
  /* The mirror of the refusal above: the Staff Portal is handler-only, so an
     administrator's operational surfaces must be reached through its own
     portal, not by picking the staff URL. */
  await submitPortalLogin(page, '/staff/login', SEED.admin.email, SEED.admin.password);

  const error = page.locator('#portal-login-error');
  await expect(error).toBeVisible({ timeout: 25_000 });
  await expect(error).toContainText(/not a handler account/i);
  await expect(page).toHaveURL(/\/staff\/login/);
  expect(await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'))).toBeFalsy();
  await expect(page.locator('[data-portal-shell]')).toHaveCount(0);
});

test('customer credentials are refused at the Administrator portal — explained, and with no session', async ({ page }) => {
  await submitPortalLogin(page, '/admin/login', SEED.customer.email, SEED.customer.password);

  const error = page.locator('#portal-login-error');
  await expect(error).toBeVisible({ timeout: 25_000 });
  /* Announced (role="alert"), not merely visible. */
  await expect(page.getByRole('alert').first()).toContainText(/administrator access|matches your role/i);

  /* A refused sign-in stores nothing and enters no portal. */
  expect(await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'))).toBeFalsy();
  await expect(page.locator('[data-portal-shell]')).toHaveCount(0);
  await expect(page).toHaveURL(/\/admin\/login/);
});

test('a customer is refused at the Owner portal too — no portal admits a customer', async ({ page }) => {
  await submitPortalLogin(page, '/owner/login', SEED.customer.email, SEED.customer.password);

  const error = page.locator('#portal-login-error');
  await expect(error).toBeVisible({ timeout: 25_000 });
  await expect(error).toContainText(/staff accounts only|not the business owner/i);
  expect(await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'))).toBeFalsy();
  await expect(page.locator('[data-portal-shell]')).toHaveCount(0);
});

test('a wrong password at a portal is explained and signs nobody in', async ({ page }) => {
  await submitPortalLogin(page, '/staff/login', SEED.admin.email, 'not-the-password');

  await expect(page.locator('#portal-login-error')).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('#portal-login-error')).toContainText(/incorrect/i);
  expect(await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'))).toBeFalsy();
  await expect(page.locator('[data-portal-shell]')).toHaveCount(0);
});

test('an authenticated operator who opens a login URL directly is never left on a dead form', async ({ page }) => {
  /* First sign in through the real form, so the session is genuine. */
  await submitPortalLogin(page, '/admin/login', SEED.admin.email, SEED.admin.password);
  await page.waitForURL(/\/admin\/dashboard/, { timeout: 25_000 });

  /* Then open a login URL directly while authenticated. Either outcome is
     acceptable (the form renders, or the app hands the visitor on) — what must
     NEVER happen is the loading skeleton persisting, or a blank page, or the
     session being silently dropped. */
  await page.goto('/admin/login');
  await expect(
    page.locator('#portal-email').or(page.locator('[data-portal-shell]')),
    'opening a login URL while authenticated settled on neither the form nor a portal shell'
  ).toBeVisible({ timeout: 25_000 });
  await expect(loadingSkeleton(page)).toHaveCount(0);

  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'));
  expect(token, 'the existing staff session was dropped by visiting a login URL').toBeTruthy();
});

test('a dead staff token is cleared and the visitor is returned to the portal login', async ({ page }) => {
  /* A structurally valid, unverifiable token: exactly what an expired or
     revoked session looks like to the client. */
  await page.goto('/admin/login');
  await page.evaluate(() => {
    window.localStorage.setItem(
      'flora_alchemy_admin_token',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleHBpcmVkIn0.not-a-real-signature'
    );
    window.localStorage.setItem(
      'flora_alchemy_admin_session',
      JSON.stringify({ id: 'expired', role: 'admin', portal: 'admin' })
    );
  });

  await page.goto('/admin/dashboard');

  /* The 401 → clear session → redirect-to-login flow must still hold. */
  await page.waitForURL(/\/admin\/login/, { timeout: 25_000 });
  expect(await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'))).toBeFalsy();
  await expect(page.locator('#portal-email')).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('[data-portal-shell]')).toHaveCount(0);
});
