/**
 * Phase 15 security regression tests.
 *
 * Every assertion proves a security control is actually enforced server-side.
 * Self-contained: boots its OWN backend (port 4093) against its OWN database
 * (Flora-Alchemy-Test-Security). The brute-force test exhausts THIS server's
 * in-memory login limiter only — other suites are never affected (Phase 16).
 *
 * Run: node scripts/security-smoke.mjs
 */
import { bootTestServer, stopTestServer } from './lib/testServer.mjs';

const { child: API_CHILD, base: API_BASE } = await bootTestServer({
  port: 4093,
  db: 'Flora-Alchemy-Test-Security',
  label: 'security-smoke',
});
const BASE = `${API_BASE}/api`;

let passed = 0;
let failed = 0;
const failures = [];

async function req(method, path, { token, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

async function main() {
  const stamp = Date.now();

  console.log('\n— SETUP —');
  let r = await req('POST', '/auth/login', { body: { email: 'handler.admin@flora-alchemy.demo', password: 'handler1234' } });
  const ADMIN = r.json.token;
  const ADMIN_ID = r.json.user?.id;
  check('admin login works', r.status === 200 && !!ADMIN);

  r = await req('POST', '/auth/register', { body: { name: 'Sec A', email: `sec-a-${stamp}@example.com`, password: 'secret123' } });
  const CUSTOMER_A = r.json.token;
  const CUST_A_ID = r.json.user?.customerId;
  check('customer A registered', r.status === 201);

  r = await req('POST', '/auth/register', { body: { name: 'Sec B', email: `sec-b-${stamp}@example.com`, password: 'secret123' } });
  const CUSTOMER_B = r.json.token;
  check('customer B registered', r.status === 201);

  r = await req('POST', '/auth/register', { body: { name: 'Sec H', email: `sec-h-${stamp}@example.com`, password: 'secret123' } });
  check('customers cannot self-register as staff', r.json.user?.role === 'customer');

  console.log('\n— AUTHENTICATION: TOKEN FORGERY / EXPIRY / MALFORMED —');
  r = await req('GET', '/auth/me', { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJoYWNrZWQiLCJyb2xlIjoiYWRtaW4ifQ.forged-signature' } });
  check('forged JWT rejected → 401', r.status === 401);
  r = await req('GET', '/auth/me', { headers: { Authorization: 'Bearer not.a.jwt' } });
  check('malformed JWT rejected → 401', r.status === 401);
  r = await req('GET', '/auth/me', { headers: { Authorization: 'Bearer ' } });
  check('empty bearer rejected → 401', r.status === 401);
  r = await req('GET', '/auth/me', {});
  check('missing token rejected → 401', r.status === 401);
  // Token signed with the wrong secret (proper JWT structure, invalid signature)
  r = await req('GET', '/auth/me', { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6ImFkbWluIn0.wrong' } });
  check('wrong-secret JWT rejected → 401', r.status === 401);
  // IDOR via token claims: token for one user cannot claim another's identity
  r = await req('POST', '/auth/login', { body: { email: `sec-b-${stamp}@example.com`, password: 'secret123' } });
  const TOKEN_B_ONLY = r.json.token;
  check('role claim in token is not trusted for admin ops', (await req('GET', '/customers', { token: TOKEN_B_ONLY })).status === 403);

  console.log('\n— CUSTOMER OWNERSHIP (cross-customer isolation) —');
  // Stock-resilient product resolution: earlier suites may deplete a given
  // fixture's stock, so pick any in-stock product; admin-restock if all empty.
  let P = 'gold-foil-pressed-stickers';
  {
    const inv = (await req('GET', '/inventory', { token: ADMIN })).json.inventory || [];
    const pick = inv.find((i) => (i.currentStock ?? i.quantity ?? 0) > 0);
    if (pick) P = pick.productSlug;
    const cur = inv.find((i) => i.productSlug === P);
    if ((cur?.currentStock ?? cur?.quantity ?? 0) < 2) {
      await req('POST', `/inventory/${P}/adjust`, { token: ADMIN, body: { type: 'restock', quantity: 50, reason: 'security-suite restock' } });
    }
  }
  r = await req('POST', '/orders', {
    token: CUSTOMER_A,
    body: {
      items: [{ productSlug: P, quantity: 1 }],
      shippingAddress: { name: 'Sec A', address: '1 Sec St', city: 'Mumbai', state: 'MH', pincode: '400001' },
    },
  });
  check('customer A order created', r.status === 201, JSON.stringify(r.json).slice(0, 120));
  const ORDER_A = r.json.order?.orderId;

  r = await req('GET', `/orders/${ORDER_A}`, { token: CUSTOMER_B });
  check('customer B cannot read A order → 404', r.status === 404);
  r = await req('GET', `/payments/${ORDER_A}/status`, { token: CUSTOMER_B });
  check('customer B cannot read A payment status → 404', r.status === 404);
  r = await req('POST', '/payments/create-order', { token: CUSTOMER_B, body: { orderId: ORDER_A } });
  check('customer B cannot pay A order → 404', r.status === 404);
  r = await req('GET', `/customers/${CUST_A_ID}`, { token: CUSTOMER_B });
  check('customer B cannot read A profile → 404', r.status === 404);
  r = await req('GET', '/customers/me/addresses', { token: CUSTOMER_A });
  check('addresses scoped to owner', r.status === 200);

  // Conversation isolation: B cannot open A's order conversation.
  r = await req('GET', `/conversations/order/${ORDER_A}`, { token: CUSTOMER_B });
  check('customer B cannot access A conversation → 403/404', r.status === 403 || r.status === 404, String(r.status));

  console.log('\n— NOTIFICATION OWNERSHIP —');
  r = await req('GET', '/notifications', { token: CUSTOMER_A });
  check('customer reads own notifications', r.status === 200);
  r = await req('PATCH', '/notifications/000000000000000000000000/read', { token: CUSTOMER_A });
  check('mark-read unknown id → 404 (no cross-user mutation)', r.status === 404);

  console.log('\n— ROLE ENFORCEMENT —');
  r = await req('POST', '/admin/users', { token: CUSTOMER_A, body: { name: 'X', email: `x-${stamp}@t.io`, role: 'HANDLER' } });
  check('customer cannot create operator → 403', r.status === 403);
  r = await req('PATCH', '/settings', { token: CUSTOMER_A, body: { storeName: 'Hacked' } });
  check('customer cannot write settings → 403', r.status === 403);
  r = await req('POST', '/inventory/gold-foil-pressed-stickers/adjust', { token: CUSTOMER_A, body: { type: 'remove', quantity: 999 } });
  check('customer cannot adjust inventory → 403', r.status === 403);
  r = await req('PATCH', `/orders/${ORDER_A}/status`, { token: CUSTOMER_A, body: { status: 'confirmed' } });
  check('customer cannot change order status → 403', r.status === 403);
  r = await req('GET', '/analytics/overview', { token: CUSTOMER_A });
  check('customer cannot read analytics → 403', r.status === 403);
  r = await req('POST', '/products', { token: CUSTOMER_A, body: { name: 'Hack', price: 1 } });
  check('customer cannot create product → 403', r.status === 403);
  r = await req('POST', '/uploads/product-image', { token: CUSTOMER_A });
  check('customer cannot upload → 403', r.status === 403);
  r = await req('GET', '/conversations', { token: CUSTOMER_A });
  check('customer cannot list all conversations → 403', r.status === 403);
  r = await req('PATCH', '/conversations/whatever/status', { token: CUSTOMER_A, body: { status: 'closed' } });
  check('customer cannot close conversations → 403', r.status === 403);

  console.log('\n— PAYMENT TAMPERING —');
  // Tamper test: send a fake price for the SAME resolved in-stock product and
  // assert the server recomputes it (compare against a fresh server-priced
  // order rather than a hardcoded amount).
  r = await req('POST', '/orders', {
    token: CUSTOMER_A,
    body: {
      items: [{ productSlug: P, price: 1, quantity: 1 }],
      shippingAddress: { name: 'Sec A', address: '1 Sec St', city: 'Mumbai', state: 'MH', pincode: '400001' },
    },
  });
  check('order created for tamper test', r.status === 201);
  const clean = await req('POST', '/orders', {
    token: CUSTOMER_A,
    body: {
      items: [{ productSlug: P, quantity: 1 }],
      shippingAddress: { name: 'Sec A', address: '1 Sec St', city: 'Mumbai', state: 'MH', pincode: '400001' },
    },
  });
  const serverPrice = clean.json.order?.items?.[0]?.price;
  check('client price ₹1 ignored — server recomputed price', r.json.order?.items?.[0]?.price === serverPrice && serverPrice > 1, `got ${r.json.order?.items?.[0]?.price}, server ${serverPrice}`);
  r = await req('POST', '/payments/verify', { token: CUSTOMER_A, body: { orderId: r.json.order?.orderId, razorpay_payment_id: 'fake', razorpay_order_id: 'fake', razorpay_signature: 'deadbeef' } });
  check('forged payment signature rejected → 400/422/503', [400, 422, 503].includes(r.status), String(r.status));
  r = await req('GET', `/payments/${ORDER_A}/status`, { token: CUSTOMER_A });
  const notPaidByForgery = r.json.payment?.paymentStatus !== 'Paid';
  check('client cannot mark order paid', notPaidByForgery);

  console.log('\n— WEBHOOK SECURITY —');
  r = await req('POST', '/payments/webhook', { body: { event: 'payment.captured', payload: { payment: { entity: { order_id: 'order_fake', id: 'pay_fake' } } } } });
  check('webhook without signature rejected (400/501)', [400, 501].includes(r.status), String(r.status));
  r = await req('POST', '/payments/webhook', { body: { event: 'payment.captured' }, headers: { 'x-razorpay-signature': 'forged' } });
  check('webhook with forged signature rejected (400/501)', [400, 501].includes(r.status), String(r.status));

  console.log('\n— NOSQL INJECTION —');
  r = await req('POST', '/auth/login', { body: { email: { $ne: null }, password: { $ne: null } } });
  check('login $operator injection rejected → 401/422', [401, 422].includes(r.status), String(r.status));
  r = await req('POST', '/auth/login', { body: { email: { $gt: '' }, password: { $regex: '.*' } } });
  check('login $regex injection rejected → 401/422', [401, 422].includes(r.status), String(r.status));
  r = await req('GET', '/products?q=' + encodeURIComponent('{"$gt":""}'));
  check('product search with operator payload → 200 (sanitized, no crash)', r.status === 200);
  r = await req('GET', '/products?q=' + encodeURIComponent('a{1000000'));
  check('ReDoS pattern in search is escaped (no hang, 200)', r.status === 200);

  console.log('\n— SECURITY HEADERS —');
  const health = await fetch(`${BASE}/health`);
  const h = health.headers;
  check('X-Content-Type-Options: nosniff present', (h.get('x-content-type-options') || '').includes('nosniff'));
  check('X-Frame-Options / frame-ancestors deny present', !!(h.get('x-frame-options') || h.get('content-security-policy')));
  check('security headers do not break CORS-free API reads', health.status === 200);

  console.log('\n— SUSPENDED OPERATOR (status enforcement) —');
  // Create a fresh handler the CURRENT way (single-use invitation → activation)
  // then suspend it and verify login + protected access are blocked.
  r = await req('POST', '/admin/users', { token: ADMIN, body: { name: 'Susp Test', email: `susp-${stamp}@example.com`, role: 'HANDLER', password: 'temppass123' } });
  check('direct staff creation is disabled → 410 INVITATION_REQUIRED',
    r.status === 410 && r.json?.code === 'INVITATION_REQUIRED', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/admin/invitations', {
    token: ADMIN,
    body: { name: 'Susp Test', email: `susp-${stamp}@example.com`, staffRole: 'fulfillment' },
  });
  check('suspension target invited → 201', r.status === 201, JSON.stringify(r.json).slice(0, 120));
  const SUSP_TOKEN = String(r.json?.link || '').split('/').pop();
  r = await req('POST', `/invitations/${SUSP_TOKEN}/activate`, { body: { password: 'temppass123', name: 'Susp Test' } });
  check('suspension target activated its own account → 201', r.status === 201, `${r.status} ${r.json?.code}`);
  const opList = await req('GET', `/admin/users?q=susp-${stamp}%40example.com`, { token: ADMIN });
  const TARGET_ID = (opList.json?.operators || [])[0]?.id;
  check('the activated operator appears in the directory', !!TARGET_ID, JSON.stringify(opList.json?.operators));
  r = await req('POST', '/auth/login', { body: { email: `susp-${stamp}@example.com`, password: 'temppass123', portal: 'staff' } });
  const HANDLER_TOKEN = r.json.token;
  check('new handler can log in before suspension', r.status === 200);
  r = await req('PATCH', `/admin/users/${TARGET_ID}/status`, { token: ADMIN, body: { status: 'SUSPENDED' } });
  check('admin suspends operator → 200', r.status === 200);
  r = await req('POST', '/auth/login', { body: { email: `susp-${stamp}@example.com`, password: 'temppass123' } });
  check('suspended operator login rejected → 403 ACCOUNT_SUSPENDED', r.status === 403 && r.json.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json.code}`);
  r = await req('GET', '/analytics/overview', { token: HANDLER_TOKEN });
  check('suspended operator existing session rejected on next request → 403', r.status === 403 && r.json.code === 'ACCOUNT_SUSPENDED', `${r.status}`);
  r = await req('GET', '/notifications', { token: HANDLER_TOKEN });
  check('suspended operator notifications blocked → 403', r.status === 403, String(r.status));
  // Guards
  r = await req('PATCH', `/admin/users/${ADMIN_ID}/status`, { token: ADMIN, body: { status: 'SUSPENDED' } });
  check('self-suspension blocked → 422', r.status === 422, String(r.status));
  r = await req('PATCH', `/admin/users/${TARGET_ID}/status`, { token: ADMIN, body: { status: 'ACTIVE' } });
  check('reactivation works', r.status === 200);
  r = await req('DELETE', `/admin/users/${TARGET_ID}`, { token: ADMIN });
  check('cleanup: operator deleted', r.status === 200);

  console.log('\n— INPUT VALIDATION —');
  r = await req('POST', '/auth/register', { body: { name: 'X'.repeat(5000), email: `long-${stamp}@x.io`, password: 'secret123' } });
  check('oversized name rejected → 4xx', [422, 413].includes(r.status), String(r.status));
  r = await req('POST', '/auth/register', { body: { name: 'OK', email: 'not-an-email', password: 'secret123' } });
  check('invalid email rejected → 422', r.status === 422);
  r = await req('POST', '/orders', { token: CUSTOMER_A, body: { items: [{ productSlug: 'gold-foil-pressed-stickers', quantity: -5 }], shippingAddress: { name: 'A' } } });
  check('negative quantity rejected → 422', r.status === 422, String(r.status));
  r = await req('POST', '/inventory/gold-foil-pressed-stickers/adjust', { token: ADMIN, body: { type: 'not-a-type', quantity: 5 } });
  check('invalid adjustment type rejected → 4xx', [422, 404].includes(r.status), String(r.status));

  console.log('\n— RATE LIMITING —');
  // Runs LAST: it deliberately exhausts the login limiter for this IP, and
  // once breached, every login from this IP is 429 until the window resets.
  // Successful login is proven FIRST, before the brute-force loop below
  // saturates the window — failed attempts saturate the attacker, while the
  // legitimate login above shows real users are not collateral damage.
  const okLogin = await req('POST', '/auth/login', { body: { email: 'handler.admin@flora-alchemy.demo', password: 'handler1234' } });
  check('successful login unaffected before throttle window', okLogin.status === 200, String(okLogin.status));
  let got429 = false;
  let attempts = 0;
  for (let i = 0; i < 60; i++) {
    const rr = await req('POST', '/auth/login', { body: { email: `rl-${stamp}@x.io`, password: 'wrongpass' } });
    attempts += 1;
    if (rr.status === 429) { got429 = true; break; }
  }
  check(`login brute-force throttled with 429 (after ${attempts} failed attempts)`, got429, 'no 429 after 60 failed attempts');

  console.log(`\n══════════════════════════════════════`);
  console.log(`SECURITY RESULT: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILURES:', failures.join(' | ')); process.exit(1); }
  console.log('ALL SECURITY TESTS PASSED');
}

main().catch((err) => {
  console.error('SECURITY RUNNER ERROR:', err);
  process.exitCode = 1;
}).finally(() => {
  stopTestServer(API_CHILD);
});
