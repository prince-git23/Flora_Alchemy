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
import {
  assertSafeDatabase,
  classifyDatabase,
  describeDatabase,
  EnvironmentSafetyError,
} from '../utils/environmentGuard.js';

const argv = process.argv.slice(2);
const reportOnly = !argv.includes('--apply');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '');
};
const slugFlag = flag('--slug');
const nameFlag = flag('--name');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** The Phase 22.5 purpose confirmation an --apply run needs for production. */
const PRODUCTION_MIGRATION_CONFIRM = 'APPLY_PRODUCTION_WORKSPACE_MIGRATION';

/** Set by resolveApplySafety() for --apply runs (null while reporting). */
let applySafety = null;

function refuse(message) {
  console.error(`[workspaces] ${message}`);
  process.exit(1);
}

/**
 * Phase 22.5 — can this --apply run write to its target database?
 *
 * The ORDINARY path is unchanged: a DISPOSABLE database (a name carrying a
 * test/qa/dev/smoke marker, or a localhost instance) migrates with just
 * `--name`/`--slug`, and `environmentGuard.assertSafeDatabase` remains the
 * gate that lets it through.
 *
 * MIGRATING PRODUCTION is deliberately a TWO-KEY operation that does NOT
 * weaken `environmentGuard`. The guard's own exact-name confirmation is
 * ANDed with a Phase 22.5 purpose confirmation, and the target must be a
 * database the application already recognises as production
 * (`PRODUCTION_DB_NAMES`):
 *
 *   CONFIRM_DATABASE_UNSAFE_OPERATION=Flora-Alchemy
 *   WORKSPACE_MIGRATION_CONFIRM=APPLY_PRODUCTION_WORKSPACE_MIGRATION
 *
 * A missing key, an unknown/relative database name, or pointing the
 * production flags at a disposable test database all fail closed BEFORE the
 * connection is opened.
 */
function resolveApplySafety() {
  const info = classifyDatabase(uri);
  const dbName = info.dbName;

  if (!dbName) {
    refuse('refusing to migrate: the database name could not be determined from MONGO_URI.');
  }

  const purposeConfirmed =
    String(process.env.WORKSPACE_MIGRATION_CONFIRM || '') === PRODUCTION_MIGRATION_CONFIRM;
  const exactNameConfirmed =
    String(process.env.CONFIRM_DATABASE_UNSAFE_OPERATION || '') === dbName;

  // ── Ordinary path — a disposable database. environmentGuard is the gate.
  if (info.disposable) {
    if (purposeConfirmed) {
      refuse(
        'WORKSPACE_MIGRATION_CONFIRM is set but the target is a disposable database. ' +
          'Unset the production confirmation flags — a disposable target needs only --name/--slug.'
      );
    }
    try {
      assertSafeDatabase(uri, 'backfill workspace membership');
    } catch (err) {
      if (err instanceof EnvironmentSafetyError) refuse(err.message);
      throw err;
    }
    return { info, production: false };
  }

  // ── Non-disposable. Only a database the app already recognises as
  //    production may be migrated, and only with BOTH explicit confirmations.
  if (!info.nameProtected) {
    refuse(
      `refusing to migrate: "${dbName}" is neither disposable nor a recognised production database ` +
        `(list it in PRODUCTION_DB_NAMES). Production must be positively identified, never inferred.`
    );
  }
  if (!exactNameConfirmed) {
    refuse(
      `refusing production migration: set CONFIRM_DATABASE_UNSAFE_OPERATION=${dbName} to confirm the exact database name.`
    );
  }
  if (!purposeConfirmed) {
    refuse(
      `refusing production migration: set WORKSPACE_MIGRATION_CONFIRM=${PRODUCTION_MIGRATION_CONFIRM} to confirm the intent.`
    );
  }
  return { info, production: true };
}

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('[workspaces] MONGO_URI is not configured.');
  process.exit(1);
}

