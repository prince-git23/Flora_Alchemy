/**
 * THE REFERENCE-IMAGE DRAFT LIST — a regression floor for the request the
 * production incident was made of.
 *
 * WHY THIS SPEC EXISTS
 * --------------------
 * The studio asked `GET /api/references?draftKey=…` and the deployed API
 * answered `404 { code: 'NOT_FOUND', message: 'Route not found: GET
 * /api/references?draftKey=…' }` — and the screen then said **"No prepared
 * images yet."** beside that error. Two separate defects met there:
 *
 *   1. the API revision serving that origin did not mount the reference router
 *      at all (a deployment-version mismatch — the repo's own route table and
 *      `npm run test:references` prove the route exists and works), and
 *   2. the studio rendered an EMPTY-STATE CLAIM from the ABSENCE of a response.
 *      An empty array caused by a failure is not an answer, and reporting it as
 *      "you have no images" invites an administrator to re-upload photographs
 *      that already exist.
 *
 * Defect 2 is client-side and is fixed in `ReferenceImageStudio.jsx`; this spec
 * is what keeps it fixed. Defect 1 is a deploy, not a code change, and is
 * reported separately — no test here can prove a third-party hosting dashboard
 * is serving the right revision.
 *
 * FLOW numbers continue the suite's shared sequence (spec 13 ends at FLOW 36),
 * so a flow can be referred to by one number across specs.
 *
 * WHAT IS REAL
 * ------------
 * The whole stack: an isolated backend, the production bundle, the seeded
 * identities, real multipart uploads, and the real background-removal pipeline.
 * Nothing is stubbed. The ONE interception below is deliberate and is the
 * incident itself — it replays the production 404 so the failure path is
 * exercised through the browser rather than reasoned about.
 *
 * CROSS-WORKSPACE SCOPE
 * ---------------------
 * The E2E stack provisions a second SHOP (`SECOND_SHOP_SLUG`, used by the
 * storefront tenancy specs) but publishes no STAFF identity for it — the only
 * credential the stack hands to specs is the platform owner's. There is
 * therefore no second-workspace admin a browser test could sign in as, so the
 * cross-workspace 404 is proved where it can be REAL: `npm run test:references`
 * §I drives a second workspace admin directly against the API and asserts 404
 * (never 403) for read, list, mutate, and byte reads of a foreign reference.
 *
 * This spec covers the refusals a browser genuinely produces: `422` for a
 * missing set identity, `403` for a customer token, `401` with no session.
 */

import { test, expect } from '@playwright/test';
import {
  apiCall,
  freshVisitor,
  observe,
  signInAdmin,
  signInCustomer,
  waitForRouteReady,
} from '../support/helpers.js';
import { makeProductPng } from '../support/fixtures.js';


/** Every list request the studio made, with its real response. */
function recordListCalls(page) {
  const calls = [];
  page.on('request', (req) => {
    if (req.method() === 'GET' && /\/api\/references\?/.test(req.url())) {
      calls.push({ url: req.url(), response: null });
    }
  });
  page.on('response', async (res) => {
    if (!/\/api\/references\?/.test(res.url())) return;
    const match = calls.find((c) => c.url === res.url() && c.response === null);
    const body = await res.json().catch(() => null);
    if (match) match.response = { status: res.status(), body };
  });
  return calls;
}

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 37 — the studio asks for the draft set at GET /api/references?draftKey=…', async ({ page }) => {
  const audit = observe(page);
  const calls = recordListCalls(page);

  await signInAdmin(page);
  /* The create form is DRAFT mode: no product exists yet, so the set identity
     is the draft key. This is the exact request shape from the incident. */
  await page.goto('/admin/products/new');
  await waitForRouteReady(page);

  await expect(page.getByTestId('reference-studio')).toBeVisible();
  await expect
    .poll(() => calls.length, { timeout: 25_000, message: 'the studio never listed the draft set' })
    .toBeGreaterThan(0);

  const first = new URL(calls[0].url);
  /* The contract, asserted literally: the mounted router path, and the query
     parameter the controller reads (`req.query.draftKey`). A future rename of
     either side fails HERE instead of in production. */
  expect(first.pathname, 'the list request does not target the mounted router').toMatch(
    /\/api\/references$/
  );
  expect(first.searchParams.get('productSlug')).toBeNull();
  expect(first.searchParams.get('draftKey'), 'draft mode must identify the set by draftKey').toMatch(
    /^draft-/
  );

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 38 — a confirmed-empty draft says "No prepared images yet", and nothing else', async ({
  page,
}) => {
  const calls = recordListCalls(page);

  await signInAdmin(page);
  await page.goto('/admin/products/new');
  await waitForRouteReady(page);

  const studio = page.getByTestId('reference-studio');
  await expect(studio).toBeVisible();

  /* Server truth first: the list really did answer 200 with an empty set. Only
     then is the empty state a statement the UI is entitled to make. */
  await expect
    .poll(() => calls.find((c) => c.response)?.response?.status ?? null, { timeout: 25_000 })
    .toBe(200);
  const first = calls.find((c) => c.response).response;
  expect(first.body.success).toBe(true);
  expect(first.body.images).toEqual([]);

  await expect(studio).toContainText(/No prepared images yet/i);
  /* An empty set is not an error, and must not present itself as one. */
  await expect(page.getByTestId('reference-list-error')).toHaveCount(0);
});

