/**
 * Phase 23 — STAFF / HANDLER ACTION CENTER permission suite.
 *
 * Phase 21/22 proved the portal and tenant foundations. This suite proves the
 * per-OPERATION layer the Action Center stands on, from the handler's own
 * token, so "the button is on screen" can never be mistaken for "the server
 * allows it":
 *
 *   §1 FIXTURES      — workspace A/B, admin A, handlers A/B, a suspended
 *     handler, owner, customers, products, stock, orders,
 *     conversations, custom requests.
 *   §2 PERMITTED     — every operational action a handler is assigned:
 *     workspace orders + one-step lifecycle advance, stock
 *     movements + history, custom-request review/quote/accept,
 *     conversation read/reply, customer operational view,
 *     notifications, analytics. Each must succeed for a handler.
 *   §3 REFUSED       — administrator-only and owner-only surfaces answer 403
 *     for a handler: personnel lifecycle, operators, invitations,
 *     applications + approval, platform settings, owner surfaces —
 *     plus the Phase 23 operation policy (declining a custom
 *     request is a business decision, not handler work).
 *   §4 ISOLATION     — handler A cannot read or mutate workspace B (404 /
 *     empty), and a forged body `workspaceId` is scrubbed: the
 *     write still lands on the caller's own workspace.
 *   §5 SUSPENSION    — a suspended handler is refused at login AND on the
 *     next authenticated request (no token-expiry grace), and the
 *     workspace suspension path is unaffected.
 *   §6 ADMIN/AUDIT   — the policy narrows handlers only: admin A performs the
 *     same refused operations successfully, and the documented
 *     catalogue policy (handlers hold no MORE than adminOrHandler
 *     grants today) is asserted so any change is deliberate.
 *   §7 REGRESSION    — public reads and health unchanged.
 *
 * Isolation: own server (port 4108), own DB, SEED_ON_START=false. Never touches
 * dev or production data.
 *
 * Run: node scripts/staff-action-center-smoke.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import Inventory from '../models/Inventory.js';
import Conversation from '../models/Conversation.js';
import CustomRequest from '../models/CustomRequest.js';
import Settings from '../models/Settings.js';
import Invitation from '../models/Invitation.js';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DB_NAME = 'Flora-Alchemy-Test-ActionCenter';
const PORT = Number(process.env.ACTION_CENTER_PORT || 4108);

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  Workspace.init(),
  User.init(),
  Customer.init(),
  Product.init(),
  Order.init(),
  Inventory.init(),
  Conversation.init(),
  CustomRequest.init(),
  Settings.init(),
  Invitation.init(),
]);

const stamp = Date.now();
const P = (name) => `${name}-Passw0rd-${stamp}!`;

// ══════════ §1 — FIXTURES ══════════
console.log('\n— §1 FIXTURES —');

const wsA = await Workspace.create({ slug: `ac-ws-a-${stamp}`, displayName: 'Action Center Salon A' });
const wsB = await Workspace.create({ slug: `ac-ws-b-${stamp}`, displayName: 'Action Center Salon B' });

async function makeUser({ email, password, role, name, workspaceId, isOwner = false, status = 'ACTIVE' }) {
  return User.create({
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role,
    name,
    isOwner,
    status,
    isFixture: false,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

const ownerEmail = `ac-owner-${stamp}@action.test`;
const adminAEmail = `ac-admin-a-${stamp}@action.test`;
const handlerAEmail = `ac-handler-a-${stamp}@action.test`;
const handlerBEmail = `ac-handler-b-${stamp}@action.test`;
const handlerSEmail = `ac-handler-suspended-${stamp}@action.test`;

const owner = await makeUser({ email: ownerEmail, password: P('Owner'), role: 'admin', name: 'AC Owner', isOwner: true });
const adminA = await makeUser({ email: adminAEmail, password: P('AdminA'), role: 'admin', name: 'AC Admin A', workspaceId: wsA._id });
await makeUser({ email: handlerBEmail, password: P('HandlerB'), role: 'handler', name: 'AC Handler B', workspaceId: wsB._id });
const handlerA = await makeUser({ email: handlerAEmail, password: P('HandlerA'), role: 'handler', name: 'AC Handler A', workspaceId: wsA._id });
const handlerSuspended = await makeUser({
  email: handlerSEmail,
  password: P('HandlerS'),
  role: 'handler',
  name: 'AC Handler Suspended',
  workspaceId: wsA._id,
});

const custA = await Customer.create({ name: 'AC Customer A', email: `ac-cust-a-${stamp}@action.test` });
const custB = await Customer.create({ name: 'AC Customer B', email: `ac-cust-b-${stamp}@action.test` });

const { child: SERVER, base } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'staff-action-center-smoke',
});
const BASE = `${base}/api`;

await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

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

const HANDLER_A = await login(handlerAEmail, P('HandlerA'));
const HANDLER_B = await login(handlerBEmail, P('HandlerB'));
const ADMIN_A = await login(adminAEmail, P('AdminA'));
const OWNER = await login(ownerEmail, P('Owner'));
check('handler A signed in (staff portal)', !!HANDLER_A);
check('admin A signed in', !!ADMIN_A);

// Products + stock + orders (created with the ADMIN token, as the workspace does).
let r = await req('POST', '/products', {
  token: ADMIN_A,
  body: { name: 'Action Center Bloom A', price: 1200, category: 'Posies', initialStock: 40, workspaceId: wsB._id },
});
check('workspace A product created (201)', r.status === 201, `${r.status}`);
const PRODUCT_A = r.json?.product?.slug;

r = await req('POST', '/products', {
  token: ADMIN_A,
  body: { name: 'Action Center Bloom B (other tenant)', price: 900, category: 'Posies', initialStock: 10 },
});
const productB = await Product.create({
  name: 'Action Center Bloom B',
  slug: `ac-bloom-b-${stamp}`,
  price: 900,
  category: 'Posies',
  workspaceId: wsB._id,
});
await Inventory.create({ productSlug: productB.slug, productName: productB.name, currentStock: 3, reorderLevel: 10, workspaceId: wsB._id });

r = await req('POST', '/orders/admin', {
  token: ADMIN_A,
  body: { customerId: String(custA._id), items: [{ productSlug: PRODUCT_A, quantity: 1 }], workspaceId: wsB._id },
});
check('workspace A order created (201)', r.status === 201, `${r.status}`);
const orderA = r.json?.order;

const orderB = await Order.create({
  orderId: `AC-B-${stamp}`,
  customerId: custB._id,
  customerName: custB.name,
  items: [{ name: productB.name, productSlug: productB.slug, price: 900, quantity: 1 }],
  subtotal: 900,
  total: 900,
  orderStatus: 'new',
  workspaceId: wsB._id,
});

const convA = await Conversation.create({ orderId: orderA.orderId, customerId: custA._id, status: 'open', unreadCount: 2, workspaceId: wsA._id });
const convB = await Conversation.create({ orderId: orderB.orderId, customerId: custB._id, status: 'open', unreadCount: 3, workspaceId: wsB._id });

const crA = await CustomRequest.create({ customerId: custA._id, description: 'Action Center request for workspace A (handler work).', status: 'pending', workspaceId: wsA._id });
const crB = await CustomRequest.create({ customerId: custB._id, description: 'Action Center request owned by workspace B (isolation fixture).', status: 'pending', workspaceId: wsB._id });

// ══════════ §2 — WHAT A HANDLER IS ASSIGNED (must succeed) ══════════
console.log('\n— §2 HANDLER PERMITTED OPERATIONS —');

r = await req('GET', '/orders', { token: HANDLER_A });
check('handler reads the workspace order list (200)', r.status === 200, `${r.status}`);
check('handler order list contains the workspace order', (r.json?.orders || []).some((o) => o.orderId === orderA.orderId));

r = await req('GET', `/orders/${orderA.orderId}`, { token: HANDLER_A });
check('handler reads a single workspace order (200)', r.status === 200 && r.json?.order?.orderId === orderA.orderId, `${r.status}`);

r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: HANDLER_A, body: { status: 'confirmed', note: 'Acknowledged on the floor' } });
check('handler advances the order lifecycle (new → confirmed)', r.status === 200 && r.json?.order?.orderStatus === 'confirmed', `${r.status}`);

r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: HANDLER_A, body: { status: 'shipped' } });
check(
  'handler cannot skip a stage — the quality gate holds (403 ACTION_NOT_PERMITTED)',
  r.status === 403 && r.json?.code === 'ACTION_NOT_PERMITTED',
  `${r.status} ${r.json?.code}`
);
check('the skip refusal names the next stage', /one stage at a time/i.test(r.json?.message || ''), r.json?.message);
r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: HANDLER_A, body: { status: 'new' } });
check('handler cannot move an order backwards (422 INVALID_TRANSITION)', r.status === 422 && r.json?.code === 'INVALID_TRANSITION', `${r.status} ${r.json?.code}`);
const orderAAfterRefusals = await Order.findOne({ orderId: orderA.orderId }).lean();
check('refused transitions changed nothing', orderAAfterRefusals.orderStatus === 'confirmed', orderAAfterRefusals.orderStatus);

r = await req('POST', '/orders/admin', {
  token: HANDLER_A,
  body: { customerId: String(custA._id), items: [{ productSlug: PRODUCT_A, quantity: 1 }] },
});
check('handler records a phone/desk order for the workspace (201)', r.status === 201, `${r.status}`);

r = await req('GET', '/inventory', { token: HANDLER_A });
check('handler reads workspace inventory (200)', r.status === 200, `${r.status}`);
const invA = (r.json?.inventory || []).find((i) => i.productSlug === PRODUCT_A);
check('inventory payload carries the stock level and reorder point', !!invA && typeof invA.currentStock === 'number' && typeof invA.reorderLevel === 'number');

const stockBefore = invA?.currentStock ?? 0;
r = await req('POST', `/inventory/${PRODUCT_A}/adjust`, { token: HANDLER_A, body: { type: 'restock', quantity: 5, reason: 'Floor restock' } });
check('handler records a stock movement (200)', r.status === 200, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 140)}`);
check('stock movement applied to the workspace row', (r.json?.inventory?.currentStock ?? -1) === stockBefore + 5, `${r.json?.inventory?.currentStock}`);

r = await req('POST', `/inventory/${PRODUCT_A}/adjust`, { token: HANDLER_A, body: { type: 'not-a-type', quantity: 5 } });
check('handler cannot invent a movement type (422)', r.status === 422, `${r.status}`);

r = await req('GET', '/inventory/history', { token: HANDLER_A });
check('handler reads the movement history (200)', r.status === 200, `${r.status}`);

r = await req('GET', '/custom-requests', { token: HANDLER_A });
check('handler reads the workspace request queue (200)', r.status === 200, `${r.status}`);
check('request queue is scoped to the workspace', (r.json?.requests || []).every((q) => String(q._id) !== String(crB._id)));

r = await req('PATCH', `/custom-requests/${crA._id}/status`, { token: HANDLER_A, body: { status: 'reviewing' } });
check('handler moves a request into review (200)', r.status === 200 && r.json?.request?.status === 'reviewing', `${r.status}`);
r = await req('PATCH', `/custom-requests/${crA._id}/status`, { token: HANDLER_A, body: { status: 'quoted', adminNotes: 'Quote prepared by handler' } });
check('handler records a quote (200)', r.status === 200 && r.json?.request?.status === 'quoted', `${r.status}`);
r = await req('PATCH', `/custom-requests/${crA._id}/status`, { token: HANDLER_A, body: { status: 'accepted' } });
check('handler accepts a request (200)', r.status === 200 && r.json?.request?.status === 'accepted', `${r.status}`);

r = await req('GET', '/conversations?status=open', { token: HANDLER_A });
check('handler lists workspace conversations (200)', r.status === 200, `${r.status}`);
check('conversation list is scoped to the workspace', (r.json?.conversations || []).every((c) => String(c._id) !== String(convB._id)));

r = await req('GET', `/conversations/${convA.id}/messages`, { token: HANDLER_A });
check('handler reads conversation messages (200)', r.status === 200, `${r.status}`);
r = await req('POST', `/conversations/${convA.id}/messages`, { token: HANDLER_A, body: { body: 'Packing today, dispatch tomorrow.' } });
check('handler replies to a customer conversation (201/200)', r.status === 201 || r.status === 200, `${r.status}`);
r = await req('PATCH', `/conversations/${convA.id}/read`, { token: HANDLER_A });
check('handler marks a conversation read (200)', r.status === 200, `${r.status}`);

r = await req('GET', '/customers', { token: HANDLER_A });
check('handler lists the customers their workspace serves (200)', r.status === 200, `${r.status}`);
r = await req('GET', `/customers/${custA._id}`, { token: HANDLER_A });
check('handler opens a customer file for operational work (200)', r.status === 200, `${r.status}`);

r = await req('GET', '/notifications', { token: HANDLER_A });
check('handler reads workspace notifications (200)', r.status === 200, `${r.status}`);

r = await req('GET', '/analytics/overview', { token: HANDLER_A });
check('handler reads workspace analytics (200)', r.status === 200, `${r.status}`);

// ══════════ §3 — WHAT A HANDLER MUST NOT DO ══════════
console.log('\n— §3 HANDLER REFUSED (admin-only / owner-only / policy) —');

r = await req('PATCH', `/custom-requests/${crA._id}/status`, { token: HANDLER_A, body: { status: 'declined' } });
check('declining a custom request is refused for a handler (403 ACTION_NOT_PERMITTED)', r.status === 403 && r.json?.code === 'ACTION_NOT_PERMITTED', `${r.status} ${r.json?.code}`);
check('the refusal explains the rule', /administrator/i.test(r.json?.message || ''), r.json?.message);

r = await req('GET', '/admin/staff', { token: HANDLER_A });
check('staff directory is refused for a handler (403)', r.status === 403, `${r.status}`);
r = await req('GET', '/admin/users', { token: HANDLER_A });
check('operator list is refused for a handler (403)', r.status === 403, `${r.status}`);
r = await req('POST', '/admin/users', { token: HANDLER_A, body: { email: `nope-${stamp}@action.test`, name: 'Nope', password: P('Nope') } });
check('creating an operator is refused for a handler (403)', r.status === 403, `${r.status}`);
r = await req('GET', '/admin/invitations', { token: HANDLER_A });
check('invitation ledger is refused for a handler (403)', r.status === 403, `${r.status}`);
r = await req('GET', '/admin-applications', { token: HANDLER_A });
check('administrator applications are refused for a handler (403)', r.status === 403, `${r.status}`);
r = await req('GET', '/owner/administrators', { token: HANDLER_A });
check('owner governance surfaces are refused for a handler (403)', r.status === 403, `${r.status}`);
r = await req('PATCH', '/settings', { token: HANDLER_A, body: { storeName: 'Hijacked Atelier' } });
check('platform settings are refused for a handler (403)', r.status === 403, `${r.status}`);
r = await req('POST', '/auth/register', { body: { name: 'Smuggle', email: `smuggle-${stamp}@action.test`, password: P('Smuggle'), role: 'handler' } });
check('public registration cannot mint a handler (422)', r.status === 422, `${r.status}`);

// ══════════ §4 — CROSS-WORKSPACE ISOLATION ══════════
console.log('\n— §4 ISOLATION (handler A vs workspace B) —');

r = await req('GET', '/orders', { token: HANDLER_A });
check('workspace B order absent from handler A list', !(r.json?.orders || []).some((o) => o.orderId === orderB.orderId));
r = await req('PATCH', `/orders/${orderB.orderId}/status`, { token: HANDLER_A, body: { status: 'confirmed' } });
check('mutating another workspace order is refused (404)', r.status === 404, `${r.status}`);
const orderBAfter = await Order.findOne({ orderId: orderB.orderId }).lean();
check('other workspace order untouched after the refused write', orderBAfter?.orderStatus === 'new', orderBAfter?.orderStatus);

r = await req('GET', `/inventory/${productB.slug}`, { token: HANDLER_A });
check('reading another workspace stock row is refused (404)', r.status === 404, `${r.status}`);
r = await req('POST', `/inventory/${productB.slug}/adjust`, { token: HANDLER_A, body: { type: 'restock', quantity: 25 } });
check('adjusting another workspace stock is refused (404)', r.status === 404, `${r.status}`);
const invBAfter = await Inventory.findOne({ productSlug: productB.slug }).lean();
check('other workspace stock untouched after the refused adjustment', invBAfter.currentStock === 3, `${invBAfter.currentStock}`);

r = await req('PATCH', `/custom-requests/${crB._id}/status`, { token: HANDLER_A, body: { status: 'reviewing' } });
check('updating another workspace request is refused (404)', r.status === 404, `${r.status}`);
r = await req('GET', `/conversations/${convB.id}/messages`, { token: HANDLER_A });
check('reading another workspace conversation is refused (404/403)', r.status === 404 || r.status === 403, `${r.status}`);

// Forged tenant identifiers never influence attribution.
r = await req('POST', `/inventory/${PRODUCT_A}/adjust`, {
  token: HANDLER_A,
  body: { type: 'restock', quantity: 2, workspaceId: String(wsB._id), reason: 'Forged tenant' },
});
check('forged workspaceId on a stock write is ignored (write still succeeds on own row)', r.status === 200, `${r.status}`);
const invAAfter = await Inventory.findOne({ productSlug: PRODUCT_A }).lean();
check('stock write landed on the caller workspace (not the forged one)', String(invAAfter.workspaceId) === String(wsA._id), `${invAAfter.workspaceId}`);

r = await req('POST', '/orders/admin', {
  token: HANDLER_A,
  body: { customerId: String(custA._id), items: [{ productSlug: PRODUCT_A, quantity: 1 }], workspaceId: String(wsB._id) },
});
check('forged workspaceId on an order create is ignored', r.status === 201 && String(r.json?.order?.workspaceId) === String(wsA._id), `${r.status} ${r.json?.order?.workspaceId}`);

// ── Custom request: product context derives the workspace (Phase 2) ──────
// A customer starting a bespoke request from a catalogue product must land in
// THAT product's workspace, and can never select a tenant themselves.
const CR_CUSTOMER = await req('POST', '/auth/register', {
  body: { name: 'Request Customer', email: `cr-customer-${stamp}@action.test`, password: P('CrCust') },
});
check('request customer registered', CR_CUSTOMER.status === 201, `${CR_CUSTOMER.status}`);
const CR_TOKEN = CR_CUSTOMER.json?.token;

// PRODUCT_A belongs to workspace A; productB belongs to workspace B.
const wsOfProductA = await Product.findOne({ slug: PRODUCT_A }).select('workspaceId').lean();
check('workspace A product is workspace-scoped', String(wsOfProductA?.workspaceId) === String(wsA._id), `${wsOfProductA?.workspaceId}`);

r = await req('POST', '/custom-requests', {
  token: CR_TOKEN,
  body: { description: 'Please craft this posy in sage and cream', productId: PRODUCT_A },
});
check('product-context request accepted (201)', r.status === 201, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 120)}`);
check(
  'request workspace derived from the product',
  String((await CustomRequest.findById(r.json?.request?._id).lean()).workspaceId) === String(wsA._id),
  `${r.json?.request?.shop?.slug}`
);
check('request records its product context', !!r.json?.request?.productId && !!r.json?.request?.productName, `${r.json?.request?.productName}`);
check('customer payload carries the shop, not the workspaceId', r.json?.request?.shop?.slug === wsA.slug && r.json?.request?.workspaceId === undefined);

// A forged workspaceId in the body must not move the request to workspace B.
r = await req('POST', '/custom-requests', {
  token: CR_TOKEN,
  body: { description: 'Trying to pick my own tenant for this request', productId: PRODUCT_A, workspaceId: String(wsB._id) },
});
check(
  'forged workspaceId on a request is ignored',
  r.status === 201 && String((await CustomRequest.findById(r.json?.request?._id).lean()).workspaceId) === String(wsA._id),
  `${r.json?.request?.shop?.slug}`
);

// The same product resolution must follow the product, not the caller: a
// request started from workspace B's product lands in workspace B.
r = await req('POST', '/custom-requests', {
  token: CR_TOKEN,
  body: { description: 'A request started from the other workspace product', productId: productB.slug },
});
check(
  'workspace B product resolves to workspace B',
  r.status === 201 && String((await CustomRequest.findById(r.json?.request?._id).lean()).workspaceId) === String(wsB._id),
  `${r.json?.request?.shop?.slug}`
);

// PHASE 2 — a standalone request MUST name an ACTIVE shop: there is no
// unassigned request floating between shops any more.
r = await req('POST', '/custom-requests', {
  token: CR_TOKEN,
  body: { description: 'An open bespoke brief with no shop named at all' },
});
check('standalone request without a shop → 422 SHOP_REQUIRED', r.status === 422 && r.json?.code === 'SHOP_REQUIRED', `${r.status} ${r.json?.code}`);

// …and with a shop, the request lands in exactly that workspace.
r = await req('POST', '/custom-requests', {
  token: CR_TOKEN,
  body: { description: 'An open bespoke brief for the second studio', shopSlug: wsB.slug },
});
check(
  'standalone request names its shop and lands there',
  r.status === 201 &&
    r.json?.request?.shop?.slug === wsB.slug &&
    String((await CustomRequest.findById(r.json?.request?._id).lean()).workspaceId) === String(wsB._id),
  `${r.status} ${r.json?.request?.shop?.slug}`
);

// A request in workspace A is visible to workspace A staff and invisible to B.
r = await req('GET', '/custom-requests', { token: ADMIN_A });
check(
  'workspace A staff see the product-context request',
  r.status === 200 && (r.json?.requests || []).some((q) => String(q.productName || '').includes('Action Center Bloom A')),
  `${r.status}`
);
check(
  'workspace A staff do not see workspace B requests',
  (r.json?.requests || []).every((q) => String(q._id) !== String(crB._id))
);

// ══════════ §5 — SUSPENSION ══════════
console.log('\n— §5 SUSPENSION —');

// A token issued BEFORE suspension must stop working on the very next call
// (protect re-reads the user per request), and no mutation may land.
const liveToken = await login(handlerSuspended.email, P('HandlerS'));
check('handler can sign in while ACTIVE', !!liveToken);
await User.updateOne({ _id: handlerSuspended._id }, { $set: { status: 'SUSPENDED' } });

const suspendedLogin = await req('POST', '/auth/login', { body: { email: handlerSuspended.email, password: P('HandlerS') } });
check(
  'suspended handler cannot sign in (403 ACCOUNT_SUSPENDED)',
  suspendedLogin.status === 403 && suspendedLogin.json?.code === 'ACCOUNT_SUSPENDED',
  `${suspendedLogin.status} ${suspendedLogin.json?.code}`
);

r = await req('GET', '/orders', { token: liveToken });
check('suspended handler loses reads immediately (403 ACCOUNT_SUSPENDED)', r.status === 403 && r.json?.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json?.code}`);
const stockBeforeSuspend = (await Inventory.findOne({ productSlug: PRODUCT_A }).lean()).currentStock;
r = await req('POST', `/inventory/${PRODUCT_A}/adjust`, { token: liveToken, body: { type: 'restock', quantity: 1 } });
check('suspended handler cannot mutate stock (403)', r.status === 403, `${r.status}`);
const stockAfterSuspend = (await Inventory.findOne({ productSlug: PRODUCT_A }).lean()).currentStock;
check('suspended mutation changed nothing', stockAfterSuspend === stockBeforeSuspend, `${stockBeforeSuspend} → ${stockAfterSuspend}`);

await Workspace.updateOne({ _id: wsA._id }, { $set: { status: 'SUSPENDED' } });
r = await req('GET', '/orders', { token: HANDLER_A });
check('workspace suspension stops handler work (403 WORKSPACE_SUSPENDED)', r.status === 403 && r.json?.code === 'WORKSPACE_SUSPENDED', `${r.status} ${r.json?.code}`);
await Workspace.updateOne({ _id: wsA._id }, { $set: { status: 'ACTIVE' } });
r = await req('GET', '/orders', { token: HANDLER_A });
check('reactivating the workspace restores handler work (200)', r.status === 200, `${r.status}`);

// ══════════ §6 — THE POLICY NARROWS HANDLERS ONLY ══════════
console.log('\n— §6 ADMIN / OWNER + DOCUMENTED CATALOGUE POLICY —');

await CustomRequest.updateOne({ _id: crA._id }, { $set: { status: 'quoted' } });
// Custom-request workflow: rejecting now REQUIRES a persisted, customer-safe
// reason (the customer sees it), so the no-reason attempt is refused first and
// the admin's real decision carries one.
r = await req('PATCH', `/custom-requests/${crA._id}/status`, { token: ADMIN_A, body: { status: 'declined', adminNotes: 'Out of scope for the studio' } });
check('declining without a reason is refused (422)', r.status === 422, `${r.status}`);
r = await req('PATCH', `/custom-requests/${crA._id}/status`, { token: ADMIN_A, body: { status: 'declined', adminNotes: 'Out of scope for the studio', rejectionReason: 'Outside our current studio scope.' } });
check('admin A may still decline a request (200)', r.status === 200 && r.json?.request?.status === 'declined', `${r.status}`);
check('the rejection reason is persisted for the customer', r.json?.request?.rejectionReason === 'Outside our current studio scope.');

r = await req('GET', '/orders', { token: OWNER });
check('owner is refused workspace operations (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);

// The administrator keeps the platform's documented fast-forward (api-smoke
// asserts a multi-stage jump for an admin): the Phase 23 policy narrows
// HANDLERS only, never the workspace owner's control of their own orders.
const jumpOrder = await Order.create({
  orderId: `AC-JUMP-${stamp}`,
  customerId: custA._id,
  customerName: custA.name,
  items: [{ name: productB.name, productSlug: productB.slug, price: 900, quantity: 1 }],
  subtotal: 900,
  total: 900,
  orderStatus: 'confirmed',
  workspaceId: wsA._id,
});
r = await req('PATCH', `/orders/${jumpOrder.orderId}/status`, { token: HANDLER_A, body: { status: 'ready_to_dispatch' } });
check('handler is refused the multi-stage jump on the same order (403)', r.status === 403 && r.json?.code === 'ACTION_NOT_PERMITTED', `${r.status} ${r.json?.code}`);
r = await req('PATCH', `/orders/${jumpOrder.orderId}/status`, { token: ADMIN_A, body: { status: 'ready_to_dispatch' } });
check('admin A still holds the documented fast-forward (200)', r.status === 200 && r.json?.order?.orderStatus === 'ready_to_dispatch', `${r.status}`);

// Documented audit finding (NOT a new grant): handlers hold the shop-level
// catalogue capability the platform already granted them via adminOrHandler +
// requireWorkspace, and nothing wider. Asserted so narrowing it later is a
// deliberate, visible change rather than a silent drift.
r = await req('PATCH', `/products/${PRODUCT_A}`, { token: HANDLER_A, body: { name: 'Action Center Bloom A (floor edited)' } });
check('documented: handler may edit workspace catalogue (200)', r.status === 200, `${r.status}`);
const adminStaff = await req('GET', '/admin/staff', { token: ADMIN_A });
const handlerStaff = await req('GET', '/admin/staff', { token: HANDLER_A });
check(
  'documented: the same surface is admin-only (admin 200, handler 403)',
  adminStaff.status === 200 && handlerStaff.status === 403,
  `${adminStaff.status}/${handlerStaff.status}`
);

// ══════════ §7 — PUBLIC REGRESSION ══════════
console.log('\n— §7 PUBLIC REGRESSION —');
r = await req('GET', '/products');
check('public catalogue read unchanged', r.status === 200, `${r.status}`);
r = await req('GET', '/settings');
check('public settings read unchanged', r.status === 200, `${r.status}`);
r = await req('GET', '/health');
check('health probe unchanged', r.status === 200 && r.json?.status === 'ok', `${r.status}`);

console.log(`\nSTAFF ACTION CENTER RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}

try {
  await mongoose.disconnect().catch(() => {});
} finally {
  await stopTestServer(SERVER, base);
}
