/**
 * Phase 22.2 — workspace backfill (MIGRATION SCRIPT).
 *
 * PURPOSE
 * -------
 * The platform currently has NO workspace: every document is unscoped, which
 * is exactly why the store behaves as one tenant. Phase 22.5 turns that
 * single data set into a first-class workspace, and this script is the
 * instrument that will do it — deliberately split into two modes:
 *
 *   --report   (DEFAULT, ALWAYS SAFE) read-only. Prints the full inventory of
 *              unscoped documents per collection, an assignment plan, rows
 *              whose ownership cannot be determined, and slug-uniqueness
 *              readiness. It never writes a single byte, so it is safe to run
 *              against ANY database, including production.
 *
 *   --apply    (GUARDED, NOT RUN IN PHASE 22.2) performs the migration. It
 *              refuses to run unless ALL of the following are true:
 *                · `--name "<display name>"` AND `--slug <slug>` are supplied
 *                  explicitly — nothing ever invents a production displayName
 *                  or slug from a default;
 *                · the target database passes `assertSafeDatabase` (a
 *                  PROTECTED/production database fails closed even with the
 *                  flags present);
 *                · the slug is well-formed and not already taken.
 *
 * This phase only ships the script and runs `--report` against an ISOLATED
 * disposable test database. No production write, no production migration.
 *
 * Usage (from backend/):
 *   node scripts/backfill-workspaces.mjs --report
 *   node scripts/backfill-workspaces.mjs --report --slug flora-alchemy
 *   node scripts/backfill-workspaces.mjs --apply --name "Flora Alchemy" --slug flora-alchemy
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
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
import { assertSafeDatabase, describeDatabase, EnvironmentSafetyError } from '../utils/environmentGuard.js';

const argv = process.argv.slice(2);
const reportOnly = !argv.includes('--apply');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '');
};
const slugFlag = flag('--slug');
const nameFlag = flag('--name');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('[workspaces] MONGO_URI is not configured.');
  process.exit(1);
}

if (!reportOnly) {
  // Apply WRITES. Fail closed unless the target is unmistakably disposable.
  try {
    assertSafeDatabase(uri, 'backfill workspace membership');
  } catch (err) {
    if (err instanceof EnvironmentSafetyError) {
      console.error(`[workspaces] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  if (!nameFlag || nameFlag.trim().length < 2) {
    console.error('[workspaces] --apply requires an explicit --name "<display name>" (nothing is invented).');
    process.exit(1);
  }
  if (!slugFlag || !SLUG_RE.test(slugFlag)) {
    console.error('[workspaces] --apply requires an explicit --slug matching /^[a-z0-9][a-z0-9-]{1,63}$/.');
    process.exit(1);
  }
} else if (slugFlag && !SLUG_RE.test(slugFlag)) {
  console.error(`[workspaces] --slug "${slugFlag}" is not a valid workspace slug (preview ignored).`);
  process.exit(1);
}

await mongoose.connect(uri);
console.log(`[workspaces] connected — ${describeDatabase(uri)}${reportOnly ? ' (report only)' : ' (APPLY)'}`);

/**
 * Collections that become workspace-owned data. The KEY is the collection
 * name as it appears in MongoDB, the value describes how rows are attributed:
 *   'all'      every unscoped row belongs to the workspace
 *   'staff'    only handler/admin (non-owner) rows — customers/owners stay
 *              unscoped identities, they are not workspace members
 */
const TARGETS = [
  { label: 'products', model: Product, plan: 'all' },
  { label: 'collections', model: Collection, plan: 'all' },
  { label: 'orders', model: Order, plan: 'all' },
  { label: 'inventory', model: Inventory, plan: 'all' },
  { label: 'inventory movements', model: InventoryMovement, plan: 'all' },
  { label: 'conversations', model: Conversation, plan: 'all' },
  { label: 'custom requests', model: CustomRequest, plan: 'all' },
  { label: 'settings', model: Settings, plan: 'all' },
  { label: 'invitations', model: Invitation, plan: 'invitation' },
  { label: 'staff events', model: StaffEvent, plan: 'all' },
  { label: 'notifications', model: Notification, plan: 'all' },
];

const UNSCOPED = { $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }] };

