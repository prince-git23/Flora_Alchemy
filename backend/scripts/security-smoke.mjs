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
import { isOriginAllowed, normalizeCorsOrigin, parseCorsOrigins } from '../utils/corsOrigins.js';

// The CORS allowlist under test is explicit, local and deliberately messy —
// written the way a human writes a URL (trailing slash, upper-case host, one
// outright bad entry). The server must canonicalize it, must keep matching
// EXACTLY, and must refuse everything else.
const CORS_CONFIG = 'http://localhost:3000/, https://STORE.Example.com, not-an-origin';
const ALLOWED_ORIGIN = 'http://localhost:3000';
const ALLOWED_ORIGIN_CASED = 'https://store.example.com';
const DISALLOWED_ORIGIN = 'https://not-allowlisted.example.com';

const { child: API_CHILD, base: API_BASE } = await bootTestServer({
  port: 4093,
  db: 'Flora-Alchemy-Test-Security',
  label: 'security-smoke',
  extraEnv: { CORS_ORIGIN: CORS_CONFIG, RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' },
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
  check('customer B cannot pay A order → 404 (even when payment provider unconfigured)', r.status === 404 && r.json?.code === 'ORDER_NOT_FOUND');
  r = await req('POST', '/payments/create-order', { token: CUSTOMER_B, body: { orderId: 'FA-NONEXISTENT' } });
  check('nonexistent order pay attempt → 404', r.status === 404 && r.json?.code === 'ORDER_NOT_FOUND');

  // ── The OTHER half of the ordering contract: an OWNED, non-provider order ──
  // The provider is deliberately unconfigured in this suite (keys are blanked
  // for the child server). ORDER_A was created without a method, so it carries
  // the default `Sample` — the exact prototype case the storefront turns
  // `503 PAYMENT_NOT_CONFIGURED` into. If the method check moved ahead of the
  // configuration check, this would answer 422 and strand the order, which is
  // the compatibility regression this assertion exists to prevent.
  r = await req('POST', '/payments/create-order', { token: CUSTOMER_A, body: { orderId: ORDER_A } });
  check(
    'owned Sample order + unconfigured provider → 503 PAYMENT_NOT_CONFIGURED (prototype fallback)',
    r.status === 503 && r.json?.code === 'PAYMENT_NOT_CONFIGURED',
    `${r.status} ${r.json?.code}`
  );
  check('the refusal carries no provider material', r.json?.payment === undefined, JSON.stringify(r.json).slice(0, 120));

  // COD is a SHOP POLICY, not a payment-provider question: orderService refuses
  // it unless the shop has enabled it. Enable it first so this case measures
  // the payment endpoint's precedence rather than the shop's policy.
  const settingsNow = (await req('GET', '/settings', { token: ADMIN })).json?.settings || {};
  const commerce = settingsNow.commerceConfiguration || {};
  const enableCod = await req('PATCH', '/settings', {
    token: ADMIN,
    body: {
      commerceConfiguration: {
        ...commerce,
        paymentMethods: { ...(commerce.paymentMethods || {}), cod: true },
      },
    },
  });
  check('shop can enable Cash on Delivery', enableCod.status === 200, `${enableCod.status}`);

  r = await req('POST', '/orders', {
    token: CUSTOMER_A,
    body: {
      items: [{ productSlug: P, quantity: 1 }],
      paymentMethod: 'cod',
      shippingAddress: { name: 'Sec A', address: '1 Sec St', city: 'Mumbai', state: 'MH', pincode: '400001' },
    },
  });
  const COD_ORDER = r.json?.order?.orderId;
  check('customer A COD order created', r.status === 201 && !!COD_ORDER, `${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
  r = await req('POST', '/payments/create-order', { token: CUSTOMER_A, body: { orderId: COD_ORDER } });
  check(
    'owned COD order + unconfigured provider → 503 (never converted into a charge)',
    r.status === 503 && r.json?.code === 'PAYMENT_NOT_CONFIGURED',
    `${r.status} ${r.json?.code}`
  );
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

  console.log('\n— CORS ORIGIN ALLOWLIST —');
  // Regression (pre-merge audit): the cors `origin` callback used to reject a
  // disallowed origin by handing a PLAIN Error to `next`, so the generic error
  // handler answered HTTP 500 INTERNAL_ERROR. Every cross-origin request from
  // an unlisted origin therefore read as a backend outage — including a Vercel
  // preview deployment or a local dev server pointed at the deployed API — and
  // any third party could trigger 5xx at will. A rejected origin is a client
  // error: honest 403 ORIGIN_NOT_ALLOWED, no Access-Control-Allow-Origin, and
  // the request is never processed.
  const preflightFrom = (origin) =>
    fetch(`${BASE}/products`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    });
  const readFrom = (origin) => fetch(`${BASE}/products?limit=1`, { headers: { Origin: origin } });
  const bodyOf = async (res) => { try { return await res.json(); } catch { return null; } };

  let pf = await preflightFrom(ALLOWED_ORIGIN);
  check(
    'preflight from an allowlisted origin → 204 + ACAO',
    pf.status === 204 && pf.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN,
    `${pf.status} ${pf.headers.get('access-control-allow-origin')}`
  );

  pf = await preflightFrom(DISALLOWED_ORIGIN);
  const pfBody = await bodyOf(pf);
  check(
    'preflight from a disallowed origin → 403 ORIGIN_NOT_ALLOWED (never 500)',
    pf.status === 403 && pfBody?.code === 'ORIGIN_NOT_ALLOWED',
    `${pf.status} ${pfBody?.code}`
  );
  check(
    'disallowed preflight carries no Access-Control-Allow-Origin',
    !pf.headers.get('access-control-allow-origin'),
    String(pf.headers.get('access-control-allow-origin'))
  );

  let rd = await readFrom(ALLOWED_ORIGIN);
  check(
    'GET from an allowlisted origin → 200 + ACAO',
    rd.status === 200 && rd.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN,
    `${rd.status} ${rd.headers.get('access-control-allow-origin')}`
  );

  rd = await readFrom(DISALLOWED_ORIGIN);
  const rdBody = await bodyOf(rd);
  check(
    'GET from a disallowed origin is refused → 403 (never 500)',
    rd.status === 403 && rdBody?.code === 'ORIGIN_NOT_ALLOWED',
    `${rd.status} ${rdBody?.code}`
  );

  // ── A refusal is never a 5xx through some OTHER error path ────────────
  // The rejected response is static and origin-free: it must not echo the
  // supplied origin (no reflecting), and must not carry stack/internal fields
  // that a generic error handler would only add on a genuine fault.
  const leaked = JSON.stringify(rdBody ?? {});
  check(
    'refusal body is static — never echoes the supplied origin',
    !leaked.includes(DISALLOWED_ORIGIN) && !('stack' in (rdBody ?? {})) && rdBody?.success === false,
    leaked.slice(0, 160)
  );

  // ── The refused request is never PROCESSED ────────────────────────────
  // A write from an unlisted origin must not reach a controller. Register an
  // account from a disallowed origin, then prove no such account exists.
  const blockedEmail = `blocked-origin-${stamp}@example.com`;
  const blockedWrite = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: DISALLOWED_ORIGIN },
    body: JSON.stringify({ name: 'Blocked', email: blockedEmail, password: 'secret123' }),
  });
  const blockedWriteBody = await bodyOf(blockedWrite);
  check(
    'write from a disallowed origin → 403 and no token issued',
    blockedWrite.status === 403 && !blockedWriteBody?.token,
    `${blockedWrite.status} token=${!!blockedWriteBody?.token}`
  );
  const neverCreated = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: blockedEmail, password: 'secret123' }),
  });
  check(
    'the refused write never reached the controller (account does not exist)',
    neverCreated.status === 401,
    String(neverCreated.status)
  );

  // ── Trailing-slash / upper-case config entries still match ────────────
  // CORS_ORIGIN above is written the way a human writes a URL. Browsers send a
  // canonical serialized origin, so an un-normalized entry could NEVER match
  // and would silently brick the storefront with no signal anywhere.
  const slashPrefight = await preflightFrom(ALLOWED_ORIGIN);
  check(
    'a trailing-slash config entry still matches → 204 + ACAO',
    slashPrefight.status === 204 &&
      slashPrefight.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN,
    `${slashPrefight.status} ${slashPrefight.headers.get('access-control-allow-origin')}`
  );
  const casedRead = await readFrom(ALLOWED_ORIGIN_CASED);
  check(
    'an upper-case config entry matches its canonical origin → 200 + ACAO',
    casedRead.status === 200 &&
      casedRead.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN_CASED,
    `${casedRead.status} ${casedRead.headers.get('access-control-allow-origin')}`
  );
  const wrongPort = await readFrom('http://localhost:3001');
  check('a sibling port is NOT covered by the entry → 403', wrongPort.status === 403, String(wrongPort.status));

  // ── Null origin (sandboxed iframe / data: document) ───────────────────
  const nullOrigin = await readFrom('null');
  const nullBody = await bodyOf(nullOrigin);
  check(
    'a null origin is refused → 403 with no ACAO',
    nullOrigin.status === 403 && !nullOrigin.headers.get('access-control-allow-origin'),
    `${nullOrigin.status} ${nullBody?.code}`
  );

  // ── Health / readiness (intended public behavior) ─────────────────────
  const noOrigin = await fetch(`${BASE}/products?limit=1`);
  check('non-browser client (no Origin header) still served → 200', noOrigin.status === 200, String(noOrigin.status));
  const healthNoOrigin = await fetch(`${BASE}/health`);
  check('health probe unaffected by the origin allowlist → 200', healthNoOrigin.status === 200, String(healthNoOrigin.status));
  const readinessNoOrigin = await fetch(`${BASE}/readiness`);
  check('readiness probe (no Origin) → 200', readinessNoOrigin.status === 200, String(readinessNoOrigin.status));
  const healthBlockedOrigin = await fetch(`${BASE}/health`, { headers: { Origin: DISALLOWED_ORIGIN } });
  check(
    'health from a disallowed browser origin is refused → 403 (never 500)',
    healthBlockedOrigin.status === 403,
    String(healthBlockedOrigin.status)
  );
  const healthBlockedBody = await bodyOf(healthBlockedOrigin);
  check(
    'a refused health probe is still not a server fault',
    healthBlockedBody?.code === 'ORIGIN_NOT_ALLOWED',
    String(healthBlockedBody?.code)
  );

  // ── Allowlist parsing (pure) — shapes that must never widen access ────
  const parsedMessy = parseCorsOrigins(CORS_CONFIG);
  check(
    'parsing canonicalizes messy entries and drops unusable ones',
    parsedMessy.origins.length === 2 &&
      parsedMessy.origins.includes(ALLOWED_ORIGIN) &&
      parsedMessy.origins.includes(ALLOWED_ORIGIN_CASED) &&
      parsedMessy.rejected.length === 1 &&
      parsedMessy.rejected[0] === 'not-an-origin',
    JSON.stringify(parsedMessy)
  );
  check(
    'a wildcard entry is dropped, never honoured',
    parseCorsOrigins('*').origins.length === 0 &&
      parseCorsOrigins('https://*').origins.length === 0 &&
      parseCorsOrigins('https://*.example.com').origins.length === 0,
    JSON.stringify(parseCorsOrigins('https://*.example.com'))
  );
  check(
    'a dropped wildcard never allows a matching host',
    isOriginAllowed('https://anything.example.com', parseCorsOrigins('https://*.example.com').origins) === false
  );
  check('an empty allowlist refuses every origin', isOriginAllowed('https://any.example', []) === false);
  check('a matching origin is allowed', isOriginAllowed(ALLOWED_ORIGIN, [ALLOWED_ORIGIN]) === true);
  check(
    'a subdomain of an allowed origin is NOT allowed',
    isOriginAllowed('https://evil.store.example.com', [ALLOWED_ORIGIN_CASED]) === false
  );
  check(
    'a suffix-collision origin is NOT allowed',
    isOriginAllowed('https://store.example.com.evil.net', [ALLOWED_ORIGIN_CASED]) === false
  );
  check('a non-http scheme is refused', normalizeCorsOrigin('file:///etc/passwd') === '');
  check(
    'scheme-less junk is refused',
    normalizeCorsOrigin('store.example.com') === '' && normalizeCorsOrigin('null') === ''
  );
  check(
    'http and https are distinct origins',
    isOriginAllowed('http://store.example.com', [ALLOWED_ORIGIN_CASED]) === false
  );

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

  console.log('\n— PHASE 22.5: CUSTOMER-SAFE PAYLOAD PROJECTIONS —');
  // ── MED-6 — the customer order payload is a strict WHITELIST ──────────
  r = await req('GET', `/orders/${ORDER_A}`, { token: CUSTOMER_A });
  const ord = r.json?.order;
  const ordStr = JSON.stringify(ord || {});
  check('customer order read → 200', r.status === 200 && !!ord, String(r.status));
  // Plain `paymentProvider` (a non-secret provider name like 'razorpay') is
  // deliberately customer-visible — it predates this projection and the payment
  // suites assert it. What must never leak are the provider IDENTIFIERS and
  // verification metadata listed here.
  const FORBIDDEN_ORDER_KEYS = [
    'workspaceId', 'paymentProviderOrderId', 'paymentProviderPaymentId',
    'paymentSignatureVerified', 'paymentReference', 'paymentVerifiedAt',
    'paymentFailureReason', 'isFixture',
  ];
  check(
    'order payload carries no workspace/provider/audit keys',
    !!ord && FORBIDDEN_ORDER_KEYS.every((k) => !(k in ord) && !ordStr.includes(`"${k}"`)),
    ord ? FORBIDDEN_ORDER_KEYS.filter((k) => k in ord).join(',') : 'no order'
  );
  check('order payload contains no internal _id anywhere', !/"_id"/.test(ordStr));
  check(
    'order payload keeps the customer-visible fields',
    !!ord && ord.orderId === ORDER_A && Array.isArray(ord.items) && ord.items.length >= 1
      && typeof ord.subtotal === 'number' && typeof ord.shipping === 'number'
      && typeof ord.tax === 'number' && typeof ord.total === 'number'
      && 'shop' in ord && 'paymentStatus' in ord && 'orderStatus' in ord
      && 'trackingNumber' in ord && 'statusHistory' in ord && 'shippingAddress' in ord,
    JSON.stringify(Object.keys(ord || {})).slice(0, 200)
  );
  check(
    'line items expose no inventory/audit internals',
    !!ord && Array.isArray(ord.items) && ord.items.every((i) => !('stockDeducted' in i) && !('_id' in i)),
    JSON.stringify(Object.keys(ord?.items?.[0] || {}))
  );
  check(
    'journey log entries carry no staff identity (changedBy)',
    !!ord && (ord.statusHistory || []).every((h) => !('changedBy' in h))
  );

  r = await req('GET', '/orders/mine', { token: CUSTOMER_A });
  const mineArr = r.json?.orders || [];
  const mineStr = JSON.stringify(mineArr);
  check('orders/mine → 200', r.status === 200 && Array.isArray(mineArr), String(r.status));
  check(
    'orders/mine carries no workspace/provider/audit keys',
    mineArr.length > 0
      && FORBIDDEN_ORDER_KEYS.every((k) => !mineStr.includes(`"${k}"`))
      && !/"_id"/.test(mineStr),
    mineStr.slice(0, 160)
  );
  check(
    'orders/mine still exposes the fulfilling shop',
    mineArr.some((o) => o.orderId === ORDER_A && 'shop' in o)
  );

  // ── MED-5 — conversation payloads never carry the tenant id ───────────
  r = await req('GET', `/conversations/order/${ORDER_A}`, { token: CUSTOMER_A });
  const conv = r.json?.conversation;
  check('customer opens own order conversation → 200', r.status === 200 && !!conv, `${r.status}`);
  check(
    'conversation payload carries no workspaceId',
    !!conv && !('workspaceId' in conv) && !JSON.stringify(conv).includes('workspaceId')
  );
  r = await req('GET', '/conversations/mine', { token: CUSTOMER_A });
  const convList = r.json?.conversations || [];
  check('conversation list returns the row', r.status === 200 && convList.length >= 1, `${r.status} ${convList.length}`);
  check(
    'conversation list rows carry no workspaceId',
    convList.length >= 1 && convList.every((c) => !('workspaceId' in c))
  );

  // ── MED-4 — markRead uses the customer-safe list projection ───────────
  // Feed a real customer notification: staff confirming the order emits
  // order_status_change to the ordering customer.
  r = await req('PATCH', `/orders/${ORDER_A}/status`, { token: ADMIN, body: { status: 'confirmed' } });
  check('admin confirms the order (feeds a customer notification)', r.status === 200, `${r.status}`);
  r = await req('GET', '/notifications', { token: CUSTOMER_A });
  const notifs = r.json?.notifications || [];
  check('customer received the status-change notification', r.status === 200 && notifs.length >= 1, `${r.status} n=${notifs.length}`);
  check('notification list rows carry no workspaceId', notifs.length >= 1 && notifs.every((n) => !('workspaceId' in n)));
  if (notifs.length >= 1) {
    r = await req('PATCH', `/notifications/${notifs[0]._id}/read`, { token: CUSTOMER_A });
    const n = r.json?.notification;
    check('markRead → 200', r.status === 200 && !!n, `${r.status}`);
    check(
      'markRead response is the projected shape (no workspaceId/userId/role/entity fields)',
      !!n
        && !('workspaceId' in n) && !('userId' in n) && !('role' in n)
        && !('entityId' in n) && !('entityType' in n)
        && 'type' in n && 'title' in n && 'read' in n,
      n ? Object.keys(n).join(',') : 'none'
    );
    check('markRead still returns unreadCount', typeof r.json?.unreadCount === 'number', typeof r.json?.unreadCount);
  } else {
    check('markRead projection asserted (skipped: no notification delivered)', false, 'notification missing');
  }

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
