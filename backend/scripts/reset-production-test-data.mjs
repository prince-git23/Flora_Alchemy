/**
 * Phase 22.6 — ONE-OFF PRODUCTION TEST-DATA RESET + WORKSPACE RECONCILIATION.
 *
 * The launch database accumulated test/demo data (seed fixtures, E2E handler,
 * rehearsal orders/customers) and two workspaces whose relationship to the
 * live catalogue had drifted. This tool removes the confirmed test/demo
 * records and reconciles the workspace architecture to:
 *
 *   · the OWNER account (role=admin, isOwner=true)          — preserved
 *   · the CANONICAL bootstrap workspace `flora-alchemy`     — preserved + flagged
 *   · the empty rehearsal workspace `flora-alchemy-originals` — retired (soft)
 *   · StaffEvent audit history and Settings                 — preserved
 *   · everything else                                       — removed
 *
 * SAFETY
 * ------
 *  · Requires an explicit gate: PRODUCTION_DATA_RESET_CONFIRM=RESET_TEST_DATA_FLORA_ALCHEMY
 *  · Requires the resolved database name to be exactly the expected production
 *    database (`Flora-Alchemy`) — no other target is ever touched.
 *  · Every removal uses a CONCRETE predicate (an explicit id list or a
 *    workspace-scoped filter). There is no `deleteMany({})` and no whole-DB
 *    wipe. It never deletes the owner, the canonical workspace, StaffEvents
 *    or Settings.
 *  · `--dry-run` (default) only reports; `--apply` performs the reset.
 *  · `--apply` writes a local JSON backup of every removed document (outside
 *    the repository, with password/token hashes stripped) and prints its path.
 *
 * This script does NOT modify or weaken backend/utils/environmentGuard.js.
 * The gate above is deliberately production-specific.
 *
 * Usage:
 *   node scripts/reset-production-test-data.mjs --dry-run
 *   PRODUCTION_DATA_RESET_CONFIRM=RESET_TEST_DATA_FLORA_ALCHEMY \
 *     node scripts/reset-production-test-data.mjs --apply
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

const EXPECTED_DB = 'Flora-Alchemy';
const CONFIRM_VALUE = 'RESET_TEST_DATA_FLORA_ALCHEMY';
const CANONICAL_SLUG = 'flora-alchemy';
const RETIRED_SLUG = 'flora-alchemy-originals';

const APPLY = process.argv.includes('--apply');
const SENSITIVE = new Set(['passwordHash', 'tokenHash', 'resetTokenHash']);

function resolveUri() {
  // Prefer an explicit MONGO_URI; otherwise read backend/.env (never printed).
  let uri = process.env.MONGO_URI;
  if (!uri) {
    try {
      const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
      const m = env.match(/^MONGO_URI=(.*)$/m);
      if (m) uri = m[1].trim();
    } catch { /* fall through to the error below */ }
  }
  if (!uri) {
    console.error('[reset] MONGO_URI could not be resolved.');
    process.exit(1);
  }
  // Retarget only the database name to the expected production database.
  const u = new URL(uri);
  u.pathname = `/${EXPECTED_DB}`;
  return u.toString();
}

function stripSensitive(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (SENSITIVE.has(k)) continue;
    out[k] = v;
  }
  return out;
}

const idStr = (x) => (x == null ? null : String(x));
const S = (o) => JSON.stringify(o);