async function count(model, filter = {}) {
  return model.countDocuments(filter);
}

try {
  const existingWorkspaces = await Workspace.find({}).select('slug displayName status createdAt').lean();

  // ── users by role ────────────────────────────────────────────────────────
  const byRole = await User.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }]);
  const roleCount = Object.fromEntries(byRole.map((r) => [r._id || 'unknown', r.n]));
  const owners = await count(User, { isOwner: true });
  const adminNonOwner = await count(User, { role: 'admin', isOwner: { $ne: true } });
  const handlers = await count(User, { role: 'handler' });
  const customers = await count(User, { role: 'customer' });
  const staffAssignable = await count(User, {
    role: { $in: ['admin', 'handler'] },
    isOwner: { $ne: true },
    ...UNSCOPED,
  });

  // ── per-collection inventory + assignment plan ───────────────────────────
  const plan = [];
  for (const t of TARGETS) {
    const total = await count(t.model);
    const unscoped = await count(t.model, UNSCOPED);
    let assignable = unscoped;
    if (t.plan === 'invitation') {
      // Admin invitations stay platform-level; handler invitations follow
      // their inviter's workspace.
      assignable = await count(t.model, { ...UNSCOPED, role: 'handler' });
    }
    plan.push({ label: t.label, total, unscoped, assignable });
  }

  // ── rows whose ownership cannot be determined ────────────────────────────
  const undeterminable = [];
  const badOrders = await count(Order, { $or: [{ customerId: { $exists: false } }, { customerId: null }] });
  if (badOrders) undeterminable.push({ what: 'orders without a customerId', n: badOrders });
  const orphanConversations = await Conversation.countDocuments({
    $or: [{ customerId: { $exists: false } }, { customerId: null }],
  });
  if (orphanConversations) undeterminable.push({ what: 'conversations without a customerId', n: orphanConversations });
  const adminInvites = await count(Invitation, { ...UNSCOPED, role: 'admin' });
  if (adminInvites) undeterminable.push({ what: 'admin invitations (stay platform-level, not auto-assigned)', n: adminInvites });
  const ownerInvites = await count(User, { isOwner: true, ...UNSCOPED });
  if (ownerInvites) undeterminable.push({ what: 'owner accounts (stay platform-level by design)', n: ownerInvites });
  const customerUsers = await count(User, { role: 'customer', ...UNSCOPED });
  if (customerUsers) undeterminable.push({ what: 'customer identities (not workspace members)', n: customerUsers });
  const danglingStaffEvents = await StaffEvent.countDocuments({
    user: null,
    invitation: null,
    actor: null,
  });
  if (danglingStaffEvents) {
    undeterminable.push({ what: 'staff events with no user/invitation/actor', n: danglingStaffEvents });
  }

  // ── slug-uniqueness readiness ────────────────────────────────────────────
  const dupCheck = async (model, field) => {
    const rows = await model.aggregate([
      { $match: { [field]: { $exists: true, $ne: null } } },
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $project: { _id: 0, value: '$_id', n: 1 } },
    ]);
    return rows;
  };
  const dupProducts = await dupCheck(Product, 'slug');
  const dupCollections = await dupCheck(Collection, 'slug');
  const dupInventory = await dupCheck(Inventory, 'productSlug');
  const slugTaken = slugFlag ? await count(Workspace, { slug: slugFlag }) : 0;
  const slugsReady =
    dupProducts.length === 0 && dupCollections.length === 0 && dupInventory.length === 0 && slugTaken === 0;

  // ── report ──────────────────────────────────────────────────────────────
  console.log('');
  console.log('PHASE 22.2 — WORKSPACE BACKFILL REPORT (read-only)');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`Workspaces already present: ${existingWorkspaces.length}`);
  existingWorkspaces.forEach((w) => console.log(`  - ${w.slug}  "${w.displayName}"  [${w.status}]`));

  console.log('\nUsers by role');
  console.log(`  admin: ${roleCount.admin || 0}   handler: ${roleCount.handler || 0}   customer: ${roleCount.customer || 0}   total: ${Object.values(roleCount).reduce((a, b) => a + b, 0)}`);
  console.log(`  owner accounts (isOwner): ${owners}`);
  console.log(`  administrators (non-owner): ${adminNonOwner}`);
  console.log(`  handlers: ${handlers}`);
  console.log(`  customer identities: ${customers}`);
  console.log(`  → staff rows the migration would attach: ${staffAssignable} (owners + customers stay unscoped by design)`);

  console.log('\nAssignment plan (unscoped → workspace)');
  for (const p of plan) {
    const suffix = p.assignable === p.unscoped ? '' : `   (${p.unscoped - p.assignable} stay unscoped)`;
    console.log(`  ${p.label.padEnd(22)} total ${String(p.total).padStart(5)}   unscoped ${String(p.unscoped).padStart(5)}   assignable ${String(p.assignable).padStart(5)}${suffix}`);
  }
  const totalAssignable = plan.reduce((a, p) => a + p.assignable, 0) + staffAssignable;
  console.log(`  ── documents the migration would attach in total: ${totalAssignable}`);

  console.log('\nUndeterminable / deliberately unassigned ownership');
  if (undeterminable.length === 0) {
    console.log('  none');
  } else {
    undeterminable.forEach((u) => console.log(`  - ${u.what}: ${u.n}`));
  }

  console.log('\nSlug-uniqueness readiness');
  console.log(`  duplicate product slugs: ${dupProducts.length}`);
  dupProducts.slice(0, 10).forEach((d) => console.log(`    ! ${d.value} ×${d.n}`));
  console.log(`  duplicate collection slugs: ${dupCollections.length}`);
  dupCollections.slice(0, 10).forEach((d) => console.log(`    ! ${d.value} ×${d.n}`));
  console.log(`  duplicate inventory productSlugs: ${dupInventory.length}`);
  dupInventory.slice(0, 10).forEach((d) => console.log(`    ! ${d.value} ×${d.n}`));
  if (slugFlag) {
    console.log(`  proposed workspace slug "${slugFlag}": ${slugTaken ? 'ALREADY TAKEN' : 'available'}`);
  } else {
    console.log('  no --slug supplied (pass --slug <slug> to preview availability)');
  }
  console.log(`  readiness: ${slugsReady ? 'READY' : 'BLOCKED — resolve the duplicates above first'}`);

  if (reportOnly) {
    console.log('\n[workspaces] --report: NO CHANGES MADE (read-only).');
    console.log('[workspaces] --apply is guarded and was not requested. It additionally requires');
    console.log('             --name / --slug and a disposable target database.');
    console.log('             The migration itself is scheduled for Phase 22.5.');
  } else {
    // ── apply (guarded; never reached against production) ──────────────────
    const existing = await Workspace.findOne({ slug: slugFlag }).select('_id');
    if (existing) {
      console.error(`[workspaces] workspace "${slugFlag}" already exists — refusing to re-apply.`);
      process.exitCode = 1;
    } else {
      const ownerDoc = await User.findOne({ isOwner: true, role: 'admin' }).sort({ createdAt: 1 }).select('_id');
      const workspace = await Workspace.create({
        slug: slugFlag,
        displayName: String(nameFlag).trim(),
        status: 'ACTIVE',
        primaryAdminId: ownerDoc ? ownerDoc._id : null,
        isFixture: false,
      });
      console.log(`[workspaces] created workspace ${workspace.slug} (${workspace.id})`);

      let attached = 0;
      for (const t of TARGETS) {
        const filter = t.plan === 'invitation' ? { ...UNSCOPED, role: 'handler' } : { ...UNSCOPED };
        const res = await t.model.updateMany(filter, { $set: { workspaceId: workspace._id } });
        if (res.modifiedCount) {
          attached += res.modifiedCount;
          console.log(`[workspaces] ${t.label}: attached ${res.modifiedCount}`);
        }
      }
      const staffRes = await User.updateMany(
        { role: { $in: ['admin', 'handler'] }, isOwner: { $ne: true }, ...UNSCOPED },
        { $set: { workspaceId: workspace._id } }
      );
      attached += staffRes.modifiedCount;
      console.log(`[workspaces] staff identities: attached ${staffRes.modifiedCount}`);
      console.log(`[workspaces] APPLY DONE — ${attached} document(s) attached to ${workspace.slug}.`);
    }
  }
} finally {
  await mongoose.disconnect();
}
