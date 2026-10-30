/**
 * MULTI-VIEW CAPTURE SET — E2E (3D Studio Phase 11).
 *
 * WHY THIS SPEC EXISTS
 * --------------------
 * The backend suite proves the capture service by calling it: coverage, duplicate
 * bytes, pose validation, per-engine verdicts, the deterministic plan, the
 * submission audit, tenancy. It cannot see the render path at all — this project
 * has no frontend unit runner — and the capture panel is the ONE screen where a
 * wrong verdict becomes a wrong submission. A panel that reported "valid for
 * Meshy" while the server refused, or that quiet-started a set because somebody
 * opened the product page, would pass every backend assertion and still be wrong.
 *
 * WHAT IT PROVES
 * --------------
 *  · Opening the product page is a READ. No capture set exists afterwards, and
 *    the API still answers 404 for that product — a page view must never write.
 *  · "Start capture set" is the explicit action that creates it.
 *  · A COMPLETE four-view capture reads as complete, and the SAME rows get
 *    different verdicts per engine: TripoSR is ready, Meshy is refused with the
 *    reason naming the deployment, ReLi3D reports no adapter. That contrast is
 *    the whole point of Phase 11's per-engine contract.
 *  · The plan is real: a single-image engine is handed ONE of four views, and the
 *    panel says the other three are left out by that engine's input limit.
 *  · A pose recorded in the panel persists (with its source), a partial pose is
 *    refused without overwriting the good one, and the panel re-measures.
 *  · The submit confirmation names the charge risk honestly: no metered
 *    acknowledgement appears for a free engine, and the confirmation is cancelled
 *    here — this spec NEVER submits, so no job and no billing exists afterwards.
 *  · A client cannot force a status through PATCH, and an unauthenticated caller
 *    cannot read the set at all.
 *  · A failed engine-registry load shows the cause and a Retry that recovers.
 *  · The panel still fits a phone.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * Nothing about reconstruction quality. The fixture views are deterministic
 * synthetic images and no engine ran (the stack's local provider is deliberately
 * unreachable). A passing capture set says the workflow is honest, not that a
 * bouquet reconstructs well — see docs/PHASE_11_REMAINING_WORK.md.
 */

import { test, expect } from '@playwright/test';
import { freshVisitor, observe, signInAdmin, waitForRouteReady } from '../support/helpers.js';
import { CAPTURE_FIXTURE } from '../support/fixtures.js';

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000/api';
const PRODUCT_SLUG = CAPTURE_FIXTURE.productSlug;
const VIEW_COUNT = CAPTURE_FIXTURE.views.length;

/** The staff token the portal stores; every API assertion below is authenticated. */
async function staffToken(page) {
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'));
  expect(token, 'no staff token after sign-in').toBeTruthy();
  return token;
}

