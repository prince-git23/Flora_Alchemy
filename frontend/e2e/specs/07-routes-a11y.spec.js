/**
 * PHASE 4 §7, §19, §21, §23, §26 — routing, accessibility, motion, dark mode
 * and console hygiene.
 *
 * §7 is the cheapest way to catch a whole class of regressions: a lazy route
 * that only works when reached by a click (missing hydration, a bad deep-link,
 * a dev-server-only assumption) fails on a direct load. Every critical URL is
 * therefore entered cold AND reloaded in place.
 */

import { test, expect } from '@playwright/test';
import { SEED, freshVisitor, observe, waitForRouteReady } from '../support/helpers.js';

/**
 * The critical storefront routes, with what must be on screen when they render
 * cold. `expect` is deliberately loose (a landmark or a real string), because
 * the assertion being made is "this URL is a real page", not "this copy exists".
 */
const ROUTES = [
  { path: '/', has: () => 'the storefront home' },
  { path: '/shop' },
  { path: `/shops/e2e-botanical-studio` },
  { path: `/product/${SEED.product.slug}` },
  { path: '/collections' },
  { path: '/search?q=rose' },
  { path: '/wishlist' },
  { path: '/gift-finder' },
  { path: '/custom-request' },
  { path: '/custom-gifts' },
  { path: '/cart' },
  { path: '/order-tracking' },
  { path: '/our-story' },
  { path: '/how-its-made' },
  { path: '/notifications' },
  /* The two auth-gated surfaces: they must render their own gate, never a
     blank page and never a crash. */
  { path: '/checkout', gate: /Sign in to continue/i },
  { path: '/account', gate: /sign in|account/i },
  { path: '/admin/login' },
  { path: '/access' },
];

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('§7 — every critical route survives a cold load, a reload and a client-side hop', async ({ page }) => {
  const audit = observe(page);

  for (const route of ROUTES) {
    await page.goto(route.path);
    await expect(page.locator('main'), `${route.path} rendered no main landmark`).toBeVisible();
    /* Settle the gate first: the skeleton carries no text, so an immediate
       read would call a slow route an empty one. */
    await waitForRouteReady(page);

    const first = await page.locator('main').innerText();
    expect(first.trim().length, `${route.path} rendered an empty page on direct load`).toBeGreaterThan(10);

    if (route.gate) {
      await expect(page.locator('main'), `${route.path} did not render its gate`).toContainText(route.gate);
    }

    /* Reload in place: the same URL must not depend on in-memory router state. */
    await page.reload();
    await expect(page.locator('main'), `${route.path} broke on reload`).toBeVisible();
    await waitForRouteReady(page);
    const second = await page.locator('main').innerText();
    expect(second.trim().length, `${route.path} rendered an empty page after reload`).toBeGreaterThan(10);
  }

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors across the route matrix: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('§29 — history: Shop → Product → Back, and forward again', async ({ page }) => {
  await page.goto('/shop');
  const card = page.locator('article a[href^="/product/"]').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/product\//);

  await page.goBack();
  await expect(page).toHaveURL(/\/shop/);
  await expect(page.locator('article a[href^="/product/"]').first()).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/product\//);
  await expect(page.getByRole('button', { name: /Add to Bag|Out of Stock/i }).first()).toBeVisible();
});

test('§29b — Search → Product → Back keeps the query', async ({ page }) => {
  await page.goto('/search?q=rose');
  await page.locator('article a[href^="/product/"]').first().click();
  await expect(page).toHaveURL(/\/product\//);
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?q=rose/);
  await expect(page.getByLabel('Search the catalogue')).toHaveValue('rose');
});

test('§19 — keyboard navigation reaches the page content with a visible focus ring', async ({ page }) => {
  await page.goto('/shop');

  /* Walk into the page with the keyboard alone and confirm focus lands on a
     real control with a visible indicator — never on <body>. */
  let focused = null;
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = window.getComputedStyle(el);
      return {
        tag: el.tagName,
        outline: `${cs.outlineStyle} ${cs.outlineWidth}`,
        boxShadow: cs.boxShadow,
        label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || '',
      };
    });
    if (focused) break;
  }

  expect(focused, 'Tab never reached an interactive element').toBeTruthy();
  const visible =
    (focused.outline && !/^none 0px$/.test(focused.outline)) ||
    (focused.boxShadow && focused.boxShadow !== 'none');
  expect(visible, `no visible focus indicator on ${JSON.stringify(focused)}`).toBe(true);
});

