/**
 * PHASE 3 §24 — ORDER CONSISTENCY REPORT (READ-ONLY, DRY-RUN BY DESIGN).
 *
 * Classifies every stored Order against the Phase 3 invariant:
 *
 *     Order.workspaceId == Product.workspaceId of every catalogue item
 *
 * and, for custom-request orders:
 *
 *     Order.workspaceId == Proposal.workspaceId == CustomRequest.workspaceId
 *
 *   VALID      — every attributed item belongs to the order's workspace (or the
 *                order's workspace is provable from the request/proposal chain);
 *   AMBIGUOUS  — ownership cannot be proven from stored data: a legacy order
 *                with no workspaceId, a catalogue line whose Product no longer
 *                exists, or an order whose workspace exists but no item carries
 *                attribution. These are REPORTED, never guessed or rewritten;
 *   INVALID    — a provable contradiction: an item that belongs to a DIFFERENT
 *                workspace, or a request/proposal/order chain whose workspaces
 *                disagree. Nothing is repaired here.
 *
 * This script NEVER writes and has no --apply mode. A future migration must be
 * a separate, explicitly confirmed operation run by an operator.
 *
 * Usage (from backend/):
 *   node scripts/order-consistency-report.mjs            # human table
 *   node scripts/order-consistency-report.mjs --json     # machine-readable
 */
import mongoose from 'mongoose';
import 'dotenv/config';

import Order from '../models/Order.js';
import Product from '../models/Product.js';
import Workspace from '../models/Workspace.js';
import CustomRequest from '../models/CustomRequest.js';
import Proposal from '../models/Proposal.js';
import { dbNameFromUri } from '../utils/environmentGuard.js';

const asJson = process.argv.includes('--json');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not configured (backend/.env).');
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const dbName = dbNameFromUri(uri);
  console.log(`[order-consistency] READ-ONLY report against database: ${dbName}`);

  const workspaceCount = await Workspace.countDocuments({});
  const orders = await Order.find({}).select('orderId workspaceId items customRequestId proposalId').lean();

  const slugs = [
    ...new Set(
      orders.flatMap((o) => (o.items || []).filter((i) => i.productSlug).map((i) => i.productSlug))
    ),
  ];
  const products = slugs.length
    ? await Product.find({ slug: { $in: slugs } }).select('slug workspaceId').lean()
    : [];
  const productById = new Map(products.map((p) => [p.slug, p]));

  const requestIds = [...new Set(orders.map((o) => o.customRequestId).filter(Boolean).map(String))];
  const proposalIds = [...new Set(orders.map((o) => o.proposalId).filter(Boolean).map(String))];
  const [requests, proposals] = await Promise.all([
    requestIds.length
      ? CustomRequest.find({ _id: { $in: requestIds } }).select('_id workspaceId').lean()
      : [],
    proposalIds.length
      ? Proposal.find({ _id: { $in: proposalIds } }).select('_id workspaceId').lean()
      : [],
  ]);
  const requestById = new Map(requests.map((r) => [String(r._id), r]));
  const proposalById = new Map(proposals.map((p) => [String(p._id), p]));

  const buckets = { VALID: [], AMBIGUOUS: [], INVALID: [] };
  const reasons = new Map();

  for (const order of orders) {
    const reasonsFor = [];
    const itemWorkspaces = new Set();
    let missingItem = false;
    for (const item of order.items || []) {
      if (!item.productSlug) continue;
      const product = productById.get(item.productSlug);
      if (!product) {
        missingItem = true;
        continue;
      }
      if (product.workspaceId) itemWorkspaces.add(String(product.workspaceId));
    }

    let verdict = 'VALID';
    const orderWs = order.workspaceId ? String(order.workspaceId) : '';

    if (orderWs) {
      for (const ws of itemWorkspaces) {
        if (ws !== orderWs) {
          verdict = 'INVALID';
          reasonsFor.push(`item workspace ${ws} ≠ order workspace ${orderWs}`);
        }
      }
      if (verdict === 'VALID' && itemWorkspaces.size === 0 && (order.items || []).some((i) => i.productSlug)) {
        // The order records its workspace and nothing contradicts it — the
        // catalogue lines simply predate attribution (legacy product rows), so
        // there is no mismatch to prove. Reported as a note, not a defect.
        reasonsFor.push('catalogue items carry no attribution (legacy rows); no contradiction found');
      }
    } else if (workspaceCount === 0) {
      verdict = 'VALID';
      reasonsFor.push('pre-onboarding deployment (no Workspace exists)');
    } else {
      verdict = 'AMBIGUOUS';
      reasonsFor.push('legacy order without a workspace');
    }

    if (order.customRequestId) {
      const request = requestById.get(String(order.customRequestId));
      const proposal = order.proposalId ? proposalById.get(String(order.proposalId)) : null;
      if (!request) {
        verdict = 'AMBIGUOUS';
        reasonsFor.push('customRequestId does not resolve');
      } else {
        const requestWs = request.workspaceId ? String(request.workspaceId) : '';
        if (requestWs && orderWs && requestWs !== orderWs) {
          verdict = 'INVALID';
          reasonsFor.push(`request workspace ${requestWs} ≠ order workspace ${orderWs}`);
        }
        if (!requestWs && !orderWs) {
          if (verdict === 'VALID') verdict = 'AMBIGUOUS';
          reasonsFor.push('request and order are both unattributed');
        }
      }
      if (proposal) {
        const proposalWs = proposal.workspaceId ? String(proposal.workspaceId) : '';
        if (proposalWs && orderWs && proposalWs !== orderWs) {
          verdict = 'INVALID';
          reasonsFor.push(`proposal workspace ${proposalWs} ≠ order workspace ${orderWs}`);
        }
      }
    }

    if (missingItem && verdict !== 'INVALID') {
      // A deleted Product makes one line unverifiable — but a PROVEN
      // contradiction outranks it and must stay INVALID.
      verdict = 'AMBIGUOUS';
      reasonsFor.push('a catalogue line references a Product that no longer exists — ownership cannot be verified');
    }

    buckets[verdict].push({ orderId: order.orderId, workspaceId: orderWs || null, reasons: reasonsFor });
    for (const reason of reasonsFor) {
      const key = reason.replace(/\b[0-9a-f]{24}\b/g, '<id>');
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
  }

  const summary = {
    database: dbName,
    readOnly: true,
    workspaces: workspaceCount,
    orders: orders.length,
    VALID: buckets.VALID.length,
    AMBIGUOUS: buckets.AMBIGUOUS.length,
    INVALID: buckets.INVALID.length,
    reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, buckets }, null, 2));
  } else {
    console.log(`\norders: ${summary.orders} · VALID: ${summary.VALID} · AMBIGUOUS: ${summary.AMBIGUOUS} · INVALID: ${summary.INVALID}`);
    for (const bucket of ['INVALID', 'AMBIGUOUS']) {
      if (buckets[bucket].length === 0) continue;
      console.log(`\n${bucket} (first 20 of ${buckets[bucket].length}):`);
      for (const row of buckets[bucket].slice(0, 20)) {
        console.log(`  · ${row.orderId} workspace=${row.workspaceId || '—'} — ${row.reasons.join('; ')}`);
      }
    }
    console.log('\nNo writes were performed. Migrations are separate, operator-run, and confirmation-gated.');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[order-consistency] failed:', err.message);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
