/**
 * Phase 22.3 — CROSS-TENANT SECURITY MATRIX suite.
 *
 * tenant-core-smoke.mjs proves the FOUNDATION (helpers, gates, injection,
 * migration, audit). This suite proves ISOLATION BETWEEN TWO REAL
 * WORKSPACES: every staff-facing surface is exercised from BOTH sides, so a
 * regression that accidentally drops one scope filter shows up as a concrete
 * cross-tenant leak here.
 *
 *   §1  FIXTURES        — Workspace A/B, Admin A/B, Handler A/B, an unscoped
 *     admin, an owner, customers, products, collections, staff
 *     orders (attributed server-side), conversations, custom
 *     requests, notifications.
 *   §2  GATES           — owner refused on operational surfaces (§18), owner
 *     allowed on §19 surfaces, unscoped staff fail closed, customers
 *     refused, public reads unaffected.
 *   §3  PRODUCTS        — list/detail scoped both ways, cross writes 404,
 *     global slug uniqueness, server-derived workspaceId (smuggled
 *     body value ignored), hidden products public-safe.
 *   §4  COLLECTIONS     — same matrix for collections.
 *   §5  ORDERS          — staff order lists disjoint, cross read/update 404,
 *     attribution server-derived, customer ownership intact.
 *   §6  INVENTORY       — overview/history scoped, cross read/adjust 404.
 *   §7  CUSTOMERS       — RELATIONSHIP rule: served-by-A visible to A only,
 *     unserved customer invisible to both, cross read/update 404.
 *   §8  CONVERSATIONS   — order-linked conversations scoped, cross read/write
 *     404, list disjoint.
 *   §9  CUSTOM REQUESTS — staff list strictly scoped (Phase 22.5: legacy
 *     unattributed rows are NO LONGER visible to any workspace),
 *     cross status update 404.
 *   §10 STAFF + OPERATORS — directory/operators disjoint, cross dossier,
 *     suspend and profile edit 404, owner sees the whole platform.
 *   §11 INVITATIONS     — ledger scoped, binding server-derived, cross
 *     read/revoke 404, owner sees both ledgers.
 *   §12 NOTIFICATIONS   — read-side belt: a foreign-workspace notification
 *     addressed to me is hidden; legacy (unattributed) is now hidden too.
 *   §13 ANALYTICS       — orders/revenue/customers/products each equal the
 *     caller's OWN numbers, never the other tenant's.
 *   §14 SETTINGS        — per-workspace documents; owner patches the shared
 *     singleton without touching either workspace's copy.
 *   §15 UPLOADS         — gate before multer (403 without membership), local
 *     file written under the workspace's slug prefix.
 *   §16 RACES           — concurrent inventory overdraw (never negative),
 *     concurrent cross-tenant product update (loser 404s, writes nothing),
 *     invitation activation reuse (exactly one winner), concurrent
 *     duplicate-slug create (one 201, one 409).
 *   §17 SUSPENSION      — workspace suspended mid-run: member refused on the
 *     next request (403 WORKSPACE_SUSPENDED, no cache), catalogue degrades
 *     to public, the OTHER workspace is unaffected, reactivation restores.
 *   §18 PUBLIC REGRESSION — storefront reads/health unchanged throughout.
 *
 * Isolation: own server (port 4104), own DB (Flora-Alchemy-Test-TenantMatrix),
 * SEED_ON_START=false. Nothing here ever touches dev or production data.
 *
 * Run: node scripts/tenant-matrix-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import Collection from '../models/Collection.js';
import Order from '../models/Order.js';
import Inventory from '../models/Inventory.js';
import InventoryMovement from '../models/InventoryMovement.js';
import Conversation from '../models/Conversation.js';
import CustomRequest from '../models/CustomRequest.js';
import Settings from '../models/Settings.js';
import Invitation from '../models/Invitation.js';
import Notification from '../models/Notification.js';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');
const DB_NAME = 'Flora-Alchemy-Test-TenantMatrix';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

// ── Deterministic start: drop the dedicated test DB, pre-build indexes ──
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  Workspace.init(),
  User.init(),
  Customer.init(),
  Product.init(),
  Collection.init(),
  Order.init(),
  Inventory.init(),
  InventoryMovement.init(),
  Conversation.init(),
  CustomRequest.init(),
  Settings.init(),
  Invitation.init(),
  Notification.init(),
]);

const stamp = Date.now();
const ownerPassword = `Owner-Passw0rd-${stamp}!`;
const adminAPassword = `AdminA-Passw0rd-${stamp}!`;
const adminBPassword = `AdminB-Passw0rd-${stamp}!`;
const handlerAPassword = `HandlerA-Passw0rd-${stamp}!`;
const handlerBPassword = `HandlerB-Passw0rd-${stamp}!`;
const unscopedPassword = `Unscoped-Passw0rd-${stamp}!`;
const activatePassword = `Activate-Passw0rd-${stamp}!`;
const registerPassword = `Register-Passw0rd-${stamp}!`;

// ══════════ §1 — FIXTURES ══════════
console.log('\n— §1 FIXTURES (two workspaces, fully attributed) —');

const wsA = await Workspace.create({ slug: 'matrix-ws-a', displayName: 'Matrix Salon A' });
const wsB = await Workspace.create({ slug: 'matrix-ws-b', displayName: 'Matrix Salon B' });

async function makeUser({ email, password, role, name, workspaceId, isOwner = false }) {
  return User.create({
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role,
    name,
    isOwner,
    isFixture: false,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

const owner = await makeUser({ email: `owner-${stamp}@matrix.test`, password: ownerPassword, role: 'admin', name: 'Matrix Owner', isOwner: true });
const adminA = await makeUser({ email: `admin-a-${stamp}@matrix.test`, password: adminAPassword, role: 'admin', name: 'Matrix Admin A', workspaceId: wsA._id });
const adminB = await makeUser({ email: `admin-b-${stamp}@matrix.test`, password: adminBPassword, role: 'admin', name: 'Matrix Admin B', workspaceId: wsB._id });
const handlerA = await makeUser({ email: `handler-a-${stamp}@matrix.test`, password: handlerAPassword, role: 'handler', name: 'Matrix Handler A', workspaceId: wsA._id });
const handlerB = await makeUser({ email: `handler-b-${stamp}@matrix.test`, password: handlerBPassword, role: 'handler', name: 'Matrix Handler B', workspaceId: wsB._id });
const unscopedAdmin = await makeUser({ email: `unscoped-${stamp}@matrix.test`, password: unscopedPassword, role: 'admin', name: 'Matrix Unscoped Admin' });

const custA = await Customer.create({ name: 'Matrix Customer A', email: `cust-a-${stamp}@matrix.test` });
const custB = await Customer.create({ name: 'Matrix Customer B', email: `cust-b-${stamp}@matrix.test` });
const custX = await Customer.create({ name: 'Matrix Customer X', email: `cust-x-${stamp}@matrix.test` });
const custLegacy = await Customer.create({ name: 'Matrix Customer Legacy', email: `cust-legacy-${stamp}@matrix.test` });

const { child: SERVER, base } = await bootTestServer({
  port: 4104,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'tenant-matrix-smoke',
});
const BASE = `${base}/api`;

// One long-lived connection for direct-document assertions.
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

async function req(method, path_, { token, body, headers = {}, form } = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${path_}`, {
        method,
        headers: h,
        body: form ? form : body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch { /* non-json */ }
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

