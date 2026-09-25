/**
 * Phase 20.6.1 — staff/admin provisioning regression suite.
 *
 * Proves, against an EMPTY isolated database (no seeded fixtures):
 *   - public registration can never create a privileged account
 *   - the first-owner bootstrap CLI works exactly once and fails closed
 *     (wrong/missing confirmations, weak/missing password, active admin exists)
 *   - an authorized admin can create handler/admin accounts; duplicates,
 *     unknown roles and missing passwords are rejected
 *   - handlers/customers/anonymous can never touch staff management
 *   - suspension blocks login AND existing tokens; reactivation restores login
 *     without silently changing the role
 *   - self-lockout protections hold
 *
 * Isolation: own server (port 4091), own DB (Flora-Alchemy-Test-Provisioning),
 * SEED_ON_START=false so the bootstrap path runs against a truly empty DB.
 * The suite cleans up every account it created — no QA accounts left behind.
 *
 * Run: node scripts/provisioning-smoke.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';
import User from '../models/User.js';
import Customer from '../models/Customer.js';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_NAME = 'Flora-Alchemy-Test-Provisioning';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

// Deterministic empty start: drop the dedicated test DB from previous runs
// (no QA accounts left behind) and PRE-BUILD the schema indexes. On a truly
// fresh database mongoose autoIndex can otherwise race the first registration
// TRANSACTION — a catalog change mid-transaction surfaces as an intermittent
// TransientTransactionError/WriteConflict 500. With indexes already in place
// the server's own autoIndex is a no-op, so the suite is deterministic.
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await User.init();
await Customer.init();
await mongoose.disconnect();

const { child: SERVER, base } = await bootTestServer({
  port: 4091,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'provisioning-smoke',
});
const BASE = `${base}/api`;

let passed = 0;
let failed = 0;
const failures = [];

async function req(method, path_, { token, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  // One retry on network-level failure: the CLI guard checks in the middle of
  // the suite idle the keep-alive pool for ~30s, and a stale socket can reset
  // the next request. Retrying a login/test request is side-effect-safe here.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${path_}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
      let json = null;
      try { json = await res.json(); } catch { /* non-json */ }
      return { status: res.status, json };
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

