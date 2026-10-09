/**
 * PHASE 4 — Playwright E2E configuration.
 *
 * Scope: the critical customer / staff journeys the launch gate names. The
 * suite runs against the REAL stack (isolated backend + the production bundle),
 * never a mocked API, and the app under test is the same artifact the deploy
 * ships.
 *
 *   npm run test:e2e                  # whole suite
 *   npm run test:e2e -- --grep FLOW   # a subset
 *
 * Browser: the locally installed Google Chrome (`channel: 'chrome'`). No
 * Playwright browser download is required, which keeps CI setup to a single
 * `npm ci` and means the suite exercises the same rendering engine the
 * customers use.
 *
 * Workers: 1. The suite deliberately shares one backend — checkout decrements
 * real stock and the order-status transitions are forward-only — so parallel
 * workers would race each other's inventory instead of proving anything.
 */

import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = Number(process.env.E2E_WEB_PORT || 4300);
const API_PORT = Number(process.env.E2E_API_PORT || 4000);
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e/specs',
  outputDir: './e2e/.artifacts',

  fullyParallel: false,
  workers: 1,

  /* A launch gate must not hide a flake behind a retry. */
  retries: 0,
  forbidOnly: !!process.env.CI,

  timeout: 120_000,
  /* The stack runs against the real cluster. Phase 4 measured the public
     catalogue endpoint spiking into the teens of seconds under concurrency
     (remote Atlas), so a 15s window produced false reds for correct requests.
     25s is the same ceiling the app itself now applies to critical hydration. */
  expect: { timeout: 25_000 },

  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e/.artifacts/results.json' }],
  ],

  use: {
    baseURL: BASE_URL,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    /* Deterministic geometry: the layouts under test are responsive, so the
       default window size must not drift between machines. */
    viewport: { width: 1280, height: 800 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },

  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],

  webServer: {
    command: 'node e2e/stack.mjs',
    url: `${BASE_URL}/`,
    cwd: import.meta.dirname,
    /* Boot (backend + provisioning + vite preview) plus the stack's own
       bounded retry must both fit inside this window. */
    timeout: 360_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { E2E_API_PORT: String(API_PORT), E2E_WEB_PORT: String(WEB_PORT) },
  },
});
