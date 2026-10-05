/**
 * PHASE 2 — merge per-(customer, workspace) wishlists into ONE GLOBAL wishlist.
 *
 * WHY: the wishlist is a customer-owned record; the Phase 22.5 model stored one
 * document per (customerId, workspaceId), and `scripts/attach-wishlist-workspaces.mjs`
 * even attached the previously unscoped rows to the single workspace. Phase 2
 * removes shop/workspace authority from the wishlist entirely, so historical
 * documents must be consolidated: one document per customer, holding the UNION
 * of what they saved.
 *
 * SAFETY CONTRACT
 *   · DRY-RUN by default — `--apply` is required to write anything;
 *   · disposable database OR a recognised production database with BOTH
 *     CONFIRM_DATABASE_UNSAFE_OPERATION=<dbName> and
 *     WISHLIST_MIGRATION_CONFIRM=APPLY_PRODUCTION_WISHLIST_MERGE;
 *   · it NEVER deletes a product reference that resolves to a real Product
 *     (valid products are preserved), and NEVER overwrites: merges are unions;
 *   · only PROVABLY orphaned references (a slug that resolves to no Product at
 *     all) are dropped, and every drop is reported;
 *   · ambiguity is REPORTED, never guessed: multiple scoped documents, several
 *     candidate canonical rows, and product references whose owning shop
 *     differs from the document's old workspace stamp all land in the report;
 *   · IDEMPOTENT — a second run plans zero changes and writes nothing.
 *
 * Usage (from backend/):
 *   node scripts/merge-wishlists-global.mjs              # DRY-RUN: report only
 *   node scripts/merge-wishlists-global.mjs --report     # same as above
 *   node scripts/merge-wishlists-global.mjs --apply      # perform the merge
 */
import 'dotenv/config';
import path from 'node:path';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { classifyDatabase, assertSafeDatabase, EnvironmentSafetyError } from '../utils/environmentGuard.js';
import Wishlist from '../models/Wishlist.js';
import Product from '../models/Product.js';

