/**
 * GRANULAR STAFF ROLES & PERMISSIONS suite (invitation-based onboarding).
 *
 * Proves, against an EMPTY isolated database, that:
 *   §A INVITATION-ONLY ONBOARDING — direct password-based staff creation is
 *     gone (410), and an administrator invites a staff member whose account is
 *     created by ACTIVATION with the invitee's own name and password.
 *   §B WORKSPACE INHERITANCE — inviter.workspaceId → invitation.workspaceId →
 *     activated user.workspaceId, with a client-supplied workspaceId (or role,
 *     or permission bundle) never becoming authority.
 *   §C INVITATION LIFECYCLE — single-use, expiry, revocation, resend
 *     invalidation, no duplicate accounts.
 *   §D GRANULAR ENFORCEMENT — the permission bundle on the account is the
 *     authority on every gated route, taken from the DATABASE per request, so
 *     a grant works and a removal bites on the very next call, with no re-login.
 *   §E WORKSPACE + ADMIN BOUNDARIES — staff cannot reach another workspace,
 *     cannot invite, cannot edit permissions, cannot escalate to admin/owner,
 *     and an administrator of another workspace cannot touch this staff member.
 *   §F CATALOGUE INTEGRITY — only real, assignable workspace permissions exist;
 *     owner/administrator/platform authority is absent and unassignable.
 *
 * Isolation: own server (port 4106), own DB
 * (Flora-Alchemy-Test-StaffPermissions), SEED_ON_START=false. The suite drops
 * its database on start and removes what it created at the end.
 *
 * Run: node scripts/staff-permissions-smoke.mjs
 */
import fs from 'fs';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';
import User from '../models/User.js';
import Invitation from '../models/Invitation.js';
import Workspace from '../models/Workspace.js';
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import Inventory from '../models/Inventory.js';
import StaffEvent from '../models/StaffEvent.js';
import Settings from '../models/Settings.js';
import { FULL_WORKSPACE_ACCESS, ALL_PERMISSIONS } from '../utils/permissions.js';

const DB_NAME = 'Flora-Alchemy-Test-StaffPermissions';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  User.init(),
  Invitation.init(),
  Workspace.init(),
  Product.init(),
  Order.init(),
  Inventory.init(),
  StaffEvent.init(),
  Settings.init(),
]);

const stamp = Date.now();
const ownerPassword = `Owner-Pw-${stamp}!aA1`;
const adminPassword = `Admin-Pw-${stamp}!aA1`;
const staffPassword = `Staff-Pw-${stamp}!aA1`;

const wsA = await Workspace.create({ slug: `perm-a-${stamp}`, displayName: 'Perm Studio A', status: 'ACTIVE' });
const wsB = await Workspace.create({ slug: `perm-b-${stamp}`, displayName: 'Perm Studio B', status: 'ACTIVE' });

const owner = await User.create({
  email: `owner-${stamp}@permissions.test`,
  passwordHash: await bcrypt.hash(ownerPassword, 12),
  role: 'admin',
  name: 'Permission Owner',
  isOwner: true,
});

const adminA = await User.create({
  email: `admin-a-${stamp}@permissions.test`,
  passwordHash: await bcrypt.hash(adminPassword, 12),
  role: 'admin',
  name: 'Admin A',
  workspaceId: wsA._id,
});

const adminB = await User.create({
  email: `admin-b-${stamp}@permissions.test`,
  passwordHash: await bcrypt.hash(adminPassword, 12),
  role: 'admin',
  name: 'Admin B',
  workspaceId: wsB._id,
});

// Catalogue fixtures so product/inventory/order permissions have targets.
await Product.create([
  { slug: `perm-product-a-${stamp}`, name: 'Perm Product A', price: 500, visibility: 'Visible', workspaceId: wsA._id },
  { slug: `perm-product-b-${stamp}`, name: 'Perm Product B', price: 900, visibility: 'Visible', workspaceId: wsB._id },
]);
await Inventory.create([
  { productSlug: `perm-product-a-${stamp}`, productName: 'Perm Product A', currentStock: 5, workspaceId: wsA._id },
  { productSlug: `perm-product-b-${stamp}`, productName: 'Perm Product B', currentStock: 5, workspaceId: wsB._id },
]);
const orderA = await Order.create({
  orderId: `PERM-A-${stamp}`,
  customerId: new mongoose.Types.ObjectId(),
  customerName: 'Perm Customer A',
  items: [{ name: 'Perm Product A', price: 500, quantity: 1 }],
  total: 500,
  orderStatus: 'new',
  workspaceId: wsA._id,
});
await Order.create({
  orderId: `PERM-B-${stamp}`,
  customerId: new mongoose.Types.ObjectId(),
  customerName: 'Perm Customer B',
  items: [{ name: 'Perm Product B', price: 900, quantity: 1 }],
  total: 900,
  orderStatus: 'new',
  workspaceId: wsB._id,
});

const { child: SERVER, base } = await bootTestServer({
  port: 4106,
  db: DB_NAME,
  extraEnv: {
    SEED_ON_START: 'false',
    RATE_LIMIT_LOGIN_FAILED_MAX: '5000',
    RATE_LIMIT_API_WRITE_MAX: '5000',
    RATE_LIMIT_INVITATION_MAX: '5000',
  },
  label: 'staff-permissions-smoke',
});
const BASE = `${base}/api`;

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

