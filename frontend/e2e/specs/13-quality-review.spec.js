/**
 * FLOW 31–36 — THE QUALITY GATE, IN A BROWSER (3D Studio, Phase 6).
 *
 * WHY THIS SPEC EXISTS
 * --------------------
 * Phase 5's review panel renders only for a CANDIDATE asset, and the E2E stack
 * never created one, so the panel had never been drawn in a browser; it was
 * verified once with a throwaway probe and that probe was deleted. This spec
 * replaces it: the stack now provisions a candidate for every state the panel
 * has (`QUALITY_FIXTURES`), each through the SHIPPED services
 * (`createCandidateFromGeneration` → `assessAssetQuality`), so the report the
 * browser reads is the one the server really produced.
 *
 * WHAT IS A FIXTURE AND WHAT IS NOT
 * ---------------------------------
 * The geometry and the cutouts are deterministic fixtures
 * (`backend/scripts/lib/meshFixtures.mjs`), and every row is labelled
 * `e2e-fixture` / `e2e-fixture-engine`. **Not one of them is an AI-generated
 * model**, and this spec never claims otherwise. What IS real: the reference
 * row, the candidate row, its private bytes on disk, the job row, the quality
 * report, and every API call below.
 *
 * WHERE THE RULES LIVE
 * --------------------
 * The gate's RULES are proven server-side by `npm run test:3d-quality`. What
 * this spec adds is the CONTRACT the browser depends on: the panel draws the
 * server's verdict with its metrics and reasons, the acknowledgement and
 * override gates actually block the buttons, a fabricated verdict changes
 * nothing, and the studio payload carries no storage paths or credentials.
 */
import { test, expect } from '@playwright/test';
import { signInAdmin, waitForRouteReady, observe, apiCall } from '../support/helpers.js';
/* From the SUPPORT module, never from `stack.mjs`: importing that file EXECUTES
   it, so a spec that read the map from there booted a second stack inside the
   test worker and failed on "port 4000 is already in use". */
import { QUALITY_FIXTURES, PROVIDER_SECRET_CANARY } from '../support/fixtures.js';

const STUDIO_PATH = (slug) => `/3d/products/${slug}/studio`;

/**
 * Record the API calls a UI decision actually makes, so an assertion about an
 * approval/rejection can say whether the request happened at all, what it
 * carried, and what came back — rather than timing out with no explanation.
 */
function recordDecisionCalls(page) {
  const calls = [];
  const pattern = /\/api\/3d\/jobs\/[^/]+\/(approve|reject)$/;
  page.on('request', (req) => {
    if (pattern.test(req.url())) calls.push({ sent: req.method(), url: req.url(), body: req.postData() });
  });
  page.on('response', async (res) => {
    if (!pattern.test(res.url())) return;
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* a body that cannot be read is not the point */
    }
    calls.push({ answered: res.status(), url: res.url(), body: body.slice(0, 300) });
  });
  return calls;
}

/** Sign in, open a product's studio, and wait for the review panel. */
async function openStudio(page, productSlug) {
  await signInAdmin(page);
  await page.goto(`/admin/products/${productSlug}`);
  await waitForRouteReady(page);
  await page.getByRole('button', { name: /edit product/i }).click();
  await expect(page.getByTestId('candidate-review')).toBeVisible({ timeout: 30_000 });
}

/** The admin bearer token the app itself stored, for API-level assertions. */
function adminToken(page) {
  return page.evaluate(() => window.localStorage.getItem('flora_alchemy_admin_token'));
}

/** The candidate and its job, read from the API the studio itself uses. */
async function studioFacts(page, productSlug, token) {
  const studio = await apiCall(page, 'GET', STUDIO_PATH(productSlug), { token });
  expect(studio.status, `the studio read failed: ${JSON.stringify(studio.body)}`).toBe(200);
  const candidate = (studio.body.assets || []).find((a) => a.status === 'CANDIDATE');
  const job = (studio.body.jobs || []).find((j) => j.status === 'READY_FOR_REVIEW');
  expect(candidate, 'the fixture candidate is missing — the stack did not provision it').toBeTruthy();
  expect(job, 'the fixture job is missing — the stack did not provision it').toBeTruthy();
  return { candidate, job };
}