if (!reportOnly) {
  // Apply WRITES. Fail closed unless the target is a disposable database OR a
  // positively identified production database carrying BOTH confirmations.
  applySafety = resolveApplySafety();
  if (!nameFlag || nameFlag.trim().length < 2) {
    refuse('--apply requires an explicit --name "<display name>" (nothing is invented).');
  }
  if (!slugFlag || !SLUG_RE.test(slugFlag)) {
    refuse('--apply requires an explicit --slug matching /^[a-z0-9][a-z0-9-]{1,63}$/.');
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
  { label: 'settings', model: Settings, plan: 'settings' },
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
    // Phase 22.5 — safety assertions. On a PRODUCTION target this tool is the
    // ONE-TIME initial migration, so a pre-existing Workspace is refused; on a
    // disposable target it stays a general backfill (used by the suites). A
    // re-apply (same slug) and unattributable operational records always fail
    // closed BEFORE any write. The counts mirror the --report "undeterminable"
    // block, EXCLUDING the deliberate platform/customer categories (owner
    // accounts, customer identities, admin invitations) which stay unscoped.
    const anyWorkspace = await Workspace.countDocuments({});
    const [badOrders, orphanConversations, danglingStaffEvents] = await Promise.all([
      count(Order, { $or: [{ customerId: { $exists: false } }, { customerId: null }] }),
      Conversation.countDocuments({
        $or: [{ customerId: { $exists: false } }, { customerId: null }],
      }),
      StaffEvent.countDocuments({ user: null, invitation: null, actor: null }),
    ]);
    const unresolved = badOrders + orphanConversations + danglingStaffEvents;

    if (existing) {
      console.error(`[workspaces] workspace "${slugFlag}" already exists — refusing to re-apply.`);
      process.exitCode = 1;
    } else if (applySafety && applySafety.production && anyWorkspace > 0) {
      console.error(
        `[workspaces] refusing production apply: ${anyWorkspace} Workspace document(s) already exist. ` +
          'The production migration creates exactly ONE initial workspace — inspect the existing state with --report instead.'
      );
      process.exitCode = 1;
    } else if (unresolved > 0) {
      console.error(
        `[workspaces] refusing to apply: ${unresolved} operational record(s) have undeterminable ownership ` +
          `(orders/conversations without a customerId: ${badOrders + orphanConversations}; ` +
          `staff events with no subject: ${danglingStaffEvents}). Resolve these before migrating — ownership is never guessed.`
      );
      process.exitCode = 1;
    } else {
      // Phase 22.5 — the initial Workspace is NEVER anchored to the platform
      // Owner (the owner is a platform identity, not a workspace member). The
      // only pre-existing administrators are fixture/suspended demo accounts,
      // which are not legitimate clients, so the initial workspace has no
      // primary admin until a real client is onboarded. primaryAdminId = null
      // is supported by the schema.
      const workspace = await Workspace.create({
        slug: slugFlag,
        displayName: String(nameFlag).trim(),
        status: 'ACTIVE',
        primaryAdminId: null,
        isFixture: false,
      });
      console.log(`[workspaces] created workspace ${workspace.slug} (${workspace.id})`);

      let attached = 0;
      for (const t of TARGETS) {
        if (t.plan === 'settings') continue; // handled separately below (clone, not attach)
        const filter = t.plan === 'invitation' ? { ...UNSCOPED, role: 'handler' } : { ...UNSCOPED };
        const res = await t.model.updateMany(filter, { $set: { workspaceId: workspace._id } });
        if (res.modifiedCount) {
          attached += res.modifiedCount;
          console.log(`[workspaces] ${t.label}: attached ${res.modifiedCount}`);
        }
      }

      // Settings: the platform singleton stays the public/platform document. A
      // workspace gets its OWN cloned settings document (key = slug) — the same
      // shape workspaceProvisioningService creates on client onboarding — so
      // platform configuration and tenant configuration remain separate.
      const singleton = await Settings.findOne({ key: 'default' }).lean();
      if (singleton) {
        const clone = { ...singleton };
        for (const f of ['_id', '__v', 'key', 'workspaceId', 'createdAt', 'updatedAt']) delete clone[f];
        await Settings.create({
          ...clone,
          key: workspace.slug,
          workspaceId: workspace._id,
          storeName: workspace.displayName,
          isFixture: false,
        });
        console.log(`[workspaces] settings: created workspace document (key=${workspace.slug})`);
      }

      // Attach STAFF identities only — never the owner, and never fixture/demo
      // accounts. A suspended seeded handler is not a legitimate member and is
      // deliberately left unscoped rather than silently transferred.
      const staffRes = await User.updateMany(
        { role: { $in: ['admin', 'handler'] }, isOwner: { $ne: true }, isFixture: { $ne: true }, ...UNSCOPED },
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
