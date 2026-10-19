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
 *   node scripts/db-footprint.mjs --drop-leftovers      # drop VERIFIED leftovers
 *   node scripts/db-footprint.mjs --drop-leftovers --keep=Flora-Alchemy-Test-E2E
 *   node scripts/db-footprint.mjs --drop-leftovers --allow=some-other-qa-db
 *
 * Safety (the reason this file is careful rather than clever):
 *   · the DEFAULT action is a read-only report;
 *   · a target must be EXPLICITLY verified as disposable — it matches the suite
 *     naming pattern this repository creates (`Flora-Alchemy-Test-*`) or the
 *     operator named it with `--allow=`. A bare name-marker (`test`/`qa`/`dev`/
 *     `smoke`/`sandbox`) is NOT enough any more: a remote development database
 *     such as `flora_alchemy_dev` sits on the same cluster as production;
 *   · `Flora-Alchemy` and `flora_alchemy_dev` are never dropped, with or
 *     without `--allow`, and neither is anything in `PRODUCTION_DB_NAMES`;
 *   · the currently configured database is never dropped;
 *   · the selection logic lives in `scripts/lib/cleanupTargets.mjs` and is
 *     unit-tested without a cluster in `scripts/environment-guard-smoke.mjs`;
 *   · every drop is printed before it happens.
 */

import mongoose from 'mongoose';
import { loadBackendEnv } from './lib/testServer.mjs';
import { dbNameFromUri, isDisposableDbName, protectedDbNames } from '../utils/environmentGuard.js';
import { selectCleanupTargets } from './lib/cleanupTargets.mjs';

loadBackendEnv();

const args = process.argv.slice(2);
const dropLeftovers = args.includes('--drop-leftovers');
const keepArg = args.find((a) => a.startsWith('--keep='));
const allowArg = args.find((a) => a.startsWith('--allow='));
const keep = new Set(
  (keepArg ? keepArg.slice('--keep='.length).split(',') : ['Flora-Alchemy-Test-E2E'])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
// Operator-verified extra targets. Exact names only — there is no pattern form,
// because "looks disposable" is exactly the judgement this tool no longer makes.
const allow = new Set(
  (allowArg ? allowArg.slice('--allow='.length).split(',') : [])
    .map((s) => s.trim())
    .filter(Boolean)
);

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is not configured (backend/.env).');
  process.exit(1);
}

const connectedDb = dbNameFromUri(uri);
console.log(`configured database: ${connectedDb || '<unknown>'} (never dropped by this script)`);
// Protected names are the LOCAL safeguards plus anything the environment names.
// De-duplicated because this list is a safety control: 'Flora-Alchemy' appearing
// twice leaves a reader wondering whether the second entry was a variant that
// would slip past a `!==` comparison (it is not — matching is case-insensitive
// and set-based — but a guardrail must not look ambiguous).
const protectedNames = [...new Set(['Flora-Alchemy', 'flora_alchemy_dev', ...protectedDbNames()])];
console.log(`protected names: ${protectedNames.join(', ')}\n`);

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

  const { droppable: droppableNames, kept } = selectCleanupTargets(rows, {
    keep,
    connectedDb,
    protectedNames,
    allow,
  });
  const droppable = rows.filter((r) => droppableNames.includes(r.name));

  if (!dropLeftovers) {
    console.log(`Reclaimable now: ${droppable.length} verified-disposable databases ` +
      `(${droppable.reduce((s, r) => s + r.collections, 0)} collections). Re-run with --drop-leftovers.`);
    const notDropped = kept.filter((k) => !/protected name|currently configured|keep list/.test(k.reason));
    if (notDropped.length) {
      console.log(`Not reclaimable without --allow=<exact name>:`);
      for (const k of notDropped) console.log(`  ${k.name.padEnd(36)} ${k.reason}`);
    }
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