test('FLOW 31 — a PASS candidate shows its metrics and needs no acknowledgement', async ({ page }) => {
  const audit = observe(page);
  await openStudio(page, QUALITY_FIXTURES.pass.productSlug);

  const gate = page.getByTestId('quality-gate');
  await expect(gate).toHaveAttribute('data-quality-decision', 'PASS');

  /* Named, reproducible measurements — never a single unexplained percentage. */
  await expect(gate).toContainText(/Silhouette overlap/i);
  await expect(gate).toContainText(/Aspect error/i);
  await expect(gate).toContainText(/Triangles/i);
  await expect(gate).toContainText(/Matched view/i);

  /* The photograph it was measured against, and how much Phase 1 trusted it. */
  await expect(page.getByTestId('quality-reference')).toContainText(/e2e-fixture-engine/);
  await expect(page.getByTestId('quality-reference')).toContainText(/confidence 0\.95/);

  /* PASS is eligible for normal approval: nothing to acknowledge, nothing to
     override, and the verdict is current. */
  await expect(page.getByTestId('quality-review-note')).toHaveCount(0);
  await expect(page.getByTestId('quality-override-reason')).toHaveCount(0);
  await expect(page.getByTestId('quality-stale')).toHaveCount(0);
  await expect(page.getByTestId('approve-model')).toBeEnabled();

  expect(audit.unexpected().pageErrors).toEqual([]);
});

test('FLOW 32 — a REVIEW candidate explains itself and blocks approval until acknowledged', async ({
  page,
}) => {
  const audit = observe(page);
  await openStudio(page, QUALITY_FIXTURES.review.productSlug);

  const gate = page.getByTestId('quality-gate');
  await expect(gate).toHaveAttribute('data-quality-decision', 'REVIEW');

  /* Reasons and warnings are the server's own codes — a sphere's view really is
     an assumption, and this model really has no texture maps. */
  await expect(page.getByTestId('quality-reasons')).toContainText('SILHOUETTE_VIEW_AMBIGUOUS');
  await expect(page.getByTestId('quality-warnings')).toContainText('MATERIAL_VERTEX_COLOUR');
  await expect(page.getByTestId('quality-material-state')).toContainText(/per vertex/i);
  await expect(page.getByTestId('quality-reference')).toContainText(/e2e-fixture-engine/);

  /* COLOUR, judged apart from shape: this model's colours are stored per vertex
     but it carries no material, so glTF's metallic fallback suppresses them in
     every viewer. The panel has to state that, and the server has to have said
     it — a dark preview with no explanation is the defect this covers. */
  const colour = page.getByTestId('quality-colour');
  await expect(colour).toContainText(/vertex colour/i);
  await expect(colour).toContainText('1.00');
  await expect(page.getByTestId('quality-reasons')).toContainText('MATERIAL_MISSING_DIELECTRIC');

  const approve = page.getByTestId('approve-model');
  const note = page.getByTestId('quality-review-note');
  await expect(note).toBeVisible();
  await expect(approve).toBeDisabled();

  /* A token acknowledgement is not an acknowledgement. */
  await note.fill('nope');
  await expect(approve).toBeDisabled();
  await note.fill('Compared side by side: the outline differs, the lid reads correctly.');
  await expect(approve).toBeEnabled();

  /* And the SERVER holds the same line — the UI's gate is a courtesy. */
  const token = await adminToken(page);
  const { candidate, job } = await studioFacts(page, QUALITY_FIXTURES.review.productSlug, token);
  const unacknowledged = await apiCall(page, 'POST', `/3d/jobs/${job.id}/approve`, {
    body: { assetId: candidate.id },
    token,
  });
  expect(unacknowledged.status).toBe(422);
  expect(unacknowledged.body.code).toBe('QUALITY_REVIEW_REQUIRED');

  /* Nothing was published by the refusal, and nothing was published by the typing. */
  const current = await apiCall(page, 'GET', `/3d/products/${QUALITY_FIXTURES.review.productSlug}/assets/current`, { token });
  expect(current.body.asset).toBeNull();

  expect(audit.unexpected().pageErrors).toEqual([]);
});

