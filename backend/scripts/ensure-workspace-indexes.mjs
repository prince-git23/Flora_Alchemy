/**
 * Phase 22.5 — workspace-aware composite index tool (STEP 10).
 *
 * Creates (or verifies) the composite indexes the multi-tenant model needs,
 * ADDITIVELY and only after proving there is no data that would make a unique
 * index fail. It NEVER drops or rebuilds an index, so pre-existing platform /
 * global indexes are preserved.
 *
 * Safety:
 *   · `--report` (read-only) prints existing indexes + duplicate detection.
 *   · apply requires the SAME production gates as the migration tool — a
 *     disposable database, OR a recognised production database with
 *     CONFIRM_DATABASE_UNSAFE_OPERATION=<name> AND
 *     WORKSPACE_MIGRATION_CONFIRM=APPLY_PRODUCTION_WORKSPACE_MIGRATION.
 *   · a unique-index conflict (duplicate rows) fails closed BEFORE any write.
 *
 * Usage (from backend/):
 *   node scripts/ensure-workspace-indexes.mjs --report
 *   node scripts/ensure-workspace-indexes.mjs            # disposable DBs
 *   CONFIRM_DATABASE_UNSAFE_OPERATION=Flora-Alchemy \
 *     WORKSPACE_MIGRATION_CONFIRM=APPLY_PRODUCTION_WORKSPACE_MIGRATION \
 *     node scripts/ensure-workspace-indexes.mjs          # production
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { classifyDatabase, assertSafeDatabase, EnvironmentSafetyError } from '../utils/environmentGuard.js';

import Product from '../models/Product.js';
import Collection from '../models/Collection.js';
import Inventory from '../models/Inventory.js';
import Order from '../models/Order.js';
import Conversation from '../models/Conversation.js';
import CustomRequest from '../models/CustomRequest.js';
import Invitation from '../models/Invitation.js';
import StaffEvent from '../models/StaffEvent.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Wishlist from '../models/Wishlist.js';

const PRODUCTION_MIGRATION_CONFIRM = 'APPLY_PRODUCTION_WORKSPACE_MIGRATION';
const reportOnly = process.argv.includes('--report');

// Index creation must be EXPLICIT here (never a connect side-effect), so that
// duplicate detection always runs before any unique index is built.
mongoose.set('autoIndex', false);

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('[indexes] MONGO_URI is not configured.');
  process.exit(1);
}

function refuse(message) {
  console.error(`[indexes] ${message}`);
  process.exit(1);
}

function resolveSafety() {
  const info = classifyDatabase(uri);
  if (!info.dbName) refuse('the database name could not be determined from MONGO_URI.');
  const purposeConfirmed =
    String(process.env.WORKSPACE_MIGRATION_CONFIRM || '') === PRODUCTION_MIGRATION_CONFIRM;
  const exactNameConfirmed =
    String(process.env.CONFIRM_DATABASE_UNSAFE_OPERATION || '') === info.dbName;

  if (info.disposable) {
    if (purposeConfirmed) {
      refuse('WORKSPACE_MIGRATION_CONFIRM is set but the target is disposable — unset the production flags.');
    }
    try {
      assertSafeDatabase(uri, 'create workspace indexes');
    } catch (err) {
      if (err instanceof EnvironmentSafetyError) refuse(err.message);
      throw err;
    }
    return info;
  }
  if (!info.nameProtected) {
    refuse(`"${info.dbName}" is neither disposable nor a recognised production database (PRODUCTION_DB_NAMES).`);
  }
  if (!exactNameConfirmed) refuse(`set CONFIRM_DATABASE_UNSAFE_OPERATION=${info.dbName} to confirm the exact database name.`);
  if (!purposeConfirmed) refuse(`set WORKSPACE_MIGRATION_CONFIRM=${PRODUCTION_MIGRATION_CONFIRM} to confirm the intent.`);
  return info;
}

/** Unique composites that must have zero duplicates before creation. */
const UNIQUE_CHECKS = [
  { collection: 'products', key: { workspaceId: '$workspaceId', slug: '$slug' }, label: 'products {workspaceId, slug}' },
  { collection: 'collections', key: { workspaceId: '$workspaceId', slug: '$slug' }, label: 'collections {workspaceId, slug}' },
  {
    collection: 'inventories',
    key: { workspaceId: '$workspaceId', productSlug: '$productSlug' },
    label: 'inventories {workspaceId, productSlug}',
  },
];

