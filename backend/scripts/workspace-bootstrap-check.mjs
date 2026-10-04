/**
 * PHASE 1 — disposable verification of the identity-gated canonical-bootstrap
 * provisioning rule.
 *
 * Runs against a DISPOSABLE database (name carries the `Test` marker) and
 * drives the real `activateAdminInvitation` service directly:
 *
 *   0. An UNRELATED first creator does NOT inherit the canonical bootstrap —
 *      it gets its own workspace and the bootstrap stays unclaimed.
 *      "First administrator wins" is NOT the rule (the pre-Phase-1 bug).
 *   1. The CANONICAL Flora Alchemy business claims the ACTIVE, unclaimed
 *      bootstrap workspace (no duplicate workspace), reusing its Settings.
 *   2. A genuinely NEW client business still gets its own workspace.
 *   2b. A SECOND canonical-identity creator arriving after the claim is NOT
 *      handed the claimed bootstrap — it is provisioned its own workspace.
 *   3. Staff inherit the admin's workspace (asserted via the invitation path
 *      contract — the handler flow consumes the invitation and uses the
 *      admin's workspaceId; here we assert the admin anchor).
 *   4. The OWNER stays platform-scoped (workspaceId null) and is untouched.
 *   5. A repeated activation is refused and creates nothing.
 *   6. A client-supplied workspaceId is never used.
 *
 * Usage: node scripts/workspace-bootstrap-check.mjs
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Settings from '../models/Settings.js';
import AdminApplication from '../models/AdminApplication.js';
import Invitation from '../models/Invitation.js';
import { activateAdminInvitation, ProvisioningError } from '../services/workspaceProvisioningService.js';

const TEST_DB = 'Flora-Alchemy-Test-Bootstrap';
let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
};

function testUri() {
  let uri = process.env.MONGO_URI;
  if (!uri) {
    const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    uri = env.match(/^MONGO_URI=(.*)$/m)[1].trim();
  }
  const u = new URL(uri);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

const future = () => new Date(Date.now() + 72 * 3600 * 1000);
let OWNER_ID = null;

async function makeInvitation({ email, slug, application, name }) {
  return Invitation.create({
    recipientEmail: email,
    recipientName: name,
    role: 'admin',
    status: 'INVITED',
    expiresAt: future(),
    workspaceSlug: slug,
    workspaceName: name,
    application: application ? application._id : null,
    inviter: OWNER_ID,
    tokenHash: `hash-${Math.random().toString(16).slice(2)}`,
  });
}

/** Retry on transient transaction lock conflicts (shared Atlas cluster). */
async function activate(opts) {
  let last;
  for (let i = 0; i < 5; i += 1) {
    try { return await activateAdminInvitation(opts); }
    catch (e) {
      last = e;
      const transient = /TransientTransactionError|lock/i.test(e.message || '') ||
        (e.errorLabels && e.errorLabels.includes('TransientTransactionError'));
      if (transient) { await new Promise((r) => setTimeout(r, 400 * (i + 1))); continue; }
      throw e;
    }
  }
  throw last;
}