test('FLOW 33 — a BLOCKED candidate is refused, needs a real reason to override, and ignores a forged verdict', async ({
  page,
}) => {
  const audit = observe(page);
  const productSlug = QUALITY_FIXTURES.blocked.productSlug;
  await openStudio(page, productSlug);

  const gate = page.getByTestId('quality-gate');
  await expect(gate).toHaveAttribute('data-quality-decision', 'BLOCKED');
  await expect(gate).toContainText(/Normal approval is refused/i);
  await expect(page.getByTestId('quality-reasons')).toContainText('SILHOUETTE_SEVERE_MISMATCH');

  const approve = page.getByTestId('approve-model');
  const reason = page.getByTestId('quality-override-reason');
  await expect(reason).toBeVisible();
  await expect(approve).toBeDisabled();

  const token = await adminToken(page);
  const { candidate, job } = await studioFacts(page, productSlug, token);

  /* An override with a blank reason is refused (the server TRIMS; the UI only
     checks that something was typed, which is why the two must be tested). */
  const blank = await apiCall(page, 'POST', `/3d/jobs/${job.id}/approve`, {
    body: { assetId: candidate.id, overrideQuality: true, overrideReason: '   ' },
    token,
  });
  expect(blank.status).toBe(422);
  expect(blank.body.code).toBe('QUALITY_OVERRIDE_REASON_REQUIRED');

  /* A FABRICATED verdict changes nothing: the request asserts PASS everywhere it
     can, and the server still answers with its own measured verdict. */
  const forged = await apiCall(page, 'POST', `/3d/jobs/${job.id}/approve`, {
    body: {
      assetId: candidate.id,
      quality: 'PASS',
      decision: 'PASS',
      score: 1,
      report: { decision: 'PASS', iou: 1 },
    },
    token,
  });
  expect(forged.status).toBe(422);
  expect(forged.body.code).toBe('QUALITY_BLOCKED');

  /* Neither refusal published anything. */
  const current = await apiCall(page, 'GET', `/3d/products/${productSlug}/assets/current`, { token });
  expect(current.body.asset).toBeNull();
  const assets = await apiCall(page, 'GET', `/3d/products/${productSlug}/assets`, { token });
  expect(assets.body.assets.filter((a) => a.status === 'APPROVED')).toEqual([]);

  /* A real reason DOES unlock the override in the UI. The click is deliberately
     not made: publishing a fixture model onto a catalogue product is not this
     test's business, and the server-side override is proven by
     `npm run test:3d-quality`. */
  await reason.fill('The fixture is a deliberate drill; the real product is regenerated next sprint.');
  await expect(approve).toBeEnabled();

  expect(audit.unexpected().pageErrors).toEqual([]);
});

