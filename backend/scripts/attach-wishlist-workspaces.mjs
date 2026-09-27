/**
 * Phase 22.5 — attach unscoped wishlists to the initial workspace (STEP 13A).
 *
 * Safe by construction:
 *   · `--report` (read-only) lists candidate documents + duplicate detection.
 *   · apply requires the SAME production gates as the other 22.5 tools —
 *     a disposable database, OR a recognised production database with BOTH
 *     CONFIRM_DATABASE_UNSAFE_OPERATION=<name> and
 *     WORKSPACE_MIGRATION_CONFIRM=APPLY_PRODUCTION_WORKSPACE_MIGRATION.
 *   · it refuses when the platform does not have EXACTLY ONE ACTIVE workspace
 *     (attribution would be ambiguous), or when a duplicate
 *     (customerId, workspaceId) would result.
 *   · it NEVER deletes or merges; it only sets workspaceId on unscoped rows.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { classifyDatabase, assertSafeDatabase, EnvironmentSafetyError } from '../utils/environmentGuard.js';
import Workspace from '../models/Workspace.js';
import Wishlist from '../models/Wishlist.js';

const PRODUCTION_MIGRATION_CONFIRM = 'APPLY_PRODUCTION_WORKSPACE_MIGRATION';
const reportOnly = process.argv.includes('--report');
const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('[wishlists] MONGO_URI is not configured.');
  process.exit(1);
}

function refuse(message) {
  console.error(`[wishlists] ${message}`);
  process.exit(1);
}

function resolveSafety() {
  const info = classifyDatabase(uri);
  if (!info.dbName) refuse('the database name could not be determined from MONGO_URI.');
  const purpose = String(process.env.WORKSPACE_MIGRATION_CONFIRM || '') === PRODUCTION_MIGRATION_CONFIRM;
  const exact = String(process.env.CONFIRM_DATABASE_UNSAFE_OPERATION || '') === info.dbName;
  if (info.disposable) {
    if (purpose) refuse('WORKSPACE_MIGRATION_CONFIRM is set but the target is disposable — unset the production flags.');
    try {
      assertSafeDatabase(uri, 'attach wishlist workspaces');
    } catch (err) {
      if (err instanceof EnvironmentSafetyError) refuse(err.message);
      throw err;
    }
    return { info, production: false };
  }
  if (!info.nameProtected) refuse(`"${info.dbName}" is neither disposable nor a recognised production database (PRODUCTION_DB_NAMES).`);
  if (!exact) refuse(`set CONFIRM_DATABASE_UNSAFE_OPERATION=${info.dbName} to confirm the exact database name.`);
  if (!purpose) refuse(`set WORKSPACE_MIGRATION_CONFIRM=${PRODUCTION_MIGRATION_CONFIRM} to confirm the intent.`);
  return { info, production: true };
}

await mongoose.connect(uri);
const cls = classifyDatabase(uri);
console.log(`[wishlists] connected — db=${cls.dbName} host=${cls.localHost ? 'local' : 'remote'} class=${cls.disposable ? 'disposable' : 'PROTECTED'}${reportOnly ? ' (report only)' : ''}`);

const actives = await Workspace.find({ status: 'ACTIVE' }).select('slug displayName').lean();
const unscoped = await Wishlist.find({ $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }] })
  .select('customerId productIds workspaceId')
  .lean();
const totalBefore = await Wishlist.countDocuments({});

console.log(`[wishlists] total=${totalBefore} unscoped=${unscoped.length} ACTIVE workspaces=${actives.length} [${actives.map((w) => w.slug).join(', ')}]`);
for (const w of unscoped) {
  console.log(`  – doc ${String(w._id)} customerId=${String(w.customerId).slice(0, 6)}… productIds=${(w.productIds || []).length}`);
}

if (actives.length !== 1) {
  refuse(`refusing: expected EXACTLY ONE ACTIVE workspace, found ${actives.length}. Attribution would be ambiguous.`);
}
const workspace = actives[0];

// Duplicate guard: attaching workspaceId must not create a duplicate
// (customerId, workspaceId).
const dup = await Wishlist.aggregate([
  { $match: { customerId: { $in: unscoped.map((w) => w.customerId) }, workspaceId: workspace._id } },
  { $group: { _id: '$customerId', n: { $sum: 1 } } },
  { $match: { n: { $gt: 0 } } },
]);
if (dup.length) {
  refuse(`refusing: ${dup.length} customer(s) already have a wishlist in workspace ${workspace.slug}; attaching would create a duplicate.`);
}

console.log(`\nPLAN: attach ${unscoped.length} wishlist doc(s) to workspace "${workspace.slug}" (${workspace.displayName}).`);
console.log(`  wishlist count before: ${totalBefore}`);
console.log(`  wishlist count after (expected): ${totalBefore} (no inserts/deletes)`);
console.log('  mutation: set workspaceId on the unscoped documents only');

if (reportOnly) {
  console.log('\n[wishlists] --report: NO CHANGES MADE.');
  await mongoose.disconnect();
  process.exit(0);
}

resolveSafety();

if (unscoped.length === 0) {
  console.log('[wishlists] nothing to attach — all wishlists already scoped.');
} else {
  const res = await Wishlist.updateMany(
    { _id: { $in: unscoped.map((w) => w._id) } },
    { $set: { workspaceId: workspace._id } }
  );
  console.log(`[wishlists] attached ${res.modifiedCount} document(s) to ${workspace.slug}.`);
}

const remaining = await Wishlist.countDocuments({ $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }] });
const totalAfter = await Wishlist.countDocuments({});
const inWs = await Wishlist.countDocuments({ workspaceId: workspace._id });
console.log(`[wishlists] AFTER total=${totalAfter} unscoped=${remaining} in ${workspace.slug}=${inWs}`);
await mongoose.disconnect();
if (remaining !== 0) process.exit(1);
console.log('[wishlists] DONE.');
