/**
 * PHASE 22.5 — LEGACY OWNERSHIP BACKFILL (MIGRATION SCRIPT).
 *
 * PURPOSE
 * -------
 * Close the workspace-ownership gaps that predate the Workspace model, using
 * ONLY authoritative evidence. Covered entities:
 *
 *   · ORDERS without workspaceId (§4) — attributed with the exact same
 *     classification the read-only audit uses, in evidence order:
 *       1. CustomRequest.workspaceId (order.customRequestId)
 *       2. Proposal.workspaceId      (order.proposalId)
 *       3. Product.workspaceId where EVERY catalogue line resolves to the
 *          same single workspace
 *     Anything else — bespoke-only orders, missing products, lines that
 *     resolve to different workspaces, owners that no longer exist — is
 *     AMBIGUOUS or INVALID and is NEVER written. Ownership is never guessed.
 *
 *   · Order.shopSnapshot (§5) — written ONLY when the historical identity is
 *     provable: the owning Workspace document must have been created AND last
 *     changed before the order existed (createdAt <= order.createdAt AND
 *     updatedAt <= order.createdAt). That proves the workspace's current
 *     {slug, displayName} IS the identity at order time. Otherwise the record
 *     is reported SNAPSHOT_NOT_PROVABLE and shopSnapshot stays null. The
 *     current Shop name is NEVER copied into a snapshot on faith.
 *
 *   · NOTIFICATIONS without workspaceId (§9) — attributed only through their
 *     source entity's workspaceId. Platform-wide `system` notifications stay
 *     null by design and are never touched.
 *
 *   · CONVERSATIONS without workspaceId (§10) — attributed only from their
 *     Order's workspace, and only once the Order itself owns one.
 *
 *   · WISHLISTS ARE NEVER TOUCHED (§11) — the wishlist merge is separate
 *     tooling (scripts/merge-wishlists-global.mjs) with its own confirmation.
 *     Products / Collections / Inventory are likewise out of scope here and
 *     are reported by scripts/production-consistency-audit.mjs instead.
 *
 * MODES
 * -----
 *   DRY-RUN (default, ALWAYS SAFE) — read-only. Prints the per-record
 *   classification with evidence, the exact mutation plan, and the migration
 *   summary table. It never writes, so it is safe against ANY database,
 *   including production.
 *
 *   --apply (GUARDED) performs the planned mutations. Every write is:
 *     · deterministic  — the evidence rules above, never inferred;
 *     · idempotent     — scoped filters such as { _id, workspaceId: null },
 *                        so a re-run plans and writes zero changes;
 *     · logged         — one line per mutation, and skipped no-ops are shown;
 *     · transactional when the topology supports transactions (falls back to
 *        per-document atomic updates on a standalone topology).
 *   A PRODUCTION target (a database name listed in PRODUCTION_DB_NAMES)
 *   additionally requires BOTH exact confirmation keys, before the connection
 *   is even opened:
 *
 *     CONFIRM_DATABASE_UNSAFE_OPERATION=<database-name>
 *     WORKSPACE_MIGRATION_CONFIRM=APPLY_PRODUCTION_WORKSPACE_MIGRATION
 *
 *   A generic CONFIRM=true is never accepted. Pointing the production keys at
 *   a disposable database fails closed as well.
 *
 * Usage (from backend/):
 *   node scripts/backfill-legacy-ownership.mjs                  # DRY-RUN
 *   node scripts/backfill-legacy-ownership.mjs --db Flora-Alchemy
 *   node scripts/backfill-legacy-ownership.mjs --apply          # guarded write
 *
 * The optional `--db <name>` only rewrites the path segment of MONGO_URI;
 * every safety guard classifies the FINAL connection string.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import Workspace from '../models/Workspace.js';
import Order from '../models/Order.js';
import CustomRequest from '../models/CustomRequest.js';
import Proposal from '../models/Proposal.js';
import Product from '../models/Product.js';
import Inventory from '../models/Inventory.js';
import Conversation from '../models/Conversation.js';
import Notification from '../models/Notification.js';
import {
  assertSafeDatabase,
  classifyDatabase,
  describeDatabase,
  EnvironmentSafetyError,
} from '../utils/environmentGuard.js';

const argv = process.argv.slice(2);
const applyMode = argv.includes('--apply');
const dbArgIdx = argv.indexOf('--db');
const explicitDb = dbArgIdx > -1 ? argv[dbArgIdx + 1] : null;

/** The Phase 22.5 purpose confirmation a production --apply run needs. */
const PRODUCTION_MIGRATION_CONFIRM = 'APPLY_PRODUCTION_WORKSPACE_MIGRATION';

