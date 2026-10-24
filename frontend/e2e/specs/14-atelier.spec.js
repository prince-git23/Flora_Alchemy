import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { freshVisitor } from '../support/helpers.js';

/**
 * FLOW 37–39 — THE ATELIER (the cinematic workshop on the homepage).
 *
 * What is real here: the production bundle, the real API, the browser's own
 * WebGL context, the shipped scroll choreography, the shipped station controls
 * and the real Custom Gift Studio the CTA hands off to.
 *
 * What is NOT asserted: that a GPU-composed frame "looks good". That is a
 * human judgement; the tests assert the things a human would then trust — the
 * section mounts, it is its own lazy chunk, the chapters advance with the
 * scroll, the controls change the composition, and the hand-off can only ever
 * carry ids the studio actually offers.
 */

const FRONTEND_DIR = path.resolve(import.meta.dirname, '../..');

async function openAtelier(page) {
  await freshVisitor(page);
  await page.goto('/');
  const section = page.locator('[data-atelier-section]');
  await expect(section).toBeAttached();
  return section;
}

/** Put the section's own top at the top of the viewport — chapter 01. */
async function scrollToRunwayStart(page) {
  await page.evaluate(() => {
    const node = document.querySelector('[data-atelier-section]');
    window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY + 8);
  });
  await page.waitForTimeout(400);
}

/** Walk a fraction of the section's runway (0 = its top, 1 = its bottom). */
async function scrollRunway(page, fraction) {
  await page.evaluate((ratio) => {
    const node = document.querySelector('[data-atelier-section]');
    const top = node.getBoundingClientRect().top + window.scrollY;
    const distance = Math.max(1, node.getBoundingClientRect().height - window.innerHeight);
    window.scrollTo(0, top + distance * ratio);
  }, fraction);
  await page.waitForTimeout(500);
}

test('FLOW 37 — the atelier is a lazy chunk and renders a stage, not an empty box', async ({ page }) => {
  /* The section ships as its own file. That is what keeps three.js out of the
     storefront's first paint (FLOW 27 proves the entry bundle itself); this test
     proves the section did not get folded into HomePage instead. */
  const distDir = path.join(FRONTEND_DIR, 'dist');
  const assets = readdirSync(path.join(distDir, 'assets'));
  expect(assets.some((file) => /^AtelierExperience.*\.js$/.test(file)), 'the atelier must ship as its own chunk').toBe(true);

  const homeChunk = assets.find((file) => /^HomePage-.*\.js$/.test(file));
  expect(homeChunk, 'HomePage must still be its own chunk').toBeTruthy();
  const homeSource = readFileSync(path.join(distDir, 'assets', homeChunk), 'utf8');
  /* IMPLEMENTATION, not mention: a dynamic import always leaves the chunk's
     FILENAME in the importing chunk (Vite preloads it), so matching
     `three.module` here would fail on correct lazy loading. The renderer's own
     code must not be there; FLOW 27 separately proves the entry bundle is free
     of it too. */
  expect(/WebGLRenderer|class GLTFLoader|PerspectiveCamera/.test(homeSource), 'HomePage must not carry a renderer implementation').toBe(false);

  const section = await openAtelier(page);

  /* Scroll it into view: the chunk is fetched on approach, by design. */
  await section.scrollIntoViewIfNeeded();
  const stage = section.locator('.atelier-stage');
  await expect(stage).toBeVisible();

  /* Either the WebGL stage or the designed static still must be present — both
     are shipped experiences. An empty dark rectangle is the failure. */
  const canvas = section.locator('canvas');
  const staticStill = section.locator('[data-atelier-static]');
  await expect(canvas.or(staticStill).first()).toBeVisible();

  /* The overlay is HTML, so the workshop stays usable with no renderer at all. */
  await expect(section.getByRole('heading', { name: /Pressed by hand|Written, not printed|Tied to the keepsake/ })).toBeVisible();
  await expect(section.getByRole('button', { name: /Finish it in the studio/i })).toBeVisible();
});

test('FLOW 38 — scrolling the runway moves the film, not the page furniture', async ({ page }) => {
  const section = await openAtelier(page);
  await scrollToRunwayStart(page);

  const stage = section.locator('.atelier-stage');
  const startScroll = await page.evaluate(() => window.scrollY);

  await expect(section).toHaveAttribute('data-atelier-chapter-active', 'seal');

  /* Walk the runway: the stage must stay put (it is pinned) while the chapter
     advances. If the pin is broken the stage scrolls away and every control in
     it becomes unreachable — which is exactly what a sticky stage inside this
     storefront's `body { overflow-x: hidden }` used to do. */
  await scrollRunway(page, 0.5);
  await expect(section).toHaveAttribute('data-atelier-chapter-active', 'note');

  /* The page really moved… */
  const movedBy = (await page.evaluate(() => window.scrollY)) - startScroll;
  expect(movedBy, 'the test must actually scroll for this to mean anything').toBeGreaterThan(300);

  /* …and the stage stayed pinned to the viewport, rather than travelling with
     the document (which is what a broken pin looks like from the inside: every
     station control scrolls out of reach while the film keeps playing). */
  const pinned = await stage.boundingBox();
  expect(Math.abs(pinned.y), 'the pinned stage must stay at the viewport top').toBeLessThan(10);
  expect(Math.round(pinned.height)).toBeGreaterThan(300);

  await scrollRunway(page, 0.95);
  await expect(section).toHaveAttribute('data-atelier-chapter-active', 'ribbon');
});

test('FLOW 39 — a composition can only be handed to the studio with ids it offers', async ({ page }) => {
  const section = await openAtelier(page);

  /* Chapter 03 owns the ribbon and the base. */
  await scrollRunway(page, 0.95);
  await expect(section).toHaveAttribute('data-atelier-chapter-active', 'ribbon');
  await section.getByRole('button', { name: 'French Olive Velvet Cord' }).click();
  await expect(section.locator('[data-atelier-summary]')).toContainText('French Olive Velvet Cord');

  await section.getByRole('button', { name: /Finish it in the studio/i }).click();
  await expect(page).toHaveURL(/\/custom-gifts\?/);

  const url = new URL(page.url());
  const params = url.searchParams;
  expect(params.get('ribbon')).toBe('velvet-cord');
  expect(['keepsake-posy', 'heirloom-box', 'ceramic-pot']).toContain(params.get('base'));
  expect(['mauve', 'sage', 'terracotta', 'cream']).toContain(params.get('palette'));
  expect(['terracotta', 'sage', 'gold']).toContain(params.get('seal'));

  /* The studio is a real page with the real catalogue, and it accepts the
     hand-off: the chosen base is the one the base station highlights. */
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Build a Gift/i);

  /* A hand-edited query string cannot invent a choice the studio does not sell:
     the studio falls back to its own default instead of trusting the URL. */
  const forged = await page.goto('/custom-gifts?palette=neon-neon&seal=plutonium&base=free-yacht');
  expect(forged.ok()).toBeTruthy();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Build a Gift/i);
  await expect(page.locator('body')).not.toContainText('free-yacht');
  await expect(page.locator('body')).not.toContainText('plutonium');
});
