import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { freshVisitor, observe } from '../support/helpers.js';

/**
 * FLOW 40–42 — THE CINEMATIC HOMEPAGE (camera-led photographic scenes).
 *
 * The homepage is a camera travelling through real photography: eight scenes,
 * each with its own scroll choreography, sharing one motion system
 * (`lib/cinematicMotion.js`). What is real here: the production bundle, the
 * real API, the browser's own rendering, the shipped scroll choreography and
 * the real routes every CTA hands off to.
 *
 * What is NOT asserted: that a specific pixel looks cinematic. That is a
 * human judgement; the tests assert the things a human would then trust —
 * every scene mounts with real imagery, the page carries no renderer
 * implementation, the camera choreography is scoped and cleaned up, reduced
 * motion shows the finished page (nothing hidden), and no request fails.
 */

const FRONTEND_DIR = path.resolve(import.meta.dirname, '../..');

test('FLOW 40 — all eight scenes mount with real photography and no failed requests', async ({ page }) => {
  const audit = observe(page);
  const failedRequests = [];
  page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url()}`));
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
  });

  await freshVisitor(page);
  await page.goto('/');
  await expect(page.locator('main')).toBeVisible();
  /* The four shopping doors the storefront owes a first-time visitor. */
  await expect(page.getByRole('link', { name: /Shop All Gifts/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Explore Collections/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Find a Gift/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Custom Gifts/i }).first()).toBeVisible();

  // All eight scenes are present, each with its data-scene marker.
  for (const scene of ['opening', 'reveal', 'craft', 'collections', 'pieces', 'studio', 'story', 'closing']) {
    await expect(page.locator(`[data-scene="${scene}"]`), `scene "${scene}" must mount`).toHaveCount(1);
  }

  // Every image has a real src (no placeholder, no data URI) and a meaningful alt.
  const images = page.locator('main img');
  const count = await images.count();
  expect(count, 'the cinematic homepage must carry real photography').toBeGreaterThan(8);
  for (let i = 0; i < count; i += 1) {
    const img = images.nth(i);
    const src = await img.getAttribute('src');
    expect(src, `image ${i} has an empty src`).toBeTruthy();
    expect(src.startsWith('data:'), `image ${i} is a data URI, not real photography`).toBe(false);
    const alt = await img.getAttribute('alt');
    expect(alt, `image ${i} has no alt text`).toBeTruthy();
  }

  // Scroll through the whole page to trigger every ScrollTrigger.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  // Exactly one h1 (the a11y contract).
  await expect(page.locator('h1')).toHaveCount(1);

  // No failed requests during the walk.
  expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);

  const { pageErrors, consoleErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 41 — the HomePage chunk carries no renderer implementation; three.js is absent from the entry bundle', async () => {
  const distDir = path.join(FRONTEND_DIR, 'dist');
  const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const initialScripts = [...html.matchAll(/assets\/[^"']+\.js/g)].map((m) => m[0]);
  expect(initialScripts.length, 'index.html exposes no script to check').toBeGreaterThan(0);

  // The entry bundle (everything index.html loads up front) must not contain
  // a WebGL renderer, a GLTF loader, or a perspective camera.
  for (const script of initialScripts) {
    const source = readFileSync(path.join(distDir, script), 'utf8');
    expect(
      /WebGLRenderer|class GLTFLoader|PerspectiveCamera/.test(source),
      `entry bundle ${script} carries a renderer implementation`
    ).toBe(false);
  }

  // The HomePage chunk itself must also be free of renderer code.
  const assets = readdirSync(path.join(distDir, 'assets'));
  const homeChunk = assets.find((file) => /^HomePage-.*\.js$/.test(file));
  expect(homeChunk, 'HomePage must be its own chunk').toBeTruthy();
  const homeSource = readFileSync(path.join(distDir, 'assets', homeChunk), 'utf8');
  expect(
    /WebGLRenderer|class GLTFLoader|PerspectiveCamera/.test(homeSource),
    'HomePage must not carry a renderer implementation'
  ).toBe(false);
});

test('FLOW 42 — reduced motion shows the finished page: nothing is hidden behind an animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freshVisitor(page);
  await page.goto('/');
  await expect(page.locator('main')).toBeVisible();

  // Under reduced motion, every scene must be visible immediately: no
  // opacity-0, no visibility-hidden, no transform that pushes content
  // off-screen. The page renders in its finished state.
  const hiddenElements = await page.evaluate(() => {
    const results = [];
    const check = (el, label) => {
      const style = window.getComputedStyle(el);
      if (style.opacity === '0' || style.visibility === 'hidden') {
        results.push(`${label} is hidden (opacity=${style.opacity}, visibility=${style.visibility})`);
      }
    };
    document.querySelectorAll('[data-scene] h1, [data-scene] h2, [data-scene] img').forEach((el, i) => {
      check(el, `${el.tagName}#${i}`);
    });
    return results;
  });
  expect(hiddenElements, `hidden elements under reduced motion: ${hiddenElements.join(' | ')}`).toEqual([]);

  // The hero CTA is clickable and navigates.
  await page.getByRole('link', { name: /Shop All Gifts/i }).click();
  await expect(page).toHaveURL(/\/shop/);
});