const baseUri = process.env.MONGO_URI;
if (!baseUri) {
  console.error('[legacy-backfill] MONGO_URI is not configured.');
  process.exit(1);
}
const uri = explicitDb
  ? baseUri.replace(/\/[^/?]+(\?|$)/, `/${explicitDb}$1`)
  : baseUri;

function refuse(message) {
  console.error(`[legacy-backfill] ${message}`);
  process.exit(1);
}

/**
 * Can this --apply run write to its target database?
 *
 * DISPOSABLE target: ordinary path, gated only by
 * `environmentGuard.assertSafeDatabase`. PRODUCTION target: a TWO-KEY
 * operation that does not weaken the guard — the exact-name confirmation is
 * ANDed with the Phase 22.5 purpose confirmation, and the target must be a
 * database the application already recognises as production. Everything runs
 * BEFORE the connection is opened, so a refusal never touches data.
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
          'Unset the production confirmation flags — a disposable target needs only --apply.'
      );
    }
    try {
      assertSafeDatabase(uri, 'backfill legacy ownership');
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

// Fail closed BEFORE connecting when a write was requested.
const applySafety = applyMode ? resolveApplySafety() : null;

await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
console.log(
  `[legacy-backfill] connected — ${describeDatabase(uri)}${applyMode ? ' (APPLY)' : ' (DRY-RUN)'}`
);

// ── Load the read model (same shapes the read-only audit classifies) ───────
const workspaces = await Workspace.find({})
  .select('slug displayName createdAt updatedAt')
  .lean();
const wsIds = new Set(workspaces.map((w) => String(w._id)));
const wsById = new Map(workspaces.map((w) => [String(w._id), w]));

const orders = await Order.find({}).lean();
const orderById = new Map(orders.map((o) => [String(o.orderId), o]));

const products = await Product.find({}).select('slug workspaceId').lean();
const productBySlug = new Map(products.map((p) => [String(p.slug), p]));

const requests = await CustomRequest.find({}).select('workspaceId').lean();
const requestsById = new Map(requests.map((r) => [String(r._id), r]));

const proposals = await Proposal.find({}).select('workspaceId').lean();
const proposalsById = new Map(proposals.map((p) => [String(p._id), p]));

const conversations = await Conversation.find({}).select('orderId workspaceId customerId').lean();
const inventories = await Inventory.find({}).select('workspaceId').lean();

// ── Lookup maps (one pass; every source resolves in memory) ─────────────────
const orderByObjectId = new Map(orders.map((o) => [String(o._id), o]));
const productById = new Map(products.map((p) => [String(p._id), p]));
const requestById = new Map(requests.map((r) => [String(r._id), r]));
const proposalById = new Map(proposals.map((p) => [String(p._id), p]));
const conversationById = new Map(conversations.map((c) => [String(c._id), c]));
const inventoryById = new Map(inventories.map((i) => [String(i._id), i]));
const notifications = await Notification.find({})
  .select('type entityType entityId workspaceId userId role')
  .lean();

/**
 * EXACT copy of the read-only audit's classification (§4). Kept byte-for-byte
 * in behaviour so the dry-run, the audit and the apply can never disagree
 * about what ownership means.
 */
