/**
 * Phase 20.6.6 — owner ←→ public admin application flow suite.
 *
 * Proves, against an EMPTY isolated database (no seeded fixtures):
 *   §23 PUBLIC INTAKE — anonymous submission creates ONLY an AdminApplication:
 *     no User, no credential, no Invitation, no JWT; client-supplied role /
 *     isOwner / status / userId / password fields are never honoured; field
 *     validation mirrors the documented 422 contract; an open duplicate is
 *     409 DUPLICATE_APPLICATION while a previously REJECTED email may re-apply;
 *     active owners are notified; the StaffEvent ledger records the intake;
 *     every owner-gated endpoint refuses anonymous callers with 401.
 *   §24 OWNER AUTHZ MATRIX — customer / handler / plain-admin sessions all
 *     receive 403 FORBIDDEN on list, dossier, approve and reject, with NO
 *     side effects; only an isOwner administrator may review.
 *   §25 LIFECYCLE — reject validation (422), approve mints exactly ONE
 *     invitation (role FIXED to 'admin', only the SHA-256 hash stored — the
 *     raw token exists once, in the approve response), one-way review decisions
 *     (409 on approve-after-approve / reject-after-approve /
 *     approve-after-reject / reject-after-reject), lazy APPROVED → INVITED on
 *     landing lookup, activation drives the dossier to ACTIVATED and the new
 *     administrator can sign in — but still cannot review; EMAIL_TAKEN aborts
 *     approval with the application left reviewable; dead invitations lazily
 *     reconcile the dossier to EXPIRED.
 *   §26 APPROVE RACE — two concurrent approvals produce exactly ONE 200 + one
 *     409 and exactly ONE invitation for the application.
 *
 * Isolation: own server (port 4100 — 4096 is held by a local proxy controller
 * on some dev machines), own DB (Flora-Alchemy-Test-ApplicationFlow),
 * SEED_ON_START=false so the suite controls every account it asserts on.
 * The suite cleans up everything it created — no QA data left behind.
 *
 * Run: node scripts/application-flow-smoke.mjs
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
import StaffEvent from '../models/StaffEvent.js';

const DB_NAME = 'Flora-Alchemy-Test-ApplicationFlow';

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
await Promise.all([
  User.init(),
  Customer.init(),
  Invitation.init(),
  AdminApplication.init(),
  Notification.init(),
  StaffEvent.init(),
]);

// ── Fixture accounts (created directly; the suite never seeds) ──
const stamp = Date.now();
const ownerPassword = `Owner-Passw0rd-${stamp}!`;
const plainPassword = `Plain-Passw0rd-${stamp}!`;
const handlerPassword = `Handler-Passw0rd-${stamp}!`;
const customerPassword = `Customer-Passw0rd-${stamp}!`;

const owner = await User.create({
  email: `owner-${stamp}@application.test`,
  passwordHash: await bcrypt.hash(ownerPassword, 12),
  role: 'admin',
  name: 'Application Flow Owner',
  isFixture: false,
  isOwner: true,
});
const plainAdmin = await User.create({
  email: `plain-${stamp}@application.test`,
  passwordHash: await bcrypt.hash(plainPassword, 12),
  role: 'admin',
  name: 'Plain Administrator',
  isFixture: false,
  isOwner: false,
});
const handler = await User.create({
  email: `handler-${stamp}@application.test`,
  passwordHash: await bcrypt.hash(handlerPassword, 12),
  role: 'handler',
  name: 'Ops Handler',
  isFixture: false,
  isOwner: false,
});
const customer = await User.create({
  email: `customer-${stamp}@application.test`,
  passwordHash: await bcrypt.hash(customerPassword, 12),
  role: 'customer',
  name: 'Curious Customer',
  isFixture: false,
  isOwner: false,
});

const { child: SERVER, base } = await bootTestServer({
  port: 4100,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'application-flow-smoke',
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

function validSubmission(email, name = 'Test Applicant') {
  return {
    name,
    email,
    phone: '9876543210',
    reason: 'I want to steward the operations console for the atelier.',
    background: 'Five years of retail operations and fulfilment coordination.',
  };
}

async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  return r.json?.token || null;
}

async function main() {
  const OWNER = await login(owner.email, ownerPassword);
  const PLAIN = await login(plainAdmin.email, plainPassword);
  const HANDLER = await login(handler.email, handlerPassword);
  const CUSTOMER = await login(customer.email, customerPassword);
  check('all four fixture sessions issued', !!OWNER && !!PLAIN && !!HANDLER && !!CUSTOMER);

  // ══════════ §23 — PUBLIC INTAKE (anonymous) ══════════
  console.log('\n— §23 PUBLIC INTAKE (anonymous, review record only) —');
  const pubEmail = `pub-${stamp}@application.test`;
  let r = await req('POST', '/admin-applications', { body: validSubmission(pubEmail, 'Public Applicant') });
  check('valid anonymous submit → 201', r.status === 201 && r.json?.success === true, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  check('response identifies the dossier (APP-…)', /^APP-/.test(r.json?.application?.applicationId || ''), r.json?.application?.applicationId);
  check('dossier opens as PENDING_REVIEW', r.json?.application?.status === 'PENDING_REVIEW', r.json?.application?.status);
  const pubId = r.json?.application?.id;
  const submitBody = JSON.stringify(r.json || {});
  check('submit response carries no JWT', !submitBody.includes('eyJ'), submitBody.slice(0, 200));
  check('submit response carries no password field', !submitBody.includes('"password'), submitBody.slice(0, 200));
  check('submit response carries no role/isOwner field', !submitBody.includes('"role') && !submitBody.includes('"isOwner'), submitBody.slice(0, 200));

  check('no User account was created', (await User.countDocuments({ email: pubEmail })) === 0);
  check('no Invitation was created', (await Invitation.countDocuments({ recipientEmail: pubEmail })) === 0);

  // Owner notification + audit ledger.
  const ownerNote = await Notification.findOne({
    userId: owner._id,
    type: 'system',
    title: 'New administrator application',
  }).lean();
  check('active owner was notified of the intake', !!ownerNote && ownerNote.link === '/admin/applications', JSON.stringify(ownerNote || {}).slice(0, 200));
  const intakeEvent = await StaffEvent.findOne({ type: 'ADMIN_APPLICATION_SUBMITTED', recipientEmail: pubEmail }).lean();
  check('StaffEvent ledger recorded ADMIN_APPLICATION_SUBMITTED', !!intakeEvent, 'no event');

  // Privilege fields are never honoured.
  const forgeEmail = `forge-${stamp}@application.test`;
  r = await req('POST', '/admin-applications', {
    body: {
      ...validSubmission(forgeEmail, 'Forged Fields'),
      role: 'admin',
      isOwner: true,
      status: 'APPROVED',
      userId: owner._id.toString(),
      password: 'client-supplied-secret',
    },
  });
  check('submit with forged privilege fields still → 201', r.status === 201, String(r.status));
  check('stored status stays PENDING_REVIEW (never client APPROVED)', r.json?.application?.status === 'PENDING_REVIEW', r.json?.application?.status);
  check('forged submit creates no account and no invitation',
    (await User.countDocuments({ email: forgeEmail })) === 0 &&
    (await Invitation.countDocuments({ recipientEmail: forgeEmail })) === 0);
  check('client-supplied password is never echoed', !JSON.stringify(r.json || {}).includes('client-supplied-secret'));

  // Field validation.
  r = await req('POST', '/admin-applications', { body: { ...validSubmission(`short-name-${stamp}@application.test`), name: 'A' } });
  check('name < 2 chars → 422 VALIDATION_ERROR', r.status === 422 && r.json?.code === 'VALIDATION_ERROR', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/admin-applications', { body: validSubmission('not-an-email') });
  check('invalid email → 422 VALIDATION_ERROR', r.status === 422 && r.json?.code === 'VALIDATION_ERROR', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/admin-applications', { body: { ...validSubmission(`short-reason-${stamp}@application.test`), reason: 'let me in' } });
  check('reason < 10 chars → 422 VALIDATION_ERROR', r.status === 422 && r.json?.code === 'VALIDATION_ERROR', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/admin-applications', { body: { ...validSubmission(`short-bg-${stamp}@application.test`), background: 'short' } });
  check('background < 10 chars → 422 VALIDATION_ERROR', r.status === 422 && r.json?.code === 'VALIDATION_ERROR', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/admin-applications', { body: { ...validSubmission(`long-phone-${stamp}@application.test`), phone: '1234567890123456' } });
  check('phone with >15 digits → 422 VALIDATION_ERROR', r.status === 422 && r.json?.code === 'VALIDATION_ERROR', `${r.status} ${r.json?.code}`);
  const rejectedCount = await AdminApplication.countDocuments({ email: { $regex: `-(name|reason|bg)-${stamp}@` } });
  check('validation failures wrote no partial dossier', rejectedCount === 0, String(rejectedCount));

  // Duplicate guard + rejected-then-reapply path.
  r = await req('POST', '/admin-applications', { body: validSubmission(pubEmail) });
  check('second open application for same email → 409 DUPLICATE_APPLICATION', r.status === 409 && r.json?.code === 'DUPLICATE_APPLICATION', `${r.status} ${r.json?.code}`);
  const reapplyEmail = `reapply-${stamp}@application.test`;
  r = await req('POST', '/admin-applications', { body: validSubmission(reapplyEmail) });
  const reapplyId = r.json?.application?.id;
  await AdminApplication.updateOne({ _id: reapplyId }, { $set: { status: 'REJECTED' } });
  r = await req('POST', '/admin-applications', { body: validSubmission(reapplyEmail) });
  check('previously REJECTED email may re-apply → 201', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);

  // Anonymous callers are refused by the owner guards.
  r = await req('GET', '/admin-applications');
  check('anonymous list → 401', r.status === 401, String(r.status));
  r = await req('GET', `/admin-applications/${pubId}`);
  check('anonymous dossier → 401', r.status === 401, String(r.status));
  r = await req('POST', `/admin-applications/${pubId}/approve`);
  check('anonymous approve → 401', r.status === 401, String(r.status));
  r = await req('POST', `/admin-applications/${pubId}/reject`, { body: { reason: 'anonymous attempt should never run' } });
  check('anonymous reject → 401', r.status === 401, String(r.status));
  check('anonymous attempts left the dossier reviewable', (await AdminApplication.findById(pubId).lean())?.status === 'PENDING_REVIEW');

  // ══════════ §24 — OWNER AUTHZ MATRIX ══════════
  console.log('\n— §24 OWNER AUTHZ MATRIX (non-owners are refused, no side effects) —');
  r = await req('GET', '/admin-applications', { token: CUSTOMER });
  check('customer list → 403 FORBIDDEN', r.status === 403 && r.json?.code === 'FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('GET', '/admin-applications', { token: HANDLER });
  check('handler list → 403 FORBIDDEN', r.status === 403 && r.json?.code === 'FORBIDDEN', `${r.status} ${r.json?.code}`);
  r = await req('GET', '/admin-applications', { token: PLAIN });
  check('plain administrator (isOwner:false) list → 403 FORBIDDEN', r.status === 403 && r.json?.code === 'FORBIDDEN', `${r.status} ${r.json?.code}`);

  for (const [label, token] of [['customer', CUSTOMER], ['handler', HANDLER], ['plain admin', PLAIN]]) {
    r = await req('GET', `/admin-applications/${pubId}`, { token });
    check(`${label} dossier → 403`, r.status === 403, String(r.status));
    r = await req('POST', `/admin-applications/${pubId}/approve`, { token });
    check(`${label} approve → 403`, r.status === 403, String(r.status));
    r = await req('POST', `/admin-applications/${pubId}/reject`, { token, body: { reason: 'non-owner rejection attempt' } });
    check(`${label} reject → 403`, r.status === 403, String(r.status));
  }
  check('no non-owner attempt changed the dossier', (await AdminApplication.findById(pubId).lean())?.status === 'PENDING_REVIEW');
  check('no non-owner attempt minted an invitation', (await Invitation.countDocuments({ recipientEmail: pubEmail })) === 0);

  r = await req('GET', '/admin-applications', { token: OWNER });
  check('owner list → 200 with whole-ledger counts',
    r.status === 200 && r.json?.success === true &&
    ['all', 'pending', 'approved', 'invited', 'activated', 'rejected', 'expired'].every((k) => typeof r.json?.counts?.[k] === 'number'),
    `${r.status} ${JSON.stringify(r.json?.counts)}`);

  // ══════════ §25 — REVIEW LIFECYCLE ══════════
  console.log('\n— §25 LIFECYCLE (one-way review, one-time link, activation) —');
  const lifeEmail = `life-${stamp}@application.test`;
  r = await req('POST', '/admin-applications', { body: validSubmission(lifeEmail, 'Lifecycle Applicant') });
  const lifeId = r.json?.application?.id;

  r = await req('GET', `/admin-applications/${lifeId}`, { token: OWNER });
  check('owner dossier → 200, reviewable, no invitation yet',
    r.status === 200 && r.json?.application?.canApprove === true && r.json?.application?.canReject === true && r.json?.invitation === null,
    `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);

  r = await req('POST', `/admin-applications/${lifeId}/reject`, { token: OWNER, body: { reason: 'no' } });
  check('reject reason < 10 chars → 422 VALIDATION_ERROR', r.status === 422 && r.json?.code === 'VALIDATION_ERROR', `${r.status} ${r.json?.code}`);
  check('failed reject validation left it reviewable', (await AdminApplication.findById(lifeId).lean())?.status === 'PENDING_REVIEW');

  const beforeCounts = (await req('GET', '/admin-applications', { token: OWNER })).json?.counts;

  r = await req('POST', `/admin-applications/${lifeId}/approve`, { token: OWNER, body: { note: 'Reviewed and approved.' } });
  check('owner approve → 200 with the one-time link', r.status === 200 && typeof r.json?.link === 'string' && r.json?.link.includes('/admin/activate/'), `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  check('approved dossier reports status APPROVED and no further actions',
    r.json?.application?.status === 'APPROVED' && r.json?.application?.canApprove === false && r.json?.application?.canReject === false,
    JSON.stringify(r.json?.application));
  const rawToken = String(r.json?.link || '').split('/').pop();
  check('approve response minted an invitation id', /^INV-/.test(r.json?.invitation?.invitationId || ''), JSON.stringify(r.json?.invitation));

  const invDocs = await Invitation.find({ recipientEmail: lifeEmail }).lean();
  check('exactly ONE invitation exists for the application', invDocs.length === 1, String(invDocs.length));
  const invDoc = invDocs[0];
  check('invitation role is FIXED to admin', invDoc?.role === 'admin', invDoc?.role);
  check('invitation is linked to the application', String(invDoc?.application) === lifeId, String(invDoc?.application));
  check('invitation stores only the SHA-256 hash', invDoc?.tokenHash === sha256(rawToken) && invDoc?.tokenHash !== rawToken, invDoc?.tokenHash);
  check('raw token is stored NOWHERE', !JSON.stringify(invDoc).includes(rawToken), 'raw token persisted!');
  check('approval recorded ADMIN_APPLICATION_APPROVED + INVITATION_CREATED events',
    !!(await StaffEvent.findOne({ type: 'ADMIN_APPLICATION_APPROVED', recipientEmail: lifeEmail }).lean()) &&
    !!(await StaffEvent.findOne({ type: 'INVITATION_CREATED', recipientEmail: lifeEmail }).lean()));

  const afterCounts = (await req('GET', '/admin-applications', { token: OWNER })).json?.counts;
  check('counts moved exactly: approved +1, pending -1',
    afterCounts.approved === beforeCounts.approved + 1 && afterCounts.pending === beforeCounts.pending - 1,
    `${beforeCounts.approved}→${afterCounts.approved}, ${beforeCounts.pending}→${afterCounts.pending}`);

  r = await req('GET', `/admin-applications/${lifeId}`, { token: OWNER });
  check('dossier after approve shows the live INVITED invitation',
    r.status === 200 && r.json?.invitation?.status === 'INVITED' && r.json?.application?.canApprove === false,
    JSON.stringify(r.json).slice(0, 220));
  const listBody = JSON.stringify((await req('GET', '/admin-applications', { token: OWNER })).json || {});
  check('list/dossier responses never expose tokenHash or a raw token', !listBody.includes('tokenHash') && !listBody.includes(rawToken), 'token material leaked in list');

  r = await req('POST', `/admin-applications/${lifeId}/approve`, { token: OWNER });
  check('second approve → 409 ALREADY_APPROVED', r.status === 409 && r.json?.code === 'ALREADY_APPROVED', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin-applications/${lifeId}/reject`, { token: OWNER, body: { reason: 'trying to reject after approval' } });
  check('reject AFTER approve → 409 APPLICATION_APPROVED', r.status === 409 && r.json?.code === 'APPLICATION_APPROVED', `${r.status} ${r.json?.code}`);

  // Rejection path on a separate dossier.
  const rejEmail = `rej-${stamp}@application.test`;
  r = await req('POST', '/admin-applications', { body: validSubmission(rejEmail, 'Rejectable Applicant') });
  const rejId = r.json?.application?.id;
  const rejectReason = 'Not the right fit for the atelier at this time.';
  r = await req('POST', `/admin-applications/${rejId}/reject`, { token: OWNER, body: { reason: rejectReason } });
  check('owner reject with valid reason → 200', r.status === 200 && r.json?.application?.status === 'REJECTED', `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  const rejDoc = await AdminApplication.findById(rejId).lean();
  check('rejection persisted the reason and reviewer', rejDoc?.reviewNote === rejectReason && String(rejDoc?.reviewedBy) === String(owner._id), JSON.stringify({ n: rejDoc?.reviewNote, b: rejDoc?.reviewedBy }));
  r = await req('POST', `/admin-applications/${rejId}/approve`, { token: OWNER });
  check('approve AFTER reject → 409 APPLICATION_REJECTED', r.status === 409 && r.json?.code === 'APPLICATION_REJECTED', `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin-applications/${rejId}/reject`, { token: OWNER, body: { reason: 'second rejection attempt right here' } });
  check('second reject → 409 ALREADY_REJECTED', r.status === 409 && r.json?.code === 'ALREADY_REJECTED', `${r.status} ${r.json?.code}`);
  check('rejection recorded ADMIN_APPLICATION_REJECTED event', !!(await StaffEvent.findOne({ type: 'ADMIN_APPLICATION_REJECTED', recipientEmail: rejEmail }).lean()));

  // Lazy APPROVED → INVITED happens when the recipient opens the landing link.
  r = await req('GET', `/invitations/${rawToken}`);
  check('landing lookup with the minted token → 200', r.status === 200, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  check('application lazily moved APPROVED → INVITED', (await AdminApplication.findById(lifeId).lean())?.status === 'INVITED', (await AdminApplication.findById(lifeId).lean())?.status);

  // Activation drives the dossier to ACTIVATED and the account can sign in —
  // as an administrator, never as an owner.
  const chosenPassword = `Activated-Passw0rd-${stamp}!`;
  r = await req('POST', `/invitations/${rawToken}/activate`, { body: { password: chosenPassword, isOwner: true } });
  check('activation with the minted token → 201', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  check('application moved to ACTIVATED', (await AdminApplication.findById(lifeId).lean())?.status === 'ACTIVATED', (await AdminApplication.findById(lifeId).lean())?.status);
  const activatedUser = await User.findOne({ email: lifeEmail }).lean();
  check('created account is a non-owner administrator', activatedUser?.role === 'admin' && activatedUser?.isOwner === false, JSON.stringify({ r: activatedUser?.role, o: activatedUser?.isOwner }));

  const ACTIVATED_TOKEN = await login(lifeEmail, chosenPassword);
  check('activated administrator signs in through the existing login', !!ACTIVATED_TOKEN);
  r = await req('GET', '/admin-applications', { token: ACTIVATED_TOKEN });
  check('administrator WITHOUT isOwner still cannot review applications → 403', r.status === 403 && r.json?.code === 'FORBIDDEN', `${r.status} ${r.json?.code}`);

  // Email-taken refusal aborts the transaction: the claim rolls back, so the
  // application stays reviewable (and no invitation is ever minted).
  const takenEmail = `taken-${stamp}@application.test`;
  r = await req('POST', '/admin-applications', { body: validSubmission(takenEmail, 'Taken Email Applicant') });
  const takenId = r.json?.application?.id;
  await User.create({
    email: takenEmail,
    passwordHash: await bcrypt.hash(`Taken-Passw0rd-${stamp}!`, 12),
    role: 'admin',
    name: 'Existing Account',
    isFixture: false,
    isOwner: false,
  });
  r = await req('POST', `/admin-applications/${takenId}/approve`, { token: OWNER });
  check('approve with an existing account email → 409 EMAIL_TAKEN', r.status === 409 && r.json?.code === 'EMAIL_TAKEN', `${r.status} ${r.json?.code}`);
  check('EMAIL_TAKEN rolled back the claim (still reviewable)', ['SUBMITTED', 'PENDING_REVIEW'].includes((await AdminApplication.findById(takenId).lean())?.status), (await AdminApplication.findById(takenId).lean())?.status);
  check('EMAIL_TAKEN minted no invitation', (await Invitation.countDocuments({ recipientEmail: takenEmail })) === 0);

  // Dead invitations lazily reconcile dossiers to EXPIRED before owner reads.
  const expApp = await AdminApplication.create({
    applicationId: `APP-EXPIRED-${stamp}`,
    name: 'Expired Applicant',
    email: `exp-${stamp}@application.test`,
    phone: '',
    reason: 'Approved once but the invitation died of old age.',
    background: 'Operations background in retail and fulfilment coordination.',
    status: 'APPROVED',
  });
  await Invitation.create({
    recipientEmail: expApp.email,
    recipientName: expApp.name,
    role: 'admin',
    inviter: owner._id,
    application: expApp._id,
    tokenHash: sha256(crypto.randomBytes(32).toString('hex')),
    expiresAt: new Date(Date.now() - 60 * 1000),
    status: 'EXPIRED',
  });
  r = await req('GET', '/admin-applications', { token: OWNER });
  check('dead invitation lazily reconciled the dossier to EXPIRED', (await AdminApplication.findById(expApp._id).lean())?.status === 'EXPIRED', (await AdminApplication.findById(expApp._id).lean())?.status);
  check('counts.expired reflects the reconciled dossier', (r.json?.counts?.expired || 0) >= 1, JSON.stringify(r.json?.counts));

  // ══════════ §26 — APPROVE RACE (single winner) ══════════
  console.log('\n— §26 APPROVE RACE (two concurrent approvals, one invitation) —');
  const raceEmail = `race-${stamp}@application.test`;
  r = await req('POST', '/admin-applications', { body: validSubmission(raceEmail, 'Race Applicant') });
  const raceId = r.json?.application?.id;
  const [a1, a2] = await Promise.all([
    req('POST', `/admin-applications/${raceId}/approve`, { token: OWNER }),
    req('POST', `/admin-applications/${raceId}/approve`, { token: OWNER }),
  ]);
  const statuses = [a1.status, a2.status].sort((x, y) => x - y);
  check('race produces exactly one 200 and one 409', statuses[0] === 200 && statuses[1] === 409, JSON.stringify(statuses));
  const winner = a1.status === 200 ? a1 : a2;
  const loser = a1.status === 200 ? a2 : a1;
  check('loser answered a clean 409 (ALREADY_APPROVED or CONFLICT)', ['ALREADY_APPROVED', 'CONFLICT'].includes(loser.json?.code), `${loser.status} ${loser.json?.code}`);
  check('exactly ONE response carried the one-time link',
    typeof winner.json?.link === 'string' && typeof loser.json?.link === 'undefined');
  const raceInvites = await Invitation.find({ recipientEmail: raceEmail }).lean();
  check('exactly ONE invitation exists for the raced application', raceInvites.length === 1, String(raceInvites.length));
  check('raced application settled on APPROVED', (await AdminApplication.findById(raceId).lean())?.status === 'APPROVED', (await AdminApplication.findById(raceId).lean())?.status);

  // ── Cleanup: no QA data left behind ──
  try {
    const delUsers = await mongoose.connection.db.collection('users').deleteMany({});
    const delInvites = await mongoose.connection.db.collection('invitations').deleteMany({});
    const delApps = await mongoose.connection.db.collection('adminapplications').deleteMany({});
    const delNotes = await mongoose.connection.db.collection('notifications').deleteMany({});
    const delEvents = await mongoose.connection.db.collection('staffevents').deleteMany({});
    const delCustomers = await mongoose.connection.db.collection('customers').deleteMany({});
    console.log(`\n— cleanup: removed ${delUsers.deletedCount} user(s), ${delInvites.deletedCount} invitation(s), ${delApps.deletedCount} application(s), ${delNotes.deletedCount} notification(s), ${delEvents.deletedCount} staff event(s), ${delCustomers.deletedCount} customer profile(s) —`);
  } catch (err) {
    console.log(`\n— cleanup skipped (${err.message}) —`);
  }

  console.log(`\nAPPLICATION FLOW RESULT: ${passed} passed, ${failed} failed`);
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
