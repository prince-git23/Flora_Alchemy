/**
 * Production hardening smoke tests — Flora Alchemy backend (Phase 11A).
 *
 * Tests:
 *   1. Health endpoint returns 200 with service info
 *   2. Readiness endpoint returns 200 when MongoDB is connected
 *   3. Production seed rejection (SEED_ON_START=true exits non-zero)
 *   4. Missing MONGO_URI exits non-zero in production
 *   5. Missing JWT_SECRET exits non-zero in production
 *   6. Missing CORS_ORIGIN exits non-zero in production
 *   7. Graceful shutdown on SIGTERM
 *   8. Graceful shutdown on SIGINT
 *   9. Shutdown idempotency (second signal doesn't crash)
 *  10. Production startup with valid config (health + readiness)
 *
 * Run:  cd backend && node scripts/production-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import dotenv from 'dotenv';
import { testMongoUri } from './lib/testServer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');

// Load backend/.env
dotenv.config({ path: path.join(BACKEND_DIR, '.env'), override: false });

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✘ ${name} ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (inUse) => { socket.destroy(); resolve(inUse); };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

async function findFreePort(start = 4100) {
  for (let port = start; port < start + 200; port++) {
    if (!(await portInUse(port))) return port;
  }
  throw new Error('No free port found');
}

async function req(base, method, p) {
  const res = await fetch(`${base}${p}`, { method });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// Phase 20.6 — the local copy of this helper (a raw string splice with no
// validation) was replaced by the shared, guarded implementation in
// scripts/lib/testServer.mjs, which fails closed unless the derived database
// is unmistakably disposable and differs from the configured one.

// 60s per boot, matching scripts/lib/testServer.mjs: an Atlas cold connect plus
// a busy machine can legitimately take longer than the old 30s, and a boot
// timeout aborts the whole suite before any assertion runs. The budget only
// bounds how long we wait for evidence — no assertion is weakened.
async function bootServer({ port, env = {}, timeoutMs = 60_000 }) {
  const testUri = testMongoUri(process.env.MONGO_URI, `Flora-Alchemy-Test-Production-Smoke-${port}`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MONGO_URI: testUri,
      SEED_ON_START: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}: ${output.slice(0, 200)}`);
    }
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return { child, base, output };
    } catch {}
    await sleep(500);
  }
  child.kill('SIGKILL');
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

function killServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(resolve, 5000);
  });
}

/**
 * Wait (bounded) for a child to exit, instead of sampling `exitCode` after a
 * fixed sleep.
 *
 * The four "exits in production" checks used to `await sleep(5000)` and then
 * read `child.exitCode`. That is a wall-clock assumption about how fast a fresh
 * Node process can import the whole server module graph: on a loaded machine
 * (which the pre-merge audit was producing — a concurrent headless-Chrome
 * responsive sweep) the child had not finished booting inside those five
 * seconds, so the suite reported 8 FAILURES for a server that behaves correctly
 * and passes 25/25 when run alone. Polling for the exit is strictly stronger —
 * the assertion is still "it exited, with this message" — it just stops
 * treating machine load as a product defect.
 *
 * Bounded, and never vacuous: it returns false if the child is still running at
 * the deadline (the negative control below proves that), and it reports
 * termination by EITHER exit status or signal, so a process killed by a signal
 * is not mistaken for one that is still booting (which used to cost a 30s stall
 * and then report a failure whose cause was hidden). Termination is not
 * "success" on its own: each rejection test also asserts a non-zero exit status
 * and the rejection message, so a crash can never be read as an honest refusal.
 */
function hasTerminated(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasTerminated(child)) return true;
    await sleep(100);
  }
  return hasTerminated(child);
}

// ── Tests ──────────────────────────────────────────────────────────────
console.log('\n▶ Production Smoke Tests');

// --- Test 1: Health endpoint ---
{
  const port = await findFreePort(4100);
  const { child, base } = await bootServer({ port });
  try {
    const { status, json } = await req(base, 'GET', '/api/health');
    check('health returns 200', status === 200, `status=${status}`);
    check('health includes service', json?.service === 'flora-alchemy-api');
    check('health includes status ok', json?.status === 'ok');
    check('health includes time', !!json?.time);
  } finally {
    await killServer(child);
  }
}

// --- Test 2: Readiness endpoint (connected) ---
{
  const port = await findFreePort(4110);
  const { child, base } = await bootServer({ port });
  try {
    const { status, json } = await req(base, 'GET', '/api/readiness');
    check('readiness returns 200 when connected', status === 200, `status=${status}`);
    check('readiness status is ready', json?.status === 'ready');
    check('readiness success is true', json?.success === true);
  } finally {
    await killServer(child);
  }
}

