/**
 * PHASE 3 — UNIFIED BAG, SHOP-AWARE CHECKOUT, ORDERS & FULFILLMENT (focused).
 *
 * Self-contained: own server (port 4114), own database
 * (Flora-Alchemy-Test-Checkout), SEED_ON_START=false. Nothing here touches dev
 * or production data.
 *
 * What it proves, by section:
 *
 *   §D ONE SHOP PER CHECKOUT — a catalogue order derives its workspace from the
 *      stored Product ownership (never the body) and stamps it on the order.
 *   §E MIXED WORKSPACE — items from two shops in one checkout are refused
 *      (409 MIXED_WORKSPACE_ORDER) before anything is created.
 *   §F FORGED WORKSPACE / SLUG MISMATCH — a body `workspaceId` is scrubbed and
 *      cannot set or widen ownership; a `shopSlug` contradicting the items'
 *      shop is refused (409 SHOP_MISMATCH).
 *   §G PRODUCT OWNERSHIP — missing/hidden products and products of a suspended
 *      shop refuse the order; legacy-unscoped rows keep the documented
 *      single-store compatibility rule.
 *   §H STAFF-CREATED ORDERS — the caller's own workspace is the authority; a
 *      cross-shop item is refused and the order is attributed to the staff
 *      workspace.
 *   §I SHOP-SPECIFIC SHIPPING — each shop's own shipping configuration is used;
 *      one shop can never influence another's checkout.
 *   §J COMMERCE ENFORCEMENT — acceptNewOrders / storeAvailability /
 *      minimumOrderValue / maximumOrderItems / paymentMethods / studio-gift
 *      toggle are enforced server-side with stable codes.
 *   §K SERVER PRICING — client-supplied prices and totals are ignored.
 *   §L SHIPPING RULES — threshold / standard / express derive from settings.
 *   §M INVENTORY OWNERSHIP — only the ordered shop's stock moves.
 *   §N INVENTORY ATOMICITY — concurrent orders cannot oversell the last unit.
 *   §O PAYMENT AMOUNT — the payment amount is the stored server total; client
 *      amounts never reach it.
 *   §P PAYMENT METHOD SAFETY — canonical method mapping; COD can never create a
 *      provider order.
 *   §Q ORDER STATUS AUTHORIZATION — customers cannot advance status; staff of
 *      another shop read 404; the owning staff can advance it.
 *   §R SUSPENDED SHOP — new orders refused, historical orders still readable
 *      (with the stored shop snapshot).
 *   §S STALE CART REVALIDATION — a changed price / removed product refuses or
 *      re-prices against live data, never the stale client value.
 *   §U SHOP ATTRIBUTION — customer payloads carry `shop { slug, displayName }`
 *      and order history survives suspension.
 *   §W CUSTOMER ISOLATION — a customer can never read another's order.
 *   §X CONVERSATION INHERITANCE — Conversation.workspaceId comes from the Order.
 *   §Y NOTIFICATION ROUTING — only the owning shop's staff are notified.
 *   §Z NO TENANT LEAKAGE — deep scan of every customer-facing payload.
 *
 * Run: npm run test:checkout
 */
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import Inventory from '../models/Inventory.js';
import Settings from '../models/Settings.js';
import Order from '../models/Order.js';
import Conversation from '../models/Conversation.js';
import Notification from '../models/Notification.js';
import { canonicalPaymentMethod } from '../services/orderService.js';
import { isRazorpayMethod } from '../services/razorpayService.js';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.CHECKOUT_PORT || 4114);
const MOCK_PORT = Number(process.env.CHECKOUT_MOCK_PORT || 4128);
const DB_NAME = 'Flora-Alchemy-Test-Checkout';
const KEY_ID = 'rzp_test_checkout';
const KEY_SECRET = 'checkout_test_secret';

// ── Mock Razorpay provider (deterministic; never touches the real API) ──
let mockOrderCounter = 0;
const createdOrders = [];
function startMockRazorpay() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      const expected = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;
      if (auth !== expected) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { description: 'Auth failed' } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/orders') {
        const payload = JSON.parse(body || '{}');
        const id = `order_test_${++mockOrderCounter}`;
        createdOrders.push({ id, amount: payload.amount, receipt: payload.receipt });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, amount: payload.amount, status: 'created', receipt: payload.receipt }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { description: 'not found' } }));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

