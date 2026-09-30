/**
 * Phase 22.2 — TENANT CORE suite.
 *
 * Proves the foundation of workspace tenancy without changing a single
 * existing endpoint's behaviour:
 *
 *   §27 WORKSPACE ENTITY — create/read, slug normalisation + global
 *     uniqueness, displayName required, status enum, toJSON shape; nothing
 *     auto-creates a workspace from a request.
 *   §28 MEMBERSHIP (User.workspaceId) — SPARSE by design: an identity created
 *     without membership has NO field at all (not null); owner and customer
 *     accounts stay unscoped by design; the sparse index exists.
 *   §29 TENANCY HELPERS — getWorkspaceId / workspaceFilter (fails closed with
 *     403 WORKSPACE_REQUIRED) / assertWorkspaceMember (403 WORKSPACE_MISMATCH,
 *     unscoped legacy documents still readable).
 *   §30 requireWorkspace MIDDLEWARE — 401 unauthenticated, 403 for customers,
 *     403 for unscoped staff, 403 for a suspended workspace (re-read per
 *     request), pass-through with req.workspaceId + req.workspaceSlug for an
 *     ACTIVE member. Mounted on the workspace-scoped routers as of Phase 22.3.
 *   §31 CLIENT INJECTION — a workspaceId smuggled into register / login /
 *     createOperator / staff-profile / product-create / invitation-create /
 *     invitation-activation / a query string is never persisted; invitation
 *     binding and activation assignment come from the SERVER side only.
 *     Phase 22.3 adds the gate dimension: an unscoped staff identity now gets
 *     403 WORKSPACE_REQUIRED on gated writes, and a member's write ignores any
 *     client workspaceId (server assigns the caller's own workspace).
 *   §32 BINDING RULES — a handler invitation carries the inviter's workspace
 *     and the activated handler inherits it; an ADMIN invitation never does,
 *     even when the invitation document carries a workspaceId.
 *   §33 GATE WIRING + NO BEHAVIOUR REGRESSION — owner sessions still reach the
 *     §19 surfaces (staff directory, operators), public catalogue/settings
 *     reads are unchanged, all 14 workspace routers MOUNT a requireWorkspace*
 *     gate, server.js itself never names one, and operational surfaces refuse
 *     both the owner (§18) and unscoped staff with 403 WORKSPACE_REQUIRED.
 *   §34 MIGRATION SCRIPT — `--report` is read-only (document counts
 *     unchanged, "NO CHANGES MADE"), `--apply` without --name/--slug is
 *     refused, a PRODUCTION-named database is refused before any connection,
 *     and a guarded apply against this isolated disposable database attaches
 *     staff + operational rows while owner/customer identities stay unscoped.
 *   §35 TENANT AUDIT TOOL — pure scanner unit checks + the real CLI in
 *     --json and --strict modes (exit 0 today, zero plan regressions).
 *
 * Isolation: own server (port 4103), own DB (Flora-Alchemy-Test-TenantCore),
 * SEED_ON_START=false. Nothing here ever touches dev or production data.
 *
 * Run: node scripts/tenant-core-smoke.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';
import { SCOPE_MANIFEST, scanSource, scanAll, groupFindings, isTenantAware } from './lib/tenantAudit.mjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import Collection from '../models/Collection.js';
import Order from '../models/Order.js';
import Inventory from '../models/Inventory.js';
import InventoryMovement from '../models/InventoryMovement.js';
import Conversation from '../models/Conversation.js';
import CustomRequest from '../models/CustomRequest.js';
import Settings from '../models/Settings.js';
import Invitation from '../models/Invitation.js';
import StaffEvent from '../models/StaffEvent.js';
import Notification from '../models/Notification.js';

import { getWorkspaceId, workspaceFilter, assertWorkspaceMember } from '../utils/tenancy.js';
import { requireWorkspace, stripClientWorkspaceId } from '../middleware/workspaceMiddleware.js';
import { ApiError } from '../middleware/errorMiddleware.js';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DB_NAME = 'Flora-Alchemy-Test-TenantCore';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

// ── Deterministic start: drop the dedicated test DB, pre-build indexes ──
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  Workspace.init(),
  User.init(),
  Customer.init(),
  Product.init(),
  Collection.init(),
  Order.init(),
  Inventory.init(),
  InventoryMovement.init(),
  Conversation.init(),
  CustomRequest.init(),
  Settings.init(),
  Invitation.init(),
  StaffEvent.init(),
  Notification.init(),
]);

const stamp = Date.now();
const ownerPassword = `Owner-Passw0rd-${stamp}!`;
const adminPassword = `Admin-Passw0rd-${stamp}!`;
const handlerPassword = `Handler-Passw0rd-${stamp}!`;
const memberPassword = `Member-Passw0rd-${stamp}!`;
const newOpPassword = `Operator-Passw0rd-${stamp}!`;
const activatePassword = `Activate-Passw0rd-${stamp}!`;
const registerPassword = `Register-Passw0rd-${stamp}!`;

// Fixture identities — created directly, never seeded.
const owner = await User.create({
  email: `owner-${stamp}@tenant.test`,
  passwordHash: await bcrypt.hash(ownerPassword, 12),
  role: 'admin',
  name: 'Tenant Core Owner',
  isFixture: false,
  isOwner: true,
});
const plainAdmin = await User.create({
  email: `admin-${stamp}@tenant.test`,
  passwordHash: await bcrypt.hash(adminPassword, 12),
  role: 'admin',
  name: 'Tenant Core Admin',
  isFixture: false,
  isOwner: false,
});
const handler = await User.create({
  email: `handler-${stamp}@tenant.test`,
  passwordHash: await bcrypt.hash(handlerPassword, 12),
  role: 'handler',
  name: 'Tenant Core Handler',
  isFixture: false,
  isOwner: false,
});
const customerUser = await User.create({
  email: `customer-${stamp}@tenant.test`,
  passwordHash: await bcrypt.hash(`Customer-Passw0rd-${stamp}!`, 12),
  role: 'customer',
  name: 'Tenant Core Customer',
  isFixture: false,
  isOwner: false,
});

const { child: SERVER, base } = await bootTestServer({
  port: 4103,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'tenant-core-smoke',
});
const BASE = `${base}/api`;

// One long-lived connection for direct-document assertions.
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

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

async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  return r.json?.token || null;
}

/** Run requireWorkspace against a synthetic request; returns { error, req }. */
async function runRequireWorkspace(user) {
  const fakeReq = user === undefined ? {} : { user };
  let error = null;
  let nextCalled = false;
  await requireWorkspace(fakeReq, {}, (err) => {
    nextCalled = true;
    error = err || null;
  });
  return { nextCalled, error, req: fakeReq };
}

