/**
 * Phase 21.4–21.7 — PERSONNEL LIFECYCLE (end-to-end).
 *
 * Proves the full business chain against an isolated disposable database with
 * NO seeded fixtures — every account in this suite is created by the flow the
 * suite is testing:
 *
 *   OWNER → public application → owner review → approval → one-time invitation
 *         → activation → ACTIVE ADMIN (ADM-…) → /admin/login
 *         → admin invites HANDLER → activation → ACTIVE HANDLER (HND-…)
 *         → /staff/login
 *         → owner suspends the admin → access lost → owner reactivates → access restored
 *
 * It also encodes the negative half of the RBAC matrix and the security
 * properties of the application/invitation lifecycle:
 *
 *   · role injection: a public application cannot carry a role/owner field,
 *     and the handler-invite endpoint rejects `role: "admin"` (422) rather
 *     than coercing it
 *   · duplicates: re-applying while open → 409; approving twice → 409 with
 *     exactly ONE invitation ever minted for the application
 *   · invitations: the raw token appears in exactly one response, only its
 *     SHA-256 hash is stored, reads never leak it, a resend invalidates the
 *     previous link, a revoke makes the link unusable, expiry → 410
 *   · ADMIN invitations are owner-only: a plain administrator cannot resend or
 *     revoke one (403 OWNER_REQUIRED) — the privilege-escalation guard
 *   · suspension invalidates an already-issued token on the very next request
 *
 * Isolation: own server (port 4102), own DB (Flora-Alchemy-Test-Personnel),
 * SEED_ON_START=false. The database is dropped at the start and the end.
 *
 * Run: node scripts/personnel-lifecycle-smoke.mjs
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

const DB_NAME = 'Flora-Alchemy-Test-Personnel';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

function sha256(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Fresh database + pre-built indexes (avoids autoIndex racing a transaction).
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([User.init(), Customer.init(), Invitation.init(), AdminApplication.init(), StaffEvent.init()]);

const stamp = Date.now();
const ownerPassword = `Owner-Passw0rd-${stamp}!`;
const adminPass = `Admin-Passw0rd-${stamp}!`;
const handlerPass = `Handler-Passw0rd-${stamp}!`;

// The ONLY pre-existing account: the bootstrapped owner (what provision-admin
// would have created). Everything else is produced by the lifecycle.
const owner = await User.create({
  email: `owner-${stamp}@personnel.test`,
  passwordHash: await bcrypt.hash(ownerPassword, 12),
  role: 'admin',
  name: 'Provisioned Owner',
  isOwner: true,
  isFixture: false,
});

// A SECOND administrator, created directly: the subject for the "an admin
// cannot manage another administrator" assertions (targeting the acting admin
// itself would trip the self-action guard first and prove the wrong rule).
const peerAdmin = await User.create({
  email: `peer-admin-${stamp}@personnel.test`,
  passwordHash: await bcrypt.hash(`Peer-Passw0rd-${stamp}!`, 12),
  role: 'admin',
  name: 'Peer Administrator',
  isOwner: false,
  isFixture: false,
});

const applicantEmail = `applicant-${stamp}@personnel.test`;
const handlerEmail = `handler-${stamp}@personnel.test`;

const { child: SERVER, base } = await bootTestServer({
  port: 4102,
  db: DB_NAME,
  extraEnv: {
    SEED_ON_START: 'false',
    // The suite deliberately makes many refused calls; give the isolated
    // server headroom so the limiter never masks a real assertion.
    RATE_LIMIT_LOGIN_FAILED_MAX: '5000',
    RATE_LIMIT_API_WRITE_MAX: '5000',
    RATE_LIMIT_APPLICATION_MAX: '5000',
    RATE_LIMIT_INVITATION_MAX: '5000',
  },
  label: 'personnel-lifecycle-smoke',
});
const BASE = `${base}/api`;

await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });

let passed = 0;
let failed = 0;
const failures = [];

async function req(method, path_, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${path_}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch { /* non-json */ }
      return { status: res.status, json };
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 750));
    }
  }
}

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

/** Pull the raw activation token out of the one-time link a response returned. */
function tokenFrom(link) {
  const m = String(link || '').match(/\/admin\/activate\/(.+)$/);
  return m ? m[1] : null;
}

