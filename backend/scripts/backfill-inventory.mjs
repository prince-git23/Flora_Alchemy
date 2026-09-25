/**
 * Phase 20.2 — inventory backfill.
 *
 * Every stock-tracked product must have an Inventory record, otherwise the
 * first order for it dies with a raw "No inventory record exists for <slug>"
 * diagnostic at the final Review step. Products created before the
 * auto-create lifecycle (or seeded directly into MongoDB) can lack one.
 *
 * This script is idempotent and conservative:
 *   - missing records are created with currentStock 0 (= unavailable, never
 *     sellable blind) and the existing default reorderLevel of 5;
 *   - existing records are never modified;
 *   - orphan inventory records (no matching product) are REPORTED only.
 *
 * Orphaned records whose product was RENAMED (slug regenerated on edit)
 * are detected by create-flow timestamp and MIGRATED to the current slug,
 * preserving stock, instead of the product being zeroed. Orphans with no
 * surviving product are reported and only deleted with --purge-orphans.
 *
 * Usage (from backend/):
 *   node scripts/backfill-inventory.mjs --report         # dry run, print findings
 *   node scripts/backfill-inventory.mjs                  # migrate + backfill
 *   node scripts/backfill-inventory.mjs --purge-orphans  # also delete dead rows
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Inventory from '../models/Inventory.js';
import { assertSafeDatabase, describeDatabase } from '../utils/environmentGuard.js';

const reportOnly = process.argv.includes('--report');
const purgeOrphans = process.argv.includes('--purge-orphans');

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('[backfill] MONGO_URI is not configured.');
  process.exit(1);
}

// Phase 20.6 — this script WRITES inventory records (and deletes orphaned ones
// with --purge-orphans). A local `node scripts/backfill-inventory.mjs` used to
// resolve straight to whatever MONGO_URI pointed at, which is production in
// the shipped .env layout. It now fails closed unless the target database is
// unmistakably disposable. --report stays read-only and is always allowed.
if (!reportOnly) {
  try {
    assertSafeDatabase(uri, 'backfill inventory records');
  } catch (err) {
    console.error(`[backfill] ${err.message}`);
    process.exit(1);
  }
}

await mongoose.connect(uri);
console.log(`[backfill] connected — ${describeDatabase(uri)}${reportOnly ? ' (report only)' : ''}`);

try {
  const allProducts = await Product.find({}).select('slug name sku isFixture stockTracked createdAt').lean();
  const tracked = allProducts.filter((p) => p.stockTracked !== false);
  const inventory = await Inventory.find({}).select('productSlug productName currentStock sku reorderLevel createdAt').lean();
  const have = new Set(inventory.map((i) => i.productSlug));

  const missing = tracked.filter((p) => !have.has(p.slug));
  const allSlugs = new Set(allProducts.map((p) => p.slug));
  const orphans = inventory.filter((i) => !allSlugs.has(i.productSlug));

  // ---- slug-rename pairing -------------------------------------------------
  // When an edit regenerates a product's slug, the inventory record created
  // for the original slug is orphaned while the product loses its stock
  // (that is how "No inventory record exists for ..." reaches checkout).
  // Product and inventory row are written within the same create request
  // (~300ms apart), so pair them by createdAt and migrate the row to the
  // current slug — stock preserved — instead of zeroing the product.
  const PAIR_WINDOW_MS = 5000;
  const consumedOrphans = new Set();
  const migrations = [];
  for (const p of missing) {
    const t0 = new Date(p.createdAt).getTime();
    if (Number.isNaN(t0)) continue;
    let best = null;
    let bestDelta = Infinity;
    for (const o of orphans) {
      if (consumedOrphans.has(o.productSlug)) continue;
      const delta = Math.abs(new Date(o.createdAt).getTime() - t0);
      if (delta <= PAIR_WINDOW_MS && delta < bestDelta) {
        best = o;
        bestDelta = delta;
      }
    }
    if (best) {
      consumedOrphans.add(best.productSlug);
      migrations.push({ product: p, orphan: best, delta: bestDelta });
    }
  }
  const missingAfterMigration = missing.filter(
    (p) => !migrations.some((m) => m.product.slug === p.slug)
  );
  const deadOrphans = orphans.filter((o) => !consumedOrphans.has(o.productSlug));

  console.log(`[backfill] products total: ${allProducts.length} (stock-tracked: ${tracked.length})`);
  console.log(`[backfill] inventory records: ${inventory.length}`);
  console.log(`[backfill] stock-tracked products MISSING an inventory record: ${missing.length}`);
  missing.forEach((p) => console.log(`  - ${p.slug}  "${p.name}"`));
  console.log(`[backfill] slug-rename pairs to migrate (stock preserved): ${migrations.length}`);
  migrations.forEach((m) =>
    console.log(`  - ${m.orphan.productSlug} (stock ${m.orphan.currentStock}) -> ${m.product.slug}  [dt ${m.delta}ms]`)
  );
  console.log(`[backfill] dead orphan inventory records (no product): ${deadOrphans.length}`);
  deadOrphans.forEach((i) => console.log(`  - ${i.productSlug} (stock ${i.currentStock})`));

  if (reportOnly) {
    console.log('[backfill] --report: no changes made.');
    if (migrations.length || deadOrphans.length) {
      console.log('[backfill] re-run without --report to apply the plan above.');
    }
  } else {
    let changed = 0;

    // Migrate rename-paired orphans to the current slug (stock preserved).
    for (const m of migrations) {
      const set = { productSlug: m.product.slug, productName: m.product.name };
      if (m.product.sku) set.sku = m.product.sku;
      await Inventory.updateOne({ _id: m.orphan._id }, { $set: set });
      changed += 1;
      console.log(`[backfill] migrated ${m.orphan.productSlug} -> ${m.product.slug} (stock ${m.orphan.currentStock} preserved)`);
    }

    // Dead QA/orphan rows: removed only when explicitly requested.
    if (deadOrphans.length) {
      if (purgeOrphans) {
        const del = await Inventory.deleteMany({
          productSlug: { $in: deadOrphans.map((o) => o.productSlug) },
        });
        console.log(`[backfill] purged ${del.deletedCount} dead orphan record(s).`);
      } else {
        console.log(`[backfill] ${deadOrphans.length} dead orphan(s) kept — pass --purge-orphans to delete.`);
      }
    }

    if (missingAfterMigration.length === 0) {
      if (changed === 0) console.log('[backfill] nothing to backfill.');
    } else {
      const ops = missingAfterMigration.map((p) => ({
        updateOne: {
          filter: { productSlug: p.slug },
          update: {
            $setOnInsert: {
              productSlug: p.slug,
              sku: p.sku || '',
              productName: p.name,
              currentStock: 0,
              reorderLevel: 5,
              unit: 'units',
              isFixture: !!p.isFixture,
            },
          },
          upsert: true,
        },
      }));
      const res = await Inventory.bulkWrite(ops);
      console.log(`[backfill] backfilled ${res.upsertedCount} missing inventory record(s) at stock 0.`);
    }
  }
} finally {
  await mongoose.disconnect();
}