// --- Negative control: a process that does NOT exit must NOT be reported as
// having exited. Without this, `waitForExit` returning true unconditionally
// would turn all four rejection tests into silent no-ops.
{
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    cwd: BACKEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exitedEarly = await waitForExit(child, 1500);
  check('a still-running process is NOT reported as exited', exitedEarly === false, `exited=${exitedEarly}`);
  child.kill('SIGKILL');
  await sleep(500);
}

// --- Test 3: Production seed rejection ---
{
  const port = await findFreePort(4120);
  const testUri = testMongoUri(process.env.MONGO_URI, `Flora-Alchemy-Test-Production-Smoke-${port}`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MONGO_URI: testUri,
      NODE_ENV: 'production',
      SEED_ON_START: 'true',
      JWT_SECRET: 'test-secret-for-production-smoke',
      CORS_ORIGIN: 'https://example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = await waitForExit(child);
  check('production + SEED_ON_START=true exits', exited, `exitCode=${child.exitCode}`);
  check('production + SEED_ON_START=true exits NON-ZERO', (child.exitCode ?? -1) > 0, `exitCode=${child.exitCode}`);
  check('rejection message mentions SEED_ON_START', output.includes('SEED_ON_START'), output.slice(0, 300));
  child.kill('SIGTERM');
  await sleep(500);
}

// --- Test 4: Missing MONGO_URI in production ---
{
  const port = await findFreePort(4130);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MONGO_URI: '',
      NODE_ENV: 'production',
      SEED_ON_START: 'false',
      JWT_SECRET: 'test-secret',
      CORS_ORIGIN: 'https://example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = await waitForExit(child);
  check('production + missing MONGO_URI exits', exited, `exitCode=${child.exitCode}`);
  check('production + missing MONGO_URI exits NON-ZERO', (child.exitCode ?? -1) > 0, `exitCode=${child.exitCode}`);
  check('error mentions MONGO_URI', output.includes('MONGO_URI'), output.slice(0, 300));
  child.kill('SIGTERM');
  await sleep(500);
}

// --- Test 5: Missing JWT_SECRET in production ---
{
  const port = await findFreePort(4140);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MONGO_URI: testMongoUri(process.env.MONGO_URI, `Flora-Alchemy-Test-Production-Smoke-${port}`),
      NODE_ENV: 'production',
      SEED_ON_START: 'false',
      JWT_SECRET: '',
      CORS_ORIGIN: 'https://example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = await waitForExit(child);
  check('production + missing JWT_SECRET exits', exited, `exitCode=${child.exitCode}`);
  check('production + missing JWT_SECRET exits NON-ZERO', (child.exitCode ?? -1) > 0, `exitCode=${child.exitCode}`);
  check('error mentions JWT_SECRET', output.includes('JWT_SECRET'), output.slice(0, 300));
  child.kill('SIGTERM');
  await sleep(500);
}

// --- Test 6: Missing CORS_ORIGIN in production ---
{
  const port = await findFreePort(4150);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MONGO_URI: testMongoUri(process.env.MONGO_URI, `Flora-Alchemy-Test-Production-Smoke-${port}`),
      NODE_ENV: 'production',
      SEED_ON_START: 'false',
      JWT_SECRET: 'test-secret',
      CORS_ORIGIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = await waitForExit(child);
  check('production + missing CORS_ORIGIN exits', exited, `exitCode=${child.exitCode}`);
  check('production + missing CORS_ORIGIN exits NON-ZERO', (child.exitCode ?? -1) > 0, `exitCode=${child.exitCode}`);
  check('error mentions CORS_ORIGIN', output.includes('CORS_ORIGIN'), output.slice(0, 300));

  // Missing CORS_ORIGIN is one fault; a CORS_ORIGIN that contains no usable
  // origin is another, and it must also refuse to boot rather than start and
  // silently reject every browser request (`utils/corsOrigins.js`).
  const junkPort = await findFreePort(4155);
  const junkChild = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(junkPort),
      MONGO_URI: testMongoUri(process.env.MONGO_URI, `Flora-Alchemy-Test-Production-Smoke-${junkPort}`),
      NODE_ENV: 'production',
      SEED_ON_START: 'false',
      JWT_SECRET: 'test-secret',
      CORS_ORIGIN: '*, not-a-url',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let junkOutput = '';
  junkChild.stdout.on('data', (d) => { junkOutput += d; });
  junkChild.stderr.on('data', (d) => { junkOutput += d; });
  const junkExited = await waitForExit(junkChild);
  check('production + unusable CORS_ORIGIN exits NON-ZERO', junkExited && (junkChild.exitCode ?? -1) > 0, `exitCode=${junkChild.exitCode}`);
  check(
    'the unusable CORS_ORIGIN is named in the failure',
    junkOutput.includes('CORS_ORIGIN') && junkOutput.includes('no usable origin'),
    junkOutput.slice(0, 300)
  );
  junkChild.kill('SIGTERM');
  await sleep(500);
  child.kill('SIGTERM');
  await sleep(500);
}

// On Windows, child.kill('SIGTERM') uses TerminateProcess which doesn't
// give a clean exit code 0 — the exit code is null. Both behaviors are
// acceptable: the important thing is the process actually exits.
const isWin = process.platform === 'win32';
function processExited(exitCode) {
  // On Unix, exit code 0 = clean shutdown.
  // On Windows, exit code null = process was terminated (expected).
  return isWin ? (exitCode === null || exitCode === 0) : exitCode === 0;
}

// --- Test 7: Graceful SIGTERM shutdown ---
{
  const port = await findFreePort(4160);
  const { child, base } = await bootServer({ port });
  try {
    const { status } = await req(base, 'GET', '/api/health');
    check('server up before SIGTERM', status === 200);

    const exitPromise = new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    child.kill('SIGTERM');
    const exitCode = await Promise.race([exitPromise, sleep(10000).then(() => -1)]);
    check('SIGTERM shuts down process', processExited(exitCode), `exitCode=${exitCode}`);
  } catch (err) {
    check('SIGTERM test', false, err.message);
    child.kill('SIGKILL');
  }
}

// --- Test 8: Graceful SIGINT shutdown ---
{
  const port = await findFreePort(4170);
  const { child, base } = await bootServer({ port });
  try {
    const { status } = await req(base, 'GET', '/api/health');
    check('server up before SIGINT', status === 200);

    const exitPromise = new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    child.kill('SIGINT');
    const exitCode = await Promise.race([exitPromise, sleep(10000).then(() => -1)]);
    check('SIGINT shuts down process', processExited(exitCode), `exitCode=${exitCode}`);
  } catch (err) {
    check('SIGINT test', false, err.message);
    child.kill('SIGKILL');
  }
}

// --- Test 9: Shutdown idempotency (double SIGTERM) ---
{
  const port = await findFreePort(4180);
  const { child, base } = await bootServer({ port });
  try {
    const exitPromise = new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 200);
    const exitCode = await Promise.race([exitPromise, sleep(10000).then(() => -1)]);
    check('double SIGTERM shuts down process', processExited(exitCode), `exitCode=${exitCode}`);
  } catch (err) {
    check('double SIGTERM', false, err.message);
    child.kill('SIGKILL');
  }
}

