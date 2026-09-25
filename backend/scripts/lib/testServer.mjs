/**
 * Shared test-server bootstrap for Flora Alchemy smoke suites.
 *
 * Every suite boots its OWN backend process against its OWN MongoDB database:
 *   - no dependency on a manually started dev server
 *   - fresh in-memory rate-limit store per suite (the security suite may
 *     exhaust the login limiter without affecting any other suite)
 *   - zero writes to the development database (Phase 16 isolation fix —
 *     previously suites relying on process.env.MONGO_URI silently fell back
 *     to the dev database because the shell never defines that variable)
 *
 * Usage:
 *   import { bootTestServer, testMongoUri } from './lib/testServer.mjs';
 *   const { child, base } = await bootTestServer({ port: 4095, db: 'Flora-Alchemy-Test-Api' });
 *   try { …run assertions against ${base}/api… } finally { await child.kill(); }
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import dotenv from 'dotenv';
import {
  dbNameFromUri,
  isDisposableDbName,
  EnvironmentSafetyError,
} from '../../utils/environmentGuard.js';

export const BACKEND_DIR = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Load backend/.env into process.env (without overriding variables the
 * caller/CI already set). Must run BEFORE computing test DB URIs — the
 * suites derive their isolated database from MONGO_URI.
 */
export function loadBackendEnv() {
  dotenv.config({ path: path.join(BACKEND_DIR, '.env'), override: false });
}

/**
 * Derive a dedicated test-database URI from the configured MONGO_URI by
 * swapping the database pathname. Returns undefined when no base URI exists
 * (the caller then fails loudly instead of silently testing against dev data).
 */
export function testMongoUri(baseUri, dbName) {
  if (!baseUri || !dbName) return undefined;
  const baseDb = dbNameFromUri(baseUri);

  // Phase 20.6 — fail closed. The derived database must (a) carry an
  // unmistakable disposable marker and (b) actually differ from the configured
  // database. Without this, a typo in a suite's db name — or a future suite
  // that forgets to pass one — would silently run the whole suite, including
  // its cleanups, against the live database.
  if (!isDisposableDbName(dbName)) {
    throw new EnvironmentSafetyError(
      `Refusing to run tests against "${dbName}": a test database name must contain ` +
      'a test/qa/dev/smoke/sandbox marker (e.g. Flora-Alchemy-Test-<Suite>).',
      { database: dbName, operation: 'derive test database' }
    );
  }

  let derived;
  try {
    const u = new URL(baseUri);
    u.pathname = `/${dbName}`;
    derived = u.toString();
  } catch {
    return undefined;
  }

  const derivedDb = dbNameFromUri(derived);
  if (derivedDb === baseDb) {
    throw new EnvironmentSafetyError(
      `Refusing to run tests: the derived test database resolves to the configured ` +
      `database "${baseDb}". Tests must never target a non-test database.`,
      { database: baseDb, operation: 'derive test database' }
    );
  }
  return derived;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp(base) {
  try {
    const r = await fetch(`${base}/api/health`);
    return r.ok;
  } catch {
    return false;
  }
}

export async function portInUse(port) {
  // TCP-level check: ANY accepting listener counts as in use. An HTTP probe
  // misclassifies foreign listeners (e.g. a local proxy controller answering
  // 401) as "free" — on Windows the child then half-binds and connections
  // silently go to the other process.
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (inUse) => { socket.destroy(); resolve(inUse); };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Boot an isolated backend for testing.
 *
 * @param {object} opts
 * @param {number} opts.port       port for the spawned server
 * @param {string} opts.db         dedicated MongoDB database name
 * @param {object} [opts.extraEnv] additional env for the child (e.g. Razorpay mocks)
 * @param {string} [opts.label]    suite name used in logs
 * @returns {Promise<{child: import('node:child_process').ChildProcess, base: string}>}
 */
export async function bootTestServer({ port, db, extraEnv = {}, label = 'suite' }) {
  loadBackendEnv();
  const base = `http://127.0.0.1:${port}`;
  const testUri = testMongoUri(process.env.MONGO_URI, db);
  if (!testUri) {
    throw new Error(
      `[${label}] MONGO_URI is not configured (backend/.env). Refusing to run without an isolated test database.`
    );
  }
  console.log(`[${label}] test database: ${dbNameFromUri(testUri)}`);
  if (await portInUse(port)) {
    throw new Error(
      `[${label}] port ${port} is already in use — stop the other process first (concurrent suites would corrupt assertions).`
    );
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MONGO_URI: testUri,
      // Test servers seed fixtures, which production mode forbids. Force
      // development semantics unless the caller explicitly overrides —
      // a developer's local .env with NODE_ENV=production must not make
      // every suite fail with the seed-rejection config error.
      NODE_ENV: 'development',
      SEED_ON_START: 'true',
      // Deterministic provider config: test servers never inherit live
      // ImageKit credentials from backend/.env — invalid/expired keys made
      // multipart upload tests depend on a third-party service (the suite
      // 403'd against live ImageKit mid-run). With empty creds the upload
      // controller takes its real local-storage path, which is fully
      // verifiable on disk. Live-provider verification belongs to an
      // external check, not the deterministic suite.
      IMAGEKIT_PRIVATE_KEY: '',
      IMAGEKIT_PUBLIC_KEY: '',
      IMAGEKIT_URL_ENDPOINT: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let childOutput = '';
  child.stdout.on('data', (d) => { childOutput += d; });
  child.stderr.on('data', (d) => { childOutput += d; });

  // Wait for health (up to ~60s — Atlas cold connect + a FULL first seed
  // with bcrypt-12 fixture hashing can take ~30s+; healthy servers return
  // immediately regardless).
  for (let i = 0; i < 120; i += 1) {
    if (await isUp(base)) {
      return { child, base };
    }
    if (child.exitCode !== null) {
      throw new Error(`[${label}] backend exited during boot (code ${child.exitCode}):\n${childOutput.slice(-800)}`);
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`[${label}] backend did not become healthy within 60s:\n${childOutput.slice(-800)}`);
}

/**
 * Kill the spawned server and WAIT for the port to actually be released.
 * On Windows child.kill() is asynchronous at the OS level — the next suite
 * (or a same-suite second server on the same port) can hit EADDRINUSE
 * without this await. Tolerates repeat calls and already-exited children.
 */
export async function stopTestServer(child, base) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, sleep(5000)]);
  if (base) {
    // Wait until the health endpoint stops answering (port truly released).
    for (let i = 0; i < 20; i += 1) {
      if (!(await isUp(base))) return;
      await sleep(250);
    }
  }
}
