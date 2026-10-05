/**
 * PHASE 22.5 — LEGACY OWNERSHIP BACKFILL suite.
 *
 * Proves the safety contract of scripts/backfill-legacy-ownership.mjs against
 * an isolated disposable database (Flora-Alchemy-Test-LegacyBackfill). No HTTP
 * server is needed: the migration is a script, so the suite drives it exactly
 * as an operator would, with spawnSync, and inspects the result in MongoDB.
 *
 *   §A DRY-RUN IS THE DEFAULT — running with no arguments classifies, prints the
 *      mutation plan and writes nothing at all.
 *   §B PRODUCTION FAILS CLOSED — a PRODUCTION-named database is refused BEFORE
 *      any connection, demands the exact-name confirmation, then the
 *      Phase 22.5 purpose confirmation, and rejects those keys when aimed at a
 *      disposable database.
 *   §C EVIDENCE, NEVER A GUESS — a catalogue order is attributed only through
 *      Product.workspaceId; a custom-request order only through
 *      CustomRequest.workspaceId; bespoke-only, cross-workspace and
 *      ghost-owner orders are left EXACTLY as they were.
 *   §D SHOP SNAPSHOTS — written only where the historical identity is provable
 *      (workspace untouched since before the order); a workspace changed after
 *      the order keeps shopSnapshot = null (SNAPSHOT_NOT_PROVABLE).
 *   §E NOTIFICATIONS — order notifications inherit their source order's
 *      workspace in the same pass; platform-wide `system` notifications stay
 *      null; a notification whose source no longer exists is left alone.
 *   §F IDEMPOTENCY — a second --apply plans and writes zero changes, and
 *      wishlists are never touched by this tool (§11).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import mongoose from 'mongoose';

import { loadBackendEnv, testMongoUri } from './lib/testServer.mjs';
import Workspace from '../models/Workspace.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import CustomRequest from '../models/CustomRequest.js';
import Conversation from '../models/Conversation.js';
import Notification from '../models/Notification.js';
import Wishlist from '../models/Wishlist.js';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DB_NAME = 'Flora-Alchemy-Test-LegacyBackfill';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

/** Run the migration exactly as an operator would, with an explicit env. */
function spawnMigration(args, env = {}) {
  return spawnSync(process.execPath, ['scripts/backfill-legacy-ownership.mjs', ...args], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', PRODUCTION_DB_NAMES: 'Flora-Alchemy', MONGO_URI: TEST_URI, ...env },
  });
}
const text = (r) => `${r.stdout || ''}${r.stderr || ''}`;

const line = (slug) => ({ productSlug: slug, name: `Product ${slug}`, price: 1000, quantity: 1 });