const OWNER = await login(owner.email, ownerPassword);
const ADMIN_A = await login(adminA.email, adminAPassword);
const ADMIN_B = await login(adminB.email, adminBPassword);
const HANDLER_A = await login(handlerA.email, handlerAPassword);
const HANDLER_B = await login(handlerB.email, handlerBPassword);
const UNSCOPED = await login(unscopedAdmin.email, unscopedPassword);
check('all staff sessions issued', !!(OWNER && ADMIN_A && ADMIN_B && HANDLER_A && HANDLER_B && UNSCOPED));

// Shared storefront products (each workspace's own, attributed server-side).
let r = await req('POST', '/products', {
  token: ADMIN_A,
  body: { name: 'Matrix Bloom A', price: 750, category: 'Posies', initialStock: 50, workspaceId: wsB._id },
});
check('product A created (201)', r.status === 201, `${r.status}`);
const productA = await Product.findOne({ slug: 'matrix-bloom-a' }).lean();
check('product A is attributed to workspace A (body workspaceId ignored)', productA && String(productA.workspaceId) === String(wsA._id), `ws=${productA?.workspaceId}`);

r = await req('POST', '/products', {
  token: ADMIN_A,
  body: { name: 'Matrix Hidden A', price: 640, visibility: 'Hidden', initialStock: 5, workspaceId: wsB._id },
});
check('hidden product A created (201)', r.status === 201, `${r.status}`);

r = await req('POST', '/products', {
  token: ADMIN_B,
  body: { name: 'Matrix Bloom B', price: 900, category: 'Posies', initialStock: 50, workspaceId: wsA._id },
});
check('product B created (201)', r.status === 201, `${r.status}`);
const productB = await Product.findOne({ slug: 'matrix-bloom-b' }).lean();
check('product B is attributed to workspace B', productB && String(productB.workspaceId) === String(wsB._id), `ws=${productB?.workspaceId}`);

r = await req('POST', '/products', {
  token: ADMIN_A,
  body: { name: 'Matrix Race Stock', price: 300, initialStock: 10 },
});
check('race-stock product created (201)', r.status === 201, `${r.status}`);

const invA = await Inventory.findOne({ productSlug: 'matrix-bloom-a' }).lean();
const invB = await Inventory.findOne({ productSlug: 'matrix-bloom-b' }).lean();
check('inventory A stamped with workspace A', invA && String(invA.workspaceId) === String(wsA._id), `ws=${invA?.workspaceId}`);
check('inventory B stamped with workspace B', invB && String(invB.workspaceId) === String(wsB._id), `ws=${invB?.workspaceId}`);

r = await req('POST', '/collections', { token: ADMIN_A, body: { name: 'Matrix Collection A' } });
check('collection A created (201)', r.status === 201, `${r.status}`);
r = await req('POST', '/collections', { token: ADMIN_B, body: { name: 'Matrix Collection B' } });
check('collection B created (201)', r.status === 201, `${r.status}`);

// Staff orders — attribution comes from the CALLER's membership; a smuggled
// body workspaceId is scrubbed before the controller runs.
r = await req('POST', '/orders/admin', {
  token: ADMIN_A,
  body: { customerId: String(custA._id), items: [{ productSlug: 'matrix-bloom-a', quantity: 1 }], workspaceId: wsB._id },
});
check('staff order A created (201)', r.status === 201, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 160)}`);
const orderA = r.json?.order;

r = await req('POST', '/orders/admin', {
  token: ADMIN_B,
  body: { customerId: String(custB._id), items: [{ productSlug: 'matrix-bloom-b', quantity: 1 }] },
});
check('staff order B created (201)', r.status === 201, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 160)}`);
const orderB = r.json?.order;
check('order A attributed to workspace A', orderA && String(orderA.workspaceId) === String(wsA._id), `ws=${orderA?.workspaceId}`);
check('order B attributed to workspace B', orderB && String(orderB.workspaceId) === String(wsB._id), `ws=${orderB?.workspaceId}`);

// Conversations (one per order, created through the real staff endpoint).
r = await req('GET', `/conversations/order/${orderA.orderId}`, { token: ADMIN_A });
check('conversation for order A created (200)', r.status === 200, `${r.status}`);
r = await req('GET', `/conversations/order/${orderB.orderId}`, { token: ADMIN_B });
check('conversation for order B created (200)', r.status === 200, `${r.status}`);
const convA = await Conversation.findOne({ orderId: orderA.orderId }).lean();
const convB = await Conversation.findOne({ orderId: orderB.orderId }).lean();
check('conversation A stamped with workspace A', convA && String(convA.workspaceId) === String(wsA._id), `ws=${convA?.workspaceId}`);
check('conversation B stamped with workspace B', convB && String(convB.workspaceId) === String(wsB._id), `ws=${convB?.workspaceId}`);

// Custom requests — one attributed to A, one attributed to B, and one
// legacy/unattributed. Phase 22.5 completed the backfill, so the legacy row
// must now be invisible to BOTH workspaces (strict isolation).
const crA = await CustomRequest.create({
  customerId: custX._id,
  description: 'Matrix custom request owned by workspace A (isolation fixture).',
  status: 'pending',
  workspaceId: wsA._id,
});
const crB = await CustomRequest.create({
  customerId: custB._id,
  description: 'Matrix custom request owned by workspace B (isolation fixture).',
  status: 'pending',
  workspaceId: wsB._id,
});
const crLegacy = await CustomRequest.create({
  customerId: custLegacy._id,
  description: 'Matrix legacy custom request with no workspace attribution.',
  status: 'pending',
});