function classifyOrderMissingWs(order) {
  // Evidence order: CustomRequest -> Proposal -> Product chain.
  if (order.customRequestId) {
    const req = requestsById.get(String(order.customRequestId));
    if (req && req.workspaceId) {
      return { cls: 'PROVABLY_ATTRIBUTABLE', owner: String(req.workspaceId), via: 'CustomRequest.workspaceId' };
    }
    return { cls: 'AMBIGUOUS', owner: null, via: 'CustomRequest has no workspaceId' };
  }
  if (order.proposalId) {
    const prop = proposalsById.get(String(order.proposalId));
    if (prop && prop.workspaceId) {
      return { cls: 'PROVABLY_ATTRIBUTABLE', owner: String(prop.workspaceId), via: 'Proposal.workspaceId' };
    }
    return { cls: 'AMBIGUOUS', owner: null, via: 'Proposal has no workspaceId' };
  }
  const slugs = (order.items || []).filter((i) => i.productSlug).map((i) => String(i.productSlug));
  if (!slugs.length) {
    return { cls: 'AMBIGUOUS', owner: null, via: 'bespoke-only legacy order: no catalogue line, no request' };
  }
  const owners = new Set();
  let missingProduct = false;
  for (const s of slugs) {
    const p = productBySlug.get(s);
    if (!p) { missingProduct = true; continue; }
    if (p.workspaceId) owners.add(String(p.workspaceId));
  }
  if (missingProduct) {
    return { cls: 'AMBIGUOUS', owner: null, via: 'a catalogue line references a Product that no longer exists' };
  }
  if (owners.size === 1) {
    const owner = [...owners][0];
    if (!wsIds.has(owner)) {
      return { cls: 'INVALID', owner, via: 'product owner workspace does not exist' };
    }
    return { cls: 'PROVABLY_ATTRIBUTABLE', owner, via: 'every catalogue line resolves to one Product.workspaceId' };
  }
  if (owners.size === 0) {
    return { cls: 'AMBIGUOUS', owner: null, via: 'catalogue lines carry no Product.workspaceId' };
  }
  return { cls: 'INVALID', owner: null, via: `lines resolve to ${owners.size} different workspaces` };
}

/**
 * §5 — is the historical shop identity provable for this order?
 * The workspace document must be unchanged since before the order was created
 * (created AND last touched <= order.createdAt): its current {slug,
 * displayName} is then exactly what the identity was at order time.
 */
function classifySnapshot(order, workspace) {
  if (!workspace) {
    return { cls: 'SNAPSHOT_NOT_PROVABLE', reason: 'owning workspace does not exist', candidate: null };
  }
  const wsCreated = workspace.createdAt ? Date.parse(workspace.createdAt) : null;
  const wsUpdated = workspace.updatedAt ? Date.parse(workspace.updatedAt) : null;
  const ordCreated = order.createdAt ? Date.parse(order.createdAt) : null;
  const unchangedSinceBefore =
    wsCreated !== null && ordCreated !== null && wsCreated <= ordCreated &&
    wsUpdated !== null && wsUpdated <= ordCreated;
  return unchangedSinceBefore
    ? {
        cls: 'SNAPSHOT_PROVABLE',
        reason: `workspace created ${new Date(workspace.createdAt).toISOString()} and untouched since (order ${new Date(order.createdAt).toISOString()}); stored slug/displayName ARE the identity at order time`,
        candidate: { slug: workspace.slug, displayName: workspace.displayName },
      }
    : {
        cls: 'SNAPSHOT_NOT_PROVABLE',
        reason: `workspace changed after order creation (updatedAt ${workspace.updatedAt} vs order ${order.createdAt}); current name cannot prove historical identity`,
        candidate: null,
      };
}

// ── Phase 1: orders missing workspaceId (§4) ───────────────────────────────
const orderWsPlan = new Map(); // orderId -> workspaceId string (proven now)
const orderRows = [];
let ordersValid = 0;
for (const o of orders) {
  if (o.workspaceId) { ordersValid += 1; continue; }
  const c = classifyOrderMissingWs(o);
  if (c.cls === 'PROVABLY_ATTRIBUTABLE') orderWsPlan.set(String(o.orderId), c.owner);
  orderRows.push({ order: o, cls: c.cls, owner: c.owner, via: c.via });
}
const provenWsFor = (o) => (o.workspaceId ? String(o.workspaceId) : orderWsPlan.get(String(o.orderId)) || null);

// ── Phase 2: shop snapshots (§5) for every order still missing one ─────────
const snapshotRows = [];
let snapshotPresent = 0;
for (const o of orders) {
  if (o.shopSnapshot && o.shopSnapshot.slug) { snapshotPresent += 1; continue; }
  const wsId = provenWsFor(o);
  const row = { order: o, wsId };
  if (!wsId) {
    row.cls = 'SNAPSHOT_NOT_PROVABLE';
    row.reason = 'order has no proven workspace';
    row.candidate = null;
  } else {
    const s = classifySnapshot(o, wsById.get(wsId));
    row.cls = s.cls;
    row.reason = s.reason;
    row.candidate = s.candidate;
  }
  snapshotRows.push(row);
}

