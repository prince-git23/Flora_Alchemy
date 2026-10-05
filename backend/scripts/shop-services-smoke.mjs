/**
 * PHASE 2 — SHOP-OWNED SERVICES & CUSTOMER RELATIONSHIPS (focused suite).
 *
 * Self-contained: own server (port 4113), own database
 * (Flora-Alchemy-Test-ShopServices), SEED_ON_START=false. Nothing here touches
 * dev or production data.
 *
 * What it proves, by section:
 *
 *   §A GLOBAL CUSTOMER IDENTITY — a customer owns their own profile; staff
 *      operational endpoints cannot rewrite the global name/contact/addresses/
 *      preferences/account status, while relationship-linked reads keep working
 *      and unrelated reads stay 404.
 *   §B GLOBAL WISHLIST — one document per customer, products from several shops
 *      in the SAME wishlist, shop navigation (`?shop=`) has no authority, and
 *      the payload carries Shop identity without any workspaceId.
 *   §C WISHLIST MIGRATION — the guarded DRY-RUN → APPLY merge consolidates
 *      legacy per-(customer, workspace) rows, preserves valid products, drops
 *      only provably orphaned references, reports ambiguity and is idempotent.
 *   §D CUSTOM REQUEST DESTINATION — a standalone request requires an ACTIVE
 *      shop; the request is stored against exactly that workspace.
 *   §E PRODUCT-ORIGINATED LOCKING — the request inherits Product.workspaceId; a
 *      mismatched shopSlug is refused and a forged workspaceId is ignored.
 *   §F INVALID SHOP — unknown / malformed / suspended shops (and products owned
 *      by them) can never receive a request, and no partial record is written.
 *   §G CUSTOM REQUEST ISOLATION — cross-workspace and cross-customer reads and
 *      writes are denied; staff lists never cross tenants.
 *   §H PROPOSAL INHERITANCE — the proposal is stamped with the request's shop,
 *      a mismatched proposal can never be sent, and the resulting order carries
 *      the same workspace (invariant asserted before creation).
 *   §I CONVERSATION — Conversation.workspaceId comes from Order.workspaceId
 *      (customer-created included), mismatches self-heal, cross-shop access is
 *      denied and the internal id never reaches an API payload.
 *   §J NOTIFICATIONS — a new request notifies ONLY the owning shop's staff; a
 *      customer feed carries no workspaceId.
 *   §K CUSTOM GIFT STUDIO — a studio gift needs an explicit ACTIVE fulfilment
 *      shop when several could fulfil it, the selected shop is stored on the
 *      order, server-side pricing stays authoritative and invalid shops refuse.
 *   §L NO TENANT LEAKAGE — a deep scan of every customer-facing payload.
 *
 * Run: npm run test:shop-services
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';
import { buildWishlistMergePlan } from './merge-wishlists-global.mjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import Inventory from '../models/Inventory.js';
import Message from '../models/Message.js';
import Wishlist from '../models/Wishlist.js';
import CustomRequest from '../models/CustomRequest.js';
import Proposal from '../models/Proposal.js';
import Order from '../models/Order.js';
import Conversation from '../models/Conversation.js';
import Notification from '../models/Notification.js';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.SHOP_SERVICES_PORT || 4113);
const DB_NAME = 'Flora-Alchemy-Test-ShopServices';

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
  Wishlist.init(),
  CustomRequest.init(),
  Proposal.init(),
  Order.init(),
  Conversation.init(),
  Notification.init(),
  Message.init(),
]);

const wsA = await Workspace.create({ slug: `svc-studio-a-${stamp}`, displayName: 'Service Studio A', status: 'ACTIVE' });
const wsB = await Workspace.create({ slug: `svc-studio-b-${stamp}`, displayName: 'Service Studio B', status: 'ACTIVE' });
const wsSuspended = await Workspace.create({ slug: `svc-studio-dormant-${stamp}`, displayName: 'Dormant Studio', status: 'SUSPENDED' });
check('fixtures: three workspaces (A, B ACTIVE · dormant SUSPENDED)', !!wsA && !!wsB && wsSuspended.status === 'SUSPENDED');

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
const adminAEmail = `svc-admin-a-${stamp}@shopservices.test`;
const adminBEmail = `svc-admin-b-${stamp}@shopservices.test`;
const handlerAEmail = `svc-handler-a-${stamp}@shopservices.test`;
await makeUser({ email: adminAEmail, password: P('AdminA'), role: 'admin', name: 'Svc Admin A', workspaceId: wsA._id });
await makeUser({ email: adminBEmail, password: P('AdminB'), role: 'admin', name: 'Svc Admin B', workspaceId: wsB._id });
await makeUser({ email: handlerAEmail, password: P('HandlerA'), role: 'handler', name: 'Svc Handler A', workspaceId: wsA._id });

const { child: SERVER, base } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'shop-services',
});
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
const HANDLER_A = await login(handlerAEmail, P('HandlerA'));

const custAEmail = `svc-cust-a-${stamp}@shopservices.test`;
const custBEmail = `svc-cust-b-${stamp}@shopservices.test`;
await req('POST', '/auth/register', { body: { name: 'Svc Customer A', email: custAEmail, password: P('CustA') } });
await req('POST', '/auth/register', { body: { name: 'Svc Customer B', email: custBEmail, password: P('CustB') } });
const CUST_A = await login(custAEmail, P('CustA'));
const CUST_B = await login(custBEmail, P('CustB'));
const custA = (await req('GET', '/customers/me', { token: CUST_A })).json?.customer;
const custB = (await req('GET', '/customers/me', { token: CUST_B })).json?.customer;
// The customer payload exposes `id` (Customer.toJSON maps _id → id).
const custAId = custA?.id || custA?._id;
const custBId = custB?.id || custB?._id;
check('fixtures: staff + customers signed in', !!ADMIN_A && !!ADMIN_B && !!HANDLER_A && !!CUST_A && !!CUST_B);

// Products through the real staff endpoint (server-side attribution + stock).
let r = await req('POST', '/products', {
  token: ADMIN_A,
  body: { name: 'Service Bloom A', price: 1200, category: 'Posies', initialStock: 10 },
});
const PRODUCT_A = r.json?.product?.slug;
r = await req('POST', '/products', {
  token: ADMIN_B,
  body: { name: 'Service Bloom B', price: 900, category: 'Posies', initialStock: 10 },
});
const PRODUCT_B = r.json?.product?.slug;
const productSuspended = await Product.create({
  name: 'Dormant Bloom',
  slug: `dormant-bloom-${stamp}`,
  price: 700,
  visibility: 'Visible',
  stockTracked: false,
  workspaceId: wsSuspended._id,
});
const productLegacy = await Product.create({
  name: 'Legacy Posy',
  slug: `legacy-posy-${stamp}`,
  price: 500,
  visibility: 'Visible',
  stockTracked: false,
});
check(
  'fixtures: products attributed to A, B, a suspended shop and a legacy row',
  !!PRODUCT_A && !!PRODUCT_B && String((await Product.findOne({ slug: PRODUCT_A }).lean()).workspaceId) === String(wsA._id)
);

// A REAL order in workspace A (staff order → server-derived attribution).
r = await req('POST', '/orders/admin', {
  token: ADMIN_A,
  body: {
    customerId: String(custAId),
    items: [{ name: 'Bespoke Service Order', price: 1500, quantity: 1 }],
    paymentMethod: 'Sample',
  },
});
const ORDER_A = r.json?.order?.orderId;
check('fixtures: workspace A order created', r.status === 201 && !!ORDER_A, `${r.status}`);

// ══════════ §A GLOBAL CUSTOMER IDENTITY ══════════
console.log('\n— §A GLOBAL CUSTOMER IDENTITY —');
r = await req('PATCH', `/customers/${String(custAId)}`, {
  token: CUST_A,
  body: { name: 'Svc Customer A Updated', phone: '9876500001', city: 'Jaipur' },
});
const custAReloaded = await Customer.findById(custAId).lean();
check(
  'customer self-service keeps working (name/phone/city)',
  r.status === 200 && custAReloaded.name === 'Svc Customer A Updated' && custAReloaded.city === 'Jaipur',
  `${r.status} ${custAReloaded.name}`
);

r = await req('PATCH', `/customers/${String(custBId)}`, { token: CUST_A, body: { name: 'Not Mine' } });
check('customer cannot update another customer (403)', r.status === 403, `${r.status}`);

r = await req('PATCH', `/customers/${String(custAId)}`, { token: CUST_A, body: { status: 'Inactive' } });
check(
  'customer cannot change their own account status (403 CUSTOMER_PROFILE_PROTECTED)',
  r.status === 403 && r.json?.code === 'CUSTOMER_PROFILE_PROTECTED',
  `${r.status} ${r.json?.code}`
);
check(
  'account status untouched after the attempt',
  (await Customer.findById(custAId).lean()).status === 'Active'
);

// The customer must be RELATIONSHIP-linked to workspace A first (the staff
// order above created that link).
r = await req('PATCH', `/customers/${String(custAId)}`, { token: ADMIN_A, body: { name: 'Renamed By Staff' } });
check(
  'staff cannot rewrite the global customer name (403 CUSTOMER_PROFILE_PROTECTED)',
  r.status === 403 && r.json?.code === 'CUSTOMER_PROFILE_PROTECTED',
  `${r.status} ${r.json?.code}`
);
check(
  'the global name is unchanged after the staff attempt',
  (await Customer.findById(custAId).lean()).name === 'Svc Customer A Updated'
);
r = await req('PATCH', `/customers/${String(custAId)}`, {
  token: ADMIN_A,
  body: { phone: '9000000000', addresses: [], preferences: { newsletter: false } },
});
check('staff cannot rewrite contact details / addresses / preferences (403)', r.status === 403, `${r.status}`);
const afterStaffAttempt = await Customer.findById(custAId).lean();
check(
  'phone + preferences untouched by staff',
  afterStaffAttempt.phone === '9876500001' && afterStaffAttempt.preferences.newsletter === true
);

r = await req('PATCH', `/customers/${String(custBId)}`, { token: ADMIN_A, body: { name: 'Cross Shop' } });
check('staff patching an UNRELATED customer reads as 404 (relationship rule first)', r.status === 404, `${r.status}`);

r = await req('GET', `/customers/${String(custAId)}`, { token: ADMIN_A });
check(
  'staff CAN read the relationship-linked customer (fulfilment data)',
  r.status === 200 && r.json?.customer?.phone === '9876500001',
  `${r.status}`
);
r = await req('GET', `/customers/${String(custAId)}`, { token: ADMIN_B });
check('cross-shop staff cannot read an unrelated customer (404)', r.status === 404, `${r.status}`);
r = await req('PATCH', `/customers/${String(custAId)}`, { token: ADMIN_A, body: { internalNote: 'no protected field' } });
check('a staff PATCH without identity fields is a read-only no-op (200)', r.status === 200, `${r.status}`);

// ══════════ §C WISHLIST MIGRATION (guarded DRY-RUN → APPLY) ══════════
console.log('\n— §C WISHLIST MIGRATION —');
const migrationCustomer = await Customer.create({ name: 'Migration Customer', email: `svc-migrate-${stamp}@shopservices.test` });
const legacyScoped = await Wishlist.create({
  customerId: migrationCustomer._id,
  workspaceId: wsA._id,
  productIds: [PRODUCT_A, 'ghost-slug-that-does-not-exist'],
});
const legacyGlobal = await Wishlist.create({
  customerId: migrationCustomer._id,
  workspaceId: null,
  productIds: [PRODUCT_A, PRODUCT_B],
});

// Pure planner (unit-level rules).
const planFixture = buildWishlistMergePlan({
  wishlists: [
    { _id: 'w1', customerId: 'c1', workspaceId: 'wsA', productIds: ['p1', 'p2'], createdAt: new Date('2026-01-01') },
    { _id: 'w2', customerId: 'c1', workspaceId: null, productIds: ['p2', 'p3', 'ghost'], createdAt: new Date('2026-02-01') },
  ],
  knownProductSlugs: new Set(['p1', 'p2', 'p3']),
  productWorkspaceById: new Map([['p1', 'wsA'], ['p2', 'wsB'], ['p3', null]]),
});
const fixturePlan = planFixture.plans[0];
check('planner: canonical document prefers the existing global row', String(fixturePlan.canonicalId) === 'w2', `${fixturePlan.canonicalId}`);
check('planner: superseded scoped document is listed for removal', fixturePlan.supersededIds.length === 1 && String(fixturePlan.supersededIds[0]) === 'w1');
check(
  'planner: union preserves every valid product and dedupes',
  JSON.stringify(fixturePlan.productIds) === JSON.stringify(['p1', 'p2', 'p3']),
  JSON.stringify(fixturePlan.productIds)
);
check('planner: only the provably orphaned reference is dropped', JSON.stringify(fixturePlan.dropped) === JSON.stringify(['ghost']), JSON.stringify(fixturePlan.dropped));
check(
  'planner: ambiguity is reported (multiple docs + cross-shop reference)',
  planFixture.summary.ambiguousFindings.some((f) => f.kind === 'multiple-documents') &&
    planFixture.summary.ambiguousFindings.some((f) => f.kind === 'cross-scope-reference')
);
const replay = buildWishlistMergePlan({
  wishlists: [{ _id: 'w2', customerId: 'c1', workspaceId: null, productIds: ['p1', 'p2', 'p3'], createdAt: new Date('2026-02-01') }],
  knownProductSlugs: new Set(['p1', 'p2', 'p3']),
});
check('planner: idempotent — a consolidated customer plans no change', replay.summary.changed === false && replay.plans[0].changed === false);
const singleScoped = buildWishlistMergePlan({
  wishlists: [{ _id: 'w9', customerId: 'c9', workspaceId: 'wsA', productIds: ['p1'], createdAt: new Date('2026-01-01') }],
  knownProductSlugs: new Set(['p1']),
});
check('planner: a lone legacy scoped row is detached (workspaceId → null)', singleScoped.plans[0].changed === true && singleScoped.summary.documentsDetached === 1);

// The CLI itself: DRY-RUN first, then APPLY, then idempotent re-APPLY.
function runMigrationCli(args) {
  return execFileSync(process.execPath, ['scripts/merge-wishlists-global.mjs', ...args], {
    cwd: BACKEND_DIR,
    env: { ...process.env, MONGO_URI: TEST_URI },
    encoding: 'utf8',
    timeout: 60000,
  });
}
const dryRun = runMigrationCli([]);
check('migration CLI: DRY-RUN reports the plan and writes nothing', /DRY-RUN/.test(dryRun) && (await Wishlist.countDocuments({ customerId: migrationCustomer._id })) === 2);
const applied = runMigrationCli(['--apply']);
check('migration CLI: APPLY consolidates to one document', /DONE/.test(applied) && (await Wishlist.countDocuments({ customerId: migrationCustomer._id })) === 1);
const mergedDoc = await Wishlist.findOne({ customerId: migrationCustomer._id }).lean();
check('migration: merged document is global (workspaceId null)', mergedDoc && !mergedDoc.workspaceId, `${mergedDoc?.workspaceId}`);
check(
  'migration: valid products preserved, orphan dropped',
  JSON.stringify([...mergedDoc.productIds].sort()) === JSON.stringify([PRODUCT_A, PRODUCT_B].sort()),
  JSON.stringify(mergedDoc?.productIds)
);
check('migration: superseded scoped row deleted', !(await Wishlist.findById(legacyScoped._id).lean()));
const reapplied = runMigrationCli(['--apply']);
check('migration CLI: re-APPLY is idempotent (nothing to apply)', /nothing to apply/.test(reapplied), reapplied.trim().split('\n').slice(-1)[0]);
check('migration: the customer still holds exactly one document', (await Wishlist.countDocuments({ customerId: migrationCustomer._id })) === 1);
await Wishlist.deleteOne({ _id: legacyGlobal._id });

// ══════════ §B GLOBAL WISHLIST ══════════
console.log('\n— §B GLOBAL WISHLIST —');
r = await req('POST', `/wishlist/${PRODUCT_A}?shop=${wsA.slug}`, { token: CUST_A });
check('save a product while browsing Shop A (200)', r.status === 200 && r.json?.wishlist?.productIds?.includes(PRODUCT_A), `${r.status}`);
r = await req('POST', `/wishlist/${PRODUCT_B}?shop=${wsB.slug}`, { token: CUST_A });
check('save a product while browsing Shop B (200)', r.status === 200 && r.json?.wishlist?.productIds?.includes(PRODUCT_B), `${r.status}`);

check('ONE wishlist document for the customer', (await Wishlist.countDocuments({ customerId: custAId })) === 1);
r = await req('GET', `/wishlist?shop=${wsA.slug}`, { token: CUST_A });
const wishA = r.json?.wishlist || {};
check(
  'opening Shop A shows BOTH shops’ saved products',
  wishA.productIds?.includes(PRODUCT_A) && wishA.productIds?.includes(PRODUCT_B),
  JSON.stringify(wishA.productIds)
);
r = await req('GET', `/wishlist?shop=${wsB.slug}`, { token: CUST_A });
check(
  'opening Shop B does NOT switch the wishlist',
  r.json?.wishlist?.productIds?.includes(PRODUCT_A) && r.json?.wishlist?.productIds?.includes(PRODUCT_B),
  JSON.stringify(r.json?.wishlist?.productIds)
);
r = await req('GET', '/wishlist', { token: CUST_A });
check('no shop context returns the same global wishlist', (r.json?.wishlist?.productIds || []).length === 2, JSON.stringify(r.json?.wishlist?.productIds));

r = await req('POST', `/wishlist/${PRODUCT_A}?shop=${wsB.slug}`, { token: CUST_A });
check(
  'duplicate save deduped (once, and still one document)',
  (r.json?.wishlist?.productIds || []).filter((id) => id === PRODUCT_A).length === 1 &&
    (await Wishlist.countDocuments({ customerId: custAId })) === 1
);
const wishlistPayload = r.json?.wishlist;
check('wishlist payload carries Shop identity per product', wishlistPayload?.products?.find((p) => p.slug === PRODUCT_A)?.shop?.slug === wsA.slug && wishlistPayload?.products?.find((p) => p.slug === PRODUCT_B)?.shop?.slug === wsB.slug);
check('wishlist payload exposes NO workspaceId', leaks(wishlistPayload).length === 0, JSON.stringify(leaks(wishlistPayload)));

r = await req('POST', `/wishlist/${productSuspended.slug}`, { token: CUST_A });
check(
  'a product from a suspended shop is saved but reported UNAVAILABLE',
  r.status === 200 && r.json?.wishlist?.unavailableIds?.includes(productSuspended.slug) && !(r.json?.wishlist?.products || []).some((p) => p.slug === productSuspended.slug),
  `${r.status} ${JSON.stringify(r.json?.wishlist?.unavailableIds)}`
);

r = await req('GET', '/wishlist', { token: CUST_B });
check('another customer’s wishlist stays independent (empty)', r.status === 200 && (r.json?.wishlist?.productIds || []).length === 0);
r = await req('POST', `/wishlist/${PRODUCT_A}`, { token: HANDLER_A });
check('staff have no wishlist (403)', r.status === 403, `${r.status}`);

r = await req('DELETE', `/wishlist/${PRODUCT_B}?shop=${wsA.slug}`, { token: CUST_A });
check('remove works regardless of the shop context', r.status === 200 && !(r.json?.wishlist?.productIds || []).includes(PRODUCT_B));
r = await req('DELETE', `/wishlist/${productLegacy.slug}`, { token: CUST_A });
check(
  'removing an id that was never saved is a no-op (200, list unchanged)',
  r.status === 200 && !(r.json?.wishlist?.productIds || []).includes(productLegacy.slug),
  `${r.status}`
);
r = await req('POST', `/wishlist/${productLegacy.slug}`, { token: CUST_A });
check('a legacy (shop-less) product is still saveable', r.status === 200 && r.json?.wishlist?.productIds?.includes(productLegacy.slug));
r = await req('DELETE', '/wishlist', { token: CUST_A });
check('clear empties the single global wishlist', r.status === 200 && (r.json?.wishlist?.productIds || []).length === 0);

// ══════════ §D/§E/§F CUSTOM REQUEST DESTINATION ══════════
console.log('\n— §D STANDALONE REQUESTS —');
let requestCount = await CustomRequest.countDocuments({});
r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Standalone brief with an explicit shop selected', shopSlug: wsB.slug },
});
const STANDALONE_B = r.json?.request?._id || r.json?.request?.id;
check('standalone request with an ACTIVE shop → 201', r.status === 201 && !!STANDALONE_B, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 120)}`);
check(
  'the request is stored against the SELECTED shop',
  String((await CustomRequest.findById(STANDALONE_B).lean()).workspaceId) === String(wsB._id)
);
check(
  'customer payload carries the shop and no workspaceId',
  r.json?.request?.shop?.slug === wsB.slug && leaks(r.json?.request).length === 0,
  JSON.stringify(r.json?.request?.shop)
);

r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'A standalone brief that forgot to select any shop' },
});
check('standalone request without a shop → 422 SHOP_REQUIRED', r.status === 422 && r.json?.code === 'SHOP_REQUIRED', `${r.status} ${r.json?.code}`);
check('no partial record was written', (await CustomRequest.countDocuments({})) === requestCount + 1);

r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Standalone brief with a forged tenant field', shopSlug: wsB.slug, workspaceId: String(wsA._id) },
});
check(
  'a forged workspaceId cannot move a standalone request to another shop',
  r.status === 201 && String((await CustomRequest.findById(r.json?.request?._id).lean()).workspaceId) === String(wsB._id)
);

r = await req('GET', '/custom-requests', { token: ADMIN_B });
check('shop B’s staff queue shows its request', (r.json?.requests || []).some((q) => String(q._id) === String(STANDALONE_B)));
r = await req('GET', '/custom-requests', { token: ADMIN_A });
check('shop A’s staff queue never shows shop B’s request', !(r.json?.requests || []).some((q) => String(q._id) === String(STANDALONE_B)));

console.log('\n— §E PRODUCT-ORIGINATED REQUESTS —');
r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: {
    description: 'Commission a custom version of this arrangement',
    productId: PRODUCT_A,
    workspaceId: String(wsB._id),
  },
});
const REQUEST_FROM_A = r.json?.request?._id || r.json?.request?.id;
check('product-context request accepted (201)', r.status === 201 && !!REQUEST_FROM_A, `${r.status}`);
check(
  'request inherits Product.workspaceId (forged tenant ignored)',
  String((await CustomRequest.findById(REQUEST_FROM_A).lean()).workspaceId) === String(wsA._id)
);
check('product identity frozen on the request', !!r.json?.request?.productId && !!r.json?.request?.productName);
check('customer payload shows the product’s shop, never a workspaceId', r.json?.request?.shop?.slug === wsA.slug && leaks(r.json?.request).length === 0);

const beforeMismatch = await CustomRequest.countDocuments({});
r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Trying to redirect the product commission', productId: PRODUCT_A, shopSlug: wsB.slug },
});
check('mismatched shopSlug on a product request → 409 SHOP_MISMATCH', r.status === 409 && r.json?.code === 'SHOP_MISMATCH', `${r.status} ${r.json?.code}`);
check('the mismatch wrote nothing', (await CustomRequest.countDocuments({})) === beforeMismatch);

r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Matching shop context on a product commission', productId: PRODUCT_A, shopSlug: wsA.slug },
});
check('matching shopSlug is accepted', r.status === 201, `${r.status}`);

console.log('\n— §F INVALID / SUSPENDED SHOP —');
const beforeInvalid = await CustomRequest.countDocuments({});
r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Request aimed at a shop that does not exist', shopSlug: 'no-such-shop-anywhere' },
});
check('unknown shop → 422 SHOP_NOT_FOUND', r.status === 422 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);
r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Request aimed at a malformed shop slug', shopSlug: 'Not A Slug!!' },
});
check('malformed slug → 422 SHOP_NOT_FOUND', r.status === 422 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);
r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Request aimed at a suspended shop', shopSlug: wsSuspended.slug },
});
check('suspended shop → 422 SHOP_NOT_FOUND', r.status === 422 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);
r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Commission from a product whose shop is suspended', productId: productSuspended.slug },
});
check('product owned by a suspended shop → 422 PRODUCT_NOT_FOUND', r.status === 422 && r.json?.code === 'PRODUCT_NOT_FOUND', `${r.status} ${r.json?.code}`);
check('no invalid attempt wrote a record', (await CustomRequest.countDocuments({})) === beforeInvalid);

// ══════════ §G CUSTOM REQUEST ISOLATION ══════════
console.log('\n— §G CUSTOM REQUEST ISOLATION —');
r = await req('GET', `/custom-requests/${String(REQUEST_FROM_A)}`, { token: ADMIN_B });
check('admin B reading shop A’s request → 404', r.status === 404, `${r.status}`);
r = await req('GET', `/custom-requests/${String(REQUEST_FROM_A)}`, { token: ADMIN_A });
check('admin A reads its own request → 200', r.status === 200, `${r.status}`);
r = await req('GET', `/custom-requests/${String(REQUEST_FROM_A)}`, { token: HANDLER_A });
check('shop A handler reads the request (membership + permission)', r.status === 200, `${r.status}`);
r = await req('GET', `/custom-requests/${String(REQUEST_FROM_A)}`, { token: CUST_B });
check('customer B cannot read customer A’s request → 404', r.status === 404, `${r.status}`);
r = await req('PATCH', `/custom-requests/${String(REQUEST_FROM_A)}/status`, { token: ADMIN_B, body: { status: 'reviewing' } });
check('admin B cannot decide on shop A’s request → 404', r.status === 404, `${r.status}`);
check('the cross-shop decision changed nothing', (await CustomRequest.findById(REQUEST_FROM_A).lean()).status === 'pending');
r = await req('PATCH', `/custom-requests/${String(REQUEST_FROM_A)}/status`, { token: CUST_A, body: { status: 'accepted' } });
check('a customer cannot drive staff status transitions → 403', r.status === 403, `${r.status}`);
r = await req('POST', `/custom-requests/${String(REQUEST_FROM_A)}/proposal`, { token: ADMIN_B, body: { items: [{ itemName: 'x', quantity: 1, unitPrice: 1 }] } });
check('admin B cannot build a proposal for shop A’s request → 404', r.status === 404, `${r.status}`);
check('no proposal was written by the cross-shop attempt', !(await Proposal.findOne({ customRequestId: REQUEST_FROM_A }).lean()));

// ══════════ §H PROPOSAL / ORDER INHERITANCE ══════════
console.log('\n— §H PROPOSAL + ORDER INHERITANCE —');
r = await req('PATCH', `/custom-requests/${String(REQUEST_FROM_A)}/status`, { token: ADMIN_A, body: { status: 'accepted' } });
check('shop A accepts the request', r.status === 200 && r.json?.request?.status === 'accepted', `${r.status}`);
r = await req('POST', `/custom-requests/${String(REQUEST_FROM_A)}/proposal`, {
  token: ADMIN_A,
  body: { items: [{ itemName: 'Preserved rose arrangement', quantity: 2, unitPrice: 750 }, { itemName: 'Name card', quantity: 1, unitPrice: 100 }] },
});
const proposalId = r.json?.proposal?._id;
check('proposal created (201) with server-calculated totals', r.status === 201 && r.json?.proposal?.subtotal === 1600, `${r.status} ${r.json?.proposal?.subtotal}`);
check('proposal inherits the request’s shop', String((await Proposal.findById(proposalId).lean()).workspaceId) === String(wsA._id));

// Corrupt the proposal's shop directly in the DB — the invariant must refuse.
await Proposal.updateOne({ _id: proposalId }, { $set: { workspaceId: wsB._id } });
const beforeMismatchOrders = await Order.countDocuments({});
r = await req('POST', `/custom-requests/${String(REQUEST_FROM_A)}/proposal/send`, { token: ADMIN_A });
check('a proposal stamped with another shop cannot be sent → 409 SHOP_MISMATCH', r.status === 409 && r.json?.code === 'SHOP_MISMATCH', `${r.status} ${r.json?.code}`);
check('the request was not quoted by the mismatched send', (await CustomRequest.findById(REQUEST_FROM_A).lean()).status === 'accepted');
check('no order exists for the mismatched attempt', (await Order.countDocuments({})) === beforeMismatchOrders);

r = await req('POST', `/custom-requests/${String(REQUEST_FROM_A)}/proposal`, {
  token: ADMIN_A,
  body: { items: [{ itemName: 'Preserved rose arrangement', quantity: 2, unitPrice: 750 }] },
});
check('rebuilding the draft re-stamps the request’s shop', String((await Proposal.findById(proposalId).lean()).workspaceId) === String(wsA._id));
r = await req('POST', `/custom-requests/${String(REQUEST_FROM_A)}/proposal/send`, { token: ADMIN_A });
check('sending the repaired proposal succeeds (request quoted)', r.status === 200 && r.json?.request?.status === 'quoted', `${r.status}`);

r = await req('POST', `/custom-requests/${String(REQUEST_FROM_A)}/proposal/accept`, { token: CUST_A });
const proposalOrderId = r.json?.order?.orderId;
check('customer accepts the proposal (order created)', (r.status === 200 || r.status === 201) && !!proposalOrderId, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 120)}`);
const proposalOrder = await Order.findOne({ orderId: proposalOrderId }).lean();
check(
  'Proposal.workspaceId == CustomRequest.workspaceId == Order.workspaceId',
  String(proposalOrder?.workspaceId) === String(wsA._id) &&
    String((await Proposal.findById(proposalId).lean()).workspaceId) === String(wsA._id) &&
    String((await CustomRequest.findById(REQUEST_FROM_A).lean()).workspaceId) === String(wsA._id),
  `${proposalOrder?.workspaceId}`
);
check(
  'the order total equals the stored proposal total (server-authoritative)',
  proposalOrder?.total === 750 * 2 + proposalOrder.shipping
);

// ══════════ §I CONVERSATION TENANCY ══════════
console.log('\n— §I CONVERSATION —');
r = await req('GET', `/conversations/order/${ORDER_A}`, { token: CUST_A });
check('customer opens the order conversation (200)', r.status === 200, `${r.status}`);
const conversationA = await Conversation.findOne({ orderId: ORDER_A }).lean();
check(
  'a CUSTOMER-created conversation inherits Order.workspaceId',
  String(conversationA?.workspaceId) === String(wsA._id),
  `${conversationA?.workspaceId}`
);
r = await req('GET', `/conversations/mine`, { token: CUST_A });
check(
  'conversation payloads never expose workspaceId',
  leaks(r.json?.conversations || []).length === 0 && (r.json?.conversations || []).length > 0,
  JSON.stringify(leaks(r.json?.conversations))
);

r = await req('GET', `/conversations/order/${ORDER_A}?workspaceId=${wsB._id}`, { token: CUST_A });
check(
  'a query-string workspaceId cannot move the conversation',
  r.status === 200 && String((await Conversation.findOne({ orderId: ORDER_A }).lean()).workspaceId) === String(wsA._id)
);

// Self-heal: simulate a conversation created before the rule (unscoped).
await Conversation.updateOne({ orderId: ORDER_A }, { $set: { workspaceId: null } });
r = await req('GET', `/conversations/order/${ORDER_A}`, { token: ADMIN_A });
check(
  'staff access self-heals a legacy unscoped conversation from the order',
  r.status === 200 && String((await Conversation.findOne({ orderId: ORDER_A }).lean()).workspaceId) === String(wsA._id)
);
r = await req('GET', `/conversations/order/${ORDER_A}`, { token: ADMIN_B });
check('another shop cannot open the conversation → 404', r.status === 404, `${r.status}`);
r = await req('GET', `/conversations/order/${ORDER_A}`, { token: CUST_B });
check('another customer cannot open the conversation → 403', r.status === 403, `${r.status}`);
r = await req('POST', `/conversations/${String(conversationA._id)}/messages`, { token: ADMIN_B, body: { body: 'cross tenant attempt' } });
check('another shop cannot post into the conversation → 404', r.status === 404, `${r.status}`);
r = await req('POST', `/conversations/${String(conversationA._id)}/messages`, { token: ADMIN_A, body: { body: 'Shop A here — your order is in production.' } });
check('owning shop can post (201)', r.status === 201, `${r.status}`);
r = await req('GET', `/conversations/${String(conversationA._id)}/messages`, { token: CUST_A });
check('customer reads the messages (ownership)', r.status === 200 && (r.json?.messages || []).length === 1, `${r.status}`);

// The proposal order's conversation follows the same rule, from the customer.
r = await req('GET', `/conversations/order/${proposalOrderId}`, { token: CUST_A });
check(
  'the proposal order’s conversation also inherits its order workspace',
  r.status === 200 &&
    String((await Conversation.findOne({ orderId: proposalOrderId }).lean()).workspaceId) === String(wsA._id),
  `${r.status}`
);

// ══════════ §J NOTIFICATION ROUTING ══════════
console.log('\n— §J NOTIFICATION ROUTING —');
const adminANotificationsBefore = await Notification.countDocuments({ userId: (await User.findOne({ email: adminAEmail }).lean())._id, type: 'new_custom_request' });
const adminBNotificationsBefore = await Notification.countDocuments({ userId: (await User.findOne({ email: adminBEmail }).lean())._id, type: 'new_custom_request' });
r = await req('POST', '/custom-requests', {
  token: CUST_A,
  body: { description: 'Routing probe — this belongs to shop B only', shopSlug: wsB.slug },
});
const ROUTING_REQUEST = r.json?.request?._id;
const adminANotificationsAfter = await Notification.countDocuments({ userId: (await User.findOne({ email: adminAEmail }).lean())._id, type: 'new_custom_request' });
const adminBNotificationsAfter = await Notification.countDocuments({ userId: (await User.findOne({ email: adminBEmail }).lean())._id, type: 'new_custom_request' });
check('the owning shop’s staff are notified', adminBNotificationsAfter === adminBNotificationsBefore + 1, `${adminBNotificationsBefore} → ${adminBNotificationsAfter}`);
check('the other shop’s staff are NOT notified', adminANotificationsAfter === adminANotificationsBefore, `${adminANotificationsBefore} → ${adminANotificationsAfter}`);

await req('PATCH', `/custom-requests/${String(ROUTING_REQUEST)}/status`, { token: ADMIN_B, body: { status: 'reviewing' } });
r = await req('GET', '/notifications', { token: CUST_A });
const customerNotifications = r.json?.notifications || [];
check('the customer receives their own request notification', customerNotifications.some((n) => n.type === 'custom_request_status'), JSON.stringify(customerNotifications.map((n) => n.type)));
check('customer notification payloads expose no workspaceId', leaks(customerNotifications).length === 0, JSON.stringify(leaks(customerNotifications)));
const customerBFeed = (await req('GET', '/notifications', { token: CUST_B })).json?.notifications || [];
check('another customer’s feed never contains it', !customerBFeed.some((n) => n.type === 'custom_request_status'));

// ══════════ §K CUSTOM GIFT STUDIO FULFILMENT SHOP ══════════
console.log('\n— §K CUSTOM GIFT STUDIO —');
const giftConfig = {
  baseId: 'keepsake-posy',
  flowerIds: ['rose'],
  paletteId: 'mauve',
  ribbonId: 'frayed-silk',
  sealId: 'terracotta',
};
const giftOrderBody = {
  items: [
    {
      name: 'Custom Birthday Gift — Handcrafted Everlasting Posy',
      price: 1, // deliberately wrong: the server must ignore it
      quantity: 1,
      customGiftConfig: giftConfig,
    },
  ],
  paymentMethod: 'Sample',
  shippingAddress: { name: 'Svc Customer A', address: '1 Bloom Lane', city: 'Jaipur', state: 'RJ', pincode: '302001' },
};
const ordersBeforeGift = await Order.countDocuments({});
r = await req('POST', '/orders', { token: CUST_A, body: giftOrderBody });
check('a studio gift without a fulfilment shop (2 live shops) → 422 SHOP_REQUIRED', r.status === 422 && r.json?.code === 'SHOP_REQUIRED', `${r.status} ${r.json?.code}`);
check('the refused gift wrote no order', (await Order.countDocuments({})) === ordersBeforeGift);

r = await req('POST', '/orders', { token: CUST_A, body: { ...giftOrderBody, shopSlug: wsB.slug } });
const giftOrder = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a studio gift with an explicit ACTIVE shop is accepted (201)', r.status === 201 && !!giftOrder, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 140)}`);
check('the order carries the SELECTED fulfilment shop', String(giftOrder?.workspaceId) === String(wsB._id), `${giftOrder?.workspaceId}`);
check('server-side pricing stayed authoritative (client price ignored)', giftOrder?.subtotal === 1850, `${giftOrder?.subtotal}`);

r = await req('POST', '/orders', { token: CUST_A, body: { ...giftOrderBody, shopSlug: wsSuspended.slug } });
check('a suspended shop cannot fulfil → 422 SHOP_NOT_FOUND', r.status === 422 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);
r = await req('POST', '/orders', { token: CUST_A, body: { ...giftOrderBody, shopSlug: 'not-a-shop-at-all' } });
check('an unknown shop cannot fulfil → 422 SHOP_NOT_FOUND', r.status === 422 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);
r = await req('POST', '/orders', { token: CUST_A, body: { ...giftOrderBody, shopSlug: wsSuspended.slug, workspaceId: String(wsA._id) } });
check('a forged tenant field cannot bypass the shop check', r.status === 422 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);

// Catalogue orders: an explicit shop attributes them; no shop keeps the
// historical unattributed behaviour.
r = await req('POST', '/orders', {
  token: CUST_A,
  body: {
    items: [{ productSlug: PRODUCT_A, name: 'Service Bloom A', quantity: 1 }],
    paymentMethod: 'Sample',
    shippingAddress: { name: 'Svc Customer A', address: '1 Bloom Lane', city: 'Jaipur', state: 'RJ', pincode: '302001' },
    shopSlug: wsA.slug,
  },
});
const catalogueOrder = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a catalogue order with a shop slug is attributed to that shop', r.status === 201 && String(catalogueOrder?.workspaceId) === String(wsA._id), `${r.status}`);
r = await req('POST', '/orders', {
  token: CUST_A,
  body: {
    items: [{ productSlug: PRODUCT_B, name: 'Service Bloom B', quantity: 1 }],
    paymentMethod: 'Sample',
    shippingAddress: { name: 'Svc Customer A', address: '1 Bloom Lane', city: 'Jaipur', state: 'RJ', pincode: '302001' },
  },
});
const unattributedOrder = await Order.findOne({ orderId: r.json?.order?.orderId }).lean();
check('a catalogue order without a shop stays unattributed (unchanged)', r.status === 201 && !unattributedOrder?.workspaceId, `${r.status} ${unattributedOrder?.workspaceId}`);

// ══════════ §L NO TENANT LEAKAGE ══════════
console.log('\n— §L NO TENANT LEAKAGE —');
const customerSurfaces = {
  wishlist: (await req('GET', '/wishlist', { token: CUST_A })).json,
  myRequests: (await req('GET', '/custom-requests/mine', { token: CUST_A })).json,
  requestDetail: (await req('GET', `/custom-requests/${String(REQUEST_FROM_A)}`, { token: CUST_A })).json,
  conversations: (await req('GET', '/conversations/mine', { token: CUST_A })).json,
  order: (await req('GET', `/orders/${proposalOrderId}`, { token: CUST_A })).json,
  myOrders: (await req('GET', '/orders/mine', { token: CUST_A })).json,
  catalogue: (await req('GET', '/products')).json,
  shops: (await req('GET', '/shops')).json,
};
for (const [surface, payload] of Object.entries(customerSurfaces)) {
  check(`no workspaceId in the customer-facing ${surface} payload`, leaks(payload).length === 0, JSON.stringify(leaks(payload)));
}
check(
  'the shop directory still answers with { slug, displayName } only',
  (customerSurfaces.shops?.shops || []).every((s) => Object.keys(s).sort().join(',') === 'displayName,slug')
);
r = await req('GET', `/custom-requests/${String(REQUEST_FROM_A)}`, { token: ADMIN_A });
check('staff reads keep the internal workspaceId (operational need)', !!r.json?.request?.workspaceId, `${r.json?.request?.workspaceId}`);

// ══════════ cleanup + result ══════════
try {
  for (const name of [
    'users',
    'customers',
    'workspaces',
    'products',
    'inventories',
    'inventorymovements',
    'wishlists',
    'customrequests',
    'proposals',
    'orders',
    'conversations',
    'messages',
    'notifications',
    'settings',
    'staffevents',
  ]) {
    try {
      await mongoose.connection.db.collection(name).deleteMany({});
    } catch {
      /* collection may not exist */
    }
  }
  console.log(`\n— cleanup: cleared ${DB_NAME} —`);
} catch (err) {
  console.log(`\n— cleanup skipped (${err.message}) —`);
}

console.log(`\nSHOP-SERVICES RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
}

try {
  await mongoose.disconnect().catch(() => {});
} finally {
  await stopTestServer(SERVER, base);
}