// Notifications — n2 is deliberately addressed to Admin A but stamped with
// workspace B (the read-side belt must hide it from A).
await Notification.create([
  { userId: adminA._id, role: 'admin', type: 'system', title: 'A scoped ping', message: 'Matrix A workspace notification.', workspaceId: wsA._id },
  { userId: adminA._id, role: 'admin', type: 'system', title: 'B scoped leak attempt', message: 'Matrix B workspace notification addressed to A.', workspaceId: wsB._id },
  { userId: adminA._id, role: 'admin', type: 'system', title: 'Legacy ping', message: 'Matrix unattributed notification.' },
  { userId: adminB._id, role: 'admin', type: 'system', title: 'B scoped ping', message: 'Matrix B workspace notification.', workspaceId: wsB._id },
]);

// ══════════ §2 — GATES ══════════
console.log('\n— §2 GATES (§18 refuses owner/unscoped, §19 keeps owner surfaces) —');
r = await req('GET', '/orders', { token: OWNER });
check('owner refused the order list (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('GET', '/inventory', { token: OWNER });
check('owner refused inventory (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('GET', '/analytics/overview', { token: OWNER });
check('owner refused analytics (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('POST', '/products', { token: OWNER, body: { name: 'Owner Should Not', price: 1 } });
check('owner refused product create (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('GET', '/admin/staff', { token: OWNER });
check('owner reads the staff directory (§19, allowOwner)', r.status === 200, `${r.status}`);
r = await req('GET', '/admin/users', { token: OWNER });
check('owner reads the operator list (§19, allowOwner)', r.status === 200, `${r.status}`);
r = await req('GET', '/admin/invitations', { token: OWNER });
check('owner reads the invitation ledger (§19, allowOwner)', r.status === 200, `${r.status}`);

r = await req('GET', '/orders', { token: UNSCOPED });
check('unscoped admin refused the order list (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('GET', '/inventory', { token: UNSCOPED });
check('unscoped admin refused inventory (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('GET', '/admin/staff', { token: UNSCOPED });
check('unscoped admin refused the staff directory (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('PATCH', '/settings', { token: UNSCOPED, body: { storeName: 'Should Not Land' } });
check('unscoped admin refused settings write (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('POST', '/admin/invitations', { token: UNSCOPED, body: { name: 'No', email: `nope-${stamp}@matrix.test`, role: 'handler' } });
check('unscoped admin refused invitation issue (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);

r = await req('GET', '/products');
check('public catalogue read needs no workspace (200)', r.status === 200 && Array.isArray(r.json?.products), `${r.status}`);
r = await req('GET', '/settings');
check('public settings read needs no workspace (200)', r.status === 200, `${r.status}`);
r = await req('GET', '/health');
check('health probe unchanged (200)', r.status === 200 && r.json?.status === 'ok', `${r.status}`);

// ══════════ §3 — PRODUCTS ══════════
console.log('\n— §3 PRODUCTS (scoped both ways, cross writes 404) —');
r = await req('GET', '/products', { token: ADMIN_A });
const aNames = (r.json?.products || []).map((p) => p.slug);
check('A sees its own products', aNames.includes('matrix-bloom-a') && aNames.includes('matrix-hidden-a'), JSON.stringify(aNames));
check('A never sees B\'s products', !aNames.includes('matrix-bloom-b'), JSON.stringify(aNames));

r = await req('GET', '/products', { token: ADMIN_B });
const bNames = (r.json?.products || []).map((p) => p.slug);
check('B sees its own products', bNames.includes('matrix-bloom-b'), JSON.stringify(bNames));
check('B never sees A\'s products (even the Hidden one)', !bNames.includes('matrix-bloom-a') && !bNames.includes('matrix-hidden-a'), JSON.stringify(bNames));

r = await req('GET', '/products');
const publicNames = (r.json?.products || []).map((p) => p.slug);
check('public storefront shows both Visible products', publicNames.includes('matrix-bloom-a') && publicNames.includes('matrix-bloom-b'), JSON.stringify(publicNames));
check('public storefront never shows the Hidden product', !publicNames.includes('matrix-hidden-a'), JSON.stringify(publicNames));

r = await req('GET', '/products/matrix-bloom-b', { token: ADMIN_A });
check('A reading B\'s product detail → 404', r.status === 404, `${r.status}`);
r = await req('GET', '/products/matrix-bloom-a', { token: ADMIN_B });
check('B reading A\'s product detail → 404', r.status === 404, `${r.status}`);
r = await req('GET', '/products/matrix-bloom-a', { token: ADMIN_A });
check('A reads its own product detail → 200', r.status === 200, `${r.status}`);

r = await req('PATCH', '/products/matrix-bloom-b', { token: ADMIN_A, body: { price: 111 } });
check('A patching B\'s product → 404', r.status === 404, `${r.status}`);
check('B\'s product price untouched by A\'s write', (await Product.findOne({ slug: 'matrix-bloom-b' }).lean()).price === 900, 'price changed');

r = await req('DELETE', '/products/matrix-bloom-a', { token: ADMIN_B });
check('B deleting A\'s product → 404', r.status === 404, `${r.status}`);
check('A\'s product still exists after B\'s delete attempt', !!(await Product.findOne({ slug: 'matrix-bloom-a' }).lean()));

r = await req('POST', '/products', { token: ADMIN_B, body: { name: 'Matrix Bloom A', price: 1 } });
check('global slug uniqueness: duplicate name → 409 DUPLICATE', r.status === 409 && r.json?.code === 'DUPLICATE', `${r.status} ${r.json?.code}`);

// ══════════ §4 — COLLECTIONS ══════════
console.log('\n— §4 COLLECTIONS (same matrix as products) —');
r = await req('GET', '/collections', { token: ADMIN_A });
const aColl = (r.json?.collections || []).map((c) => c.slug);
check('A sees its collection, not B\'s', aColl.includes('matrix-collection-a') && !aColl.includes('matrix-collection-b'), JSON.stringify(aColl));
r = await req('GET', '/collections', { token: ADMIN_B });
const bColl = (r.json?.collections || []).map((c) => c.slug);
check('B sees its collection, not A\'s', bColl.includes('matrix-collection-b') && !bColl.includes('matrix-collection-a'), JSON.stringify(bColl));
r = await req('PATCH', '/collections/matrix-collection-b', { token: ADMIN_A, body: { description: 'cross' } });
check('A patching B\'s collection → 404', r.status === 404, `${r.status}`);
r = await req('DELETE', '/collections/matrix-collection-a', { token: ADMIN_B });
check('B deleting A\'s collection → 404', r.status === 404, `${r.status}`);
check('A\'s collection still exists', !!(await Collection.findOne({ slug: 'matrix-collection-a' }).lean()));

// ══════════ §5 — ORDERS ══════════
console.log('\n— §5 ORDERS (disjoint lists, cross read/update 404) —');
r = await req('GET', '/orders', { token: ADMIN_A });
const aOrderIds = (r.json?.orders || []).map((o) => o.orderId);
check('A\'s order list contains order A', aOrderIds.includes(orderA.orderId), JSON.stringify(aOrderIds));
check('A\'s order list never contains order B', !aOrderIds.includes(orderB.orderId), JSON.stringify(aOrderIds));

r = await req('GET', '/orders', { token: ADMIN_B });
const bOrderIds = (r.json?.orders || []).map((o) => o.orderId);
check('B\'s order list contains order B', bOrderIds.includes(orderB.orderId), JSON.stringify(bOrderIds));
check('B\'s order list never contains order A', !bOrderIds.includes(orderA.orderId), JSON.stringify(bOrderIds));

r = await req('GET', `/orders/${orderA.orderId}`, { token: ADMIN_B });
check('B reading order A → 404 ORDER_NOT_FOUND', r.status === 404 && r.json?.code === 'ORDER_NOT_FOUND', `${r.status} ${r.json?.code}`);
r = await req('GET', `/orders/${orderB.orderId}`, { token: ADMIN_A });
check('A reading order B → 404 ORDER_NOT_FOUND', r.status === 404 && r.json?.code === 'ORDER_NOT_FOUND', `${r.status} ${r.json?.code}`);
r = await req('GET', `/orders/${orderA.orderId}`, { token: ADMIN_A });
check('A reads its own order → 200', r.status === 200, `${r.status}`);

r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: ADMIN_B, body: { status: 'confirmed' } });
check('B updating order A status → 404', r.status === 404, `${r.status}`);
const orderAAfter = await Order.findOne({ orderId: orderA.orderId }).lean();
check('order A status untouched by B', orderAAfter.orderStatus === 'new', orderAAfter.orderStatus);

r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: ADMIN_A, body: { status: 'confirmed' } });
check('A updates its own order status → 200', r.status === 200, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 120)}`);

// Customer sessions keep the ownership rule (no existence disclosure).
const regEmail = `customer-c-${stamp}@matrix.test`;
r = await req('POST', '/auth/register', { body: { name: 'Matrix Customer C', email: regEmail, password: registerPassword, role: 'customer' } });
check('customer C registered (201)', r.status === 201, `${r.status}`);
const CUSTOMER_C = await login(regEmail, registerPassword);
check('customer C session issued', !!CUSTOMER_C);
r = await req('GET', `/orders/${orderA.orderId}`, { token: CUSTOMER_C });
check('unrelated customer reading order A → 404', r.status === 404, `${r.status}`);
r = await req('GET', '/orders', { token: CUSTOMER_C });
check('customer cannot use the staff order list → 403', r.status === 403, `${r.status}`);

// ══════════ §6 — INVENTORY ══════════
console.log('\n— §6 INVENTORY (overview/history scoped, cross adjust 404) —');
r = await req('GET', '/inventory', { token: ADMIN_A });
const aInv = (r.json?.inventory || []).map((i) => i.productSlug);
check('A\'s inventory overview includes A\'s stock', aInv.includes('matrix-bloom-a') && aInv.includes('matrix-race-stock'), JSON.stringify(aInv));
check('A\'s inventory overview excludes B\'s stock', !aInv.includes('matrix-bloom-b'), JSON.stringify(aInv));

r = await req('GET', '/inventory', { token: ADMIN_B });
const bInv = (r.json?.inventory || []).map((i) => i.productSlug);
check('B\'s inventory overview excludes A\'s stock', !bInv.includes('matrix-bloom-a') && !bInv.includes('matrix-race-stock'), JSON.stringify(bInv));

r = await req('GET', '/inventory/matrix-bloom-b', { token: ADMIN_A });
check('A reading B\'s inventory record → 404', r.status === 404, `${r.status}`);
r = await req('POST', '/inventory/matrix-bloom-b/adjust', { token: ADMIN_A, body: { type: 'restock', quantity: 5 } });
check('A adjusting B\'s stock → 404', r.status === 404, `${r.status}`);
check('B\'s stock untouched by A\'s adjust', (await Inventory.findOne({ productSlug: 'matrix-bloom-b' }).lean()).currentStock === 49, 'stock changed');

r = await req('POST', '/inventory/matrix-bloom-a/adjust', { token: ADMIN_A, body: { type: 'remove', quantity: 1, reason: 'matrix isolation check' } });
check('A adjusts its own stock → 200', r.status === 200, `${r.status}`);
const invAAfter = await Inventory.findOne({ productSlug: 'matrix-bloom-a' }).lean();
check('A\'s stock decreased to 48', invAAfter.currentStock === 48, String(invAAfter.currentStock));
check('the movement is attributed to workspace A', String(invAAfter.workspaceId) === String(wsA._id), String(invAAfter.workspaceId));
const moveA = await InventoryMovement.findOne({ productSlug: 'matrix-bloom-a' }).lean();
check('movement record stamped with workspace A', moveA && String(moveA.workspaceId) === String(wsA._id), String(moveA?.workspaceId));

r = await req('GET', '/inventory/history', { token: ADMIN_B });
const bMoves = (r.json?.movements || []).map((m) => m.productSlug);
check('B\'s movement history shows no A movements', !bMoves.includes('matrix-bloom-a'), JSON.stringify(bMoves));

// ══════════ §7 — CUSTOMERS (RELATIONSHIP rule) ══════════
console.log('\n— §7 CUSTOMERS (relationship visibility, cross read/update 404) —');
r = await req('GET', '/customers', { token: ADMIN_A });
const aCustIds = (r.json?.customers || []).map((c) => String(c.id || c._id));
check('A sees the customer it served (order A)', aCustIds.includes(String(custA._id)), JSON.stringify(aCustIds));
check('A sees the customer behind its custom request', aCustIds.includes(String(custX._id)), JSON.stringify(aCustIds));
check('A never sees B\'s customer', !aCustIds.includes(String(custB._id)), JSON.stringify(aCustIds));

r = await req('GET', '/customers', { token: ADMIN_B });
const bCustIds = (r.json?.customers || []).map((c) => String(c.id || c._id));
check('B sees the customer it served (order B)', bCustIds.includes(String(custB._id)), JSON.stringify(bCustIds));
check('B never sees A\'s customers', !bCustIds.includes(String(custA._id)) && !bCustIds.includes(String(custX._id)), JSON.stringify(bCustIds));

r = await req('GET', `/customers/${String(custB._id)}`, { token: ADMIN_A });
check('A reading B\'s customer → 404', r.status === 404, `${r.status}`);
r = await req('PATCH', `/customers/${String(custB._id)}`, { token: ADMIN_A, body: { name: 'Renamed By A' } });
check('A patching B\'s customer → 404', r.status === 404, `${r.status}`);
check('B\'s customer name untouched', (await Customer.findById(custB._id).lean()).name === 'Matrix Customer B', 'name changed');
r = await req('GET', `/customers/${String(custA._id)}`, { token: ADMIN_A });
check('A reads its served customer → 200', r.status === 200, `${r.status}`);

// ══════════ §8 — CONVERSATIONS ══════════
console.log('\n— §8 CONVERSATIONS (scoped by order linkage) —');
r = await req('GET', `/conversations/order/${orderA.orderId}`, { token: ADMIN_B });
check('B opening order A\'s conversation → 404', r.status === 404, `${r.status}`);
r = await req('GET', `/conversations/order/${orderA.orderId}`, { token: ADMIN_A });
check('A opens its own conversation → 200', r.status === 200, `${r.status}`);

r = await req('GET', '/conversations', { token: ADMIN_A });
const aConvIds = (r.json?.conversations || []).map((c) => String(c.id || c._id));
check('A\'s conversation list contains its conversation', aConvIds.includes(String(convA.id || convA._id)), JSON.stringify(aConvIds));
check('A\'s conversation list never contains B\'s', !aConvIds.includes(String(convB.id || convB._id)), JSON.stringify(aConvIds));

r = await req('GET', '/conversations', { token: ADMIN_B });
const bConvIds = (r.json?.conversations || []).map((c) => String(c.id || c._id));
check('B\'s conversation list never contains A\'s', !bConvIds.includes(String(convA.id || convA._id)), JSON.stringify(bConvIds));

r = await req('POST', `/conversations/${String(convA.id || convA._id)}/messages`, { token: ADMIN_B, body: { body: 'cross tenant message attempt' } });
check('B sending a message into A\'s conversation → 404', r.status === 404, `${r.status}`);
r = await req('POST', `/conversations/${String(convA.id || convA._id)}/messages`, { token: ADMIN_A, body: { body: 'Matrix A reply (isolation fixture).' } });
check('A messages its own conversation → 201', r.status === 201, `${r.status}`);
r = await req('GET', `/conversations/${String(convA.id || convA._id)}/messages`, { token: ADMIN_B });
check('B reading A\'s messages → 404', r.status === 404, `${r.status}`);

// ══════════ §9 — CUSTOM REQUESTS ══════════
console.log('\n— §9 CUSTOM REQUESTS (scoped staff list, cross status update 404) —');
r = await req('GET', '/custom-requests', { token: ADMIN_A });
const aReqIds = (r.json?.requests || []).map((q) => String(q._id));
check('A sees its attributed request', aReqIds.includes(String(crA._id)), JSON.stringify(aReqIds));
check('A never sees the legacy (unattributed) request (strict, post-backfill)', !aReqIds.includes(String(crLegacy._id)), JSON.stringify(aReqIds));
check('A never sees B\'s requests', !aReqIds.includes(String(crB._id)), JSON.stringify(aReqIds));

r = await req('GET', '/custom-requests', { token: ADMIN_B });
const bReqIds = (r.json?.requests || []).map((q) => String(q._id));
check('B sees its attributed request', bReqIds.includes(String(crB._id)), JSON.stringify(bReqIds));
check('B never sees A\'s attributed request', !bReqIds.includes(String(crA._id)), JSON.stringify(bReqIds));
check('B never sees the legacy (unattributed) request (strict, post-backfill)', !bReqIds.includes(String(crLegacy._id)), JSON.stringify(bReqIds));

r = await req('PATCH', `/custom-requests/${String(crA._id)}/status`, { token: ADMIN_B, body: { status: 'reviewing' } });
check('B updating A\'s request status → 404', r.status === 404, `${r.status}`);
check('A\'s request status untouched', (await CustomRequest.findById(crA._id).lean()).status === 'pending', 'status changed');
r = await req('PATCH', `/custom-requests/${String(crA._id)}/status`, { token: ADMIN_A, body: { status: 'reviewing' } });
check('A updates its own request → 200', r.status === 200, `${r.status}`);
r = await req('PATCH', `/custom-requests/${String(crB._id)}/status`, { token: ADMIN_A, body: { status: 'reviewing' } });
check('A updating B\'s request status → 404 (second path)', r.status === 404, `${r.status}`);

// ══════════ §10 — STAFF DIRECTORY + OPERATORS ══════════
console.log('\n— §10 STAFF + OPERATORS (disjoint directories, cross actions 404) —');
r = await req('GET', '/admin/staff', { token: ADMIN_A });
const aStaffEmails = (r.json?.staff || []).map((s) => s.email);
check('A\'s directory contains its members', aStaffEmails.includes(adminA.email) && aStaffEmails.includes(handlerA.email), JSON.stringify(aStaffEmails));
check('A\'s directory never contains B\'s members', !aStaffEmails.includes(adminB.email) && !aStaffEmails.includes(handlerB.email), JSON.stringify(aStaffEmails));

r = await req('GET', '/admin/staff', { token: ADMIN_B });
const bStaffEmails = (r.json?.staff || []).map((s) => s.email);
check('B\'s directory never contains A\'s members', !bStaffEmails.includes(adminA.email) && !bStaffEmails.includes(handlerA.email), JSON.stringify(bStaffEmails));

r = await req('GET', '/admin/staff', { token: OWNER });
const ownerStaffEmails = (r.json?.staff || []).map((s) => s.email);
check('owner directory spans BOTH workspaces (platform scope)', ownerStaffEmails.includes(handlerA.email) && ownerStaffEmails.includes(handlerB.email), JSON.stringify(ownerStaffEmails));

r = await req('GET', `/admin/staff/${String(handlerB._id)}`, { token: ADMIN_A });
check('A opening B\'s staff dossier → 404', r.status === 404, `${r.status}`);
r = await req('POST', `/admin/staff/${String(handlerB._id)}/suspend`, { token: ADMIN_A, body: { reason: 'cross tenant attempt' } });
check('A suspending B\'s handler → 404', r.status === 404, `${r.status}`);
check('B\'s handler still ACTIVE', (await User.findById(handlerB._id).lean()).status === 'ACTIVE', 'status changed');
r = await req('PATCH', `/admin/staff/${String(handlerB._id)}`, { token: ADMIN_A, body: { department: 'Invaded' } });
check('A editing B\'s handler profile → 404', r.status === 404, `${r.status}`);
check('B\'s handler department untouched', !((await User.findById(handlerB._id).lean()).department), 'department changed');
r = await req('GET', `/admin/staff/${String(handlerA._id)}`, { token: ADMIN_A });
check('A opens its own member dossier → 200', r.status === 200, `${r.status}`);

r = await req('GET', '/admin/users', { token: ADMIN_A });
const aOps = (r.json?.operators || []).map((o) => o.email);
check('A\'s operator list contains its members', aOps.includes(adminA.email) && aOps.includes(handlerA.email), JSON.stringify(aOps));
check('A\'s operator list never contains B\'s members', !aOps.includes(adminB.email) && !aOps.includes(handlerB.email), JSON.stringify(aOps));
r = await req('GET', '/admin/users', { token: OWNER });
const ownerOps = (r.json?.operators || []).map((o) => o.email);
check('owner operator list spans both workspaces', ownerOps.includes(adminA.email) && ownerOps.includes(adminB.email), JSON.stringify(ownerOps));

// ══════════ §11 — INVITATIONS ══════════
console.log('\n— §11 INVITATIONS (scoped ledger, server-side binding, cross 404) —');
r = await req('POST', '/admin/invitations', {
  token: ADMIN_A,
  body: { name: 'Matrix Invite A', email: `invite-a-${stamp}@matrix.test`, role: 'handler', department: 'Atelier', workspaceId: wsB._id },
});
check('A issues a handler invitation (201)', r.status === 201, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 140)}`);
const inviteA = await Invitation.findOne({ recipientEmail: `invite-a-${stamp}@matrix.test` }).lean();
check('invitation bound to the ISSUER workspace (body ignored)', inviteA && String(inviteA.workspaceId) === String(wsA._id), `ws=${inviteA?.workspaceId}`);

r = await req('POST', '/admin/invitations', {
  token: ADMIN_B,
  body: { name: 'Matrix Invite B', email: `invite-b-${stamp}@matrix.test`, role: 'handler', department: 'Fulfilment' },
});
check('B issues a handler invitation (201)', r.status === 201, `${r.status}`);
const inviteB = await Invitation.findOne({ recipientEmail: `invite-b-${stamp}@matrix.test` }).lean();

r = await req('GET', '/admin/invitations', { token: ADMIN_A });
const aInvIds = (r.json?.invitations || []).map((i) => i.id);
check('A\'s ledger contains its invitation', aInvIds.includes(String(inviteA._id)), JSON.stringify(aInvIds));
check('A\'s ledger never contains B\'s invitation', !aInvIds.includes(String(inviteB._id)), JSON.stringify(aInvIds));

r = await req('GET', '/admin/invitations', { token: ADMIN_B });
const bInvIds = (r.json?.invitations || []).map((i) => i.id);
check('B\'s ledger never contains A\'s invitation', !bInvIds.includes(String(inviteA._id)), JSON.stringify(bInvIds));

r = await req('GET', `/admin/invitations/${String(inviteB._id)}`, { token: ADMIN_A });
check('A reading B\'s invitation → 404', r.status === 404, `${r.status}`);
r = await req('POST', `/admin/invitations/${String(inviteB._id)}/revoke`, { token: ADMIN_A, body: { reason: 'cross tenant attempt' } });
check('A revoking B\'s invitation → 404', r.status === 404, `${r.status}`);
check('B\'s invitation still INVITED', (await Invitation.findById(inviteB._id).lean()).status === 'INVITED', 'status changed');

r = await req('GET', '/admin/invitations', { token: OWNER });
const ownerInvIds = (r.json?.invitations || []).map((i) => i.id);
check('owner ledger spans both workspaces', ownerInvIds.includes(String(inviteA._id)) && ownerInvIds.includes(String(inviteB._id)), JSON.stringify(ownerInvIds));

// ══════════ §12 — NOTIFICATIONS ══════════
console.log('\n— §12 NOTIFICATIONS (recipient + workspace read belt) —');
r = await req('GET', '/notifications', { token: ADMIN_A });
const aNotes = (r.json?.notifications || []).map((n) => n.title);
check('A sees its own workspace notification', aNotes.includes('A scoped ping'), JSON.stringify(aNotes));
check('A never sees the legacy (unattributed) notification (strict, post-backfill)', !aNotes.includes('Legacy ping'), JSON.stringify(aNotes));
check('A does NOT see a B-stamped notification addressed to it', !aNotes.includes('B scoped leak attempt'), JSON.stringify(aNotes));
check('A never sees B\'s own notification', !aNotes.includes('B scoped ping'), JSON.stringify(aNotes));
check('A unread count matches the one visible item (strict)', r.json?.unreadCount === 1, String(r.json?.unreadCount));

r = await req('GET', '/notifications', { token: ADMIN_B });
const bNotes = (r.json?.notifications || []).map((n) => n.title);
check('B sees its own workspace notification', bNotes.includes('B scoped ping'), JSON.stringify(bNotes));
check('B never sees A\'s notifications', !bNotes.includes('A scoped ping') && !bNotes.includes('B scoped leak attempt'), JSON.stringify(bNotes));

// ══════════ §13 — ANALYTICS ══════════
console.log('\n— §13 ANALYTICS (every number is the caller\'s own) —');
const ownScopeA = { workspaceId: wsA._id, paymentStatus: { $in: ['Paid', 'Sample'] } };
const ownScopeB = { workspaceId: wsB._id, paymentStatus: { $in: ['Paid', 'Sample'] } };
const expectedRevenueA = (await Order.find(ownScopeA).lean()).reduce((s, o) => s + o.total, 0);
const expectedRevenueB = (await Order.find(ownScopeB).lean()).reduce((s, o) => s + o.total, 0);
const expectedCustomersA = (await Order.distinct('customerId', { workspaceId: wsA._id })).length;
const expectedCustomersB = (await Order.distinct('customerId', { workspaceId: wsB._id })).length;
const expectedVisibleA = await Product.countDocuments({ workspaceId: wsA._id, visibility: 'Visible' });
const expectedVisibleB = await Product.countDocuments({ workspaceId: wsB._id, visibility: 'Visible' });

r = await req('GET', '/analytics/overview', { token: ADMIN_A });
const aStats = r.json?.analytics || {};
check('A analytics total orders equals A\'s own orders', aStats.totalOrders === 1, String(aStats.totalOrders));
check('A analytics revenue equals A\'s order total', aStats.totalRevenue === expectedRevenueA, `${aStats.totalRevenue} vs ${expectedRevenueA}`);
check('A analytics customer count is relationship-scoped', aStats.totalCustomers === expectedCustomersA, `${aStats.totalCustomers} vs ${expectedCustomersA}`);
check('A analytics visible products are workspace-scoped', aStats.visibleProducts === expectedVisibleA, `${aStats.visibleProducts} vs ${expectedVisibleA}`);

r = await req('GET', '/analytics/overview', { token: ADMIN_B });
const bStats = r.json?.analytics || {};
check('B analytics total orders equals B\'s own orders', bStats.totalOrders === 1, String(bStats.totalOrders));
check('B analytics revenue equals B\'s order total', bStats.totalRevenue === expectedRevenueB, `${bStats.totalRevenue} vs ${expectedRevenueB}`);
check('B analytics customer count is relationship-scoped', bStats.totalCustomers === expectedCustomersB, `${bStats.totalCustomers} vs ${expectedCustomersB}`);
check('B analytics visible products are workspace-scoped', bStats.visibleProducts === expectedVisibleB, `${bStats.visibleProducts} vs ${expectedVisibleB}`);
check('the two workspaces report genuinely different revenue', expectedRevenueA !== expectedRevenueB, `${expectedRevenueA} vs ${expectedRevenueB}`);

// ══════════ §14 — SETTINGS ══════════
console.log('\n— §14 SETTINGS (per-workspace docs, owner patches the singleton) —');
r = await req('PATCH', '/settings', { token: ADMIN_A, body: { storeName: 'Matrix Studio A' } });
check('A patches its settings (200)', r.status === 200, `${r.status}`);
r = await req('PATCH', '/settings', { token: ADMIN_B, body: { storeName: 'Matrix Studio B' } });
check('B patches its settings (200)', r.status === 200, `${r.status}`);

r = await req('GET', '/settings', { token: ADMIN_A });
check('A reads ITS settings document', r.json?.settings?.storeName === 'Matrix Studio A', r.json?.settings?.storeName);
r = await req('GET', '/settings', { token: ADMIN_B });
check('B reads ITS settings document', r.json?.settings?.storeName === 'Matrix Studio B', r.json?.settings?.storeName);
r = await req('GET', '/settings');
check('the public storefront never sees a workspace\'s settings', r.json?.settings?.storeName !== 'Matrix Studio A' && r.json?.settings?.storeName !== 'Matrix Studio B', r.json?.settings?.storeName);

r = await req('PATCH', '/settings', { token: OWNER, body: { storeName: 'Matrix Platform Studio' } });
check('owner patches the platform singleton (200)', r.status === 200, `${r.status}`);
r = await req('GET', '/settings');
check('public storefront now reads the owner\'s singleton', r.json?.settings?.storeName === 'Matrix Platform Studio', r.json?.settings?.storeName);
r = await req('GET', '/settings', { token: ADMIN_A });
check('workspace A\'s settings untouched by the owner write', r.json?.settings?.storeName === 'Matrix Studio A', r.json?.settings?.storeName);
check('settings documents exist per workspace', (await Settings.countDocuments({ workspaceId: { $in: [wsA._id, wsB._id] } })) === 2, 'workspace settings docs');

// ══════════ §15 — UPLOADS ══════════
console.log('\n— §15 UPLOADS (gate before multer, workspace-namespaced storage) —');
r = await req('POST', '/uploads/product-image', { token: OWNER });
check('owner refused upload (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('POST', '/uploads/product-image', { token: UNSCOPED });
check('unscoped admin refused upload (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const form = new FormData();
form.append('image', new Blob([pngBytes], { type: 'image/png' }), 'pixel.png');
r = await req('POST', '/uploads/product-image', { token: HANDLER_A, form });
check('workspace member upload succeeds (201)', r.status === 201, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 160)}`);
check('upload took the real local path', r.json?.provider === 'local', String(r.json?.provider));
const uploadedUrl = String(r.json?.url || '');
check('file written under the workspace slug prefix', uploadedUrl.includes('matrix-ws-a-'), uploadedUrl);
let uploadedPath = null;
if (uploadedUrl.includes('/uploads/')) {
  uploadedPath = path.join(REPO_ROOT, 'frontend', 'public', 'uploads', uploadedUrl.split('/uploads/')[1]);
}

// ══════════ §16 — RACES ══════════
console.log('\n— §16 RACES (inventory overdraw, cross-tenant writes, token reuse) —');

// R1 — concurrent overdraw: two −7 against stock 10 must never go negative.
const [adj1, adj2] = await Promise.all([
  req('POST', '/inventory/matrix-race-stock/adjust', { token: ADMIN_A, body: { type: 'remove', quantity: 7, reason: 'race 1' } }),
  req('POST', '/inventory/matrix-race-stock/adjust', { token: ADMIN_A, body: { type: 'remove', quantity: 7, reason: 'race 2' } }),
]);
const adjStatuses = [adj1.status, adj2.status].sort();
const adjSuccesses = adjStatuses.filter((s) => s === 200).length;
check('exactly one concurrent overdraw succeeds', adjSuccesses === 1, JSON.stringify(adjStatuses));
check('the losing adjustment is refused with a stock/business error', adjStatuses.some((s) => s === 409), JSON.stringify(adjStatuses));
const raceStock = (await Inventory.findOne({ productSlug: 'matrix-race-stock' }).lean()).currentStock;
check('stock after the race is exactly 3 (never negative)', raceStock === 3, String(raceStock));

// R2 — concurrent cross-tenant update: A can never write B's product, even
// when both requests land at the same moment.
const [cross1, cross2] = await Promise.all([
  req('PATCH', '/products/matrix-bloom-b', { token: ADMIN_A, body: { price: 111 } }),
  req('PATCH', '/products/matrix-bloom-b', { token: ADMIN_B, body: { price: 222 } }),
]);
check('cross-tenant writer got 404', cross1.status === 404 || cross2.status === 404, `${cross1.status}/${cross2.status}`);
check('the legitimate owner write got 200', cross1.status === 200 || cross2.status === 200, `${cross1.status}/${cross2.status}`);
const finalPrice = (await Product.findOne({ slug: 'matrix-bloom-b' }).lean()).price;
check('final price is the OWNER\'s write (222), never the intruder\'s', finalPrice === 222, String(finalPrice));

// R3 — invitation activation reuse: one token, two concurrent activations,
// exactly one account.
r = await req('POST', '/admin/invitations', {
  token: ADMIN_A,
  body: { name: 'Matrix Race Invite', email: `race-${stamp}@matrix.test`, role: 'handler' },
});
check('race invitation issued (201)', r.status === 201, `${r.status}`);
const raceToken = String(r.json?.link || '').split('/activate/')[1];
check('race activation link returned', !!raceToken);
const [act1, act2] = await Promise.all([
  req('POST', `/invitations/${raceToken}/activate`, { body: { password: activatePassword } }),
  req('POST', `/invitations/${raceToken}/activate`, { body: { password: activatePassword } }),
]);
const actOk = [act1, act2].filter((a) => a.status === 200 || a.status === 201).length;
check('exactly ONE concurrent activation wins', actOk === 1, `${act1.status}/${act2.status}`);
check('the losing activation is refused', [act1.status, act2.status].every((s) => s >= 200 && s < 500) && actOk === 1, `${act1.status}/${act2.status}`);
const raceUser = await User.findOne({ email: `race-${stamp}@matrix.test` }).lean();
check('exactly one account was created', (await User.countDocuments({ email: `race-${stamp}@matrix.test` })) === 1, 'count mismatch');
check('the winner inherited the ISSUER workspace', raceUser && String(raceUser.workspaceId) === String(wsA._id), `ws=${raceUser?.workspaceId}`);
r = await req('POST', `/invitations/${raceToken}/activate`, { body: { password: `${activatePassword}x` } });
check('reusing the consumed token afterwards is refused', r.status >= 400, `${r.status}`);

// R4 — concurrent duplicate-slug create: slugs are globally unique, so two
// workspaces racing on the same name produce exactly one winner.
const [dup1, dup2] = await Promise.all([
  req('POST', '/products', { token: ADMIN_A, body: { name: 'Matrix Duplicate Race', price: 100 } }),
  req('POST', '/products', { token: ADMIN_B, body: { name: 'Matrix Duplicate Race', price: 200 } }),
]);
const dupOk = [dup1, dup2].filter((d) => d.status === 201).length;
check('exactly one duplicate-slug create wins', dupOk === 1, `${dup1.status}/${dup2.status}`);
check('the loser is refused with 409/422 (never a second document)',
  [dup1.status, dup2.status].includes(409) || [dup1.status, dup2.status].includes(422),
  `${dup1.status}/${dup2.status}`);
check('exactly one document exists for that slug', (await Product.countDocuments({ slug: 'matrix-duplicate-race' })) === 1, 'count mismatch');

// ══════════ §17 — SUSPENSION (mid-run, no cache) ══════════
console.log('\n— §17 SUSPENSION (takes effect on the very next request) —');
r = await req('GET', '/orders', { token: ADMIN_A });
check('A reads orders normally before suspension', r.status === 200, `${r.status}`);

await Workspace.updateOne({ _id: wsA._id }, { $set: { status: 'SUSPENDED', statusChangedAt: new Date() } });

r = await req('GET', '/orders', { token: ADMIN_A });
check('A refused immediately after suspension (403 WORKSPACE_SUSPENDED)', r.status === 403 && r.json?.code === 'WORKSPACE_SUSPENDED', `${r.status} ${r.json?.code}`);
r = await req('POST', '/products', { token: ADMIN_A, body: { name: 'Suspended Write', price: 1 } });
check('A refused writes while suspended (403 WORKSPACE_SUSPENDED)', r.status === 403 && r.json?.code === 'WORKSPACE_SUSPENDED', `${r.status} ${r.json?.code}`);
r = await req('GET', '/products', { token: ADMIN_A });
const suspendedNames = (r.json?.products || []).map((p) => p.slug);
check('A\'s catalogue read degrades to the public view (no Hidden product)', !suspendedNames.includes('matrix-hidden-a'), JSON.stringify(suspendedNames));
r = await req('GET', '/orders', { token: ADMIN_B });
check('B completely unaffected by A\'s suspension', r.status === 200, `${r.status}`);
r = await req('GET', '/products', { token: ADMIN_B });
check('B\'s staff catalogue view intact during A\'s suspension', (r.json?.products || []).some((p) => p.slug === 'matrix-bloom-b'), 'B lost visibility');

await Workspace.updateOne({ _id: wsA._id }, { $set: { status: 'ACTIVE', statusChangedAt: new Date() } });

r = await req('GET', '/orders', { token: ADMIN_A });
check('A restored immediately after reactivation (200)', r.status === 200, `${r.status}`);
r = await req('GET', '/products', { token: ADMIN_A });
check('A\'s staff catalogue view restored (Hidden product visible again)',
  (r.json?.products || []).some((p) => p.slug === 'matrix-hidden-a'), 'hidden product missing');

// ══════════ §18 — PUBLIC REGRESSION ══════════
console.log('\n— §18 PUBLIC REGRESSION (storefront untouched by all of the above) —');
r = await req('GET', '/products');
check('public catalogue still lists both Visible products', r.status === 200 && (r.json?.products || []).every((p) => p.visibility === 'Visible'), `${r.status}`);
check('public catalogue still hides the Hidden product', !(r.json?.products || []).some((p) => p.slug === 'matrix-hidden-a'), 'hidden leaked');
r = await req('GET', '/collections');
check('public collections read unchanged', r.status === 200, `${r.status}`);
r = await req('GET', '/settings');
check('public settings read unchanged', r.status === 200, `${r.status}`);
r = await req('GET', '/health');
check('health probe unchanged', r.status === 200 && r.json?.status === 'ok', `${r.status}`);

// ── Cleanup: no QA data left behind (DB is dropped next run anyway) ──
try {
  let removed = 0;
  for (const name of ['users', 'workspaces', 'products', 'collections', 'orders', 'inventory', 'inventorymovements', 'conversations', 'customrequests', 'settings', 'invitations', 'staffevents', 'notifications', 'customers', 'messages', 'inventories']) {
    try {
      const res = await mongoose.connection.db.collection(name).deleteMany({});
      removed += res.deletedCount;
    } catch { /* collection may not exist */ }
  }
  console.log(`\n— cleanup: removed ${removed} document(s) from ${DB_NAME} —`);
} catch (err) {
  console.log(`\n— cleanup skipped (${err.message}) —`);
}
try {
  if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
  const uploadsDir = path.join(REPO_ROOT, 'frontend', 'public', 'uploads');
  if (fs.existsSync(uploadsDir)) {
    for (const f of fs.readdirSync(uploadsDir)) {
      if (f.startsWith('matrix-ws-a-') || f.startsWith('matrix-ws-b-')) {
        fs.unlinkSync(path.join(uploadsDir, f));
      }
    }
  }
} catch { /* best-effort file cleanup */ }

console.log(`\nTENANT MATRIX RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}

try {
  await mongoose.disconnect().catch(() => {});
} finally {
  await stopTestServer(SERVER, base);
}
