/**
 * Phase 4 — cluster footprint inventory (READ-ONLY) and safe leftover cleanup.
 *
 * WHY THIS EXISTS
 * ---------------
 * The shared cluster enforces a 500-COLLECTION cap, and every smoke suite leaves
 * its own `Flora-Alchemy-Test-*` database behind. Once the cap is reached, new
 * suites fail with "cannot create a new collection -- already using 500
 * collections of 500" — which reads exactly like a product regression and is
 * not one. This was observed live in Phase 4 (Portal Auth failed that way).
 *
 * Usage:
 *   node scripts/db-footprint.mjs                       # report only, no writes
 *   node scripts/db-footprint.mjs --drop-leftovers      # drop DISPOSABLE leftovers
 *   node scripts/db-footprint.mjs --drop-leftovers --keep=Flora-Alchemy-Test-E2E
 *
 * Safety (the reason this file is careful rather than clever):
 *   · the DEFAULT action is a read-only report;
 *   · a target must carry a disposable marker (`test`/`qa`/`dev`/`smoke`/
 *     `sandbox`) — `Flora-Alchemy` and `flora_alchemy_dev` can therefore never
 *     be dropped by this script, and neither can a database listed in
 *     `PRODUCTION_DB_NAMES`;
 *   · the E2E database is kept unless explicitly told otherwise, because the
 *     browser suite's fixtures are expensive to recreate;
 *   · every drop is printed before it happens.
 */

import mongoose from 'mongoose';
import { loadBackendEnv } from './lib/testServer.mjs';
import { dbNameFromUri, isDisposableDbName, protectedDbNames } from '../utils/environmentGuard.js';

loadBackendEnv();

const args = process.argv.slice(2);
const dropLeftovers = args.includes('--drop-leftovers');
const keepArg = args.find((a) => a.startsWith('--keep='));
const keep = new Set(
  (keepArg ? keepArg.slice('--keep='.length).split(',') : ['Flora-Alchemy-Test-E2E'])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is not configured (backend/.env).');
  process.exit(1);
}

const connectedDb = dbNameFromUri(uri);
console.log(`configured database: ${connectedDb || '<unknown>'} (never dropped by this script)`);
console.log(`protected names: ${['Flora-Alchemy', 'flora_alchemy_dev', ...protectedDbNames()].join(', ')}\n`);

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });

try {
  const client = mongoose.connection.client;
  const { databases } = await client.db().admin().listDatabases();

  const rows = [];
  for (const { name } of databases) {
    if (['admin', 'local', 'config'].includes(name)) continue;
    const collections = await client.db(name).listCollections().toArray();
    rows.push({ name, collections: collections.length });
  }
  rows.sort((a, b) => b.collections - a.collections);

  const total = rows.reduce((sum, r) => sum + r.collections, 0);
  console.log('database'.padEnd(38), 'collections');
  for (const r of rows) {
    const isProtected = !isDisposableDbName(r.name);
    const kept = keep.has(r.name.toLowerCase());
    console.log(
      `  ${r.name.padEnd(36)} ${String(r.collections).padStart(4)}` +
        `${isProtected ? '  PROTECTED' : ''}${kept ? '  KEPT' : ''}`
    );
  }
  console.log(`\n  ${rows.length} databases · ${total} collections total (cap: 500)\n`);

  const droppable = rows.filter(
    (r) => isDisposableDbName(r.name) && !keep.has(r.name.toLowerCase()) && r.name !== connectedDb
  );

  if (!dropLeftovers) {
    console.log(`Reclaimable now: ${droppable.length} disposable databases ` +
      `(${droppable.reduce((s, r) => s + r.collections, 0)} collections). Re-run with --drop-leftovers.`);
  } else {
    let freed = 0;
    for (const r of droppable) {
      console.log(`  dropping ${r.name} (${r.collections} collections)`);
      await client.db(r.name).dropDatabase();
      freed += r.collections;
    }
    console.log(`\nDropped ${droppable.length} disposable databases · ${freed} collections freed.`);
  }
} finally {
  await mongoose.disconnect();
}