/** Same values in the same order? (used for the idempotency decision) */
function sameArray(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

const PRODUCTION_MIGRATION_CONFIRM = 'APPLY_PRODUCTION_WISHLIST_MERGE';

/**
 * PURE planner — no IO, so the merge rules are unit-testable.
 *
 * @param {object} input
 * @param {Array<{_id:any, customerId:any, workspaceId:any, productIds:string[], createdAt?:Date}>} input.wishlists
 * @param {Set<string>|Iterable<string>} input.knownProductSlugs  slugs that resolve to a real Product
 * @param {Map<string,string|null>} [input.productWorkspaceById] slug → owning workspaceId (for the ambiguity report)
 * @returns {{plans:Array, summary:object}}
 */
export function buildWishlistMergePlan({ wishlists = [], knownProductSlugs, productWorkspaceById }) {
  const known = knownProductSlugs instanceof Set ? knownProductSlugs : new Set(knownProductSlugs || []);
  const byCustomer = new Map();
  for (const doc of wishlists) {
    const key = String(doc.customerId);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(doc);
  }

  const plans = [];
  const summary = {
    customers: 0,
    documents: wishlists.length,
    customersWithMultipleDocuments: 0,
    duplicatesMerged: 0,
    supersededDocuments: 0,
    documentsDetached: 0,
    referencesDeduplicated: 0,
    orphanedReferencesDropped: 0,
    ambiguousFindings: [],
    changed: false,
  };

  for (const [customerId, docs] of byCustomer) {
    summary.customers += 1;
    const sorted = [...docs].sort((a, b) => {
      const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return at - bt;
    });
    // Canonical: the already-global (unscoped) document when one exists, else
    // the oldest — deterministic, and it prefers the row the API already uses.
    const canonical = sorted.find((d) => !d.workspaceId) || sorted[0];
    const others = sorted.filter((d) => String(d._id) !== String(canonical._id));

    if (others.length > 0) {
      summary.customersWithMultipleDocuments += 1;
      summary.duplicatesMerged += 1;
      summary.supersededDocuments += others.length;
      summary.ambiguousFindings.push({
        customerId,
        kind: 'multiple-documents',
        detail: `${sorted.length} wishlist documents for one customer — merged into ${String(canonical._id)}`,
        workspaceStamps: sorted.map((d) => (d.workspaceId ? String(d.workspaceId) : null)),
      });
    }

    const merged = [];
    const dropped = [];
    const crossScope = [];
    for (const doc of sorted) {
      for (const slug of doc.productIds || []) {
        if (!known.has(slug)) {
          // PROVABLY orphaned: no Product with this slug exists at all.
          if (!dropped.includes(slug)) dropped.push(slug);
          continue;
        }
        if (merged.includes(slug)) {
          summary.referencesDeduplicated += 1;
          continue;
        }
        merged.push(slug);
        const owner = productWorkspaceById && productWorkspaceById.get(slug);
        if (doc.workspaceId && owner && String(owner) !== String(doc.workspaceId)) {
          crossScope.push(slug);
        }
      }
    }

    if (crossScope.length > 0) {
      summary.ambiguousFindings.push({
        customerId,
        kind: 'cross-scope-reference',
        detail: `saved slug(s) owned by a different shop than the document's workspace stamp: ${crossScope.join(', ')}`,
      });
    }
    if (dropped.length > 0) {
      summary.orphanedReferencesDropped += dropped.length;
      summary.ambiguousFindings.push({
        customerId,
        kind: 'orphaned-reference',
        detail: `dropped slug(s) that resolve to no product: ${dropped.join(', ')}`,
      });
    }

    const canonicalIsScoped = !!canonical.workspaceId;
    if (canonicalIsScoped) summary.documentsDetached += 1;

    // Idempotency: nothing to write when the canonical row already holds
    // exactly the merged union and carries no legacy workspace stamp.
    const changed =
      others.length > 0 ||
      canonicalIsScoped ||
      !sameArray(canonical.productIds || [], merged);

    plans.push({
      customerId,
      canonicalId: canonical._id,
      canonicalWorkspaceId: canonical.workspaceId ? String(canonical.workspaceId) : null,
      supersededIds: others.map((d) => d._id),
      productIds: merged,
      dropped,
      changed,
    });
  }

  summary.changed = plans.some((p) => p.changed);
  return { plans, summary };
}

function refuse(message) {
  console.error(`[wishlists-global] ${message}`);
  process.exit(1);
}

function resolveSafety(info) {
  const purpose = String(process.env.WISHLIST_MIGRATION_CONFIRM || '') === PRODUCTION_MIGRATION_CONFIRM;
  const exact = String(process.env.CONFIRM_DATABASE_UNSAFE_OPERATION || '') === info.dbName;
  if (info.disposable) {
    if (purpose) refuse('WISHLIST_MIGRATION_CONFIRM is set but the target is disposable — unset the production flags.');
    try {
      assertSafeDatabase(process.env.MONGO_URI, 'merge wishlists');
    } catch (err) {
      if (err instanceof EnvironmentSafetyError) refuse(err.message);
      throw err;
    }
    return;
  }
  if (!info.nameProtected) {
    refuse(`"${info.dbName}" is neither disposable nor a recognised production database (PRODUCTION_DB_NAMES).`);
  }
  if (!exact) refuse(`set CONFIRM_DATABASE_UNSAFE_OPERATION=${info.dbName} to confirm the exact database name.`);
  if (!purpose) refuse(`set WISHLIST_MIGRATION_CONFIRM=${PRODUCTION_MIGRATION_CONFIRM} to confirm the intent.`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) refuse('MONGO_URI is not configured.');

  await mongoose.connect(uri);
  const cls = classifyDatabase(uri);
  console.log(
    `[wishlists-global] connected — db=${cls.dbName} host=${cls.localHost ? 'local' : 'remote'} ` +
      `class=${cls.disposable ? 'disposable' : 'PROTECTED'} mode=${apply ? 'APPLY' : 'DRY-RUN'}`
  );

  const wishlists = await Wishlist.find({}).select('customerId workspaceId productIds createdAt').lean();
  const products = await Product.find({}).select('slug workspaceId').lean();
  const knownProductSlugs = new Set(products.map((p) => p.slug));
  const productWorkspaceById = new Map(products.map((p) => [p.slug, p.workspaceId ? String(p.workspaceId) : null]));

  const { plans, summary } = buildWishlistMergePlan({ wishlists, knownProductSlugs, productWorkspaceById });

  console.log(
    `[wishlists-global] customers=${summary.customers} documents=${summary.documents} ` +
      `multi-doc customers=${summary.customersWithMultipleDocuments}`
  );
  console.log(
    `[wishlists-global] planned: superseded docs to delete=${summary.supersededDocuments} ` +
      `docs to detach=${summary.documentsDetached} refs deduped=${summary.referencesDeduplicated} ` +
      `orphaned refs dropped=${summary.orphanedReferencesDropped}`
  );
  for (const finding of summary.ambiguousFindings) {
    console.log(`  ! ${finding.kind} customer=${String(finding.customerId).slice(0, 8)}… — ${finding.detail}`);
  }

  if (!apply) {
    console.log(
      `\n[wishlists-global] DRY-RUN — NO CHANGES MADE. ${summary.changed ? 'Re-run with --apply to merge.' : 'Nothing to change (already consolidated).'}`
    );
    await mongoose.disconnect();
    return;
  }

  resolveSafety(cls);

  if (!summary.changed) {
    console.log('[wishlists-global] nothing to apply — every customer already has exactly one global wishlist.');
    await mongoose.disconnect();
    return;
  }

  let mergedDocs = 0;
  let deletedDocs = 0;
  for (const plan of plans.filter((p) => p.changed)) {
    // Union into the canonical row and detach it from any legacy workspace.
    await Wishlist.updateOne(
      { _id: plan.canonicalId },
      { $set: { productIds: plan.productIds, workspaceId: null } }
    );
    mergedDocs += 1;
    if (plan.supersededIds.length > 0) {
      // Every product reference in the superseded rows has already been merged
      // into the canonical row above — this deletes only now-empty duplicates.
      const res = await Wishlist.deleteMany({ _id: { $in: plan.supersededIds } });
      deletedDocs += res.deletedCount || 0;
    }
  }

  // Verification: exactly one document per customer, every one unscoped.
  const remainingDupes = await Wishlist.aggregate([
    { $group: { _id: '$customerId', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  const remainingScoped = await Wishlist.countDocuments({ workspaceId: { $ne: null } });
  const total = await Wishlist.countDocuments({});
  console.log(
    `[wishlists-global] applied: canonical docs updated=${mergedDocs} superseded docs deleted=${deletedDocs} ` +
      `total documents=${total} still-scoped=${remainingScoped} duplicate customers=${remainingDupes.length}`
  );
  await mongoose.disconnect();
  if (remainingDupes.length > 0 || remainingScoped > 0) {
    refuse('verification failed — wishlists are not fully consolidated.');
  }
  console.log('[wishlists-global] DONE.');
}

// Only run when executed directly (`node scripts/merge-wishlists-global.mjs`);
// importing the module in a test loads the planner without touching a database.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  await main();
}