// Allow lingering connections to clean up before the final test
await sleep(3000);

// --- Test 10: Production startup with valid config ---
// Rather than booting a full 10th server (port reuse / Atlas connection
// throttling can make this flaky), verify production config behavior by
// spawning the process and checking its stdout for the expected startup
// sequence and warnings.
{
  const port = await findFreePort(4200);
  const testUri = testMongoUri(process.env.MONGO_URI, `Flora-Alchemy-Test-Production-Smoke-${port}`);
  console.log(`  (verifying production startup on port ${port}...)`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MONGO_URI: testUri,
      SEED_ON_START: 'false',
      NODE_ENV: 'production',
      JWT_SECRET: 'test-production-smoke-secret',
      CORS_ORIGIN: 'https://example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  // Wait for server to either start or exit (up to 30s)
  let started = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    if (output.includes('listening on')) { started = true; break; }
    await sleep(500);
  }

  if (started) {
    // Server started — verify health + readiness
    const base = `http://127.0.0.1:${port}`;
    try {
      const { status: healthStatus } = await req(base, 'GET', '/api/health');
      check('production health returns 200', healthStatus === 200);
      const { status: readyStatus, json: readyJson } = await req(base, 'GET', '/api/readiness');
      check('production readiness returns 200', readyStatus === 200);
      check('production readiness is ready', readyJson?.status === 'ready');
    } catch (err) {
      check('production endpoints reachable', false, err.message);
    }
  } else {
    check('production server starts', false, output.slice(0, 200));
  }

  // ImageKit/Razorpay warnings only appear when the corresponding env vars
  // are absent. In the dev environment they may already be configured.
  const imageKitMissing = !process.env.IMAGEKIT_PRIVATE_KEY || !process.env.IMAGEKIT_PUBLIC_KEY || !process.env.IMAGEKIT_URL_ENDPOINT;
  const razorpayMissing = !process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET;
  if (imageKitMissing) {
    check('ImageKit warning when unconfigured', output.includes('ImageKit') || output.includes('WARNING'), output.slice(0, 400));
  } else {
    check('ImageKit warning absent when configured', !output.includes('WARNING: ImageKit'));
  }
  if (razorpayMissing) {
    check('Razorpay warning when unconfigured', output.includes('Razorpay') || output.includes('WARNING'), output.slice(0, 400));
  } else {
    check('Razorpay warning absent when configured', !output.includes('WARNING: Razorpay'));
  }

  child.kill('SIGTERM');
  await sleep(2000);
}

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n════════════════════════════════════════`);
console.log(`  Production Smoke: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(`  Failures: ${failures.join(', ')}`);
}
console.log(`════════════════════════════════════════\n`);

process.exit(failed > 0 ? 1 : 0);