// ── Phase 3: conversations without workspaceId (§10) ───────────────────────
const conversationRows = [];
let conversationsValid = 0;
for (const cv of conversations) {
  if (cv.workspaceId) { conversationsValid += 1; continue; }
  const ord = cv.orderId ? orderById.get(String(cv.orderId)) : null;
  const ordWs = ord ? provenWsFor(ord) : null;
  if (!ord) {
    conversationRows.push({ cv, cls: 'AMBIGUOUS', owner: null, via: 'its Order no longer exists' });
  } else if (!ordWs) {
    conversationRows.push({ cv, cls: 'WAITING_FOR_ORDER_BACKFILL', owner: null, via: `Order ${ord.orderId} has no proven workspace` });
  } else {
    conversationRows.push({ cv, cls: 'PROVABLY_ATTRIBUTABLE', owner: ordWs, via: 'Order.workspaceId' });
  }
}

// ── Phase 4: notifications without workspaceId (§9) ────────────────────────
// A notification inherits ownership ONLY through its source entity. Platform-
// wide `system` notifications legitimately keep workspaceId = null and are
// never touched; anything unresolvable is REPORTED, never guessed.
const NOTIF_SOURCE = {
  order: 'orders', custom_request: 'customrequests', proposal: 'proposals',
  conversation: 'conversations', product: 'products', inventory: 'inventories',
  customer: null,
};
function resolveNotifSource(n) {
  if (n.type === 'system' || !n.entityType) {
    return { cls: 'PLATFORM_WIDE_OK', workspaceId: null, reason: 'platform-wide system notification: null is correct' };
  }
  const kind = NOTIF_SOURCE[n.entityType];
  if (kind === undefined || kind === null) {
    return { cls: 'AMBIGUOUS', workspaceId: null, reason: `entityType=${n.entityType} has no workspace-owning source` };
  }
  if (!n.entityId) return { cls: 'AMBIGUOUS', workspaceId: null, reason: 'notification carries no entityId' };
  const sid = String(n.entityId);
  let doc = null;
  if (kind === 'orders') doc = orderByObjectId.get(sid);
  else if (kind === 'customrequests') doc = requestById.get(sid);
  else if (kind === 'proposals') doc = proposalById.get(sid);
  else if (kind === 'conversations') doc = conversationById.get(sid);
  else if (kind === 'products') doc = productById.get(sid);
  else if (kind === 'inventories') doc = inventoryById.get(sid);
  if (!doc) return { cls: 'AMBIGUOUS', workspaceId: null, reason: `source ${kind} no longer exists` };

  let ws = doc.workspaceId ? String(doc.workspaceId) : null;
  let pending = false;
  if (kind === 'orders') {
    // The order this run is about to attribute counts as evidence NOW, so one
    // pass resolves the notification without a second execution.
    ws = provenWsFor(doc);
    pending = !doc.workspaceId;
  } else if (kind === 'conversations' && !ws && doc.orderId) {
    const ord = orderById.get(String(doc.orderId));
    ws = ord ? provenWsFor(ord) : null;
    pending = Boolean(ord) && !ord.workspaceId;
  }
  if (!ws) return { cls: 'WAITING_FOR_SOURCE', workspaceId: null, reason: `source ${kind} has no workspace yet` };
  return {
    cls: 'PROVABLY_ATTRIBUTABLE',
    workspaceId: ws,
    reason: `source ${kind}.workspaceId${pending ? ' (this same run attributes the source)' : ''}`,
  };
}

const notificationRows = [];
let notificationsValid = 0;
let notificationSourceMismatch = 0;
for (const n of notifications) {
  if (n.workspaceId) {
    notificationsValid += 1;
    const s = resolveNotifSource(n);
    if (s.cls === 'PROVABLY_ATTRIBUTABLE' && s.workspaceId !== String(n.workspaceId)) {
      notificationSourceMismatch += 1;
      notificationRows.push({ n, cls: 'INVALID', owner: String(n.workspaceId), via: `attribution disagrees with its source (${s.reason})` });
    }
    continue;
  }
  const s = resolveNotifSource(n);
  notificationRows.push({ n, cls: s.cls, owner: s.workspaceId, via: s.reason });
}

