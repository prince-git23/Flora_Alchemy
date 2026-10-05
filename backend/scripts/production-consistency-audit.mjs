/**
 * PHASE 22.5 — PRODUCTION CONSISTENCY AUDIT (READ-ONLY).
 *
 * Classifies legacy production data against the Phase 3 / Phase 22.5 tenancy
 * invariants WITHOUT writing anything. There is no --apply mode and no
 * mutation path: this script only runs finds, counts and aggregations.
 *
 * Reports, per entity:
 *   VALID                    — invariant holds from stored data
 *   PROVABLY_ATTRIBUTABLE    — ownership provable (safe to backfill)
 *   AMBIGUOUS                — ownership not provable: report only
 *   INVALID                  — provable contradiction: report only
 * plus the specific invariant checks the Green criteria require.
 *
 * Usage (from backend/):
 *   node scripts/production-consistency-audit.mjs                 # uses MONGO_URI
 *   node scripts/production-consistency-audit.mjs --db Flora-Alchemy
 *   node scripts/production-consistency-audit.mjs --json
 *
 * SAFETY: connects read-only in behaviour; never calls update/insert/delete.
 * The --db switch only changes which database is READ.
 */
import mongoose from 'mongoose';
import 'dotenv/config';

import { dbNameFromUri } from '../utils/environmentGuard.js';

const asJson = process.argv.includes('--json');
const dbArgIdx = process.argv.indexOf('--db');
const explicitDb = dbArgIdx > -1 ? process.argv[dbArgIdx + 1] : null;

const out = [];
const line = (s = '') => {
  if (!asJson) console.log(s);
  out.push(s);
};

function classifyOrderMissingWs(order, productBySlug, workspaceIds, requestsById, proposalsById) {
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
    if (!workspaceIds.has(owner)) {
      return { cls: 'INVALID', owner, via: 'product owner workspace does not exist' };
    }
    return { cls: 'PROVABLY_ATTRIBUTABLE', owner, via: 'every catalogue line resolves to one Product.workspaceId' };
  }
  if (owners.size === 0) {
    return { cls: 'AMBIGUOUS', owner: null, via: 'catalogue lines carry no Product.workspaceId' };
  }
  return { cls: 'INVALID', owner: null, via: `lines resolve to ${owners.size} different workspaces` };
}