async function login(email, password, portal) {
  const r = await req('POST', '/auth/login', { body: { email, password, ...(portal ? { portal } : {}) } });
  return { token: r.json?.token || null, user: r.json?.user || null, status: r.status };
}

function tokenFrom(link) {
  const m = String(link || '').match(/\/admin\/activate\/([a-f0-9]{64})$/i);
  return m ? m[1] : null;
}

/** Invite + activate in one step, returning the live staff token. */
async function inviteAndActivate({ adminToken, name, email, password, staffRole, permissions, fullAccess }) {
  const inv = await req('POST', '/admin/invitations', {
    token: adminToken,
    body: {
      name,
      email,
      ...(fullAccess ? { fullAccess: true } : staffRole ? { staffRole, ...(permissions ? { permissions } : {}) } : {}),
    },
  });
  const token = tokenFrom(inv.json?.link);
  if (!token) return { invite: inv, activation: null, session: null, token: null };
  const activation = await req('POST', `/invitations/${token}/activate`, { body: { password, name } });
  const session = await login(email, password, 'staff');
  return { invite: inv, activation, session, token };
}

async function main() {
  const OWNER = (await login(owner.email, ownerPassword, 'owner')).token;
  const ADMIN_A = (await login(adminA.email, adminPassword, 'admin')).token;
  const ADMIN_B = (await login(adminB.email, adminPassword, 'admin')).token;
  check('owner, admin A and admin B sign in', !!OWNER && !!ADMIN_A && !!ADMIN_B);

  // ══════════ §A — INVITATION-ONLY ONBOARDING ══════════
  console.log('\n— §A INVITATION-ONLY ONBOARDING (no direct password creation) —');
  let r = await req('POST', '/admin/users', {
    token: ADMIN_A,
    body: { name: 'Direct Hire', email: `direct-${stamp}@permissions.test`, role: 'handler', password: 'secret123' },
  });
  check('legacy direct staff creation → 410 INVITATION_REQUIRED',
    r.status === 410 && r.json?.code === 'INVITATION_REQUIRED', `${r.status} ${r.json?.code}`);
  check('the refusal points at the invitation flow',
    /invitations/i.test(r.json?.message || ''), r.json?.message);
  check('no account was created by the refused call',
    !(await User.findOne({ email: `direct-${stamp}@permissions.test` })), 'account exists');

  const staff1 = await inviteAndActivate({
    adminToken: ADMIN_A,
    name: 'Meera Nambiar',
    email: `meera-${stamp}@permissions.test`,
    password: staffPassword,
    staffRole: 'fulfillment',
  });
  check('admin A invites a staff member → 201', staff1.invite.status === 201, `${staff1.invite.status}`);
  check('the invitation link is a one-time activation URL with a 256-bit token',
    /^https?:\/\/.+\/admin\/activate\/[a-f0-9]{64}$/.test(staff1.invite.json?.link || ''),
    staff1.invite.json?.link);
  check('the invitation response carries the assigned role template',
    staff1.invite.json?.invitation?.staffRole === 'fulfillment',
    JSON.stringify(staff1.invite.json?.invitation?.staffRole));
  check('the invitation response leaks no token hash or password material',
    !JSON.stringify(staff1.invite.json || {}).includes('tokenHash') &&
      !JSON.stringify(staff1.invite.json || {}).includes('passwordHash'),
    JSON.stringify(staff1.invite.json).slice(0, 160));

  // The public landing (what the activation screen reads) — checked on a
  // FRESH invitation, because staff1.token was consumed by the helper above.
  const landingInv = await req('POST', '/admin/invitations', {
    token: ADMIN_A,
    body: { email: `landing-${stamp}@permissions.test`, staffRole: 'fulfillment' },
  });
  const landingToken = tokenFrom(landingInv.json?.link);
  check('an invitation may carry NO name (the invitee supplies it)', landingInv.status === 201,
    `${landingInv.status} ${landingInv.json?.code}`);
  const landing = await req('GET', `/invitations/${landingToken}`);
  check('public landing resolves the invitation → 200', landing.status === 200, `${landing.status}`);
  check('landing shows the JOINING workspace name', landing.json?.invitation?.workspaceName === 'Perm Studio A',
    JSON.stringify(landing.json?.invitation?.workspaceName));
  check('landing carries no name when the invitation had none',
    landing.json?.invitation?.recipientName === '', JSON.stringify(landing.json?.invitation?.recipientName));
  check('landing shows the assigned access template label',
    landing.json?.invitation?.staffRoleLabel === 'Fulfillment',
    JSON.stringify(landing.json?.invitation?.staffRoleLabel));
  check('landing never exposes the inviter password or token hash',
    !JSON.stringify(landing.json || {}).includes('tokenHash'), 'tokenHash leaked');

  check('activation creates the account → 201', staff1.activation?.status === 201, `${staff1.activation?.status}`);
  check('the invited person signs in with the password THEY set', !!staff1.session?.token, `${staff1.session?.status}`);
  check('portal resolved as staff', staff1.session?.user?.portal === 'staff', staff1.session?.user?.portal);
  check('role is handler', staff1.session?.user?.role === 'handler', staff1.session?.user?.role);
  check('the account name is the one the invitee typed at activation',
    staff1.session?.user?.name === 'Meera Nambiar', staff1.session?.user?.name);

  const staff1Doc = await User.findOne({ email: `meera-${stamp}@permissions.test` });
  check('activated user inherits the INVITER’s workspace',
    String(staff1Doc?.workspaceId) === String(wsA._id), String(staff1Doc?.workspaceId));
  check('activated user is ACTIVE', staff1Doc?.status === 'ACTIVE', staff1Doc?.status);
  check('invitation bundle applied to the account (staffRole)',
    staff1Doc?.staffRole === 'fulfillment', String(staff1Doc?.staffRole));
  check('invitation bundle applied to the account (permissions)',
    Array.isArray(staff1Doc?.permissions) && staff1Doc.permissions.includes('orders.view') && !staff1Doc.permissions.includes('products.delete'),
    JSON.stringify(staff1Doc?.permissions));
  check('activation response carries no credential material',
    !JSON.stringify(staff1.activation?.json || {}).includes('passwordHash'), 'passwordHash leaked');
  const activatedSelf = await req('GET', '/auth/me', { token: staff1.session.token });
  check('/auth/me exposes the effective permission list for staff',
    Array.isArray(activatedSelf.json?.user?.access?.effective) &&
      activatedSelf.json.user.access.effective.includes('orders.view'),
    JSON.stringify(activatedSelf.json?.user?.access?.effective));

  // ══════════ §B — WORKSPACE INHERITANCE & CLIENT INJECTION ══════════
  console.log('\n— §B WORKSPACE INHERITANCE (client can never choose the tenant) —');
  const invitedB = await req('POST', '/admin/invitations', {
    token: ADMIN_B,
    body: { name: 'B Staff', email: `bstaff-${stamp}@permissions.test`, staffRole: 'inventory' },
  });
  check('admin B invitation is bound to workspace B server-side',
    String((await Invitation.findOne({ recipientEmail: `bstaff-${stamp}@permissions.test` }))?.workspaceId) === String(wsB._id),
    'wrong workspace on the invitation');

  const bToken = tokenFrom(invitedB.json?.link);
  const bActivation = await req('POST', `/invitations/${bToken}/activate`, {
    body: {
      password: staffPassword,
      name: 'B Staff',
      // Forged tenant + privilege + bundle: all of it must be ignored.
      workspaceId: String(wsA._id),
      role: 'admin',
      isOwner: true,
      staffRole: 'full_workspace',
      permissions: ['products.delete', 'orders.view'],
    },
  });
  const bStaffDoc = await User.findOne({ email: `bstaff-${stamp}@permissions.test` });
  check('activated staff keeps the invitation workspace despite a forged workspaceId',
    String(bStaffDoc?.workspaceId) === String(wsB._id), String(bStaffDoc?.workspaceId));
  check('activated staff cannot be promoted to admin by the activation body',
    bStaffDoc?.role === 'handler' && bStaffDoc?.isOwner !== true, `${bStaffDoc?.role}/${bStaffDoc?.isOwner}`);
  check('activated staff cannot rewrite its invited permission bundle',
    bStaffDoc?.staffRole === 'inventory' && !(bStaffDoc?.permissions || []).includes('products.delete'),
    JSON.stringify({ role: bStaffDoc?.staffRole, perms: bStaffDoc?.permissions }));
  check('forged activation body did not break the invitation', bActivation.status === 201, `${bActivation.status}`);

  // ══════════ §C — INVITATION LIFECYCLE ══════════
  console.log('\n— §C INVITATION LIFECYCLE (single-use · expiry · revoke · resend) —');
  r = await req('POST', `/invitations/${staff1.token}/activate`, { body: { password: staffPassword } });
  check('a USED invitation cannot be activated twice',
    [409, 410].includes(r.status), `${r.status} ${r.json?.code}`);
  check('no duplicate account was created by the replay',
    (await User.countDocuments({ email: `meera-${stamp}@permissions.test` })) === 1, 'duplicate account');

  const expiredEmail = `expired-${stamp}@permissions.test`;
  const expiredInv = await req('POST', '/admin/invitations', {
    token: ADMIN_A,
    body: { name: 'Expired Invite', email: expiredEmail, staffRole: 'inventory' },
  });
  const expiredToken = tokenFrom(expiredInv.json?.link);
  await Invitation.updateOne({ recipientEmail: expiredEmail }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
  r = await req('POST', `/invitations/${expiredToken}/activate`, { body: { password: staffPassword, name: 'Expired Invite' } });
  check('an EXPIRED invitation cannot activate', r.status === 410, `${r.status} ${r.json?.code}`);
  check('expired invitation created no account', !(await User.findOne({ email: expiredEmail })), 'account exists');

  const revokedEmail = `revoked-${stamp}@permissions.test`;
  const revokedInv = await req('POST', '/admin/invitations', {
    token: ADMIN_A,
    body: { name: 'Revoked Invite', email: revokedEmail, staffRole: 'inventory' },
  });
  const revokedToken = tokenFrom(revokedInv.json?.link);
  const revokedId = revokedInv.json?.invitation?.id;
  r = await req('POST', `/admin/invitations/${revokedId}/revoke`, { token: ADMIN_A, body: { reason: 'Changed plan.' } });
  check('admin A revokes an invitation → 200', r.status === 200, `${r.status}`);
  r = await req('POST', `/invitations/${revokedToken}/activate`, { body: { password: staffPassword, name: 'Revoked Invite' } });
  check('a REVOKED invitation cannot activate', r.status === 403, `${r.status} ${r.json?.code}`);
  check('revoked invitation created no account', !(await User.findOne({ email: revokedEmail })), 'account exists');

  const resendEmail = `resend-${stamp}@permissions.test`;
  const firstInv = await req('POST', '/admin/invitations', {
    token: ADMIN_A,
    body: { name: 'Resend Person', email: resendEmail, staffRole: 'customer_support' },
  });
  const firstToken = tokenFrom(firstInv.json?.link);
  const resendId = firstInv.json?.invitation?.id;
  const resent = await req('POST', `/admin/invitations/${resendId}/resend`, { token: ADMIN_A });
  const secondToken = tokenFrom(resent.json?.link);
  check('resend mints a NEW activation link', resent.status === 200 && !!secondToken && secondToken !== firstToken,
    `${resent.status}`);
  check('the PREVIOUS link stops working after a resend',
    (await req('GET', `/invitations/${firstToken}`)).status === 404, 'old token still valid');
  check('resend preserves workspace B… (workspace) and the role bundle',
    resent.json?.invitation?.staffRole === 'customer_support',
    JSON.stringify(resent.json?.invitation?.staffRole));
  const resentActivation = await req('POST', `/invitations/${secondToken}/activate`, {
    body: { password: staffPassword, name: 'Resend Person' },
  });
  check('the resent link activates exactly once', resentActivation.status === 201, `${resentActivation.status}`);
  check('resend + activation created exactly one account',
    (await User.countDocuments({ email: resendEmail })) === 1, 'duplicate account');

  // ══════════ §D — GRANULAR ENFORCEMENT (live, no re-login) ══════════
  console.log('\n— §D GRANULAR ENFORCEMENT (server-authoritative, immediate) —');
  const STAFF = staff1.session.token; // fulfillment template
  const staffId = String(staff1Doc._id);

  r = await req('GET', '/orders', { token: STAFF });
  check('staff with orders.view reads the workspace pipeline → 200', r.status === 200, `${r.status}`);
  r = await req('GET', `/orders?workspaceId=${wsB._id}`, { token: STAFF });
  const forgedOrders = (r.json?.orders || []).map((o) => o.workspaceId).filter(Boolean).map(String);
  check('a forged ?workspaceId never widens the staff read',
    r.status === 200 && !forgedOrders.includes(String(wsB._id)), JSON.stringify(forgedOrders));
  r = await req('POST', `/inventory/perm-product-a-${stamp}/adjust`, {
    token: STAFF,
    body: { type: 'add', quantity: 1, reason: 'Audit probe' },
  });
  check('staff without inventory.adjust is refused a stock write',
    r.status === 403 && r.json?.code === 'PERMISSION_DENIED', `${r.status} ${r.json?.code}`);
  check('the refusal names the missing permission',
    /inventory\.adjust/.test(r.json?.message || ''), r.json?.message);
  r = await req('GET', '/analytics/overview', { token: STAFF });
  check('staff without analytics.view is refused analytics', r.status === 403, `${r.status}`);
  r = await req('POST', `/products`, { token: STAFF, body: { name: 'Nope', price: 10 } });
  check('staff without products.create cannot create a product', r.status === 403, `${r.status}`);

  // Grant products.create — the SAME token must start working.
  r = await req('PATCH', `/admin/access/staff/${staffId}`, { token: ADMIN_A, body: { permissions: ['orders.view', 'products.view', 'products.create'] } });
  check('admin A saves an explicit bundle → 200', r.status === 200, `${r.status} ${r.json?.code}`);
  check('the saved bundle is reported back as effective',
    (r.json?.access?.effective || []).includes('products.create'), JSON.stringify(r.json?.access?.effective));
  r = await req('POST', '/products', {
    token: STAFF,
    body: { name: `Staff Created ${stamp}`, price: 250, category: 'Flowers & Bouquets' },
  });
  check('the SAME session can now create a product (no re-login)', r.status === 201, `${r.status} ${r.json?.code}`);
  const createdSlug = r.json?.product?.slug || null;

  // Revoke it again — the removal must bite immediately.
  r = await req('PATCH', `/admin/access/staff/${staffId}`, { token: ADMIN_A, body: { permissions: ['orders.view', 'products.view'] } });
  check('admin A saves a reduced bundle → 200', r.status === 200, `${r.status}`);
  r = await req('POST', '/products', {
    token: STAFF,
    body: { name: `Staff Blocked ${stamp}`, price: 250, category: 'Flowers & Bouquets' },
  });
  check('permission REMOVAL is enforced on the very next request',
    r.status === 403 && r.json?.code === 'PERMISSION_DENIED', `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/products/${createdSlug}`, { token: STAFF, body: { price: 300 } });
  check('a permission the bundle never had (products.update) stays refused', r.status === 403, `${r.status}`);

  // Order-stage permissions are stage-specific: the SAME endpoint grants or
  // refuses depending on the stage being written.
  r = await req('PATCH', `/admin/access/staff/${staffId}`, { token: ADMIN_A, body: { permissions: ['orders.view', 'orders.update_status'] } });
  check('staff switched to an order-status-only bundle', r.status === 200, `${r.status}`);
  r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: STAFF, body: { status: 'confirmed' } });
  check('accepting a new order needs orders.accept (refused without it)',
    r.status === 403 && r.json?.code === 'PERMISSION_DENIED', `${r.status} ${r.json?.code}`);

  r = await req('PATCH', `/admin/access/staff/${staffId}`, {
    token: ADMIN_A,
    body: { permissions: ['orders.view', 'orders.accept', 'orders.update_status'] },
  });
  check('staff granted orders.accept + orders.update_status', r.status === 200, `${r.status}`);
  r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: STAFF, body: { status: 'confirmed' } });
  check('accepting an order is allowed with orders.accept', r.status === 200, `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: STAFF, body: { status: 'in_production' } });
  check('a production stage write is allowed with orders.update_status',
    r.status === 200, `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: STAFF, body: { status: 'quality_check' } });
  check('the next production stage is allowed too', r.status === 200, `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: STAFF, body: { status: 'ready_to_dispatch' } });
  check('packing the order is allowed', r.status === 200, `${r.status} ${r.json?.code}`);
  // Dispatch is a DIFFERENT authority (orders.fulfillment) on the same endpoint.
  r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: STAFF, body: { status: 'shipped' } });
  check('dispatching an order needs orders.fulfillment (refused without it)',
    r.status === 403 && r.json?.code === 'PERMISSION_DENIED', `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/admin/access/staff/${staffId}`, {
    token: ADMIN_A,
    body: { permissions: ['orders.view', 'orders.accept', 'orders.update_status', 'orders.fulfillment'] },
  });
  check('staff granted orders.fulfillment', r.status === 200, `${r.status}`);
  r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: STAFF, body: { status: 'shipped' } });
  check('dispatching is allowed once orders.fulfillment is granted (no re-login)',
    r.status === 200, `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/orders/${orderA.orderId}/status`, { token: STAFF, body: { status: 'delivered' } });
  check('completing an order needs orders.complete (refused without it)',
    r.status === 403 && r.json?.code === 'PERMISSION_DENIED', `${r.status} ${r.json?.code}`);

  // Full workspace access, then everything operational works.
  r = await req('PATCH', `/admin/access/staff/${staffId}`, { token: ADMIN_A, body: { fullAccess: true } });
  check('full workspace access granted → 200', r.status === 200 && r.json?.access?.isFullAccess === true,
    `${r.status} ${JSON.stringify(r.json?.access?.isFullAccess)}`);
  check('full access is exactly the workspace bundle',
    (r.json?.access?.effective || []).length === FULL_WORKSPACE_ACCESS.length, `${(r.json?.access?.effective || []).length}`);
  r = await req('GET', '/analytics/overview', { token: STAFF });
  check('full workspace access unlocks analytics', r.status === 200, `${r.status}`);
  r = await req('GET', '/inventory/history', { token: STAFF });
  check('full workspace access unlocks the movement ledger', r.status === 200, `${r.status}`);
  r = await req('GET', '/admin/access/catalogue', { token: STAFF });
  check('staff cannot read the access catalogue (admin surface)', r.status === 403, `${r.status}`);
  r = await req('GET', '/admin/staff', { token: STAFF });
  check('staff cannot read the staff directory', r.status === 403, `${r.status}`);
  r = await req('PATCH', `/admin/access/staff/${staffId}`, { token: STAFF, body: { permissions: ALL_PERMISSIONS } });
  check('staff cannot edit permissions (even its own)', r.status === 403, `${r.status}`);
  r = await req('POST', '/admin/invitations', { token: STAFF, body: { name: 'Sneaky', email: `sneak-${stamp}@permissions.test` } });
  check('staff cannot invite another staff member', r.status === 403, `${r.status}`);
  r = await req('POST', '/admin/users', { token: STAFF, body: { name: 'Sneaky', email: `sneak2-${stamp}@permissions.test`, role: 'handler', password: 'secret123' } });
  check('staff cannot create an operator directly', r.status === 403, `${r.status}`);
  r = await req('PATCH', `/admin/staff/${staffId}`, { token: STAFF, body: { department: 'Self Promotion' } });
  check('staff cannot edit its own staff record', r.status === 403, `${r.status}`);

  // Audit trail.
  const accessEvents = await StaffEvent.countDocuments({ user: staff1Doc._id, type: 'ACCESS_UPDATED' });
  check('every access change is written to the staff timeline', accessEvents >= 4, `events=${accessEvents}`);

  // ══════════ §E — WORKSPACE & ADMIN BOUNDARIES ══════════
  console.log('\n— §E WORKSPACE & ADMIN BOUNDARIES —');
  r = await req('PATCH', `/admin/access/staff/${staffId}`, { token: ADMIN_B, body: { fullAccess: true } });
  check('an administrator of ANOTHER workspace cannot change this staff member',
    r.status === 404, `${r.status} ${r.json?.code}`);
  r = await req('POST', '/admin/invitations', { token: ADMIN_B, body: { name: 'Cross Check', email: `x-${stamp}@permissions.test` } });
  const xInv = await Invitation.findOne({ recipientEmail: `x-${stamp}@permissions.test` });
  check('admin B’s invitation stays in workspace B', String(xInv?.workspaceId) === String(wsB._id), String(xInv?.workspaceId));
  r = await req('GET', '/admin/invitations', { token: ADMIN_B });
  const bEmails = (r.json?.invitations || []).map((i) => i.recipientEmail);
  check('admin B never sees workspace A invitations', !bEmails.includes(`meera-${stamp}@permissions.test`), JSON.stringify(bEmails));

  // An ADMINISTRATOR account carries admin-gate authority, not a staff bundle:
  // even the owner is refused the staff-access surface for it (administrators
  // are managed through the administrator lifecycle, not permission bundles).
  r = await req('PATCH', `/admin/access/staff/${String(adminA._id)}`, { token: OWNER, body: { fullAccess: true } });
  check('an administrator account is not editable through staff access (owner-managed)',
    r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/admin/access/staff/${String(owner._id)}`, { token: OWNER, body: { fullAccess: true } });
  check('nobody edits their own access (self-action refused)', r.status === 422, `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/admin/access/staff/${String(adminB._id)}`, { token: ADMIN_A, body: { fullAccess: true } });
  check('workspace A cannot reach workspace B’s administrator', r.status === 404, `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/admin/access/staff/${staffId}`, { token: ADMIN_A, body: { role: 'no-such-template' } });
  check('an unknown role template → 422', r.status === 422, `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/admin/access/staff/${staffId}`, { token: ADMIN_A, body: { permissions: ['owner.superuser'] } });
  check('an unknown permission id → 422 (never silently dropped)', r.status === 422, `${r.status} ${r.json?.code}`);
  r = await req('PATCH', `/admin/access/staff/${staffId}`, { token: ADMIN_A, body: { role: 'owner' } });
  check('there is no owner/administrator bundle to assign', r.status === 422, `${r.status}`);

  r = await req('POST', `/admin/staff/${staffId}/suspend`, { token: ADMIN_A, body: { reason: 'Audit', note: 'Permission suite' } });
  check('admin A suspends the staff member', r.status === 200, `${r.status}`);
  r = await req('GET', '/orders', { token: STAFF });
  check('a SUSPENDED staff account is refused immediately (fresh token too)',
    r.status === 403 && r.json?.code === 'ACCOUNT_SUSPENDED', `${r.status} ${r.json?.code}`);
  r = await req('POST', '/auth/login', { body: { email: `meera-${stamp}@permissions.test`, password: staffPassword, portal: 'staff' } });
  check('a SUSPENDED account cannot sign in', r.status === 403, `${r.status} ${r.json?.code}`);
  r = await req('POST', `/admin/staff/${staffId}/reactivate`, { token: ADMIN_A });
  check('admin A reactivates the staff member', r.status === 200, `${r.status}`);
  r = await req('GET', '/orders', { token: STAFF });
  check('the reactivated account works again with the same token', r.status === 200, `${r.status}`);

  // ══════════ §F — CATALOGUE INTEGRITY + PUBLIC/ADMIN BEHAVIOUR ══════════
  console.log('\n— §F CATALOGUE INTEGRITY & UNTOUCHED SURFACES —');
  r = await req('GET', '/admin/access/catalogue', { token: ADMIN_A });
  const ids = (r.json?.catalogue?.groups || []).flatMap((g) => g.permissions.map((p) => p.id));
  check('catalogue is readable by an administrator → 200', r.status === 200, `${r.status}`);
  check('catalogue ids are exactly the enforced set',
    ids.length === ALL_PERMISSIONS.length && ALL_PERMISSIONS.every((p) => ids.includes(p)),
    `${ids.length}/${ALL_PERMISSIONS.length}`);
  check('catalogue carries no owner/administrator/platform permission',
    !ids.some((id) => /owner|admin|platform|billing|workspace\./i.test(id)), JSON.stringify(ids.filter((id) => /owner|admin/i.test(id))));
  check('catalogue exposes the reserved boundary for the UI',
    Array.isArray(r.json?.reserved) && r.json.reserved.length >= 4, JSON.stringify(r.json?.reserved));
  check('catalogue templates include the five operational bundles',
    (r.json?.catalogue?.templates || []).map((t) => t.key).join(',') ===
      'fulfillment,inventory,customer_support,catalog_operations,custom,full_workspace',
    JSON.stringify((r.json?.catalogue?.templates || []).map((t) => t.key)));

  r = await req('GET', '/products');
  check('anonymous storefront catalogue still works', r.status === 200, `${r.status}`);
  r = await req('GET', '/products', { token: ADMIN_B });
  check('an administrator still reads its own catalogue', r.status === 200, `${r.status}`);

  // A legacy handler with NO stored permissions keeps full workspace access.
  const legacy = await User.create({
    email: `legacy-${stamp}@permissions.test`,
    passwordHash: await bcrypt.hash(staffPassword, 12),
    role: 'handler',
    name: 'Legacy Handler',
    workspaceId: wsA._id,
  });
  const legacySession = await login(legacy.email, staffPassword, 'staff');
  r = await req('GET', '/inventory', { token: legacySession.token });
  check('a pre-existing handler (no stored bundle) keeps full workspace access',
    r.status === 200, `${r.status} ${r.json?.code}`);
  r = await req('GET', '/admin/access/staff/' + String(legacy._id), { token: ADMIN_A });
  check('the legacy default is reported honestly to the administrator',
    r.status === 200 && r.json?.access?.legacyDefault === true, JSON.stringify(r.json?.access?.legacyDefault));
  r = await req('PATCH', `/admin/access/staff/${String(legacy._id)}`, {
    token: ADMIN_A, body: { permissions: ['orders.view'] },
  });
  const stillFull = await req('GET', '/analytics/overview', { token: legacySession.token });
  check('saving an explicit bundle turns the legacy default off immediately',
    r.status === 200 && stillFull.status === 403, `${r.status}/${stillFull.status}`);

  // Staff directory surfaces access.
  r = await req('GET', `/admin/staff/${staffId}`, { token: ADMIN_A });
  check('the staff dossier reports the member’s access',
    r.status === 200 && !!r.json?.member?.access?.roleLabel, JSON.stringify(r.json?.member?.access).slice(0, 120));

  // ══════════ §G — DIRECT ROUTE GATE (frontend) ══════════
  // A hidden sidebar link is not a closed door: /staff/customers typed into the
  // address bar, a deep link or a bookmark never passes the sidebar filter. This
  // section proves the ROUTE guard refuses it before the page mounts — so no
  // console slice is read into an empty "0 customers" screen and no page fires a
  // request it was always going to be refused.
  console.log('\n— §G DIRECT STAFF ROUTE GATE —');
  const frontendRoot = new URL('../../frontend/', import.meta.url);
  const readF = (rel) => fs.readFileSync(new URL(rel, frontendRoot), 'utf8');
  const gateSource = readF('src/components/StaffRoute.jsx');
  const bootstrapSource = readF('src/components/RouteBootstrapGate.jsx');
  const customersPageSource = readF('src/pages/admin/AdminCustomersPage.jsx');
  const { requiredStaffPermissions } = await import(
    new URL('src/services/staffRouteAccess.js', frontendRoot).href
  );
  // Copy assertions read RENDERED text: comments explain the rule, they are not
  // the rule, and JSX escapes `&` as `&amp;`.
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
  const gateText = stripComments(gateSource).replace(/&amp;/g, '&');

  // 1. Every /staff route the router declares must RESOLVE to a decision, so a
  //    new staff screen cannot be shipped without declaring its permission.
  const declared = [...new Set([...readF('src/App.jsx').matchAll(/path="(\/staff[^"]*)"/g)].map((m) => m[1]))];
  const unresolved = declared.filter((p) => {
    const concrete = p.replace(/:[A-Za-z]+/g, 'x').replace(/\/$/, '') || '/';
    return requiredStaffPermissions(concrete) === null;
  });
  check('every declared /staff route is classified by the access table',
    declared.length >= 20 && unresolved.length === 0, JSON.stringify(unresolved));
  check('the dashboard is deliberately ungated (no staff member is locked out of their landing screen)',
    requiredStaffPermissions('/staff')?.any?.length === 0 &&
      requiredStaffPermissions('/staff/dashboard')?.any?.length === 0,
    JSON.stringify(requiredStaffPermissions('/staff/dashboard')));

  // 2. The four routes named in the production defect must require exactly the
  //    permission the SERVER enforces (backend/routes/*.js requirePermission).
  const expectations = [
    ['/staff/customers', 'customers.view'],
    ['/staff/customers/abc123', 'customers.view'],
    ['/staff/conversations', 'conversations.view'],
    ['/staff/custom-requests', 'requests.view'],
    ['/staff/custom-requests/abc123', 'requests.view'],
    ['/staff/analytics', 'analytics.view'],
    ['/staff/analytics/sales', 'analytics.view'],
    ['/staff/orders', 'orders.view'],
    ['/staff/orders/new', 'orders.create'],
    ['/staff/products', 'products.view'],
    ['/staff/collections', 'collections.view'],
    ['/staff/inventory', 'inventory.view'],
    ['/staff/notifications', 'notifications.view'],
  ];
  const wrong = expectations.filter(([p, perm]) => !requiredStaffPermissions(p)?.any?.includes(perm));
  check('direct routes require the same permission the server enforces',
    wrong.length === 0, JSON.stringify(wrong));

  // 3. Specificity: the movement ledger needs inventory.movement.view, and it
  //    must not be satisfied by the broader inventory.view rule (or the reverse).
  check('the more specific route wins (inventory/history → inventory.movement.view)',
    JSON.stringify(requiredStaffPermissions('/staff/inventory/history')?.any) === JSON.stringify(['inventory.movement.view']),
    JSON.stringify(requiredStaffPermissions('/staff/inventory/history')?.any));
  check('an order conversation is reachable from Orders OR Conversations',
    ['conversations.view', 'orders.view'].every((p) =>
      requiredStaffPermissions('/staff/orders/abc/conversation')?.any?.includes(p)),
    JSON.stringify(requiredStaffPermissions('/staff/orders/abc/conversation')?.any));

  // 4. The guard actually consults it, and refuses BEFORE mounting the page.
  check('the route guard consults the access table',
    gateSource.includes('requiredStaffPermissions('), 'no resolver call');
  check('the refusal happens before the page is mounted',
    gateSource.indexOf('StaffAccessRefusal') > -1 &&
      gateSource.indexOf('StaffAccessRefusal') < gateSource.indexOf('return children'),
    'children rendered before the refusal');
  check('the gate delegates the verdict to the SESSION permission check (unknown bundle ⇒ server decides)',
    gateSource.includes('sessionHasPermission('), 'no session check');
  check('the refusal names the missing permission and the remedy',
    /permission/.test(gateText) && /Access\s*&\s*Role/.test(gateText), 'no named remedy');
  check('the refusal is an access decision, never a retryable outage',
    /access decision, not a connection problem/.test(gateText) && !/>\s*Retry\s*</.test(gateText) &&
      !/onClick/.test(gateText),
    'refusal offers Retry or lacks the access wording');

  // 4b. HYDRATION MUST NOT ASK FOR A SLICE THE ROLE CANNOT READ. Console
  //     hydration is all-or-nothing, so one unreadable slice fails the whole
  //     route — a handler without products.view used to lose every staff screen
  //     to a page-level error. The plan and the full hydration must filter the
  //     same set: exactly the console slices the SERVER gates for a staff token
  //     (products.view, collections.view, orders.view, customers.view,
  //     inventory.view, analytics.view), and NOT settings, whose GET is public.
  const planSource = stripComments(readF('src/services/routeDataRequirements.js'));
  const storeSource = stripComments(readF('src/services/dataStore.js'));
  const sliceBlock = (planSource.match(/const SLICE_PERMISSION = \{([\s\S]*?)\};/) || [])[1] || '';
  const gatedSlices = {
    products: 'products.view',
    collections: 'collections.view',
    orders: 'orders.view',
    customers: 'customers.view',
    inventory: 'inventory.view',
    analytics: 'analytics.view',
  };
  const unfiltered = Object.entries(gatedSlices).filter(([slice, perm]) =>
    !new RegExp(`${slice}:\\s*'${perm.replace('.', '\\.')}'`).test(sliceBlock));
  check('every server-gated console slice is permission-filtered in the route plan',
    unfiltered.length === 0, JSON.stringify(unfiltered));
  check('settings stays unfiltered (GET /settings is genuinely public)',
    !/\bsettings:/.test(sliceBlock), 'settings was filtered');
  check('the filtering is the SAME predicate in the plan and in full hydration',
    /sessionReadsSlice\(permissions, slice\)/.test(planSource) &&
      /reads = \(slice\) => sessionReadsSlice\(permissions, slice\)/.test(storeSource) &&
      /reads\('products'\) \? api\.get\('\/products'/.test(storeSource),
    'full hydration does not use the shared filter');

  // 5. The empty state the defect produced is still a LEGITIMATE state for a
  //    genuinely empty workspace — the gate owns the refusal, the page keeps
  //    its honest "no data" copy, and neither one pretends to be the other.
  check('the customers page keeps its legitimate empty-data state',
    /No Customers Found/.test(customersPageSource), 'empty state removed');
  check('the customers page does not re-decide authorization locally',
    !/PERMISSION_DENIED|isAccessRefusal/.test(customersPageSource), 'page duplicates the gate');

  // 6. Error-state taxonomy: a permission refusal must never be collapsed into
  //    the generic access/connection screens.
  check('hydration classifies PERMISSION_DENIED as its OWN state',
    /case 'PERMISSION_DENIED':\s*\n\s*return 'permission'/.test(bootstrapSource),
    'PERMISSION_DENIED not distinguished');
  check('the permission state names the remedy, not a connection problem',
    /'permission'/.test(bootstrapSource) && /Access\s*&\s*Role/.test(bootstrapSource),
    'no permission-specific copy');
  check('SUSPENDED / FORBIDDEN / NOT_FOUND / connection states all remain distinct',
    ["'suspended'", "'forbidden'", "'not-found'", "'connection'"].every((k) => bootstrapSource.includes(`return ${k}`)),
    'a state was collapsed');

  // ══════════ cleanup ══════════
  try {
    let removed = 0;
    for (const name of ['users', 'workspaces', 'invitations', 'products', 'orders', 'inventory', 'inventorymovements', 'staffevents', 'settings', 'notifications', 'collections', 'customers', 'customrequests', 'conversations', 'messages']) {
      try {
        const res = await mongoose.connection.db.collection(name).deleteMany({});
        removed += res.deletedCount;
      } catch { /* collection may not exist */ }
    }
    console.log(`\n— cleanup: removed ${removed} document(s) from ${DB_NAME} —`);
  } catch (err) {
    console.log(`\n— cleanup skipped (${err.message}) —`);
  }

  console.log(`\nSTAFF PERMISSIONS RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
  }

  try {
    await mongoose.disconnect().catch(() => {});
  } finally {
    await stopTestServer(SERVER, base);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('suite crashed:', err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  try { await stopTestServer(SERVER, base); } catch { /* ignore */ }
  process.exit(1);
});
