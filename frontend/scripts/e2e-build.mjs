/**
 * PHASE 4 — build the bundle the E2E suite drives.
 *
 * WHY THIS EXISTS
 * ---------------
 * `frontend/.env` is configured for the DEPLOYED app: VITE_API_URL points at
 * https://flora-alchemy.onrender.com/api. That is correct for a normal build,
 * and it is dangerous for a browser gate — `npm run build && playwright test`
 * would point the suite's browser at PRODUCTION, where checkout creates real
 * orders for real staff and decrements real stock.
 *
 * So the E2E build does not read that value: it forces the loopback API origin
 * (the isolated backend `e2e/stack.mjs` boots), and `e2e/stack.mjs` then
 * re-verifies the emitted bundle before it starts anything, so a stale or
 * hand-built dist can never be used to run the suite against a live API.
 *
 * Cross-platform on purpose (no inline `VAR=value cmd`, which cmd.exe cannot
 * run) and dependency-free: it invokes the installed Vite binary directly.
 *
 *   npm run build:e2e      # build only
 *   npm run test:e2e       # build, then Playwright
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const API_PORT = process.env.E2E_API_PORT || '4000';
const API_ORIGIN = process.env.E2E_API_ORIGIN || `http://127.0.0.1:${API_PORT}/api`;

/* The PAYMENT key is blanked alongside the API origin, for the same reason the
   stack blanks the server-side Razorpay credentials: `frontend/.env` carries a
   sandbox key id, so a normal build tells the checkout UI that a gateway is
   connected while the E2E backend has none. The two would disagree — the UI
   would offer "Pay ₹X" and try to open Razorpay, and the server would refuse
   with PAYMENT_NOT_CONFIGURED — and the suite would be exercising a state no
   deployment has. Unconfigured on both sides is the honest state: the checkout
   records the documented Sample payment status and no charge can be attempted. */
const BLANKED_BUILD_ENV = { VITE_RAZORPAY_KEY_ID: '' };

const viteBin = path.join(FRONTEND_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

console.log(`[e2e-build] building the E2E bundle against ${API_ORIGIN} (payment gateway disabled)`);

const result = spawnSync(process.execPath, [viteBin, 'build'], {
  cwd: FRONTEND_DIR,
  stdio: 'inherit',
  env: { ...process.env, VITE_API_URL: API_ORIGIN, ...BLANKED_BUILD_ENV },
});

if (result.error) {
  console.error(`[e2e-build] could not run vite: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