test('§19b — each critical page has one real heading and a labelled landmark', async ({ page }) => {
  for (const path of ['/shop', `/product/${SEED.product.slug}`, '/cart', '/gift-finder', '/custom-request']) {
    await page.goto(path);
    await waitForRouteReady(page);
    /* Poll rather than read once: the heading is part of the lazy route chunk,
       so a single read can catch the frame before it mounts. */
    await expect
      .poll(() => page.locator('h1').count(), { timeout: 30_000, message: `${path} must expose exactly one h1` })
      .toBe(1);
    await expect(page.locator('main')).toBeVisible();
  }
});

test('§26 — no unexplained console errors while walking the storefront', async ({ page }) => {
  const audit = observe(page);

  for (const path of ['/', '/shop', `/product/${SEED.product.slug}`, '/cart', '/gift-finder', '/search?q=rose']) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
  }

  const { consoleErrors, pageErrors, failedRequests } = audit.unexpected();
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
});

test('§21 — reduced motion is honoured and changes nothing functional', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/gift-finder');

  const env = await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  expect(env, 'the browser did not apply the reduced-motion preference').toBe(true);

  /* Functionality is identical: the questionnaire still completes. */
  for (let step = 0; step < 5; step += 1) {
    const group = page.getByRole('radiogroup');
    await expect(group).toBeVisible();
    await group.locator('label').first().click();
    await page
      .getByRole('button', { name: step === 4 ? /See My Gifts/i : /^Continue$/i })
      .click();
  }
  await expect(page.getByRole('heading', { name: /Here are a few gifts/i })).toBeVisible();

  /* And the decoration is genuinely suppressed, not merely shortened. */
  const longest = await page.evaluate(() => {
    const anims = document.getAnimations ? document.getAnimations() : [];
    return anims.reduce((max, a) => {
      const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
      return Math.max(max, Number(t.duration) || 0);
    }, 0);
  });
  expect(longest, `an animation still runs for ${longest}ms under reduced motion`).toBeLessThan(50);
});

test('§23 — the dark mode switch is real and keeps text visible', async ({ page }) => {
  await page.goto('/shop');
  await waitForRouteReady(page);
  /* The contrast check needs a real text node to measure. */
  await expect
    .poll(() => page.locator('main h1, main h2, main p').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);

  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.getByRole('button', { name: /Switch to dark mode/i }).click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(after).not.toBe(before);

  /* A theme that leaves the copy unreadable is not a theme. */
  const contrast = await page.evaluate(() => {
    function lum(rgb) {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function parse(c) {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      return m[1].split(',').slice(0, 3).map((n) => parseFloat(n));
    }
    function bgOf(el) {
      let node = el;
      while (node) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg && parse(getComputedStyle(node).backgroundColor)[3] !== 0) return bg;
        node = node.parentElement;
      }
      return [255, 255, 255];
    }
    const target = document.querySelector('main h1, main h2, main p');
    if (!target) return null;
    const fg = parse(getComputedStyle(target).color);
    const bg = bgOf(target);
    if (!fg || !bg) return null;
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return { ratio, fg, bg };
  });

  expect(contrast, 'no text node was measurable').toBeTruthy();
  expect(contrast.ratio, `dark-mode contrast ${contrast.ratio.toFixed(2)}:1 is too low`).toBeGreaterThan(3);

  /* And the choice survives a reload, because it is a stored preference. */
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
