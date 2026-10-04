/**
 * CUSTOM REQUEST FULFILLMENT WORKFLOW — targeted smoke suite.
 *
 * Proves the request→payment journey end to end against a disposable DB:
 *
 *   §1 IMAGE + CREATION   — optional reference image (none · valid URL · local
 *     reference · invalid scheme → 422), product-derived workspace, forged
 *     workspaceId ignored, customer isolation.
 *   §2 ADMIN DECISION     — accept · reject (reason REQUIRED + persisted) ·
 *     invalid repeats blocked · cross-workspace 404 · handler decline refused.
 *   §3 PROPOSAL           — dynamic items · server-calculated lineTotal /
 *     subtotal / total (client totals ignored) · send · no silent post-send
 *     edits · withdraw + rebuild.
 *   §4 CUSTOMER + PAYMENT — customer accept creates the REAL order from the
 *     stored proposal · decline branch · the booking is authoritative (client
 *     body cannot change a rupee) · payment verified server-side moves the
 *     request to paid.
 *   §5 FULFILLMENT        — paid → in_progress → completed · terminal states
 *     refuse further transitions.
 *   §6 LEGACY REGRESSION  — the pre-workflow statuses keep working for staff.
 *
 * Isolation: own server and own database. Never touches dev or production data.
 *
 * Run: npm run test:custom-request
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import CustomRequest from '../models/CustomRequest.js';
import Proposal from '../models/Proposal.js';
import Order from '../models/Order.js';
import Settings from '../models/Settings.js';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DB_NAME = 'Flora-Alchemy-Test-CustomRequest';
const PORT = Number(process.env.CUSTOM_REQUEST_PORT || 4112);

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  Workspace.init(), User.init(), Customer.init(), Product.init(),
  CustomRequest.init(), Proposal.init(), Order.init(), Settings.init(),
]);

const stamp = Date.now();
const P = (name) => `${name}-Passw0rd-${stamp}!`;

// ══════════ FIXTURES ══════════
const wsA = await Workspace.create({ slug: `cr-ws-a-${stamp}`, displayName: 'Custom Request Salon A' });
const wsB = await Workspace.create({ slug: `cr-ws-b-${stamp}`, displayName: 'Custom Request Salon B' });

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
const adminAEmail = `cr-admin-a-${stamp}@workflow.test`;
const adminBEmail = `cr-admin-b-${stamp}@workflow.test`;
const handlerAEmail = `cr-handler-a-${stamp}@workflow.test`;
await makeUser({ email: adminAEmail, password: P('AdminA'), role: 'admin', name: 'CR Admin A', workspaceId: wsA._id });
await makeUser({ email: adminBEmail, password: P('AdminB'), role: 'admin', name: 'CR Admin B', workspaceId: wsB._id });
await makeUser({ email: handlerAEmail, password: P('HandlerA'), role: 'handler', name: 'CR Handler A', workspaceId: wsA._id });

const { child: SERVER, base } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'custom-request-workflow',
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

// Product owned by workspace A (created through the real staff endpoint using
// admin A's own membership — the api attaches it to wsA server-side).
let r = await req('POST', '/products', {
  token: await login(adminAEmail, P('AdminA')),
  body: { name: 'Workflow Bloom A', price: 1200, category: 'Posies', initialStock: 20 },
});
check('workspace A product created', r.status === 201 && !!r.json?.product?.slug, `${r.status}`);
const PRODUCT_A = r.json?.product?.slug;

const custAEmail = `cr-cust-a-${stamp}@workflow.test`;
const custBEmail = `cr-cust-b-${stamp}@workflow.test`;
await req('POST', '/auth/register', { body: { name: 'CR Customer A', email: custAEmail, password: P('CustA') } });
await req('POST', '/auth/register', { body: { name: 'CR Customer B', email: custBEmail, password: P('CustB') } });
const CUST_A = await login(custAEmail, P('CustA'));
const CUST_B = await login(custBEmail, P('CustB'));
const ADMIN_A = await login(adminAEmail, P('AdminA'));
const ADMIN_B = await login(adminBEmail, P('AdminB'));
const HANDLER_A = await login(handlerAEmail, P('HandlerA'));
check('fixture identities signed in', !!CUST_A && !!CUST_B && !!ADMIN_A && !!ADMIN_B && !!HANDLER_A);

// ══════════ §1 — REFERENCE IMAGE + REQUEST CREATION ══════════
console.log('\n— §1 IMAGE + CREATION —');

r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'A general bespoke bouquet with no reference image at all' },
});
const R_GENERAL = r.json?.request?._id;
check('optional image absent → request submits (201)', r.status === 201 && r.json?.request?.imageUrl === '', `${r.status}`);
check('general request stays unassigned', !r.json?.request?.workspaceId && !r.json?.request?.productId);

r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Please match this inspiration exactly, sage and cream', imageUrl: 'https://example.com/inspiration.png' },
});
check('valid image URL persists (201)', r.status === 201 && r.json?.request?.imageUrl === 'https://example.com/inspiration.png', `${r.status}`);

r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Local upload fallback reference should be accepted too', imageUrl: '/uploads/request-123-abc.webp' },
});
check('local /uploads reference persists (local-storage fallback)', r.status === 201 && r.json?.request?.imageUrl === '/uploads/request-123-abc.webp', `${r.status}`);

r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Trying a hostile image reference scheme', imageUrl: 'javascript:alert(1)' },
});
check('invalid image scheme → 422 (no broken admin render)', r.status === 422, `${r.status}`);

r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Plain text in the image field is not a reference', imageUrl: 'not-a-url' },
});
check('malformed image reference → 422', r.status === 422, `${r.status}`);

r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Commission a custom version of this arrangement', productId: PRODUCT_A, workspaceId: String(wsB._id) },
});
const R_WSA = r.json?.request?._id;
check('product-context request accepted (201)', r.status === 201 && !!R_WSA, `${r.status}`);
check('workspace derived from the product (forged ws ignored)', String(r.json?.request?.workspaceId) === String(wsA._id), `${r.json?.request?.workspaceId}`);
check('product identity frozen on the request', !!r.json?.request?.productId && !!r.json?.request?.productName);

r = await req('GET', `/custom-requests/${R_WSA}`, { token: CUST_B });
check('customer B cannot read customer A\'s request (404)', r.status === 404, `${r.status}`);

r = await req('GET', `/custom-requests/${R_WSA}`, { token: ADMIN_B });
check('admin B cannot read workspace A\'s request (404)', r.status === 404, `${r.status}`);

r = await req('GET', `/custom-requests/${R_WSA}`, { token: ADMIN_A });
check('admin A reads the request (200)', r.status === 200 && !!r.json?.request, `${r.status}`);

r = await req('GET', `/custom-requests/${R_WSA}`, { token: CUST_A });
check('customer sees their OWN request without internal notes', r.status === 200 && r.json?.request?.adminNotes === undefined, `${r.status}`);

// ══════════ §2 — ADMIN DECISION ══════════
console.log('\n— §2 ADMIN DECISION —');

r = await req('PATCH', `/custom-requests/${R_WSA}/status`, { token: ADMIN_B, body: { status: 'accepted' } });
check('cross-workspace decision → 404', r.status === 404, `${r.status}`);

r = await req('PATCH', `/custom-requests/${R_WSA}/status`, { token: ADMIN_A, body: { status: 'accepted' } });
check('admin accepts the request (200 → accepted)', r.status === 200 && r.json?.request?.status === 'accepted', `${r.status}`);
check('accept persists a workspace-side response', String(r.json?.request?.workspaceId) === String(wsA._id));

r = await req('PATCH', `/custom-requests/${R_WSA}/status`, { token: ADMIN_A, body: { status: 'accepted' } });
check('repeat accept is refused (422 already)', r.status === 422, `${r.status}`);

r = await req('PATCH', `/custom-requests/${R_WSA}/status`, { token: ADMIN_A, body: { status: 'declined' } });
check('reject without a reason → 422 (reason required)', r.status === 422, `${r.status}`);

// A second request for the rejection branch.
r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'A request that the studio will not be able to take forward', productId: PRODUCT_A },
});
const R_REJECT = r.json?.request?._id;

r = await req('PATCH', `/custom-requests/${R_REJECT}/status`, { token: ADMIN_A, body: { status: 'declined', rejectionReason: 'We cannot source these blooms before your date.' } });
check('reject with reason → declined (200)', r.status === 200 && r.json?.request?.status === 'declined', `${r.status}`);
check('rejection reason persisted', r.json?.request?.rejectionReason === 'We cannot source these blooms before your date.');

r = await req('PATCH', `/custom-requests/${R_REJECT}/status`, { token: ADMIN_A, body: { status: 'accepted' } });
check('declined → accepted is blocked (INVALID_TRANSITION)', r.status === 422 && r.json?.code === 'INVALID_TRANSITION', `${r.status} ${r.json?.code}`);

r = await req('PATCH', `/custom-requests/${R_WSA}/status`, { token: HANDLER_A, body: { status: 'declined', rejectionReason: 'Handler should not decide this' } });
check('handler decline refused (403 ACTION_NOT_PERMITTED)', r.status === 403 && r.json?.code === 'ACTION_NOT_PERMITTED', `${r.status} ${r.json?.code}`);

r = await req('GET', `/custom-requests/${R_REJECT}`, { token: CUST_A });
check('customer reads the persisted rejection reason', r.json?.request?.rejectionReason === 'We cannot source these blooms before your date.');

// ══════════ §3 — PROPOSAL ══════════
console.log('\n— §3 PROPOSAL —');

// Helper: create → accept → (optionally) send, returning ids.
async function toAccepted(adminToken = ADMIN_A) {
  const created = await req('POST', '/custom-requests', {
    token: CUST_A,
    body: { description: 'A commission to be quoted with dynamic line items', productId: PRODUCT_A },
  });
  const id = created.json?.request?._id;
  await req('PATCH', `/custom-requests/${id}/status`, { token: adminToken, body: { status: 'accepted' } });
  return id;
}

const R2 = await toAccepted();

r = await req('POST', '/custom-requests/000000000000000000000000/proposal', { token: ADMIN_A, body: { items: [{ itemName: 'x', quantity: 1, unitPrice: 1 }] } });
check('proposal for an unknown request → 404', r.status === 404, `${r.status}`);

r = await req('POST', `/custom-requests/${R2}/proposal`, { token: ADMIN_B, body: { items: [{ itemName: 'x', quantity: 1, unitPrice: 1 }] } });
check('proposal for another workspace → 404', r.status === 404, `${r.status}`);

r = await req('POST', `/custom-requests/${R2}/proposal`, {
  token: ADMIN_A,
  body: { items: [{ itemName: 'No price', quantity: 0, unitPrice: 1 }] },
});
check('invalid quantity → 422', r.status === 422, `${r.status}`);

// Client-submitted totals/lineTotals are deliberately wrong — the server must
// recalculate every value from itemName/quantity/unitPrice.
r = await req('POST', `/custom-requests/${R2}/proposal`, {
  token: ADMIN_A,
  body: {
    items: [
      { itemName: 'Preserved rose arrangement', description: 'Sage and cream palette', quantity: 1, unitPrice: 650, lineTotal: 1 },
      { itemName: 'Belgian chocolate box', quantity: 1, unitPrice: 450, lineTotal: 1 },
      { itemName: 'Handwritten note', quantity: 1, unitPrice: 50, lineTotal: 1 },
      { itemName: 'Personalized name card', quantity: 2, unitPrice: 40, lineTotal: 1 },
    ],
    subtotal: 1,
    total: 1,
  },
});
const P2 = r.json?.proposal;
check('dynamic proposal draft saved (201)', r.status === 201 && !!P2, `${r.status}`);
check('server recalculated each lineTotal', P2?.items?.every((i) => i.lineTotal === i.quantity * i.unitPrice), JSON.stringify(P2?.items?.map((i) => i.lineTotal)));
check('server recalculated the subtotal (650+450+50+80)', P2?.subtotal === 1230, String(P2?.subtotal));
check('server ignored the client subtotal/total', P2?.total !== 1 && P2?.subtotal !== 1);
check('items are NOT catalogue products', P2?.items?.every((i) => !i.productSlug));

r = await req('GET', `/custom-requests/${R2}`, { token: CUST_A });
check('customer sees the draft proposal with items', r.status === 200 && r.json?.proposal?.items?.length === 4, `${r.status}`);

r = await req('POST', `/custom-requests/${R2}/proposal/send`, { token: ADMIN_A });
const sent2 = r.json?.proposal;
check('proposal sent → request quoted', r.status === 200 && r.json?.request?.status === 'quoted', `${r.status}`);
check('sent proposal locked its totals', sent2?.status === 'sent' && sent2?.total === sent2?.subtotal + sent2?.shipping, JSON.stringify({ s: sent2?.status, t: sent2?.total }));

r = await req('POST', `/custom-requests/${R2}/proposal/send`, { token: ADMIN_A });
check('sending twice is refused (409)', r.status === 409, `${r.status}`);

r = await req('POST', `/custom-requests/${R2}/proposal`, { token: ADMIN_A, body: { items: [{ itemName: 'Sneaky edit', quantity: 1, unitPrice: 9999 }] } });
check('silent edit after send is refused (409)', r.status === 409, `${r.status}`);

// Withdraw + rebuild — the honest revision path.
r = await req('POST', `/custom-requests/${R2}/proposal/withdraw`, { token: ADMIN_A });
check('sent proposal withdrawn → request back to accepted', r.status === 200 && r.json?.request?.status === 'accepted' && r.json?.proposal?.status === 'withdrawn', `${r.status}`);

r = await req('POST', `/custom-requests/${R2}/proposal`, {
  token: ADMIN_A,
  body: { items: [{ itemName: 'Revised arrangement', quantity: 1, unitPrice: 1400 }] },
});
check('withdrawn proposal can be rebuilt', (r.status === 201 || r.status === 200) && r.json?.proposal?.subtotal === 1400, `${r.status}`);

r = await req('POST', `/custom-requests/${R2}/proposal/send`, { token: ADMIN_A });
check('rebuilt proposal re-sent → quoted', r.status === 200 && r.json?.request?.status === 'quoted', `${r.status}`);
const FINAL2 = r.json?.proposal;

// Proposal edits after a customer decision are impossible (customer decides now).
r = await req('POST', `/custom-requests/${R2}/proposal/decline`, { token: CUST_B, body: { reason: 'Not mine' } });
check('customer B cannot decline customer A\'s proposal (404)', r.status === 404, `${r.status}`);

// ── Decline branch (R3) ──────────────────────────────────────────────
const R3 = await toAccepted();
await req('POST', `/custom-requests/${R3}/proposal`, { token: ADMIN_A, body: { items: [{ itemName: 'Box', quantity: 1, unitPrice: 500 }] } });
await req('POST', `/custom-requests/${R3}/proposal/send`, { token: ADMIN_A });

r = await req('POST', `/custom-requests/${R3}/proposal/decline`, { token: CUST_A, body: { reason: 'Over my budget right now.' } });
check('customer declines → request customer_declined', r.status === 200 && r.json?.request?.status === 'customer_declined', `${r.status}`);
check('decline reason persisted on the proposal', r.json?.proposal?.declineReason === 'Over my budget right now.');

r = await req('POST', `/custom-requests/${R3}/proposal/decline`, { token: CUST_A, body: {} });
check('declining twice is an idempotent no-op', r.status === 200 && r.json?.request?.status === 'customer_declined', `${r.status}`);

r = await req('PATCH', `/custom-requests/${R3}/status`, { token: ADMIN_A, body: { status: 'paid' } });
check('manual payment state refused (422 workflow-only)', r.status === 422, `${r.status}`);

r = await req('POST', `/custom-requests/${R3}/proposal/accept`, { token: CUST_A });
check('accepting a declined proposal refuses (422/409)', r.status === 422 || r.status === 409, `${r.status}`);

// ══════════ §4 — CUSTOMER ACCEPT + PAYMENT ══════════
console.log('\n— §4 CUSTOMER ACCEPT + PAYMENT —');

r = await req('POST', `/custom-requests/${R2}/proposal/accept`, {
  token: CUST_A,
  // A client trying to dictate pricing: the endpoint reads NOTHING from the body.
  body: { total: 1, items: [{ itemName: 'Cheap swap', quantity: 1, unitPrice: 1 }], workspaceId: String(wsB._id) },
});
const accepted2 = r.json;
check('customer accepts → request payment_pending', r.status === 200 && accepted2?.request?.status === 'payment_pending', `${r.status} ${accepted2?.request?.status}`);
check('real order created from the stored proposal', !!accepted2?.order?.orderId, JSON.stringify(accepted2?.order || {}));
check('order total equals the authoritative proposal total', accepted2?.order?.total === FINAL2?.total, `${accepted2?.order?.total} vs ${FINAL2?.total}`);
check('client-sent totals were ignored', accepted2?.order?.total !== 1);

const ORDER2 = await Order.findOne({ orderId: accepted2?.order?.orderId }).lean();
check('order references the request + proposal (DB)', String(ORDER2?.customRequestId) === String(R2) && !!ORDER2?.proposalId);
check('order items mirror the proposal (qty · price)', ORDER2?.items?.length === FINAL2?.items?.length && ORDER2?.items?.[0]?.price === FINAL2?.items?.[0]?.unitPrice, JSON.stringify(ORDER2?.items?.map((i) => ({ p: i.price, q: i.quantity }))));

r = await req('POST', `/custom-requests/${R2}/proposal/accept`, { token: CUST_A });
check('accepting twice is idempotent (same order, no duplicate)', r.status === 200 && r.json?.order?.orderId === accepted2?.order?.orderId, `${r.status}`);
const orderCount = await Order.countDocuments({ customRequestId: R2 });
check('exactly ONE order exists for the request', orderCount === 1, String(orderCount));

// ── Payment verification (Razorpay TEST mode when configured) ─────────
const providerConfigured = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
if (providerConfigured) {
  r = await req('POST', '/payments/create-order', { token: CUST_A, body: { orderId: accepted2.order.orderId, amount: 1 } });
  const rzpOrderId = r.json?.payment?.razorpayOrderId;
  check('razorpay order created for the proposal order', r.status === 200 && String(rzpOrderId).startsWith('order_'), `${r.status}`);
  check('amount is the SERVER total in paise (client amount ignored)', r.json?.payment?.amount === Math.round(FINAL2.total * 100), `${r.json?.payment?.amount} vs ${Math.round(FINAL2.total * 100)}`);

  r = await req('POST', '/payments/verify', {
    token: CUST_A,
    body: { orderId: accepted2.order.orderId, razorpay_payment_id: 'pay_bad_1', razorpay_order_id: rzpOrderId, razorpay_signature: '0'.repeat(64) },
  });
  check('invalid signature refused (400)', r.status === 400 && r.json?.code === 'INVALID_SIGNATURE', `${r.status}`);

  r = await req('GET', `/custom-requests/${R2}`, { token: CUST_A });
  check('request still payment_pending after a failed verification', r.json?.request?.status === 'payment_pending', `${r.json?.request?.status}`);

  const payId = `pay_${crypto.randomBytes(8).toString('hex')}`;
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${rzpOrderId}|${payId}`).digest('hex');
  r = await req('POST', '/payments/verify', {
    token: CUST_A,
    body: { orderId: accepted2.order.orderId, razorpay_payment_id: payId, razorpay_order_id: rzpOrderId, razorpay_signature: signature },
  });
  check('verified payment → order Paid', r.status === 200 && r.json?.order?.paymentStatus === 'Paid', `${r.status} ${r.json?.order?.paymentStatus}`);

  r = await req('GET', `/custom-requests/${R2}`, { token: CUST_A });
  check('request transitions to paid after verified payment', r.json?.request?.status === 'paid', `${r.json?.request?.status}`);

  r = await req('POST', '/payments/verify', {
    token: CUST_A,
    body: { orderId: accepted2.order.orderId, razorpay_payment_id: payId, razorpay_order_id: rzpOrderId, razorpay_signature: signature },
  });
  check('duplicate verification stays paid (idempotent)', r.status === 200 && r.json?.order?.paymentStatus === 'Paid', `${r.status}`);
} else {
  console.log('  (Razorpay test keys not supplied — the prototype Sample settlement path is asserted instead)');
  r = await req('GET', `/custom-requests/${R2}`, { token: CUST_A });
  check('prototype environment settles the request honestly (Sample → paid)', r.json?.request?.status === 'paid', `${r.json?.request?.status}`);
}

// ══════════ §5 — FULFILLMENT ══════════
console.log('\n— §5 FULFILLMENT —');

r = await req('PATCH', `/custom-requests/${R2}/status`, { token: HANDLER_A, body: { status: 'in_progress' } });
check('handler starts fulfillment (paid → in_progress)', r.status === 200 && r.json?.request?.status === 'in_progress', `${r.status}`);

r = await req('PATCH', `/custom-requests/${R2}/status`, { token: HANDLER_A, body: { status: 'completed' } });
check('handler completes the request (in_progress → completed)', r.status === 200 && r.json?.request?.status === 'completed', `${r.status}`);

r = await req('PATCH', `/custom-requests/${R2}/status`, { token: ADMIN_A, body: { status: 'in_progress' } });
check('completed is terminal (no regression)', r.status === 422 && r.json?.code === 'INVALID_TRANSITION', `${r.status} ${r.json?.code}`);

r = await req('GET', `/custom-requests/${R2}`, { token: CUST_A });
check('customer sees the completed request (customer-safe fields only)', r.json?.request?.status === 'completed' && r.json?.request?.adminNotes === undefined);

r = await req('PATCH', `/custom-requests/${R2}/status`, { token: ADMIN_A, body: { status: 'completed', adminNotes: 'Wrapped with the sage ribbon.' } });
check('notes save on an unchanged status is allowed', r.status === 200 && r.json?.request?.adminNotes === 'Wrapped with the sage ribbon.', `${r.status}`);

// ══════════ §6 — LEGACY STATUS REGRESSION ══════════
console.log('\n— §6 LEGACY REGRESSION —');

r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Legacy quote path — staff quotes outside the builder', productId: PRODUCT_A },
});
const R_LEGACY = r.json?.request?._id;

r = await req('PATCH', `/custom-requests/${R_LEGACY}/status`, { token: HANDLER_A, body: { status: 'reviewing' } });
check('handler can still claim a request (reviewing)', r.status === 200 && r.json?.request?.status === 'reviewing', `${r.status}`);

r = await req('PATCH', `/custom-requests/${R_LEGACY}/status`, { token: HANDLER_A, body: { status: 'quoted', adminNotes: 'Quote sent by phone' } });
check('handler can still record a legacy quote (quoted)', r.status === 200 && r.json?.request?.status === 'quoted', `${r.status}`);

r = await req('PATCH', `/custom-requests/${R_LEGACY}/status`, { token: HANDLER_A, body: { status: 'accepted' } });
check('handler can still accept a legacy request', r.status === 200 && r.json?.request?.status === 'accepted', `${r.status}`);

r = await req('GET', '/custom-requests', { token: ADMIN_B });
check('workspace B queue never shows workspace A requests', (r.json?.requests || []).every((q) => String(q.workspaceId) !== String(wsA._id)));

r = await req('GET', '/health');
check('health endpoint unchanged', r.status === 200);

console.log(`\nCUSTOM REQUEST WORKFLOW RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exitCode = 1;
}

stopTestServer(SERVER);
await mongoose.disconnect();
