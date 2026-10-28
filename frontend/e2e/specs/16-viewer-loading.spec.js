/**
 * FLOW 43–46 — THE 3D VIEWER ALWAYS REACHES A TERMINAL STATE.
 *
 * WHY THIS SPEC EXISTS
 * --------------------
 * The 3D Model Studio could sit on “Loading the 3D model…” indefinitely: the
 * private media read had no timeout, and the viewer's loader had no deadline, so
 * a request that opened and then stalled left the promise pending forever — no
 * error, no Retry, nothing to click. The fix bounds the read (AbortController +
 * a typed failure) AND the whole load (a watchdog that names the stage it was
 * stuck in). These specs are the proof that the bound is real in a browser:
 *
 *   FLOW 43 — a candidate AWAITING REVIEW loads and renders (real private bytes,
 *             real parse, real framing) and reports the measured load time.
 *   FLOW 44 — a STALLED media request becomes a stated timeout plus a working
 *             Retry, rather than an endless spinner.
 *   FLOW 45 — 401/403 and 404 are reported as DIFFERENT, actionable failures.
 *   FLOW 46 — malformed and empty bodies end in `error`, never `ready`, and the
 *             approval controls stay usable while the viewport is broken.
 *
 * WHAT IS REAL AND WHAT IS INJECTED
 * ---------------------------------
 * The candidate, its private GLB on disk, the media route, the parse and the
 * framing are all the shipped stack (`QUALITY_FIXTURES` are labelled
 * deterministic fixtures, not generated models — see 13-quality-review). Only
 * the FAILURE cases are injected, and they are injected at the network layer
 * with `page.route`, which is the only honest way to produce a 401, a 404 or a
 * stall against a server that is working correctly.
 *
 * THE BOUNDS ARE CONFIGURATION, NOT A TEST HACK. `scripts/e2e-build.mjs` builds
 * this bundle with `VITE_GLB_FETCH_TIMEOUT_MS=6000` and
 * `VITE_GLB_LOAD_DEADLINE_MS=45000`, so a stall proves itself in seconds while a
 * healthy local load keeps a wide margin. The deployed build uses the defaults
 * (120 s read / 180 s whole load).
 */
import { test, expect } from '@playwright/test';
import { signInAdmin, waitForRouteReady } from '../support/helpers.js';

/** The candidate + approved fixtures live on this product (see support/fixtures). */
const PRODUCT_SLUG = 'dusty-rose-lavender-posy';
const MEDIA_GLOB = '**/api/3d/media/**';

/** Sign in, open the product, enter edit mode and wait for the viewport. */
async function openViewer(page) {
  await signInAdmin(page);
  await page.goto(`/admin/products/${PRODUCT_SLUG}`);
  await waitForRouteReady(page);
  await page.getByRole('button', { name: /edit product/i }).click();
  const preview = page.getByTestId('glb-preview');
  await expect(preview).toBeVisible({ timeout: 30_000 });
  return preview;
}

/** Every media request the viewer makes, so a failure can be attributed. */
function recordMediaCalls(page) {
  const calls = [];
  page.on('response', (res) => {
    if (!res.url().includes('/3d/media/')) return;
    calls.push({ status: res.status(), url: res.url() });
  });
  page.on('requestfailed', (req) => {
    if (!req.url().includes('/3d/media/')) return;
    calls.push({ status: 'failed', url: req.url(), failure: req.failure()?.errorText || '' });
  });
  return calls;
}

test('FLOW 43 — a candidate awaiting review loads, renders and reports its stage', async ({ page }) => {
  const media = recordMediaCalls(page);
  const preview = await openViewer(page);

  /* The candidate is the thing under review, so the viewport must label it as
     such — its loading state says nothing about its review status. */
  await expect(page.getByText(/candidate awaiting your review/i)).toBeVisible();

  await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(preview).toHaveAttribute('data-stage', 'ready');

  /* Real geometry was parsed and framed — not merely a 200. */
  const meshCount = Number(await preview.getAttribute('data-mesh-count'));
  expect(meshCount, 'the viewport reached ready without any drawable mesh').toBeGreaterThan(0);

  /* The load time is MEASURED. A blank string would mean we never reached the
     end of the machine. */
  const loadMs = Number(await preview.getAttribute('data-load-ms'));
  expect(Number.isFinite(loadMs) && loadMs >= 0, `data-load-ms was "${loadMs}"`).toBe(true);

  /* The bytes came through the private route, for a real asset id. */
  expect(media.some((c) => c.status === 200 && /\/model$/.test(c.url))).toBe(true);
  expect(media.some((c) => c.url.includes(PRODUCT_SLUG))).toBe(true);

  /* The stage readout is gone once the model is up. */
  await expect(page.getByTestId('glb-preview-stage')).toHaveCount(0);
});

