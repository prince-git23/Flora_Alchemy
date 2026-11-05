/**
 * Phase 24 — ANALYTICS suite: server-measured performance, revenue rule and
 * workspace isolation.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/api/analytics/performance` used to return only customer rows, so the admin
 * page rebuilt product revenue from the hydrated order list (capped at 500).
 * That made a capped list able to under-report revenue and let the browser own
 * a second definition of "revenue". The endpoint now measures product
 * performance itself; this suite proves:
 *
 *   §1 CONTRACT     — the payload carries productPerformance, totals and
 *                     customerPerformance, and is derived from stored orders.
 *   §2 REVENUE RULE — Paid and legacy Sample count; Pending, Failed and
 *                     Refunded never do, in products, customer spend, totals
 *                     and /overview alike.
 *   §3 ORDER COUNT  — an order is counted once even when it contains the same
 *                     product on two lines (the old browser code counted lines).
 *   §4 SCOPE        — workspace A never sees workspace B's products, customers
 *                     or revenue, and B's numbers are its own.
 *   §5 PERMISSIONS  — success for a handler (analytics.view), 401 anonymous,
 *                     workspace-required refusal for a platform owner.
 *   §6 WINDOW       — an optional `days` window is accepted and clamped; the
 *                     default stays all-time.
 *
 * Isolation: own server (port 4114), own `Flora-Alchemy-Test-Analytics`
 * database, SEED_ON_START=false. Never touches dev or production data.
 *
 * Run: node scripts/analytics-smoke.mjs  (or `npm run test:analytics`)
 */
import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import Order from '../models/Order.js';

const DB_NAME = 'Flora-Alchemy-Test-Analytics';
const PORT = Number(process.env.ANALYTICS_PORT || 4114);

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([Workspace.init(), User.init(), Customer.init(), Product.init(), Order.init()]);

const stamp = Date.now();
const P = (name) => `${name}-Passw0rd-${stamp}!`;

const wsA = await Workspace.create({ slug: `an-ws-a-${stamp}`, displayName: 'Analytics Salon A' });
const wsB = await Workspace.create({ slug: `an-ws-b-${stamp}`, displayName: 'Analytics Salon B' });

const hash = await bcrypt.hash(P('Admin'), 10);
const adminA = await User.create({
  email: `an-admin-a-${stamp}@analytics.test`,
  passwordHash: hash,
  role: 'admin',
  name: 'Analytics Admin A',
  workspaceId: wsA._id,
});
await User.create({
  email: `an-admin-b-${stamp}@analytics.test`,
  passwordHash: hash,
  role: 'admin',
  name: 'Analytics Admin B',
  workspaceId: wsB._id,
});
await User.create({
  email: `an-handler-a-${stamp}@analytics.test`,
  passwordHash: hash,
  role: 'handler',
  name: 'Analytics Handler A',
  workspaceId: wsA._id,
});
await User.create({
  email: `an-owner-${stamp}@analytics.test`,
  passwordHash: hash,
  role: 'admin',
  name: 'Analytics Owner',
  isOwner: true,
});

const custA = await Customer.create({ name: 'Analytics Customer A', email: `an-cust-a-${stamp}@analytics.test` });
const custB = await Customer.create({ name: 'Analytics Customer B', email: `an-cust-b-${stamp}@analytics.test` });

const productA1 = await Product.create({
  name: 'Analytics Posy A1', slug: `an-posy-a1-${stamp}`, price: 1200, category: 'Posies', workspaceId: wsA._id,
});
const productA2 = await Product.create({
  name: 'Analytics Posy A2', slug: `an-posy-a2-${stamp}`, price: 500, category: 'Posies', workspaceId: wsA._id,
});
const productA3 = await Product.create({
  name: 'Analytics Pending A3', slug: `an-pending-a3-${stamp}`, price: 900, category: 'Posies', workspaceId: wsA._id,
});
const productB = await Product.create({
  name: 'Analytics Posy B1', slug: `an-posy-b1-${stamp}`, price: 700, category: 'Bouquets', workspaceId: wsB._id,
});