test('FLOW 34 — a failed assessment and a stale verdict are both shown as what they are', async ({
  page,
}) => {
  const audit = observe(page);

  /* FAILED: the stored model file is genuinely gone, so the assessment could not
     run. That is a REVIEW with a reason, never a silent pass and never a crash. */
  await openStudio(page, QUALITY_FIXTURES.failed.productSlug);
  const failedGate = page.getByTestId('quality-gate');
  await expect(failedGate).toHaveAttribute('data-quality-decision', 'REVIEW');
  await expect(page.getByTestId('quality-reasons')).toContainText('ASSESSMENT_FAILED');
  await expect(failedGate).toContainText(/not measured/i);
  await expect(page.getByTestId('quality-stale')).toHaveCount(0);

  /* STALE: measured, then the generation settings changed. The panel says the
     verdict is out of date rather than passing it off as current. */
  const staleSlug = QUALITY_FIXTURES.stale.productSlug;
  await openStudio(page, staleSlug);
  const staleNote = page.getByTestId('quality-stale');
  await expect(staleNote).toBeVisible();
  await expect(staleNote).toContainText(/out of date/i);

  const token = await adminToken(page);
  const before = await studioFacts(page, staleSlug, token);
  expect(before.candidate.quality.decision).toBe('PASS');
  expect(before.candidate.quality.stale).toBe(true);

  const calls = recordDecisionCalls(page);

  /* Approving re-MEASURES instead of trusting the stored verdict: the asset
     becomes the live model and carries a report with a different fingerprint. */
  await page.getByTestId('approve-model').click();
  try {
    await expect
      .poll(async () => {
        const read = await apiCall(page, 'GET', `/3d/assets/${before.candidate.id}`, { token });
        return read.body?.asset?.status || '';
      }, { timeout: 30_000 })
      .toBe('APPROVED');
  } catch (err) {
    /* A failed approval must say WHY in its own failure: the studio shows the
       server's message, and a bare timeout would hide it. */
    const banner = await page
      .getByTestId('candidate-review')
      .innerText()
      .catch(() => '(the studio showed no message)');
    throw new Error(
      `${err.message}\nThe studio said: ${banner.slice(0, 400)}\nDecision calls: ${JSON.stringify(calls)}`
    );
  }

  const approved = await apiCall(page, 'GET', `/3d/assets/${before.candidate.id}`, { token });
  expect(approved.body.asset.quality.stale).toBe(false);
  expect(approved.body.asset.quality.fingerprint).not.toBe(before.candidate.quality.fingerprint);
  expect(approved.body.asset.quality.assessedAt).not.toBe(before.candidate.quality.assessedAt);

  expect(audit.unexpected().pageErrors).toEqual([]);
});

test('FLOW 35 — rejecting a replacement leaves the live model exactly as it was', async ({ page }) => {
  const audit = observe(page);
  const productSlug = QUALITY_FIXTURES.replacement.productSlug;
  await openStudio(page, productSlug);

  const token = await adminToken(page);
  const before = await apiCall(page, 'GET', `/3d/products/${productSlug}/assets/current`, { token });
  expect(before.body.asset.status).toBe('APPROVED');
  const publicBefore = await apiCall(page, 'GET', `/3d/products/${productSlug}/public`);
  expect(publicBefore.body.product3d.hasModel).toBe(true);
  const { candidate, job } = await studioFacts(page, productSlug, token);

  /* Reject the candidate through the UI, exactly as an operator would. */
  const calls = recordDecisionCalls(page);
  await page.getByTestId('reject-model').click();
  await page.getByPlaceholder(/not good enough/i).fill('The replacement does not match the product.');
  await page.getByRole('button', { name: /confirm rejection/i }).click();
  /* THE DIALOG MUST CLOSE, AND THE SUCCESS MUST BE SHOWN — that is all this
     line may assert, and both assertions are monotonic (once true they stay
     true, whatever the machine speed). Asserting `reject-model` to be visible
     here was wrong twice over: while the reason form is open the button is
     still mounted (so the check passed without proving anything — it could
     pass even if the dialog NEVER closed), and once the rejection lands the
     candidate is no longer reviewable, so the whole review card — button
     included — correctly unmounts, turning the check into a race against
     that unmount. CI lost that race 2/2 (25s timeout with the flash and the
     REJECTED row already on screen) while slower machines won it, including
     yesterday's green run at 2.6s. The server-truth assertions below are the
     ones that carry this flow's name, and they are untouched. */
  await expect(page.getByRole('button', { name: /confirm rejection/i })).toHaveCount(0);
  await expect(page.getByText(/Candidate rejected/i).first()).toBeVisible();
  await expect
    .poll(async () => {
      const assets = await apiCall(page, 'GET', `/3d/products/${productSlug}/assets`, { token });
      return assets.body.assets.find((a) => a.id === candidate.id)?.status || '';
    }, { timeout: 20_000, message: `the rejection never reached the server: ${JSON.stringify(calls)}` })
    .toBe('REJECTED');

  /* Server truth: the candidate is REJECTED and the approved model is untouched —
     same row, same bytes, still public. */
  const after = await apiCall(page, 'GET', `/3d/products/${productSlug}/assets/current`, { token });
  expect(after.body.asset.id).toBe(before.body.asset.id);
  expect(after.body.asset.status).toBe('APPROVED');
  const assets = await apiCall(page, 'GET', `/3d/products/${productSlug}/assets`, { token });
  expect(assets.body.assets.find((a) => a.id === before.body.asset.id).status).toBe('APPROVED');
  const publicAfter = await apiCall(page, 'GET', `/3d/products/${productSlug}/public`);
  expect(publicAfter.body.product3d.id).toBe(publicBefore.body.product3d.id);

  /* The job is settled too: nothing is left half-decided. */
  const jobAfter = await apiCall(page, 'GET', `/3d/jobs/${job.id}`, { token });
  expect(jobAfter.body.job.status).toBe('REJECTED');

  expect(audit.unexpected().pageErrors).toEqual([]);
});

