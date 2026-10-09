/**
 * PHASE 4 — shared E2E support.
 *
 * Everything here is deliberate about one thing: the suite must talk to the
 * REAL stack. Identities come from the backend seed fixtures (which only exist
 * in a disposable test database), sign-in runs through the real form, and the
 * API helpers hit the real HTTP endpoints — nothing is stubbed, so a green run
 * is evidence about the deployed application rather than about a mock.
 */

import { expect } from '@playwright/test';

/* The demo identities come from the seed's single definition. Copying the
   password literals here would create a second copy of a fixture credential in
   source, which the production-safety rules forbid. */
import { DEMO_CUSTOMER, DEMO_HANDLER } from '../../../backend/seed/fixtures.js';

export const API_URL = process.env.E2E_API_URL || 'http://127.0.0.1:4000/api';

/** Identities and catalogue rows created by backend/seed/seed.js. */
export const SEED = {
  customer: { email: DEMO_CUSTOMER.email, password: DEMO_CUSTOMER.password },
  /* A second, unrelated person — used to prove customer isolation. */
  otherCustomer: { email: 'aarav.mehta@example.com' },
  admin: { email: DEMO_HANDLER.email, password: DEMO_HANDLER.password },
  product: { slug: 'dusty-rose-lavender-posy', name: /Dusty Rose/i },
  productAlt: { slug: 'vintage-peony-eucalyptus-posy', name: /Peony/i },
  collection: 'festival-collection',
  order: {
    /* aarav.mehta@example.com — delivered */
    delivered: 'FA-0912',
    /* priya.sharma@example.com — in production */
    inProduction: 'FA-1024',
  },
};

/**
 * Every storage key that can make a scope look authenticated. Cleared before
 * each test so a bag or session can never leak between journeys.
 */
const STORAGE_PREFIX = 'flora_alchemy';

export async function freshVisitor(page) {
  await page.addInitScript((prefix) => {
    try {
      /* ONCE per browser context. An init script runs on EVERY document, and
         wiping the bag on each navigation would destroy the very journey under
         test (a real visitor's bag survives navigation). The sessionStorage
         sentinel gives each test a clean visitor and then leaves their bag
         alone. */
      if (window.sessionStorage.getItem('__flora_e2e_isolated') === '1') return;
      window.sessionStorage.setItem('__flora_e2e_isolated', '1');
      Object.keys(window.localStorage)
        .filter((k) => k.startsWith(prefix))
        .forEach((k) => window.localStorage.removeItem(k));
    } catch {
      /* storage unavailable — nothing to clear */
    }
  }, STORAGE_PREFIX);
}

/**
 * Wait until the ROUTE GATE has settled before asserting on page content.
 *
 * The gate renders a content-shaped skeleton while a route's own data is in
 * flight, and that skeleton contains no text. Reading `main` without waiting
 * therefore asserts on a skeleton and reports "empty page" for a page that is
 * merely still loading — a flake that looks exactly like a broken route. This
 * waits for the skeleton to be gone, and fails loudly if the route instead
 * landed on the connection-error state (which would be a real failure, not a
 * slow one).
 */
export async function waitForRouteReady(page, { timeout = 30_000 } = {}) {
  await expect(page.locator('main')).toBeVisible({ timeout });

  /* Readiness is defined by CONTENT, not by the absence of a skeleton. A route
     component is a lazy chunk: while that chunk is still loading `main` is
     simply empty, and the route's own gate (which owns the skeleton) has not
     mounted yet — so "no skeleton" is true on an empty page. Polling the
     property under test is the only version that cannot pass early. */
  await expect
    .poll(async () => (await page.locator('main').innerText()).trim().length, {
      timeout,
      message: 'the route never rendered any content',
    })
    .toBeGreaterThan(10);

  /* A route that settled on the connection state is a real failure, not a slow
     one, so it must not be reported as "ready". */
  await expect(
    page.getByRole('heading', { name: /couldn.t reach the studio server/i }),
    'the route gate settled on a connection error instead of content'
  ).toHaveCount(0);
}

/**
 * The header bag badge is the application's OWN receipt that a line was
 * accepted into the bag — asserted before navigating, so the suite never
 * mistakes a dropped request for a slow render.
 */
export async function expectBagItems(page, count) {
  await expect(
    page.getByRole('link', { name: new RegExp(`Shopping Bag, ${count} items`) })
  ).toBeVisible({ timeout: 20_000 });
}

/**
 * Sign a customer in through the real form. Returns after the app has settled
 * on the requested destination.
 */
export async function signInCustomer(page, { redirect } = {}) {
  await page.goto(redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login');
  await page.locator('input[type="email"]').fill(SEED.customer.email);
  await page.locator('input[type="password"]').fill(SEED.customer.password);
  await page.getByRole('button', { name: /Sign In to Account/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

export async function signInAdmin(page) {
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(SEED.admin.email);
  await page.locator('input[type="password"]').fill(SEED.admin.password);
  await page.getByRole('button', { name: /sign in|enter|continue/i }).first().click();
  await page.waitForURL(/\/admin|\/owner|\/staff/, { timeout: 20_000 });
}

/* ───────────────────────────── API helpers ────────────────────────────── */

/**
 * Raw authenticated fetch against the real backend, executed from the browser
 * so the request carries the page's own Origin (and therefore exercises CORS
 * the way a customer's browser would).
 */
export async function apiCall(page, method, path, { body, token } = {}) {
  /* The request runs IN the page, so the page needs the app's own origin: from
     `about:blank` the fetch is cross-origin with an opaque `Origin: null`, the
     API's CORS policy (correctly) refuses it, and the caller sees
     "TypeError: Failed to fetch" instead of the status under test. */
  if (!/^https?:/.test(page.url())) {
    await page.goto('/');
  }
  return page.evaluate(
    async ({ apiUrl, method: m, path: p, body: b, token: t }) => {
      const res = await fetch(`${apiUrl}${p}`, {
        method: m,
        headers: {
          'Content-Type': 'application/json',
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
        },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* non-JSON body */
      }
      return { status: res.status, body: json };
    },
    { apiUrl: API_URL, method, path, body, token }
  );
}

/* ────────────────────────── observability ─────────────────────────────── */

/**
 * Collect console errors, page errors and failed requests for the lifetime of
 * a test. Phase 4 requires classifying these rather than ignoring them.
 */
export function observe(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText || 'failed'}`);
  });

  return {
    consoleErrors,
    pageErrors,
    failedRequests,
    /** Errors that are not explainable by the app being probed for failure. */
    unexpected() {
      const expected = /favicon|ERR_ABORTED|net::ERR_NETWORK_IO_SUSPENDED/i;
      return {
        consoleErrors: consoleErrors.filter((m) => !expected.test(m)),
        pageErrors: pageErrors.filter((m) => !expected.test(m)),
        failedRequests: failedRequests.filter((m) => !expected.test(m)),
      };
    },
  };
}

/* ───────────────────────────── navigation ─────────────────────────────── */

/** Add the seeded primary product to the bag from the product page itself. */
export async function addSeededProductToBag(page, { qty } = {}) {
  await page.goto(`/product/${SEED.product.slug}`);
  const cta = page.getByRole('button', { name: /Add to Bag/i }).first();
  await cta.waitFor({ state: 'visible' });
  if (qty && qty > 1) {
    for (let i = 1; i < qty; i += 1) {
      await page.getByRole('button', { name: 'Increase quantity' }).click();
    }
  }
  await cta.click();
}