function line(product, quantity = 1) {
  return { name: product.name, productSlug: product.slug, price: product.price, quantity };
}

let seq = 0;
async function order({ workspaceId, customer, items, total, paymentStatus, orderStatus = 'delivered', createdAt }) {
  seq += 1;
  return Order.create({
    orderId: `AN-${stamp}-${seq}`,
    customerId: customer._id,
    customerName: customer.name,
    items,
    subtotal: total,
    total,
    orderStatus,
    paymentStatus,
    workspaceId,
    ...(createdAt ? { createdAt } : {}),
  });
}

// A1 is sold twice (two separate paid orders), so an order count of 2 is
// distinguishable from a line count.
await order({ workspaceId: wsA._id, customer: custA, items: [line(productA1)], total: 1200, paymentStatus: 'Paid' });
await order({ workspaceId: wsA._id, customer: custA, items: [line(productA1)], total: 1200, paymentStatus: 'Paid' });
// Sample is the legacy prototype's stand-in for paid and still counts.
await order({ workspaceId: wsA._id, customer: custA, items: [line(productA2)], total: 500, paymentStatus: 'Sample' });
// Never revenue: Pending, Failed, Refunded.
await order({ workspaceId: wsA._id, customer: custA, items: [line(productA3)], total: 900, paymentStatus: 'Pending' });
await order({ workspaceId: wsA._id, customer: custA, items: [line(productA3)], total: 900, paymentStatus: 'Failed' });
await order({ workspaceId: wsA._id, customer: custA, items: [line(productA3)], total: 900, paymentStatus: 'Refunded' });
// Workspace B — Paid, but must never appear in A's numbers.
await order({ workspaceId: wsB._id, customer: custB, items: [line(productB)], total: 700, paymentStatus: 'Paid' });
// One paid order with the SAME product on two lines: one order, two units.
await Order.create({
  orderId: `AN-${stamp}-multi`,
  customerId: custA._id,
  customerName: custA.name,
  items: [line(productA2), line(productA2)],
  subtotal: 1000,
  total: 1000,
  orderStatus: 'delivered',
  paymentStatus: 'Paid',
  workspaceId: wsA._id,
});

const { child: SERVER, base } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'analytics-smoke',
});
const BASE = `${base}/api`;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