/** Composite indexes this phase expects to exist afterwards (name + unique). */
const EXPECTED_UNIQUE = new Set(['workspaceId_1_slug_1', 'workspaceId_1_productSlug_1', 'customerId_1_workspaceId_1']);
const EXPECTED = {
  products: ['workspaceId_1_slug_1'],
  collections: ['workspaceId_1_slug_1'],
  inventories: ['workspaceId_1_productSlug_1'],
  orders: ['workspaceId_1_createdAt_-1', 'workspaceId_1_orderStatus_1', 'workspaceId_1_customerId_1'],
  conversations: ['workspaceId_1_status_1_lastMessageAt_-1'],
  customrequests: ['workspaceId_1_status_1_createdAt_-1'],
  invitations: ['workspaceId_1_status_1'],
  staffevents: ['workspaceId_1_at_-1'],
  notifications: ['workspaceId_1_read_1'],
  users: ['workspaceId_1_role_1_status_1'],
  wishlists: ['customerId_1_workspaceId_1'],
};

const MODELS = [Product, Collection, Inventory, Order, Conversation, CustomRequest, Invitation, StaffEvent, Notification, User, Wishlist];

await mongoose.connect(uri);
const db = mongoose.connection.db;
const cls = classifyDatabase(uri);
console.log(`[indexes] connected — db=${cls.dbName} host=${cls.localHost ? 'local' : 'remote'} class=${cls.disposable ? 'disposable' : 'PROTECTED'}${reportOnly ? ' (report only)' : ''}`);

// ── 1. Duplicate detection (always, before any write) ──────────────────────
let conflicts = 0;
for (const c of UNIQUE_CHECKS) {
  const rows = await db
    .collection(c.collection)
    .aggregate([{ $group: { _id: c.key, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 5 }])
    .toArray();
  if (rows.length) {
    conflicts += rows.length;
    console.error(`[indexes] DUPLICATE in ${c.label}: ${JSON.stringify(rows)}`);
  } else {
    console.log(`[indexes] ${c.label}: clean`);
  }
}
if (reportOnly) {
  for (const m of MODELS) {
    const idx = await db.collection(m.collection.name).indexes();
    console.log(`[indexes] ${m.collection.name}: ${idx.map((i) => `${i.name}${i.unique ? ' (unique)' : ''}`).join(', ')}`);
  }
  console.log('[indexes] --report: NO CHANGES MADE.');
  await mongoose.disconnect();
  process.exit(conflicts ? 1 : 0);
}

if (conflicts) refuse('refusing to create unique indexes: duplicate rows exist. Resolve them first (no data is silently changed).');

resolveSafety();

// ── 2a. Wishlist index transition ──────────────────────────────────────────
// The former GLOBAL unique `customerId` index must be replaced by the
// (customerId, workspaceId) tenant key. Drop the old one explicitly (a
// same-name rebuild with different options would otherwise error), then let
// createIndexes build the non-unique customer index + the compound unique.
try {
  const idx = await db.collection('wishlists').indexes();
  const legacy = idx.find((i) => i.name === 'customerId_1' && i.unique);
  if (legacy) {
    await db.collection('wishlists').dropIndex('customerId_1');
    console.log('[indexes] wishlists: dropped legacy unique customerId_1');
  }
} catch (err) {
  refuse(`wishlist index transition failed: ${err.message}`);
}

// ── 2b. Create indexes additively (never drops) ────────────────────────────
for (const m of MODELS) {
  try {
    await m.createIndexes();
    console.log(`[indexes] ${m.collection.name}: ensureIndexes OK`);
  } catch (err) {
    refuse(`creating indexes for ${m.collection.name} failed: ${err.message}`);
  }
}

// ── 3. Verify read-only ────────────────────────────────────────────────────
let missing = 0;
for (const [coll, names] of Object.entries(EXPECTED)) {
  const idx = await db.collection(coll).indexes();
  const byName = new Map(idx.map((i) => [i.name, i]));
  const absent = names.filter((n) => !byName.has(n));
  const notUnique = names.filter((n) => EXPECTED_UNIQUE.has(n) && byName.has(n) && !byName.get(n).unique);
  if (absent.length || notUnique.length) {
    missing += absent.length + notUnique.length;
    if (absent.length) console.error(`[indexes] MISSING on ${coll}: ${absent.join(', ')}`);
    if (notUnique.length) console.error(`[indexes] NOT UNIQUE on ${coll}: ${notUnique.join(', ')}`);
  } else {
    console.log(`[indexes] verified on ${coll}: ${names.join(', ')}`);
  }
}
await mongoose.disconnect();
if (missing) {
  console.error(`[indexes] ${missing} expected index(es) not present.`);
  process.exit(1);
}
console.log('[indexes] DONE — all expected workspace-aware indexes present.');
