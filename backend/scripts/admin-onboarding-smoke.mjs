/**
 * Phase 22.4 — CLIENT ADMIN ONBOARDING & WORKSPACE ACTIVATION suite.
 *
 * Proves, against an EMPTY isolated database:
 *   §A INTAKE — business identity (businessName required, preferredSlug
 *     validated: format, reserved routes, already-taken addresses), the
 *     server derives proposedSlug, and intake still creates ONLY a dossier.
 *   §B APPROVE — owner-only approval stamps the approved identity
 *     (workspaceName/workspaceSlug) onto the invitation and creates NO
 *     Workspace yet: an application is not an active shop.
 *   §C ACTIVATION — one transaction provisions Workspace + Admin + Settings,
 *     application → ACTIVATED, account signs in with a display-only
 *     workspace claim, and the new admin reaches operational surfaces but
 *     is refused every owner-governance surface (§26 hierarchy).
 *   §D COLLISION & ROLLBACK — a slug taken between approval and activation
 *     aborts with 409 WORKSPACE_SLUG_TAKEN and returns the invitation to
 *     INVITED (no partial Workspace/User/Settings); invalid alternatives
 *     are refused actionably; a valid alternative slug succeeds.
 *   §E TWO WORKSPACES — business A and business B provision independent
 *     workspaces with independent settings identities.
 *   §F PUBLIC DIRECTORY — GET /api/shops/:slug resolves ACTIVE shops only.
 *   §G SECURITY — client-supplied workspaceId/role/isOwner/status/staffId
 *     are never honoured; responses never leak passwords/tokens/hashes.
 *
 * Isolation: own server (port 4105), own DB (Flora-Alchemy-Test-
 * AdminOnboarding), SEED_ON_START=false. The suite cleans up everything it
 * created — no QA data left behind.
 *
 * Run: node scripts/admin-onboarding-smoke.mjs
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
import Workspace from '../models/Workspace.js';
import Settings from '../models/Settings.js';
import Product from '../models/Product.js';
import Collection from '../models/Collection.js';
import Inventory from '../models/Inventory.js';
import Wishlist from '../models/Wishlist.js';

const DB_NAME = 'Flora-Alchemy-Test-AdminOnboarding';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

// ── Deterministic start: drop the dedicated test DB, pre-build indexes ──
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  User.init(),
  Customer.init(),
  Invitation.init(),
  AdminApplication.init(),
  Notification.init(),
  StaffEvent.init(),
  Workspace.init(),
  Settings.init(),
]);

const stamp = Date.now();
const ownerPassword = `Owner-Passw0rd-${stamp}!`;
const admin1Password = `Admin1-Passw0rd-${stamp}!`;
const admin2Password = `Admin2-Passw0rd-${stamp}!`;
const admin3Password = `Admin3-Passw0rd-${stamp}!`;
const admin4Password = `Admin4-Passw0rd-${stamp}!`;
const handlerPassword = `Handler-Passw0rd-${stamp}!`;

const owner = await User.create({
  email: `owner-${stamp}@onboarding.test`,
  passwordHash: await bcrypt.hash(ownerPassword, 12),
  role: 'admin',
  name: 'Onboarding Owner',
  isFixture: false,
  isOwner: true,
});

const { child: SERVER, base } = await bootTestServer({
  port: 4105,
  db: DB_NAME,
  extraEnv: {
    SEED_ON_START: 'false',
    RATE_LIMIT_LOGIN_FAILED_MAX: '5000',
    RATE_LIMIT_API_WRITE_MAX: '5000',
    RATE_LIMIT_APPLICATION_MAX: '5000',
    RATE_LIMIT_INVITATION_MAX: '5000',
  },
  label: 'admin-onboarding-smoke',
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

async function login(email, password, portal) {
  const r = await req('POST', '/auth/login', { body: { email, password, ...(portal ? { portal } : {}) } });
  return { token: r.json?.token || null, user: r.json?.user || null, status: r.status, redirectTo: r.json?.redirectTo };
}

function tokenFrom(link) {
  const m = String(link || '').match(/\/admin\/activate\/(.+)$/);
  return m ? m[1] : null;
}

function submission({ name, email, businessName, preferredSlug, reason, background, phone = '9876543210' }) {
  return {
    name,
    email,
    phone,
    reason: reason || 'I want to steward the operations console for this business.',
    background: background || 'Years of retail operations, fulfilment and studio coordination.',
    ...(businessName ? { businessName } : {}),
    ...(preferredSlug ? { preferredSlug } : {}),
  };
}

async function approve(email, OWNER) {
  const list = await req('GET', `/admin-applications?q=${encodeURIComponent(email)}`, { token: OWNER });
  const app = (list.json?.applications || []).find((a) => a.email === email);
  if (!app) return { appId: null, link: null };
  const r = await req('POST', `/admin-applications/${app.id}/approve`, { token: OWNER, body: { note: 'Reviewed and approved.' } });
  return { appId: app.id, link: r.json?.link || null, status: r.status, app: r.json?.application };
}

async function main() {
  const OWNER = (await login(owner.email, ownerPassword))?.token;
  check('owner signs in', !!OWNER);

  // ══════════ §A — PUBLIC INTAKE WITH BUSINESS IDENTITY ══════════
  console.log('\n— §A INTAKE (business name + workspace address) —');
  const app1Email = `asha-${stamp}@onboarding.test`;
  let r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Asha Rao', email: app1Email, businessName: 'Asha Resin Studio' }),
  });
  check('valid intake with businessName → 201', r.status === 201 && !!r.json?.application?.id, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  check('server derives proposedSlug from the business name',
    r.json?.application?.proposedSlug === 'asha-resin-studio', r.json?.application?.proposedSlug);
  check('businessName is echoed to the applicant',
    r.json?.application?.businessName === 'Asha Resin Studio', r.json?.application?.businessName);
  const submitBody = JSON.stringify(r.json || {});
  check('intake response carries no JWT', !submitBody.includes('eyJ'), submitBody.slice(0, 200));
  check('intake response carries no password/role/isOwner field',
    !submitBody.includes('"password') && !submitBody.includes('"role') && !submitBody.includes('"isOwner'), submitBody.slice(0, 200));
  const app1Id = r.json?.application?.id;

  const app2Email = `aurora-${stamp}@onboarding.test`;
  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Meera Shah', email: app2Email, businessName: 'Aurora Blooms', preferredSlug: 'aurora-keepsakes' }),
  });
  check('explicit preferredSlug is accepted → 201', r.status === 201, `${r.status}`);
  check('proposedSlug honours the explicit preferredSlug',
    r.json?.application?.proposedSlug === 'aurora-keepsakes' && r.json?.application?.preferredSlug === 'aurora-keepsakes',
    JSON.stringify({ p: r.json?.application?.proposedSlug, f: r.json?.application?.preferredSlug }));

  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'No Business', email: `nobiz-${stamp}@onboarding.test` }),
  });
  check('missing businessName → 422 VALIDATION_ERROR',
    r.status === 422 && r.json?.code === 'VALIDATION_ERROR', `${r.status} ${r.json?.code}`);

  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Short Biz', email: `shortbiz-${stamp}@onboarding.test`, businessName: 'A' }),
  });
  check('businessName shorter than 2 chars → 422', r.status === 422, `${r.status}`);

  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Bad Slug', email: `badslug-${stamp}@onboarding.test`, businessName: 'Bad Slug Studio', preferredSlug: 'Not A Slug!' }),
  });
  check('malformed preferredSlug → 422 INVALID_SLUG',
    r.status === 422 && r.json?.code === 'INVALID_SLUG', `${r.status} ${r.json?.code}`);

  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Reserved Slug', email: `reserved-${stamp}@onboarding.test`, businessName: 'Reserved Studio', preferredSlug: 'admin' }),
  });
  check('reserved route slug (admin) → 422 INVALID_SLUG',
    r.status === 422 && r.json?.code === 'INVALID_SLUG', `${r.status} ${r.json?.code}`);

  await Workspace.create({ slug: 'taken-shop', displayName: 'Already Trading', status: 'ACTIVE' });
  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Taken Slug', email: `takenslug-${stamp}@onboarding.test`, businessName: 'Taken Address Co', preferredSlug: 'taken-shop' }),
  });
  check('preferredSlug already in use → 409 SLUG_TAKEN',
    r.status === 409 && r.json?.code === 'SLUG_TAKEN', `${r.status} ${r.json?.code}`);

  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Asha Rao', email: app1Email, businessName: 'Asha Resin Studio' }),
  });
  check('duplicate open application → 409 DUPLICATE_APPLICATION',
    r.status === 409 && r.json?.code === 'DUPLICATE_APPLICATION', `${r.status} ${r.json?.code}`);

  const wsCountAfterIntake = await Workspace.countDocuments({});
  check('intake created NO workspace (application ≠ shop)', wsCountAfterIntake === 1, String(wsCountAfterIntake));
  check('intake created NO account', (await User.countDocuments({ email: app1Email })) === 0);

  // ══════════ §A.2 — OPTIONAL SHOP ADDRESS (blank derives, collisions resolve) ══════════
  // The preferred shop address is a PREFERENCE, never a requirement. Blank must
  // always submit; a derived address that collides must resolve deterministically
  // instead of blocking the applicant, and must never touch the shop that
  // already holds the address. This section creates NO Workspace, so the
  // counting assertions around it stay valid.
  console.log('\n— §A.2 OPTIONAL ADDRESS (blank, derivation, collisions) —');

  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Blank Address', email: `blank-${stamp}@onboarding.test`, businessName: 'Petal & Preserve' }),
  });
  check('blank shop address still submits → 201', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  check('“&” reads as the word and: Petal & Preserve → petal-and-preserve',
    r.json?.application?.proposedSlug === 'petal-and-preserve', r.json?.application?.proposedSlug);
  check('a derived address is reported as auto-generated with no stored preference',
    r.json?.application?.slugAutoGenerated === true && r.json?.application?.preferredSlug === '',
    JSON.stringify({ auto: r.json?.application?.slugAutoGenerated, preferred: r.json?.application?.preferredSlug }));

  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Explicit Address', email: `explicit-${stamp}@onboarding.test`, businessName: 'Aurora Blooms Two', preferredSlug: 'aurora-two' }),
  });
  check('explicit available address → 201 and NOT auto-generated',
    r.status === 201 && r.json?.application?.slugAutoGenerated === false && r.json?.application?.preferredSlug === 'aurora-two',
    `${r.status} ${JSON.stringify(r.json?.application || {}).slice(0, 160)}`);

  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Derived Collision', email: `derivedcollision-${stamp}@onboarding.test`, businessName: 'Taken Shop' }),
  });
  check('derived address colliding with an existing shop resolves instead of blocking',
    r.status === 201 && r.json?.application?.proposedSlug === 'taken-shop-2',
    `${r.status} ${r.json?.application?.proposedSlug}`);
  check('the colliding derived address created no shop and left the existing one untouched',
    (await Workspace.countDocuments({ slug: 'taken-shop' })) === 1 &&
      (await Workspace.countDocuments({ slug: 'taken-shop-2' })) === 0);

  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Fallback Person', email: `fallback-${stamp}@onboarding.test`, businessName: '###' }),
  });
  check('an unusable business name falls back to the applicant name, deterministically',
    r.status === 201 && r.json?.application?.proposedSlug === 'fallback-person',
    `${r.status} ${r.json?.application?.proposedSlug}`);

  // ══════════ §B — OWNER APPROVE STAMPS THE IDENTITY, STILL NO WORKSPACE ══════════
  console.log('\n— §B APPROVE (owner-only, identity stamped, no Workspace) —');
  const handlerEmail = `handler-${stamp}@onboarding.test`;
  await User.create({
    email: handlerEmail,
    passwordHash: await bcrypt.hash(handlerPassword, 12),
    role: 'handler',
    name: 'Ops Handler',
    isFixture: false,
  });
  const HANDLER = (await login(handlerEmail, handlerPassword))?.token;
  const reg = await req('POST', '/auth/register', { body: { name: 'Curious Customer', email: `cust-${stamp}@onboarding.test`, password: 'secret123' } });
  const CUSTOMER = reg.json?.token;

  r = await req('POST', `/admin-applications/${app1Id}/approve`, { token: HANDLER });
  check('handler cannot approve → 403', r.status === 403, `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin-applications/${app1Id}/approve`, { token: CUSTOMER });
  check('customer cannot approve → 403', r.status === 403, `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin-applications/${app1Id}/approve`, { body: { note: 'anon' } });
  check('anonymous approve → 401', r.status === 401, String(r.status));

  const approved = await approve(app1Email, OWNER);
  check('owner approves → one-time link', approved.status === 200 && typeof approved.link === 'string', `${approved.status}`);
  const app1Token = tokenFrom(approved.link);
  check('raw activation token extracted from the one-time link', !!app1Token && app1Token.length === 64, String(app1Token || '').slice(0, 20));

  const invitedDoc = await Invitation.findOne({ recipientEmail: app1Email }).lean();
  check('invitation carries the APPROVED business name',
    invitedDoc?.workspaceName === 'Asha Resin Studio', invitedDoc?.workspaceName);
  check('invitation carries the APPROVED workspace slug',
    invitedDoc?.workspaceSlug === 'asha-resin-studio', invitedDoc?.workspaceSlug);
  check('invitation role is fixed to admin', invitedDoc?.role === 'admin', invitedDoc?.role);
  const wsCountAfterApprove = await Workspace.countDocuments({});
  check('approval created NO workspace yet', wsCountAfterApprove === 1, String(wsCountAfterApprove));
  check('approval created NO account', (await User.countDocuments({ email: app1Email })) === 0);

  r = await req('GET', `/invitations/${app1Token}`);
  const landing = r.json?.invitation || {};
  check('landing → 200 for the recipient', r.status === 200 && landing.recipientEmail === app1Email, `${r.status}`);
  check('landing shows the approved workspace identity',
    landing.workspaceName === 'Asha Resin Studio' && landing.workspaceSlug === 'asha-resin-studio',
    JSON.stringify({ n: landing.workspaceName, s: landing.workspaceSlug }));
  const landingBody = JSON.stringify(r.json || {});
  check('landing never leaks tokenHash or inviter identity',
    !landingBody.includes('tokenHash') && !landingBody.includes(app1Token) && !landingBody.includes('inviter'),
    landingBody.slice(0, 240));
  check('landing moved the dossier APPROVED → INVITED',
    (await AdminApplication.findById(app1Id).lean())?.status === 'INVITED');

  // ══════════ §C — ACTIVATION PROVISIONS WORKSPACE + ADMIN + SETTINGS ══════════
  console.log('\n— §C ACTIVATION (single transaction: Workspace + Admin + Settings) —');
  r = await req('POST', `/invitations/${app1Token}/activate`, { body: { password: 'weak' } });
  check('weak password → 422 without consuming the token',
    r.status === 422 && (await Invitation.findOne({ recipientEmail: app1Email }).lean())?.status === 'INVITED',
    `${r.status}`);

  const attackerWs = await Workspace.create({ slug: `attacker-${stamp}`, displayName: 'Attacker Space', status: 'ACTIVE' });
  r = await req('POST', `/invitations/${app1Token}/activate`, {
    body: {
      password: admin1Password,
      role: 'customer',
      isOwner: true,
      status: 'SUSPENDED',
      staffId: 'HAX-0001',
      name: 'Injected Name',
      workspaceId: attackerWs._id.toString(),
    },
  });
  check('activation → 201', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  const actBody = JSON.stringify(r.json || {});
  check('activation response never echoes the password', !actBody.includes(admin1Password), 'password leaked');
  check('activation response carries no JWT', !actBody.includes('eyJ'), actBody.slice(0, 200));
  check('activation response reports the provisioned workspace',
    r.json?.workspace?.slug === 'asha-resin-studio' && r.json?.workspace?.displayName === 'Asha Resin Studio',
    JSON.stringify(r.json?.workspace));

  const admin1 = await User.findOne({ email: app1Email }).lean();
  const ws1 = await Workspace.findOne({ slug: 'asha-resin-studio' }).lean();
  check('account role is admin (client role ignored)', admin1?.role === 'admin', admin1?.role);
  check('account is NOT an owner (client isOwner ignored)', admin1?.isOwner === false, String(admin1?.isOwner));
  check('account is ACTIVE (client status ignored)', admin1?.status === 'ACTIVE', admin1?.status);
  check('account badge is server-derived ADM- (client staffId ignored)',
    /^ADM-/.test(admin1?.staffId || ''), admin1?.staffId);
  check('account name comes from the application, not the client',
    admin1?.name === 'Asha Rao', admin1?.name);
  check('account is real (non-fixture)', admin1?.isFixture === false, String(admin1?.isFixture));
  check('account belongs to the NEW workspace (never the attacker workspace)',
    !!admin1?.workspaceId && String(admin1.workspaceId) === String(ws1?._id),
    `user=${admin1?.workspaceId} ws=${ws1?._id}`);
  check('workspace exists with the approved slug', !!ws1 && ws1.slug === 'asha-resin-studio', ws1?.slug);
  check('workspace display name is the approved business name',
    ws1?.displayName === 'Asha Resin Studio', ws1?.displayName);
  check('workspace is ACTIVE and non-fixture', ws1?.status === 'ACTIVE' && ws1?.isFixture === false,
    JSON.stringify({ s: ws1?.status, f: ws1?.isFixture }));
  check('workspace is bound to this administrator (primaryAdminId)',
    !!ws1 && String(ws1.primaryAdminId || '') === String(admin1._id), String(ws1?.primaryAdminId));

  const settings1 = await Settings.findOne({ workspaceId: ws1._id }).lean();
  check('workspace settings document exists', !!settings1, 'no settings');
  check('settings key is the workspace slug', settings1?.key === 'asha-resin-studio', settings1?.key);
  check('settings storeName is the business name', settings1?.storeName === 'Asha Resin Studio', settings1?.storeName);
  check('settings document is real (non-fixture)', settings1?.isFixture === false, String(settings1?.isFixture));
  const settingsBody = JSON.stringify(settings1 || {});
  check('settings document never carries platform secrets',
    !/JWT|passwordHash|RAZORPAY|secret/i.test(settingsBody), settingsBody.slice(0, 200));

  check('application dossier moved to ACTIVATED',
    (await AdminApplication.findById(app1Id).lean())?.status === 'ACTIVATED');
  const consumed = await Invitation.findOne({ recipientEmail: app1Email }).lean();
  check('invitation consumed exactly once (ACTIVE + consumedAt)',
    consumed?.status === 'ACTIVE' && !!consumed?.consumedAt, consumed?.status);
  check('owner was notified of the activation',
    !!(await Notification.findOne({ userId: owner._id, type: 'system', title: 'Invitation activated' }).lean()));
  check('audit ledger records ACCOUNT_ACTIVATED',
    !!(await StaffEvent.findOne({ type: 'ACCOUNT_ACTIVATED', recipientEmail: app1Email }).lean()));

  r = await req('POST', `/invitations/${app1Token}/activate`, { body: { password: admin1Password } });
  check('second activation with the same token → 409 (single-use)',
    r.status === 409 && r.json?.code === 'INVITATION_ALREADY_ACTIVATED', `${r.status} ${r.json?.code}`);
  r = await req('GET', `/invitations/${app1Token}`);
  check('landing after activation → 409', r.status === 409, String(r.status));

  console.log('\n— §C SIGN-IN + PORTAL HIERARCHY —');
  let session = await login(app1Email, admin1Password, 'admin');
  check('activated administrator signs in at /admin/login → 200', session.status === 200 && !!session.token, String(session.status));
  check('login lands on /admin/dashboard', session.redirectTo === '/admin/dashboard', session.redirectTo);
  check('session is display-only workspace context (slug + name)',
    session.user?.workspace?.slug === 'asha-resin-studio' && session.user?.workspace?.name === 'Asha Resin Studio',
    JSON.stringify(session.user?.workspace));
  check('session is never an owner', session.user?.isOwner === false, String(session.user?.isOwner));
  const ownerPortal = await login(app1Email, admin1Password, 'owner');
  check('the new admin is REFUSED the Owner Portal → 403',
    ownerPortal.status === 403 && ownerPortal.user === null, String(ownerPortal.status));

  r = await req('GET', '/owner/administrators', { token: session.token });
  check('admin cannot read the owner administrators directory → 403', r.status === 403, `${r.status} ${r.json?.code}`);
  r = await req('GET', '/owner/overview', { token: session.token });
  check('admin cannot read the owner overview → 403', r.status === 403, `${r.status}`);
  r = await req('POST', `/admin-applications/${app1Id}/approve`, { token: session.token });
  check('admin cannot approve applications (owner governance) → 403', r.status === 403, `${r.status} ${r.json?.code}`);

  r = await req('GET', '/admin/staff', { token: session.token });
  check('workspace-scoped admin reads the staff console → 200', r.status === 200, `${r.status}`);
  r = await req('GET', '/orders', { token: session.token });
  check('workspace-scoped admin reads the operational order list → 200', r.status === 200, `${r.status}`);

  console.log('\n— §C HANDLER INVITATION FROM THE NEW ADMIN INHERITS ITS WORKSPACE —');
  const handEmail = `team-${stamp}@onboarding.test`;
  r = await req('POST', '/admin/invitations', { token: session.token, body: { name: 'Team Handler', email: handEmail, department: 'Packing' } });
  check('admin invites a handler → 201', r.status === 201, `${r.status}`);
  const handToken = tokenFrom(r.json?.link);
  r = await req('POST', `/invitations/${handToken}/activate`, { body: { password: handlerPassword } });
  check('handler activation → 201', r.status === 201, `${r.status}`);
  const handUser = await User.findOne({ email: handEmail }).lean();
  check('handler inherits the inviter workspace', !!handUser?.workspaceId && String(handUser.workspaceId) === String(ws1._id),
    String(handUser?.workspaceId));
  check('handler role stays handler', handUser?.role === 'handler', handUser?.role);

  // ══════════ §D — SLUG COLLISION AT ACTIVATION: ABORT + RETRY ══════════
  console.log('\n— §D COLLISION & ROLLBACK (no partial provisioning) —');
  const app3Email = `late-${stamp}@onboarding.test`;
  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Late Racer', email: app3Email, businessName: 'Late Race Shop', preferredSlug: 'late-race-shop' }),
  });
  check('intake for the race scenario → 201', r.status === 201, `${r.status}`);
  const approved3 = await approve(app3Email, OWNER);
  check('owner approves the race scenario', approved3.status === 200, String(approved3.status));
  const app3Token = tokenFrom(approved3.link);
  await Workspace.create({ slug: 'late-race-shop', displayName: 'Someone Else', status: 'ACTIVE' });

  r = await req('POST', `/invitations/${app3Token}/activate`, { body: { password: admin3Password } });
  check('activation with a taken slug → 409 WORKSPACE_SLUG_TAKEN',
    r.status === 409 && r.json?.code === 'WORKSPACE_SLUG_TAKEN', `${r.status} ${r.json?.code}`);
  check('collision leaves the invitation USABLE (INVITED)',
    (await Invitation.findOne({ recipientEmail: app3Email }).lean())?.status === 'INVITED');
  check('collision created NO account', (await User.countDocuments({ email: app3Email })) === 0);
  check('collision left the application un-activated',
    ['APPROVED', 'INVITED'].includes((await AdminApplication.findOne({ email: app3Email }).lean())?.status));
  check('collision created NO partial settings document',
    (await Settings.countDocuments({ key: 'late-race-shop' })) === 0);
  check('the legitimate owner of the slug keeps exactly one workspace',
    (await Workspace.countDocuments({ slug: 'late-race-shop' })) === 1);

  r = await req('POST', `/invitations/${app3Token}/activate`, { body: { password: admin3Password, workspaceSlug: 'Not Valid!' } });
  check('an invalid alternative slug → 422 and the invitation stays INVITED',
    r.status === 422 && (await Invitation.findOne({ recipientEmail: app3Email }).lean())?.status === 'INVITED',
    `${r.status} ${r.json?.code}`);
  r = await req('POST', `/invitations/${app3Token}/activate`, { body: { password: admin3Password, workspaceSlug: 'owner' } });
  check('a reserved alternative slug → 422', r.status === 422 && r.json?.code === 'INVALID_SLUG', `${r.status} ${r.json?.code}`);
  check('still no account after the failed alternatives', (await User.countDocuments({ email: app3Email })) === 0);

  r = await req('POST', `/invitations/${app3Token}/activate`, { body: { password: admin3Password, workspaceSlug: 'sunset-studio' } });
  check('a VALID alternative slug succeeds → 201', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  check('the retry provisioned the suggested address',
    r.json?.workspace?.slug === 'sunset-studio', JSON.stringify(r.json?.workspace));
  const admin3 = await User.findOne({ email: app3Email }).lean();
  const ws3 = await Workspace.findOne({ slug: 'sunset-studio' }).lean();
  check('the retried activation still provisions a full workspace + settings',
    !!ws3 && String(admin3?.workspaceId) === String(ws3._id) && !!(await Settings.findOne({ key: 'sunset-studio' }).lean()),
    `ws=${ws3?._id} user=${admin3?.workspaceId}`);
  check('the alternative workspace display name still uses the approved business name',
    ws3?.displayName === 'Late Race Shop', ws3?.displayName);

  // ══════════ §E — TWO INDEPENDENT WORKSPACES ══════════
  console.log('\n— §E TWO WORKSPACES (independent identities + settings) —');
  const app4Email = `bloom-${stamp}@onboarding.test`;
  r = await req('POST', '/admin-applications', {
    body: submission({ name: 'Bina Das', email: app4Email, businessName: 'Bloom Box Co' }),
  });
  check('second business intake → 201', r.status === 201, `${r.status}`);
  const approved4 = await approve(app4Email, OWNER);
  const app4Token = tokenFrom(approved4.link);
  r = await req('POST', `/invitations/${app4Token}/activate`, { body: { password: admin4Password } });
  check('second business activates → 201', r.status === 201, `${r.status}`);
  const admin4 = await User.findOne({ email: app4Email }).lean();
  const ws4 = await Workspace.findOne({ slug: 'bloom-box-co' }).lean();
  check('second workspace provisioned with its own slug', !!ws4 && ws4.slug === 'bloom-box-co', ws4?.slug);
  check('the two administrators never share a workspace',
    !!admin1?.workspaceId && !!admin4?.workspaceId && String(admin1.workspaceId) !== String(admin4.workspaceId),
    `${admin1?.workspaceId} vs ${admin4?.workspaceId}`);
  const settings4 = await Settings.findOne({ key: 'bloom-box-co' }).lean();
  check('each workspace owns its own settings identity',
    settings4?.storeName === 'Bloom Box Co' && String(settings4?.workspaceId) === String(ws4._id),
    JSON.stringify({ n: settings4?.storeName, w: settings4?.workspaceId }));
  check('settings count matches provisioned workspaces (direct doubles have none)',
    (await Settings.countDocuments({})) === 3, String(await Settings.countDocuments({})));

  const OWNER_DIR = await req('GET', '/owner/administrators', { token: OWNER });
  const dirRows = OWNER_DIR.json?.administrators || [];
  const rowA = dirRows.find((x) => x.email === app1Email);
  const rowB = dirRows.find((x) => x.email === app4Email);
  check('owner directory shows administrator A with its workspace',
    rowA?.kind === 'user' && rowA?.workspace?.slug === 'asha-resin-studio' && rowA?.status === 'ACTIVE',
    JSON.stringify(rowA).slice(0, 220));
  check('owner directory shows administrator B with its workspace',
    rowB?.kind === 'user' && rowB?.workspace?.slug === 'bloom-box-co', JSON.stringify(rowB).slice(0, 220));
  check('owner directory rows link back to the source application',
    typeof rowA?.applicationId === 'string' && rowA.applicationId.length > 10, String(rowA?.applicationId));
  check('owner directory still lists the owner account as owner',
    dirRows.some((x) => x.isOwner === true));
  check('the still-pending application is NOT an administrators row',
    !dirRows.some((x) => x.email === app2Email),
    JSON.stringify(dirRows.filter((x) => x.email === app2Email)).slice(0, 160));
  check('the pending application is counted in the owner queues instead',
    (OWNER_DIR.json?.counts?.pendingApplications || 0) >= 1,
    JSON.stringify(OWNER_DIR.json?.counts));

  // ══════════ §F — PUBLIC SHOP DIRECTORY ══════════
  console.log('\n— §F PUBLIC DIRECTORY (GET /api/shops/:slug) —');
  r = await req('GET', '/shops/asha-resin-studio');
  check('active workspace resolves publicly → 200',
    r.status === 200 && r.json?.shop?.displayName === 'Asha Resin Studio', `${r.status} ${JSON.stringify(r.json)}`);
  r = await req('GET', '/shops/no-such-shop');
  check('unknown slug → 404 SHOP_NOT_FOUND', r.status === 404 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status}`);
  r = await req('GET', '/shops/..%2F..%2Fetc%2Fpasswd');
  check('path-traversal slug → 404 (never 500)', r.status === 404, String(r.status));
  await Workspace.updateOne({ _id: ws4._id }, { $set: { status: 'SUSPENDED', statusChangedAt: new Date() } });
  r = await req('GET', '/shops/bloom-box-co');
  check('suspended workspace disappears from the public directory → 404', r.status === 404, String(r.status));

  // ══════════ §F2 — PUBLIC SHOP STOREFRONT (workspace-scoped catalogue) ═════
  console.log('\n— §F2 PUBLIC SHOP STOREFRONT (per-workspace catalogue hydration) —');
  await Product.create([
    { slug: `asha-bloom-${stamp}`, name: 'Asha Bloom', price: 1200, description: 'A', visibility: 'Visible', workspaceId: ws1._id, isFixture: false },
    { slug: `sunset-bloom-${stamp}`, name: 'Sunset Bloom', price: 1500, description: 'B', visibility: 'Visible', workspaceId: ws3._id, isFixture: false },
    { slug: `asha-hidden-${stamp}`, name: 'Asha Hidden', price: 900, description: 'C', visibility: 'Hidden', workspaceId: ws1._id, isFixture: false },
  ]);
  await Collection.create([
    { slug: `asha-coll-${stamp}`, name: 'Asha Collection', visibility: 'Visible', workspaceId: ws1._id },
    { slug: `sunset-coll-${stamp}`, name: 'Sunset Collection', visibility: 'Visible', workspaceId: ws3._id },
  ]);
  await Inventory.create([{ productSlug: `asha-bloom-${stamp}`, currentStock: 4, workspaceId: ws1._id }]);

  let sp = await req('GET', '/shops/asha-resin-studio/products');
  const aSlugs = (sp.json?.products || []).map((x) => x.slug);
  const firstProd = sp.json?.products?.[0] || {};
  check('shop products: active slug resolves its own product → 200',
    sp.status === 200 && aSlugs.includes(`asha-bloom-${stamp}`), `${sp.status} ${JSON.stringify(aSlugs)}`);
  check('shop products: a Hidden product is never exposed', !aSlugs.includes(`asha-hidden-${stamp}`), JSON.stringify(aSlugs));
  check('shop products: another workspace product is never exposed', !aSlugs.includes(`sunset-bloom-${stamp}`), JSON.stringify(aSlugs));
  check('shop products: raw inventory quantities are never exposed',
    !('stock' in firstProd) && !('reorderLevel' in firstProd), JSON.stringify(firstProd));
  check('shop products: availability is exposed instead of stock', firstProd.inStock === true, JSON.stringify(firstProd));

  sp = await req('GET', '/shops/sunset-studio/products');
  const sSlugs = (sp.json?.products || []).map((x) => x.slug);
  check('changing the URL slug changes the storefront tenant',
    sSlugs.includes(`sunset-bloom-${stamp}`) && !sSlugs.includes(`asha-bloom-${stamp}`), JSON.stringify(sSlugs));

  // Phase 23 — /shop (legacy shared storefront: GET /api/products with no
  // token) vs /shops/:slug (the per-workspace address). The shared storefront is
  // deliberately workspace-agnostic — it is the deployment-wide storefront of a
  // single-workspace platform (see utils/catalogueContext.js) — but it must
  // obey the SAME visibility rule, so it can never become a second source of
  // truth that exposes Hidden catalogue entries.
  const shared = await req('GET', '/products');
  const sharedSlugs = (shared.json?.products || []).map((x) => x.slug);
  check('shared storefront (/shop) is the Visible union across addresses',
    shared.status === 200 && sharedSlugs.includes(`asha-bloom-${stamp}`) && sharedSlugs.includes(`sunset-bloom-${stamp}`),
    `${shared.status} ${JSON.stringify(sharedSlugs)}`);
  check('shared storefront and slug storefront agree on visibility (no Hidden leak)',
    !sharedSlugs.includes(`asha-hidden-${stamp}`), JSON.stringify(sharedSlugs));
  check('the slug storefront catalogue is the shared storefront scoped to one address',
    aSlugs.length > 0 && aSlugs.every((s) => sharedSlugs.includes(s)),
    JSON.stringify({ aSlugs, sharedSlugs }));

  const sc = await req('GET', '/shops/asha-resin-studio/collections');
  const aColl = (sc.json?.collections || []).map((x) => x.slug);
  check('shop collections: only the resolved workspace\u2019s collections',
    aColl.includes(`asha-coll-${stamp}`) && !aColl.includes(`sunset-coll-${stamp}`), JSON.stringify(aColl));

  r = await req('GET', `/shops/asha-resin-studio/products?workspaceId=${ws3._id.toString()}`);
  const injSlugs = (r.json?.products || []).map((x) => x.slug);
  check('a client-supplied workspaceId cannot switch tenancy',
    injSlugs.includes(`asha-bloom-${stamp}`) && !injSlugs.includes(`sunset-bloom-${stamp}`), JSON.stringify(injSlugs));

  r = await req('GET', '/shops/asha-resin-studio/products', { token: HANDLER });
  const jwtSlugs = (r.json?.products || []).map((x) => x.slug);
  check('public shop reads ignore a staff JWT (slug is the only authority)',
    r.status === 200 && jwtSlugs.includes(`asha-bloom-${stamp}`) && !jwtSlugs.includes(`sunset-bloom-${stamp}`),
    `${r.status} ${JSON.stringify(jwtSlugs)}`);

  r = await req('GET', '/shops/no-such-shop/products');
  check('unknown slug products → 404 SHOP_NOT_FOUND', r.status === 404 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status}`);
  r = await req('GET', '/shops/bloom-box-co/products');
  check('suspended workspace products → 404 (no leak)', r.status === 404, String(r.status));
  r = await req('GET', '/shops/asha-resin-studio/settings');
  check('shop settings expose the resolved workspace store name',
    r.status === 200 && r.json?.settings?.storeName === 'Asha Resin Studio', JSON.stringify(r.json?.settings).slice(0, 160));

  // ══════════ §F3 — WISHLIST TENANCY (one wishlist per customer+workspace) ══
  console.log('\n— §F3 WISHLIST TENANCY (customer keeps an independent wishlist per workspace) —');
  r = await req('POST', `/wishlist/asha-bloom-${stamp}?shop=asha-resin-studio`, { token: CUSTOMER });
  check('wishlist add in workspace A → 200',
    r.status === 200 && r.json?.wishlist?.productIds?.includes(`asha-bloom-${stamp}`),
    `${r.status} ${JSON.stringify(r.json?.wishlist?.productIds)}`);
  r = await req('POST', `/wishlist/sunset-bloom-${stamp}?shop=sunset-studio`, { token: CUSTOMER });
  check('wishlist add in workspace B → 200',
    r.status === 200 && r.json?.wishlist?.productIds?.includes(`sunset-bloom-${stamp}`), `${r.status}`);

  r = await req('GET', '/wishlist?shop=asha-resin-studio', { token: CUSTOMER });
  const wA = r.json?.wishlist?.productIds || [];
  check('workspace A wishlist is isolated to A',
    wA.includes(`asha-bloom-${stamp}`) && !wA.includes(`sunset-bloom-${stamp}`), JSON.stringify(wA));
  r = await req('GET', '/wishlist?shop=sunset-studio', { token: CUSTOMER });
  const wB = r.json?.wishlist?.productIds || [];
  check('workspace B wishlist is isolated to B',
    wB.includes(`sunset-bloom-${stamp}`) && !wB.includes(`asha-bloom-${stamp}`), JSON.stringify(wB));

  const wlA = await Wishlist.countDocuments({ workspaceId: ws1._id });
  const wlB = await Wishlist.countDocuments({ workspaceId: ws3._id });
  check('one customer holds TWO independent wishlist documents', wlA === 1 && wlB === 1, `A=${wlA} B=${wlB}`);
  const wlDup = await Wishlist.aggregate([
    { $group: { _id: { c: '$customerId', w: '$workspaceId' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  check('no duplicate (customerId, workspaceId) wishlists', wlDup.length === 0, JSON.stringify(wlDup));

  r = await req('POST', `/wishlist/asha-bloom-${stamp}?shop=sunset-studio`, {
    token: CUSTOMER,
    body: { workspaceId: ws1._id.toString() },
  });
  check('a forged workspaceId cannot move a product into another workspace wishlist',
    r.status === 404, `${r.status} ${r.json?.code}`);

  // ══════════ §G — OWNER SESSION + GOVERNANCE SCOPE ══════════
  console.log('\n— §G OWNER SESSION (governance scope, display-null workspace) —');
  const ownerSession = await login(owner.email, ownerPassword, 'owner');
  check('owner signs into the Owner Portal → 200', ownerSession.status === 200 && !!ownerSession.token, String(ownerSession.status));
  check('owner lands on /owner/dashboard', ownerSession.redirectTo === '/owner/dashboard', ownerSession.redirectTo);
  check('owner session has NO workspace (platform-level by design)',
    ownerSession.user?.workspace === null, JSON.stringify(ownerSession.user?.workspace));
  r = await req('GET', '/admin-applications', { token: ownerSession.token });
  check('owner reads the applications ledger → 200 with counts',
    r.status === 200 && typeof r.json?.counts?.pending === 'number', `${r.status}`);
  r = await req('GET', '/owner/administrators', { token: HANDLER });
  check('handler cannot read the owner directory → 403', r.status === 403, String(r.status));
  r = await req('GET', '/owner/administrators', { token: CUSTOMER });
  check('customer cannot read the owner directory → 403', r.status === 403, String(r.status));
  r = await req('GET', '/admin-applications', { token: CUSTOMER });
  check('customer cannot read the applications ledger → 403', r.status === 403, String(r.status));

  const actBody2 = JSON.stringify(r.json || {});
  check('error responses carry no credentials', !actBody2.includes('eyJ') && !actBody2.includes('passwordHash'),
    actBody2.slice(0, 200));

  // ── Cleanup: no QA data left behind ──
  try {
    let removed = 0;
    for (const name of ['users', 'workspaces', 'invitations', 'adminapplications', 'notifications', 'staffevents', 'settings', 'customers']) {
      try {
        const res = await mongoose.connection.db.collection(name).deleteMany({});
        removed += res.deletedCount;
      } catch { /* collection may not exist */ }
    }
    console.log(`\n— cleanup: removed ${removed} document(s) from ${DB_NAME} —`);
  } catch (err) {
    console.log(`\n— cleanup skipped (${err.message}) —`);
  }

  console.log(`\nONBOARDING RESULT: ${passed} passed, ${failed} failed`);
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