async function req(method, path_, { token, body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path_}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function login(email) {
  const r = await req('POST', '/auth/login', { body: { email, password: P('Admin') } });
  return { token: r.json?.token || null, status: r.status };
}

const A = (await login(adminA.email)).token;
const B = (await login(`an-admin-b-${stamp}@analytics.test`)).token;
const HANDLER = (await login(`an-handler-a-${stamp}@analytics.test`)).token;
const OWNER = (await login(`an-owner-${stamp}@analytics.test`)).token;
check('workspace A admin signed in', !!A, 'no token');
check('workspace B admin signed in', !!B, 'no token');
check('workspace A handler signed in', !!HANDLER, 'no token');
check('platform owner signed in', !!OWNER, 'no token');

// ══════════ §1 CONTRACT ══════════
console.log('\n— §1 CONTRACT —');
let r = await req('GET', '/analytics/performance', { token: A });
check('performance reads 200 for a workspace admin', r.status === 200, `${r.status}`);
const perf = r.json?.analytics || {};
check('payload carries productPerformance[]', Array.isArray(perf.productPerformance), typeof perf.productPerformance);
check('payload carries totals', !!perf.totals && typeof perf.totals.revenue === 'number');
check('payload carries customerPerformance[]', Array.isArray(perf.customerPerformance));
check('rangeDays is null by default (all-time)', perf.rangeDays === null, `${perf.rangeDays}`);

// ══════════ §2 REVENUE RULE ══════════
console.log('\n— §2 REVENUE RULE —');
const bySlug = new Map((perf.productPerformance || []).map((p) => [p.productSlug, p]));
check('Paid product is measured', bySlug.has(productA1.slug));
check('legacy Sample product is measured', bySlug.has(productA2.slug));
check('Pending product is absent', !bySlug.has(productA3.slug));
check('A1 revenue is the sum of its paid orders (2400)', bySlug.get(productA1.slug)?.revenue === 2400, `${bySlug.get(productA1.slug)?.revenue}`);
check('A2 revenue includes Sample + the two-line Paid order (1500)', bySlug.get(productA2.slug)?.revenue === 1500, `${bySlug.get(productA2.slug)?.revenue}`);
check('revenue-eligible totals are Paid + Sample only (3900)', perf.totals?.revenue === 3900, `${perf.totals?.revenue}`);
check('revenue-eligible order count is 4', perf.totals?.orders === 4, `${perf.totals?.orders}`);
check('units count line quantities (5)', perf.totals?.units === 5, `${perf.totals?.units}`);

const customerA = (perf.customerPerformance || []).find((c) => c.name === custA.name);
check('customer spend follows the same rule (3900)', customerA?.spend === 3900, `${customerA?.spend}`);
check('customer order count includes only revenue-eligible orders (4)', customerA?.orders === 4, `${customerA?.orders}`);

const overview = await req('GET', '/analytics/overview', { token: A });
check('overview revenue agrees with performance (3900)', overview.json?.analytics?.totalRevenue === 3900, `${overview.json?.analytics?.totalRevenue}`);
check('overview order count agrees (4)', overview.json?.analytics?.totalOrders === 4, `${overview.json?.analytics?.totalOrders}`);

// ══════════ §3 ORDER COUNT SEMANTICS ══════════
console.log('\n— §3 ORDER COUNT SEMANTICS —');
const a2 = bySlug.get(productA2.slug);
check('two paid orders for A2 (Sample + two-line) count as 2 orders', a2?.orders === 2, `${a2?.orders}`);
check('the two-line order contributes 2 units, not 2 orders', a2?.units === 3, `${a2?.units}`);

// ══════════ §4 SCOPE ══════════
console.log('\n— §4 WORKSPACE SCOPE —');
check("workspace B's product is absent from A", !bySlug.has(productB.slug));
check("workspace B's customer is absent from A", !(perf.customerPerformance || []).some((c) => c.name === custB.name));

const perfB = (await req('GET', '/analytics/performance', { token: B })).json?.analytics || {};
const slugsB = (perfB.productPerformance || []).map((p) => p.productSlug);
check('B sees only its own product', slugsB.length === 1 && slugsB[0] === productB.slug, JSON.stringify(slugsB));
check('B revenue is 700', perfB.totals?.revenue === 700, `${perfB.totals?.revenue}`);
check('B does not see A customers', !(perfB.customerPerformance || []).some((c) => c.name === custA.name));

// ══════════ §5 PERMISSIONS ══════════
console.log('\n— §5 PERMISSIONS —');
r = await req('GET', '/analytics/performance', { token: HANDLER });
check('handler with analytics.view reads performance (200)', r.status === 200, `${r.status}`);
r = await req('GET', '/analytics/performance');
check('anonymous read is refused (401)', r.status === 401, `${r.status}`);
r = await req('GET', '/analytics/performance', { token: OWNER });
check('platform owner without a workspace is refused (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);

// ══════════ §6 WINDOW ══════════
console.log('\n— §6 WINDOW —');
r = await req('GET', '/analytics/performance?days=30', { token: A });
check('days=30 is accepted', r.status === 200 && r.json?.analytics?.rangeDays === 30, `${r.status} ${r.json?.analytics?.rangeDays}`);
check('recent orders are included in the window', r.json?.analytics?.totals?.revenue === 3900, `${r.json?.analytics?.totals?.revenue}`);
r = await req('GET', '/analytics/performance?days=abc', { token: A });
check('a non-numeric window falls back rather than erroring (200)', r.status === 200, `${r.status}`);
check('the fallback window is reported (30)', r.json?.analytics?.rangeDays === 30, `${r.json?.analytics?.rangeDays}`);
r = await req('GET', '/analytics/performance?days=99999', { token: A });
check('an over-large window is clamped to 3650', r.json?.analytics?.rangeDays === 3650, `${r.json?.analytics?.rangeDays}`);

console.log(`\nANALYTICS RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
}

await mongoose.disconnect().catch(() => {});
await stopTestServer(SERVER, base);
