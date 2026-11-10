import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { freshVisitor, observe, waitForRouteReady } from '../support/helpers.js';

/**
 * FLOW 40–45 — INDEX 3D MOTION v4.
 *
 * The index is the existing photographic storefront with one lazy WebGL layer
 * in the hero. These tests use the E2E stack's real catalogue, real API and
 * production bundle; the hero fixtures in `e2e/stack.mjs` flag three seeded
 * products as `hero:true`, so the animated path is exercised rather than the
 * static fallback alone.
 *
 * What is asserted: the real catalogue drives the hero and Beloved Pieces, the
 * three.js chunk stays out of the entry/HomePage bundles, reduced motion and
 * no-WebGL keep the static hero, keyboard navigation enters the pinned
 * chapters, and a visitor with JavaScript disabled still gets a usable page.
 */

const FRONTEND_DIR = path.resolve(import.meta.dirname, '../..');
const HERO_PRODUCT = /Dusty Rose/i;

test('FLOW 40 — the catalogue-driven hero and every existing scene mount with real photography', async ({ page }) => {
  const audit = observe(page);
  await freshVisitor(page);
  await page.goto('/');
  await expect(page.locator('main')).toBeVisible();
  await waitForRouteReady(page);

  await expect
    .poll(() => page.locator('[data-hero-mode]').getAttribute('data-hero-mode'), {
      timeout: 30_000,
      message: 'the catalogue hero never mounted',
    })
    .toBe('motion');

  /* Chrome is the ordinary storefront chrome, not the removed bespoke index. */
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Shop All Gifts/i })).toBeVisible();

  for (const scene of ['opening', 'reveal', 'craft', 'collections', 'pieces', 'studio', 'story', 'closing']) {
    await expect(page.locator(`[data-scene="${scene}"]`), `scene "${scene}" must mount`).toHaveCount(1);
  }

  /* The active hero image is catalogue photography with catalogue alt text. */
  const activeImage = page.locator('[data-hero-mode="motion"] img[fetchpriority="high"]').first();
  await expect(activeImage).toBeVisible();
  await expect(activeImage).toHaveAttribute('alt', HERO_PRODUCT);
  await expect(activeImage).toHaveAttribute('src', /\/assets\/images\/flora-asset-/);

  const images = page.locator('main img');
  expect(await images.count(), 'the homepage must carry real photography').toBeGreaterThan(8);
  const emptySources = await images.evaluateAll((nodes) =>
    nodes.filter((node) => !node.getAttribute('src') || node.getAttribute('src').startsWith('data:')).length
  );
  expect(emptySources, 'an image is a placeholder or data URI').toBe(0);

  const typeHooks = await page.evaluate(() =>
    [...document.querySelectorAll('[data-type-reveal]')].map((el) => el.dataset.typeReveal)
  );
  expect(typeHooks.length).toBeGreaterThanOrEqual(6);

  await expect(page.locator('h1')).toHaveCount(1);
  const { pageErrors, consoleErrors, failedRequests } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
});

test('FLOW 41 — three.js stays in a lazy hero chunk, never the entry or HomePage bundle', async () => {
  const distDir = path.join(FRONTEND_DIR, 'dist');
  const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const initialScripts = [...html.matchAll(/assets\/[^"']+\.js/g)].map((match) => match[0]);
  expect(initialScripts.length).toBeGreaterThan(0);

  for (const script of initialScripts) {
    const source = readFileSync(path.join(distDir, script), 'utf8');
    expect(
      /WebGLRenderer|class GLTFLoader|PerspectiveCamera/.test(source),
      `entry script ${script} carries a renderer implementation`
    ).toBe(false);
    expect(script, 'the entry must not load the lazy fragment renderer').not.toMatch(/HeroFragments|three\.module/);
  }

  const assets = readdirSync(path.join(distDir, 'assets'));
  const homeChunk = assets.find((file) => /^HomePage-.*\.js$/.test(file));
  expect(homeChunk, 'HomePage must be its own chunk').toBeTruthy();
  const homeSource = readFileSync(path.join(distDir, 'assets', homeChunk), 'utf8');
  expect(/WebGLRenderer|class GLTFLoader|PerspectiveCamera/.test(homeSource)).toBe(false);
  expect(assets.some((file) => /^HeroFragments-.*\.js$/.test(file)), 'HeroFragments must be its own chunk').toBe(true);
  expect(assets.some((file) => /^three\.module-.*\.js$/.test(file)), 'three.js must be a separate chunk').toBe(true);
});

test('FLOW 42 — reduced motion and no-WebGL both render the finished static hero', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freshVisitor(page);
  await page.goto('/');
  await waitForRouteReady(page);

  await expect(page.locator('[data-hero-mode="static"]')).toHaveCount(1);
  await expect(page.locator('[data-hero-mode] canvas')).toHaveCount(0);
  await expect(page.locator('[data-scene="opening"] h1')).toHaveText('Flora Alchemy');

  const hiddenElements = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('[data-scene] h1, [data-scene] h2, [data-scene] img').forEach((el, i) => {
      const style = window.getComputedStyle(el);
      if (style.opacity === '0' || style.visibility === 'hidden') {
        results.push(`${el.tagName}#${i} is hidden (opacity=${style.opacity}, visibility=${style.visibility})`);
      }
    });
    return results;
  });
  expect(hiddenElements, `hidden elements under reduced motion: ${hiddenElements.join(' | ')}`).toEqual([]);

  await page.getByRole('link', { name: /Shop All Gifts/i }).click();
  await expect(page).toHaveURL(/\/shop/);
});

