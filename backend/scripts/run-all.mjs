/**
 * Phase 16 — full test orchestrator.
 * Phase 4 — timeout classification, elapsed timing and a re-run filter.
 *
 * Runs every backend suite in a fixed, deterministic order. Each suite boots
 * its own isolated backend process against its own dedicated MongoDB test
 * database, so:
 *   - suites cannot pollute each other (inventory, users, rate limits)
 *   - the security suite's intentional login-limiter exhaustion stays
 *     contained inside its own server process
 *   - the development database is never touched
 *
 * Prerequisites: Node 18+, network access to the MongoDB cluster configured
 * in backend/.env (MONGO_URI). No dev server needed. Real Razorpay
 * credentials are NOT required (payment suite uses an internal mock; the
 * live-credentials suite is skipped unless RAZORPAY_KEY_ID/SECRET are set).
 *
 * WHY PHASE 4 CHANGED THIS FILE
 * ----------------------------
 * A killed suite used to be indistinguishable from a failing one (both exited
 * non-zero), so a run that lost 13 suites to the per-suite cap read as "13
 * failures" and a green-looking summary could hide a suite that never executed
 * a single assertion. Every suite now reports one of four explicit states:
 *
 *   PASS                 exited 0
 *   FAIL                 exited non-zero with its own summary line present
 *   ENVIRONMENTAL/TIMEOUT the cap killed it (or the spawn itself failed)
 *   CAPACITY             MongoDB refused to create collections (cluster cap)
 *   NOT RUN              never attempted (only in --only mode, for the rest)
 *
 * Elapsed time is printed per suite, and TIMEOUT is never folded into FAIL.
 * Timeouts are not raised automatically to make a run look green: a suite that
 * hits the cap has to be re-run on its own and explained.
 *
 * WHY THE ORCHESTRATOR NOW RECLAIMS DATABASES
 * -------------------------------------------
 * Every suite leaves its own `Flora-Alchemy-Test-*` database behind (~22
 * collections). The shared cluster caps a project at 500 COLLECTIONS, so a full
 * 30-suite run needs ~660 and the last third dies with
 * "cannot create a new collection -- already using 500 collections of 500" — a
 * capacity outcome that used to be reported as an ENVIRONMENTAL/TIMEOUT and read
 * by a human as a regression. After each suite the orchestrator therefore
 * re-runs `scripts/db-footprint.mjs --drop-leftovers`, which only ever drops
 * databases carrying a disposable marker and never touches `Flora-Alchemy`
 * production, `flora_alchemy_dev`, or the E2E database. Pass
 * `--keep-databases` to inspect a suite's data afterwards.
 *
 * A cap hit is now classified `CAPACITY`, separately from a timeout, so the two
 * are never confused again.
 *
 * Usage:
 *   node scripts/run-all.mjs                       # every suite
 *   node scripts/run-all.mjs --only=API,Payment    # serial re-run of a subset
 *   node scripts/run-all.mjs --timeout=600         # per-suite cap (seconds)
 *   node scripts/run-all.mjs --keep-databases      # do not reclaim test DBs
 *
 * Exit code is non-zero if ANY suite did not pass.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Deterministic order: fast functional suites first, security last (it
// deliberately exhausts its own server's login rate limiter).
const SUITES = [
  { name: 'Environment Guard', script: 'scripts/environment-guard-smoke.mjs', summary: /ENVIRONMENT GUARD RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Pricing', script: 'scripts/custom-gift-pricing-test.mjs', summary: /PRICING TEST: (\d+) passed, (\d+) failed/ },
  { name: 'API', script: 'scripts/api-smoke.mjs', summary: /SMOKE RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Integration', script: 'scripts/integration-smoke.mjs', summary: /INTEGRATION RESULT: (\d+) passed, (\d+) failed/ },
  // Phase 10 — these four suites existed, passed, and were never RUN by this
  // orchestrator: `npm test` covered 25 of 29 executable suites, so a
  // regression in marketplace identity, shop services, checkout ownership or
  // the custom-request workflow could ship without anything going red. They are
  // ordinary isolated suites (own server, own Flora-Alchemy-Test-* database) and
  // belong in the sweep.
  { name: 'Marketplace', script: 'scripts/marketplace-identity-smoke.mjs', summary: /MARKETPLACE RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Shop Services', script: 'scripts/shop-services-smoke.mjs', summary: /SHOP-SERVICES RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Checkout', script: 'scripts/checkout-ownership-smoke.mjs', summary: /CHECKOUT RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Custom Request', script: 'scripts/custom-request-workflow-smoke.mjs', summary: /CUSTOM REQUEST WORKFLOW RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Payment', script: 'scripts/payment-smoke.mjs', summary: /PAYMENT SMOKE RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Conversation', script: 'scripts/conversation-smoke.mjs', summary: /CONVERSATION SMOKE RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Provisioning', script: 'scripts/provisioning-smoke.mjs', summary: new RegExp('PROVISIONING RESULT: (\\d+) passed, (\\d+) failed') },
  { name: 'Activation', script: 'scripts/activation-smoke.mjs', summary: /ACTIVATION RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Invitation Link', script: 'scripts/invitation-link-smoke.mjs', summary: /INVITATION LINK RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Staff Lifecycle', script: 'scripts/staff-lifecycle-smoke.mjs', summary: /STAFF LIFECYCLE RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Portal Auth', script: 'scripts/portal-auth-smoke.mjs', summary: /PORTAL AUTH RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Personnel Lifecycle', script: 'scripts/personnel-lifecycle-smoke.mjs', summary: /PERSONNEL LIFECYCLE RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Application Flow', script: 'scripts/application-flow-smoke.mjs', summary: /APPLICATION FLOW RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Tenant Core', script: 'scripts/tenant-core-smoke.mjs', summary: /TENANT CORE RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Tenant Matrix', script: 'scripts/tenant-matrix-smoke.mjs', summary: /TENANT MATRIX RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Admin Onboarding', script: 'scripts/admin-onboarding-smoke.mjs', summary: /ONBOARDING RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Staff Permissions', script: 'scripts/staff-permissions-smoke.mjs', summary: /STAFF PERMISSIONS RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Action Center', script: 'scripts/staff-action-center-smoke.mjs', summary: /STAFF ACTION CENTER RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Legacy Backfill', script: 'scripts/legacy-backfill-smoke.mjs', summary: /LEGACY BACKFILL RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Reference Studio', script: 'scripts/reference-image-smoke.mjs', summary: /REFERENCE STUDIO RESULT: (\d+) passed, (\d+) failed/ },
  { name: '3D Studio', script: 'scripts/3d-studio-smoke.mjs', summary: /3D STUDIO RESULT: (\d+) passed, (\d+) failed/ },
  { name: '3D Worker Provider', script: 'scripts/3d-worker-provider-smoke.mjs', summary: /3D WORKER RESULT: (\d+) passed, (\d+) failed/ },
  // Remote GPU agent — the machine protocol, lease machinery and the deferred
  // result pipeline against a REAL booted backend (own port, own database).
  { name: '3D GPU Agent', script: 'scripts/3d-agent-smoke.mjs', summary: /3D AGENT RESULT: (\d+) passed, (\d+) failed/ },
  // R2 object storage — the driver behind both private media roots, against a
  // local SigV4-verifying S3 mock (no database, no cloud account).
  { name: 'Supabase Storage', script: 'scripts/supabase-storage-smoke.mjs', summary: /SUPABASE STORAGE RESULT: (\d+) passed, (\d+) failed/ },
  // Media storage: the roots themselves (absolute/CWD-independent), a typed
  // storage failure instead of a generic 500, honest asset presence, scoped
  // cleanup and the migration utility.
  { name: 'Media Storage', script: 'scripts/media-storage-smoke.mjs', summary: /MEDIA STORAGE RESULT: (\d+) passed, (\d+) failed/ },
  { name: '3D Quality', script: 'scripts/3d-quality-smoke.mjs', summary: /3D QUALITY RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Backup & Integrity', script: 'scripts/backup-smoke.mjs', summary: /BACKUP RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Security', script: 'scripts/security-smoke.mjs', summary: /SECURITY RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Production', script: 'scripts/production-smoke.mjs', summary: /Production Smoke: (\d+) passed, (\d+) failed/ },
];

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const timeoutArg = args.find((a) => a.startsWith('--timeout='));
const keepDatabases = args.includes('--keep-databases');

// The cluster cap message, matched exactly as MongoDB words it, so a capacity
// outcome is never mistaken for a product failure.
const CAPACITY_RE = /already using \d+ collections of \d+|cannot create a new collection/i;

/**
 * Drop this machine's finished-suite databases.
 *
 * Delegates to db-footprint.mjs rather than re-implementing a drop: that script
 * owns the safety rules — a target must match the suite pattern this repository
 * creates (or be named exactly with --allow=), production/dev/E2E/configured
 * names are never dropped, and every drop is printed. A second implementation
 * of "which databases are safe to delete" is precisely the duplication this
 * codebase avoids.
 */
