/**
 * PHASE 4 §4 — SLOW / FAILED CATALOGUE RESILIENCE, deterministically.
 *
 * The defect this proves fixed: a public catalogue request that STALLED pinned
 * the route to its loading skeleton forever — no error, no retry, no way
 * forward. It was found by measurement (the live endpoint spiked to 11–30s
 * under concurrency, and the browser sat on the skeleton), but a launch gate
 * cannot wait for the network to misbehave on cue, so these tests produce the
 * conditions deliberately with route interception:
 *
 *   · a request that FAILS          → the route must say so, and Retry must work
 *   · a request that NEVER ARRIVES  → the route must give up on its own bound
 *                                     and offer the same honest state
 *   · a request that succeeds EMPTY → must read as empty, NOT as a failure, and
 *                                     NOT as a fabricated catalogue
 *
 * The last one matters as much as the first two: converting an outage into a
 * calm empty shop would hide a real incident behind a plausible-looking page.
 */

import { test, expect } from '@playwright/test';
import { freshVisitor, observe } from '../support/helpers.js';

/* Errors this file EXPECTS the browser to report: the app deliberately logs its
   own hydration failure, and a request we aborted produces a resource error.
   Anything outside this set still fails the test. */
const EXPECTED_NOISE =
  /ERR_FAILED|ERR_ABORTED|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|Failed to load resource|route critical backfill failed|net::ERR/i;

const SHOP = '/shop';
const ERROR_TITLE = /couldn’t reach the studio server|couldn't reach the studio server/i;
const CATALOGUE = '**/api/products*';

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('§4 — a FAILED catalogue request is reported, and Retry recovers', async ({ page }) => {
  const audit = observe(page);

  /* Every catalogue read fails — a total outage of the critical slice. */
  await page.route(CATALOGUE, (route) => route.abort('failed'));

  await page.goto(SHOP);

  /* The route must name the failure instead of rendering an empty shop. */
  await expect(page.getByRole('heading', { name: ERROR_TITLE })).toBeVisible({ timeout: 25_000 });
  const retry = page.getByRole('button', { name: /^Retry$/i });
  await expect(retry).toBeVisible();

  /* Nothing was invented to fill the gap. */
  await expect(page.locator('main article')).toHaveCount(0);

  /* The outage is temporary by construction: restore the API and Retry. */
  await page.unroute(CATALOGUE);
  await retry.click();

  await expect(page.locator('main article').first()).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('main')).not.toContainText(ERROR_TITLE);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('§4 — a catalogue request that NEVER ANSWERS is bounded, not eternal', async ({ page }) => {
  const audit = observe(page);

  /* A held response: the request stays open far past the app's own bound, so
     the ONLY way this test can reach the error state is if the app gave up by
     itself. Without the bound the gate would render the skeleton forever and
     this assertion would time out — which is exactly the bug. */
  let held = 0;
  await page.route(CATALOGUE, async (route) => {
    held += 1;
    if (held === 1) {
      await new Promise((resolve) => setTimeout(resolve, 90_000));
      return route.abort('timedout');
    }
    return route.continue();
  });

  await page.goto(SHOP, { waitUntil: 'domcontentloaded' });

  /* 1. While the response is in flight the customer sees the honest
        content-shaped loading state (not a blank page). */
  await expect(page.getByRole('status', { name: 'Loading page content' })).toBeVisible({ timeout: 15_000 });

  /* 2. It resolves by itself — the bound fired, so the skeleton is gone and the
        failure is explainable. 40s ceiling: the app's bound is 25s. */
  await expect(page.getByRole('heading', { name: ERROR_TITLE })).toBeVisible({ timeout: 40_000 });
  const retry = page.getByRole('button', { name: /^Retry$/i });
  await expect(retry).toBeVisible();

  /* 3. And the state is recoverable, not terminal. */
  await page.unroute(CATALOGUE);
  await retry.click();
  await expect(page.locator('main article').first()).toBeVisible({ timeout: 25_000 });

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('§4 — a LATE response from an abandoned request cannot overwrite fresh data', async ({ page }) => {
  const audit = observe(page);

  /* The abandoned request does not disappear — it lands eventually, long after
     the app gave up on it and the customer retried. This test gives that late
     response a payload that is IMPOSSIBLE to confuse with the real catalogue,
     so if it were allowed to commit, its fabricated row would be visible on the
     page. "Last response to arrive wins" fails this test; "last request to
     START wins" passes it. */
  const PROBE = 'LATE ARRIVAL PROBE — must never render';
  let held = 0;
  await page.route(CATALOGUE, async (route) => {
    held += 1;
    if (held === 1) {
      await new Promise((resolve) => setTimeout(resolve, 35_000));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          products: [
            {
              slug: 'late-arrival-probe',
              name: PROBE,
              price: 1,
              category: 'Probe',
              stockTracked: false,
              inStock: true,
              images: [],
            },
          ],
        }),
      });
    }
    return route.continue();
  });

  await page.goto(SHOP, { waitUntil: 'domcontentloaded' });

  /* The bound fires on its own (the app's ceiling is 25s). */
  await expect(page.getByRole('heading', { name: ERROR_TITLE })).toBeVisible({ timeout: 40_000 });

  /* The customer retries and gets the real catalogue. The route handler STAYS
     installed (its second-and-later branch forwards to the real API) so the
     abandoned first response can still be delivered later — unrouting it here
     would release the held route and there would be no late response left to
     prove anything about. */
  await page.getByRole('button', { name: /^Retry$/i }).click();
  await expect(page.locator('main article').first()).toBeVisible({ timeout: 25_000 });
  const realCount = await page.locator('main article').count();
  expect(realCount).toBeGreaterThan(0);

  /* Now let the abandoned response land (35s mark) and settle. Nothing about
     the page may change: the fresh rows stay, the stale payload is dropped. */
  await page.waitForTimeout(20_000);
  await expect(page.locator('main')).not.toContainText(PROBE);
  await expect(page.locator('main article')).toHaveCount(realCount);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('§4 — a genuinely EMPTY catalogue reads as empty, not as an error', async ({ page }) => {
  /* A successful response that happens to contain no products. This is the
     inverse hazard: an outage must not be disguised as an empty shop, and a
     real empty shop must not be reported as an outage. */
  await page.route(CATALOGUE, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, products: [] }),
    })
  );

  await page.goto(SHOP);

  /* Settle: the page rendered its own content (the loading state is gone)... */
  await expect(page.getByRole('status', { name: 'Loading page content' })).toBeHidden({ timeout: 25_000 });
  await expect(page.locator('main')).toBeVisible();

  /* ...it is NOT an error, and there is no Retry to offer... */
  await expect(page.getByRole('heading', { name: ERROR_TITLE })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Retry$/i })).toHaveCount(0);

  /* ...and nothing was fabricated to fill the grid. */
  await expect(page.locator('main article')).toHaveCount(0);
});
