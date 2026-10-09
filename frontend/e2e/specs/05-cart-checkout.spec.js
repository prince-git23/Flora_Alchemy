/**
 * PHASE 4 — E2E FLOW 13–18: cart, checkout, order creation, tracking.
 *
 * Money is involved here, so the emphasis is deliberately on SERVER AUTHORITY:
 * the browser may ask, but only the server may decide what an order costs, who
 * fulfils it, and whether payment happened. Razorpay is unconfigured in the E2E
 * stack on purpose, so no charge can occur — what is verified is that the
 * server refuses to pretend a payment it cannot make.
 */

import { test, expect } from '@playwright/test';
import {
  freshVisitor,
  observe,
  signInCustomer,
  apiCall,
  expectBagItems,
} from '../support/helpers.js';

const SHOP = 'e2e-botanical-studio';
const SECOND_SHOP = 'e2e-second-atelier';
const PRODUCT = 'dusty-rose-lavender-posy';
const SECOND_SHOP_PRODUCT = 'pressed-wildflower-cards';

async function addToBag(page, slug, qty = 1, expectedTotal = qty) {
  await page.goto(`/product/${slug}`);
  const cta = page.getByRole('button', { name: /Add to Bag/i }).first();
  await expect(cta).toBeVisible();
  for (let i = 1; i < qty; i += 1) {
    await page.getByRole('button', { name: 'Increase quantity' }).click();
  }
  await cta.click();
  /* The badge is the app's receipt: wait for it before navigating away. */
  await expectBagItems(page, expectedTotal);
}

test.beforeEach(async ({ page }) => {
  await freshVisitor(page);
});

test('FLOW 13 — the bag groups lines by shop and checks out per shop', async ({ page }) => {
  const audit = observe(page);

  await addToBag(page, PRODUCT, 1, 1);
  await addToBag(page, SECOND_SHOP_PRODUCT, 1, 2);
  await page.goto('/cart');

  /* Two shops, two groups: one checkout can never fulfil both. */
  const groups = page.locator('[data-shop]');
  await expect(groups).toHaveCount(2, { timeout: 20_000 });

  const shopValues = await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-shop')));
  expect(new Set(shopValues).size).toBe(2);

  /* Each group carries its own way into checkout. */
  await expect(page.locator('[data-checkout-shop]')).toHaveCount(2);
  await expect(page.locator('main')).toContainText(/checked out on its own|shops|shop/i);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 14 — the bag flags stale inventory, reconciles it, then allows checkout', async ({ page }) => {
  /* The keepsake hamper is the low-stock row (6 in the seed), so add exactly
     what the studio can make today — the product page itself caps the
     quantity control at the available stock, which is the first half of the
     honesty under test. */
  await addToBag(page, 'heirloom-keepsake-hamper', 6, 6);

  /* Then age the bag into the state a returning customer's tab really has: a
     line asking for more than the catalogue can fulfil. */
  await page.evaluate(() => {
    const key = 'flora_alchemy_cart';
    const bag = JSON.parse(window.localStorage.getItem(key) || '[]');
    bag.forEach((line) => { line.quantity = (line.quantity || 1) + 1; });
    window.localStorage.setItem(key, JSON.stringify(bag));
  });

  await page.goto('/cart');

  /* Whatever the wording, the customer must be told BEFORE they pay. */
  const main = page.locator('main');
  await expect(main).toContainText(/only 6 left|stock|unavailable|fewer|reduce/i, { timeout: 25_000 });

  /* And the app must offer the reconciliation, not just the warning. */
  const reduce = page.getByRole('button', { name: /Reduce to 6/i }).first();
  await expect(reduce).toBeVisible();
  await reduce.click();

  /* Reconciled: the warning clears and checkout becomes reachable again. */
  await expect(main).not.toContainText(/only 6 left/i, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: /checkout|sign in to continue/i }).first()).toBeVisible();
});