// ── The mutation plan (§18/§19) ────────────────────────────────────────────
// Deterministic, scoped and idempotent: every filter pins the document AND the
// still-empty field, so a second run plans zero changes and writes nothing.
const plan = [];
for (const r of orderRows.filter((x) => x.cls === 'PROVABLY_ATTRIBUTABLE')) {
  plan.push({
    label: `order ${r.order.orderId}: set workspaceId=${r.owner} (${r.via})`,
    model: Order,
    filter: { _id: r.order._id, workspaceId: null },
    update: { $set: { workspaceId: r.owner } },
  });
}
for (const r of snapshotRows.filter((x) => x.cls === 'SNAPSHOT_PROVABLE')) {
  plan.push({
    label: `order ${r.order.orderId}: set shopSnapshot={ slug: '${r.candidate.slug}', displayName: '${r.candidate.displayName}' } (historical identity provable)`,
    model: Order,
    // shopSnapshot carries SCHEMA DEFAULTS (slug: ''), so an unwritten
    // snapshot is either an absent subdocument or one holding '' — both mean
    // "no snapshot". Never overwrite a snapshot that already has a slug.
    filter: { _id: r.order._id, $or: [{ 'shopSnapshot.slug': null }, { 'shopSnapshot.slug': '' }] },
    update: { $set: { shopSnapshot: { slug: r.candidate.slug, displayName: r.candidate.displayName } } },
  });
}
for (const r of conversationRows.filter((x) => x.cls === 'PROVABLY_ATTRIBUTABLE')) {
  plan.push({
    label: `conversation ${r.cv._id}: set workspaceId=${r.owner} (${r.via})`,
    model: Conversation,
    filter: { _id: r.cv._id, workspaceId: null },
    update: { $set: { workspaceId: r.owner } },
  });
}
for (const r of notificationRows.filter((x) => x.cls === 'PROVABLY_ATTRIBUTABLE')) {
  plan.push({
    label: `notification ${r.n._id}: set workspaceId=${r.owner} (${r.via})`,
    model: Notification,
    filter: { _id: r.n._id, workspaceId: null },
    update: { $set: { workspaceId: r.owner } },
  });
}

// ── Report ────────────────────────────────────────────────────────────────
const count = (rows, cls) => rows.filter((r) => r.cls === cls).length;
const pad = (s, n) => String(s).padEnd(n);

console.log('\n════ PHASE 22.5 LEGACY OWNERSHIP BACKFILL ════');
console.log(
  `mode: ${applyMode ? 'APPLY' : 'DRY-RUN'}${applySafety?.production ? ' (PRODUCTION — both confirmation keys supplied)' : ''}` +
    `   target: ${describeDatabase(uri)}`
);

console.log('\n— ORDERS missing workspaceId (§4) —');
if (!orderRows.length) console.log('  none — every order already carries a workspace');
for (const r of orderRows) {
  console.log(`  ${pad(r.order.orderId, 12)} ${pad(r.cls, 24)} ${r.cls === 'PROVABLY_ATTRIBUTABLE' ? `→ ${r.owner}` : '— left unchanged'}`);
  console.log(`      evidence: ${r.via}`);
}

console.log('\n— ORDER shop snapshots (§5) —');
console.log(`  already present: ${snapshotPresent}`);
for (const r of snapshotRows) {
  const detail = r.cls === 'SNAPSHOT_PROVABLE'
    ? `{ slug: '${r.candidate.slug}', displayName: '${r.candidate.displayName}' }`
    : `— left null (${r.reason})`;
  console.log(`  ${pad(r.order.orderId, 12)} ${pad(r.cls, 24)} ${detail}`);
}

console.log('\n— CONVERSATIONS missing workspaceId (§10) —');
if (!conversationRows.length) console.log('  none — every conversation already carries a workspace');
for (const r of conversationRows) {
  console.log(`  ${pad(r.cv._id, 26)} ${pad(r.cls, 26)} ${r.cls === 'PROVABLY_ATTRIBUTABLE' ? `→ ${r.owner}` : '— left unchanged'}`);
  console.log(`      ${r.via}`);
}

console.log('\n— NOTIFICATIONS missing workspaceId (§9) —');
if (!notificationRows.length) console.log('  none — every notification carries (or legitimately lacks) a workspace');
for (const r of notificationRows) {
  console.log(`  ${pad(r.n._id, 26)} ${pad(r.cls, 26)} ${r.cls === 'PROVABLY_ATTRIBUTABLE' ? `→ ${r.owner}` : '— left unchanged'}`);
  console.log(`      ${r.via}`);
}
if (notificationSourceMismatch) {
  console.log(`  ! ${notificationSourceMismatch} attributed notification(s) disagree with their source — reported, never rewritten`);
}