// ══════════ harness ══════════
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✘ ${name} ${detail}`);
  }
}

const stamp = Date.now();
const P = (name) => `${name}-Passw0rd-${stamp}!`;

/** Every path at which `workspaceId` appears anywhere in a payload. */
function findWorkspaceIdPaths(value, trail = '$', hits = []) {
  if (!value || typeof value !== 'object') return hits;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findWorkspaceIdPaths(item, `${trail}[${index}]`, hits));
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'workspaceId') hits.push(`${trail}.${key}`);
    findWorkspaceIdPaths(child, `${trail}.${key}`, hits);
  }
  return hits;
}
const leaks = (payload) => findWorkspaceIdPaths(payload);

// ── Deterministic start ──
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  Workspace.init(),
  User.init(),
  Customer.init(),
  Product.init(),
  Inventory.init(),
  Settings.init(),
  Order.init(),
  Conversation.init(),
  Notification.init(),
]);

const SHOP_A_SLUG = `petal-and-stem-${stamp}`;
const SHOP_B_SLUG = `marigold-workshop-${stamp}`;
const SHOP_SLUG = `dormant-atelier-${stamp}`;
const wsA = await Workspace.create({ slug: SHOP_A_SLUG, displayName: 'Petal & Stem', status: 'ACTIVE' });
const wsB = await Workspace.create({ slug: SHOP_B_SLUG, displayName: 'Marigold Workshop', status: 'ACTIVE' });
const wsDormant = await Workspace.create({ slug: SHOP_SLUG, displayName: 'Dormant Atelier', status: 'SUSPENDED' });
check('fixtures: two ACTIVE shops + one SUSPENDED shop', !!wsA && !!wsB && wsDormant.status === 'SUSPENDED');

async function makeUser({ email, password, role, name, workspaceId }) {
  return User.create({
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role,
    name,
    status: 'ACTIVE',
    ...(workspaceId ? { workspaceId } : {}),
  });
}
const adminAEmail = `chk-admin-a-${stamp}@checkout.test`;
const adminBEmail = `chk-admin-b-${stamp}@checkout.test`;
await makeUser({ email: adminAEmail, password: P('AdminA'), role: 'admin', name: 'Chk Admin A', workspaceId: wsA._id });
await makeUser({ email: adminBEmail, password: P('AdminB'), role: 'admin', name: 'Chk Admin B', workspaceId: wsB._id });

const mockServer = await startMockRazorpay();
let SERVER;
let base;
try {
  ({ child: SERVER, base } = await bootTestServer({
    port: PORT,
    db: DB_NAME,
    extraEnv: {
      SEED_ON_START: 'false',
      // A deterministic provider: the suite proves the amount/ownership rules
      // without ever calling the real Razorpay API.
      RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    },
    label: 'checkout',
  }));
} catch (err) {
  console.error(`\nCHECKOUT SUITE ABORTED: ${err.message}`);
  mockServer.close();
  process.exit(1);
}
const BASE = `${base}/api`;

async function req(method, path_, { token, body } = {}) {
  const h = {};
  if (body) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${path_}`, {
        method,
        headers: h,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* non-json body */
      }
      return { status: res.status, json };
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}
async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  return r.json?.token || null;
}

const ADMIN_A = await login(adminAEmail, P('AdminA'));
const ADMIN_B = await login(adminBEmail, P('AdminB'));

const custAEmail = `chk-cust-a-${stamp}@checkout.test`;
const custBEmail = `chk-cust-b-${stamp}@checkout.test`;
await req('POST', '/auth/register', { body: { name: 'Chk Customer A', email: custAEmail, password: P('CustA') } });
await req('POST', '/auth/register', { body: { name: 'Chk Customer B', email: custBEmail, password: P('CustB') } });
const CUST_A = await login(custAEmail, P('CustA'));
const CUST_B = await login(custBEmail, P('CustB'));
const custA = (await req('GET', '/customers/me', { token: CUST_A })).json?.customer;
const custB = (await req('GET', '/customers/me', { token: CUST_B })).json?.customer;
const custAId = custA?.id || custA?._id;
const custBId = custB?.id || custB?._id;
check('fixtures: staff + customers signed in', !!ADMIN_A && !!ADMIN_B && !!CUST_A && !!CUST_B);

// Products through the real staff endpoint: server-derived attribution + stock.
async function makeProduct(token, { name, price, stock, visibility }) {
  const r = await req('POST', '/products', {
    token,
    body: { name, price, category: 'Posies', initialStock: stock, ...(visibility ? { visibility } : {}) },
  });
  return r.json?.product?.slug || null;
}
const A1 = await makeProduct(ADMIN_A, { name: 'Petal Posy A1', price: 1200, stock: 10 });
const A2 = await makeProduct(ADMIN_A, { name: 'Petal Posy A2', price: 800, stock: 10 });
const B1 = await makeProduct(ADMIN_B, { name: 'Marigold Box B1', price: 900, stock: 10 });
const B2 = await makeProduct(ADMIN_B, { name: 'Marigold Box B2', price: 950, stock: 10 });
const A_LAST = await makeProduct(ADMIN_A, { name: 'Last Stem', price: 600, stock: 1 });
const A_STOCK = await makeProduct(ADMIN_A, { name: 'Stock Bloom', price: 640, stock: 5 });
const A_HIDDEN = await Product.create({
  name: 'Hidden Bloom', slug: `hidden-bloom-${stamp}`, price: 700, visibility: 'Hidden',
  stockTracked: false, workspaceId: wsA._id,
});
const DORMANT_PRODUCT = await Product.create({
  name: 'Dormant Bloom', slug: `dormant-bloom-${stamp}`, price: 700, visibility: 'Visible',
  stockTracked: false, workspaceId: wsDormant._id,
});
const LEGACY_PRODUCT = await Product.create({
  name: 'Legacy Posy', slug: `legacy-posy-${stamp}`, price: 500, visibility: 'Visible',
  stockTracked: false,
});
const A1_DOC = await Product.findOne({ slug: A1 }).lean();
const a1Workspace = String(A1_DOC.workspaceId);
check('fixtures: products attributed to A, B, a suspended shop, a hidden row and a legacy row',
  !!A1 && !!B1 && a1Workspace === String(wsA._id) && A_HIDDEN.visibility === 'Hidden');

