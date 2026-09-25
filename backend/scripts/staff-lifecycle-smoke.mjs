/**
 * Phase 20.6.3 / 20.6.4 / 20.6.5 — staff lifecycle, permissions & E2E suite.
 *
 * Proves the whole staff ecosystem against an ISOLATED database (no seeded
 * fixtures, SEED_ON_START=false), using only the real HTTP API plus direct
 * document assertions where the point is what is (not) persisted:
 *
 *   20.6.3  handler invitations
 *     · only an ADMIN may issue/list/resend/revoke (handler 403, customer 403,
 *       anonymous 401) — the backend is the authority, not the UI
 *     · the raw token is returned exactly once, stored only as SHA-256, never
 *       present in any read payload and never in the database
 *     · duplicate handling: existing account → 409 EMAIL_TAKEN, live pending
 *       invitation → 409 INVITATION_PENDING, role !== handler → 422
 *     · resend mints a NEW token and invalidates the previous link
 *     · revoke is idempotent and permanently unusable
 *     · activation is single-use, rejects weak passwords, carries the
 *       department/phone/inviter onto the account, never echoes the password
 *
 *   20.6.4  staff directory + lifecycle
 *     · the directory merges accounts and live invitations with real counts
 *     · suspend/reactivate really invalidate and restore access mid-session
 *     · self-action, fixture and owner-only (administrator targets) guards
 *     · administration can never be locked out (active-admin count never 0)
 *     · the audit timeline contains only events that actually happened
 *
 *   20.6.5  end-to-end lifecycle + production safety
 *     · owner → admin → handler invitation → activation → login → dashboard
 *       data → suspend → access denied → reactivate → login again
 *     · invalid / revoked / expired invitations can never create accounts
 *     · no QA data is left behind (everything created here is removed)
 *
 * Run: node scripts/staff-lifecycle-smoke.mjs
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Invitation from '../models/Invitation.js';
import AdminApplication from '../models/AdminApplication.js';
import StaffEvent from '../models/StaffEvent.js';
import Notification from '../models/Notification.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';

const DB_NAME = 'Flora-Alchemy-Test-StaffLifecycle';
const PORT = 4101;

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

function sha256(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// ── Deterministic start: drop the dedicated DB, pre-build every index the
// server will touch so autoIndex cannot race a write on a fresh database. ──
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  User.init(),
  Customer.init(),
  Invitation.init(),
  AdminApplication.init(),
  StaffEvent.init(),
  Notification.init(),
  Order.init(),
  Product.init(),
]);

const stamp = Date.now();
const passwordFor = (who) => `${who}-Passw0rd-${stamp}!`;

// ── Fixtures ────────────────────────────────────────────────────────────────
// Two owners: the lifecycle needs a second owner to outlive a suspension, and
// the active-admin invariant ("never lock administration out") needs a
// population to shrink.
const ownerPassword = passwordFor('Owner');
const owner = await User.create({
  email: `owner-${stamp}@staff.test`,
  passwordHash: await bcrypt.hash(ownerPassword, 12),
  role: 'admin',
  name: 'Atelier Owner',
  isOwner: true,
  isFixture: false,
});

const owner2Password = passwordFor('Owner2');
const owner2 = await User.create({
  email: `owner2-${stamp}@staff.test`,
  passwordHash: await bcrypt.hash(owner2Password, 12),
  role: 'admin',
  name: 'Second Owner',
  isOwner: true,
  isFixture: false,
});

const adminPassword = passwordFor('Admin');
const plainAdmin = await User.create({
  email: `admin-${stamp}@staff.test`,
  passwordHash: await bcrypt.hash(adminPassword, 12),
  role: 'admin',
  name: 'Plain Administrator',
  isOwner: false,
  isFixture: false,
});

// A pre-existing handler created directly (the "legacy account" case): used to
// prove role gating BEFORE the invitation flow produces a handler, and to
// prove the audit timeline is empty (not invented) for accounts that predate
// the audit trail.
const legacyHandlerPassword = passwordFor('Legacy');
const legacyHandler = await User.create({
  email: `legacy-h-${stamp}@staff.test`,
  passwordHash: await bcrypt.hash(legacyHandlerPassword, 12),
  role: 'handler',
  name: 'Legacy Handler',
  isFixture: false,
});

// Seed fixture operator — read-only by policy. Deliberately a HANDLER so it
// does not inflate the active-administrator population this suite reasons
// about when proving that administration can never be locked out.
const fixtureAdmin = await User.create({
  email: `fixture-${stamp}@staff.test`,
  passwordHash: await bcrypt.hash(passwordFor('Fixture'), 12),
  role: 'handler',
  name: 'Fixture Operator',
  isFixture: true,
});

const customerPassword = passwordFor('Customer');
const customerUser = await User.create({
  email: `customer-${stamp}@staff.test`,
  passwordHash: await bcrypt.hash(customerPassword, 12),
  role: 'customer',
  name: 'Storefront Customer',
  isFixture: false,
});

const { child: SERVER, base } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'staff-lifecycle-smoke',
});
const BASE = `${base}/api`;

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

/** Sign in and return the bearer token (fails the suite loudly if it cannot). */
async function signIn(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`sign-in failed for ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function main() {
  console.log('\n— 20.6.3 · INVITATION AUTHORIZATION —');
  const ownerAuth = await signIn(owner.email, ownerPassword);
  const ownerToken = ownerAuth.token;
  const owner2Token = (await signIn(owner2.email, owner2Password)).token;
  const adminToken = (await signIn(plainAdmin.email, adminPassword)).token;
  const legacyToken = (await signIn(legacyHandler.email, legacyHandlerPassword)).token;
  const customerToken = (await signIn(customerUser.email, customerPassword)).token;

  check('owner session exposes staffId + roleLabel', !!ownerAuth.user.staffId && ownerAuth.user.roleLabel === 'Owner', JSON.stringify(ownerAuth.user));
  check('owner session sets isOwner true', ownerAuth.user.isOwner === true);
  check('non-owner admin session sets isOwner false', (await signIn(plainAdmin.email, adminPassword)).user.isOwner === false);

  let r = await req('GET', '/admin/invitations');
  check('anonymous invitation list → 401', r.status === 401, String(r.status));
  r = await req('POST', '/admin/invitations', { body: { name: 'X Y', email: 'x@y.test' } });
  check('anonymous invitation create → 401', r.status === 401, String(r.status));
  r = await req('GET', '/admin/invitations', { token: legacyToken });
  check('HANDLER cannot list invitations → 403', r.status === 403 && r.json?.code === 'FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/admin/invitations', { token: legacyToken, body: { name: 'Sneaky Handler', email: 'sneaky@staff.test' } });
  check('HANDLER cannot create an invitation → 403 (handlers cannot create handlers)', r.status === 403, `${r.status} ${r.json?.code}`);
  r = await req('GET', '/admin/invitations', { token: customerToken });
  check('CUSTOMER cannot list invitations → 403', r.status === 403, String(r.status));
  r = await req('POST', '/admin/invitations', { token: customerToken, body: { name: 'Cust Omer', email: 'cust@staff.test' } });
  check('CUSTOMER cannot create an invitation → 403', r.status === 403, String(r.status));
  r = await req('GET', '/admin/invitations', { token: adminToken });
  check('non-owner ADMIN may list invitations → 200', r.status === 200, `${r.status} ${r.json?.message}`);

  console.log('\n— 20.6.3 · ISSUING A HANDLER INVITATION —');
  const inviteeEmail = `devika-${stamp}@staff.test`;
  r = await req('POST', '/admin/invitations', {
    token: adminToken,
    body: {
      name: 'Devika Mehra',
      email: inviteeEmail,
      phone: '+91 98450 12389',
      department: 'Packaging & Keepsake Boxes',
      notes: 'Assigned to Workbench B-02.',
    },
  });
  check('admin creates a handler invitation → 201', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  const created = r.json?.invitation || {};
  const firstLink = r.json?.link || '';
  const firstToken = firstLink.split('/').pop();
  check('response returns an activation link exactly once', /\/admin\/activate\/[a-f0-9]{64}$/.test(firstLink), firstLink.slice(0, 80));
  check('invitation role is fixed to handler', created.role === 'handler' && created.roleLabel === 'Handler', JSON.stringify(created));
  check('invitation starts INVITED with a future expiry', created.status === 'INVITED' && new Date(created.expiresAt) > new Date());
  check('admin cannot mint a non-handler invitation → 422', await (async () => {
    const x = await req('POST', '/admin/invitations', { token: adminToken, body: { name: 'Nope Person', email: `nope-${stamp}@staff.test`, role: 'admin' } });
    return x.status === 422;
  })());
  r = await req('POST', '/admin/invitations', { token: adminToken, body: { name: 'X', email: 'not-an-email' } });
  check('invalid email → 422', r.status === 422, `${r.status}`);
  r = await req('POST', '/admin/invitations', { token: adminToken, body: { name: 'A', email: `short-${stamp}@staff.test` } });
  check('too-short name → 422', r.status === 422, `${r.status}`);
  r = await req('POST', '/admin/invitations', { token: adminToken, body: { name: 'Existing Person', email: legacyHandler.email } });
  check('inviting an existing account → 409 EMAIL_TAKEN', r.status === 409 && r.json?.code === 'EMAIL_TAKEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/admin/invitations', { token: adminToken, body: { name: 'Devika Again', email: inviteeEmail } });
  check('duplicate pending invitation → 409 INVITATION_PENDING', r.status === 409 && r.json?.code === 'INVITATION_PENDING', `${r.status} ${r.json?.code}`);

  const stored = await Invitation.findOne({ recipientEmail: inviteeEmail }).lean();
  check('only the SHA-256 hash of the token is stored', stored?.tokenHash === sha256(firstToken), String(stored?.tokenHash).slice(0, 24));
  check('the raw token never reaches the database', JSON.stringify(stored || {}).includes(firstToken) === false);
  check('invitation metadata is persisted', stored?.recipientName === 'Devika Mehra' && stored?.department === 'Packaging & Keepsake Boxes' && stored?.phone === '+91 98450 12389');

  r = await req('GET', '/admin/invitations', { token: adminToken });
  const listBody = JSON.stringify(r.json || {});
  check('invitation list includes the new invite', (r.json?.invitations || []).some((i) => i.id === created.id));
  check('invitation list never exposes tokenHash', listBody.includes('tokenHash') === false);
  check('invitation list never exposes the raw token', listBody.includes(firstToken) === false);
  check('invitation list reports inviter by name', (r.json?.invitations || []).find((i) => i.id === created.id)?.invitedByName === 'Plain Administrator');
  check('invitation list counts pending invitations', (r.json?.counts?.pending ?? 0) >= 1, JSON.stringify(r.json?.counts));
  const byId = await req('GET', `/admin/invitations/${created.id}`, { token: adminToken });
  check('single invitation read → 200 without token material', byId.status === 200 && !JSON.stringify(byId.json).includes('tokenHash'), String(byId.status));
  r = await req('GET', `/admin/invitations/${new mongoose.Types.ObjectId()}`, { token: adminToken });
  check('unknown invitation id → 404', r.status === 404, String(r.status));

  console.log('\n— 20.6.3 · PUBLIC LANDING (token = credential) —');
  r = await req('GET', `/invitations/${firstToken}`);
  const landing = r.json?.invitation || {};
  check('landing resolves with real dossier fields', r.status === 200 && landing.recipientEmail === inviteeEmail, `${r.status} ${JSON.stringify(landing).slice(0, 160)}`);
  check('landing shows recipient name, role and department', landing.recipientName === 'Devika Mehra' && landing.roleLabel === 'Handler' && landing.department === 'Packaging & Keepsake Boxes', JSON.stringify(landing));
  check('landing shows who invited them', landing.invitedByName === 'Plain Administrator', landing.invitedByName);
  check('landing shows an invitation badge id and future expiry', String(landing.invitationId).startsWith('INV-') && new Date(landing.expiresAt) > new Date());
  check('landing never leaks token material', JSON.stringify(r.json).includes('tokenHash') === false && JSON.stringify(r.json).includes(firstToken) === false);

  console.log('\n— 20.6.3 · RESEND INVALIDATES THE OLD LINK —');
  r = await req('POST', `/admin/invitations/${created.id}/resend`, { token: adminToken });
  const secondLink = r.json?.link || '';
  const secondToken = secondLink.split('/').pop();
  check('resend → 200 with a NEW link', r.status === 200 && secondToken && secondToken !== firstToken, `${r.status} ${secondLink.slice(0, 60)}`);
  r = await req('GET', `/invitations/${firstToken}`);
  check('the superseded link is now invalid → 404', r.status === 404, String(r.status));
  r = await req('GET', `/invitations/${secondToken}`);
  check('the freshly minted link works → 200', r.status === 200, String(r.status));
  const afterResend = await Invitation.findById(created.id).lean();
  check('resend counter and hash are updated', afterResend?.resendCount === 1 && afterResend?.tokenHash === sha256(secondToken));

  console.log('\n— 20.6.3 · ACTIVATION —');
  r = await req('POST', `/invitations/${secondToken}/activate`, { body: { password: '12345' } });
  check('weak password → 422 and the invitation is untouched', r.status === 422 && (await Invitation.findById(created.id).lean())?.status === 'INVITED', String(r.status));
  r = await req('POST', `/invitations/${secondToken}/activate`, { body: { password: handlerPasswordFor() } });
  check('activation → 201 with the created account', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  check('activation never echoes the password', JSON.stringify(r.json || {}).includes(handlerPasswordFor()) === false);
  check('activation reports handler identity (role + staffId)', r.json?.account?.role === 'handler' && /^HND-/.test(r.json?.account?.staffId || ''), JSON.stringify(r.json?.account));
  check('activation carries the department onto the account', r.json?.account?.department === 'Packaging & Keepsake Boxes');

  const activated = await User.findOne({ email: inviteeEmail });
  check('account exists with role handler (never a client-supplied role)', activated?.role === 'handler');
  check('account is ACTIVE and not an owner', activated?.status === 'ACTIVE' && activated?.isOwner === false);
  check('account carries inviter, phone and derived badge', String(activated?.invitedBy) === String(plainAdmin._id) && activated?.phone === '+91 98450 12389' && /^HND-/.test(activated?.staffId || ''));
  check('invitation is consumed (ACTIVE + consumedAt)', (await Invitation.findById(created.id).lean())?.status === 'ACTIVE' && !!(await Invitation.findById(created.id).lean())?.consumedAt);
  r = await req('POST', `/invitations/${secondToken}/activate`, { body: { password: handlerPasswordFor() } });
  check('single-use: a second activation → 409 INVITATION_ALREADY_ACTIVATED', r.status === 409 && r.json?.code === 'INVITATION_ALREADY_ACTIVATED', `${r.status} ${r.json?.code}`);
  r = await req('GET', `/invitations/${secondToken}`);
  check('landing after activation → 409 (sign in instead)', r.status === 409, String(r.status));
  r = await req('POST', `/admin/invitations/${created.id}/resend`, { token: adminToken });
  check('an activated invitation cannot be resent → 409', r.status === 409, String(r.status));
  r = await req('POST', `/admin/invitations/${created.id}/revoke`, { token: adminToken });
  check('an activated invitation cannot be revoked → 409', r.status === 409, String(r.status));

  console.log('\n— 20.6.3 · REVOKED & EXPIRED INVITATIONS —');
  const revokeEmail = `withdrawn-${stamp}@staff.test`;
  const withdraw = await req('POST', '/admin/invitations', { token: ownerToken, body: { name: 'Withdrawn Person', email: revokeEmail, department: 'Logistics' } });
  const withdrawId = withdraw.json?.invitation?.id;
  const withdrawToken = String(withdraw.json?.link || '').split('/').pop();
  r = await req('POST', `/admin/invitations/${withdrawId}/revoke`, { token: ownerToken, body: { reason: 'Role no longer required' } });
  check('revoke → 200 with REVOKED status', r.status === 200 && r.json?.invitation?.status === 'REVOKED', `${r.status} ${JSON.stringify(r.json?.invitation)?.slice(0, 120)}`);
  r = await req('GET', `/invitations/${withdrawToken}`);
  check('revoked link → 403 INVITATION_REVOKED', r.status === 403 && r.json?.code === 'INVITATION_REVOKED', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/invitations/${withdrawToken}/activate`, { body: { password: handlerPasswordFor() } });
  check('a revoked invitation cannot create an account → 403', r.status === 403, String(r.status));
  check('no account was created for the revoked invitation', (await User.findOne({ email: revokeEmail })) === null);
  r = await req('POST', `/admin/invitations/${withdrawId}/revoke`, { token: ownerToken });
  check('revoking twice is idempotent (200)', r.status === 200, String(r.status));
  const revokeEvent = await StaffEvent.findOne({ invitation: withdrawId, type: 'INVITATION_REVOKED' }).lean();
  check('revocation reason is recorded in the audit trail', !!revokeEvent && String(revokeEvent.message).includes('Role no longer required'), revokeEvent?.message);
  r = await req('POST', `/admin/invitations/${withdrawId}/resend`, { token: ownerToken });
  check('a revoked invitation cannot be resent → 422', r.status === 422 && r.json?.code === 'INVITATION_REVOKED', `${r.status} ${r.json?.code}`);

  const expireEmail = `lapsed-${stamp}@staff.test`;
  const lapse = await req('POST', '/admin/invitations', { token: ownerToken, body: { name: 'Lapsed Person', email: expireEmail } });
  const lapseId = lapse.json?.invitation?.id;
  const lapseToken = String(lapse.json?.link || '').split('/').pop();
  await Invitation.updateOne({ _id: lapseId }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
  r = await req('GET', `/invitations/${lapseToken}`);
  check('expired link → 410 INVITATION_EXPIRED', r.status === 410 && r.json?.code === 'INVITATION_EXPIRED', `${r.status} ${r.json?.code}`);
  check('expiry is persisted, not just computed', (await Invitation.findById(lapseId).lean())?.status === 'EXPIRED');
  r = await req('POST', `/invitations/${lapseToken}/activate`, { body: { password: handlerPasswordFor() } });
  check('an expired invitation cannot create an account → 410', r.status === 410, String(r.status));
  check('no account was created for the expired invitation', (await User.findOne({ email: expireEmail })) === null);
  r = await req('GET', `/invitations/${crypto.randomBytes(32).toString('hex')}`);
  check('a random token → 404 (no enumeration signal)', r.status === 404, String(r.status));

  console.log('\n— 20.6.3 · HANDLER SIGN-IN & BOUNDARIES —');
  const handlerPassword = handlerPasswordFor();
  const handlerAuth = await signIn(inviteeEmail, handlerPassword);
  check('the activated handler can sign in through the SAME login endpoint', handlerAuth.user.role === 'handler', JSON.stringify(handlerAuth.user));
  check('handler session carries their staff badge and department', /^HND-/.test(handlerAuth.user.staffId) && handlerAuth.user.department === 'Packaging & Keepsake Boxes', JSON.stringify(handlerAuth.user));
  check('handler session is never an owner', handlerAuth.user.isOwner === false);
  const handlerToken = handlerAuth.token;
  const handlerAfterLogin = await User.findOne({ email: inviteeEmail }).lean();
  check('sign-in records real last-active', !!handlerAfterLogin?.lastActiveAt);
  check('sign-in is written to the audit timeline', !!(await StaffEvent.findOne({ recipientEmail: inviteeEmail, type: 'LOGIN' }).lean()));
  r = await req('GET', '/orders', { token: handlerToken });
  check('handler can load operational data (orders) → 200', r.status === 200, `${r.status} ${r.json?.message}`);
  r = await req('GET', '/inventory', { token: handlerToken });
  check('handler can load operational data (inventory) → 200', r.status === 200, String(r.status));
  r = await req('GET', '/admin/staff', { token: handlerToken });
  check('handler cannot read the staff directory → 403', r.status === 403, String(r.status));
  r = await req('GET', '/admin/users', { token: handlerToken });
  check('handler cannot read the operator console → 403', r.status === 403, String(r.status));
  r = await req('GET', '/admin/staff', { token: customerToken });
  check('customer cannot read the staff directory → 403', r.status === 403, String(r.status));
  r = await req('GET', '/admin/staff');
  check('anonymous cannot read the staff directory → 401', r.status === 401, String(r.status));

  console.log('\n— 20.6.4 · STAFF DIRECTORY —');
  r = await req('GET', '/admin/staff', { token: adminToken });
  const rows = r.json?.staff || [];
  check('admin reads the unified directory → 200', r.status === 200, `${r.status} ${r.json?.message}`);
  check('directory includes real accounts and pending invitations', rows.some((x) => x.kind === 'user') && rows.some((x) => x.kind === 'invitation'), JSON.stringify(rows.map((x) => x.kind)));
  check('directory never leaks a password hash', JSON.stringify(r.json || {}).includes('passwordHash') === false);
  check('directory never leaks a token hash', JSON.stringify(r.json || {}).includes('tokenHash') === false);
  const counts = r.json?.counts || {};
  check('counts describe the whole roster', counts.all >= 4 && counts.handlers >= 2 && counts.administrators >= 3, JSON.stringify(counts));
  check('suspended count starts at zero', counts.suspended === 0, String(counts.suspended));
  const activatedRow = rows.find((x) => x.email === inviteeEmail);
  check('the activated handler appears as an ACTIVE handler row', activatedRow?.status === 'ACTIVE' && activatedRow?.role === 'handler', JSON.stringify(activatedRow)?.slice(0, 140));
  check('service-side actions are attached to each row', typeof activatedRow?.actions?.canSuspend === 'boolean');
  const ownerRow = rows.find((x) => x.email === owner.email);
  check('owner row is labelled Owner and never self-actionable by others', ownerRow?.roleBadge === 'OWNER' && ownerRow?.isOwner === true, JSON.stringify(ownerRow)?.slice(0, 120));
  r = await req('GET', '/admin/staff?role=HANDLER', { token: adminToken });
  check('role filter returns handlers only', (r.json?.staff || []).every((x) => x.role === 'handler') && (r.json?.staff || []).length >= 2);
  r = await req('GET', '/admin/staff?role=ADMINISTRATOR', { token: adminToken });
  check('role filter returns administrators only', (r.json?.staff || []).every((x) => x.role === 'admin'));
  r = await req('GET', `/admin/staff?q=${encodeURIComponent('Devika')}`, { token: adminToken });
  check('search matches by name', (r.json?.staff || []).some((x) => x.email === inviteeEmail));
  r = await req('GET', '/admin/staff?q=zzz-no-such-person', { token: adminToken });
  check('no-match search returns an empty list (real empty state)', (r.json?.staff || []).length === 0 && r.status === 200);
  r = await req('GET', '/admin/staff?sort=name-asc', { token: adminToken });
  const names = (r.json?.staff || []).map((x) => x.name);
  check('server-side sorting is applied', JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), JSON.stringify(names));

  const dossier = await req('GET', `/admin/staff/${activated?._id}`, { token: adminToken });
  const member = dossier.json?.member || {};
  check('dossier loads by id → 200', dossier.status === 200, String(dossier.status));
  check('dossier exposes identity, role, status and badge', member.email === inviteeEmail && member.roleLabel === 'Handler' && member.status === 'ACTIVE' && /^HND-/.test(member.staffId || ''), JSON.stringify(member)?.slice(0, 160));
  check('dossier names the inviting admin', member.invitedByName === 'Plain Administrator', member.invitedByName);
  check('dossier exposes last active and joined labels', !!member.lastActiveLabel && !!member.joinedLabel);
  r = await req('GET', `/admin/staff/${new mongoose.Types.ObjectId()}`, { token: adminToken });
  check('unknown staff id → 404', r.status === 404, String(r.status));

  console.log('\n— 20.6.4 · AUDIT TIMELINE —');
  const timeline = await req('GET', `/admin/staff/${activated?._id}/activity`, { token: adminToken });
  const types = (timeline.json?.events || []).map((e) => e.type);
  check('timeline loads real recorded events', timeline.status === 200 && types.length >= 3, JSON.stringify(types));
  check('timeline contains invitation → activation → login', types.includes('INVITATION_CREATED') && types.includes('ACCOUNT_ACTIVATED') && types.includes('LOGIN'), JSON.stringify(types));
  check('timeline is newest-first', (() => {
    const times = (timeline.json?.events || []).map((e) => new Date(e.at).getTime());
    return times.every((t, i) => i === 0 || times[i - 1] >= t);
  })());
  const legacyTimeline = await req('GET', `/admin/staff/${legacyHandler._id}/activity`, { token: adminToken });
  check('a pre-audit legacy account shows only its real sign-in, nothing invented',
    legacyTimeline.status === 200 &&
    (legacyTimeline.json?.events || []).length === 1 &&
    legacyTimeline.json.events[0].type === 'LOGIN',
    JSON.stringify(legacyTimeline.json?.events));
  const fixtureTimeline = await req('GET', `/admin/staff/${fixtureAdmin._id}/activity`, { token: adminToken });
  check('an account with no recorded history returns an honest EMPTY timeline',
    fixtureTimeline.status === 200 && (fixtureTimeline.json?.events || []).length === 0,
    JSON.stringify(fixtureTimeline.json?.events));

  console.log('\n— 20.6.4 · SUSPEND / REACTIVATE —');
  r = await req('POST', `/admin/staff/${activated?._id}/suspend`, { token: adminToken, body: {} });
  check('suspend without a reason → 422', r.status === 422, String(r.status));
  r = await req('POST', `/admin/staff/${activated?._id}/suspend`, { token: adminToken, body: { reason: 'Policy & Quality Audit Review', note: 'Bench audit' } });
  check('admin suspends a handler → 200 SUSPENDED', r.status === 200 && r.json?.member?.status === 'SUSPENDED', `${r.status} ${JSON.stringify(r.json?.member)?.slice(0, 120)}`);
  const suspendedDoc = await User.findById(activated?._id).lean();
  check('suspension is persisted with its reason', suspendedDoc?.status === 'SUSPENDED' && suspendedDoc?.suspension?.reason === 'Policy & Quality Audit Review' && String(suspendedDoc?.suspension?.by) === String(plainAdmin._id));
  check('suspension is recorded in the audit trail', !!(await StaffEvent.findOne({ user: activated?._id, type: 'SUSPENDED' }).lean()));
  r = await req('GET', '/orders', { token: handlerToken });
  check('an EXISTING handler token is refused immediately → 403 ACCOUNT_SUSPENDED', r.status === 403 && r.json?.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: inviteeEmail, password: handlerPassword } });
  check('a suspended handler cannot sign in → 403 ACCOUNT_SUSPENDED', r.status === 403 && r.json?.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin/staff/${activated?._id}/suspend`, { token: adminToken, body: { reason: 'Again' } });
  check('suspending twice is safe (idempotent)', r.status === 200, String(r.status));
  r = await req('GET', '/admin/staff?status=SUSPENDED', { token: adminToken });
  check('status filter surfaces the suspended account', (r.json?.staff || []).some((x) => x.email === inviteeEmail), JSON.stringify((r.json?.staff || []).map((x) => x.email)));

  r = await req('POST', `/admin/staff/${activated?._id}/reactivate`, { token: adminToken });
  check('reactivate → 200 ACTIVE', r.status === 200 && r.json?.member?.status === 'ACTIVE', `${r.status}`);
  const reactivatedDoc = await User.findById(activated?._id).lean();
  check('reactivation clears the suspension record', reactivatedDoc?.status === 'ACTIVE' && !reactivatedDoc?.suspension?.reason);
  check('reactivation is recorded in the audit trail', !!(await StaffEvent.findOne({ user: activated?._id, type: 'REACTIVATED' }).lean()));
  r = await req('POST', '/auth/login', { body: { email: inviteeEmail, password: handlerPassword } });
  check('the handler can sign in again after reactivation → 200', r.status === 200, String(r.status));
  r = await req('POST', `/admin/staff/${activated?._id}/reactivate`, { token: adminToken });
  check('reactivating an active account is safe (idempotent)', r.status === 200, String(r.status));

  console.log('\n— 20.6.4 · SELF-PROTECTION & OWNER-ONLY MATRIX —');
  r = await req('POST', `/admin/staff/${plainAdmin._id}/suspend`, { token: adminToken, body: { reason: 'Self harm' } });
  check('an admin cannot suspend itself → 422 SELF_ACTION_FORBIDDEN', r.status === 422 && r.json?.code === 'SELF_ACTION_FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin/staff/${owner._id}/suspend`, { token: adminToken, body: { reason: 'Coup' } });
  check('a non-owner admin cannot suspend the owner → 403 OWNER_REQUIRED', r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin/staff/${owner2._id}/reactivate`, { token: adminToken });
  check('a non-owner admin cannot manage administrators at all → 403', r.status === 403, String(r.status));
  r = await req('POST', `/admin/staff/${fixtureAdmin._id}/suspend`, { token: ownerToken, body: { reason: 'Any' } });
  check('fixture accounts are read-only → 422 FIXTURE_READONLY', r.status === 422 && r.json?.code === 'FIXTURE_READONLY', `${r.status} ${r.json?.code}`);
  const ownerSelfRow = await req('GET', `/admin/staff/${owner._id}`, { token: ownerToken });
  check('the owner sees their own row as non-suspendable', ownerSelfRow.json?.member?.actions?.canSuspend === false && ownerSelfRow.json?.member?.isSelf === true, JSON.stringify(ownerSelfRow.json?.member?.actions));

  r = await req('POST', `/admin/staff/${plainAdmin._id}/suspend`, { token: ownerToken, body: { reason: 'Approved sabbatical' } });
  check('the OWNER may suspend an administrator → 200', r.status === 200 && r.json?.member?.status === 'SUSPENDED', `${r.status} ${r.json?.message}`);
  const activeAdminsAfter = await User.countDocuments({ role: 'admin', status: 'ACTIVE' });
  check('active administrators remain (never locked out)', activeAdminsAfter >= 1, String(activeAdminsAfter));
  r = await req('POST', `/admin/staff/${owner2._id}/suspend`, { token: ownerToken, body: { reason: 'Sabbatical' } });
  check('owner suspends the second owner → 200', r.status === 200, `${r.status} ${r.json?.message}`);
  const lastActiveAdmins = await User.countDocuments({ role: 'admin', status: 'ACTIVE' });
  check('exactly one active administrator is left', lastActiveAdmins === 1, String(lastActiveAdmins));
  // The last active admin is the acting account itself. Reducing the count to
  // zero is impossible through the API: every remaining admin is self, and
  // self-actions are refused before any write. Assert the invariant directly.
  r = await req('POST', `/admin/staff/${owner._id}/suspend`, { token: ownerToken, body: { reason: 'Lockout attempt' } });
  check('the last active administrator cannot be suspended (lockout is impossible)', r.status === 422 && (await User.countDocuments({ role: 'admin', status: 'ACTIVE' })) === 1, `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin/staff/${plainAdmin._id}/reactivate`, { token: ownerToken });
  check('owner reactivates the administrator', r.status === 200 && r.json?.member?.status === 'ACTIVE', String(r.status));
  r = await req('POST', `/admin/staff/${owner2._id}/reactivate`, { token: ownerToken });
  check('owner reactivates the second owner', r.status === 200, String(r.status));

  console.log('\n— 20.6.4 · PROFILE UPDATE —');
  r = await req('PATCH', `/admin/staff/${activated?._id}`, { token: ownerToken, body: { department: 'Petal Dye & Winding' } });
  check('admin updates a handler department → 200', r.status === 200 && r.json?.member?.department === 'Petal Dye & Winding', `${r.status} ${JSON.stringify(r.json?.member)?.slice(0, 120)}`);
  check('profile update is recorded in the audit trail', !!(await StaffEvent.findOne({ user: activated?._id, type: 'PROFILE_UPDATED' }).lean()));
  r = await req('PATCH', `/admin/staff/${activated?._id}`, { token: ownerToken, body: { phone: '0000000000000000000' } });
  check('invalid phone is rejected → 422', r.status === 422, String(r.status));
  r = await req('PATCH', `/admin/staff/${activated?._id}`, { token: ownerToken, body: { department: 'Petal Dye & Winding' } });
  check('a no-op profile update is reported honestly', r.status === 200 && r.json?.message === 'Nothing changed.', r.json?.message);

  console.log('\n— 20.6.5 · END-TO-END LIFECYCLE —');
  // owner → admin (already exists) → admin invites handler → handler activates
  // → signs in → sees operational data → is suspended → loses access → is
  // reactivated → signs in again. Each leg asserts on REAL state.
  const e2eEmail = `e2e-handler-${stamp}@staff.test`;
  const e2ePassword = `E2E-Handler-${stamp}!`;
  const issue = await req('POST', '/admin/invitations', { token: adminToken, body: { name: 'E2E Handler', email: e2eEmail, department: 'Logistics & Courier Prep' } });
  check('E2E: admin issues the invitation', issue.status === 201, String(issue.status));
  const e2eToken = String(issue.json?.link || '').split('/').pop();
  const e2eLanding = await req('GET', `/invitations/${e2eToken}`);
  check('E2E: the recipient can open the raw link', e2eLanding.status === 200 && e2eLanding.json?.invitation?.recipientEmail === e2eEmail);
  const e2eActivate = await req('POST', `/invitations/${e2eToken}/activate`, { body: { password: e2ePassword } });
  check('E2E: the recipient activates with their own password', e2eActivate.status === 201, `${e2eActivate.status}`);
  const e2eUser = await User.findOne({ email: e2eEmail }).lean();
  check('E2E: the account becomes ACTIVE', e2eUser?.status === 'ACTIVE' && e2eUser?.role === 'handler');
  const e2eLogin = await signIn(e2eEmail, e2ePassword);
  check('E2E: the handler signs in', e2eLogin.user.role === 'handler');
  const e2eTokenJwt = e2eLogin.token;
  const dash = await req('GET', '/orders', { token: e2eTokenJwt });
  check('E2E: handler dashboard data loads', dash.status === 200 && Array.isArray(dash.json?.orders ?? dash.json?.data ?? []), `${dash.status}`);
  const seenByAdmin = await req('GET', `/admin/staff?q=${encodeURIComponent('E2E Handler')}`, { token: adminToken });
  check('E2E: the admin sees the handler as ACTIVE in the directory', (seenByAdmin.json?.staff || []).some((x) => x.email === e2eEmail && x.status === 'ACTIVE'));
  await req('POST', `/admin/staff/${e2eUser?._id}/suspend`, { token: adminToken, body: { reason: 'Approved Temporary Sabbatical / Leave' } });
  const blocked = await req('GET', '/orders', { token: e2eTokenJwt });
  check('E2E: the suspended handler’s live session is blocked → 403', blocked.status === 403 && blocked.json?.code === 'ACCOUNT_SUSPENDED', `${blocked.status} ${blocked.json?.code}`);
  await req('POST', `/admin/staff/${e2eUser?._id}/reactivate`, { token: adminToken });
  const reLogin = await req('POST', '/auth/login', { body: { email: e2eEmail, password: e2ePassword } });
  check('E2E: after reactivation the handler signs in again → 200', reLogin.status === 200, String(reLogin.status));
  const e2eTimeline = await req('GET', `/admin/staff/${e2eUser?._id}/activity`, { token: adminToken });
  const e2eTypes = (e2eTimeline.json?.events || []).map((e) => e.type);
  check('E2E: the whole lifecycle is on the audit trail',
    ['INVITATION_CREATED', 'ACCOUNT_ACTIVATED', 'LOGIN', 'SUSPENDED', 'REACTIVATED'].every((t) => e2eTypes.includes(t)),
    JSON.stringify(e2eTypes));

  console.log('\n— 20.6.5 · INVITATION LEDGER TABS —');
  r = await req('GET', '/admin/invitations?status=REVOKED', { token: ownerToken });
  check('revoked tab lists only revoked invitations', (r.json?.invitations || []).every((i) => i.status === 'REVOKED') && (r.json?.invitations || []).length >= 1);
  r = await req('GET', '/admin/invitations?status=EXPIRED', { token: ownerToken });
  check('expired tab lists only expired invitations', (r.json?.invitations || []).every((i) => i.status === 'EXPIRED') && (r.json?.invitations || []).length >= 1);
  r = await req('GET', '/admin/invitations?status=ACCEPTED', { token: ownerToken });
  check('accepted tab lists only activated invitations', (r.json?.invitations || []).every((i) => i.status === 'ACTIVE') && (r.json?.invitations || []).length >= 2);
  r = await req('GET', '/admin/invitations?status=PENDING', { token: ownerToken });
  check('pending tab is a real (possibly empty) list', r.status === 200 && Array.isArray(r.json?.invitations));
  r = await req('GET', `/admin/invitations?q=${encodeURIComponent('devika')}`, { token: ownerToken });
  check('invitation search matches the recipient', (r.json?.invitations || []).some((i) => i.recipientEmail === inviteeEmail));

  console.log('\n— 20.6.5 · PRODUCTION SAFETY —');
  check('no plaintext password is stored anywhere in users', (await User.countDocuments({ passwordHash: { $exists: false } })) === 0);
  const anyInvite = await Invitation.find({}).lean();
  check('every stored invitation token is a SHA-256 digest, never a raw token',
    anyInvite.length > 0 && anyInvite.every((i) => /^[a-f0-9]{64}$/.test(i.tokenHash) && i.tokenHash !== i.recipientEmail));
  check('no account was created for revoked or expired invitations',
    (await User.countDocuments({ email: { $in: [revokeEmail, expireEmail] } })) === 0);

  // ── Cleanup: nothing this suite created may survive ──
  try {
    const emails = [owner.email, owner2.email, plainAdmin.email, legacyHandler.email, fixtureAdmin.email, customerUser.email, inviteeEmail, e2eEmail, revokeEmail, expireEmail];
    const staffIds = (await User.find({ email: { $in: emails } }).select('_id').lean()).map((u) => u._id);
    const del = await Promise.all([
      User.deleteMany({ email: { $in: emails } }),
      Invitation.deleteMany({ recipientEmail: { $in: emails } }),
      StaffEvent.deleteMany({ recipientEmail: { $in: emails } }),
      StaffEvent.deleteMany({ user: { $in: staffIds } }),
      Notification.deleteMany({ userId: { $in: staffIds } }),
      Customer.deleteMany({ email: { $in: emails } }),
    ]);
    const remaining = await User.countDocuments({ email: { $in: emails } });
    console.log(`\n— cleanup: removed ${del[0].deletedCount} user(s), ${del[1].deletedCount} invitation(s), ${del[2].deletedCount + del[3].deletedCount} audit event(s) — ${remaining} left behind —`);
    check('cleanup left no QA users behind', remaining === 0, String(remaining));
  } catch (err) {
    console.log(`\n— cleanup skipped (${err.message}) —`);
  }

  console.log(`\nSTAFF LIFECYCLE RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

// The handler password used by every activation attempt in this suite.
function handlerPasswordFor() {
  return `Handler-Passw0rd-${stamp}!`;
}

try {
  await main();
} finally {
  await mongoose.disconnect().catch(() => {});
  await stopTestServer(SERVER, base);
}