function hasWorkspaceField(doc) {
  return !!doc && Object.prototype.hasOwnProperty.call(doc, 'workspaceId');
}

function spawnScript(scriptRelPath, args, env = {}) {
  return spawnSync(process.execPath, [scriptRelPath, ...args], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      PRODUCTION_DB_NAMES: 'Flora-Alchemy',
      ...env,
    },
  });
}

async function main() {
  // ══════════ §27 — WORKSPACE ENTITY ══════════
  console.log('\n— §27 WORKSPACE ENTITY —');
  const ws = await Workspace.create({ slug: '  Tenant-Core-Salon  ', displayName: '  Tenant Core Salon  ' });
  check('workspace created', !!ws && !!ws.id, JSON.stringify(ws || {}).slice(0, 120));
  check('slug is normalised to lowercase + trimmed', ws.slug === 'tenant-core-salon', ws.slug);
  check('displayName is trimmed', ws.displayName === 'Tenant Core Salon', ws.displayName);
  check('status defaults to ACTIVE', ws.status === 'ACTIVE', ws.status);
  check('toJSON exposes id and hides _id/__v', ws.toJSON().id === String(ws._id) && !('_id' in ws.toJSON()) && !('__v' in ws.toJSON()));

  let dupErr = null;
  try { await Workspace.create({ slug: 'tenant-core-salon', displayName: 'Impostor Salon' }); }
  catch (err) { dupErr = err; }
  check('duplicate slug is rejected (unique index)', dupErr && (dupErr.code === 11000 || dupErr.name === 'MongoServerError'), `${dupErr?.code} ${dupErr?.name}`);

  let invalidStatusErr = null;
  try { await Workspace.create({ slug: 'bad-status-salon', displayName: 'Bad Status', status: 'WHATEVER' }); }
  catch (err) { invalidStatusErr = err; }
  check('invalid status is rejected by the enum', invalidStatusErr && invalidStatusErr.name === 'ValidationError', invalidStatusErr?.name);

  let missingNameErr = null;
  try { await Workspace.create({ slug: 'no-name-salon' }); }
  catch (err) { missingNameErr = err; }
  check('displayName is required', missingNameErr && missingNameErr.name === 'ValidationError', missingNameErr?.name);

  let missingSlugErr = null;
  try { await Workspace.create({ displayName: 'No Slug Salon' }); }
  catch (err) { missingSlugErr = err; }
  check('slug is required', missingSlugErr && missingSlugErr.name === 'ValidationError', missingSlugErr?.name);

  const wsIndexes = await Workspace.collection.indexes();
  check('slug carries a unique index', wsIndexes.some((i) => i.key && i.key.slug === 1 && i.unique), JSON.stringify(wsIndexes.map((i) => i.name)));

  // ══════════ §28 — MEMBERSHIP (sparse) ══════════
  console.log('\n— §28 MEMBERSHIP (User.workspaceId is sparse, server-assigned) —');
  const unscopedAdmin = await User.findOne({ _id: plainAdmin._id }).lean();
  const rawUnscoped = await User.collection.findOne({ _id: plainAdmin._id });
  check('an identity created without membership has NO workspaceId field (not null)', !hasWorkspaceField(rawUnscoped), JSON.stringify(rawUnscoped).slice(0, 200));
  check('lean() reads it back as undefined', unscopedAdmin.workspaceId === undefined, String(unscopedAdmin.workspaceId));
  check('owner account stays unscoped by design', !hasWorkspaceField(await User.collection.findOne({ _id: owner._id })));
  check('customer account stays unscoped by design', !hasWorkspaceField(await User.collection.findOne({ _id: customerUser._id })));

  const member = await User.create({
    email: `member-${stamp}@tenant.test`,
    passwordHash: await bcrypt.hash(memberPassword, 12),
    role: 'handler',
    name: 'Scoped Handler',
    isFixture: false,
    workspaceId: ws._id,
  });
  const rawMember = await User.collection.findOne({ _id: member._id });
  check('membership is persisted when assigned server-side', String(rawMember.workspaceId) === String(ws._id), String(rawMember.workspaceId));
  check('membership round-trips through the model', String((await User.findById(member._id).lean()).workspaceId) === String(ws._id));

  const userIndexes = await User.collection.indexes();
  const wsIndex = userIndexes.find((i) => i.key && i.key.workspaceId === 1);
  check('workspaceId is indexed', !!wsIndex, JSON.stringify(userIndexes.map((i) => i.name)));
  check('workspaceId index is sparse', !!wsIndex && wsIndex.sparse === true, JSON.stringify(wsIndex));

  // ══════════ §29 — TENANCY HELPERS ══════════
  console.log('\n— §29 TENANCY HELPERS —');
  check('getWorkspaceId(null) → null', getWorkspaceId(null) === null);
  check('getWorkspaceId(unscoped) → null', getWorkspaceId(plainAdmin) === null);
  check('getWorkspaceId(string) → ObjectId', String(getWorkspaceId({ workspaceId: String(ws._id) })) === String(ws._id));
  const filter = workspaceFilter(member);
  check('workspaceFilter(member) → { workspaceId }', filter && String(filter.workspaceId) === String(ws._id), JSON.stringify(filter));
  check('workspaceFilter(unscoped, {requireWorkspace:false}) → {} (transitional)', Object.keys(workspaceFilter(plainAdmin, { requireWorkspace: false })).length === 0);
  let wfErr = null;
  try { workspaceFilter(plainAdmin); } catch (err) { wfErr = err; }
  check('workspaceFilter(unscoped) FAILS CLOSED with 403 WORKSPACE_REQUIRED', wfErr instanceof ApiError && wfErr.status === 403 && wfErr.code === 'WORKSPACE_REQUIRED', `${wfErr?.status} ${wfErr?.code}`);
  check('assertWorkspaceMember same workspace → true', assertWorkspaceMember(member, { workspaceId: ws._id }) === true);
  check('assertWorkspaceMember unscoped legacy document → true (not a leak yet)', assertWorkspaceMember(member, {}) === true);
  const otherWs = await Workspace.create({ slug: `other-${stamp}`, displayName: 'Other Salon' });
  let amErr = null;
  try { assertWorkspaceMember(member, { workspaceId: otherWs._id }, { what: 'order' }); } catch (err) { amErr = err; }
  check('assertWorkspaceMember foreign workspace → 403 WORKSPACE_MISMATCH', amErr instanceof ApiError && amErr.status === 403 && amErr.code === 'WORKSPACE_MISMATCH', `${amErr?.code}`);

  // ══════════ §30 — requireWorkspace MIDDLEWARE ══════════
  console.log('\n— §30 requireWorkspace MIDDLEWARE (unit-level: gate decisions) —');
  let r = await runRequireWorkspace(undefined);
  check('no req.user → 401 UNAUTHORIZED', r.error instanceof ApiError && r.error.status === 401 && r.error.code === 'UNAUTHORIZED', `${r.error?.status} ${r.error?.code}`);

  r = await runRequireWorkspace(customerUser);
  check('customer identity → 403 WORKSPACE_FORBIDDEN', r.error instanceof ApiError && r.error.status === 403 && r.error.code === 'WORKSPACE_FORBIDDEN', r.error?.code);

  r = await runRequireWorkspace(plainAdmin);
  check('staff identity with no workspace → 403 WORKSPACE_REQUIRED', r.error instanceof ApiError && r.error.status === 403 && r.error.code === 'WORKSPACE_REQUIRED', r.error?.code);

  r = await runRequireWorkspace({ ...plainAdmin.toObject(), workspaceId: new mongoose.Types.ObjectId() });
  check('membership pointing at a deleted workspace → 403 WORKSPACE_REQUIRED', r.error instanceof ApiError && r.error.code === 'WORKSPACE_REQUIRED', r.error?.code);

  const suspendedWs = await Workspace.create({ slug: `suspended-${stamp}`, displayName: 'Suspended Salon', status: 'SUSPENDED' });
  r = await runRequireWorkspace({ ...plainAdmin.toObject(), workspaceId: suspendedWs._id });
  check('SUSPENDED workspace → 403 WORKSPACE_SUSPENDED', r.error instanceof ApiError && r.error.status === 403 && r.error.code === 'WORKSPACE_SUSPENDED', r.error?.code);

  // Immediate effect: flipping the workspace back to ACTIVE must pass with
  // NO cache and NO token change (membership is re-read per request).
  suspendedWs.status = 'ACTIVE';
  suspendedWs.statusChangedAt = new Date();
  await suspendedWs.save();
  r = await runRequireWorkspace({ ...plainAdmin.toObject(), workspaceId: suspendedWs._id });
  check('ACTIVE workspace passes and sets req.workspaceId + req.workspaceSlug', !r.error && String(r.req.workspaceId) === String(suspendedWs._id) && r.req.workspaceSlug === `suspended-${stamp}`, JSON.stringify({ err: r.error?.code, slug: r.req.workspaceSlug }));
  suspendedWs.status = 'SUSPENDED';
  await suspendedWs.save();
  r = await runRequireWorkspace({ ...plainAdmin.toObject(), workspaceId: suspendedWs._id });
  check('re-suspending takes effect on the very next request', r.error instanceof ApiError && r.error.code === 'WORKSPACE_SUSPENDED', r.error?.code);

  r = await runRequireWorkspace(member);
  check('member passes requireWorkspace', !r.error && String(r.req.workspaceId) === String(ws._id), r.error?.code);

  // ══════════ §31 — CLIENT INJECTION ══════════
  console.log('\n— §31 CLIENT INJECTION (workspaceId is never client-writable) —');
  const attackerWs = otherWs._id;
  const OWNER = await login(owner.email, ownerPassword);
  const ADMIN = await login(plainAdmin.email, adminPassword);
  const HANDLER = await login(handler.email, handlerPassword);
  check('owner / admin / handler sessions issued', !!OWNER && !!ADMIN && !!HANDLER);

  const regEmail = `inject-${stamp}@tenant.test`;
  let resp = await req('POST', '/auth/register', {
    body: { name: 'Injected Customer', email: regEmail, password: registerPassword, workspaceId: attackerWs },
  });
  const regUser = await User.findOne({ email: regEmail }).lean();
  check('register accepts the request but never persists workspaceId', resp.status === 201 && !!regUser && regUser.workspaceId === undefined, `${resp.status} ws=${regUser?.workspaceId}`);
  check('register response does not echo a workspaceId', !JSON.stringify(resp.json || {}).includes('workspaceId'));

  resp = await req('POST', '/auth/login', { body: { email: plainAdmin.email, password: adminPassword, workspaceId: attackerWs } });
  check('login with a smuggled workspaceId still succeeds (and stores nothing)', resp.status === 200 && !!resp.json?.token, String(resp.status));

  // GRANULAR STAFF ONBOARDING replaced direct creation with an INVITATION: the
  // injection surface to prove is now the invitation (which must ignore a
  // client workspaceId) and ACTIVATION (which must take the workspace from the
  // invitation, never from the public request body).
  const opEmail = `op-inject-${stamp}@tenant.test`;
  resp = await req('POST', '/admin/users', {
    token: OWNER,
    body: { name: 'Injected Operator', email: opEmail, role: 'handler', password: newOpPassword, workspaceId: attackerWs },
  });
  check('direct staff creation is gone (no workspaceId injection path left)',
    resp.status === 410 && resp.json?.code === 'INVITATION_REQUIRED', `${resp.status} ${resp.json?.code}`);
  check('the refused call created no account', !(await User.findOne({ email: opEmail }).lean()));

  const wsAdmin = await User.create({
    email: `ws-inviter-${stamp}@tenant.test`,
    passwordHash: await bcrypt.hash(adminPassword, 12),
    role: 'admin',
    name: 'Workspace Inviter',
    isFixture: false,
    isOwner: false,
    workspaceId: ws._id,
  });
  const WS_ADMIN = await login(wsAdmin.email, adminPassword);
  const inviteResp = await req('POST', '/admin/invitations', {
    token: WS_ADMIN,
    body: { name: 'Injected Invitee', email: opEmail, staffRole: 'inventory', workspaceId: attackerWs },
  });
  check('an invitation cannot be minted into another workspace', inviteResp.status === 201, `${inviteResp.status}`);
  const inviteToken = String(inviteResp.json?.link || '').split('/').pop();
  const activationResp = await req('POST', `/invitations/${inviteToken}/activate`, {
    body: { password: newOpPassword, name: 'Injected Invitee', workspaceId: attackerWs },
  });
  const opUser = await User.findOne({ email: opEmail }).lean();
  check('activation ignores a client workspaceId and keeps the INVITER’s workspace',
    activationResp.status === 201 && String(opUser?.workspaceId) === String(ws._id),
    `${activationResp.status} ws=${opUser?.workspaceId}`);

  // Phase 22.3 — the staff-profile surface is gated: an unscoped administrator
  // fails closed once any workspace exists, and a member's write cannot
  // reassign membership because workspaceId never reaches the controller.
  const memberAdmin = await User.create({
    email: `scoped-admin-${stamp}@tenant.test`,
    passwordHash: await bcrypt.hash(adminPassword, 12),
    role: 'admin',
    name: 'Scoped Administrator',
    isFixture: false,
    isOwner: false,
    workspaceId: ws._id,
  });
  const SCOPED_ADMIN = await login(memberAdmin.email, adminPassword);
  check('workspace-scoped administrator session issued', !!SCOPED_ADMIN);

  resp = await req('PATCH', `/admin/staff/${member._id}`, {
    token: ADMIN,
    body: { department: 'Atelier', workspaceId: attackerWs },
  });
  check('unscoped admin is refused the staff surface (403 WORKSPACE_REQUIRED)', resp.status === 403 && resp.json?.code === 'WORKSPACE_REQUIRED', `${resp.status} ${resp.json?.code}`);

  resp = await req('PATCH', `/admin/staff/${member._id}`, {
    token: SCOPED_ADMIN,
    body: { department: 'Atelier', workspaceId: attackerWs },
  });
  const memberAfter = await User.findById(member._id).lean();
  check('staff profile PATCH cannot reassign membership', resp.status === 200 && String(memberAfter.workspaceId) === String(ws._id), `${resp.status} ws=${memberAfter.workspaceId}`);
  check('staff profile PATCH keeps the department change it was asked for', memberAfter.department === 'Atelier', memberAfter.department);

  // Product create: unscoped staff fail closed; a member's create is stamped
  // with the SERVER-derived workspace, never the body's.
  resp = await req('POST', '/products', {
    token: HANDLER,
    body: { name: `Injected Product ${stamp}`, price: 999, workspaceId: attackerWs },
  });
  check('unscoped handler is refused product create (403 WORKSPACE_REQUIRED)', resp.status === 403 && resp.json?.code === 'WORKSPACE_REQUIRED', `${resp.status} ${resp.json?.code}`);
  check('the refused create left no product behind', !(await Product.findOne({ name: `Injected Product ${stamp}` }).lean()), 'product exists');

  resp = await req('POST', '/products', {
    token: await login(member.email, memberPassword),
    body: { name: `Injected Product ${stamp}`, price: 999, workspaceId: attackerWs },
  });
  const injectedProduct = await Product.findOne({ name: `Injected Product ${stamp}` }).lean();
  check('product create by a workspace member succeeds', resp.status === 201 && !!injectedProduct, `${resp.status} ${JSON.stringify(resp.json || {}).slice(0, 120)}`);
  check('product create ignores a client workspaceId (server assigns the member workspace)', injectedProduct && String(injectedProduct.workspaceId) === String(ws._id), `ws=${injectedProduct?.workspaceId}`);

  resp = await req('GET', `/admin/users?workspaceId=${attackerWs}`, { token: OWNER });
  check('a smuggled workspaceId in the QUERY STRING cannot break a list read', resp.status === 200 && Array.isArray(resp.json?.operators || resp.json?.users), `${resp.status} ${JSON.stringify(resp.json).slice(0, 120)}`);

  // The scrub runs for every request (unit-level, so the flag is observable).
  const scrubReq = { body: { workspaceId: attackerWs, nested: [{ workspaceId: attackerWs, keep: 1 }], workspace_id: attackerWs }, query: { workspaceId: attackerWs } };
  let scrubNext = false;
  stripClientWorkspaceId(scrubReq, {}, () => { scrubNext = true; });
  check('stripClientWorkspaceId removes body + nested + snake_case + query values', scrubNext
    && scrubReq.body.workspaceId === undefined
    && scrubReq.body.workspace_id === undefined
    && scrubReq.body.nested[0].workspaceId === undefined
    && scrubReq.body.nested[0].keep === 1
    && scrubReq.query.workspaceId === undefined
    && scrubReq.workspaceIdStripped === true, JSON.stringify(scrubReq));

  // ══════════ §32 — BINDING RULES ══════════
  console.log('\n— §32 BINDING (invitation carries the inviter’s workspace; activation inherits it) —');
  // memberAdmin + SCOPED_ADMIN were created in §31 (its gated staff surface
  // needed a workspace-scoped administrator).

  const inviteEmail = `invited-${stamp}@tenant.test`;
  resp = await req('POST', '/admin/invitations', {
    token: SCOPED_ADMIN,
    body: { name: 'Invited Handler', email: inviteEmail, department: 'Fulfilment', workspaceId: attackerWs },
  });
  check('handler invitation issued by a scoped administrator', resp.status === 201, `${resp.status} ${JSON.stringify(resp.json).slice(0, 160)}`);
  const handlerInvite = await Invitation.findOne({ recipientEmail: inviteEmail }).lean();
  check('invitation is bound to the INVITER workspace, not the body', handlerInvite && String(handlerInvite.workspaceId) === String(ws._id), `inv ws=${handlerInvite?.workspaceId}`);

  const token = String(resp.json?.link || '').split('/activate/')[1];
  check('one-time activation link returned', !!token);
  resp = await req('POST', `/invitations/${token}/activate`, {
    body: { password: activatePassword, workspaceId: attackerWs },
  });
  const activated = await User.findOne({ email: inviteEmail }).lean();
  check('activation succeeds', resp.status === 201 || resp.status === 200, `${resp.status} ${JSON.stringify(resp.json).slice(0, 160)}`);
  check('activated handler INHERITS the invitation workspace', activated && String(activated.workspaceId) === String(ws._id), `user ws=${activated?.workspaceId}`);
  check('activation ignores a client workspaceId', activated && String(activated.workspaceId) !== String(attackerWs), String(activated?.workspaceId));
  check('activated handler role is handler', activated?.role === 'handler', activated?.role);

  // Admin invitation: even one that (hypothetically) carries a workspaceId,
  // activation must ignore it — Phase 22.4 provisions the administrator's
  // OWN workspace from the approved identity instead of attaching the new
  // administrator to any pre-existing binding.
  const adminInviteEmail = `admin-invite-${stamp}@tenant.test`;
  const adminInviteToken = crypto.randomBytes(32).toString('hex');
  await Invitation.create({
    recipientEmail: adminInviteEmail,
    recipientName: 'Platform Administrator',
    role: 'admin',
    inviter: owner._id,
    workspaceId: otherWs._id,
    tokenHash: crypto.createHash('sha256').update(adminInviteToken).digest('hex'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: 'INVITED',
  });
  resp = await req('POST', `/invitations/${adminInviteToken}/activate`, { body: { password: activatePassword } });
  const newAdmin = await User.findOne({ email: adminInviteEmail }).lean();
  check('admin invitation activates', resp.status === 201 || resp.status === 200, `${resp.status} ${JSON.stringify(resp.json).slice(0, 160)}`);
  // Phase 22.4 — the activation transaction creates a workspace owned by
  // this administrator; the invitation's hypothetical workspaceId binding
  // is never adopted.
  check('an ADMIN activation provisions its OWN workspace (never the invitation workspaceId)',
    newAdmin && !!newAdmin.workspaceId && String(newAdmin.workspaceId) !== String(otherWs._id),
    `role=${newAdmin?.role} ws=${newAdmin?.workspaceId}`);
  const provisionedCoreWs = newAdmin?.workspaceId ? await Workspace.findById(newAdmin.workspaceId).lean() : null;
  check('the provisioned workspace is bound to this administrator (primaryAdminId)',
    !!provisionedCoreWs && String(provisionedCoreWs.primaryAdminId || '') === String(newAdmin._id),
    `slug=${provisionedCoreWs?.slug} primary=${provisionedCoreWs?.primaryAdminId}`);
  check('the provisioned workspace slug derives from the approved identity',
    !!provisionedCoreWs && provisionedCoreWs.slug === 'platform-administrator',
    provisionedCoreWs?.slug);
  check('the provisioned administrator keeps its own invitation workspaceId field untouched',
    String((await Invitation.findOne({ recipientEmail: adminInviteEmail }).lean())?.workspaceId) === String(otherWs._id));

  // ══════════ §33 — GATE WIRING + NO BEHAVIOUR REGRESSION ══════════
  console.log('\n— §33 GATE WIRING (§19 owner surfaces live, §18 operational surfaces refuse) —');
  resp = await req('GET', '/admin/users', { token: OWNER });
  check('the owner still reads the operator list (§19, allowOwner)', resp.status === 200, `${resp.status} ${JSON.stringify(resp.json).slice(0, 120)}`);
  resp = await req('GET', '/admin/staff', { token: OWNER });
  check('the owner still reads the staff directory (§19, allowOwner)', resp.status === 200, `${resp.status}`);

  resp = await req('GET', '/orders', { token: OWNER });
  check('the owner is refused the operational order list (403 WORKSPACE_REQUIRED)', resp.status === 403 && resp.json?.code === 'WORKSPACE_REQUIRED', `${resp.status} ${resp.json?.code}`);
  resp = await req('GET', '/inventory', { token: OWNER });
  check('the owner is refused inventory (403 WORKSPACE_REQUIRED)', resp.status === 403 && resp.json?.code === 'WORKSPACE_REQUIRED', `${resp.status} ${resp.json?.code}`);
  resp = await req('GET', '/analytics/overview', { token: OWNER });
  check('the owner is refused analytics (403 WORKSPACE_REQUIRED)', resp.status === 403 && resp.json?.code === 'WORKSPACE_REQUIRED', `${resp.status} ${resp.json?.code}`);

  resp = await req('GET', '/orders', { token: ADMIN });
  check('unscoped admin is refused the operational order list (403 WORKSPACE_REQUIRED)', resp.status === 403 && resp.json?.code === 'WORKSPACE_REQUIRED', `${resp.status} ${resp.json?.code}`);
  resp = await req('GET', '/orders', { token: await login(member.email, memberPassword) });
  check('a workspace member reads the operational order list (strict workspace scope)', resp.status === 200, `${resp.status} ${JSON.stringify(resp.json).slice(0, 120)}`);

  resp = await req('GET', '/products');
  check('public catalogue reads are unchanged', resp.status === 200 && Array.isArray(resp.json?.products), `${resp.status}`);
  resp = await req('GET', '/settings');
  check('public settings read is unchanged', resp.status === 200, `${resp.status}`);
  resp = await req('GET', '/health');
  check('health probe is unchanged', resp.status === 200 && resp.json?.status === 'ok', `${resp.status}`);

  const gatedRouters = [
    'productRoutes.js', 'collectionRoutes.js', 'orderRoutes.js', 'inventoryRoutes.js',
    'customerRoutes.js', 'conversationRoutes.js', 'customRequestRoutes.js', 'analyticsRoutes.js',
    'settingsRoutes.js', 'staffRoutes.js', 'staffInvitationRoutes.js', 'adminUserRoutes.js',
    'uploadRoutes.js', 'notificationRoutes.js',
  ];
  const ungatedRouters = gatedRouters.filter(
    (f) => !fs.readFileSync(path.join(BACKEND_DIR, 'routes', f), 'utf8').includes('requireWorkspace')
  );
  check('all 14 workspace routers MOUNT a requireWorkspace* gate', ungatedRouters.length === 0, ungatedRouters.join(', '));
  const serverSrc = fs.readFileSync(path.join(BACKEND_DIR, 'server.js'), 'utf8');
  const scrubIndex = serverSrc.indexOf('app.use(stripClientWorkspaceId)');
  const jsonIndex = serverSrc.indexOf('express.json(');
  check('server.js mounts the client-workspaceId scrub after the body parser', scrubIndex > 0 && jsonIndex > 0 && scrubIndex > jsonIndex, `scrub=${scrubIndex} json=${jsonIndex}`);
  check('server.js itself never names a workspace gate (gates live with their routes)', !serverSrc.includes('requireWorkspace'), 'requireWorkspace is in server.js');

  // ══════════ §34 — MIGRATION SCRIPT ══════════
  console.log('\n— §34 MIGRATION SCRIPT (report-only this phase) —');
  async function snapshotCounts() {
    const cols = await mongoose.connection.db.listCollections().toArray();
    const out = {};
    for (const c of cols.sort((a, b) => a.name.localeCompare(b.name))) {
      out[c.name] = await mongoose.connection.db.collection(c.name).countDocuments();
    }
    return out;
  }
  const beforeCounts = await snapshotCounts();

  let run = spawnScript('scripts/backfill-workspaces.mjs', ['--report'], { MONGO_URI: TEST_URI });
  const reportOut = `${run.stdout || ''}${run.stderr || ''}`;
  check('--report exits 0', run.status === 0, `exit ${run.status}: ${reportOut.slice(-400)}`);
  check('--report states NO CHANGES MADE', reportOut.includes('NO CHANGES MADE'), reportOut.slice(-300));
  check('--report prints an assignment plan', reportOut.includes('Assignment plan'), reportOut.slice(0, 300));
  check('--report prints ownership findings', reportOut.includes('Undeterminable'), reportOut.slice(0, 300));
  check('--report prints slug-uniqueness readiness', reportOut.includes('Slug-uniqueness readiness'), reportOut.slice(0, 300));
  const afterReport = await snapshotCounts();
  check('--report left every collection count unchanged', JSON.stringify(beforeCounts) === JSON.stringify(afterReport), JSON.stringify({ beforeCounts, afterReport }));

  run = spawnScript('scripts/backfill-workspaces.mjs', ['--report', '--slug', 'TENANT CORE!'], { MONGO_URI: TEST_URI });
  check('an invalid --slug preview is refused', run.status !== 0 && `${run.stdout}${run.stderr}`.includes('not a valid workspace slug'), `exit ${run.status}`);

  const workspacesBeforeRefusal = await Workspace.countDocuments({});
  run = spawnScript('scripts/backfill-workspaces.mjs', ['--apply'], { MONGO_URI: TEST_URI });
  const applyNoFlags = `${run.stdout || ''}${run.stderr || ''}`;
  check('--apply WITHOUT --name/--slug is refused', run.status !== 0 && applyNoFlags.includes('--name'), `exit ${run.status}: ${applyNoFlags.slice(-300)}`);
  check('the refused --apply created no workspace', (await Workspace.countDocuments({})) === workspacesBeforeRefusal, `${workspacesBeforeRefusal} → ${await Workspace.countDocuments({})}`);

  run = spawnScript('scripts/backfill-workspaces.mjs', ['--apply', '--name', 'Production Salon', '--slug', 'production-salon'], {
    MONGO_URI: 'mongodb://127.0.0.1:9999/Flora-Alchemy',
    PRODUCTION_DB_NAMES: 'Flora-Alchemy',
  });
  const prodRefusal = `${run.stdout || ''}${run.stderr || ''}`;
  check('a PRODUCTION-named database is refused WITHOUT explicit confirmation', run.status !== 0 && prodRefusal.includes('refusing production migration'), `exit ${run.status}: ${prodRefusal.slice(-400)}`);
  check('the production refusal demands the exact-name confirmation', prodRefusal.includes('CONFIRM_DATABASE_UNSAFE_OPERATION=Flora-Alchemy'), prodRefusal.slice(0, 400));
  check('the production refusal names the protected database', prodRefusal.includes('Flora-Alchemy'), prodRefusal.slice(0, 400));

  // Guarded apply against THIS isolated disposable database (allowed by name).
  // Seed one more handler invitation from an UNSCOPED inviter first, so the
  // migration's invitation rule (handler → assigned, admin → platform) is
  // observable rather than merely asserted about already-bound rows.
  const pendingInviteEmail = `pending-invite-${stamp}@tenant.test`;
  await Invitation.create({
    recipientEmail: pendingInviteEmail,
    recipientName: 'Pending Handler',
    role: 'handler',
    inviter: plainAdmin._id,
    tokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32).toString('hex')).digest('hex'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: 'INVITED',
  });
  const pendingAdminInviteEmail = `pending-admin-invite-${stamp}@tenant.test`;
  await Invitation.create({
    recipientEmail: pendingAdminInviteEmail,
    recipientName: 'Pending Administrator',
    role: 'admin',
    inviter: owner._id,
    tokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32).toString('hex')).digest('hex'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: 'INVITED',
  });

  // Phase 22.3 — API-created products are assigned server-side, so the
  // migration's "attach unscoped operational rows" path is demonstrated with
  // a genuine pre-migration row (no workspaceId), while the §31 product
  // doubles as the "already assigned → never rewritten" case.
  const legacyProductId = (
    await Product.collection.insertOne({
      name: `Legacy Unassigned Product ${stamp}`,
      slug: `legacy-unassigned-${stamp}`,
      price: 450,
      visibility: 'Visible',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  ).insertedId;

  const applySlug = `tenant-apply-${stamp}`;
  run = spawnScript('scripts/backfill-workspaces.mjs', ['--apply', '--name', 'Tenant Apply Salon', '--slug', applySlug], { MONGO_URI: TEST_URI });
  const applyOut = `${run.stdout || ''}${run.stderr || ''}`;
  check('guarded --apply succeeds against the disposable test database', run.status === 0, `exit ${run.status}: ${applyOut.slice(-500)}`);
  const applied = await Workspace.findOne({ slug: applySlug }).lean();
  check('the workspace was created with the EXPLICIT name/slug supplied', applied && applied.displayName === 'Tenant Apply Salon', JSON.stringify(applied).slice(0, 200));
  const attachedOwner = await User.findById(owner._id).lean();
  check('--apply leaves the OWNER unscoped', attachedOwner.workspaceId === undefined, String(attachedOwner.workspaceId));
  const attachedCustomer = await User.findById(customerUser._id).lean();
  check('--apply leaves CUSTOMER identities unscoped', attachedCustomer.workspaceId === undefined, String(attachedCustomer.workspaceId));
  const attachedAdmin = await User.findById(plainAdmin._id).lean();
  check('--apply attaches a non-owner administrator', String(attachedAdmin.workspaceId) === String(applied._id), String(attachedAdmin.workspaceId));
  const attachedProduct = await Product.findById(legacyProductId).lean();
  check('--apply attaches an UNASSIGNED operational row (product)', attachedProduct && String(attachedProduct.workspaceId) === String(applied._id), String(attachedProduct?.workspaceId));
  const assignedProduct = await Product.findById(injectedProduct._id).lean();
  check('--apply never rewrites an already-assigned product (stays on its workspace)', String(assignedProduct.workspaceId) === String(ws._id), String(assignedProduct.workspaceId));
  const adminInviteAfter = await Invitation.findOne({ recipientEmail: adminInviteEmail }).lean();
  // Crafted in §32 to sit on otherWs._id: the migration must neither attach
  // it to the new workspace nor strip it — admin invitations are platform
  // concerns, and an existing binding is never rewritten.
  check('--apply never rewrites an ADMIN invitation (stays on its original value)', String(adminInviteAfter.workspaceId) === String(otherWs._id), String(adminInviteAfter.workspaceId));
  const pendingAdminInviteAfter = await Invitation.findOne({ recipientEmail: pendingAdminInviteEmail }).lean();
  check('--apply leaves an unscoped ADMIN invitation unassigned (platform-level)', pendingAdminInviteAfter.workspaceId === undefined || pendingAdminInviteAfter.workspaceId === null, String(pendingAdminInviteAfter.workspaceId));
  const pendingInviteAfter = await Invitation.findOne({ recipientEmail: pendingInviteEmail }).lean();
  check('--apply attaches a HANDLER invitation minted by an unscoped inviter', String(pendingInviteAfter.workspaceId) === String(applied._id), String(pendingInviteAfter.workspaceId));
  const alreadyBoundInvite = await Invitation.findOne({ recipientEmail: inviteEmail }).lean();
  check('--apply never rewrites an already-bound invitation', String(alreadyBoundInvite.workspaceId) === String(ws._id), String(alreadyBoundInvite.workspaceId));

  run = spawnScript('scripts/backfill-workspaces.mjs', ['--apply', '--name', 'Tenant Apply Salon', '--slug', applySlug], { MONGO_URI: TEST_URI });
  check('re-running --apply with the same slug is refused (idempotence guard)', run.status !== 0, `exit ${run.status}`);

  // ══════════ §35 — TENANT AUDIT TOOL ══════════
  console.log('\n— §35 TENANT AUDIT TOOL (pure scanner + CLI) —');
  const scopedSnippet = `
    const rows = await Order.find(workspaceFilter(req.user));
    const one = await Order.findById(id).where('workspaceId').equals(getWorkspaceId(req.user));
    assertWorkspaceMember(req.user, doc);
    const ws = await Model.find({ workspaceId: req.user.workspaceId, status: 'new' });
  `;
  const unscopedSnippet = `
    const rows = await Order.find({ status: 'new' });
    const n = await Order.countDocuments({});
    const agg = await Order.aggregate([{ $match: { paymentStatus: 'Paid' } }]);
    await Inventory.updateOne({ productSlug: slug }, { $inc: { currentStock: -1 } });
  `;
  const scopedScan = scanSource(scopedSnippet, { file: 'scoped.js' });
  check('a workspace-filtered query produces NO finding', scopedScan.findings.length === 0, JSON.stringify(scopedScan.findings));
  check('the scanner counts tenancy mentions', scopedScan.tenancySites >= 4, String(scopedScan.tenancySites));
  const unscopedScan = scanSource(unscopedSnippet, { file: 'unscoped.js' });
  check('an unfiltered query IS reported', unscopedScan.findings.length === 4, JSON.stringify(unscopedScan.findings));
  check('each finding carries file + line + call', unscopedScan.findings.every((f) => f.file === 'unscoped.js' && f.line > 0 && /^\.\w+\(\)$/.test(f.call)), JSON.stringify(unscopedScan.findings));
  const markerScan = scanSource(`// PHASE-22.2: NOT YET TENANT-SCOPED\nconst x = await User.find({});`, { file: 'marked.js' });
  check('the NOT-YET-SCOPED marker is detected', markerScan.markedUnscoped === true);
  check('isTenantAware recognises helper text', isTenantAware('Model.find(workspaceFilter(u))') === true && isTenantAware('Model.find({})') === false);
  const all = scanAll([{ file: 'a.js', source: scopedSnippet }, { file: 'b.js', source: unscopedSnippet }]);
  check('scanAll aggregates findings across files', all.findings.length === 4 && all.results.length === 2, String(all.findings.length));
  check('groupFindings groups by file', groupFindings(all.findings).length === 1, String(groupFindings(all.findings).length));

  run = spawnScript('scripts/tenant-audit.mjs', ['--json'], {});
  const auditOut = `${run.stdout || ''}`;
  let auditJson = null;
  try { auditJson = JSON.parse(auditOut); } catch { /* keep null */ }
  check('the audit CLI exits 0 in report mode', run.status === 0, `exit ${run.status}: ${run.stderr || ''}`.slice(-300));
  check('the audit CLI emits parseable JSON', !!auditJson, auditOut.slice(0, 200));
  check('every manifest file was scanned', auditJson && auditJson.scanned === SCOPE_MANIFEST.length, `${auditJson?.scanned} vs ${SCOPE_MANIFEST.length}`);
  check('the audit reports the expected unscoped query sites', auditJson && typeof auditJson.findings === 'number' && auditJson.querySites > 0, JSON.stringify({ f: auditJson?.findings, q: auditJson?.querySites }));
  check('no plan regression: nothing expected-scoped is unscoped', auditJson && auditJson.regressions.length === 0, JSON.stringify(auditJson?.regressions));
  check('no manifest file is missing', auditJson && auditJson.missing.length === 0, JSON.stringify(auditJson?.missing));

  run = spawnScript('scripts/tenant-audit.mjs', ['--strict'], {});
  check('--strict passes today (Phase 22.3 baseline)', run.status === 0, `exit ${run.status}: ${(run.stdout || '').slice(-300)}`);

  // ── Cleanup: no QA data left behind ──
  try {
    let removed = 0;
    for (const name of ['users', 'workspaces', 'products', 'collections', 'orders', 'inventory', 'inventorymovements', 'conversations', 'customrequests', 'settings', 'invitations', 'staffevents', 'notifications', 'customers', 'messages', 'inventories']) {
      try {
        const res = await mongoose.connection.db.collection(name).deleteMany({});
        removed += res.deletedCount;
      } catch { /* collection may not exist */ }
    }
    console.log(`\n— cleanup: removed ${removed} document(s) from ${DB_NAME} —`);
  } catch (err) {
    console.log(`\n— cleanup skipped (${err.message}) —`);
  }

  console.log(`\nTENANT CORE RESULT: ${passed} passed, ${failed} failed`);
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