// Shop-specific settings: A and B deliberately use DIFFERENT shipping.
const baseCommerce = {
  paymentMethods: { upi: true, cards: true, netbanking: true, cod: false, wallets: true },
  autoConfirmOrders: true,
  minimumOrderValue: 100,
  maximumOrderItems: 10,
  taxEnabled: false,
  taxRate: 0,
  orderPrefix: 'FA',
};
async function writeSettings(workspace, slug, shipping) {
  await Settings.findOneAndUpdate(
    { workspaceId: workspace._id },
    {
      $set: {
        key: `ws-${slug}`,
        workspaceId: workspace._id,
        storeAvailability: 'open',
        acceptNewOrders: true,
        shippingConfiguration: {
          freeShippingThreshold: 100000,
          standardRate: shipping.standard,
          expressRate: shipping.express,
          standardDays: '3–5 business days',
          expressDays: '1–2 business days',
          panIndia: true,
        },
        customGiftConfiguration: { enabled: true, basePrice: 1850, note: '' },
        commerceConfiguration: { ...baseCommerce },
        isFixture: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}
await writeSettings(wsA, SHOP_A_SLUG, { standard: 77, express: 777 });
await writeSettings(wsB, SHOP_B_SLUG, { standard: 33, express: 333 });
check('fixtures: shop-specific settings written (A: ₹77/₹777, B: ₹33/₹333)', true);

const giftConfig = {
  baseId: 'keepsake-posy',
  flowerIds: ['rose'],
  paletteId: 'mauve',
  ribbonId: 'frayed-silk',
  sealId: 'terracotta',
};
const ADDRESS = {
  name: 'Chk Customer A', address: '1 Bloom Lane', city: 'Jaipur', state: 'RJ', pincode: '302001',
};
const orderCount = () => Order.countDocuments({});
const item = (slug, quantity = 1) => ({ productSlug: slug, name: slug, quantity });

// ══════════ §D ONE SHOP PER CHECKOUT ══════════
console.log('\n— §D ONE SHOP PER CHECKOUT —');
let r = await req('POST', '/orders', {
  token: CUST_A,
  body: { items: [item(A1, 1), item(A2, 2)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS, shopSlug: SHOP_A_SLUG },
});
const orderA = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a single-shop catalogue checkout is accepted (201)', r.status === 201 && !!orderA, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 160)}`);
check('Order.workspaceId is derived from the items\' Product ownership', String(orderA?.workspaceId) === String(wsA._id), `${orderA?.workspaceId}`);
check('every catalogue item of the order belongs to that workspace',
  String((await Product.findOne({ slug: A1 }).lean()).workspaceId) === String(orderA?.workspaceId) &&
  String((await Product.findOne({ slug: A2 }).lean()).workspaceId) === String(orderA?.workspaceId));
check('the customer payload names the fulfilling shop', r.json?.order?.shop?.slug === SHOP_A_SLUG && r.json?.order?.shop?.displayName === 'Petal & Stem');
check('the order stores the shop snapshot for later display', orderA?.shopSnapshot?.slug === SHOP_A_SLUG && orderA?.shopSnapshot?.displayName === 'Petal & Stem');
check('subtotal is the server sum of the two lines (1200 + 800×2)', orderA?.subtotal === 2800, `${orderA?.subtotal}`);

// ══════════ §E MIXED WORKSPACE ══════════
console.log('\n— §E MIXED WORKSPACE —');
const beforeMixed = await orderCount();
r = await req('POST', '/orders', {
  token: CUST_A,
  body: { items: [item(A1, 1), item(B1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS },
});
check('a bag containing two shops is refused (409 MIXED_WORKSPACE_ORDER)', r.status === 409 && r.json?.code === 'MIXED_WORKSPACE_ORDER', `${r.status} ${r.json?.code}`);
check('the refusal created no order', (await orderCount()) === beforeMixed);
r = await req('POST', '/orders', {
  token: CUST_A,
  body: { items: [item(B1, 1), item(A2, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS, shopSlug: SHOP_B_SLUG },
});
check('a mixed bag cannot smuggle itself in via a matching shopSlug', r.status === 409 && r.json?.code === 'MIXED_WORKSPACE_ORDER', `${r.status} ${r.json?.code}`);
check('still no order created for either shop', (await orderCount()) === beforeMixed);

// ══════════ §F FORGED WORKSPACE / SLUG MISMATCH ══════════
console.log('\n— §F FORGED WORKSPACE / SLUG MISMATCH —');
r = await req('POST', '/orders', {
  token: CUST_A,
  body: { items: [item(A1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS, workspaceId: String(wsB._id), shopSlug: SHOP_B_SLUG },
});
const forgedOrder = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a body workspaceId cannot move the order (409 SHOP_MISMATCH from the slug)', r.status === 409 && r.json?.code === 'SHOP_MISMATCH', `${r.status} ${r.json?.code}`);
check('the forged request created no order', !forgedOrder);
r = await req('POST', '/orders', {
  token: CUST_A,
  body: { items: [item(A1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS, workspaceId: String(wsB._id) },
});
const scrubbed = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a body workspaceId alone is ignored (order lands on the item\'s shop)', r.status === 201 && String(scrubbed?.workspaceId) === String(wsA._id), `${r.status} ${scrubbed?.workspaceId}`);
check('no order for shop B was created by the forged payload', (await Order.countDocuments({ workspaceId: wsB._id })) === 0);
r = await req('POST', '/orders', {
  token: CUST_A,
  body: { items: [item(B1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS, shopSlug: SHOP_A_SLUG },
});
check('a slug that contradicts the product\'s shop is refused (409 SHOP_MISMATCH)', r.status === 409 && r.json?.code === 'SHOP_MISMATCH', `${r.status} ${r.json?.code}`);

// ══════════ §G PRODUCT OWNERSHIP ══════════
console.log('\n— §G PRODUCT OWNERSHIP —');
const beforeOwnership = await orderCount();
r = await req('POST', '/orders', {
  token: CUST_A, body: { items: [item(`no-such-product-${stamp}`, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS },
});
check('an unknown product refuses the order (422 PRODUCT_NOT_FOUND)', r.status === 422 && r.json?.code === 'PRODUCT_NOT_FOUND', `${r.status} ${r.json?.code}`);
r = await req('POST', '/orders', {
  token: CUST_A, body: { items: [item(A_HIDDEN.slug, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS },
});
check('a hidden product is not orderable by a customer (422 PRODUCT_NOT_FOUND)', r.status === 422 && r.json?.code === 'PRODUCT_NOT_FOUND', `${r.status} ${r.json?.code}`);
r = await req('POST', '/orders', {
  token: CUST_A, body: { items: [item(DORMANT_PRODUCT.slug, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS },
});
check('a product of a suspended shop refuses the order (422 SHOP_NOT_FOUND)', r.status === 422 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);
check('none of the refused requests created an order', (await orderCount()) === beforeOwnership);
r = await req('POST', '/orders', {
  token: CUST_A, body: { items: [item(LEGACY_PRODUCT.slug, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS },
});
check('a legacy-unscoped product with several live shops asks for a shop (422 SHOP_REQUIRED)', r.status === 422 && r.json?.code === 'SHOP_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('POST', '/orders', {
  token: CUST_A, body: { items: [item(LEGACY_PRODUCT.slug, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS, shopSlug: SHOP_A_SLUG },
});
const legacyOrder = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a legacy-unscoped product can be attributed by an explicit ACTIVE shop', r.status === 201 && String(legacyOrder?.workspaceId) === String(wsA._id), `${r.status} ${legacyOrder?.workspaceId}`);
r = await req('POST', '/orders', {
  token: CUST_A, body: { items: [item(LEGACY_PRODUCT.slug, 1), item(A1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS },
});
const mixedLegacy = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a legacy line rides along with an authoritative line\'s shop', r.status === 201 && String(mixedLegacy?.workspaceId) === String(wsA._id), `${r.status}`);

// ══════════ §H STAFF-CREATED ORDERS ══════════
console.log('\n— §H STAFF-CREATED ORDERS —');
r = await req('POST', '/orders/admin', {
  token: ADMIN_A, body: { customerId: String(custBId), items: [item(A1, 1)], paymentMethod: 'Sample', shippingAddress: ADDRESS },
});
const staffOrderA = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('staff A can create a shop-A catalogue order', r.status === 201 && String(staffOrderA?.workspaceId) === String(wsA._id), `${r.status} ${staffOrderA?.workspaceId}`);
r = await req('POST', '/orders/admin', {
  token: ADMIN_A, body: { customerId: String(custBId), items: [item(B1, 1)], paymentMethod: 'Sample', shippingAddress: ADDRESS },
});
check('staff A cannot create an order for shop B\'s product (403)', r.status === 403, `${r.status} ${r.json?.code}`);
r = await req('POST', '/orders/admin', {
  token: ADMIN_A, body: { customerId: String(custBId), items: [item(A1, 1), item(B1, 1)], paymentMethod: 'Sample', shippingAddress: ADDRESS },
});
check('a staff order mixing shops is refused (409 MIXED_WORKSPACE_ORDER)', r.status === 409 && r.json?.code === 'MIXED_WORKSPACE_ORDER', `${r.status} ${r.json?.code}`);
r = await req('POST', '/orders/admin', {
  token: ADMIN_A,
  body: { customerId: String(custBId), items: [item(A2, 1)], paymentMethod: 'Sample', shippingAddress: ADDRESS, workspaceId: String(wsB._id), shopSlug: SHOP_A_SLUG },
});
const staffForged = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a staff order cannot be moved by a body workspaceId (stays with the caller\'s shop)', r.status === 201 && String(staffForged?.workspaceId) === String(wsA._id), `${r.status} ${r.json?.code}`);
const staffListA = await req('GET', '/orders', { token: ADMIN_A });
const staffListB = await req('GET', '/orders', { token: ADMIN_B });
check('staff A\'s order list contains only shop-A orders',
  staffListA.status === 200 && (staffListA.json?.orders || []).every((o) => String(o.workspaceId) === String(wsA._id)));
check('staff B\'s order list is disjoint from shop A',
  staffListB.status === 200 && (staffListB.json?.orders || []).every((o) => String(o.workspaceId) === String(wsB._id)) &&
  (staffListB.json?.orders || []).length === 0);

// ══════════ §I SHOP-SPECIFIC SHIPPING ══════════
console.log('\n— §I SHOP-SPECIFIC SHIPPING —');
r = await req('POST', '/orders', {
  token: CUST_A, body: { items: [item(A1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS },
});
const shipA = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
r = await req('POST', '/orders', {
  token: CUST_A, body: { items: [item(B1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS },
});
const shipB = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('shop A\'s own shipping rate is applied (₹77)', shipA?.shipping === 77, `${shipA?.shipping}`);
check('shop B\'s own shipping rate is applied (₹33)', shipB?.shipping === 33, `${shipB?.shipping}`);
check('the totals differ accordingly (A: 1277 · B: 933)', shipA?.total === 1277 && shipB?.total === 933, `${shipA?.total} ${shipB?.total}`);
check('one shop\'s settings never leak into the other\'s order', shipA?.shipping !== shipB?.shipping);
const publicSettings = await req('GET', `/shops/${SHOP_A_SLUG}/settings`);
check('the public shop settings slice exposes the shop\'s own shipping configuration',
  publicSettings.status === 200 && publicSettings.json?.settings?.shippingConfiguration?.standardRate === 77,
  `${publicSettings.status}`);

// ══════════ §J COMMERCE ENFORCEMENT ══════════
console.log('\n— §J COMMERCE ENFORCEMENT —');
const settingsA = await Settings.findOne({ workspaceId: wsA._id });
const setCommerce = async (patch) => {
  Object.assign(settingsA.commerceConfiguration, patch);
  settingsA.markModified('commerceConfiguration');
  await settingsA.save();
};
const beforeEnforcement = await orderCount();

settingsA.acceptNewOrders = false;
await settingsA.save();
r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } });
check('a shop not accepting orders refuses the checkout (409 ORDERS_CLOSED)', r.status === 409 && r.json?.code === 'ORDERS_CLOSED', `${r.status} ${r.json?.code}`);
settingsA.acceptNewOrders = true;
settingsA.storeAvailability = 'closed';
await settingsA.save();
r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } });
check('a closed store availability refuses the checkout (409 ORDERS_CLOSED)', r.status === 409 && r.json?.code === 'ORDERS_CLOSED', `${r.status} ${r.json?.code}`);
settingsA.storeAvailability = 'open';
await settingsA.save();

await setCommerce({ minimumOrderValue: 5000 });
r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } });
check('minimumOrderValue is enforced server-side (422 MINIMUM_ORDER_VALUE)', r.status === 422 && r.json?.code === 'MINIMUM_ORDER_VALUE', `${r.status} ${r.json?.code}`);
await setCommerce({ minimumOrderValue: 100 });

await setCommerce({ maximumOrderItems: 1 });
r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A1, 2)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } });
check('maximumOrderItems is enforced server-side (422 MAX_ITEMS_EXCEEDED)', r.status === 422 && r.json?.code === 'MAX_ITEMS_EXCEEDED', `${r.status} ${r.json?.code}`);
await setCommerce({ maximumOrderItems: 10 });

r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A1, 1)], paymentMethod: 'Pay on Delivery', shippingAddress: ADDRESS } });
check('a disabled payment method is refused (422 PAYMENT_METHOD_NOT_ALLOWED)', r.status === 422 && r.json?.code === 'PAYMENT_METHOD_NOT_ALLOWED', `${r.status} ${r.json?.code}`);

settingsA.customGiftConfiguration.enabled = false;
settingsA.markModified('customGiftConfiguration');
await settingsA.save();
r = await req('POST', '/orders', {
  token: CUST_A,
  body: { items: [{ name: 'Studio Gift', customGiftConfig: giftConfig, quantity: 1 }], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS, shopSlug: SHOP_A_SLUG },
});
check('a disabled Custom Gift Studio refuses the studio gift (422 CUSTOM_GIFTS_DISABLED)', r.status === 422 && r.json?.code === 'CUSTOM_GIFTS_DISABLED', `${r.status} ${r.json?.code}`);
settingsA.customGiftConfiguration.enabled = true;
settingsA.markModified('customGiftConfiguration');
await settingsA.save();

check('every enforcement refusal created no order', (await orderCount()) === beforeEnforcement);

r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A1, 1)], paymentMethod: 'Pay on Delivery', shippingAddress: ADDRESS } });
const codOrder = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
if (!codOrder) {
  // COD is disabled by the shop's settings (default) — enable it and retry so
  // the COD-specific checks can still run.
  settingsA.commerceConfiguration.paymentMethods.cod = true;
  settingsA.markModified('commerceConfiguration');
  await settingsA.save();
  r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A1, 1)], paymentMethod: 'Pay on Delivery', shippingAddress: ADDRESS } });
}
const codDoc = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('an enabled COD method is accepted (201)', r.status === 201 && !!codDoc, `${r.status} ${r.json?.code}`);

