/**
 * Phase 21.1 / 21.2 — MULTI-PORTAL AUTHENTICATION suite.
 *
 * Proves, against an isolated disposable database, that:
 *
 *   · the three staff portals (owner / admin / staff) each authenticate only
 *     the identity that legitimately belongs to them — a URL can never grant
 *     a role, and every decision is server-derived (never from the JWT, never
 *     from a client-supplied role/isOwner field)
 *   · a plain administrator cannot enter the Owner Portal; a handler cannot
 *     enter the Owner or Administrator portal; a customer cannot enter any
 *     staff portal; an owner may administer but is refused the Staff Portal
 *   · suspended accounts (admin AND owner) cannot sign in, and a token issued
 *     before suspension is refused on the very next request
 *   · the owner-only API (executive overview + administrators directory) is
 *     refused to administrators, handlers and anonymous callers, and returns
 *     real counts to the owner
 *   · `npm run provision-admin` creates exactly ONE real owner, never creates
 *     demo/elevated users, never prints or stores the plaintext password, and
 *     refuses a second owner and a production database without confirmations
 *
 * Isolation: server on port 4101, DB Flora-Alchemy-Test-Portal, SEED_ON_START
 * = false so the suite controls every account it asserts on. The provisioning
 * checks run in their OWN database (…-Portal-Provision). Cleanup drops both.
 *
 * Run: node scripts/portal-auth-smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv, BACKEND_DIR } from './lib/testServer.mjs';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Invitation from '../models/Invitation.js';
import AdminApplication from '../models/AdminApplication.js';
import StaffEvent from '../models/StaffEvent.js';

const DB_NAME = 'Flora-Alchemy-Test-Portal';
const PROVISION_DB = 'Flora-Alchemy-Test-Portal-Provision';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);
const PROVISION_URI = testMongoUri(process.env.MONGO_URI, PROVISION_DB);

await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  User.init(),
  Customer.init(),
  Invitation.init(),
  AdminApplication.init(),
  StaffEvent.init(),
]);

const stamp = Date.now();
const ownerPassword = `Owner-Pass-${stamp}!`;
const adminPassword = `Admin-Pass-${stamp}!`;
const handlerPassword = `Handler-Pass-${stamp}!`;
const customerPassword = `Customer-Pass-${stamp}!`;

async function makeUser(role, extra = {}) {
  return User.create({
    email: `${role}-${stamp}${extra.suffix || ''}@portal.test`,
    passwordHash: await bcrypt.hash(extra.password || adminPassword, 12),
    role,
    name: extra.name || `Portal ${role}`,
    isFixture: false,
    isOwner: !!extra.isOwner,
    status: extra.status || 'ACTIVE',
  });
}

const owner = await makeUser('admin', { suffix: '-own', isOwner: true, name: 'Portal Owner', password: ownerPassword });
const admin = await makeUser('admin', { name: 'Portal Admin' });
const handler = await makeUser('handler', { name: 'Portal Handler', password: handlerPassword });
const suspendedAdmin = await makeUser('admin', { suffix: '-sus', name: 'Suspended Admin', status: 'SUSPENDED' });
const suspendedOwner = await makeUser('admin', { suffix: '-suso', name: 'Suspended Owner', isOwner: true, status: 'SUSPENDED', password: ownerPassword });

const { child: SERVER, base } = await bootTestServer({
  port: 4101,
  db: DB_NAME,
  // This suite deliberately makes many REFUSED sign-ins (every cross-portal
  // denial is a real failed login). The default dev login cap would throttle
  // the late assertions, so give the isolated server headroom — the ceiling is
  // still exercised by the dedicated security suite.
  extraEnv: {
    SEED_ON_START: 'false',
    RATE_LIMIT_LOGIN_FAILED_MAX: '5000',
    RATE_LIMIT_API_WRITE_MAX: '5000',
  },
  label: 'portal-auth-smoke',
});
const BASE = `${base}/api`;

await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });

let passed = 0;
let failed = 0;
const failures = [];

async function req(method, path_, { token, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
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

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

/** Run a child node script and capture exit code + combined output. */
function runScript(scriptPath, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: BACKEND_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

async function main() {
  console.log('\n— OWNER PORTAL LOGIN —');
  let r = await req('POST', '/auth/login', { body: { email: owner.email, password: ownerPassword, portal: 'owner' } });
  check('owner signs in to the Owner Portal → 200', r.status === 200, `${r.status} ${r.json?.message}`);
  check('server-derived owner state', r.json?.user?.role === 'admin' && r.json?.user?.isOwner === true && r.json?.user?.portal === 'owner', JSON.stringify(r.json?.user));
  check('owner session carries OWN- staff id', String(r.json?.user?.staffId || '').startsWith('OWN-'), r.json?.user?.staffId);
  check('server returns the owner landing route', r.json?.redirectTo === '/owner/dashboard', r.json?.redirectTo);
  check('owner may also administer (admin portal) → 200', (await req('POST', '/auth/login', { body: { email: owner.email, password: ownerPassword, portal: 'admin' } })).status === 200);

  console.log('\n— CROSS-PORTAL REFUSALS —');
  r = await req('POST', '/auth/login', { body: { email: admin.email, password: adminPassword, portal: 'owner' } });
  check('plain administrator → Owner Portal refused 403 PORTAL_FORBIDDEN', r.status === 403 && r.json?.code === 'PORTAL_FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: handler.email, password: handlerPassword, portal: 'owner' } });
  check('handler → Owner Portal refused 403', r.status === 403 && r.json?.code === 'PORTAL_FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: handler.email, password: handlerPassword, portal: 'admin' } });
  check('handler → Administrator Portal refused 403', r.status === 403 && r.json?.code === 'PORTAL_FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: owner.email, password: ownerPassword, portal: 'staff' } });
  check('owner → Staff Portal refused 403 (explicit policy)', r.status === 403 && r.json?.code === 'PORTAL_FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: admin.email, password: adminPassword, portal: 'staff' } });
  check('administrator → Staff Portal refused 403', r.status === 403 && r.json?.code === 'PORTAL_FORBIDDEN', `${r.status} ${r.json?.code}`);

  console.log('\n— ADMINISTRATOR & STAFF PORTALS —');
  r = await req('POST', '/auth/login', { body: { email: admin.email, password: adminPassword, portal: 'admin' } });
  check('administrator signs in to the Administrator Portal → 200', r.status === 200 && r.json?.user?.portal === 'admin' && r.json?.user?.isOwner === false, `${r.status} ${r.json?.user?.portal}`);
  check('administrator lands on /admin/dashboard', r.json?.redirectTo === '/admin/dashboard', r.json?.redirectTo);
  const ADMIN_TOKEN = r.json?.token;
  r = await req('POST', '/auth/login', { body: { email: handler.email, password: handlerPassword, portal: 'staff' } });
  check('handler signs in to the Staff Portal → 200', r.status === 200 && r.json?.user?.portal === 'staff', `${r.status} ${r.json?.user?.portal}`);
  check('handler lands on /staff/dashboard', r.json?.redirectTo === '/staff/dashboard', r.json?.redirectTo);
  check('handler session carries HND- staff id', String(r.json?.user?.staffId || '').startsWith('HND-'), r.json?.user?.staffId);
  const HANDLER_TOKEN = r.json?.token;

  console.log('\n— CUSTOMER ISOLATION —');
  const reg = await req('POST', '/auth/register', { body: { name: 'Portal Customer', email: `cust-${stamp}@portal.test`, password: customerPassword } });
  check('public registration still creates a customer', reg.status === 201 && reg.json?.user?.role === 'customer', `${reg.status}`);
  const CUSTOMER_TOKEN = reg.json?.token;
  for (const portal of ['owner', 'admin', 'staff']) {
    r = await req('POST', '/auth/login', { body: { email: `cust-${stamp}@portal.test`, password: customerPassword, portal } });
    check(`customer → ${portal} portal refused 403`, r.status === 403 && r.json?.code === 'PORTAL_FORBIDDEN', `${r.status} ${r.json?.code}`);
  }
  r = await req('POST', '/auth/login', { body: { email: `cust-${stamp}@portal.test`, password: customerPassword } });
  check('customer login without a portal still works (storefront)', r.status === 200 && r.json?.user?.role === 'customer', `${r.status}`);

  console.log('\n— SUSPENSION —');
  r = await req('POST', '/auth/login', { body: { email: suspendedAdmin.email, password: adminPassword, portal: 'admin' } });
  check('suspended administrator cannot sign in → 403 ACCOUNT_SUSPENDED', r.status === 403 && r.json?.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: suspendedOwner.email, password: ownerPassword, portal: 'owner' } });
  check('suspended owner cannot sign in → 403 ACCOUNT_SUSPENDED', r.status === 403 && r.json?.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json?.code}`);
  // Token issued BEFORE suspension is refused on the next protected request.
  const preSuspend = await req('POST', '/auth/login', { body: { email: admin.email, password: adminPassword, portal: 'admin' } });
  const ADMIN_TOKEN2 = preSuspend.json?.token;
  check('fresh administrator token works on /auth/me', (await req('GET', '/auth/me', { token: ADMIN_TOKEN2 })).status === 200);
  await User.updateOne({ _id: admin._id }, { $set: { status: 'SUSPENDED' } });
  r = await req('GET', '/auth/me', { token: ADMIN_TOKEN2 });
  check('token issued before suspension is rejected next request → 403', r.status === 403 && r.json?.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json?.code}`);
  await User.updateOne({ _id: admin._id }, { $set: { status: 'ACTIVE' } });

  console.log('\n— CLIENT CANNOT ELEVATE ITSELF —');
  r = await req('POST', '/auth/login', { body: { email: handler.email, password: handlerPassword, role: 'admin', isOwner: true, portal: 'owner' } });
  check('handler claiming owner+portal is still refused 403', r.status === 403, `${r.status}`);
  r = await req('POST', '/auth/login', { body: { email: admin.email, password: adminPassword, role: 'admin', isOwner: true, portal: 'owner' } });
  check('administrator claiming isOwner:true is still refused the Owner Portal', r.status === 403, `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: admin.email, password: adminPassword, portal: 'admin' } });
  check('login response ignores client isOwner (stays false)', r.json?.user?.isOwner === false, String(r.json?.user?.isOwner));
  const ADMIN_OK = r.json?.token;

  console.log('\n— OWNER-ONLY API —');
  r = await req('GET', '/owner/overview');
  check('anonymous owner API → 401', r.status === 401, String(r.status));
  r = await req('GET', '/owner/overview', { token: CUSTOMER_TOKEN });
  check('customer owner API → 403', r.status === 403, String(r.status));
  r = await req('GET', '/owner/overview', { token: HANDLER_TOKEN });
  check('handler owner API → 403', r.status === 403, String(r.status));
  r = await req('GET', '/owner/overview', { token: ADMIN_OK });
  check('non-owner administrator owner API → 403 (requireOwner)', r.status === 403, String(r.status));
  r = await req('GET', '/owner/administrators', { token: ADMIN_OK });
  check('non-owner administrator administrators directory → 403', r.status === 403, String(r.status));

  const ownerLogin = await req('POST', '/auth/login', { body: { email: owner.email, password: ownerPassword, portal: 'owner' } });
  const OWNER_TOKEN = ownerLogin.json?.token;
  r = await req('GET', '/owner/overview', { token: OWNER_TOKEN });
  check('owner overview → 200 with real KPI bundle', r.status === 200 && r.json?.overview?.administrators && r.json?.overview?.handlers, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  check('overview counts real administrators (owner + admin)', r.json?.overview?.administrators?.total >= 2, JSON.stringify(r.json?.overview?.administrators));
  check('overview reports pending invitations as a number', typeof r.json?.overview?.pendingInvitations === 'number');
  check('overview activity is an array (real audit trail)', Array.isArray(r.json?.activity));

  r = await req('GET', '/owner/administrators', { token: OWNER_TOKEN });
  const dir = r.json?.administrators || [];
  check('owner administrators directory → 200', r.status === 200 && Array.isArray(dir), String(r.status));
  check('directory lists the owner account flagged isOwner', dir.some((a) => a.isOwner === true), JSON.stringify(dir.slice(0, 3)));
  check('directory counts owners', r.json?.counts?.owners >= 1, JSON.stringify(r.json?.counts));
  check('directory never exposes passwordHash', !JSON.stringify(r.json || {}).includes('passwordHash'));
  check('directory search filters by email', (await req('GET', `/owner/administrators?q=${encodeURIComponent(admin.email)}`, { token: OWNER_TOKEN })).json?.administrators?.length === 1);

  console.log('\n— PROVISIONING: exactly one real owner —');
  const provisionScript = path.join(BACKEND_DIR, 'scripts', 'provision-admin.mjs');
  const src = fs.readFileSync(provisionScript, 'utf8');
  check('provision script never hardcodes a hashed literal', !/bcrypt\.hash\s*\(\s*['"]/.test(src));
  check('provision script reads the password from the environment', src.includes('process.env.PROVISION_ADMIN_PASSWORD') && src.includes('process.env.OWNER_PASSWORD'));
  const provisionPassword = `Provision-Owner-${stamp}!`;
  const provisionEmail = `provisioned-owner-${stamp}@portal.test`;

  const firstRun = await runScript(provisionScript, {
    MONGO_URI: PROVISION_URI,
    NODE_ENV: 'development',
    PROVISION_ADMIN_EMAIL: provisionEmail,
    PROVISION_ADMIN_PASSWORD: provisionPassword,
    PROVISION_ADMIN_NAME: 'Provisioned Owner',
  });
  check('first provision run succeeds (exit 0)', firstRun.code === 0, `code=${firstRun.code} ${firstRun.out.slice(-200)}`);
  check('provision output never prints the plaintext password', !firstRun.out.includes(provisionPassword), 'PASSWORD LEAKED IN LOGS');
  check('provision output never prints a bcrypt hash', !provisionPassword.includes('$2') && !/\$2[aby]\$/.test(firstRun.out), 'HASH LEAKED');

  const pdb = mongoose.connection.client.db(PROVISION_DB);
  const users = await pdb.collection('users').find({}).toArray();
  const admins = users.filter((u) => u.role === 'admin');
  check('exactly one account was created', users.length === 1, `count=${users.length}`);
  check('that account is the owner (role admin + isOwner + not fixture + ACTIVE)',
    admins.length === 1 && admins[0].isOwner === true && admins[0].isFixture === false && admins[0].status === 'ACTIVE',
    JSON.stringify(admins.map((a) => ({ r: a.role, o: a.isOwner, f: a.isFixture, s: a.status }))));
  check('no demo/handler/elevated users were seeded', !users.some((u) => u.role === 'handler' || u.role === 'customer'), JSON.stringify(users.map((u) => u.role)));
  check('the stored credential is a hash, never the plaintext',
    !!admins[0] && admins[0].passwordHash !== provisionPassword && /^\$2[aby]\$/.test(admins[0].passwordHash));

  const secondRun = await runScript(provisionScript, {
    MONGO_URI: PROVISION_URI,
    NODE_ENV: 'development',
    PROVISION_ADMIN_EMAIL: `second-${provisionEmail}`,
    PROVISION_ADMIN_PASSWORD: provisionPassword,
  });
  check('second provision run refuses a second owner (exit 1)', secondRun.code === 1, `code=${secondRun.code}`);
  check('refusal names the existing administrator and the one-owner rule',
    /active administrator already exists/i.test(secondRun.out) && /ONE owner/i.test(secondRun.out),
    secondRun.out.slice(-260));
  check('refusal documents the explicit recovery acknowledgement', /PROVISION_ADMIN_RECOVERY/.test(secondRun.out), secondRun.out.slice(-200));
  check('refusal never prints the plaintext password', !secondRun.out.includes(provisionPassword));
  const usersAfter = await pdb.collection('users').find({}).toArray();
  check('no second account was created', usersAfter.length === 1, `count=${usersAfter.length}`);

  console.log('\n— PROVISIONING: production guard —');
  const prodRun = await runScript(provisionScript, {
    MONGO_URI: (PROVISION_URI || '').replace(`/${PROVISION_DB}`, '/Flora-Alchemy'),
    NODE_ENV: 'development',
    PROVISION_ADMIN_EMAIL: `prod-${provisionEmail}`,
    PROVISION_ADMIN_PASSWORD: provisionPassword,
    CONFIRM_DATABASE_UNSAFE_OPERATION: '',
    PROVISION_ADMIN_CONFIRM: '',
  });
  check('non-disposable database without confirmations → refused (exit 1)', prodRun.code === 1, `code=${prodRun.code}`);
  check('refusal cites the explicit confirmation requirement', /CONFIRM_DATABASE_UNSAFE_OPERATION|not disposable/i.test(prodRun.out), prodRun.out.slice(-200));
  check('production refusal never prints the password', !prodRun.out.includes(provisionPassword));

  console.log(`\nPORTAL AUTH RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
  }
}

try {
  await main();
} finally {
  // Cleanup: drop both isolated test databases — no QA data left behind.
  try { await mongoose.connection.db.dropDatabase(); } catch { /* ignore */ }
  try { await mongoose.connection.client.db(PROVISION_DB).dropDatabase(); } catch { /* ignore */ }
  await mongoose.disconnect().catch(() => {});
  await stopTestServer(SERVER, base);
}

if (failed > 0) process.exit(1);