function reclaimTestDatabases() {
  const r = spawnSync(process.execPath, ['scripts/db-footprint.mjs', '--drop-leftovers'], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const freed = (r.stdout || '').match(/Dropped (\d+) disposable databases/);
  if (freed && Number(freed[1]) > 0) {
    console.log(`  · reclaimed ${freed[1]} test database(s) (cluster collection cap)\n`);
  } else if (r.status !== 0) {
    // Never fail the run over cleanup; report it so the next cap hit is explainable.
    console.warn(`  · could not reclaim test databases (exit ${r.status}) — see npm run db:footprint\n`);
  }
}

const only = onlyArg
  ? onlyArg
      .slice('--only='.length)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  : null;

const SUITE_TIMEOUT_MS = timeoutArg
  ? Math.max(30, Number(timeoutArg.slice('--timeout='.length))) * 1000
  : 5 * 60 * 1000;

const selected = only
  ? SUITES.filter((s) => only.includes(s.name.toLowerCase()) || only.some((o) => s.script.toLowerCase().includes(o)))
  : SUITES;

if (only && selected.length === 0) {
  console.error(`No suite matched --only=${onlyArg.slice('--only='.length)}`);
  console.error(`Known suites: ${SUITES.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

const fmtSeconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

const results = [];

console.log('Flora Alchemy — full backend QA run (each suite: isolated server + dedicated test DB)');
console.log(`Per-suite cap: ${SUITE_TIMEOUT_MS / 1000}s${only ? ` · subset: ${selected.map((s) => s.name).join(', ')}` : ''}\n`);

for (const suite of selected) {
  console.log(`▶ ${suite.name} (${suite.script})`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [suite.script], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    timeout: SUITE_TIMEOUT_MS,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const elapsedMs = Date.now() - started;

  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const m = output.match(suite.summary);
  const passed = m ? Number(m[1]) : 0;
  const failed = m ? Number(m[2]) : 0;

  let status;
  if (r.error) {
    // spawnSync reports a killed child as an error (ETIMEDOUT) rather than a
    // status; that is an environment/cap outcome, not an assertion failure.
    status = 'ENVIRONMENTAL/TIMEOUT';
  } else if (r.status === 0) {
    status = 'PASS';
  } else if (!m) {
    // Non-zero with no summary line: the suite died before reporting — a boot
    // failure, a port clash or a crash. Also environmental, not a red assert.
    status = 'ENVIRONMENTAL/TIMEOUT';
  } else {
    status = 'FAIL';
  }

  // A cap hit is not a timeout: the suite never got to run its assertions, and the
  // fix is cleanup, not a bigger per-suite limit.
  const capacity = CAPACITY_RE.test(output);
  if (capacity) status = 'CAPACITY';

  if (status === 'PASS') {
    console.log(`✔ ${suite.name} — ${passed} passed, ${failed} failed · ${fmtSeconds(elapsedMs)}\n`);
  } else {
    const tail = output.trim().split('\n').slice(-25).join('\n');
    console.error(tail);
    if (status === 'FAIL') {
      console.error(`✘ ${suite.name} — FAIL (exit ${r.status}) · ${fmtSeconds(elapsedMs)}\n`);
    } else if (status === 'CAPACITY') {
      console.error(
        `✘ ${suite.name} — CAPACITY (cluster collection cap reached) · ${fmtSeconds(elapsedMs)}\n` +
          `  This is NOT a test failure: MongoDB refused to create collections.\n` +
          `  Free space first, then re-run this suite alone:\n` +
          `    node scripts/db-footprint.mjs                 # see the footprint (read-only)\n` +
          `    node scripts/db-footprint.mjs --drop-leftovers\n` +
          `    node scripts/run-all.mjs --only="${suite.name}"\n`
      );
    } else {
      console.error(
        `⚠ ${suite.name} — ${status} after ${fmtSeconds(elapsedMs)}` +
          `${r.error ? ` (${r.error.code || r.error.message})` : ` (exit ${r.status}, no summary line)`}\n` +
          `  Re-run it on its own and explain it before treating this run as a result:\n` +
          `    node scripts/run-all.mjs --only="${suite.name}"\n`
      );
    }
  }

  results.push({ name: suite.name, passed, failed, status, elapsedMs });

  // Sequential, so nothing this suite created can belong to the next one.
  // Skipped for the last suite only when --keep-databases is explicit.
  if (!keepDatabases) reclaimTestDatabases();
}