// ══════════ §K SERVER PRICING ══════════
console.log('\n— §K SERVER PRICING —');
r = await req('POST', '/orders', {
  token: CUST_A,
  body: {
    items: [{ productSlug: A1, name: 'Tampered', quantity: 1, price: 1, isCatalogue: true }],
    paymentMethod: 'Instant UPI',
    shippingAddress: ADDRESS,
    subtotal: 1,
    shipping: 0,
    total: 1,
  },
});
const priced = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a client price cannot lower a catalogue line (server price 1200)', priced?.items?.[0]?.price === 1200, `${priced?.items?.[0]?.price}`);
check('a client subtotal/total is ignored (server 1277)', priced?.subtotal === 1200 && priced?.total === 1277, `${priced?.subtotal} ${priced?.total}`);
check('the stored total equals subtotal + shipping + tax', priced?.total === priced?.subtotal + priced?.shipping + (priced?.tax || 0));
r = await req('POST', '/orders', {
  token: CUST_A,
  body: { items: [{ name: 'Arbitrary', price: 10, quantity: 1 }], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS, shopSlug: SHOP_A_SLUG },
});
check('a customer cannot invent a bespoke line (422 VALIDATION_ERROR)', r.status === 422 && r.json?.code === 'VALIDATION_ERROR', `${r.status} ${r.json?.code}`);
await setCommerce({ taxEnabled: true, taxRate: 5 });
r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } });
const taxed = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('shop-configured tax is computed server-side (5% of 1200 = ₹60)', taxed?.tax === 60, `${taxed?.tax}`);
check('tax is included in the stored total (1200 + 77 + 60 = 1337)', taxed?.total === 1337, `${taxed?.total}`);
await setCommerce({ taxEnabled: false, taxRate: 0 });

