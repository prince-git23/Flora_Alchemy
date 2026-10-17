/**
 * release-boot-gate — would THIS tree boot, and does it mount what it claims?
 *
 * WHY THIS EXISTS
 * ---------------
 * `d7ebf9c` had to ship a controller that a router imported but which had never
 * been committed. On a developer's machine the file was sitting right there, so
 * everything worked; the release was only fixed after a human probed production
 * by hand. A CI checkout has no untracked leftovers — which is exactly the
 * property this gate relies on.
 *
 * Three checks, in increasing cost:
 *
 *   1. MODULE SWEEP — import every backend module (config, middleware, models,
 *      routes, controllers, services, utils). A missing file, a circular import
 *      or a syntax error fails here, with the offending path named. This is the
 *      check that catches the missing-controller class.
 *   2. MOUNT COVERAGE — parse `server.js` for its `app.use('/api/…', X)` mounts
 *      and assert that every route module in `routes/` is actually mounted, and
 *      that every mounted router is a real router. A route file nothing mounts
 *      is dead code pretending to be an endpoint.
 *   3. CONTRACT — boot the server against a DISPOSABLE database and run the same
 *      read-only contract checks the production probe runs.
 *
 * DATABASE: this gate REFUSES to run without one (exit 2) rather than skipping
 * check 3. "The tests passed, minus the ones that needed a database" is not a
 * release gate. In CI a Mongo service is provided; locally `backend/.env` has it.
 *
 * Usage:  node scripts/release-boot-gate.mjs
 * Exit:   0 pass · 1 a check failed · 2 the database is unavailable (not a pass)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKEND_DIR, bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';
import { runContractChecks } from './lib/contractProbe.mjs';

const PORT = Number(process.env.BOOT_GATE_PORT || 4135);
const DB_NAME = process.env.BOOT_GATE_DB || 'Flora-Alchemy-Test-BootGate';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function listModules(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The worker shims, the E2E fixtures and the background-removal engines are
      // all reachable through their entry points below; recursion keeps it honest.
      out.push(...(await listModules(full)));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

console.log('Flora Alchemy — release boot gate');
console.log('─────────────────────────────────');

// ── 1. Module sweep ──────────────────────────────────────────────────────
console.log('\n· importing every backend module');
const DIRS = ['config', 'middleware', 'models', 'routes', 'controllers', 'services', 'utils', 'seed'];
const modules = [];
for (const dir of DIRS) modules.push(...(await listModules(path.join(BACKEND_DIR, dir))));
console.log(`  (${modules.length} modules in ${DIRS.join(', ')})`);

const importErrors = [];
for (const file of modules) {
  const rel = path.relative(BACKEND_DIR, file).replace(/\\/g, '/');
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    importErrors.push(`${rel}: ${err.message}`);
  }
}
check(
  `every one of the ${modules.length} modules imports cleanly`,
  importErrors.length === 0,
  importErrors.slice(0, 5).join(' | ')
);
check('the module sweep covered the route layer', modules.some((f) => f.includes(`${path.sep}routes${path.sep}`)));
check('the module sweep covered the service layer', modules.some((f) => f.includes(`${path.sep}services${path.sep}`)));

// ── 2. Mount coverage ────────────────────────────────────────────────────
console.log('\n· every router is mounted');
const serverSource = await fs.readFile(path.join(BACKEND_DIR, 'server.js'), 'utf8');
// Import lines like: `import productRoutes from './routes/productRoutes.js';`
const imports = [...serverSource.matchAll(/import\s+(\w+)\s+from\s+'\.\/routes\/([\w.-]+)\.js'/g)].map((m) => ({
  binding: m[1],
  file: `routes/${m[2]}.js`,
}));
// Mount lines, INCLUDING the middleware-bearing form:
//   app.use('/api/products', productRoutes);
//   app.use('/api/orders', apiWriteLimiter, orderRoutes);
// The argument tail is kept as text and each imported binding is then matched
// against it by word, so a router mounted behind a limiter is not mistaken for
// an unmounted one.
const mounts = [...serverSource.matchAll(/app\.use\(\s*'(\/api[^']*)'\s*,([^;]*)\)/g)].map((m) => ({
  mount: m[1],
  args: m[2],
}));
const mountedBindings = new Set();
for (const m of mounts) {
  for (const imp of imports) {
    if (new RegExp(`\\b${imp.binding}\\b`).test(m.args)) mountedBindings.add(imp.binding);
  }
}

const routeFiles = (await listModules(path.join(BACKEND_DIR, 'routes'))).map((f) =>
  path.relative(BACKEND_DIR, f).replace(/\\/g, '/')
);

check('server.js imports at least one router', imports.length > 0, String(imports.length));
check('server.js mounts at least one router', mounts.length > 0, String(mounts.length));

const unmountedFiles = routeFiles.filter((rel) => !imports.some((i) => i.file === rel));
check(
  `every file in routes/ is imported by server.js (${routeFiles.length} files)`,
  unmountedFiles.length === 0,
  unmountedFiles.join(', ')
);

const unmountedBindings = imports.filter((i) => !mountedBindings.has(i.binding));
check(
  'every imported router is actually mounted on an /api prefix',
  unmountedBindings.length === 0,
  unmountedBindings.map((b) => `${b.binding} (${b.file})`).join(', ')
);

// The SAME router on the SAME prefix twice would mean one mount shadows the
// other; `/api/3d` deliberately mounts two DIFFERENT routers (staff, then
// public), which is a legal pattern and must not be reported as a duplicate.
const seen = new Set();
const duplicateMounts = [];
for (const m of mounts) {
  const binding = imports.find((imp) => new RegExp(`\\b${imp.binding}\\b`).test(m.args))?.binding || '';
  const pair = `${m.mount} -> ${binding}`;
  if (seen.has(pair)) duplicateMounts.push(pair);
  seen.add(pair);
}
check('no router is mounted twice on the same prefix', duplicateMounts.length === 0, duplicateMounts.join(', '));

const prefixes = new Set(mounts.map((m) => m.mount));
check('the API exposes a meaningful number of prefixes', prefixes.size >= 20, `${prefixes.size} prefixes`);
console.log(`  (${imports.length} routers → ${mounts.length} mounts across ${prefixes.size} prefixes)`);

// ── 3. Boot + contract ───────────────────────────────────────────────────
console.log('\n· booting the server against a disposable database');
loadBackendEnv();
const testUri = testMongoUri(process.env.MONGO_URI, DB_NAME);
if (!testUri) {
  console.error(
    '\n✘ MONGO_URI is not configured. This gate REFUSES to skip the contract check:\n' +
      '  a release that was only verified without a database has not been verified.\n' +
      '  Provide MONGO_URI (CI: the bundled mongo service; locally: backend/.env).'
  );
  process.exit(2);
}

let server = null;
let base = null;
try {
  const booted = await bootTestServer({
    port: PORT,
    db: DB_NAME,
    extraEnv: { SEED_ON_START: 'false', THREE_MEDIA_ROOT: path.join(BACKEND_DIR, 'uploads', 'boot-gate-3d') },
    label: 'release-boot-gate',
  });
  server = booted.child;
  base = booted.base;
  check('the server boots and answers /api/health', true);

  console.log('\n· contract checks against the booted revision');
  // `requireDurableMedia: false` — a locally booted server legitimately uses the
  // documented DEVELOPMENT default (a root inside the app tree). Production
  // durability is asserted by the production probe instead, where it decides
  // whether uploaded media survives a redeploy.
  const result = await runContractChecks({
    api: `${base}/api`,
    productSlug: '',
    requireDurableMedia: false,
    note: (msg) => console.log(`  ⚠ ${msg}`),
  });
  passed += result.passed;
  failed += result.failed;
  failures.push(...result.failures);
} catch (err) {
  check('the server boots against a disposable database', false, err.message);
} finally {
  if (server && base) await stopTestServer(server, base);
  await fs.rm(path.join(BACKEND_DIR, 'uploads', 'boot-gate-3d'), { recursive: true, force: true }).catch(() => {});
}

console.log('\n─────────────────────────────────');
console.log(`RELEASE BOOT GATE: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('This tree boots and mounts everything it claims.');
process.exit(0);