console.log('\n— MUTATION PLAN —');
if (!plan.length) console.log('  nothing to write — every provable record is already consistent');
plan.forEach((p, i) => console.log(`  ${i + 1}. ${p.label}`));

const ordersAmb = count(orderRows, 'AMBIGUOUS');
const ordersInv = count(orderRows, 'INVALID');
const ordersAuto = count(orderRows, 'PROVABLY_ATTRIBUTABLE');
const convAmb = count(conversationRows, 'AMBIGUOUS') + count(conversationRows, 'WAITING_FOR_ORDER_BACKFILL');
const convAuto = count(conversationRows, 'PROVABLY_ATTRIBUTABLE');
const notifAmb = count(notificationRows, 'AMBIGUOUS') + count(notificationRows, 'WAITING_FOR_SOURCE');
const notifInv = count(notificationRows, 'INVALID');
const notifAuto = count(notificationRows, 'PROVABLY_ATTRIBUTABLE');
const notifValid = notificationsValid + count(notificationRows, 'PLATFORM_WIDE_OK');

console.log('\nMIGRATION SUMMARY');
console.log(`  ${pad('ENTITY', 15)}${pad('TOTAL', 8)}${pad('VALID', 8)}${pad('AMBIGUOUS', 12)}${pad('INVALID', 10)}${pad('AUTO-BACKFILL', 16)}MANUAL REVIEW`);
console.log(`  ${pad('Orders', 15)}${pad(orders.length, 8)}${pad(ordersValid, 8)}${pad(ordersAmb, 12)}${pad(ordersInv, 10)}${pad(ordersAuto, 16)}${ordersAmb + ordersInv}`);
console.log(`  ${pad('Conversations', 15)}${pad(conversations.length, 8)}${pad(conversationsValid, 8)}${pad(convAmb, 12)}${pad(0, 10)}${pad(convAuto, 16)}${convAmb}`);
console.log(`  ${pad('Notifications', 15)}${pad(notifications.length, 8)}${pad(notifValid, 8)}${pad(notifAmb, 12)}${pad(notifInv, 10)}${pad(notifAuto, 16)}${pad(notifAmb + notifInv, 16)}`);
console.log(`  ${pad('Wishlists', 15)}never touched here (§11 — merge-wishlists-global.mjs is separate, DRY-RUN by default)`);
console.log(`  shopSnapshot: ${snapshotPresent} already present · ${count(snapshotRows, 'SNAPSHOT_PROVABLE')} provable · ${count(snapshotRows, 'SNAPSHOT_NOT_PROVABLE')} not provable (left null)`);
console.log(`  planned document mutations: ${plan.length}`);

// ── Execute ───────────────────────────────────────────────────────────────
if (!applyMode) {
  console.log('\n[legacy-backfill] DRY-RUN COMPLETE — NO CHANGES MADE (read-only).');
  await mongoose.disconnect();
} else {
  const results = [];
  let session = null;
  try { session = await mongoose.startSession(); } catch { session = null; }
  if (session) {
    try {
      await session.withTransaction(async () => {
        results.length = 0;
        for (const p of plan) results.push(await p.model.updateOne(p.filter, p.update, { session }));
      });
    } catch (err) {
      const message = String(err?.message || err);
      const unsupported = /Transaction numbers are only allowed|replica set|does not support transactions/i.test(message);
      if (!unsupported) throw err;
      console.log('[legacy-backfill] topology has no transaction support — using per-document atomic updates.');
      results.length = 0;
      for (const p of plan) results.push(await p.model.updateOne(p.filter, p.update));
    } finally {
      await session.endSession();
    }
  } else {
    for (const p of plan) results.push(await p.model.updateOne(p.filter, p.update));
  }
  const applied = results.reduce((n, r) => n + (r?.modifiedCount || 0), 0);
  plan.forEach((p, i) => {
    const modified = results[i]?.modifiedCount || 0;
    console.log(`  ${modified ? '✔' : '↷'} ${p.label}${modified ? '' : ' — skipped (document already consistent)'}`);
  });
  console.log(`\n[legacy-backfill] APPLY DONE — ${applied} document mutation(s) written.`);
  console.log('[legacy-backfill] re-run this script without --apply (or scripts/production-consistency-audit.mjs) to verify the post-condition.');
  await mongoose.disconnect();
}