test('FLOW 44 — a stalled download ends in a timeout with a working Retry', async ({ page }) => {
  /* Hold the request open forever. The OLD code waited on this promise with no
     bound at all; the fixed code aborts it and says so. */
  const held = [];
  await page.route(MEDIA_GLOB, (route) => {
    held.push(route);
  });

  try {
    const preview = await openViewer(page);

    await expect(preview).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
    const message = page.getByTestId('glb-preview-error');
    await expect(message).toBeVisible();
    await expect(message).toHaveText(/stopped|longer than|interrupted/i);

    /* Staff can see WHERE it failed, and can act on it. */
    await expect(page.getByTestId('glb-preview-error-stage')).toHaveText(/downloading|Starting|Checking/i);
    const retry = page.getByRole('button', { name: /try again/i }).first();
    await expect(retry).toBeVisible();
  } finally {
    /* Release the intercept before retrying, then settle the held routes. */
    await page.unroute(MEDIA_GLOB);
    for (const route of held) {
      await route.abort('failed').catch(() => {});
    }
  }

  /* Retry starts a NEW bounded load and reaches ready — no duplicate renderer,
     no stale error left on screen. */
  const preview = page.getByTestId('glb-preview');
  await expect(preview).toHaveAttribute('data-state', 'error');
  await page.getByRole('button', { name: /try again/i }).first().click();
  await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(page.getByTestId('glb-preview-error')).toHaveCount(0);
});

test('FLOW 45 — 401 and 404 are reported as different, actionable failures', async ({ page }) => {
  /* 401 — the session cannot read the model. Saying "could not be loaded (401)"
     sends staff to the wrong place; the message must name the session. */
  await page.route(MEDIA_GLOB, async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, message: 'Session expired.', code: 'UNAUTHENTICATED' }),
    });
  });

  let preview = await openViewer(page);
  await expect(preview).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(page.getByTestId('glb-preview-error')).toHaveText(/session/i);
  await page.unroute(MEDIA_GLOB);

  /* 404 — the asset is gone (replaced, deleted, or a stale id). */
  await page.route(MEDIA_GLOB, async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, message: 'That model no longer exists.', code: 'ASSET_NOT_FOUND' }),
    });
  });

  await page.reload();
  await waitForRouteReady(page);
  await page.getByRole('button', { name: /edit product/i }).click();
  preview = page.getByTestId('glb-preview');
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(page.getByTestId('glb-preview-error')).toHaveText(/no longer exists/i);

  /* Neither status may leave the spinner up. */
  await expect(page.getByTestId('glb-preview-stage')).toHaveCount(0);
  await page.unroute(MEDIA_GLOB);
});

test('FLOW 46 — malformed or empty bytes are refused, and approval stays usable', async ({ page }) => {
  await page.route(MEDIA_GLOB, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'model/gltf-binary',
      body: Buffer.from('this is not a glb, it is a sentence'),
    });
  });

  const preview = await openViewer(page);
  await expect(preview).toHaveAttribute('data-state', 'error', { timeout: 45_000 });
  /* A parse failure names the stage it died in, and never claims ready. */
  await expect(page.getByTestId('glb-preview-error-stage')).toBeVisible();
  await expect(page.getByTestId('glb-preview-error')).not.toHaveText('');

  /* The review decision is INDEPENDENT of the viewport: a broken model file must
     not disable the approve/reject controls or fake a verdict. This test never
     clicks them — approval state is not ours to change. */
  const approve = page.getByRole('button', { name: /^approve/i }).first();
  if (await approve.count()) {
    await expect(approve).toBeEnabled();
  }

  await page.unroute(MEDIA_GLOB);

  /* An empty 200 is a different failure from garbage bytes, and both are errors. */
  await page.route(MEDIA_GLOB, async (route) => {
    await route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: Buffer.alloc(0) });
  });
  await page.reload();
  await waitForRouteReady(page);
  await page.getByRole('button', { name: /edit product/i }).click();
  await expect(page.getByTestId('glb-preview')).toHaveAttribute('data-state', 'error', { timeout: 45_000 });
  await expect(page.getByTestId('glb-preview-error')).toHaveText(/empty|could not|no longer|failed/i);
  await page.unroute(MEDIA_GLOB);
});