/** Call the real API from the page's own origin context, with the staff token. */
async function call(page, method, path, body = null) {
  const token = await staffToken(page);
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

/** Open the product's editor, where the capture panel sits beside the studio. */
async function openStudio(page) {
  await page.goto(`/admin/products/${PRODUCT_SLUG}`);
  await waitForRouteReady(page);
  const edit = page.getByRole('button', { name: /^edit product$/i });
  if (await edit.count()) await edit.click();
  const panel = page.locator('[data-capture-status]');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 56 — opening the studio READS the capture state and creates nothing', async ({ page }) => {
  const audit = observe(page);
  await signInAdmin(page);

  /* The stack provisions four accepted, labelled views and NO capture set. If
     this fails the fixture — not the panel — is wrong. */
  const before = await call(page, 'GET', `/capture-sets?productSlug=${encodeURIComponent(PRODUCT_SLUG)}`);
  expect(before.status, 'the stack must start with no capture set for this product').toBe(404);

  const panel = await openStudio(page);
  await expect(panel).toHaveAttribute('data-capture-status', 'not-started');
  await expect(panel).toContainText(new RegExp(`${VIEW_COUNT} accepted photographs ready to measure`, 'i'));

  /* The guide is part of the product, not documentation somewhere else: it says
     what a capture IS, including the composite-sheet warning. */
  await expect(panel).not.toContainText(/rendered turntable/i);
  await panel.getByRole('button', { name: /how to photograph a capture set/i }).click();
  await expect(panel).toContainText(/rendered turntable/i);
  await expect(panel).toContainText(/same bouquet/i);

  /* THE ASSERTION THIS SPEC EXISTS FOR: looking at the page is not a write. */
  const after = await call(page, 'GET', `/capture-sets?productSlug=${encodeURIComponent(PRODUCT_SLUG)}`);
  expect(
    after.status,
    'opening the capture panel CREATED a capture set — a read must never write a record'
  ).toBe(404);
  await expect(panel.getByRole('button', { name: /start capture set/i })).toBeEnabled();

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 57 — a complete capture is ready for the SINGLE-view engine and refused for the others', async ({
  page,
}) => {
  const audit = observe(page);
  await signInAdmin(page);

  let panel = await openStudio(page);
  await panel.getByRole('button', { name: /start capture set/i }).click();

  /* The explicit action created it, and the panel is now the active surface. */
  await expect(panel).not.toHaveAttribute('data-capture-status', 'not-started');
  await expect(panel).toContainText(new RegExp(`Accepted views \\(${VIEW_COUNT}\\)`, 'i'));

  /* Select the single-view engine the way staff do, then re-measure explicitly. */
  await panel.getByRole('radio', { name: /Local TripoSR/i }).check();
  await panel.getByRole('button', { name: /re-validate/i }).click();
  await expect(panel).toHaveAttribute('data-capture-status', 'validated', { timeout: 30_000 });

  /* Server truth for the contrast the UI is claiming. */
  const current = await call(page, 'GET', `/capture-sets?productSlug=${encodeURIComponent(PRODUCT_SLUG)}`);
  expect(current.status).toBe(200);
  const set = current.body.captureSet;
  const live = set.live;

  expect(live.missing, 'a four-view base cover should be missing nothing').toEqual([]);
  expect(live.complete).toBe(true);
  expect(live.counts.requiredPresent, 'coverage did not count all required views').toBe(4);
  expect(live.readyFor, 'only the configured local engine can actually be submitted to').toEqual([
    'local_single_view',
  ]);

  const verdict = (engineId) => (live.engines || []).find((entry) => entry.engineId === engineId);
  expect(verdict('local_single_view').valid, 'the complete set should satisfy the single-view engine').toBe(true);
  expect(verdict('local_single_view').enabled).toBe(true);

  /* Meshy's contract is NOT satisfied here, and the reason must be the
     DEPLOYMENT, not the photographs — the same four views are a complete cover. */
  const meshy = verdict('meshy_multi_image');
  expect(meshy.valid).toBe(false);
  expect(meshy.errors.map((e) => e.code)).toContain('ENGINE_DISABLED');
  expect(meshy.errors.map((e) => e.message).join(' ')).toMatch(/configured for local_worker/i);

  /* A pose-required engine is refused for the reason Phase 11 documents. */
  const reli3d = verdict('reli3d');
  expect(reli3d.installed).toBe(false);

  /* The visible verdicts match the wire. */
  await expect(panel).toContainText(/this set is valid for it/i);
  await expect(panel).toContainText(/this set is not valid for it/i);
  await expect(panel).toContainText(/no adapter in this build/i);
  await expect(panel).toContainText(/not installed/i);

  /* ── the plan is real, and it enforces the engine's input limit ─────────── */
  await expect(panel).toContainText(/Submission plan/i);
  await expect(panel).toContainText(new RegExp(`1 image\\s*would be sent`, 'i'));
  await expect(panel).toContainText(new RegExp(`${VIEW_COUNT - 1} accepted views are left out`, 'i'));
  /* One row in the ordered list, whatever the panel claims in prose. */
  await expect(panel.locator('ol li')).toHaveCount(1);
  expect(live.engines.find((e) => e.engineId === 'local_single_view').selectedImages).toHaveLength(1);
  expect(live.engines.find((e) => e.engineId === 'local_single_view').unusedViews).toBe(VIEW_COUNT - 1);

  /* ── a pose is RECORDED, never inferred ─────────────────────────────────── */
  await expect(panel).toContainText(new RegExp(`Poses recorded\\s*0 / ${VIEW_COUNT}`, 'i'));
  await panel.getByRole('button', { name: /^record pose$/i }).first().click();
  await panel.getByLabel('cam z').fill('2.5');
  await panel.getByLabel('fov °').fill('38');
  await panel.getByRole('button', { name: /^save pose$/i }).click();

  await expect(panel).toContainText(/pose recorded \(manual\)/i, { timeout: 30_000 });
  await expect(panel).toContainText(new RegExp(`Poses recorded\\s*1 / ${VIEW_COUNT}`, 'i'), { timeout: 30_000 });

  const refs = await call(page, 'GET', `/references?productSlug=${encodeURIComponent(PRODUCT_SLUG)}`);
  expect(refs.status).toBe(200);
  const posed = (refs.body.images || []).find((image) => image.viewAngle === 'front');
  expect(posed, 'the front view is missing from the reference list').toBeTruthy();
  expect(posed.pose, 'the pose was not persisted on the reference row').toBeTruthy();
  expect(posed.pose.position.z).toBeCloseTo(2.5, 3);
  expect(posed.pose.fov).toBeCloseTo(38, 3);
  expect(posed.pose.source).toBe('manual');
  expect(posed.pose.recordedAt, 'a recorded pose must carry when it was recorded').toBeTruthy();
  expect(posed.pose.distance).toBeGreaterThan(0);
  expect(String(posed.pose.recordedBy || ''), 'a recorded pose must name who recorded it').not.toBe('');

  /* A HALF pose is refused and must not overwrite the good one. */
  const partial = await call(page, 'PATCH', `/references/${posed.id}`, {
    pose: { position: { x: 1, y: 2, z: 3 } },
  });
  expect(partial.status, 'a pose without a target and field of view must be refused').toBeGreaterThanOrEqual(400);
  expect(partial.body?.success).toBe(false);

  const afterPartial = await call(page, 'GET', `/references?productSlug=${encodeURIComponent(PRODUCT_SLUG)}`);
  const stillPosed = (afterPartial.body.images || []).find((image) => image.id === posed.id);
  expect(stillPosed.pose.position.z, 'a refused pose ERASED the valid one').toBeCloseTo(2.5, 3);
  expect(stillPosed.pose.fov).toBeCloseTo(38, 3);

  /* ── the confirmation names the risk and is cancelled, never submitted ──── */
  await expect(panel).toHaveAttribute('data-capture-can-submit', 'true');
  await panel.getByRole('button', { name: /^Submit to Local TripoSR/i }).click();
  await expect(panel).toContainText(/starts a reconstruction of 1 image/i);
  /* A FREE engine asks for no metered acknowledgement — and must not imply one. */
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel).toContainText(/not visible to customers/i);
  await panel.getByRole('button', { name: /^cancel$/i }).click();
  await expect(panel.getByRole('button', { name: /^Submit to Local TripoSR/i })).toBeVisible();

  /* NOTHING WAS SENT: no submission record exists, so no job and no bill. */
  const settled = await call(page, 'GET', `/capture-sets?productSlug=${encodeURIComponent(PRODUCT_SLUG)}`);
  expect((settled.body.captureSet.submissions || []).length, 'cancelling the confirmation still submitted').toBe(0);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 58 — a status cannot be forced, an unknown caller is refused, and a failed load recovers', async ({
  page,
}) => {
  const audit = observe(page);
  await signInAdmin(page);

  /* Make sure a set exists (this spec may run alone). */
  const panel = await openStudio(page);
  if ((await panel.getAttribute('data-capture-status')) === 'not-started') {
    await panel.getByRole('button', { name: /start capture set/i }).click();
  }
  await panel.getByRole('button', { name: /re-validate/i }).click();
  await expect(panel).toHaveAttribute('data-capture-status', 'validated', { timeout: 30_000 });

  const current = await call(page, 'GET', `/capture-sets?productSlug=${encodeURIComponent(PRODUCT_SLUG)}`);
  const set = current.body.captureSet;

  /* A client that could PATCH the status would skip validation entirely, so the
     field is not merely ignored — a request that carries it is REFUSED. */
  const forced = await call(page, 'PATCH', `/capture-sets/${set.id}`, {
    productSlug: PRODUCT_SLUG,
    status: 'completed',
  });
  expect(forced.status, 'a request that tried to set the status was accepted').toBe(422);
  expect(forced.body?.code).toBe('CAPTURE_SET_STATUS_READ_ONLY');

  const unchanged = await call(page, 'GET', `/capture-sets?productSlug=${encodeURIComponent(PRODUCT_SLUG)}`);
  expect(unchanged.body.captureSet.status, 'the refused request changed the stored status anyway').toBe('validated');

  /* A metered engine cannot be reached without the deployment switch. */
  const engines = await call(page, 'GET', '/capture-sets/engines');
  expect(engines.status).toBe(200);
  expect(engines.body.meteredAuthorised, 'metered submission must be OFF by default').toBe(false);

  const refused = await call(page, 'POST', `/capture-sets/${set.id}/submit`, {
    productSlug: PRODUCT_SLUG,
    engineId: 'meshy_multi_image',
    /* The staff acknowledgement is present ON PURPOSE: the deployment switch is
       the missing half, and the refusal must hold regardless. */
    acknowledgeMetered: true,
  });
  expect(refused.status, 'a submit to an engine this deployment is not configured for succeeded').toBeGreaterThanOrEqual(400);
  expect(refused.body?.success).toBe(false);
  expect(String(refused.body?.code || '')).toMatch(/ENGINE|NOT_ENABLED|NOT_AUTHORISED/i);

  /* The panel reaches the same conclusion through the ordinary path: choosing
     the metered engine turns the submit control OFF and says why, so a staff
     member cannot walk into a refusal they were never warned about. */
  await panel.getByRole('radio', { name: /Meshy/i }).check();
  await expect(panel).toHaveAttribute('data-capture-can-submit', 'false', { timeout: 30_000 });
  await expect(panel).toContainText(/configured for local_worker/i);

  /* Unauthenticated callers get nothing — the set names private photographs. */
  const anonymous = await page.evaluate(
    async ({ apiUrl, slug }) => {
      const r = await fetch(`${apiUrl}/capture-sets?productSlug=${encodeURIComponent(slug)}`);
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { apiUrl: API, slug: PRODUCT_SLUG }
  );
  expect(anonymous.status, 'an anonymous caller could read a capture set').toBe(401);

  /* A failed registry load surfaces the cause and offers Retry. */
  await page.route('**/api/capture-sets/engines', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, message: 'Injected engine-registry failure', code: 'INJECTED' }),
    })
  );
  await page.reload();
  await waitForRouteReady(page);
  await expect(page.getByText('Injected engine-registry failure')).toBeVisible({ timeout: 30_000 });

  await page.unroute('**/api/capture-sets/engines');
  await page.getByRole('button', { name: /^retry$/i }).click();
  await expect(page.locator('[data-capture-status]')).toHaveAttribute('data-capture-status', 'validated', {
    timeout: 30_000,
  });

  /* Responsive: the panel keeps its layout on a phone, with no horizontal spill. */
  await page.setViewportSize({ width: 390, height: 844 });
  const phonePanel = page.locator('[data-capture-status]');
  await expect(phonePanel).toBeVisible();
  await expect(phonePanel.getByRole('heading', { name: 'Multi-View Capture' })).toBeVisible();
  const box = await phonePanel.boundingBox();
  expect(box.width, `the capture panel is ${box.width}px wide on a 390px viewport`).toBeLessThanOrEqual(390);

  /* The injected 500 is the only console noise this test is allowed to have
     produced — it was the failure under test. */
  const { pageErrors, consoleErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  const unexplained = consoleErrors.filter((message) => !/Injected engine-registry failure|Failed to load resource/i.test(message));
  expect(unexplained, `console errors: ${unexplained.join(' | ')}`).toEqual([]);
});