// ══════════ §L SHIPPING RULES ══════════
console.log('\n— §L SHIPPING RULES —');
r = await req('POST', '/orders', {
  token: CUST_A,
  body: { items: [item(A2, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS, isRush: true },
});
const expressOrder = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('express shipping uses the shop\'s express rate (₹777)', expressOrder?.shipping === 777, `${expressOrder?.shipping}`);
settingsA.shippingConfiguration.freeShippingThreshold = 500;
settingsA.markModified('shippingConfiguration');
await settingsA.save();
r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } });
const freeOrder = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('the free-shipping threshold is applied from the shop settings (₹0)', freeOrder?.shipping === 0, `${freeOrder?.shipping}`);
settingsA.shippingConfiguration.freeShippingThreshold = 100000;
settingsA.markModified('shippingConfiguration');
await settingsA.save();

// ══════════ §M INVENTORY OWNERSHIP ══════════
console.log('\n— §M INVENTORY OWNERSHIP —');
const invBefore = await Inventory.findOne({ productSlug: A_STOCK }).lean();
const invBBefore = await Inventory.findOne({ productSlug: B1 }).lean();
r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A_STOCK, 2)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } });
const invAfter = await Inventory.findOne({ productSlug: A_STOCK }).lean();
const invBAfter = await Inventory.findOne({ productSlug: B1 }).lean();
check('the ordered shop\'s stock is deducted (A_STOCK: −2)', r.status === 201 && invAfter.currentStock === invBefore.currentStock - 2, `${r.status} ${invBefore.currentStock} → ${invAfter.currentStock}`);
check('another shop\'s stock is untouched (B1)', invBAfter.currentStock === invBBefore.currentStock, `${invBAfter.currentStock}`);
check('the inventory record carries the shop\'s workspaceId', String(invAfter.workspaceId) === String(wsA._id));
const stockOrder = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
const movements = await mongoose.connection.db.collection('inventorymovements')
  .find({ orderId: stockOrder?.orderId }).toArray();