async function main() {
  console.log('\n— 1-2 · OWNER SIGNS IN, APPLICANT FILES A PUBLIC APPLICATION —');
  let r = await req('POST', '/auth/login', { body: { email: owner.email, password: ownerPassword, portal: 'owner' } });
  const OWNER = r.json?.token;
  check('owner signs in to the Owner Portal → 200', r.status === 200 && r.json?.user?.portal === 'owner', `${r.status}`);
  check('owner session is server-derived (role admin + isOwner)', r.json?.user?.role === 'admin' && r.json?.user?.isOwner === true, JSON.stringify(r.json?.user));

  r = await req('POST', '/admin-applications', {
    body: {
      name: 'Devika Menon',
      email: applicantEmail,
      phone: '+91 90000 00000',
      reason: 'I want to steward the atelier operations console.',
      background: 'Six years coordinating retail operations and fulfilment.',
      // Phase 22.4 — business identity required by the onboarding intake.
      businessName: 'Menon Keepsake Studio',
      // Attempted privilege injection — must be ignored outright.
      role: 'admin',
      isOwner: true,
      status: 'APPROVED',
    },
  });
  check('public application → 201', r.status === 201 && !!r.json?.application?.id, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  const appId = r.json?.application?.id;
  check('application status starts pending review', r.json?.application?.status === 'PENDING_REVIEW', r.json?.application?.status);
  check('application accepts no role from the requester', !('role' in (r.json?.application || {})) && !('isOwner' in (r.json?.application || {})));
  check('application response issues no credential or token', !JSON.stringify(r.json || {}).includes('eyJ') && !JSON.stringify(r.json || {}).includes('password'));
  const userAfterApply = await User.countDocuments({ email: applicantEmail });
  check('submitting created NO user account', userAfterApply === 0, String(userAfterApply));
  const inviteAfterApply = await Invitation.countDocuments({ recipientEmail: applicantEmail });
  check('submitting minted NO invitation', inviteAfterApply === 0, String(inviteAfterApply));

  r = await req('POST', '/admin-applications', {
    body: {
      name: 'Devika Menon',
      email: applicantEmail,
      reason: 'Applying again with the same email.',
      background: 'Same person, duplicate submission.',
      businessName: 'Menon Keepsake Studio',
    },
  });
  check('duplicate open application → 409 DUPLICATE_APPLICATION', r.status === 409 && r.json?.code === 'DUPLICATE_APPLICATION', `${r.status} ${r.json?.code}`);

  console.log('\n— 3-4 · OWNER SEES THE QUEUE AND OPENS THE DOSSIER —');
  r = await req('GET', '/admin-applications?status=PENDING', { token: OWNER });
  check('owner sees the pending application → 200', r.status === 200 && (r.json?.applications || []).some((a) => a.id === appId), `${r.status}`);
  check('pending count is real', r.json?.counts?.pending >= 1, JSON.stringify(r.json?.counts));
  r = await req('GET', `/admin-applications/${appId}`, { token: OWNER });
  check('owner opens the dossier → 200 with the applicant identity', r.status === 200 && r.json?.application?.email === applicantEmail, `${r.status}`);
  check('dossier offers the review actions', r.json?.application?.canApprove === true && r.json?.application?.canReject === true);

  console.log('\n— 5-6 · APPROVAL IS ATOMIC AND MINTS EXACTLY ONE INVITATION —');
  r = await req('POST', `/admin-applications/${appId}/approve`, { token: OWNER, body: { note: 'Strong operations background.' } });
  check('owner approves → 200 with the one-time link', r.status === 200 && /\/admin\/activate\//.test(r.json?.link || ''), `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  const adminRawToken = tokenFrom(r.json?.link);
  const adminInviteId = r.json?.invitation?.invitationId;
  check('approve returns an invitation id', /^INV-/.test(adminInviteId || ''), String(adminInviteId));
  check('approval is recorded with reviewer + note', r.json?.application?.reviewNote === 'Strong operations background.' && !!r.json?.application?.reviewedByName, JSON.stringify(r.json?.application)?.slice(0, 160));

  const inviteDocs = await Invitation.find({ recipientEmail: applicantEmail }).lean();
  check('exactly ONE invitation exists for the application', inviteDocs.length === 1, String(inviteDocs.length));
  check('invitation role is FIXED to admin server-side', inviteDocs[0]?.role === 'admin', inviteDocs[0]?.role);
  check('only the SHA-256 hash is stored (never the raw token)', inviteDocs[0]?.tokenHash === sha256(adminRawToken) && inviteDocs[0]?.tokenHash !== adminRawToken, 'hash mismatch');
  check('the stored hash is 64 hex chars (no plaintext)', /^[a-f0-9]{64}$/.test(inviteDocs[0]?.tokenHash || ''), String(inviteDocs[0]?.tokenHash).slice(0, 20));

  r = await req('POST', `/admin-applications/${appId}/approve`, { token: OWNER });
  check('duplicate approval → 409 ALREADY_APPROVED', r.status === 409 && r.json?.code === 'ALREADY_APPROVED', `${r.status} ${r.json?.code}`);
  check('duplicate approval minted no second invitation', (await Invitation.countDocuments({ recipientEmail: applicantEmail })) === 1);
  r = await req('POST', `/admin-applications/${appId}/reject`, { token: OWNER, body: { reason: 'Changed my mind about this candidate.' } });
  check('reject-after-approve → 409 (one-way review)', r.status === 409, `${r.status} ${r.json?.code}`);

  console.log('\n— 7-9 · ADMIN OPENS THE INVITATION AND ACTIVATES (ADM-… IDENTITY) —');
  r = await req('GET', `/invitations/${adminRawToken}`);
  check('invitation landing → 200 for the invited admin', r.status === 200 && r.json?.invitation?.recipientEmail === applicantEmail, `${r.status}`);
  check('landing reports role admin and the pending status', r.json?.invitation?.role === 'admin' && r.json?.invitation?.status === 'INVITED');
  check('landing never leaks the token hash or the raw token', !JSON.stringify(r.json || {}).includes('tokenHash') && !JSON.stringify(r.json || {}).includes(adminRawToken));

  r = await req('POST', `/invitations/${adminRawToken}/activate`, { body: { password: 'weak' } });
  check('weak password refused → 422 without consuming the token', r.status === 422 && (await Invitation.findById(inviteDocs[0]._id).lean()).status === 'INVITED', `${r.status}`);

  r = await req('POST', `/invitations/${adminRawToken}/activate`, {
    body: { password: adminPass, role: 'customer', isOwner: true, name: 'Injected Name' },
  });
  check('activation succeeds ignoring client role/owner → 201', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  const adminAccount = r.json?.account || {};
  check('activated account carries an ADM- staff identity', /^ADM-/.test(adminAccount.staffId || ''), adminAccount.staffId);
  check('activated account role is administrator', adminAccount.role === 'admin', JSON.stringify(adminAccount).slice(0, 140));
  const createdAdmin = await User.findOne({ email: applicantEmail }).lean();
  check('created account is ACTIVE, real (non-fixture) and not an owner', createdAdmin?.status === 'ACTIVE' && createdAdmin?.isFixture === false && createdAdmin?.isOwner === false, JSON.stringify({ s: createdAdmin?.status, f: createdAdmin?.isFixture, o: createdAdmin?.isOwner }));
  check('the name comes from the application, not the client payload', createdAdmin?.name === 'Devika Menon', createdAdmin?.name);
  check('the invitation is consumed exactly once', (await Invitation.findById(inviteDocs[0]._id).lean()).status === 'ACTIVE');
  r = await req('POST', `/invitations/${adminRawToken}/activate`, { body: { password: adminPass } });
  check('re-activation with the same token → 409 (single-use)', r.status === 409 && r.json?.code === 'INVITATION_ALREADY_ACTIVATED', `${r.status} ${r.json?.code}`);

  console.log('\n— 10-11 · THE NEW ADMIN SIGNS IN AND REACHES THE ADMIN PORTAL —');
  r = await req('POST', '/auth/login', { body: { email: applicantEmail, password: adminPass, portal: 'owner' } });
  check('the new admin is REFUSED the Owner Portal → 403', r.status === 403 && r.json?.code === 'PORTAL_FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: applicantEmail, password: adminPass, portal: 'admin' } });
  const ADMIN = r.json?.token;
  check('the new admin signs in at /admin/login → 200', r.status === 200 && r.json?.user?.portal === 'admin', `${r.status}`);
  check('admin session lands on /admin/dashboard', r.json?.redirectTo === '/admin/dashboard', r.json?.redirectTo);
  r = await req('GET', '/admin/staff', { token: ADMIN });
  check('admin reaches the staff console → 200', r.status === 200, `${r.status}`);

  console.log('\n— 12-14 · ADMIN INVITES A HANDLER; HANDLER ACTIVATES (HND-…) —');
  r = await req('POST', '/admin/invitations', { token: ADMIN, body: { name: 'Nope Admin', email: `nope-${stamp}@personnel.test`, role: 'admin' } });
  check('admin cannot mint an ADMIN invitation → 422', r.status === 422, `${r.status} ${r.json?.code}`);

  r = await req('POST', '/admin/invitations', { token: ADMIN, body: { name: 'Tanvi Kulkarni', email: handlerEmail, department: 'Packaging' } });
  check('admin invites a HANDLER → 201 with the one-time link', r.status === 201 && /\/admin\/activate\//.test(r.json?.link || ''), `${r.status}`);
  const handlerRawToken = tokenFrom(r.json?.link);
  const handlerInviteDocId = r.json?.invitation?.id;
  const handlerInvite = await Invitation.findById(handlerInviteDocId).lean();
  check('handler invitation role is fixed to handler', handlerInvite?.role === 'handler', handlerInvite?.role);
  check('handler invitation stores only the hash', handlerInvite?.tokenHash === sha256(handlerRawToken), 'hash mismatch');

  r = await req('POST', `/invitations/${handlerRawToken}/activate`, { body: { password: handlerPass } });
  check('handler activates → 201', r.status === 201, `${r.status}`);
  const handlerAccount = r.json?.account || {};
  check('handler receives an HND- staff identity', /^HND-/.test(handlerAccount.staffId || ''), handlerAccount.staffId);
  check('handler account role is handler', handlerAccount.role === 'handler', handlerAccount.role);
  const handlerUserId = (await User.findOne({ email: handlerEmail }).lean())?._id;

  console.log('\n— 15-16 · HANDLER SIGNS IN AT /staff/login —');
  r = await req('POST', '/auth/login', { body: { email: handlerEmail, password: handlerPass, portal: 'admin' } });
  check('handler is REFUSED the Administrator Portal → 403', r.status === 403 && r.json?.code === 'PORTAL_FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: handlerEmail, password: handlerPass, portal: 'staff' } });
  const HANDLER = r.json?.token;
  check('handler signs in at /staff/login → 200', r.status === 200 && r.json?.user?.portal === 'staff', `${r.status}`);
  check('handler session lands on /staff/dashboard', r.json?.redirectTo === '/staff/dashboard', r.json?.redirectTo);

  console.log('\n— 17 · HANDLER CANNOT REACH STAFF MANAGEMENT OR OWNER CONTROLS —');
  r = await req('GET', '/admin/staff', { token: HANDLER });
  check('handler cannot read the staff directory → 403', r.status === 403, `${r.status}`);
  r = await req('POST', `/admin/staff/${handlerUserId}/suspend`, { token: HANDLER, body: { reason: 'Nope' } });
  check('handler cannot suspend anyone → 403', r.status === 403, `${r.status}`);
  r = await req('POST', '/admin/invitations', { token: HANDLER, body: { name: 'Another', email: `another-${stamp}@personnel.test` } });
  check('handler cannot invite staff → 403', r.status === 403, `${r.status}`);
  r = await req('GET', '/admin/invitations', { token: HANDLER });
  check('handler cannot read the invitation ledger → 403', r.status === 403, `${r.status}`);
  r = await req('GET', '/owner/administrators', { token: HANDLER });
  check('handler cannot access the owner directory → 403', r.status === 403, `${r.status}`);
  r = await req('POST', `/admin-applications/${appId}/approve`, { token: HANDLER });
  check('handler cannot approve applications → 403', r.status === 403, `${r.status}`);

  console.log('\n— 18-19 · OWNER SEES THE ADMIN; ADMIN SEES THE HANDLER —');
  r = await req('GET', '/owner/administrators', { token: OWNER });
  const dir = r.json?.administrators || [];
  check('owner lists administrators → 200', r.status === 200 && Array.isArray(dir), `${r.status}`);
  check('the newly activated administrator appears in the directory', dir.some((a) => a.email === applicantEmail && a.status === 'ACTIVE'), JSON.stringify(dir.map((a) => a.email)));
  check('the owner account is flagged isOwner', dir.some((a) => a.isOwner === true));
  check('directory counts expose the owner queues', typeof r.json?.counts?.pendingApplications === 'number' && typeof r.json?.counts?.pendingInvitations === 'number', JSON.stringify(r.json?.counts));

  r = await req('GET', `/admin/staff/${String(createdAdmin._id)}`, { token: OWNER });
  check('owner can open an administrator dossier → 200', r.status === 200 && r.json?.member?.email === applicantEmail, `${r.status}`);

  r = await req('GET', '/admin/staff?role=HANDLER', { token: ADMIN });
  check('admin sees the handler in the roster → 200', r.status === 200 && (r.json?.staff || []).some((x) => x.email === handlerEmail && x.role === 'handler'), `${r.status}`);
  r = await req('GET', `/admin/staff/${String(handlerUserId)}`, { token: ADMIN });
  check('admin can open a handler dossier → 200', r.status === 200 && r.json?.member?.role === 'handler');

  console.log('\n— ADMIN DENIED ADMINISTRATOR MANAGEMENT —');
  r = await req('GET', '/owner/administrators', { token: ADMIN });
  check('admin cannot reach the owner administrators directory → 403', r.status === 403, `${r.status}`);
  r = await req('GET', '/owner/overview', { token: ADMIN });
  check('admin cannot reach the owner overview → 403', r.status === 403, `${r.status}`);
  r = await req('POST', `/admin/staff/${String(peerAdmin._id)}/suspend`, { token: ADMIN, body: { reason: 'Peer demotion' } });
  check('admin cannot suspend a peer administrator → 403 OWNER_REQUIRED', r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin/staff/${String(peerAdmin._id)}/reactivate`, { token: ADMIN });
  check('admin cannot reactivate a peer administrator → 403 OWNER_REQUIRED', r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/admin/staff/${String(peerAdmin._id)}`, { token: ADMIN, body: { department: 'Hijacked' } });
  check('admin cannot edit an administrator profile → 403', r.status === 403, `${r.status} ${r.json?.code}`);

  console.log('\n— ADMIN INVITATION IS OWNER-ONLY: RESEND/REVOKE ESCALATION IS REFUSED —');
  // The admin invitation from step 6 is still live (the account exists, but the
  // guard must fire before any state check). Use a fresh live one to be sure.
  const liveAdminInvite = await Invitation.create({
    recipientEmail: `pending-admin-${stamp}@personnel.test`,
    recipientName: 'Pending Admin',
    role: 'admin',
    inviter: owner._id,
    tokenHash: sha256(crypto.randomBytes(32).toString('hex')),
    expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
    status: 'INVITED',
  });
  r = await req('POST', `/admin/invitations/${liveAdminInvite._id}/resend`, { token: ADMIN });
  check('admin cannot RESEND an administrator invitation → 403 OWNER_REQUIRED', r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin/invitations/${liveAdminInvite._id}/revoke`, { token: ADMIN, body: { reason: 'Nope' } });
  check('admin cannot REVOKE an administrator invitation → 403 OWNER_REQUIRED', r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);
  check('the administrator invitation was left untouched', (await Invitation.findById(liveAdminInvite._id).lean())?.status === 'INVITED');
  r = await req('POST', `/admin/invitations/${liveAdminInvite._id}/resend`, { token: OWNER });
  check('owner CAN resend an administrator invitation → 200', r.status === 200 && /\/admin\/activate\//.test(r.json?.link || ''), `${r.status}`);
  const resentToken = tokenFrom(r.json?.link);
  // And a LIVE invitation row DOES advertise them (so the dossier can act).
  r = await req('GET', '/owner/administrators', { token: OWNER });
  const liveAdminRow = (r.json?.administrators || []).find((a) => a.email === `pending-admin-${stamp}@personnel.test`);
  check('a live administrator invitation appears as an actionable row', liveAdminRow?.kind === 'invitation' && liveAdminRow?.actions?.canResend === true && liveAdminRow?.actions?.canRevoke === true, `row=${JSON.stringify(liveAdminRow)}`.slice(0, 260));
  check('an invitation row carries an honest expiry label', /^Expires/.test(liveAdminRow?.expiresLabel || ''), String(liveAdminRow?.expiresLabel));
  check('an invitation row never exposes a token or hash', !JSON.stringify(liveAdminRow || {}).includes('tokenHash') && !JSON.stringify(liveAdminRow || {}).includes(resentToken));

  r = await req('POST', `/admin/invitations/${liveAdminInvite._id}/revoke`, { token: OWNER, body: { reason: 'Position withdrawn' } });
  check('owner can revoke it → 200', r.status === 200 && r.json?.invitation?.status === 'REVOKED', `${r.status}`);
  r = await req('GET', `/invitations/${resentToken}`);
  check('the revoked link is unusable → 403 INVITATION_REVOKED', r.status === 403 && r.json?.code === 'INVITATION_REVOKED', `${r.status} ${r.json?.code}`);

  // The owner directory carries INVITATION rows for links that have not
  // produced an account yet, each with SERVER-derived lifecycle rights. A
  // revoked invitation must not advertise resend/revoke, or the UI would offer
  // a control the backend refuses.
  r = await req('GET', '/owner/administrators?status=REVOKED', { token: OWNER });
  const revokedRow = (r.json?.administrators || []).find((a) => a.email === `pending-admin-${stamp}@personnel.test`);
  check('owner directory lists the revoked invitation as a row', !!revokedRow && revokedRow.kind === 'invitation', JSON.stringify(revokedRow)?.slice(0, 120));
  check('a revoked invitation row offers no lifecycle actions', revokedRow?.actions?.canResend === false && revokedRow?.actions?.canRevoke === false, JSON.stringify(revokedRow?.actions));

  console.log('\n— RESEND INVALIDATES THE PREVIOUS LINK —');
  r = await req('POST', '/admin/invitations', { token: ADMIN, body: { name: 'Resend Target', email: `resend-${stamp}@personnel.test` } });
  const firstLinkToken = tokenFrom(r.json?.link);
  const resendInviteId = r.json?.invitation?.id;
  r = await req('POST', `/admin/invitations/${resendInviteId}/resend`, { token: ADMIN });
  const secondLinkToken = tokenFrom(r.json?.link);
  check('resend mints a different token', !!firstLinkToken && !!secondLinkToken && firstLinkToken !== secondLinkToken);
  check('the OLD link no longer resolves → 404', (await req('GET', `/invitations/${firstLinkToken}`)).status === 404);
  check('the NEW link resolves → 200', (await req('GET', `/invitations/${secondLinkToken}`)).status === 200);

  console.log('\n— EXPIRY —');
  const expiredToken = crypto.randomBytes(32).toString('hex');
  const expiredInvite = await Invitation.create({
    recipientEmail: `expired-${stamp}@personnel.test`,
    recipientName: 'Expired Person',
    role: 'handler',
    inviter: owner._id,
    tokenHash: sha256(expiredToken),
    expiresAt: new Date(Date.now() - 60 * 1000),
    status: 'INVITED',
  });
  r = await req('GET', `/invitations/${expiredToken}`);
  check('expired invitation → 410 INVITATION_EXPIRED', r.status === 410 && r.json?.code === 'INVITATION_EXPIRED', `${r.status} ${r.json?.code}`);
  check('expiry is persisted lazily (status → EXPIRED)', (await Invitation.findById(expiredInvite._id).lean())?.status === 'EXPIRED');
  r = await req('POST', `/invitations/${expiredToken}/activate`, { body: { password: adminPass } });
  check('an expired invitation cannot activate an account → 410', r.status === 410, `${r.status}`);

  console.log('\n— 20-23 · OWNER SUSPENDS AND REACTIVATES THE ADMINISTRATOR —');
  // A live admin token minted BEFORE the suspension must die on the next call.
  r = await req('GET', '/admin/staff', { token: ADMIN });
  check('the admin token works immediately before suspension', r.status === 200);
  r = await req('POST', `/admin/staff/${String(createdAdmin._id)}/suspend`, { token: OWNER, body: { reason: 'Extended leave', note: 'Cover arranged.' } });
  check('owner suspends the administrator → 200', r.status === 200 && r.json?.member?.status === 'SUSPENDED', `${r.status} ${r.json?.message}`);
  r = await req('GET', '/admin/staff', { token: ADMIN });
  check('the suspended admin\'s existing token is rejected → 403 ACCOUNT_SUSPENDED', r.status === 403 && r.json?.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: applicantEmail, password: adminPass, portal: 'admin' } });
  check('the suspended admin cannot sign in → 403', r.status === 403, `${r.status}`);
  r = await req('GET', '/owner/administrators', { token: OWNER });
  check('the owner directory shows the suspension', (r.json?.administrators || []).some((a) => a.email === applicantEmail && a.status === 'SUSPENDED'), 'not shown');
  check('suspended count reflects reality', r.json?.counts?.suspended >= 1, JSON.stringify(r.json?.counts));

  r = await req('GET', `/admin/staff/${String(createdAdmin._id)}/activity`, { token: OWNER });
  const types = (r.json?.events || []).map((e) => e.type);
  check('the audit timeline records suspension', types.includes('SUSPENDED'), JSON.stringify(types));

  r = await req('POST', `/admin/staff/${String(createdAdmin._id)}/reactivate`, { token: OWNER });
  check('owner reactivates the administrator → 200', r.status === 200 && r.json?.member?.status === 'ACTIVE', `${r.status}`);
  r = await req('POST', '/auth/login', { body: { email: applicantEmail, password: adminPass, portal: 'admin' } });
  const ADMIN2 = r.json?.token;
  check('the reactivated admin can sign in again → 200', r.status === 200, `${r.status}`);
  r = await req('GET', '/admin/staff', { token: ADMIN2 });
  check('and reaches the admin console again → 200', r.status === 200, `${r.status}`);
  r = await req('GET', `/admin/staff/${String(createdAdmin._id)}/activity`, { token: OWNER });
  check('the audit timeline records reactivation', (r.json?.events || []).some((e) => e.type === 'REACTIVATED'));

  console.log('\n— APPLICATION REVIEW: REJECT PATH + OWNER-ONLY GATE —');
  r = await req('POST', '/admin-applications', {
    body: {
      name: 'Rejected Applicant',
      email: `reject-${stamp}@personnel.test`,
      reason: 'I would like to apply please.',
      background: 'Various retail roles over the years.',
      businessName: 'Rejectable Studio',
    },
  });
  const rejectAppId = r.json?.application?.id;
  r = await req('POST', `/admin-applications/${rejectAppId}/reject`, { token: OWNER, body: { reason: 'Not the right fit at this time.' } });
  check('owner rejects an application → 200', r.status === 200 && r.json?.application?.status === 'REJECTED', `${r.status}`);
  check('rejection stored the reviewer and note', !!r.json?.application?.reviewedByName && r.json?.application?.reviewNote === 'Not the right fit at this time.');
  check('a rejected application mints no invitation', (await Invitation.countDocuments({ recipientEmail: `reject-${stamp}@personnel.test` })) === 0);
  r = await req('POST', `/admin-applications/${rejectAppId}/approve`, { token: OWNER });
  check('approving a rejected application → 409 APPLICATION_REJECTED', r.status === 409 && r.json?.code === 'APPLICATION_REJECTED', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin-applications/${rejectAppId}/reject`, { token: OWNER, body: { reason: 'Rejecting this one again for good measure.' } });
  check('rejecting twice → 409 ALREADY_REJECTED', r.status === 409 && r.json?.code === 'ALREADY_REJECTED', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin-applications/${rejectAppId}/approve`, { token: ADMIN2 });
  check('a plain admin cannot approve applications → 403', r.status === 403, `${r.status}`);

  console.log('\n— AUDIT TRAIL COVERS THE WHOLE CHAIN —');
  const eventTypes = new Set((await StaffEvent.find({}).select('type').lean()).map((e) => e.type));
  for (const t of ['ADMIN_APPLICATION_SUBMITTED', 'ADMIN_APPLICATION_APPROVED', 'ADMIN_APPLICATION_REJECTED', 'INVITATION_CREATED', 'ACCOUNT_ACTIVATED', 'LOGIN', 'SUSPENDED', 'REACTIVATED']) {
    check(`audit ledger contains ${t}`, eventTypes.has(t));
  }
  check('the audit ledger stores an actor for owner decisions', !!(await StaffEvent.findOne({ type: 'ADMIN_APPLICATION_APPROVED', actorName: { $ne: '' } }).lean()));
  const anyHashLeak = JSON.stringify(await StaffEvent.find({}).lean()).includes(sha256(adminRawToken));
  check('the audit ledger never stores a token hash', !anyHashLeak);

  console.log(`\nPERSONNEL LIFECYCLE RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) console.log('Failures:\n  - ' + failures.join('\n  - '));
}

try {
  await main();
} finally {
  try { await mongoose.connection.db.dropDatabase(); } catch { /* ignore */ }
  await mongoose.disconnect().catch(() => {});
  await stopTestServer(SERVER, base);
}

if (failed > 0) process.exit(1);
