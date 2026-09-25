/**
 * Phase 16 — full test orchestrator.
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
 * Exit code is non-zero if ANY suite fails.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Deterministic order: fast functional suites first, security last (it
// deliberately exhausts its own server's login rate limiter).
const SUITES = [
  { name: 'Pricing', script: 'scripts/custom-gift-pricing-test.mjs', summary: /PRICING TEST: (\d+) passed, (\d+) failed/ },
  { name: 'API', script: 'scripts/api-smoke.mjs', summary: /SMOKE RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Integration', script: 'scripts/integration-smoke.mjs', summary: /INTEGRATION RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Payment', script: 'scripts/payment-smoke.mjs', summary: /PAYMENT SMOKE RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Conversation', script: 'scripts/conversation-smoke.mjs', summary: /CONVERSATION SMOKE RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Provisioning', script: 'scripts/provisioning-smoke.mjs', summary: new RegExp('PROVISIONING RESULT: (\\d+) passed, (\\d+) failed') },
  { name: 'Security', script: 'scripts/security-smoke.mjs', summary: /SECURITY RESULT: (\d+) passed, (\d+) failed/ },
  { name: 'Production', script: 'scripts/production-smoke.mjs', summary: /Production Smoke: (\d+) passed, (\d+) failed/ },
];

const results = [];
let anyFailed = false;

console.log('Flora Alchemy — full backend QA run (each suite: isolated server + dedicated test DB)\n');

for (const suite of SUITES) {
  console.log(`▶ ${suite.name} (${suite.script})`);
  const r = spawnSync(process.execPath, [suite.script], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const m = output.match(suite.summary);
  const passed = m ? Number(m[1]) : 0;
  const failed = m ? Number(m[2]) : 0;
  const ok = r.status === 0 && !anyFailed ? true : r.status === 0;

  if (r.status !== 0) {
    anyFailed = true;
    // Show the tail so the failing assertions are visible without re-running.
    const tail = output.trim().split('\n').slice(-25).join('\n');
    console.error(tail);
    console.error(`✘ ${suite.name} — FAILED (exit ${r.status})\n`);
  } else {
    console.log(`✔ ${suite.name} — ${passed} passed, ${failed} failed\n`);
  }

  results.push({ name: suite.name, passed, failed, status: r.status === 0 ? 'PASS' : 'FAIL' });
}

console.log('══════════════════════════════════════');
console.log('SUITE SUMMARY');
for (const r of results) {
  console.log(`  ${r.status === 'PASS' ? '✔' : '✘'} ${r.name.padEnd(14)} PASS ${r.passed}  FAIL ${r.failed}`);
}
const totalPass = results.reduce((a, r) => a + r.passed, 0);
const totalFail = results.reduce((a, r) => a + r.failed, 0);
console.log(`  ────────────────────────────────`);
console.log(`  TOTAL           PASS ${totalPass}  FAIL ${totalFail}`);

if (anyFailed) {
  console.log('\nFULL RUN: FAILED');
  process.exit(1);
}
console.log('\nFULL RUN: ALL SUITES PASSED');