check('the stock movement is attributed to the shop', movements.length === 1 && String(movements[0].workspaceId) === String(wsA._id), `${movements.length}`);

// ══════════ §N INVENTORY ATOMICITY ══════════
console.log('\n— §N INVENTORY ATOMICITY —');
const results = await Promise.all([
  req('POST', '/orders', { token: CUST_A, body: { items: [item(A_LAST, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } }),
  req('POST', '/orders', { token: CUST_B, body: { items: [item(A_LAST, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } }),
]);
const wins = results.filter((x) => x.status === 201).length;
const losses = results.filter((x) => x.status === 409 && x.json?.code === 'INSUFFICIENT_STOCK').length;
const lastStock = await Inventory.findOne({ productSlug: A_LAST }).lean();
check('concurrent orders cannot oversell the last unit (exactly one 201)', wins === 1, JSON.stringify(results.map((x) => x.status)));
check('the loser gets the clean stock error and stock never goes negative', losses === 1 && lastStock.currentStock === 0, `${losses} ${lastStock?.currentStock}`);

// ══════════ §O PAYMENT AMOUNT ══════════
console.log('\n— §O PAYMENT AMOUNT —');
const paidTarget = await Order.findOne({ orderId: shipA.orderId }).lean();
const payStatus = await req('GET', `/payments/${paidTarget.orderId}/status`, { token: CUST_A });
check('payment status returns the SERVER total (₹1277)', payStatus.status === 200 && payStatus.json?.payment?.total === 1277, `${payStatus.json?.payment?.total}`);
check('the payment payload never exposes workspaceId', leaks(payStatus.json).length === 0, leaks(payStatus.json).join(','));
const payOther = await req('GET', `/payments/${paidTarget.orderId}/status`, { token: CUST_B });
check('another customer cannot read the payment (404)', payOther.status === 404, `${payOther.status}`);
const payStaffB = await req('GET', `/payments/${paidTarget.orderId}/status`, { token: ADMIN_B });
check('staff B cannot read a shop-A payment (404)', payStaffB.status === 404, `${payStaffB.status}`);
const beforeProvider = createdOrders.length;
r = await req('POST', '/payments/create-order', { token: CUST_A, body: { orderId: priced.orderId, amount: 1 } });
check('the provider order is created (200) with the stored server total', r.status === 200 && !!r.json?.payment?.razorpayOrderId, `${r.status}`);
check('the amount sent to the provider is the server total in paise (1277 → 127700)',
  createdOrders[beforeProvider]?.amount === 127700, `${createdOrders[beforeProvider]?.amount}`);
check('the client-supplied amount (₹1) never reaches the provider', createdOrders[beforeProvider]?.amount !== 100);
check('only the public key id is returned to the browser', r.json?.payment?.razorpayKeyId === KEY_ID);
r = await req('POST', '/payments/create-order', { token: CUST_A, body: { orderId: codDoc.orderId } });
check('a COD order can never be converted into an online charge (422 PAYMENT_METHOD_NOT_ALLOWED)',
  r.status === 422 && r.json?.code === 'PAYMENT_METHOD_NOT_ALLOWED', `${r.status} ${r.json?.code}`);
check('no provider order was created for the COD order', createdOrders.length === beforeProvider + 1, `${createdOrders.length}`);

// ══════════ §P PAYMENT METHOD SAFETY ══════════
console.log('\n— §P PAYMENT METHOD SAFETY —');
check('canonical mapping: storefront label → upi', canonicalPaymentMethod('Instant UPI') === 'upi');
check('canonical mapping: card label → card', canonicalPaymentMethod('Cards & Netbanking') === 'card');
check('canonical mapping: delivery label → cod', canonicalPaymentMethod('Pay on Delivery') === 'cod');
check('COD is never a provider-checkout method (no provider order possible)', isRazorpayMethod('cod') === false && isRazorpayMethod('Pay on Delivery') === false);
check('an online method remains a provider method', isRazorpayMethod('Instant UPI') === true);

// ══════════ §Q ORDER STATUS AUTHORIZATION ══════════
console.log('\n— §Q ORDER STATUS AUTHORIZATION —');
r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: CUST_A, body: { status: 'confirmed' } });
check('a customer cannot advance an order status (403)', r.status === 403, `${r.status}`);
r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: ADMIN_B, body: { status: 'confirmed' } });
check('staff of another shop cannot advance the order (404)', r.status === 404, `${r.status} ${r.json?.code}`);
r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: ADMIN_A, body: { status: 'confirmed' } });
check('the owning staff can advance the order (200)', r.status === 200 && r.json?.order?.orderStatus === 'confirmed', `${r.status}`);
r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: ADMIN_A, body: { status: 'new' } });
check('a backwards transition is refused (422 INVALID_TRANSITION)', r.status === 422 && r.json?.code === 'INVALID_TRANSITION', `${r.status} ${r.json?.code}`);
r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: ADMIN_A, body: { status: 'not-a-status' } });
check('an unknown status is refused (422 VALIDATION_ERROR)', r.status === 422 && r.json?.code === 'VALIDATION_ERROR', `${r.status} ${r.json?.code}`);
r = await req('GET', `/orders/${orderA.orderId}`, { token: ADMIN_B });
check('staff B cannot read the order at all (404, no existence disclosure)', r.status === 404, `${r.status}`);