const totalPass = results.reduce((a, r) => a + r.passed, 0);
const totalFail = results.reduce((a, r) => a + r.failed, 0);
const byStatus = (s) => results.filter((r) => r.status === s).length;

console.log('══════════════════════════════════════');
console.log('SUITE SUMMARY');
for (const r of results) {
  const glyph = r.status === 'PASS' ? '✔' : r.status === 'FAIL' || r.status === 'CAPACITY' ? '✘' : '⚠';
  console.log(
    `  ${glyph} ${r.name.padEnd(20)} ${r.status.padEnd(22)} PASS ${String(r.passed).padEnd(4)} FAIL ${String(r.failed).padEnd(4)} ${fmtSeconds(r.elapsedMs)}`
  );
}
console.log('  ────────────────────────────────');
console.log(`  TOTAL PASS ${totalPass}  FAIL ${totalFail}`);
console.log(
  `  ${byStatus('PASS')} pass · ${byStatus('FAIL')} fail · ${byStatus('ENVIRONMENTAL/TIMEOUT')} environmental/timeout` +
    (byStatus('CAPACITY') ? ` · ${byStatus('CAPACITY')} capacity-blocked` : '') +
    (only ? ` · ${SUITES.length - selected.length} not run (subset)` : '')
);

if (byStatus('FAIL') > 0 || byStatus('ENVIRONMENTAL/TIMEOUT') > 0 || byStatus('CAPACITY') > 0) {
  console.log('\nFULL RUN: NOT GREEN — see the per-suite states above.');
  process.exit(1);
}
console.log('\nFULL RUN: ALL SUITES PASSED');