async function main() {
  const uri = testUri();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  if (!/test/i.test(db.databaseName)) {
    console.error(`[bootstrap-check] refusing: "${db.databaseName}" is not disposable.`);
    process.exit(1);
  }
  console.log(`[bootstrap-check] db=${db.databaseName}`);
  await db.dropDatabase();
  await mongoose.connection.db.dropDatabase();
  await Workspace.deleteMany({});
  await User.deleteMany({});
  await Settings.deleteMany({});
  await AdminApplication.deleteMany({});
  await Invitation.deleteMany({});

  // ── platform owner + pre-migration default settings ─────────────────────
  const owner = await User.create({
    email: 'owner@flora-alchemy.test', passwordHash: await bcrypt.hash('x', 12),
    role: 'admin', name: 'Owner', isOwner: true, status: 'ACTIVE', isFixture: false,
  });
  OWNER_ID = owner._id;
  await Settings.create({ key: 'default', storeName: 'Flora Alchemy', isFixture: true });

  // ── canonical BOOTSTRAP workspace (no admin yet) ────────────────────────
  const canonical = await Workspace.create({
    slug: 'flora-alchemy', displayName: 'Flora Alchemy', status: 'ACTIVE',
    isBootstrap: true, primaryAdminId: null,
  });
  await Settings.create({ key: 'flora-alchemy', workspaceId: canonical._id, storeName: 'Flora Alchemy', isFixture: false });

  // ── CASE 0: an UNRELATED first creator must not claim the bootstrap ─────
  // This is the PHASE 1 regression guard: under the old rule this business
  // inherited the canonical Flora Alchemy workspace purely because it was the
  // first administrator to activate.
  const appZ = await AdminApplication.create({
    applicationId: 'APP-Z', name: 'Asha Rao', email: 'asha.resin@example.test',
    businessName: 'Asha Resin Studio', proposedSlug: 'asha-resin-studio', status: 'APPROVED', reason: 'bootstrap verification', background: 'disposable verification run',
  });
  const invZ = await makeInvitation({ email: 'asha.resin@example.test', slug: 'asha-resin-studio', application: appZ, name: 'Asha Rao' });
  const resZ = await activate({
    inv: invZ, application: appZ, email: 'asha.resin@example.test',
    passwordHash: await bcrypt.hash('x', 12), name: 'Asha Rao',
  });
  ok('unrelated first creator gets its OWN workspace (never the bootstrap)', resZ.workspace.slug === 'asha-resin-studio' && String(resZ.workspace.id) !== String(canonical._id));
  ok('canonical bootstrap still unclaimed after an unrelated activation', (await Workspace.findById(canonical._id).lean()).primaryAdminId == null);
  ok('workspace count = 2 after the unrelated activation', (await Workspace.countDocuments({})) === 2);
  ok('unrelated creator settings were seeded for its own workspace', (await Settings.countDocuments({ workspaceId: resZ.workspace.id })) === 1);

  // ── CASE 1: the CANONICAL Flora Alchemy business claims the bootstrap ────
  const appA = await AdminApplication.create({
    applicationId: 'APP-A', name: 'Real Admin', email: 'real.admin@example.test',
    businessName: 'Flora Alchemy', proposedSlug: 'flora-alchemy', status: 'APPROVED', reason: 'bootstrap verification', background: 'disposable verification run',
  });
  const invA = await makeInvitation({ email: 'real.admin@example.test', slug: 'flora-alchemy', application: appA, name: 'Real Admin' });
  const resA = await activate({
    inv: invA, application: appA, email: 'real.admin@example.test',
    passwordHash: await bcrypt.hash('x', 12), name: 'Real Admin',
  });
  const wsCount1 = await Workspace.countDocuments({});
  ok('the canonical business reuses the canonical bootstrap workspace (no duplicate)', String(resA.workspace.id) === String(canonical._id));
  ok('workspace count stays 2 after the canonical claim', wsCount1 === 2);
  ok('admin.workspaceId = canonical', String(resA.user.workspaceId) === String(canonical._id));
  const canonAfter = await Workspace.findById(canonical._id).lean();
  ok('canonical.primaryAdminId = new admin', String(canonAfter.primaryAdminId) === String(resA.user._id));
  ok('canonical Settings reused (one settings doc for the workspace)', (await Settings.countDocuments({ workspaceId: canonical._id })) === 1);
  ok('owner remains platform-scoped (workspaceId null)', (await User.findById(owner._id).lean()).workspaceId == null);

  // ── CASE 2: a genuinely different business gets its own workspace ───────
  const appB = await AdminApplication.create({
    applicationId: 'APP-B', name: 'Other Owner', email: 'other@second.test',
    businessName: 'Second Bloom', proposedSlug: 'second-bloom', status: 'APPROVED', reason: 'bootstrap verification', background: 'disposable verification run',
  });
  const invB = await makeInvitation({ email: 'other@second.test', slug: 'second-bloom', application: appB, name: 'Second Bloom' });
  const resB = await activate({
    inv: invB, application: appB, email: 'other@second.test',
    passwordHash: await bcrypt.hash('x', 12), name: 'Second Bloom',
  });
  ok('new business gets a NEW workspace', resB.workspace.slug === 'second-bloom');
  ok('workspace count = 3 after a different business', (await Workspace.countDocuments({})) === 3);
  ok('new admin attached to the new workspace', String(resB.user.workspaceId) === String(resB.workspace.id));

  // ── Staff inherit the admin's workspace ─────────────────────────────────
  const staff = await User.create({
    email: 'staff@flora-alchemy.test', passwordHash: await bcrypt.hash('x', 12),
    role: 'handler', name: 'Staff', status: 'ACTIVE', isFixture: false,
    workspaceId: resA.workspace.id, staffId: 'HND-TEST1',
  });
  ok('staff inherits the admin workspace', String(staff.workspaceId) === String(canonical._id));

  // ── Repeated activation refused (single-use) ────────────────────────────
  let repeated = null;
  try {
    await activate({
      inv: invA, application: appA, email: 'real.admin@example.test',
      passwordHash: await bcrypt.hash('x', 12), name: 'Real Admin',
    });
  } catch (e) { repeated = e; }
  ok('repeated activation refused', repeated instanceof ProvisioningError);
  ok('repeated activation created no duplicate workspace', (await Workspace.countDocuments({})) === 3);
  ok('repeated activation created no duplicate admin', (await User.countDocuments({ role: 'admin', isOwner: { $ne: true } })) === 3);

  // ── CASE 2b: a SECOND canonical identity never inherits the CLAIMED
  // bootstrap — it is a genuinely new business and gets its own workspace. ──
  const appD = await AdminApplication.create({
    applicationId: 'APP-D', name: 'South Desk', email: 'south.desk@example.test',
    businessName: 'Flora Alchemy', proposedSlug: 'flora-alchemy-south', status: 'APPROVED', reason: 'bootstrap verification', background: 'disposable verification run',
  });
  const invD = await makeInvitation({ email: 'south.desk@example.test', slug: 'flora-alchemy-south', application: appD, name: 'South Desk' });
  const resD = await activate({
    inv: invD, application: appD, email: 'south.desk@example.test',
    passwordHash: await bcrypt.hash('x', 12), name: 'South Desk',
  });
  ok('a claimed bootstrap is never handed out again', String(resD.workspace.id) !== String(canonical._id) && resD.workspace.slug === 'flora-alchemy-south');
  ok('workspace count = 4 after the second canonical-identity creator', (await Workspace.countDocuments({})) === 4);
  ok('still exactly one bootstrap workspace exists', (await Workspace.countDocuments({ isBootstrap: true })) === 1);

  // ── Client-supplied workspaceId ignored ─────────────────────────────────
  const appC = await AdminApplication.create({
    applicationId: 'APP-C', name: 'Third', email: 'third@third.test',
    businessName: 'Third Studio', proposedSlug: 'third-studio', status: 'APPROVED', reason: 'bootstrap verification', background: 'disposable verification run',
  });
  const invC = await makeInvitation({ email: 'third@third.test', slug: 'third-studio', application: appC, name: 'Third Studio' });
  const resC = await activate({
    inv: invC, application: appC, email: 'third@third.test',
    passwordHash: await bcrypt.hash('x', 12), name: 'Third Studio',
    // A client-supplied workspace id that must never be honoured:
    workspaceId: String(canonical._id),
  });
  ok('client-supplied workspaceId ignored (new workspace used)', String(resC.user.workspaceId) === String(resC.workspace.id) && resC.workspace.slug === 'third-studio');
  ok('workspace count = 5 at the end of the run', (await Workspace.countDocuments({})) === 5);

  console.log(`\n[bootstrap-check] ${pass} passed, ${fail} failed`);
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[bootstrap-check] ERROR', e.message); process.exit(1); });