// ══════════ §R SUSPENDED SHOP ══════════
console.log('\n— §R SUSPENDED SHOP —');
await Workspace.updateOne({ _id: wsA._id }, { $set: { status: 'SUSPENDED' } });
const beforeSuspension = await orderCount();
r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } });
check('a suspended shop cannot receive a new order (422 SHOP_NOT_FOUND)', r.status === 422 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);
check('the suspension created no order', (await orderCount()) === beforeSuspension);
const history = await req('GET', '/orders/mine', { token: CUST_A });
const historical = (history.json?.orders || []).find((o) => o.orderId === orderA.orderId);
check('historical orders remain readable after suspension', history.status === 200 && !!historical);
check('the historical order keeps its shop identity from the snapshot',
  historical?.shop?.slug === SHOP_A_SLUG && historical?.shop?.displayName === 'Petal & Stem', JSON.stringify(historical?.shop));
check('the suspended shop is absent from the live shop directory',
  !((await req('GET', '/shops')).json?.shops || []).some((s) => s.slug === SHOP_A_SLUG));
const suspendedStaff = await req('GET', '/orders', { token: ADMIN_A });
check('staff of a suspended shop are locked out (403 WORKSPACE_SUSPENDED)', suspendedStaff.status === 403, `${suspendedStaff.status} ${suspendedStaff.json?.code}`);
await Workspace.updateOne({ _id: wsA._id }, { $set: { status: 'ACTIVE' } });
const reactivatedStaff = await req('GET', '/orders', { token: ADMIN_A });
check('reactivation restores staff access immediately', reactivatedStaff.status === 200, `${reactivatedStaff.status}`);

// ══════════ §S STALE CART REVALIDATION ══════════
console.log('\n— §S STALE CART REVALIDATION —');
await Product.updateOne({ slug: A2 }, { $set: { price: 1111 } });
r = await req('POST', '/orders', {
  token: CUST_A, body: { items: [{ productSlug: A2, name: 'Stale', quantity: 1, price: 800 }], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS, total: 800 },
});
const repriced = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a stale client price is re-priced from the live catalogue (₹1111)', repriced?.items?.[0]?.price === 1111, `${repriced?.items?.[0]?.price}`);
await Product.deleteOne({ slug: A2 });
const beforeDeleted = await orderCount();
r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(A2, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } });
check('a deleted product refuses the checkout (422 PRODUCT_NOT_FOUND)', r.status === 422 && r.json?.code === 'PRODUCT_NOT_FOUND', `${r.status} ${r.json?.code}`);
check('the deleted-product refusal created no order', (await orderCount()) === beforeDeleted);