/** Run the provision-admin CLI as a child process (never inherits live confirmations). */
function runProvision(extraEnv = {}) {
  const r = spawnSync(process.execPath, ['scripts/provision-admin.mjs'], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      // Blank out any confirmation vars that might linger in the shell/.env.
      CONFIRM_DATABASE_UNSAFE_OPERATION: '',
      PROVISION_ADMIN_CONFIRM: '',
      PROVISION_ADMIN_RECOVERY: '',
      ...extraEnv,
    },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function main() {
  const stamp = Date.now();
  const ownerEmail = `owner-${stamp}@provision.test`;
  const ownerPass = 'owner-bootstrap-Passw0rd!';

  console.log('\n— PUBLIC REGISTRATION CANNOT CREATE STAFF —');
  let r = await req('POST', '/auth/register', { body: { name: 'Evil Admin', email: `evil-${stamp}@x.io`, password: 'secret123', role: 'admin' } });
  check('register with role=admin rejected → 422', r.status === 422 && r.json?.code === 'PRIVILEGED_ROLE_FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/register', { body: { name: 'Evil Handler', email: `evil-h-${stamp}@x.io`, password: 'secret123', role: 'handler' } });
  check('register with role=handler rejected → 422', r.status === 422 && r.json?.code === 'PRIVILEGED_ROLE_FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/register', { body: { name: 'Plain Cust', email: `cust-${stamp}@x.io`, password: 'secret123' } });
  check('customer registration without role still works → 201', r.status === 201, String(r.status));
  const CUSTOMER = r.json?.token;
  r = await req('POST', '/auth/register', { body: { name: 'Explicit Cust', email: `cust2-${stamp}@x.io`, password: 'secret123', role: 'customer' } });
  check('register with explicit role=customer works → 201', r.status === 201, String(r.status));

  console.log('\n— BOOTSTRAP CLI FAILS CLOSED —');
  const PROD_LIKE = 'mongodb+srv://user:pass@cluster0.provisioning-test.mongodb.net/Flora-Alchemy';
  let run = runProvision({ MONGO_URI: PROD_LIKE, PROVISION_ADMIN_EMAIL: ownerEmail, PROVISION_ADMIN_PASSWORD: ownerPass });
  check('production-like DB without confirmation refused', run.code !== 0 && run.out.includes('REFUSED'), `code=${run.code}`);
  check('refusal names the confirmation variable', run.out.includes('CONFIRM_DATABASE_UNSAFE_OPERATION'), run.out.slice(0, 200));
  check('refusal does not print the password', !run.out.includes(ownerPass), 'password leaked!');
  run = runProvision({ MONGO_URI: PROD_LIKE, PROVISION_ADMIN_EMAIL: ownerEmail, PROVISION_ADMIN_PASSWORD: ownerPass, CONFIRM_DATABASE_UNSAFE_OPERATION: 'Flora-Alchemy' });
  check('db confirmation without PROVISION_ADMIN_CONFIRM refused', run.code !== 0 && run.out.includes('PROVISION_ADMIN_CONFIRM'), `code=${run.code}`);
  run = runProvision({ MONGO_URI: '', PROVISION_ADMIN_EMAIL: ownerEmail, PROVISION_ADMIN_PASSWORD: ownerPass });
  check('missing MONGO_URI refused', run.code !== 0 && run.out.includes('MONGO_URI'), `code=${run.code}`);
  run = runProvision({ MONGO_URI: TEST_URI, PROVISION_ADMIN_EMAIL: ownerEmail });
  check('non-TTY without password refused', run.code !== 0 && run.out.includes('PROVISION_ADMIN_PASSWORD'), `code=${run.code} ${run.out.slice(0, 200)}`);
  run = runProvision({ MONGO_URI: TEST_URI, PROVISION_ADMIN_EMAIL: ownerEmail, PROVISION_ADMIN_PASSWORD: 'short12' });
  check('weak password (<12 chars) refused', run.code !== 0 && run.out.includes('at least 12'), `code=${run.code}`);
  run = runProvision({ MONGO_URI: TEST_URI, PROVISION_ADMIN_EMAIL: 'not-an-email', PROVISION_ADMIN_PASSWORD: ownerPass });
  check('invalid owner email refused', run.code !== 0 && run.out.includes('PROVISION_ADMIN_EMAIL'), `code=${run.code}`);

  console.log('\n— FIRST-OWNER BOOTSTRAP (empty database) —');
  run = runProvision({ MONGO_URI: TEST_URI, PROVISION_ADMIN_EMAIL: ownerEmail, PROVISION_ADMIN_PASSWORD: ownerPass, PROVISION_ADMIN_NAME: 'Provision Owner' });
  check('bootstrap creates the first owner → exit 0', run.code === 0, `code=${run.code} ${run.out.slice(0, 300)}`);
  check('bootstrap log never contains the password', !run.out.includes(ownerPass), 'password leaked!');
  check('bootstrap reports role=admin non-fixture', run.out.includes('role=admin') && run.out.includes('isFixture=false'), run.out.slice(0, 300));
  check('bootstrap grants the owner designation (isOwner=true)', run.out.includes('isOwner=true'), run.out.slice(0, 300));

  run = runProvision({ MONGO_URI: TEST_URI, PROVISION_ADMIN_EMAIL: `second-${stamp}@provision.test`, PROVISION_ADMIN_PASSWORD: ownerPass });
  check('second bootstrap refused while an active admin exists', run.code !== 0 && run.out.includes('active administrator already exists'), `code=${run.code}`);
  check('recovery procedure documented in refusal', run.out.includes('PROVISION_ADMIN_RECOVERY'), run.out.slice(0, 200));

  console.log('\n— OWNER AUTHENTICATES VIA EXISTING LOGIN —');
  r = await req('POST', '/auth/login', { body: { email: ownerEmail, password: ownerPass } });
  const OWNER = r.json?.token;
  const OWNER_ID = r.json?.user?.id;
  check('owner login → 200 role=admin', r.status === 200 && r.json?.user?.role === 'admin', `${r.status} ${r.json?.user?.role}`);
  check('owner is not a fixture', r.json?.user?.isFixture === false);

  console.log('\n— ADMIN CREATES STAFF —');
  const handlerEmail = `new-handler-${stamp}@example.com`;
  r = await req('POST', '/admin/users', { token: OWNER, body: { name: 'New Handler', email: handlerEmail, role: 'HANDLER', password: 'handler-pass-123' } });
  check('admin creates handler → 201', r.status === 201, JSON.stringify(r.json).slice(0, 150));
  const HANDLER_ID = r.json?.operator?.id;
  check('create response contains no credential fields', r.status === 201 && !('tempPassword' in (r.json || {})) && !('password' in (r.json || {})) && !('passwordHash' in (r.json || {})), JSON.stringify(Object.keys(r.json || {})));
  const adminEmail2 = `new-admin-${stamp}@example.com`;
  r = await req('POST', '/admin/users', { token: OWNER, body: { name: 'Second Admin', email: adminEmail2, role: 'admin', password: 'admin-pass-1234' } });
  check('admin creates another admin → 201', r.status === 201, String(r.status));

  r = await req('POST', '/admin/users', { token: OWNER, body: { name: 'Dup', email: handlerEmail, role: 'HANDLER', password: 'handler-pass-123' } });
  check('duplicate staff email → 409', r.status === 409 && r.json?.code === 'DUPLICATE', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/admin/users', { token: OWNER, body: { name: 'Bad Role', email: `bad-${stamp}@x.io`, role: 'customer', password: 'handler-pass-123' } });
  check('role=customer on staff-create rejected → 422', r.status === 422, String(r.status));
  r = await req('POST', '/admin/users', { token: OWNER, body: { name: 'Bad Role2', email: `bad2-${stamp}@x.io`, role: 'superuser', password: 'handler-pass-123' } });
  check('unknown role rejected → 422', r.status === 422, String(r.status));
  r = await req('POST', '/admin/users', { token: OWNER, body: { name: 'No Pass', email: `nop-${stamp}@x.io`, role: 'HANDLER' } });
  check('missing password rejected → 422', r.status === 422 && r.json?.code === 'VALIDATION_ERROR', String(r.status));

  console.log('\n— STAFF LISTING & ACCESS MATRIX —');
  r = await req('GET', '/admin/users', { token: OWNER });
  check('admin lists operators → 200', r.status === 200 && Array.isArray(r.json?.operators));
  check('listing never contains password material', r.status === 200 && r.json.operators.every((o) => o.passwordHash === undefined && o.password === undefined && o.tempPassword === undefined));
  r = await req('GET', '/admin/users');
  check('anonymous list → 401', r.status === 401, String(r.status));
  r = await req('POST', '/admin/users', { body: { name: 'X', email: `anon-${stamp}@x.io`, role: 'HANDLER', password: 'handler-pass-123' } });
  check('anonymous create → 401', r.status === 401, String(r.status));
  r = await req('GET', '/admin/users', { token: CUSTOMER });
  check('customer list → 403', r.status === 403, String(r.status));
  r = await req('POST', '/admin/users', { token: CUSTOMER, body: { name: 'X', email: `cust-create-${stamp}@x.io`, role: 'admin', password: 'handler-pass-123' } });
  check('customer create staff → 403', r.status === 403, String(r.status));

  r = await req('POST', '/auth/login', { body: { email: handlerEmail, password: 'handler-pass-123' } });
  const HANDLER = r.json?.token;
  check('handler login → 200 role=handler', r.status === 200 && r.json?.user?.role === 'handler', `${r.status}`);
  check('handler is NOT granted admin', r.json?.user?.role !== 'admin');
  r = await req('GET', '/admin/users', { token: HANDLER });
  check('handler list operators → 403 (admin-only route)', r.status === 403, String(r.status));
  r = await req('POST', '/admin/users', { token: HANDLER, body: { name: 'X', email: `h-create-${stamp}@x.io`, role: 'admin', password: 'handler-pass-123' } });
  check('handler cannot create staff → 403', r.status === 403, String(r.status));

  console.log('\n— ROLE IS SERVER-AUTHORITATIVE —');
  r = await req('POST', '/auth/register', { body: { name: 'Forged Role', email: `forged-${stamp}@x.io`, password: 'secret123', role: 'ADMINISTRATOR' } });
  check('register role=ADMINISTRATOR rejected → 422', r.status === 422, String(r.status));
  r = await req('GET', '/auth/me', { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6ImFkbWluIn0.wrong' } });
  check('forged admin-claim token → 401', r.status === 401, String(r.status));
  r = await req('GET', '/auth/me', { token: HANDLER });
  check('me reflects DB role (handler)', r.json?.user?.role === 'handler');

  console.log('\n— SUSPENSION / REACTIVATION —');
  r = await req('POST', '/auth/login', { body: { email: adminEmail2, password: 'admin-pass-1234' } });
  const ADMIN2 = r.json?.token;
  const ADMIN2_ID = r.json?.user?.id;
  check('second admin login → 200', r.status === 200 && r.json?.user?.role === 'admin');
  r = await req('PATCH', `/admin/users/${HANDLER_ID}/status`, { token: OWNER, body: { status: 'SUSPENDED' } });
  check('admin suspends handler → 200', r.status === 200, String(r.status));
  r = await req('POST', '/auth/login', { body: { email: handlerEmail, password: 'handler-pass-123' } });
  check('suspended staff login → 403 ACCOUNT_SUSPENDED', r.status === 403 && r.json?.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json?.code}`);
  r = await req('GET', '/auth/me', { token: HANDLER });
  check('pre-suspension token rejected → 403 ACCOUNT_SUSPENDED', r.status === 403 && r.json?.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/admin/users/${HANDLER_ID}/status`, { token: OWNER, body: { status: 'ACTIVE' } });
  check('admin reactivates handler → 200', r.status === 200, String(r.status));
  r = await req('POST', '/auth/login', { body: { email: handlerEmail, password: 'handler-pass-123' } });
  check('reactivated staff login → 200', r.status === 200, String(r.status));
  check('reactivation did not change the role', r.json?.user?.role === 'handler', r.json?.user?.role);

  console.log('\n— SELF-PROTECTION (no lockout) —');
  r = await req('PATCH', `/admin/users/${OWNER_ID}/status`, { token: OWNER, body: { status: 'SUSPENDED' } });
  check('owner cannot suspend self → 422', r.status === 422, String(r.status));
  r = await req('PATCH', `/admin/users/${OWNER_ID}/role`, { token: OWNER, body: { role: 'handler' } });
  check('owner cannot demote self → 422', r.status === 422, String(r.status));
  r = await req('DELETE', `/admin/users/${OWNER_ID}`, { token: OWNER });
  check('owner cannot delete self → 422', r.status === 422, String(r.status));
  // Reachable last-admin guard path: with admin2 suspended, the owner is the
  // ONLY active administrator — any further admin removal must be refused.
  r = await req('PATCH', `/admin/users/${ADMIN2_ID}/status`, { token: OWNER, body: { status: 'SUSPENDED' } });
  check('admin2 suspends for last-admin scenario → 200', r.status === 200, String(r.status));
  r = await req('PATCH', `/admin/users/${ADMIN2_ID}/role`, { token: OWNER, body: { role: 'handler' } });
  check('demoting another admin while only one active admin remains → 422 (last-admin guard)', r.status === 422, String(r.status));
  r = await req('PATCH', `/admin/users/${ADMIN2_ID}/status`, { token: OWNER, body: { status: 'ACTIVE' } });
  check('admin2 reactivated → 200', r.status === 200, String(r.status));

  // ── Cleanup: no QA accounts left behind in the test DB ──
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
    const del = await mongoose.connection.db.collection('users').deleteMany({});
    const delC = await mongoose.connection.db.collection('customers').deleteMany({});
    console.log(`\n— cleanup: removed ${del.deletedCount} account(s) and ${delC.deletedCount} customer profile(s) from Flora-Alchemy-Test-Provisioning —`);
    await mongoose.disconnect();
  } catch (err) {
    console.log(`\n— cleanup skipped (${err.message}) —`);
  }

  console.log(`\nPROVISIONING RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

try {
  await main();
} finally {
  await stopTestServer(SERVER, base);
}