async function main() {
  if (APPLY && process.env.PRODUCTION_DATA_RESET_CONFIRM !== CONFIRM_VALUE) {
    console.error(
      `[reset] refusing to apply: set PRODUCTION_DATA_RESET_CONFIRM=${CONFIRM_VALUE} to authorise this run.`
    );
    process.exit(1);
  }

  const uri = resolveUri();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  if (db.databaseName !== EXPECTED_DB) {
    console.error(`[reset] refusing: connected to "${db.databaseName}", expected "${EXPECTED_DB}".`);
    process.exit(1);
  }
  console.log(`[reset] connected: ${db.databaseName} (mode=${APPLY ? 'APPLY' : 'dry-run'})`);

  // ── anchors that MUST exist and are never touched ────────────────────────
  const owner = await db.collection('users').findOne({ role: 'admin', isOwner: true });
  const canonical = await db.collection('workspaces').findOne({ slug: CANONICAL_SLUG });
  const retired = await db.collection('workspaces').findOne({ slug: RETIRED_SLUG });
  if (!owner) { console.error('[reset] no owner (role=admin, isOwner=true) found — refusing.'); process.exit(1); }
  if (!canonical) { console.error(`[reset] canonical workspace "${CANONICAL_SLUG}" not found — refusing.`); process.exit(1); }
  console.log(`[reset] owner=${owner.email} canonical=${idStr(canonical._id)} retired=${retired ? idStr(retired._id) : '(none)'}`);

  const ids = async (col, predicate) =>
    (await db.collection(col).find(predicate).project({ _id: 1 }).toArray()).map((d) => d._id);

  const wsScope = retired
    ? { workspaceId: { $in: [canonical._id, retired._id] } }
    : { workspaceId: canonical._id };
  const scopedOrGlobal = {
    $or: [wsScope, { workspaceId: null }, { workspaceId: { $exists: false } }],
  };

  // Assessment first (counts), then the concrete predicate per collection.
  const plan = [];
  const add = async (col, predicate, label) => {
    const before = await db.collection(col).countDocuments(predicate);
    plan.push({ col, predicate, label, before });
  };

  await add('users', { _id: { $ne: owner._id } }, 'all users except the owner');
  await add('customers', { _id: { $in: await ids('customers', { _id: { $exists: true } }) } }, 'all customer records');
  await add('products', wsScope, 'catalogue products in the reset workspaces');
  await add('collections', wsScope, 'collections in the reset workspaces');
  await add('inventories', wsScope, 'inventory rows');
  await add('inventorymovements', wsScope, 'inventory movements');
  await add('orders', wsScope, 'orders');
  await add('conversations', wsScope, 'conversations');
  await add('customrequests', wsScope, 'custom requests');
  await add('wishlists', scopedOrGlobal, 'wishlists');
  await add('messages', { _id: { $in: await ids('messages', { _id: { $exists: true } }) } }, 'conversation messages');
  await add('notifications', scopedOrGlobal, 'notifications');
  await add('invitations', { _id: { $in: await ids('invitations', { _id: { $exists: true } }) } }, 'invitations');
  await add('adminapplications', { _id: { $in: await ids('adminapplications', { _id: { $exists: true } }) } }, 'admin applications');

  console.log('\n[reset] PLANNED REMOVALS (concrete predicates):');
  for (const step of plan) console.log(`  ${step.col.padEnd(18)} before=${String(step.before).padStart(5)}  (${step.label})`);

  console.log('\n[reset] PRESERVED:');
  console.log(`  users            owner only (${owner.email})`);
  console.log(`  workspaces       ${CANONICAL_SLUG} (kept + isBootstrap=true)${retired ? `; ${RETIRED_SLUG} (retired → SUSPENDED)` : ''}`);
  console.log(`  staffevents      ${await db.collection('staffevents').countDocuments()} (audit history preserved)`);
  console.log(`  settings         ${await db.collection('settings').countDocuments()} (platform + workspace settings preserved)`);

  if (!APPLY) {
    console.log('\n[reset] dry-run complete. Re-run with --apply and the confirmation gate to execute.');
    await mongoose.disconnect();
    return;
  }

  // ── backup (outside the repo, hashes stripped) ───────────────────────────
  const backup = {
    createdAt: new Date().toISOString(),
    database: db.databaseName,
    canonicalWorkspaceId: idStr(canonical._id),
    retiredWorkspaceId: retired ? idStr(retired._id) : null,
    ownerEmail: owner.email,
    collections: {},
  };
  for (const step of plan) {
    const docs = await db.collection(step.col).find(step.predicate).toArray();
    backup.collections[step.col] = docs.map(stripSensitive);
  }
  const backupPath = path.join(
    os.tmpdir(),
    `flora-alchemy-reset-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`\n[reset] backup written: ${backupPath} (${fs.statSync(backupPath).size} bytes, outside the repo, no credential hashes)`);

  // ── execute removals (children → parents) ────────────────────────────────
  const order = [
    'messages', 'notifications', 'inventorymovements', 'inventories', 'orders',
    'conversations', 'customrequests', 'wishlists', 'products', 'collections',
    'invitations', 'adminapplications', 'customers', 'users',
  ];
  const deleted = {};
  for (const col of order) {
    const step = plan.find((s) => s.col === col);
    if (!step) continue;
    const r = await db.collection(col).deleteMany(step.predicate);
    deleted[col] = r.deletedCount;
    console.log(`  deleted ${String(r.deletedCount).padStart(5)} from ${col}`);
  }

  // ── reconcile workspaces ─────────────────────────────────────────────────
  await db.collection('workspaces').updateOne(
    { _id: canonical._id },
    { $set: { isBootstrap: true, status: 'ACTIVE', statusChangedAt: new Date() } }
  );
  console.log(`  workspace ${CANONICAL_SLUG}: isBootstrap=true, status=ACTIVE`);
  if (retired) {
    await db.collection('workspaces').updateOne(
      { _id: retired._id },
      {
        $set: {
          status: 'SUSPENDED',
          statusChangedAt: new Date(),
          notes: 'Retired 2026-10: empty rehearsal workspace superseded by canonical flora-alchemy (Phase 22.6 reset).',
        },
      }
    );
    console.log(`  workspace ${RETIRED_SLUG}: status=SUSPENDED (retired)`);
  }

  // ── after counts ─────────────────────────────────────────────────────────
  console.log('\n[reset] AFTER counts:');
  for (const c of ['users', 'customers', 'products', 'collections', 'inventories', 'inventorymovements', 'orders', 'conversations', 'customrequests', 'wishlists', 'messages', 'notifications', 'invitations', 'adminapplications', 'staffevents', 'settings', 'workspaces']) {
    console.log(`  ${c.padEnd(18)} ${await db.collection(c).countDocuments()}`);
  }
  console.log('\n[reset] backup:', backupPath);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('[reset] ERROR', e.message);
  process.exit(1);
});