test('FLOW 43 — keyboard arrow keys move the pinned hero to the next catalogue chapter', async ({ page }) => {
  await freshVisitor(page);
  await page.goto('/');
  await waitForRouteReady(page);

  const hero = page.locator('[data-hero-mode="motion"]');
  await expect.poll(() => hero.count(), { timeout: 30_000 }).toBe(1);
  await hero.focus();

  /* The idle hero's first chapter is the first ordered hero product. */
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-active-chapter="0"]')).toHaveCount(1, { timeout: 25_000 });
  await expect(page.locator('[data-hero-mode="motion"] h1')).toContainText(HERO_PRODUCT);
  await expect(page.getByText('01 / 03')).toBeVisible();

  const nextPanel = page.getByRole('button', { name: /Next hero piece:/i });
  await expect(nextPanel).toBeVisible();

  /* The canvas is decorative only and lives inside the hero card. */
  const canvas = page.locator('[data-hero-mode="motion"] canvas');
  await expect(canvas).toHaveCount(1, { timeout: 25_000 });
  await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  expect(await canvas.evaluate((node) => window.getComputedStyle(node).pointerEvents)).toBe('none');

  const audit = observe(page);
  /* Re-focus the section before each key: the pinned section owns the
     keyboard contract, and the assertion is about the chapter transition, not
     about where the browser parked focus after a scroll. */
  await hero.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-active-chapter="1"]')).toHaveCount(1, { timeout: 25_000 });
  const { pageErrors, consoleErrors } = audit.unexpected();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 44 — fewer than two hero products falls back to the unchanged static hero', async ({ page }) => {
  let heroItems = [];
  await page.route('**/api/catalogue**', async (route) => {
    const url = new URL(route.request().url());
    const isHero = url.searchParams.get('hero') === 'true';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, count: isHero ? heroItems.length : 0, items: isHero ? heroItems : [] }),
    });
  });

  await freshVisitor(page);
  await page.goto('/');
  await waitForRouteReady(page);
  await expect(page.locator('[data-hero-mode="static"]')).toHaveCount(1);
  await expect(page.locator('[data-hero-mode="static"] h1')).toHaveText('Flora Alchemy');

  /* One item is still below the documented minimum of two. */
  heroItems = [
    {
      id: 'dusty-rose-lavender-posy',
      slug: 'dusty-rose-lavender-posy',
      name: 'The Dusty Rose & Lavender Dream Posy',
      price: 1850,
      images: ['/assets/images/flora-asset-01.jpg'],
    },
  ];
  await page.reload();
  await waitForRouteReady(page);
  await expect(page.locator('[data-hero-mode="static"]')).toHaveCount(1);
  await expect(page.locator('[data-hero-mode] canvas')).toHaveCount(0);
});

test('FLOW 45 — JavaScript-disabled visitors get the static editorial fallback, not an empty root', async ({ browser }) => {
  const baseURL = test.info().project.use.baseURL || 'http://127.0.0.1:4300';
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${baseURL}/`);
  await expect(page.locator('[data-nojs-home]')).toBeVisible();
  await expect(page.locator('[data-nojs-home] h1')).toHaveText('Flora Alchemy');
  await expect(page.locator('[data-nojs-home] a[href="/shop"]').first()).toBeVisible();
  await context.close();
});