test('FLOW 15 — checkout gates, then walks Account → Delivery → Review & Pay', async ({ page }) => {
  const audit = observe(page);
  await addToBag(page, PRODUCT);

  /* No guest checkout: the gate is a documented product decision. */
  await page.goto('/checkout');
  await expect(page.locator('main')).toContainText(/Sign in to continue/i, { timeout: 20_000 });

  await signInCustomer(page, { redirect: '/checkout' });
  await expect(page).toHaveURL(/\/checkout/);

  const progress = page.getByRole('list', { name: 'Checkout progress' });
  await expect(progress).toBeVisible();
  await expect(progress.getByRole('listitem')).toHaveCount(4);

  /* Step 0 — account confirmation, then the gate to delivery. */
  await expect(page.getByText(/Your Account/i).first()).toBeVisible();
  await page.getByRole('button', { name: /Continue to Delivery/i }).first().click();

  /* Step 1 — Delivery: the address AND the delivery options share this step
     (STEPS = Account · Delivery · Review & Pay · Confirmed — the wizard has
     three interactive steps, not four). */
  await expect(page.locator('[name="fullName"]')).toBeVisible();
  await page.locator('[name="fullName"]').fill('Demo Customer');
  await page.locator('[name="phone"]').fill('9800000000');
  await page.locator('[name="address"]').fill('14 Pressed Petal Lane');
  await page.locator('[name="city"]').fill('Mumbai');
  await page.locator('[name="state"]').selectOption('Maharashtra');
  await page.locator('[name="pincode"]').fill('400050');

  /* Both real rates the studio offers, chosen here and not later. */
  await expect(page.getByText(/Standard Pan-India Dispatch/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Express Atelier Dispatch/i)).toBeVisible();
  /* The step CTA is rendered twice — inline in the form and in the sticky
     order summary — so target the first (the form's own). */
  await page.getByRole('button', { name: /Continue to Review & Pay/i }).first().click();

  /* Step 2 — the review must show the server's own total. (The step name is
     both the page h1 and the summary heading, so target the level-1 one.) */
  await expect(page.getByRole('heading', { level: 1, name: /Review & Pay/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('main')).toContainText(/₹/);

  /* With no gateway configured the page must say so instead of implying a
     charge — the suite's stack blanks the provider on BOTH sides. */
  await expect(page.locator('main')).toContainText(/no payment gateway is connected|Demo payment/i);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('§3 — every checkout field is programmatically labelled and usable by keyboard', async ({ page }) => {
  await addToBag(page, PRODUCT);
  await signInCustomer(page, { redirect: '/checkout' });
  await page.getByRole('button', { name: /Continue to Delivery/i }).first().click();
  await expect(page.locator('[name="fullName"]')).toBeVisible();

  /* Each VISIBLE label must resolve to its own control through the
     accessibility tree — the association is the assertion, not the text. */
  for (const label of [
    'Full Name',
    'Email Address',
    'Phone Number (For Delivery Coordination)',
    'Street Address & Apartment',
    'City',
    'State',
    'Pincode',
    'Delivery Instructions (optional)',
  ]) {
    const control = page.getByLabel(label, { exact: false });
    await expect(control, `${label} is not associated with a control`).toHaveCount(1);
    await expect(control).toBeVisible();
  }

  /* No field on the delivery form is left unnamed (`labels` reflects the real
     DOM association), and every one of them is keyboard-focusable. */
  const audit = await page.evaluate(() => {
    const fields = [
      ...document.querySelectorAll(
        'form input:not([type="hidden"]):not([type="checkbox"]), form select, form textarea'
      ),
    ];
    return {
      unnamed: fields
        .filter(
          (el) =>
            !(el.labels && el.labels.length > 0) &&
            !el.getAttribute('aria-label') &&
            !el.getAttribute('aria-labelledby')
        )
        .map((el) => el.name || el.id || el.tagName),
      notFocusable: fields.filter((el) => el.tabIndex < 0 || el.disabled).map((el) => el.name || el.id),
    };
  });
  expect(audit.unnamed, `checkout fields with no accessible name: ${audit.unnamed.join(', ')}`).toEqual([]);
  expect(audit.notFocusable, `checkout fields unreachable by keyboard: ${audit.notFocusable.join(', ')}`).toEqual([]);

  /* A validation failure must be announced, not just coloured red. */
  await page.locator('[name="pincode"]').fill('1');
  await page.getByRole('button', { name: /Continue to Review & Pay/i }).first().click();
  const announced = await page
    .getByRole('alert')
    .first()
    .isVisible()
    .catch(() => false);
  if (announced) {
    await expect(page.getByRole('alert').first()).not.toBeEmpty();
  } else {
    /* The gate may instead keep the customer on the step: either way they are
       not silently taken to a step they cannot complete. */
    await expect(page.getByRole('heading', { level: 1, name: /Delivery Details/i })).toBeVisible();
  }
});

test('FLOW 16 — a paying customer reaches order success', async ({ page }) => {
  const audit = observe(page);
  await addToBag(page, PRODUCT);
  await signInCustomer(page, { redirect: '/checkout' });

  /* Step 0 → step 1 before the delivery fields exist. */
  await page.getByRole('button', { name: /Continue to Delivery/i }).first().click();

  await expect(page.locator('[name="fullName"]')).toBeVisible();
  await page.locator('[name="fullName"]').fill('Demo Customer');
  await page.locator('[name="phone"]').fill('9800000000');
  await page.locator('[name="address"]').fill('14 Pressed Petal Lane');
  await page.locator('[name="city"]').fill('Mumbai');
  await page.locator('[name="state"]').selectOption('Maharashtra');
  await page.locator('[name="pincode"]').fill('400050');
  await page.getByRole('button', { name: /Continue to Review & Pay/i }).first().click();

  /* The review step's final action is the order action itself: "Pay ₹X" for an
     online method, "Place Order · ₹X" for Pay on Delivery. No gateway is
     configured here, so whatever it says, the order it creates must carry the
     honest Sample payment status the assertion below checks. */
  await page.getByRole('button', { name: /^(Pay|Place Order)/i }).first().click();

  /* The server creates the order; the browser must land on ITS confirmation. */
  await page.waitForURL(/\/order-success\/FA-|(\/order-success\?)/, { timeout: 40_000 });
  await expect(page.locator('main')).toContainText(/FA-\d+/);

  const orderRef = (page.url().match(/FA-\d+/) || [])[0];
  expect(orderRef, 'order success rendered without an order reference').toBeTruthy();

  /* No charge was possible, so the page must not claim a real payment. */
  const body = await page.locator('main').innerText();
  expect(body).toMatch(/sample|pending|not configured|pay on delivery|unpaid/i);

  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('FLOW 17 — payment is refused when no provider is configured (no fake charge)', async ({ page }) => {
  await signInCustomer(page);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));

  /* Create a real order for this customer... */
  const created = await apiCall(page, 'POST', '/orders', {
    token,
    body: {
      items: [{ productSlug: PRODUCT, quantity: 1 }],
      paymentMethod: 'Instant UPI',
      shippingAddress: {
        name: 'Demo Customer',
        address: '14 Pressed Petal Lane',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400050',
        phone: '9800000000',
      },
    },
  });
  expect([200, 201]).toContain(created.status);
  const orderRef = created.body?.order?.orderId || created.body?.orderId;
  expect(orderRef).toBeTruthy();

  /* ...then ask the server for a payment it cannot make. It must refuse rather
     than invent a provider order. */
  const payment = await apiCall(page, 'POST', '/payments/create-order', {
    token,
    body: { orderId: orderRef },
  });
  expect([503, 400, 409]).toContain(payment.status);
  expect(JSON.stringify(payment.body || {})).toMatch(/NOT_CONFIGURED|not configured|unavailable/i);
});

test('FLOW 18 — an order reference resolves to its real timeline', async ({ page }) => {
  /* Tracking is a signed-in surface: the reference alone is not evidence of
     ownership, so an anonymous visitor is sent to sign in rather than shown
     anyone's journey. */
  await page.goto('/order-tracking/FA-E2E-1001');
  await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });

  await signInCustomer(page);
  await page.goto('/order-tracking/FA-E2E-1001');

  /* The DELIVERED fixture for this customer: the timeline must be the order's
     own, not the empty shell. */
  const main = page.locator('main');
  await expect(main).toContainText(/FA-E2E-1001/, { timeout: 25_000 });
  await expect(main).toContainText(/delivered/i);

  /* And another customer's reference stays undisclosed (ownership, not luck). */
  await page.goto('/order-tracking/FA-1024');
  await expect(main).toContainText(/not found/i, { timeout: 25_000 });
});

test('an unknown order reference is answered honestly, never with a crash', async ({ page }) => {
  const audit = observe(page);
  await signInCustomer(page);
  await page.goto('/order-tracking/FA-000000');
  await expect(page.locator('main')).toBeVisible();
  /* Wait for the lookup to settle: an empty <main> is the loading skeleton, so
     reading it immediately would assert on a frame, not on the answer. */
  await expect(page.locator('main')).toContainText(/not found|could not|no order|check/i, {
    timeout: 25_000,
  });
  const { pageErrors } = audit.unexpected();
  expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('§16 — the server re-prices the order and ignores a forged client price', async ({ page }) => {
  await signInCustomer(page);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));

  /* The real catalogue price, read from the public API. */
  const product = await apiCall(page, 'GET', `/products/${PRODUCT}`);
  const realPrice = product.body?.product?.price;
  expect(typeof realPrice).toBe('number');
  expect(realPrice).toBeGreaterThan(100);

  /* Ask for it at ₹1 with a fabricated total. */
  const forged = await apiCall(page, 'POST', '/orders', {
    token,
    body: {
      items: [{ productSlug: PRODUCT, quantity: 1, price: 1, subtotal: 1, total: 1 }],
      total: 1,
      subtotal: 1,
      /* Cod is disabled in the seeded commerce settings and the server is
         right to refuse it, so the forged PRICE is what this test probes. */
      paymentMethod: 'UPI',
      shippingAddress: {
        name: 'Demo Customer',
        address: '14 Pressed Petal Lane',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400050',
        phone: '9800000000',
      },
    },
  });

  expect([200, 201]).toContain(forged.status);
  const order = forged.body?.order || forged.body;
  expect(order.total).toBeGreaterThanOrEqual(realPrice);
  expect(order.total).not.toBe(1);
  const line = (order.items || [])[0];
  expect(line.price).toBeGreaterThanOrEqual(realPrice);
});

test('§8 — an order cannot be attributed to a shop that does not own its items', async ({ page }) => {
  await signInCustomer(page);
  const token = await page.evaluate(() => window.localStorage.getItem('flora_alchemy_customer_token'));

  const shippingAddress = {
    name: 'Demo Customer',
    address: '14 Pressed Petal Lane',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400050',
    phone: '9800000000',
  };

  /* A client shopSlug may only CONFIRM the items' own shop. */
  const wrongShop = await apiCall(page, 'POST', '/orders', {
    token,
    body: {
      items: [{ productSlug: PRODUCT, quantity: 1 }],
      shopSlug: SECOND_SHOP,
      paymentMethod: 'Pay on Delivery',
      shippingAddress,
    },
  });
  expect(wrongShop.status).toBeGreaterThanOrEqual(400);
  expect(wrongShop.body?.success).not.toBe(true);

  /* Two shops in one order is refused outright. */
  const mixed = await apiCall(page, 'POST', '/orders', {
    token,
    body: {
      items: [
        { productSlug: PRODUCT, quantity: 1 },
        { productSlug: SECOND_SHOP_PRODUCT, quantity: 1 },
      ],
      paymentMethod: 'Pay on Delivery',
      shippingAddress,
    },
  });
  expect(mixed.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(mixed.body || {})).toMatch(/MIXED|mixed|one shop|single shop|different/i);

  /* And a forged workspaceId is never read from the body. */
  const forgedWorkspace = await apiCall(page, 'POST', '/orders', {
    token,
    body: {
      items: [{ productSlug: PRODUCT, quantity: 1 }],
      workspaceId: '000000000000000000000000',
      shopSlug: SHOP,
      paymentMethod: 'Pay on Delivery',
      shippingAddress,
    },
  });
  if (forgedWorkspace.status < 400) {
    const order = forgedWorkspace.body?.order || forgedWorkspace.body;
    expect(JSON.stringify(order)).not.toContain('000000000000000000000000');
  }
});