test('FLOW 36 — the studio payload carries no storage paths, workspace ids or credentials', async ({
  page,
}) => {
  const payloads = [];
  page.on('response', async (res) => {
    if (!/\/api\/3d\/products\/[^/]+\/studio/.test(res.url())) return;
    try {
      payloads.push(JSON.stringify(await res.json()));
    } catch {
      /* a body that is not JSON is not a payload this check is about */
    }
  });

  /* This check is about the PAYLOAD, not the panel, so it deliberately does not
     wait for a candidate to be on screen: by the time it runs, FLOW 35 has
     rejected the replacement candidate, and requiring a review panel there would
     couple the two tests for no reason. */
  await signInAdmin(page);
  for (const fixture of [
    QUALITY_FIXTURES.pass,
    QUALITY_FIXTURES.review,
    QUALITY_FIXTURES.blocked,
    QUALITY_FIXTURES.replacement,
  ]) {
    /* The count is captured BEFORE the navigation, so each iteration waits for
       THIS product's payload. Polling the raw total would pass immediately on
       the second product onward and quietly check only the first one. */
    const seen = payloads.length;
    await page.goto(`/admin/products/${fixture.productSlug}`);
    await waitForRouteReady(page);
    await expect
      .poll(() => payloads.length, {
        timeout: 20_000,
        message: `the studio endpoint was never called for ${fixture.productSlug}`,
      })
      .toBeGreaterThan(seen);
  }

  expect(payloads.length, 'the studio endpoint was never called — this check would be vacuous').toBeGreaterThan(0);
  const text = payloads.join('\n');

  /* It has to contain the thing under test, or "no secrets" means nothing. */
  expect(text).toContain('quality');
  expect(text).toContain('CANDIDATE');

  /* Private paths and identity fields. These are NAMES and PATHS, never bare
     words: `MESHY_API_KEY` legitimately appears in the provider's own setup hint
     ("…or set THREE_D_PROVIDER=meshy and MESHY_API_KEY"), which is an instruction the
     administrator is meant to read. Flagging the vocabulary would be a check that
     cannot be satisfied, so the credential question is asked with a real value
     instead — below. */
  for (const forbidden of [
    'storageKey',
    'storageNamespace',
    'workspaceId',
    'passwordHash',
    'mediaRoot',
    'MONGO_URI',
    'JWT_SECRET',
    'RAZORPAY_KEY_SECRET',
    'reference-media',
    '.media-3d',
    'owner-credentials',
  ]) {
    expect(text, `the studio payload leaked "${forbidden}"`).not.toContain(forbidden);
  }

  /* The credential itself. The stack configured this provider key before booting
     the backend, so a payload that echoed its configuration would be caught here
     — and a green run means no response carried it. */
  expect(PROVIDER_SECRET_CANARY.length).toBeGreaterThan(20);
  expect(text, 'a studio payload echoed the configured provider credential').not.toContain(
    PROVIDER_SECRET_CANARY
  );
});