// ══════════ §U SHOP ATTRIBUTION ══════════
console.log('\n— §U SHOP ATTRIBUTION —');
const single = await req('GET', `/orders/${orderA.orderId}`, { token: CUST_A });
check('the order payload exposes shop { slug, displayName }',
  single.json?.order?.shop?.slug === SHOP_A_SLUG && !!single.json?.order?.shop?.displayName);
check('the order payload never exposes workspaceId', leaks(single.json).length === 0, leaks(single.json).join(','));
const mine = await req('GET', '/orders/mine', { token: CUST_A });
check('every order in the customer history carries shop attribution and no workspaceId',
  (mine.json?.orders || []).length > 0 &&
  (mine.json?.orders || []).every((o) => !('workspaceId' in o) && (o.shop === null || typeof o.shop?.slug === 'string')));
r = await req('POST', '/orders', { token: CUST_A, body: { items: [item(B1, 1)], paymentMethod: 'Instant UPI', shippingAddress: ADDRESS } });
const shopBOrder = r.json?.order;
check('a shop-B order is attributed to shop B in the customer payload', shopBOrder?.shop?.slug === SHOP_B_SLUG, `${shopBOrder?.shop?.slug}`);

// ══════════ §W CUSTOMER ISOLATION ══════════
console.log('\n— §W CUSTOMER ISOLATION —');
r = await req('GET', `/orders/${orderA.orderId}`, { token: CUST_B });
check('another customer cannot read the order (404)', r.status === 404, `${r.status}`);
const mineB = await req('GET', '/orders/mine', { token: CUST_B });
check('another customer\'s history is disjoint and carries only their own orders',
  mineB.status === 200 && (mineB.json?.orders || []).every((o) => String(o.customerId) === String(custBId)));
r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: CUST_B, body: { status: 'confirmed' } });
check('another customer cannot touch the order', r.status === 403 || r.status === 404, `${r.status}`);

// ══════════ §X CONVERSATION INHERITANCE ══════════
console.log('\n— §X CONVERSATION INHERITANCE —');
r = await req('GET', `/conversations/order/${orderA.orderId}`, { token: CUST_A });
const conversation = await Conversation.findOne({ orderId: orderA.orderId }).lean();
check('the order conversation is created for its customer (200)', r.status === 200 && !!conversation, `${r.status}`);
check('Conversation.workspaceId equals Order.workspaceId', String(conversation?.workspaceId) === String(orderA.workspaceId));
check('the conversation payload carries no workspaceId', leaks(r.json).length === 0, leaks(r.json).join(','));
r = await req('GET', `/conversations/order/${orderA.orderId}`, { token: ADMIN_B });
check('staff of another shop cannot open the conversation (404)', r.status === 404, `${r.status}`);
r = await req('GET', `/conversations/order/${orderA.orderId}`, { token: ADMIN_A });
check('the owning staff can open the conversation (200)', r.status === 200, `${r.status}`);

// ══════════ §Y NOTIFICATION ROUTING ══════════
console.log('\n— §Y NOTIFICATION ROUTING —');
const notifA = await Notification.findOne({
  entityType: 'order', entityId: orderA._id, role: 'admin',
}).lean();
check('the owning shop\'s staff are notified about the new order', !!notifA && String(notifA.workspaceId) === String(wsA._id), `${notifA?.workspaceId}`);
const notifB = await Notification.countDocuments({ entityType: 'order', entityId: orderA._id, workspaceId: wsB._id });
check('no notification for the order was routed to another shop', notifB === 0, `${notifB}`);
const custNotif = await Notification.find({ entityType: 'order', entityId: orderA._id, role: 'customer' }).lean();
check('customer notifications carry the source order\'s workspace and never leak it publicly',
  custNotif.every((n) => String(n.workspaceId) === String(wsA._id)));

// ══════════ §Z NO TENANT LEAKAGE ══════════
console.log('\n— §Z NO TENANT LEAKAGE —');
r = await req('GET', '/orders/mine', { token: CUST_A });
check('no workspaceId in the customer orders payload', leaks(r.json).length === 0, leaks(r.json).join(','));
r = await req('GET', `/orders/${orderA.orderId}`, { token: CUST_A });
check('no workspaceId in the customer order payload', leaks(r.json).length === 0, leaks(r.json).join(','));
r = await req('GET', '/conversations/mine', { token: CUST_A });
check('no workspaceId in the customer conversations payload', leaks(r.json).length === 0, leaks(r.json).join(','));
r = await req('GET', '/notifications', { token: CUST_A });
check('no workspaceId in the customer notifications payload', leaks(r.json).length === 0, leaks(r.json).join(','));
r = await req('GET', '/products');
check('no workspaceId in the public catalogue payload', leaks(r.json).length === 0, leaks(r.json).join(','));
r = await req('GET', '/shops');
check('the shop directory still answers { slug, displayName } only',
  (r.json?.shops || []).every((s) => Object.keys(s).sort().join(',') === 'displayName,slug'));

// ── cleanup ──
await stopTestServer(SERVER, base);
await new Promise((resolve) => mockServer.close(resolve));
if (process.env.CHECKOUT_KEEP_DB !== 'true') {
  await mongoose.connection.db.dropDatabase();
  console.log(`\n— cleanup: cleared ${DB_NAME} —`);
}
await mongoose.disconnect();

console.log(`\nCHECKOUT RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILED CHECKS:');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
