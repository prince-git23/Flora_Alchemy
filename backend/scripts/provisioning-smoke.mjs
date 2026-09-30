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
import bcrypt from 'bcryptjs';
import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Invitation from '../models/Invitation.js';

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
await Invitation.init();
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

  console.log('\n— ADMIN ONBOARDS STAFF BY INVITATION —');
  const handlerEmail = `new-handler-${stamp}@example.com`;
  // The legacy direct-creation contract is gone for BOTH roles: staff (and
  // administrators) are invited, and the invited person activates the account
  // with their own password (utils/permissions.js + invitationController).
  r = await req('POST', '/admin/users', { token: OWNER, body: { name: 'New Handler', email: handlerEmail, role: 'HANDLER', password: 'handler-pass-123' } });
  check('direct handler creation → 410 INVITATION_REQUIRED',
    r.status === 410 && r.json?.code === 'INVITATION_REQUIRED', `${r.status} ${r.json?.code}`);
  check('the refusal carries no credential FIELDS',
    !('password' in (r.json || {})) && !('passwordHash' in (r.json || {})) && !('tempPassword' in (r.json || {})),
    JSON.stringify(Object.keys(r.json || {})));
  r = await req('POST', '/admin/users', { token: OWNER, body: { name: 'Second Admin', email: `new-admin-${stamp}@example.com`, role: 'admin', password: 'admin-pass-1234' } });
  check('direct administrator creation → 410 (owner approval + invitation instead)', r.status === 410, String(r.status));

  r = await req('POST', '/admin/invitations', { token: OWNER, body: { name: 'New Handler', email: handlerEmail, staffRole: 'fulfillment' } });
  check('owner issues a handler invitation → 201', r.status === 201, JSON.stringify(r.json).slice(0, 150));
  const INVITE_TOKEN = String(r.json?.link || '').split('/').pop();
  check('invitation link carries a one-time 256-bit token', /^[a-f0-9]{64}$/.test(INVITE_TOKEN), INVITE_TOKEN);
  r = await req('POST', `/invitations/${INVITE_TOKEN}/activate`, { body: { password: 'handler-pass-123', name: 'New Handler' } });
  check('activation creates the staff account → 201', r.status === 201, `${r.status} ${r.json?.code}`);
  check('the activation bundle is the invited role template',
    r.json?.account?.role === 'handler', JSON.stringify(r.json?.account?.role));
  // The suite reads the invitation-derived account directly (its own short
  // connection; the server has its own) so the stored bundle can be inspected.
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
  const HANDLER_ROW = await User.findOne({ email: handlerEmail });
  const HANDLER_ID = HANDLER_ROW?._id?.toString();
  check('the activated account exists with the invited permissions',
    !!HANDLER_ID && Array.isArray(HANDLER_ROW.permissions) && HANDLER_ROW.permissions.includes('orders.view'),
    JSON.stringify(HANDLER_ROW?.permissions));
  check('the activated account inherited the workspace-scoped role template',
    HANDLER_ROW?.staffRole === 'fulfillment', String(HANDLER_ROW?.staffRole));
  await mongoose.disconnect();

  r = await req('POST', '/admin/invitations', { token: OWNER, body: { name: 'Dup', email: handlerEmail, staffRole: 'inventory' } });
  check('inviting an existing staff email → 409 EMAIL_TAKEN', r.status === 409 && r.json?.code === 'EMAIL_TAKEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/admin/invitations', { token: OWNER, body: { email: `bad-${stamp}@x.io`, staffRole: 'no-such-template' } });
  check('unknown access template rejected → 422', r.status === 422, String(r.status));
  r = await req('POST', '/admin/invitations', { token: OWNER, body: { email: `bad2-${stamp}@x.io`, permissions: ['owner.everything'] } });
  check('unknown permission id rejected → 422 (never silently dropped)', r.status === 422, String(r.status));
  r = await req('POST', '/admin/invitations', { token: OWNER, body: { email: 'not-an-email', staffRole: 'inventory' } });
  check('invalid work email rejected → 422', r.status === 422, String(r.status));

  // A second ADMINISTRATOR is created the way the architecture requires.
  // (The suite needs one to exercise the last-admin invariant; the real path is
  // owner approval of an application + activation, covered by
  // application-flow-smoke and admin-onboarding-smoke.)
  const adminEmail2 = `new-admin-${stamp}@example.com`;
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
  await User.create({
    email: adminEmail2,
    passwordHash: await bcrypt.hash('admin-pass-1234', 12),
    role: 'admin',
    name: 'Second Admin',
    isFixture: false,
  });
  check('second administrator provisioned directly in the DB for the lifecycle checks',
    !!(await User.findOne({ email: adminEmail2 })), 'account missing');
  await mongoose.disconnect();

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
  r = await req('POST', '/admin/invitations', { token: HANDLER, body: { name: 'X Two', email: `h-invite-${stamp}@x.io`, staffRole: 'inventory' } });
  check('handler cannot invite staff → 403', r.status === 403, String(r.status));

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

  console.log('\n— F4: /admin/users OWNER MATRIX (mirrors staffController) —');
  // The legacy operator surface must enforce the same matrix as /admin/staff:
  // a non-owner admin can never act on administrator/owner accounts.
  r = await req('PATCH', `/admin/users/${OWNER_ID}/status`, { token: ADMIN2, body: { status: 'SUSPENDED' } });
  check('non-owner admin cannot suspend the owner → 403 OWNER_REQUIRED', r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/admin/users/${OWNER_ID}/role`, { token: ADMIN2, body: { role: 'handler' } });
  check('non-owner admin cannot demote the owner → 403 OWNER_REQUIRED', r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);
  r = await req('DELETE', `/admin/users/${OWNER_ID}`, { token: ADMIN2 });
  check('non-owner admin cannot delete the owner → 403 OWNER_REQUIRED', r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);
  r = await req('GET', '/auth/me', { token: OWNER });
  check('owner account is intact after all three attempts → 200 admin', r.status === 200 && r.json?.user?.role === 'admin', `${r.status} ${r.json?.user?.role}`);

  // Mint guards — every route that could create an administrator.
  // GRANULAR STAFF ONBOARDING: the direct-creation contract is GONE for every
  // caller (member accounts are invited, administrators come from owner
  // approval of an application), so the guard is an unconditional refusal.
  r = await req('POST', '/admin/users', { token: ADMIN2, body: { name: 'Mint Admin', email: `mint-${stamp}@x.io`, role: 'admin', password: 'handler-pass-123' } });
  check('direct administrator creation is refused for a non-owner admin → 410',
    r.status === 410 && r.json?.code === 'INVITATION_REQUIRED', `${r.status} ${r.json?.code}`);
  // …and the handler-invitation endpoint cannot be used to mint one either:
  // it pins the role to `handler` and rejects any other role outright.
  r = await req('POST', '/admin/invitations', { token: ADMIN2, body: { name: 'Mint Admin', email: `mint2-${stamp}@x.io`, role: 'admin', staffRole: 'full_workspace' } });
  check('the invitation endpoint refuses to mint an administrator → 422', r.status === 422, `${r.status} ${r.json?.code}`);
  // A non-owner admin MAY invite an operational handler (intended split).
  r = await req('POST', '/admin/invitations', { token: ADMIN2, body: { name: 'Floor Handler', email: `floor-${stamp}@x.io`, staffRole: 'inventory' } });
  check('a non-owner admin can still invite a handler → 201', r.status === 201, `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/admin/users/${HANDLER_ID}/role`, { token: ADMIN2, body: { role: 'admin' } });
  check('non-owner admin cannot promote a handler → 403 OWNER_REQUIRED', r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);

  // The handler lane stays open to ANY admin (the matrix's allowed side).
  r = await req('PATCH', `/admin/users/${HANDLER_ID}/status`, { token: ADMIN2, body: { status: 'SUSPENDED' } });
  check('non-owner admin may suspend a handler → 200', r.status === 200, String(r.status));
  r = await req('PATCH', `/admin/users/${HANDLER_ID}/status`, { token: ADMIN2, body: { status: 'ACTIVE' } });
  check('non-owner admin may reactivate a handler → 200', r.status === 200, String(r.status));

  // Settings writes are admin-level (handlers are out).
  r = await req('PATCH', '/settings', { token: HANDLER, body: { storeName: 'Hacked By Handler' } });
  check('handler cannot write store settings → 403', r.status === 403, `${r.status} ${r.json?.code}`);
  r = await req('PATCH', '/settings', { token: ADMIN2, body: { storeName: 'Flora Alchemy (provision)' } });
  check('administrator may write store settings → 200', r.status === 200, String(r.status));
  r = await req('PATCH', '/settings', { token: OWNER, body: { storeName: 'Flora Alchemy' } });
  check('owner may write store settings → 200', r.status === 200, String(r.status));

  // Unauthorized deletes on the operator surface.
  r = await req('DELETE', `/admin/users/${ADMIN2_ID}`);
  check('anonymous delete operator → 401', r.status === 401, String(r.status));
  r = await req('DELETE', `/admin/users/${ADMIN2_ID}`, { token: CUSTOMER });
  check('customer delete operator → 403', r.status === 403, String(r.status));
  r = await req('DELETE', `/admin/users/${ADMIN2_ID}`, { token: HANDLER });
  check('handler delete operator → 403', r.status === 403, String(r.status));

  // Positive owner paths (the matrix grants, not disables).
  r = await req('PATCH', `/admin/users/${HANDLER_ID}/role`, { token: OWNER, body: { role: 'admin' } });
  check('the owner may promote a handler to admin → 200', r.status === 200 && r.json?.operator?.role === 'ADMINISTRATOR', `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  r = await req('PATCH', `/admin/users/${HANDLER_ID}/role`, { token: OWNER, body: { role: 'handler' } });
  check('the owner may demote back to handler → 200', r.status === 200 && r.json?.operator?.role === 'HANDLER', `${r.status}`);
  r = await req('DELETE', `/admin/users/${HANDLER_ID}`, { token: ADMIN2 });
  check('non-owner admin may delete a handler → 200', r.status === 200, String(r.status));

  // Last-admin delete guard — same staging as the demote guard above:
  // with admin2 suspended the owner is the ONLY active administrator, so
  // removing any admin account must be refused (docs/API.md promise).
  r = await req('PATCH', `/admin/users/${ADMIN2_ID}/status`, { token: OWNER, body: { status: 'SUSPENDED' } });
  check('stage sole-active-admin state → 200', r.status === 200, String(r.status));
  r = await req('DELETE', `/admin/users/${ADMIN2_ID}`, { token: OWNER });
  check('last active administrator cannot be deleted → 422', r.status === 422, `${r.status} ${r.json?.code}`);
  r = await req('GET', '/admin/users', { token: OWNER });
  check('the refused delete left the account intact (HTTP invariant)', r.status === 200 && (r.json?.operators || []).some((o) => o.id === ADMIN2_ID), JSON.stringify((r.json?.operators || []).map((o) => o.id)));
  r = await req('PATCH', `/admin/users/${ADMIN2_ID}/status`, { token: OWNER, body: { status: 'ACTIVE' } });
  check('admin2 reactivated for cleanup → 200', r.status === 200, String(r.status));

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
