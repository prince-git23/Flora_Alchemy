/**
 * PHASE 4 §7 — environment/database identity guard test.
 *
 * The E2E suite and every backend suite derive their database from MONGO_URI,
 * so the derivation itself is the safety boundary: if it can be talked into
 * resolving to production, every write in the suite lands on live data. This
 * suite exercises that boundary directly — no server, no database, no network,
 * no writes — and asserts the refusals in BOTH directions:
 *
 *   · a name without a disposable marker is refused;
 *   · a "derived" database that turns out to be the configured one is refused;
 *   · a positively identified production database is refused even when the
 *     caller supplies the exact confirmation token, and even when the process
 *     claims to be a development environment (a stale NODE_ENV must not
 *     authorise live data);
 *   · a generic confirmation (`true`/`1`/`yes`) never authorises anything.
 *
 * These are the properties the browser gate depends on. A regression here is
 * silent by nature — the suite would simply start talking to production — so it
 * is checked on every run rather than trusted.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  dbNameFromUri,
  classifyDatabase,
  assertSafeDatabase,
  assertFixtureAccountsAllowed,
  isDisposableDbName,
  EnvironmentSafetyError,
} from '../utils/environmentGuard.js';
import { testMongoUri } from './lib/testServer.mjs';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Run a function with an explicitly controlled environment, then restore it. */
function withEnv(vars, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Capture the error a thunk throws (or null when it does not throw). */
function caught(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

/* A production-shaped URI — the exact shape backend/.env uses. Credentials are
   placeholders so nothing secret appears here or in logs. */
const PROD_URI = 'mongodb+srv://user:placeholder@cluster0.example.mongodb.net/Flora-Alchemy?retryWrites=true&w=majority';
const DEV_URI = 'mongodb+srv://user:placeholder@cluster0.example.mongodb.net/flora_alchemy_dev?retryWrites=true';
const LOCAL_URI = 'mongodb://127.0.0.1:27017/anything_at_all';
const E2E_DB = 'Flora-Alchemy-Test-E2E';

/* ────────────────────────── 1. name extraction ────────────────────────── */
console.log('\nTEST 1: the database name always comes from the URI, never from a default');
{
  assert('srv URI → Flora-Alchemy', dbNameFromUri(PROD_URI) === 'Flora-Alchemy', dbNameFromUri(PROD_URI));
  assert('query string is not mistaken for the name', !dbNameFromUri(PROD_URI).includes('retryWrites'));
  assert('name-less URI yields "" (treated as unsafe)', dbNameFromUri('mongodb+srv://user:pw@cluster0.example.mongodb.net') === '');
  assert('non-mongo string yields ""', dbNameFromUri('not-a-uri') === '');
}

/* ─────────────────── 2. the E2E derivation is isolated ────────────────── */
console.log('\nTEST 2: the E2E harness derives an ISOLATED database from any configured URI');
{
  const derived = testMongoUri(PROD_URI, E2E_DB);
  assert('derivation succeeds for a disposable name', typeof derived === 'string' && derived.length > 0);
  assert('derived URI points at the E2E database, not production', dbNameFromUri(derived) === E2E_DB, dbNameFromUri(derived));
  assert('derived URI is not the configured URI', derived !== PROD_URI);
  assert('the E2E default name is disposable', isDisposableDbName(E2E_DB));
}

/* ─────────────────── 3. non-disposable names are refused ──────────────── */
console.log('\nTEST 3: a test database must carry a disposable marker');
{
  const err = caught(() => testMongoUri(PROD_URI, 'Flora-Alchemy'));
  assert('prod name refused before any spawn', err instanceof EnvironmentSafetyError, String(err && err.message));
  assert('refusal carries the database identity', err && err.database === 'Flora-Alchemy', err && err.database);

  const err2 = caught(() => testMongoUri(PROD_URI, 'FloraAlchemy'));
  assert('an unmarked lookalike is refused too', err2 instanceof EnvironmentSafetyError);

  const err3 = caught(() => testMongoUri(PROD_URI, ''));
  assert('a missing name is refused (fail closed)', err3 instanceof EnvironmentSafetyError);
}

console.log('\nTEST 4: a "derived" database equal to the configured one is refused');
{
  const base = 'mongodb://127.0.0.1:27017/Flora-Alchemy-Test-Rogue';
  const err = caught(() => testMongoUri(base, 'Flora-Alchemy-Test-Rogue'));
  assert('same-database derivation refused', err instanceof EnvironmentSafetyError, String(err && err.message));
}

/* ──────────── 5. positive production identification is authoritative ───── */
console.log('\nTEST 5: a configured production database can never be written to');
{
  withEnv({ PRODUCTION_DB_NAMES: 'Flora-Alchemy', CONFIRM_DATABASE_UNSAFE_OPERATION: undefined, NODE_ENV: 'development' }, () => {
    const err = caught(() => assertSafeDatabase(PROD_URI, 'seed fixture data'));
    assert('refused with a stale development NODE_ENV', err instanceof EnvironmentSafetyError, String(err && err.message));
    assert('classified as protected, not disposable', classifyDatabase(PROD_URI).disposable === false);

    const fx = caught(() => assertFixtureAccountsAllowed(PROD_URI, 'seed demo fixture accounts'));
    assert('demo fixture accounts refused in production', fx instanceof EnvironmentSafetyError);
  });

  withEnv({ PRODUCTION_DB_NAMES: 'Flora-Alchemy', CONFIRM_DATABASE_UNSAFE_OPERATION: 'Flora-Alchemy', NODE_ENV: 'production' }, () => {
    const err = caught(() => assertSafeDatabase(PROD_URI, 'seed fixture data'));
    assert('the EXACT confirmation token cannot unlock a listed production database', err instanceof EnvironmentSafetyError, String(err && err.message));
  });
}

/* ────────────────── 6. generic confirmation never bypasses ───────────── */
console.log('\nTEST 6: a generic confirmation token never authorises an unmarked database');
{
  const unlisted = 'mongodb+srv://user:pw@cluster0.example.mongodb.net/SomeUnmarkedDb';
  for (const token of ['true', '1', 'yes', 'Flora-Alchemy-Test-E2E']) {
    withEnv({ PRODUCTION_DB_NAMES: undefined, CONFIRM_DATABASE_UNSAFE_OPERATION: token, NODE_ENV: 'development' }, () => {
      const err = caught(() => assertSafeDatabase(unlisted, 'seed fixture data'));
      assert(`CONFIRM=${token} refuses to authorise an unmarked database`, err instanceof EnvironmentSafetyError);
    });
  }

  withEnv({ PRODUCTION_DB_NAMES: undefined, CONFIRM_DATABASE_UNSAFE_OPERATION: 'SomeUnmarkedDb', NODE_ENV: 'development' }, () => {
    const info = assertSafeDatabase(unlisted, 'deliberate one-off');
    assert('only the exact database name unlocks a deliberate one-off', info === null ? false : info.dbName === 'SomeUnmarkedDb');
  });
}

/* ───────────── 7. the genuinely disposable paths still work ──────────── */
console.log('\nTEST 7: disposable and local databases remain usable (the guard is not a blanket denial)');
{
  withEnv({ PRODUCTION_DB_NAMES: 'Flora-Alchemy', CONFIRM_DATABASE_UNSAFE_OPERATION: undefined }, () => {
    assert('Flora-Alchemy-Test-E2E is disposable', classifyDatabase(testMongoUri(PROD_URI, E2E_DB)).disposable === true);
    assert('the dev database is disposable', classifyDatabase(DEV_URI).disposable === true);
    assert('a local instance is disposable', classifyDatabase(LOCAL_URI).disposable === true);
    assert('a local instance needs no confirmation', assertSafeDatabase(LOCAL_URI, 'local work').dbName === 'anything_at_all');
  });
}

/* ───────────── 8. the E2E stack's own guard mirrors the rules ────────── */
console.log('\nTEST 8: the E2E stack default database and its guard agree');
{
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(path.join(BACKEND_DIR, '..', 'frontend', 'e2e', 'stack.mjs'), 'utf8')
  );
  assert('the stack derives its database through testMongoUri', /testMongoUri\(/.test(source));
  assert('the stack refuses a non-loopback API origin', /assertBundleTargetsLoopback/.test(source));
  assert('the stack refuses a disposable-name violation', /isDisposableDbName/.test(source));
  assert('the stack never enables real provider credentials', !/RAZORPAY_KEY_ID: *'(?!')/.test(source));
}

console.log('\n══════════════════════════════════════');
console.log(`ENVIRONMENT GUARD RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