test('FLOW 39 — an accepted upload really comes back from the draft list endpoint', async ({
  page,
}) => {
  const calls = recordListCalls(page);

  await signInAdmin(page);
  await page.goto('/admin/products/new');
  await waitForRouteReady(page);

  const studio = page.getByTestId('reference-studio');
  await expect(studio).toBeVisible();

  await page.getByTestId('reference-input').setInputFiles({
    name: 'e2e-draft-list-posy.png',
    mimeType: 'image/png',
    buffer: makeProductPng(),
  });

  /* The row is written by the SERVER; the card appears from a real list
     response, and settles once the real segmentation run finishes. */
  const card = page.getByTestId('reference-card-0');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(/ready|needs.?review/i, { timeout: 90_000 });

  /* The draft list returned the uploaded image, in the shape the UI renders.
     The LAST response that carried the row is the one the settled card came
     from: the studio polls this endpoint while the server is still processing,
     so earlier responses legitimately report UPLOADING/PROCESSING. Asserting
     the terminal state on the FIRST poll would be asserting the wrong thing. */
  const withImages = calls.map((c) => c.response).filter((r) => r?.body?.images?.length > 0);
  expect(withImages.length, 'the draft list never returned the uploaded image').toBeGreaterThan(0);
  const settled = withImages[withImages.length - 1];
  expect(settled.status).toBe(200);
  const image = settled.body.images[0];
  expect(image.id).toBeTruthy();
  expect(image.status).toMatch(/^(READY|NEEDS_REVIEW)$/);
  expect(image.original?.available).toBe(true);
  expect(image.cutout?.available).toBe(true);
  expect(image.neutral?.available).toBe(true);

  /* A storage path is never part of that payload. */
  expect(JSON.stringify(settled.body)).not.toContain('storageKey');
});

test('FLOW 40 — a REFUSED list request is an error with a Retry, never a false empty state', async ({
  page,
}) => {
  const audit = observe(page);
  let refuses = true;
  let attempts = 0;

  /* Replay the production symptom: the API answers 404 NOT_FOUND for the list.
     Intercepting here is the point — it drives the real component through the
     real transport into the failure path that shipped. */
  await page.route(/\/api\/references\?/, async (route) => {
    attempts += 1;
    if (!refuses) return route.continue();
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        message:
          'Route not found: GET /api/references?draftKey=draft-b3fbfdc5-e075-4ade-a038-4a932d45954b',
        code: 'NOT_FOUND',
      }),
    });
  });

  await signInAdmin(page);
  await page.goto('/admin/products/new');
  await waitForRouteReady(page);

  const studio = page.getByTestId('reference-studio');
  await expect(studio).toBeVisible();

  /* The failure is REPORTED, verbatim, with the server's own words. */
  const banner = page.getByTestId('reference-list-error');
  await expect(banner).toBeVisible({ timeout: 25_000 });
  await expect(banner).toContainText(/Route not found/i);

  /* And the studio does NOT claim the administrator has no images. This is the
     assertion the incident needed and did not have. */
  await expect(studio).not.toContainText(/No prepared images yet/i);

  /* The error is RETRYABLE: the control is present, and using it re-issues the
     request rather than merely re-rendering the banner. */
  const retry = page.getByTestId('reference-retry');
  await expect(retry).toBeVisible();
  const before = attempts;
  refuses = false;
  await retry.click();

  await expect
    .poll(() => attempts, { timeout: 25_000, message: 'Retry did not re-issue the request' })
    .toBeGreaterThan(before);

  /* The retried request reached the REAL backend, so the studio can now make
     the empty-state claim honestly — and the error is gone. */
  await expect(studio).toContainText(/No prepared images yet/i, { timeout: 25_000 });
  await expect(banner).toHaveCount(0);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 41 — refusals are real statuses, and a missing set identity is not an empty set', async ({
  page,
  browser,
}) => {
  await signInAdmin(page);
  const adminToken = await page.evaluate(() =>
    window.localStorage.getItem('flora_alchemy_admin_token')
  );
  expect(adminToken, 'no staff token after sign-in').toBeTruthy();

  /* A list request with NO set identity is a client error, never a 200 with an
     empty array (which would be a false "you have nothing"). */
  const missing = await apiCall(page, 'GET', '/references', { token: adminToken });
  expect(missing.status).toBe(422);
  expect(missing.body.code).toBe('VALIDATION_ERROR');

  /* A customer holds a real session but no staff role: refused before the
     controller runs, and the refusal discloses nothing about the set. */
  const customerContext = await browser.newContext();
  try {
    const customerPage = await customerContext.newPage();
    await signInCustomer(customerPage);
    const customerToken = await customerPage.evaluate(() =>
      window.localStorage.getItem('flora_alchemy_customer_token')
    );
    expect(customerToken, 'no customer token after sign-in').toBeTruthy();
    const refused = await apiCall(customerPage, 'GET', '/references?draftKey=draft-e2e-refused', {
      token: customerToken,
    });
    expect(refused.status).toBe(403);
    expect(refused.body?.success).toBe(false);
  } finally {
    await customerContext.close();
  }

  /* No session at all. */
  const anonymousContext = await browser.newContext();
  try {
    const anonymousPage = await anonymousContext.newPage();
    const anonymous = await apiCall(anonymousPage, 'GET', '/references?draftKey=draft-e2e-anon');
    expect(anonymous.status).toBe(401);
  } finally {
    await anonymousContext.close();
  }
});