async function main() {
  const baseUri = process.env.MONGO_URI;
  if (!baseUri) {
    console.error('MONGO_URI is not configured (backend/.env).');
    process.exit(1);
  }
  const uri = explicitDb
    ? baseUri.replace(/\/[^/?]+(\?|$)/, `/${explicitDb}$1`)
    : baseUri;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const dbName = mongoose.connection.name;
  console.log(`[production-audit] READ-ONLY report against database: ${dbName}`);

  const col = (n) => mongoose.connection.collection(n);
  const exists = new Set(
    (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name)
  );
  const has = (n) => exists.has(n);
  const all = async (n, proj) => (has(n) ? col(n).find({}, { projection: proj }).toArray() : []);
  const asMap = (rows, key = '_id') => new Map(rows.map((r) => [String(r[key]), r]));

  const report = { database: dbName, entities: {}, invariants: {}, notes: [] };

  // ── Workspaces ────────────────────────────────────────────────────────────
  const workspaces = await all('workspaces', {
    slug: 1, displayName: 1, status: 1, isBootstrap: 1, isCanonicalBootstrapIdentity: 1,
    primaryAdminId: 1, createdAt: 1, updatedAt: 1,
  });
  const wsIds = new Set(workspaces.map((w) => String(w._id)));
  const wsById = asMap(workspaces);
  const slugSeen = new Map();
  for (const w of workspaces) slugSeen.set(w.slug, (slugSeen.get(w.slug) || 0) + 1);
  const dupWsSlugs = [...slugSeen.entries()].filter(([, c]) => c > 1).map(([s]) => s);
  const active = workspaces.filter((w) => w.status === 'ACTIVE');
  const bootstrap = workspaces.filter((w) => w.isBootstrap);
  report.entities.workspaces = {
    total: workspaces.length,
    active: active.length,
    bootstrapRows: bootstrap.length,
    bootstrapClaimed: bootstrap.filter((w) => w.primaryAdminId).length,
    duplicateSlugs: dupWsSlugs,
  };
  if (workspaces.length === 0) {
    report.invariants.zeroWorkspaceMode = 'AT_RISK — no workspace document exists (compat mode reachable)';
  } else {
    report.invariants.zeroWorkspaceMode = 'OK — workspace documents exist; compat mode unreachable';
  }
  report.invariants.duplicateWorkspaceSlugs = dupWsSlugs.length === 0 ? 'OK (0)' : `FAIL (${dupWsSlugs.join(', ')})`;

  // ── Products / Collections / Inventory ───────────────────────────────────
  const products = await all('products', { slug: 1, name: 1, workspaceId: 1, visibility: 1, isFixture: 1 });
  const prodById = asMap(products);
  const prodBySlug = new Map(products.map((p) => [String(p.slug), p]));
  const prodMissingWs = products.filter((p) => !p.workspaceId);
  const prodOrphans = products.filter((p) => p.workspaceId && !wsIds.has(String(p.workspaceId)));
  const prodSlugSeen = new Map();
  for (const p of products) prodSlugSeen.set(p.slug, (prodSlugSeen.get(p.slug) || 0) + 1);
  const dupProdSlugs = [...prodSlugSeen.entries()].filter(([, c]) => c > 1).map(([s]) => s);
  report.entities.products = {
    total: products.length,
    missingWorkspaceId: prodMissingWs.length,
    orphanedWorkspaceId: prodOrphans.length,
    duplicateSlugs: dupProdSlugs.length,
    missingIds: prodMissingWs.map((p) => String(p._id)),
  };

  const collections = await all('collections', { slug: 1, name: 1, workspaceId: 1, productSlugs: 1, visibility: 1 });
  const collCross = [];
  const collMissingWs = collections.filter((c) => !c.workspaceId);
  for (const c of collections) {
    const refs = new Set();
    for (const s of c.productSlugs || []) {
      const p = prodBySlug.get(String(s));
      if (p && p.workspaceId) refs.add(String(p.workspaceId));
      else if (p && !p.workspaceId) refs.add('UNOWNED');
    }
    refs.delete(String(c.workspaceId));
    if (refs.size) collCross.push({ id: String(c._id), slug: c.slug, conflictingOwners: [...refs] });
  }
  report.entities.collections = {
    total: collections.length,
    missingWorkspaceId: collMissingWs.length,
    crossWorkspaceRefs: collCross.length,
    details: collCross,
  };

  const inventory = await all('inventories', { productSlug: 1, workspaceId: 1, currentStock: 1 });
  const invSlugSeen = new Map();
  for (const i of inventory) invSlugSeen.set(i.productSlug, (invSlugSeen.get(i.productSlug) || 0) + 1);
  const dupInvSlugs = [...invSlugSeen.entries()].filter(([, c]) => c > 1).map(([s]) => s);
  const invNoProduct = inventory.filter((i) => !prodBySlug.has(String(i.productSlug)));
  const invWsMismatch = inventory.filter((i) => {
    const p = prodBySlug.get(String(i.productSlug));
    if (!p) return false;
    const a = i.workspaceId ? String(i.workspaceId) : null;
    const b = p.workspaceId ? String(p.workspaceId) : null;
    if (a === null && b === null) return false;
    if (a === null || b === null) return false; // legacy-null tolerated by adjustStock
    return a !== b;
  });
  report.entities.inventory = {
    total: inventory.length,
    duplicateProductSlugs: dupInvSlugs.length,
    duplicateSlugs: dupInvSlugs,
    orphanRows: invNoProduct.length,
    workspaceMismatchVsProduct: invWsMismatch.length,
  };
  report.invariants.globalProductSlugUniqueness =
    dupProdSlugs.length === 0 ? 'OK — every Product slug unique in production' : `FAIL (${dupProdSlugs.join(', ')})`;
  report.invariants.inventorySlugUniqueness =
    dupInvSlugs.length === 0 ? 'OK — no duplicate Inventory.productSlug' : `FAIL (${dupInvSlugs.join(', ')})`;

  // ── Custom Requests / Proposals ──────────────────────────────────────────
  const requests = await all('customrequests', { workspaceId: 1, productId: 1, status: 1, customerId: 1 });
  const reqById = asMap(requests);
  const proposals = await all('proposals', { workspaceId: 1, requestId: 1, orderId: 1, status: 1 });
  const propById = asMap(proposals);
  const reqMissing = requests.filter((r) => !r.workspaceId);
  const propMissing = proposals.filter((p) => !p.workspaceId);
  const chainMismatch = [];
  for (const p of proposals) {
    if (!p.requestId) continue;
    const r = reqById.get(String(p.requestId));
    if (r && r.workspaceId && p.workspaceId && String(r.workspaceId) !== String(p.workspaceId)) {
      chainMismatch.push({ proposal: String(p._id), request: String(p.requestId) });
    }
  }
  report.entities.customRequests = { total: requests.length, missingWorkspaceId: reqMissing.length };
  report.entities.proposals = {
    total: proposals.length,
    missingWorkspaceId: propMissing.length,
    requestChainMismatch: chainMismatch.length,
    details: chainMismatch,
  };

  // ── Orders ───────────────────────────────────────────────────────────────
  const orders = await all('orders', {
    orderId: 1, workspaceId: 1, shopSnapshot: 1, items: 1, customRequestId: 1, proposalId: 1,
    createdAt: 1, orderStatus: 1, paymentStatus: 1, tax: 1,
  });
  const orderById = asMap(orders);
  const orderMissing = orders.filter((o) => !o.workspaceId);
  const orderClassification = [];
  for (const o of orderMissing) {
    const c = classifyOrderMissingWs(o, prodBySlug, wsIds, reqById, propById);
    orderClassification.push({
      orderId: o.orderId, cls: c.cls, proposedOwner: c.owner, evidence: c.via,
      current: { workspaceId: null, shopSnapshot: o.shopSnapshot || null },
      action: c.cls === 'PROVABLY_ATTRIBUTABLE'
        ? 'AUTO-BACKFILLABLE (workspaceId only; snapshot decided separately)'
        : 'LEAVE UNCHANGED — operator review',
    });
  }
  const orderSnapshot = [];
  for (const o of orders) {
    if (o.shopSnapshot && o.shopSnapshot.slug) continue;
    const ws = o.workspaceId ? wsById.get(String(o.workspaceId)) : null;
    if (!ws) {
      orderSnapshot.push({ orderId: o.orderId, cls: 'SNAPSHOT_NOT_PROVABLE', reason: 'order has no workspaceId yet' });
      continue;
    }
    // Provable only if the workspace document has not changed since before the
    // order was created (no rename/status churn in between).
    const wsCreated = ws.createdAt ? new Date(ws.createdAt).getTime() : null;
    const wsUpdated = ws.updatedAt ? new Date(ws.updatedAt).getTime() : null;
    const ordCreated = o.createdAt ? new Date(o.createdAt).getTime() : null;
    const unchangedSinceBefore = wsCreated !== null && ordCreated !== null && wsCreated <= ordCreated
      && wsUpdated !== null && wsUpdated <= ordCreated;
    orderSnapshot.push({
      orderId: o.orderId,
      cls: unchangedSinceBefore ? 'SNAPSHOT_PROVABLE' : 'SNAPSHOT_NOT_PROVABLE',
      reason: unchangedSinceBefore
        ? `workspace created ${ws.createdAt} and untouched since (order ${o.createdAt}); slug/displayName at order time are the stored ones`
        : `workspace changed after order creation (updatedAt ${ws.updatedAt} vs order ${o.createdAt}); current name cannot prove historical identity`,
      candidate: unchangedSinceBefore ? { slug: ws.slug, displayName: ws.displayName } : null,
    });
  }
  const orderItemMismatch = [];
  for (const o of orders) {
    if (!o.workspaceId) continue;
    for (const i of o.items || []) {
      if (!i.productSlug) continue;
      const p = prodBySlug.get(String(i.productSlug));
      if (p && p.workspaceId && String(p.workspaceId) !== String(o.workspaceId)) {
        orderItemMismatch.push({ orderId: o.orderId, slug: i.productSlug, owner: String(p.workspaceId), orderWs: String(o.workspaceId) });
      }
    }
  }
  report.entities.orders = {
    total: orders.length,
    missingWorkspaceId: orderMissing.length,
    missingShopSnapshot: orders.filter((o) => !(o.shopSnapshot && o.shopSnapshot.slug)).length,
    itemOwnershipMismatch: orderItemMismatch.length,
    classification: orderClassification,
    snapshotClassification: orderSnapshot,
    mismatchDetails: orderItemMismatch,
  };
  report.invariants.everyOrderHasWorkspace =
    orderMissing.length === 0 ? 'OK' : `OPEN — ${orderMissing.length} order(s) await backfill`;
  report.invariants.orderItemOwnership =
    orderItemMismatch.length === 0 ? 'OK — every attributed order items belong to its workspace' : `FAIL (${orderItemMismatch.length})`;

  // ── Conversations ────────────────────────────────────────────────────────
  const conversations = await all('conversations', { orderId: 1, workspaceId: 1, customerId: 1 });
  const convReport = { total: conversations.length, waitingForOrderBackfill: 0, mismatch: 0, missingWorkspaceId: 0, details: [] };
  for (const cv of conversations) {
    const ord = cv.orderId ? orderById.get(String(cv.orderId)) : null;
    if (!cv.workspaceId) convReport.missingWorkspaceId += 1;
    if (!ord) continue;
    if (!ord.workspaceId) { convReport.waitingForOrderBackfill += 1; continue; }
    if (cv.workspaceId && String(cv.workspaceId) !== String(ord.workspaceId)) {
      convReport.mismatch += 1;
      convReport.details.push({ conversation: String(cv._id), orderId: ord.orderId });
    }
  }
  report.entities.conversations = convReport;
  report.invariants.conversationMatchesOrder =
    convReport.mismatch === 0 ? 'OK — no conversation disagrees with its order' : `FAIL (${convReport.mismatch})`;

  // ── Notifications ────────────────────────────────────────────────────────
  const notifications = await all('notifications', {
    entityType: 1, entityId: 1, workspaceId: 1, role: 1, type: 1, userId: 1,
  });
  const missingNotif = notifications.filter((n) => !n.workspaceId);
  const notifClass = { PLATFORM_WIDE_OK: 0, PROVABLY_ATTRIBUTABLE: 0, WAITING_FOR_SOURCE: 0, AMBIGUOUS: 0 };
  const notifDetails = [];
  const resolveSource = (n) => {
    const map = { order: 'orders', custom_request: 'customrequests', proposal: 'proposals', conversation: 'conversations', product: 'products', customer: null, inventory: 'inventories' };
    const collName = map[n.entityType];
    if (!collName || !has(collName)) return undefined;
    if (!n.entityId) return undefined;
    return col(collName).findOne({ _id: new mongoose.Types.ObjectId(String(n.entityId)) }, { projection: { workspaceId: 1 } });
  };
  for (const n of missingNotif) {
    if (n.type === 'system' || !n.entityType) {
      notifClass.PLATFORM_WIDE_OK += 1;
      notifDetails.push({ id: String(n._id), cls: 'PLATFORM_WIDE_OK', reason: 'platform-wide system notification: null is correct' });
      continue;
    }
    const src = await resolveSource(n);
    if (src === undefined) {
      notifClass.AMBIGUOUS += 1;
      notifDetails.push({ id: String(n._id), cls: 'AMBIGUOUS', reason: `entityType=${n.entityType} has no resolvable source document` });
    } else if (!src) {
      notifClass.AMBIGUOUS += 1;
      notifDetails.push({ id: String(n._id), cls: 'AMBIGUOUS', reason: 'source document no longer exists' });
    } else if (!src.workspaceId) {
      notifClass.WAITING_FOR_SOURCE += 1;
      notifDetails.push({ id: String(n._id), cls: 'WAITING_FOR_SOURCE', reason: `${n.entityType} itself has no workspaceId yet` });
    } else {
      notifClass.PROVABLY_ATTRIBUTABLE += 1;
      notifDetails.push({ id: String(n._id), cls: 'PROVABLY_ATTRIBUTABLE', owner: String(src.workspaceId), reason: `source ${n.entityType}.workspaceId` });
    }
  }
  let notifSourceMismatch = 0;
  for (const n of notifications) {
    if (!n.workspaceId || !n.entityType || !n.entityId) continue;
    const src = await resolveSource(n);
    if (src && src.workspaceId && String(src.workspaceId) !== String(n.workspaceId)) notifSourceMismatch += 1;
  }
  report.entities.notifications = {
    total: notifications.length,
    missingWorkspaceId: missingNotif.length,
    classification: notifClass,
    sourceMismatch: notifSourceMismatch,
    details: notifDetails,
  };
  report.invariants.notificationSourceOwnership =
    notifSourceMismatch === 0 ? 'OK — attributed notifications match their source' : `FAIL (${notifSourceMismatch})`;

  // ── Reviews / Wishlists ──────────────────────────────────────────────────
  const reviews = await all('reviews', { productSlug: 1, workspaceId: 1, customerId: 1 });
  const revMissing = reviews.filter((r) => !r.workspaceId);
  const revMismatch = reviews.filter((r) => {
    const p = prodBySlug.get(String(r.productSlug));
    return p && p.workspaceId && r.workspaceId && String(p.workspaceId) !== String(r.workspaceId);
  });
  report.entities.reviews = {
    total: reviews.length,
    missingWorkspaceId: revMissing.length,
    productMismatch: revMismatch.length,
  };

  const wishlists = await all('wishlists', { customerId: 1, workspaceId: 1, productIds: 1 });
  const wlMissing = wishlists.filter((w) => !w.workspaceId);
  const wlPairSeen = new Map();
  for (const w of wishlists) {
    const k = `${w.customerId}|${w.workspaceId ?? 'null'}`;
    wlPairSeen.set(k, (wlPairSeen.get(k) || 0) + 1);
  }
  const wlDupes = [...wlPairSeen.entries()].filter(([, c]) => c > 1).map(([k]) => k);
  report.entities.wishlists = {
    total: wishlists.length,
    missingWorkspaceId: wlMissing.length,
    duplicateCustomerScopeRows: wlDupes.length,
    note: 'wishlist merge is DRY-RUN-only and deliberately untouched by this audit',
  };

  // ── Settings fallback ────────────────────────────────────────────────────
  const settings = await all('settings', { key: 1, workspaceId: 1, acceptNewOrders: 1, storeAvailability: 1 });
  const defaultSettings = settings.filter((s) => s.key === 'default' && !s.workspaceId);
  const wsSettings = settings.filter((s) => s.workspaceId);
  report.entities.settings = {
    total: settings.length,
    platformSingletons: defaultSettings.length,
    workspaceScoped: wsSettings.length,
    workspaceIdsWithSettings: wsSettings.map((s) => String(s.workspaceId)),
  };
  const activeWithoutSettings = active.filter(
    (w) => !wsSettings.some((s) => String(s.workspaceId) === String(w._id))
  ).map((w) => w.slug);
  report.invariants.settingsFallback = activeWithoutSettings.length === 0
    ? 'OK — every ACTIVE workspace has its own Settings document'
    : `FALLBACK IN USE for ${activeWithoutSettings.join(', ')} (documented: workspace settings else platform singleton)`;

  await mongoose.disconnect();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n===== PHASE 22.5 PRODUCTION CONSISTENCY AUDIT (READ-ONLY) =====');
    console.log(`database: ${report.database}`);
    for (const [name, data] of Object.entries(report.entities)) {
      console.log(`\n--- ${name} ---`);
      console.log(JSON.stringify(data, null, 2));
    }
    console.log('\n--- invariants ---');
    for (const [k, v] of Object.entries(report.invariants)) console.log(`  ${k}: ${v}`);
  }
}

main().catch((err) => {
  console.error('[production-audit] FAILED:', err.message);
  process.exit(1);
});
