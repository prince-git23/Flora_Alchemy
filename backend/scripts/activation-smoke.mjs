/**
 * Phase 20.6.2 — invitation activation & owner-gate regression suite.
 *
 * Proves, against an EMPTY isolated database (no seeded fixtures):
 *   - invitation lookup returns only the fields the landing page renders
 *     (never the SHA-256 tokenHash, never the raw token, never inviter data)
 *   - unknown / malformed tokens are 404s, expired → 410 (lazily persisted),
 *     revoked → 403, already-activated → 409
 *   - activation is SINGLE-USE: the INVITED → ACTIVE transition happens once,
 *     a second POST with the same token is refused
 *   - a taken email refuses activation WITHOUT burning the invitation
 *   - the role always comes from the invitation — client-supplied role/owner
 *     fields are ignored
 *   - the password is never echoed; the created account can sign in through
 *     the existing POST /api/auth/login
 *   - a linked AdminApplication moves to ACTIVATED and the inviter is notified
 *   - "Request Elevated Clearance" (POST /api/notifications/elevation-request)
 *     is staff-only and really notifies the owner account
 *
 * Isolation: own server (port 4090), own DB (Flora-Alchemy-Test-Activation),
 * SEED_ON_START=false so the suite controls every account it asserts on.
 * The suite cleans up everything it created — no QA data left behind.
 *
 * Run: node scripts/activation-smoke.mjs
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Invitation from '../models/Invitation.js';
import AdminApplication from '../models/AdminApplication.js';
import Notification from '../models/Notification.js';

const DB_NAME = 'Flora-Alchemy-Test-Activation';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

function sha256(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// ── Deterministic start: drop the dedicated test DB, pre-build indexes ──
// (pre-built indexes make the server's autoIndex a no-op, so no write can
// race a mid-transaction index build on a fresh database).
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([User.init(), Customer.init(), Invitation.init(), AdminApplication.init()]);

// ── Fixtures created directly (the invite-issuing endpoint is Phase 20.6.1) ─
const stamp = Date.now();
const ownerPassword = `Owner-Passw0rd-${stamp}!`;
const staffPassword = `Staff-Passw0rd-${stamp}!`;
const owner = await User.create({
  email: `owner-${stamp}@activation.test`,
  passwordHash: await bcrypt.hash(ownerPassword, 12),
  role: 'admin',
  name: 'Activation Owner',
  isFixture: false,
  isOwner: true,
});
// A second administrator WITHOUT the owner designation — the realistic
// requester on the Owner Access Required screen.
const staffAdmin = await User.create({
  email: `staff-${stamp}@activation.test`,
  passwordHash: await bcrypt.hash(staffPassword, 12),
  role: 'admin',
  name: 'Plain Admin',
  isFixture: false,
  isOwner: false,
});

const application = await AdminApplication.create({
  applicationId: `APP-${stamp}`,
  name: 'Priya Sharma',
  email: `applicant-${stamp}@activation.test`,
  phone: '',
  reason: 'Applying to steward the operations console for the atelier.',
  background: 'Operations background in retail and fulfilment coordination.',
  status: 'INVITED',
});

// The RAW token exists exactly once (in this suite's memory) — mirroring how
// the approve step returns it exactly once and only the hash is stored.
const rawTokenBytes = crypto.randomBytes(32).toString('hex');
const mainInvite = await Invitation.create({
  recipientEmail: application.email,
  role: 'admin',
  inviter: owner._id,
  application: application._id,
  tokenHash: sha256(rawTokenBytes),
  expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
  status: 'INVITED',
});

const expiredBytes = crypto.randomBytes(32).toString('hex');
const expiredInvite = await Invitation.create({
  recipientEmail: `expired-${stamp}@activation.test`,
  role: 'admin',
  inviter: owner._id,
  tokenHash: sha256(expiredBytes),
  expiresAt: new Date(Date.now() - 60 * 1000),
  status: 'INVITED',
});

const revokedBytes = crypto.randomBytes(32).toString('hex');
const revokedInvite = await Invitation.create({
  recipientEmail: `revoked-${stamp}@activation.test`,
  role: 'admin',
  inviter: owner._id,
  tokenHash: sha256(revokedBytes),
  expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
  status: 'REVOKED',
});

// Invitation whose email already has an account — activation must refuse it
// WITHOUT consuming the token.
const takenBytes = crypto.randomBytes(32).toString('hex');
const takenInvite = await Invitation.create({
  recipientEmail: owner.email,
  role: 'admin',
  inviter: owner._id,
  tokenHash: sha256(takenBytes),
  expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
  status: 'INVITED',
});

// A third invitation used to prove client-supplied role/owner fields are
// ignored (role authority lives in the invitation document only).
const forgedBytes = crypto.randomBytes(32).toString('hex');
const forgedInvite = await Invitation.create({
  recipientEmail: `forged-${stamp}@activation.test`,
  role: 'admin',
  inviter: owner._id,
  tokenHash: sha256(forgedBytes),
  expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
  status: 'INVITED',
});

const { child: SERVER, base } = await bootTestServer({
  port: 4090,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'activation-smoke',
});
const BASE = `${base}/api`;

// One long-lived connection for every direct-document assertion below.
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

async function main() {
  console.log('\n— INVITATION LOOKUP (public, token = credential) —');
  let r = await req('GET', `/invitations/${crypto.randomBytes(32).toString('hex')}`);
  check('unknown token → 404 INVITATION_NOT_FOUND', r.status === 404 && r.json?.code === 'INVITATION_NOT_FOUND', `${r.status} ${r.json?.code}`);
  r = await req('GET', '/invitations/not-a-real-token');
  check('malformed token → 404 (never 500)', r.status === 404, String(r.status));
  r = await req('GET', '/invitations/..%2F..%2Fetc%2Fpasswd');
  check('path-traversal token → 404 (never 500)', r.status === 404, String(r.status));

  r = await req('GET', `/invitations/${rawTokenBytes}`);
  check('valid token → 200 with landing fields', r.status === 200 && r.json?.invitation?.recipientEmail === application.email, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  check('landing shows the application name', r.json?.invitation?.applicantName === 'Priya Sharma', JSON.stringify(r.json?.invitation));
  check('landing shows role + future expiry + INVITED status',
    r.json?.invitation?.role === 'admin' &&
    new Date(r.json?.invitation?.expiresAt).getTime() > Date.now() &&
    r.json?.invitation?.status === 'INVITED');
  const lookupBody = JSON.stringify(r.json || {});
  check('lookup never exposes tokenHash', !lookupBody.includes('tokenHash'), lookupBody.slice(0, 200));
  check('lookup never echoes the raw token', !lookupBody.includes(rawTokenBytes), 'raw token leaked!');
  check('lookup never exposes inviter identity', !lookupBody.includes(String(owner._id)) && !lookupBody.includes('inviter'), lookupBody.slice(0, 200));

  console.log('\n— EXPIRED / REVOKED / ALREADY-USED STATES —');
  r = await req('GET', `/invitations/${expiredBytes}`);
  check('expired token → 410 INVITATION_EXPIRED', r.status === 410 && r.json?.code === 'INVITATION_EXPIRED', `${r.status} ${r.json?.code}`);
  check('expired response still identifies the recipient', r.json?.invitation?.recipientEmail === expiredInvite.recipientEmail);
  const expiredDoc = await Invitation.findById(expiredInvite._id).lean();
  check('expiry is lazily PERSISTED (status → EXPIRED)', expiredDoc.status === 'EXPIRED', expiredDoc.status);

  r = await req('GET', `/invitations/${revokedBytes}`);
  check('revoked token → 403 INVITATION_REVOKED', r.status === 403 && r.json?.code === 'INVITATION_REVOKED', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/invitations/${revokedBytes}/activate`, { body: { password: 'brand-new-pass-123' } });
  check('revoked token cannot be activated → 403', r.status === 403, String(r.status));

  console.log('\n— ACTIVATION VALIDATION —');
  r = await req('POST', `/invitations/${rawTokenBytes}/activate`, { body: { password: 'abc' } });
  check('weak password (<6) → 422 VALIDATION_ERROR', r.status === 422 && r.json?.code === 'VALIDATION_ERROR', `${r.status} ${r.json?.code}`);
  let inviteAfterWeak = await Invitation.findById(mainInvite._id).lean();
  check('failed validation does NOT consume the token', inviteAfterWeak.status === 'INVITED', inviteAfterWeak.status);

  r = await req('POST', '/invitations/0000000000000000000000000000000000000000000000000000000000000000/activate', { body: { password: 'brand-new-pass-123' } });
  check('activation with unknown token → 404', r.status === 404 && r.json?.code === 'INVITATION_NOT_FOUND', String(r.status));

  r = await req('POST', `/invitations/${takenBytes}/activate`, { body: { password: 'brand-new-pass-123' } });
  check('already-registered email → 409 EMAIL_TAKEN', r.status === 409 && r.json?.code === 'EMAIL_TAKEN', `${r.status} ${r.json?.code}`);
  const takenAfter = await Invitation.findById(takenInvite._id).lean();
  check('taken-email refusal does NOT burn the token', takenAfter.status === 'INVITED', takenAfter.status);

  console.log('\n— ACTIVATION (single-use, invitation = role authority) —');
  const chosenPassword = `Activated-Passw0rd-${stamp}!`;
  r = await req('POST', `/invitations/${rawTokenBytes}/activate`, {
    body: { password: chosenPassword, role: 'customer', isOwner: true, name: 'Client Supplied' },
  });
  check('valid activation → 201', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  check('response returns the login-ready account', r.json?.account?.email === application.email && r.json?.account?.role === 'admin', JSON.stringify(r.json));
  const activationBody = JSON.stringify(r.json || {});
  check('activation response never echoes the password', !activationBody.includes(chosenPassword), 'password leaked!');
  check('activation response carries no token/JWT', !activationBody.includes('eyJ'), activationBody.slice(0, 200));

  const createdUser = await User.findOne({ email: application.email }).lean();
  check('account created with the invitation role (admin)', createdUser?.role === 'admin', createdUser?.role);
  check('account is NOT auto-owner even if the client asked', createdUser?.isOwner === false, String(createdUser?.isOwner));
  check('account is a real (non-fixture) ACTIVE account', createdUser?.isFixture === false && createdUser?.status === 'ACTIVE');
  check('account name comes from the application, not the client', createdUser?.name === 'Priya Sharma', createdUser?.name);
  const consumedInvite = await Invitation.findById(mainInvite._id).lean();
  check('invitation consumed exactly once (ACTIVE + consumedAt)', consumedInvite.status === 'ACTIVE' && !!consumedInvite.consumedAt, consumedInvite.status);
  const activatedApp = await AdminApplication.findById(application._id).lean();
  check('linked application moved to ACTIVATED', activatedApp.status === 'ACTIVATED', activatedApp.status);
  const inviterNote = await Notification.findOne({ userId: owner._id, type: 'system', title: 'Invitation activated' }).lean();
  check('inviter was notified of the activation', !!inviterNote, 'no notification');

  r = await req('POST', `/invitations/${rawTokenBytes}/activate`, { body: { password: `Second-Attempt-${stamp}!` } });
  check('second activation with the same token → 409 (single-use)', r.status === 409 && r.json?.code === 'INVITATION_ALREADY_ACTIVATED', `${r.status} ${r.json?.code}`);
  r = await req('GET', `/invitations/${rawTokenBytes}`);
  check('landing after activation → 409 already-activated', r.status === 409 && r.json?.code === 'INVITATION_ALREADY_ACTIVATED', String(r.status));

  r = await req('POST', '/auth/login', { body: { email: application.email, password: chosenPassword } });
  check('activated account signs in through the existing login → 200', r.status === 200 && r.json?.user?.role === 'admin', `${r.status} ${r.json?.user?.role}`);
  check('login session exposes isOwner=false', r.json?.user?.isOwner === false);

  console.log('\n— ROLE AUTHORITY IS SERVER-SIDE —');
  r = await req('POST', `/invitations/${forgedBytes}/activate`, {
    body: { password: `Forged-Attempt-${stamp}!`, role: 'superuser', isOwner: true },
  });
  check('activation succeeds ignoring client role/owner fields → 201', r.status === 201, `${r.status}`);
  const forgedUser = await User.findOne({ email: forgedInvite.recipientEmail }).lean();
  check('created account keeps the invitation role', forgedUser?.role === 'admin', forgedUser?.role);
  check('created account is not owner', forgedUser?.isOwner === false, String(forgedUser?.isOwner));

  console.log('\n— ELEVATION REQUEST (real owner notification) —');
  r = await req('POST', '/notifications/elevation-request', { body: { path: '/admin/owner' } });
  check('anonymous elevation request → 401', r.status === 401, String(r.status));
  const customerReg = await req('POST', '/auth/register', { body: { name: 'Curious Customer', email: `cust-${stamp}@activation.test`, password: 'secret123' } });
  const CUSTOMER = customerReg.json?.token;
  r = await req('POST', '/notifications/elevation-request', { token: CUSTOMER, body: { path: '/admin/owner' } });
  check('customer elevation request → 403 (staff only)', r.status === 403, String(r.status));

  const staffLogin = await req('POST', '/auth/login', { body: { email: staffAdmin.email, password: staffPassword } });
  const STAFF = staffLogin.json?.token;
  check('non-owner admin can sign in', staffLogin.status === 200 && !!STAFF, String(staffLogin.status));
  r = await req('POST', '/notifications/elevation-request', { token: STAFF, body: { path: '/admin/owner' } });
  check('staff elevation request → 200 reporting the owner', r.status === 200 && r.json?.requested === 1, `${r.status} ${JSON.stringify(r.json)}`);
  const ownerNote = await Notification.findOne({ userId: owner._id, type: 'system', title: 'Elevated clearance requested' }).lean();
  check('owner really received the elevation notification', !!ownerNote && String(ownerNote.message).includes('/admin/owner'), ownerNote?.message);
  check('elevation notification never echoes requester credentials', !JSON.stringify(ownerNote || {}).includes(staffPassword));

  // ── Cleanup: no QA data left behind ──
  try {
    const delUsers = await mongoose.connection.db.collection('users').deleteMany({});
    const delInvites = await mongoose.connection.db.collection('invitations').deleteMany({});
    const delApps = await mongoose.connection.db.collection('adminapplications').deleteMany({});
    const delNotes = await mongoose.connection.db.collection('notifications').deleteMany({});
    const delCustomers = await mongoose.connection.db.collection('customers').deleteMany({});
    console.log(`\n— cleanup: removed ${delUsers.deletedCount} user(s), ${delInvites.deletedCount} invitation(s), ${delApps.deletedCount} application(s), ${delNotes.deletedCount} notification(s), ${delCustomers.deletedCount} customer profile(s) —`);
  } catch (err) {
    console.log(`\n— cleanup skipped (${err.message}) —`);
  }

  console.log(`\nACTIVATION RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

try {
  await main();
} finally {
  await mongoose.disconnect().catch(() => {});
  await stopTestServer(SERVER, base);
}