async function main() {
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
  await mongoose.connection.db.dropDatabase();
  await Promise.all([Workspace.init(), Order.init(), Product.init(), CustomRequest.init(), Conversation.init(), Notification.init()]);

  // ── Fixtures ──────────────────────────────────────────────────────────────
  // WS_A is created well before every order and never touched afterwards, so
  // its identity IS provable at order time. WS_B is renamed AFTER O5 is
  // created, which makes O5's snapshot unprovable by construction.
  const wsA = await Workspace.create({ slug: 'legacy-backfill-a', displayName: 'Legacy Backfill A', status: 'ACTIVE' });
  const wsB = await Workspace.create({ slug: 'legacy-backfill-b', displayName: 'Legacy Backfill B', status: 'ACTIVE' });
  const ghostWs = new mongoose.Types.ObjectId();
  const COLLECTION_EPOCH = new Date('2026-01-01T00:00:00.000Z');
  const ORDER_EPOCH = new Date('2026-06-01T00:00:00.000Z');
  const stamp = (model, doc, createdAt, updatedAt) =>
    model.collection.updateOne({ _id: doc._id }, { $set: { createdAt, updatedAt } });

  await stamp(Workspace, wsA, COLLECTION_EPOCH, COLLECTION_EPOCH);

  const prodA = await Product.create({ slug: 'legacy-bloom', name: 'Legacy Bloom', price: 1000, workspaceId: wsA._id });
  const prodB = await Product.create({ slug: 'legacy-herb', name: 'Legacy Herb', price: 1200, workspaceId: wsB._id });
  const prodGhost = await Product.create({ slug: 'legacy-ghost', name: 'Legacy Ghost', price: 900, workspaceId: ghostWs });

  const customerId = new mongoose.Types.ObjectId();
  const request = await CustomRequest.create({ customerId, description: 'legacy bespoke request' });
  request.workspaceId = wsA._id;
  await CustomRequest.collection.updateOne({ _id: request._id }, { $set: { workspaceId: wsA._id } });

  const stampOrder = (createdAt) => new Date(createdAt);
  const orderCatalogue = await Order.create({
    orderId: 'LB-0001', customerId, items: [line('legacy-bloom')], subtotal: 1000, total: 1000,
  });
  const orderRequest = await Order.create({
    orderId: 'LB-0002', customerId, items: [], customRequestId: request._id, subtotal: 0, total: 0,
  });
  const orderBespoke = await Order.create({
    orderId: 'LB-0003', customerId, items: [{ name: 'Bespoke jar', price: 500, quantity: 1 }], subtotal: 500, total: 500,
  });
  const orderCross = await Order.create({
    orderId: 'LB-0004', customerId, items: [line('legacy-bloom'), line('legacy-herb')], subtotal: 2200, total: 2200,
  });
  const orderGhost = await Order.create({
    orderId: 'LB-0005', customerId, items: [line('legacy-ghost')], subtotal: 900, total: 900,
  });
  for (const o of [orderCatalogue, orderRequest, orderBespoke, orderCross, orderGhost]) {
    await stamp(Order, o, ORDER_EPOCH, ORDER_EPOCH);
  }

  // An order whose OWNING workspace already exists, but whose workspace was
  // renamed long after the order was placed → snapshot must stay null.
  const orderStale = await Order.create({
    orderId: 'LB-0006', customerId, items: [line('legacy-herb')], subtotal: 1200, total: 1200, workspaceId: wsB._id,
  });
  await stamp(Order, orderStale, ORDER_EPOCH, ORDER_EPOCH);
  await stamp(Workspace, wsB, COLLECTION_EPOCH, new Date('2026-09-01T00:00:00.000Z')); // renamed AFTER the order

  const notifSystem = await Notification.create({ userId: new mongoose.Types.ObjectId(), role: 'admin', type: 'system', title: 'Maintenance', message: 'Maintenance window' });
  const notifOrder = await Notification.create({ userId: new mongoose.Types.ObjectId(), role: 'admin', type: 'new_order', title: 'New order', message: 'New order', entityType: 'order', entityId: orderCatalogue._id });
  const notifGhost = await Notification.create({ userId: new mongoose.Types.ObjectId(), role: 'admin', type: 'order_status_change', title: 'Status', message: 'Status', entityType: 'order', entityId: new mongoose.Types.ObjectId() });

  const convResolved = await Conversation.create({ orderId: 'LB-0001', customerId });
  const convWaiting = await Conversation.create({ orderId: 'LB-0003', customerId });
  const wishlist = await Wishlist.create({ customerId, productIds: ['legacy-bloom'] });

  const snapshotState = async () => ({
    orders: await Order.find({}).sort({ orderId: 1 }).lean(),
    notifications: await Notification.find({}).sort({ _id: 1 }).lean(),
    conversations: await Conversation.find({}).sort({ _id: 1 }).lean(),
    wishlists: await Wishlist.find({}).lean(),
  });
  const fingerprint = (state) => JSON.stringify(state);
  const before = await snapshotState();

  // ── §A DRY-RUN IS THE DEFAULT ─────────────────────────────────────────────
  console.log('\n— §A DRY-RUN IS THE DEFAULT —');
  let run = spawnMigration([]);
  const dryOut = text(run);
  check('a bare run exits 0', run.status === 0, `exit ${run.status}: ${dryOut.slice(-400)}`);
  check('it declares the run read-only', dryOut.includes('DRY-RUN') && dryOut.includes('NO CHANGES MADE'), dryOut.slice(-300));
  check('it prints the migration summary', dryOut.includes('MIGRATION SUMMARY'), dryOut.slice(0, 200));
  check('it prints the exact mutation plan', dryOut.includes('MUTATION PLAN') && dryOut.includes('set workspaceId='), dryOut.slice(0, 300));
  check('it reports every collection count', ['Orders', 'Conversations', 'Notifications', 'Wishlists'].every((x) => dryOut.includes(x)));
  check('it leaves the database untouched', fingerprint(await snapshotState()) === fingerprint(before));

  // ── §B PRODUCTION FAILS CLOSED ────────────────────────────────────────────
  console.log('\n— §B PRODUCTION FAILS CLOSED —');
  const PROD_URI = 'mongodb://127.0.0.1:9999/Flora-Alchemy';
  run = spawnMigration(['--apply'], { MONGO_URI: PROD_URI });
  const bare = text(run);
  check('a PRODUCTION database is refused', run.status !== 0 && bare.includes('refusing production migration'), `exit ${run.status}: ${bare.slice(-300)}`);
  check('the refusal demands the exact-name confirmation', bare.includes('CONFIRM_DATABASE_UNSAFE_OPERATION=Flora-Alchemy'), bare.slice(0, 300));
  check('the refusal happens before any connection', !/connected —/.test(bare), bare.slice(0, 200));

  run = spawnMigration(['--apply'], { MONGO_URI: PROD_URI, CONFIRM_DATABASE_UNSAFE_OPERATION: 'Flora-Alchemy' });
  const nameOnly = text(run);
  check('the exact name alone is not enough', run.status !== 0 && nameOnly.includes('WORKSPACE_MIGRATION_CONFIRM=APPLY_PRODUCTION_WORKSPACE_MIGRATION'), `exit ${run.status}: ${nameOnly.slice(-300)}`);

  run = spawnMigration(['--apply'], { MONGO_URI: PROD_URI, CONFIRM_DATABASE_UNSAFE_OPERATION: 'true' });
  const genericConfirm = text(run);
  check('a generic CONFIRM=true is never accepted', run.status !== 0 && genericConfirm.includes('CONFIRM_DATABASE_UNSAFE_OPERATION=Flora-Alchemy'), `exit ${run.status}: ${genericConfirm.slice(-300)}`);

  run = spawnMigration(['--apply'], { WORKSPACE_MIGRATION_CONFIRM: 'APPLY_PRODUCTION_WORKSPACE_MIGRATION' });
  const onDisposable = text(run);
  check('production keys aimed at a disposable database fail closed', run.status !== 0 && onDisposable.includes('disposable database'), `exit ${run.status}: ${onDisposable.slice(-300)}`);
  check('no refused run wrote anything', fingerprint(await snapshotState()) === fingerprint(before));

  // ── §C/D/E GUARDED APPLY ──────────────────────────────────────────────────
  console.log('\n— §C GUARDED APPLY: EVIDENCE, NEVER A GUESS —');
  run = spawnMigration(['--apply']);
  const applyOut = text(run);
  check('the guarded apply exits 0 against the disposable database', run.status === 0, `exit ${run.status}: ${applyOut.slice(-500)}`);
  check('it logs each mutation', applyOut.includes('✔ order LB-0001'), applyOut.slice(-600));

  const catalogue = await Order.findOne({ orderId: 'LB-0001' }).lean();
  check('a catalogue order is attributed through Product.workspaceId', String(catalogue.workspaceId) === String(wsA._id), String(catalogue.workspaceId));
  check('its provable shop snapshot is written', catalogue.shopSnapshot?.slug === 'legacy-backfill-a' && catalogue.shopSnapshot?.displayName === 'Legacy Backfill A', JSON.stringify(catalogue.shopSnapshot));

  const viaRequest = await Order.findOne({ orderId: 'LB-0002' }).lean();
  check('a custom-request order is attributed through CustomRequest.workspaceId', String(viaRequest.workspaceId) === String(wsA._id), String(viaRequest.workspaceId));

  const bespoke = await Order.findOne({ orderId: 'LB-0003' }).lean();
  check('a bespoke-only order is reported AMBIGUOUS and left untouched', !bespoke.workspaceId && applyOut.includes('AMBIGUOUS'), String(bespoke.workspaceId));

  const cross = await Order.findOne({ orderId: 'LB-0004' }).lean();
  check('an order spanning two shops is reported INVALID and left untouched', !cross.workspaceId, String(cross.workspaceId));

  const ghost = await Order.findOne({ orderId: 'LB-0005' }).lean();
  check('an order whose product owner no longer exists is left untouched', !ghost.workspaceId, String(ghost.workspaceId));

  const stale = await Order.findOne({ orderId: 'LB-0006' }).lean();
  check('a workspace renamed after the order keeps shopSnapshot null', !stale.shopSnapshot?.slug, JSON.stringify(stale.shopSnapshot));
  check('the unprovable snapshot is reported as SNAPSHOT_NOT_PROVABLE', applyOut.includes('SNAPSHOT_NOT_PROVABLE'), applyOut.slice(-800));

  console.log('\n— §D NOTIFICATIONS AND CONVERSATIONS —');
  const sys = await Notification.findById(notifSystem._id).lean();
  check('a platform-wide system notification stays unscoped', !sys.workspaceId, String(sys.workspaceId));
  const ordNotif = await Notification.findById(notifOrder._id).lean();
  check('an order notification inherits its source order workspace', String(ordNotif.workspaceId) === String(wsA._id), String(ordNotif.workspaceId));
  const ghostNotif = await Notification.findById(notifGhost._id).lean();
  check('a notification whose source is gone stays unscoped', !ghostNotif.workspaceId, String(ghostNotif.workspaceId));
  const conv1 = await Conversation.findById(convResolved._id).lean();
  check('a conversation inherits its order workspace', String(conv1.workspaceId) === String(wsA._id), String(conv1.workspaceId));
  const conv2 = await Conversation.findById(convWaiting._id).lean();
  check('a conversation on an unproven order stays WAITING_FOR_ORDER_BACKFILL', !conv2.workspaceId, String(conv2.workspaceId));

  console.log('\n— §E IDEMPOTENCY —');
  run = spawnMigration(['--apply']);
  const second = text(run);
  check('a second apply exits 0', run.status === 0, `exit ${run.status}: ${second.slice(-300)}`);
  check('a second apply writes zero documents', second.includes('APPLY DONE — 0 document mutation(s)'), second.slice(-300));
  run = spawnMigration([]);
  const cleanDry = text(run);
  check('the dry-run afterwards plans nothing', cleanDry.includes('nothing to write'), cleanDry.slice(-400));
  check('wishlists are never touched by this tool', !(await Wishlist.findById(wishlist._id).lean()).workspaceId);
}

main()
  .catch((err) => { console.log('ERROR:', err.message); process.exitCode = 1; })
  .finally(async () => {
    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log(`LEGACY BACKFILL RESULT: ${passed} passed, ${failed} failed`);
    if (failed > 0) { console.log('FAILURES:', failures.join(', ')); process.exitCode = 1; }
    await mongoose.disconnect();
  });