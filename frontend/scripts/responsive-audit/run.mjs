/*
 * Flora Alchemy — responsive audit runner (Phase 20.6.5).
 *
 * Builds the frontend (unless --no-build), serves dist with the audit probe
 * injected, and drives headless Chrome over CDP across the viewport × route
 * × theme matrix. Viewports are applied with Emulation.setDeviceMetricsOverride
 * (Chrome clamps --window-size to ~500px, which would silently skip every
 * phone breakpoint). Each run's decoded probe JSON lands in results/<stamp>/.
 *
 *   node frontend/scripts/responsive-audit/run.mjs [--no-build] [--only=<substr>]
 *
 * Exit code 1 when any run has horizontal overflow, a JS error, a harness
 * failure, or a hard (sub-24px) touch target on a phone viewport.
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const DIST = resolve(ROOT, 'frontend/dist');
const PORT = Number(process.env.AUDIT_PORT || 4611);
const BASE = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const skipBuild = argv.includes('--no-build');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;

/* ─────────────────────────── viewport matrix ─────────────────────────── */

const VIEWPORTS = [
  { name: '320x568', w: 320, h: 568 },
  { name: '360x640', w: 360, h: 640 },
  // PHASE 3 §38 — the contract viewport list starts at 360x800. 360x640 is
  // kept too (shorter height is a stricter fold check at the same width).
  { name: '360x800', w: 360, h: 800 },
  { name: '375x667', w: 375, h: 667 },
  { name: '390x844', w: 390, h: 844 },
  { name: '393x727', w: 393, h: 727 },
  { name: '412x892', w: 412, h: 892 },
  { name: '430x932', w: 430, h: 932 },
  { name: '640x800-zoom200', w: 640, h: 800 },
  { name: '768x1024', w: 768, h: 1024 },
  { name: '820x1180', w: 820, h: 1180 },
  { name: '1024x768', w: 1024, h: 768 },
  { name: '1280x800', w: 1280, h: 800 },
  { name: '1440x900', w: 1440, h: 900 },
];

const DARK_VIEWPORTS = [320, 390, 768, 1440];
const STATE_VIEWPORTS = [320, 360, 390, 768, 1024, 1280];
const MENU_VIEWPORTS = [320, 360, 390, 430];

/* ───────────────────────────── route matrix ──────────────────────────── */

const BASE_ROUTES = [
  { id: 'login', path: '/admin/login?seed=0' },
  // Phase 21.8 — the three portal logins + the Access Gateway.
  { id: 'login-owner', path: '/owner/login?seed=0' },
  { id: 'login-staff', path: '/staff/login?seed=0' },
  { id: 'gateway', path: '/access?seed=0' },
  // Phase 21.8 — OWNER PORTAL surfaces.
  { id: 'owner-dir', path: '/owner/administrators' },
  // A plain administrator reaching for the Owner Portal area gets the Owner
  // Access Required dossier — never the owner console.
  { id: 'owner-dir-plain', path: '/owner/administrators?role=plainadmin', expect: 'owner-gate' },
  { id: 'owner-home', path: '/owner/dashboard' },
  { id: 'owner-applications', path: '/owner/applications' },
  { id: 'owner-invitations', path: '/owner/invitations' },
  { id: 'owner-staff-dir', path: '/owner/staff' },
  // Phase 21.8 — STAFF PORTAL surface.
  { id: 'staff-home', path: '/staff/dashboard?role=handler' },
  { id: 'staff-orders', path: '/staff/orders?role=handler' },
  { id: 'staff-inventory', path: '/staff/inventory?role=handler' },
  { id: 'staff-owner-denied', path: '/owner/administrators?role=handler' },
  // Phase 21.12 — mirrored staff workspace surfaces (shared components behind
  // /staff URLs) + the tabbed Inventory workspace states.
  { id: 'staff-products', path: '/staff/products?role=handler' },
  { id: 'staff-customers', path: '/staff/customers?role=handler' },
  { id: 'staff-conversations', path: '/staff/conversations?role=handler' },
  { id: 'staff-custom-requests', path: '/staff/custom-requests?role=handler' },
  { id: 'staff-analytics', path: '/staff/analytics?role=handler' },
  { id: 'staff-order-new', path: '/staff/orders/new?role=handler' },
  { id: 'staff-inventory-history', path: '/staff/inventory/history?role=handler' },
  { id: 'staff-inventory-low', path: '/staff/inventory?tab=low&role=handler' },
  { id: 'staff-inventory-history-tab', path: '/staff/inventory?tab=history&role=handler' },
  { id: 'dashboard', path: '/admin/dashboard' },
  { id: 'dashboard-handler', path: '/admin/dashboard?role=handler' },
  // Phase 20.6.6 — plain administrator (isOwner:false) keeps the non-owner
  // portal home + role-scoped nav covered now that owners get their own.
  { id: 'dashboard-admin', path: '/admin/dashboard?role=plainadmin' },
  // Phase 21.12 — admin-side operational surfaces touched by the nav/IA work.
  { id: 'admin-products', path: '/admin/products' },
  { id: 'admin-customers', path: '/admin/customers' },
  { id: 'admin-conversations', path: '/admin/conversations' },
  { id: 'inventory-overview', path: '/admin/inventory' },
  { id: 'inventory-low', path: '/admin/inventory?tab=low' },
  { id: 'inventory-products', path: '/admin/inventory?tab=products' },
  { id: 'inventory-history', path: '/admin/inventory?tab=history' },
  { id: 'staff', path: '/admin/staff' },
  { id: 'staff-handler', path: '/admin/staff?role=handler' },
  { id: 'invitations', path: '/admin/invitations' },
  { id: 'access', path: '/admin/access' },
  { id: 'activate-step1', path: '/admin/activate/audit-token' },
  { id: 'activate-step2', path: '/admin/activate/audit-token?actions=accept' },
  // Phase 22.4 — ADMIN activation: workspace identity on the landing + the
  // editable workspace-address field in the password step.
  { id: 'activate-admin-step1', path: '/admin/activate/audit-admin-token' },
  { id: 'activate-admin-step2', path: '/admin/activate/audit-admin-token?actions=accept' },
  // Phase 22.4 — public workspace address (resolver gate + shop identity).
  { id: 'shop-workspace', path: '/shops/devika-preserves', expect: 'shop-catalogue' },
  // Phase 23 — CATALOGUE CONSISTENCY: the legacy storefront must render on a
  // direct load, and — the regression that shipped the empty catalogue — after
  // a client-side hop from /shops/:slug, whose route plan hydrates no global
  // slices at all.
  { id: 'shop-plain', path: '/shop?seed=0', expect: 'shop-catalogue' },
  { id: 'shop-hop', path: '/shops/devika-preserves?seed=0&actions=hop-to-shop', expect: 'shop-catalogue' },
  // Phase 20.6.6 — owner console + application ledger + public intake.
  { id: 'owner-dashboard', path: '/admin/owner' },
  { id: 'applications', path: '/admin/applications' },
  { id: 'apply-admin', path: '/apply/admin' },
  // PHASE 3 §38 — the six conversion surfaces, run over the full viewport
  // matrix with `--only=p3-`. Product detail points at a slug the audit
  // probe's catalogue stub actually serves, so the gallery, purchase panel
  // and review layer all render real markup instead of a not-found state.
  { id: 'p3-product', path: '/product/pressed-flora-frame' },
  { id: 'p3-gift-finder', path: '/gift-finder' },
  { id: 'p3-custom-request', path: '/custom-request' },
  { id: 'p3-cart', path: '/cart' },
  { id: 'p3-checkout', path: '/checkout' },
  { id: 'p3-tracking', path: '/order-tracking' },
];

const STATE_ROUTES = [
  // Phase 21.8 — owner directory overlays: invitation dossier (Resend/Revoke),
  // administrator dossier + the suspension confirmation modal.
  { id: 'owner-dir-inv', path: '/owner/administrators?actions=owner-inv-dossier' },
  { id: 'owner-dir-admin', path: '/owner/administrators?actions=owner-admin-dossier', expect: 'dialog' },
  { id: 'owner-dir-suspend', path: '/owner/administrators?actions=owner-admin-dossier,owner-suspend' },
  { id: 'staff-dossier', path: '/admin/staff?actions=dossier' },
  { id: 'staff-suspend', path: '/admin/staff?actions=dossier,suspend' },
  { id: 'staff-drawer', path: '/admin/staff?actions=drawer' },
  { id: 'inv-revoke', path: '/admin/invitations?actions=revoke' },
  { id: 'access-add-op', path: '/admin/access?actions=addOperator' },
  // Phase 20.6.6 — dossier panel, approve (one-time link view), reject dialog.
  { id: 'app-dossier', path: '/admin/applications?actions=app-dossier' },
  { id: 'app-approve', path: '/admin/applications?actions=app-dossier,app-approve', expect: 'approve-success' },
  { id: 'app-reject', path: '/admin/applications?actions=app-dossier,app-reject', expect: 'reject-done' },
  { id: 'app-denied', path: '/admin/applications?role=plainadmin' },
  { id: 'apply-submit', path: '/apply/admin?actions=apply-submit' },
];

/*
 * Portal-context matrix (Phase 22.6).
 *
 * The portal a login URL names must be the portal the account works in. These
 * routes type a real identity into a real login form and assert the END STATE:
 * which portal the app entered, whether a mismatch was explained, and which
 * shell rendered (a refused sign-in must render NO portal shell at all).
 *
 * The last two drive an already-authenticated session straight at the other
 * portal's area — a URL can never be a way to change portal.
 */
const AUTH_VIEWPORTS = VIEWPORTS.filter((v) => [320, 390, 1440].includes(v.w));

const AUTH_ROUTES = [
  // The portal the identity belongs to.
  { id: 'auth-owner-owner', path: '/owner/login?seed=0&actions=login&as=owner', expect: 'owner-portal' },
  { id: 'auth-admin-admin', path: '/admin/login?seed=0&actions=login&as=admin', expect: 'admin-portal' },
  { id: 'auth-handler-staff', path: '/staff/login?seed=0&actions=login&as=handler', expect: 'staff-portal' },
  // A portal the identity does NOT belong to.
  { id: 'auth-owner-admin', path: '/admin/login?seed=0&actions=login&as=owner', expect: 'portal-mismatch' },
  { id: 'auth-admin-owner', path: '/owner/login?seed=0&actions=login&as=admin', expect: 'refused' },
  { id: 'auth-handler-admin', path: '/admin/login?seed=0&actions=login&as=handler', expect: 'refused' },
  { id: 'auth-owner-staff', path: '/staff/login?seed=0&actions=login&as=owner', expect: 'refused' },
  { id: 'auth-customer-staff', path: '/staff/login?seed=0&actions=login&as=customer', expect: 'refused' },
  // Direct navigation after authentication cannot cross a portal boundary.
  { id: 'auth-nav-owner-operational', path: '/admin/orders', expect: 'owner-portal' },
  { id: 'auth-nav-handler-admin', path: '/admin/staff?role=handler', expect: 'staff-portal' },
];

/*
 * Phase 23 — Staff Action Center matrix.
 *
 * These routes drive the handler workbench the way a handler does: filter the
 * queue by work CATEGORY (the six studio lanes are filters, not the extent of
 * the handler's work), filter by status, execute a real work-item mutation and
 * stop. The last three assert the FAILURE paths end to end — a stale work item
 * (404 ORDER_NOT_FOUND), a suspended operator (403 ACCOUNT_SUSPENDED, which
 * must never be reported as a connection problem) and a successful stock
 * movement.
 */
const WORK_VIEWPORTS = VIEWPORTS.filter((v) => [320, 390, 768, 1440].includes(v.w));

const WORK_ROUTES = [
  { id: 'staff-work-center', path: '/staff/work?role=handler', expect: 'work-center' },
  {
    id: 'staff-work-area',
    path: '/staff/work?role=handler&actions=work-filter-area&area=Packaging+%26+Keepsake+Boxes',
    expect: 'work-area:Packaging & Keepsake Boxes',
  },
  {
    id: 'staff-work-status',
    path: '/staff/work?role=handler&actions=work-filter-status&status=ready_to_dispatch',
    expect: 'work-status:ready_to_dispatch',
  },
  {
    id: 'staff-work-action',
    path: '/staff/work?role=handler&actions=work-advance&target=order:FA-1201',
    expect: 'work-action-ok',
  },
  {
    id: 'staff-work-stale',
    path: '/staff/work?role=handler&actions=work-advance&target=order:FA-1206',
    expect: 'work-action-stale',
  },
  {
    id: 'staff-work-movement',
    path: '/staff/work?role=handler&actions=work-movement&target=inventory:rose-keepsake-box',
    expect: 'work-movement-ok',
  },
  {
    id: 'staff-work-suspended',
    path: '/staff/work?role=handler&actions=work-movement&target=inventory:lavender-glass-vial',
    expect: 'work-action-suspended',
  },
];

const MENU_ROUTES = [
  { id: 'sidebar-open', path: '/admin/dashboard?actions=menu' },
  // Phase 21.8 — the owner portal drawer (its own nav set).
  { id: 'owner-sidebar-open', path: '/owner/administrators?actions=menu' },
];

function buildMatrix() {
  const runs = [];
  const add = (route, vp, dark) => {
    const id = `${route.id}__${vp.name}${dark ? '__dark' : ''}`;
    if (only && !id.includes(only)) return;
    runs.push({ id, route, vp, dark });
  };

  for (const r of BASE_ROUTES) for (const vp of VIEWPORTS) add(r, vp, false);
  for (const r of STATE_ROUTES) {
    for (const vp of VIEWPORTS) if (STATE_VIEWPORTS.includes(vp.w)) add(r, vp, false);
    add(r, VIEWPORTS.find((v) => v.w === 390), true); // dark modal state
  }
  for (const r of MENU_ROUTES) {
    for (const vp of VIEWPORTS) if (MENU_VIEWPORTS.includes(vp.w)) add(r, vp, false);
  }
  for (const r of AUTH_ROUTES) for (const vp of AUTH_VIEWPORTS) add(r, vp, false);
  for (const r of WORK_ROUTES) for (const vp of WORK_VIEWPORTS) add(r, vp, false);
  for (const r of BASE_ROUTES.filter((x) => x.id !== 'dashboard-handler' && x.id !== 'staff-handler')) {
    for (const w of DARK_VIEWPORTS) add(r, VIEWPORTS.find((v) => v.w === w), true);
  }
  return runs;
}

/* ─────────────────────────── chrome discovery ────────────────────────── */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'google-chrome',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findBrowser() {
  for (const c of CHROME_CANDIDATES) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c;
    } else {
      try {
        const which = process.platform === 'win32' ? 'where' : 'which';
        execFileSync(which, [c], { stdio: 'ignore' });
        return c;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/* ─────────────────────────── build + server ──────────────────────────── */

function build() {
  console.log('[run] npm run build …');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
}

function startServer() {
  const child = spawn(process.execPath, [join(__dirname, 'serve.mjs')], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', (d) => {
    if (process.env.AUDIT_DEBUG) process.stdout.write(String(d));
  });
  return child;
}

/**
 * Wait for OUR server — not merely for something answering on the port.
 *
 * A stale serve.mjs left over from an interrupted run keeps the port and
 * answers happily while serving the PROBE FROM MEMORY, i.e. the audit would
 * silently grade the app with last run's instrumentation. So: fail fast when
 * the child dies, and confirm the probe we are served is the probe on disk.
 */
/**
 * Stop the static server for real. On Windows `child.kill()` regularly leaves
 * the listener alive, and a leftover server then owns the port for the next
 * run — where it silently answers with the PREVIOUS probe from memory.
 */
function killServer(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  } catch { /* already gone */ }
}

async function waitForServer(timeoutMs, child) {
  const probe = readFileSync(join(__dirname, 'audit.js'), 'utf8');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      console.error(`[run] static server exited (code ${child.exitCode}) — port ${PORT} already in use?`);
      return false;
    }
    try {
      const res = await fetch(`${BASE}/`);
      const served = await fetch(`${BASE}/__audit.js`);
      if (res.ok && served.ok) {
        const body = await served.text();
        if (body === probe) return true;
        console.error(
          `[run] port ${PORT} is answering with a DIFFERENT audit probe — a leftover serve.mjs from an interrupted run owns the port.\n` +
            '       Stop that process (netstat -ano | findstr :' + PORT + ') and run again: grading with stale instrumentation is worse than not running.'
        );
        return false;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────── CDP client ───────────────────────────── */

function launchChrome(browser, profileDir) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const proc = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        `--user-data-dir=${profileDir}`,
        '--force-device-scale-factor=1',
        '--window-size=1440,900',
        '--remote-debugging-port=0',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* gone */ }
      rejectLaunch(new Error('chrome never exposed DevTools: ' + stderr.slice(0, 300)));
    }, 25000);

    proc.stderr.on('data', (d) => {
      stderr += d;
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolveLaunch({ proc, wsUrl: m[1] });
      }
    });
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectLaunch(e);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectLaunch(new Error(`chrome exited early (${code}): ${stderr.slice(0, 300)}`));
    });
  });
}

function cdpConnect(wsUrl) {
  return new Promise((resolveC, rejectC) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    let opened = false;

    const failAll = (why) => {
      for (const [, p] of pending) p.rej(new Error(why));
      pending.clear();
    };

    ws.onopen = () => {
      opened = true;
      resolveC({
        send(method, params, sessionId) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            pending.set(id, { res, rej });
            const msg = { id, method, params: params || {} };
            if (sessionId) msg.sessionId = sessionId;
            ws.send(JSON.stringify(msg));
          });
        },
        close() {
          try { ws.close(); } catch { /* already closed */ }
        },
      });
    };
    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(String(ev.data)); } catch { return; }
      if (data.id != null && pending.has(data.id)) {
        const { res, rej } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) rej(new Error(`${data.error.message}`));
        else res(data.result || {});
      }
      // events (Page.*, etc.) are ignored — the probe is polled instead.
    };
    ws.onerror = () => {
      if (!opened) rejectC(new Error('DevTools WebSocket error'));
      else failAll('DevTools WebSocket error');
    };
    ws.onclose = () => failAll('DevTools WebSocket closed');
  });
}

async function runBrowserCdp(browser, run, profileDir) {
  const url =
    `${BASE}${run.route.path}` +
    `${run.route.path.includes('?') ? '&' : '?'}dark=${run.dark ? '1' : '0'}`;

  const { proc, wsUrl } = await launchChrome(browser, profileDir);
  const cdp = await cdpConnect(wsUrl);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = (targetInfos || []).find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');

    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });

    // Exact viewport — Chrome's window manager clamps --window-size to ~500px,
    // which would silently disable every phone breakpoint.
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: run.vp.w,
        height: run.vp.h,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: run.vp.w,
        screenHeight: run.vp.h,
      },
      sessionId
    );
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);

    const deadline = Date.now() + 30000;
    let b64 = null;
    let lastErr = null;
    while (Date.now() < deadline) {
      await sleep(300);
      try {
        const r = await cdp.send(
          'Runtime.evaluate',
          { expression: "document.documentElement.getAttribute('data-audit')", returnByValue: true },
          sessionId
        );
        const v = r && r.result && r.result.value;
        if (v) { b64 = v; break; }
        const err = await cdp.send(
          'Runtime.evaluate',
          { expression: "document.documentElement.getAttribute('data-audit-error') || ''", returnByValue: true },
          sessionId
        );
        if (err && err.result && err.result.value) throw new Error(`publish failed: ${err.result.value}`);
      } catch (e) {
        lastErr = e;
        if (String(e.message).startsWith('publish failed')) throw e;
        // session may be mid-navigation — keep polling
      }
    }
    if (!b64) throw new Error(`timeout waiting for data-audit${lastErr ? ` (last: ${lastErr.message})` : ''}`);

    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } finally {
    cdp.close();
    try { proc.kill(); } catch { /* already gone */ }
  }
}

/* ───────────────────────────── evaluation ────────────────────────────── */

function evaluate(res) {
  const issues = [];
  if (res.harnessError) {
    issues.push({ level: 'fail', kind: 'harness', detail: res.harnessError });
    return issues;
  }
  const f = res.final;
  if (!f) {
    issues.push({ level: 'fail', kind: 'harness', detail: 'no final sample' });
    return issues;
  }
  if (res.errors && res.errors.length) {
    issues.push({ level: 'fail', kind: 'js-error', detail: res.errors.join(' | ').slice(0, 400) });
  }
  for (const o of f.overflow || []) {
    issues.push({
      level: 'fail',
      kind: 'overflow',
      detail: `${o.el} [left=${o.left} right=${o.right} w=${o.w} vw=${f.vw}] "${o.text}"`,
    });
  }
  for (const s of f.smallTargets || []) {
    issues.push({
      level: s.hard ? 'fail' : 'advisory',
      kind: s.hard ? 'touch-hard' : 'touch-small',
      detail: `${s.el} ${s.w}x${s.h}${s.inScroll ? ' (in scroll container)' : ''} "${s.text}"`,
    });
  }
  for (const c of f.clipped || []) {
    const worst = c.worst ? ` | offender: ${c.worst.el} (+${c.worst.spill}px) "${c.worst.text}"` : '';
    issues.push({
      level: 'advisory',
      kind: 'clipped',
      detail: `${c.el} scrollW=${c.scrollW} clientW=${c.clientW} delta=${c.delta} "${c.text.slice(0, 60)}"${worst}`,
    });
  }
  if (f.vw !== res.vp.w) {
    issues.push({ level: 'warn', kind: 'viewport', detail: `clientWidth=${f.vw} expected ${res.vp.w}` });
  }

  // ── declared flow outcome ─────────────────────────────────────────────
  // A route may declare what the flow it drives MUST end on. This is the
  // assertion that was missing when a click that worked and a route that
  // crashed both produced an identical, green run.
  const flowOut = res.flow || null;
  if (res.expect && flowOut) {
    if (flowOut.routeErrorBoundary) {
      // The boundary's own copy says nothing about WHY. React reports the
      // render failure through console.error, which the probe now captures.
      const why = (res.consoleErrors || []).find((m) => /Error/.test(m));
      issues.push({
        level: 'fail',
        kind: 'flow',
        detail: `route error boundary rendered — the page failed to render (expected ${res.expect})${
          why ? ` :: ${why.slice(0, 260)}` : ''
        }`,
      });
    }
    if (res.expect === 'dialog' && !flowOut.dialogRendered) {
      issues.push({ level: 'fail', kind: 'flow', detail: 'no [role="dialog"] rendered after the open action' });
    }
    if (res.expect === 'approve-success' && flowOut.approveState !== 'success') {
      issues.push({
        level: 'fail',
        kind: 'flow',
        detail: `approve did not reach its success state (data-approve-state=${flowOut.approveState || 'absent'})`,
      });
    }
    if (res.expect === 'reject-done' && flowOut.rejectDialogOpen) {
      issues.push({ level: 'fail', kind: 'flow', detail: 'reject dialog still open — the decision never settled' });
    }

    // ── portal context: the login URL must match the account's portal ────
    const login = flowOut.login || null;
    if (['owner-portal', 'admin-portal', 'staff-portal'].includes(res.expect)) {
      const want = res.expect.split('-')[0];
      const pathOk = String(flowOut.pathname || '').startsWith(`/${want}`);
      const shellOk = flowOut.portalShell === want;
      if (!pathOk || !shellOk) {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `expected the ${want} portal (path=${flowOut.pathname} shell=${flowOut.portalShell || 'none'})`,
        });
      }
    }
    if (res.expect === 'refused') {
      if (!login || !login.refused) {
        issues.push({ level: 'fail', kind: 'flow', detail: 'the wrong-portal sign-in was not refused' });
      }
      if (login && login.landedPath) {
        issues.push({ level: 'fail', kind: 'flow', detail: `a refused sign-in still navigated to ${login.landedPath}` });
      }
      if (flowOut.portalShell) {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `a portal shell rendered for a refused sign-in (${flowOut.portalShell})`,
        });
      }
    }
    if (res.expect === 'portal-mismatch') {
      if (!login || !login.sawMismatch) {
        issues.push({ level: 'fail', kind: 'flow', detail: 'no portal-mismatch notice was shown before the hand-over' });
      } else if (!/belongs to/.test(login.mismatchNotice) || !/Owner Portal/.test(login.mismatchNotice)) {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `the mismatch notice did not name the account's portal: "${login.mismatchNotice}"`,
        });
      }
      if (!login || !String(login.landedPath || '').startsWith('/owner')) {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `the owner was not handed to the Owner Portal (landed ${login && login.landedPath ? login.landedPath : 'nowhere'})`,
        });
      }
      if (flowOut.portalShell === 'admin') {
        issues.push({ level: 'fail', kind: 'flow', detail: 'the Administrator shell rendered for an owner account' });
      }
      // The notice lives on screen for ~2s, so the scheduled samples never see
      // it — the probe measures it the moment it appears.
      if (login && Array.isArray(login.mismatchOverflow) && login.mismatchOverflow.length) {
        issues.push({
          level: 'fail',
          kind: 'overflow',
          detail: `the portal-mismatch notice overflows: ${login.mismatchOverflow.join(' | ')}`.slice(0, 600),
        });
      }
    }
    // ── Staff Action Center (handler workbench) ──────────────────────────
    if (res.expect === 'work-center') {
      if (flowOut.workState !== 'ready') {
        issues.push({ level: 'fail', kind: 'flow', detail: `the work queue never became ready (state=${flowOut.workState})` });
      }
      if (!(flowOut.workCount > 0)) {
        issues.push({ level: 'fail', kind: 'flow', detail: `no work items rendered (count=${flowOut.workCount})` });
      }
      if ((flowOut.workAreas || []).some((a) => !a)) {
        issues.push({ level: 'fail', kind: 'flow', detail: 'a work item rendered without a work category' });
      }
    }
    if (typeof res.expect === 'string' && res.expect.startsWith('work-area:')) {
      const want = res.expect.slice('work-area:'.length);
      const areas = flowOut.workAreas || [];
      if (!areas.length) issues.push({ level: 'fail', kind: 'flow', detail: 'the category filter emptied the queue' });
      else if (areas.some((a) => a !== want)) {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `the category filter leaked other lanes: ${[...new Set(areas)].join(' | ')}`,
        });
      }
    }
    if (typeof res.expect === 'string' && res.expect.startsWith('work-status:')) {
      const want = res.expect.slice('work-status:'.length);
      const statuses = flowOut.workStatuses || [];
      if (!statuses.length) issues.push({ level: 'fail', kind: 'flow', detail: 'the status filter emptied the queue' });
      else if (statuses.some((s) => s !== want)) {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `the status filter leaked other states: ${[...new Set(statuses)].join(' | ')}`,
        });
      }
    }
    if (res.expect === 'work-action-ok') {
      if (flowOut.actionState !== 'success') {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `the work item action reported ${flowOut.actionState || 'nothing'} (${flowOut.actionFeedback || ''})`,
        });
      }
      if (!(flowOut.workStatuses || []).includes('confirmed')) {
        issues.push({ level: 'fail', kind: 'flow', detail: 'the advanced order did not re-render at its new stage' });
      }
    }
    if (res.expect === 'work-action-stale') {
      if (flowOut.actionState !== 'error') {
        issues.push({ level: 'fail', kind: 'flow', detail: 'a stale work item reported no failure at all' });
      }
      if (flowOut.actionCode !== 'ORDER_NOT_FOUND') {
        issues.push({ level: 'fail', kind: 'flow', detail: `the wrong failure surfaced (code=${flowOut.actionCode})` });
      }
      if (!/no longer available/i.test(flowOut.actionFeedback || '')) {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `the copy did not explain the stale work item: "${flowOut.actionFeedback || ''}"`,
        });
      }
    }
    if (res.expect === 'work-action-suspended') {
      if (flowOut.actionState !== 'error') {
        issues.push({ level: 'fail', kind: 'flow', detail: 'a suspended operator was not told the action failed' });
      }
      if (!/suspended/i.test(flowOut.actionFeedback || '')) {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `a suspension was not named in the feedback: "${flowOut.actionFeedback || ''}"`,
        });
      }
      if (/could not reach|connection problem|network/i.test(flowOut.actionFeedback || '')) {
        issues.push({ level: 'fail', kind: 'flow', detail: 'a suspended account was misreported as a connection problem' });
      }
    }
    if (res.expect === 'work-movement-ok') {
      if (flowOut.actionState !== 'success') {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `the stock movement reported ${flowOut.actionState || 'nothing'} (${flowOut.actionFeedback || ''})`,
        });
      } else if (!/recorded/i.test(flowOut.actionFeedback || '')) {
        issues.push({ level: 'fail', kind: 'flow', detail: 'no movement confirmation was shown' });
      }
    }

    if (res.expect === 'owner-gate') {
      if (!flowOut.ownerGate) {
        issues.push({ level: 'fail', kind: 'flow', detail: 'the Owner Access Required dossier did not render' });
      }
      if (flowOut.portalShell === 'owner') {
        issues.push({ level: 'fail', kind: 'flow', detail: 'the Owner console shell rendered for a non-owner session' });
      }
    }
    // ── Catalogue consistency (Phase 23) ────────────────────────────────
    // A catalogue surface (legacy /shop or /shops/:slug) must render product
    // cards and must NEVER show an empty state when the mock catalogue has
    // products — the exact regression behind "different browsers, different
    // catalogues".
    if (res.expect === 'shop-catalogue') {
      if (flowOut.shopEmpty) {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `the catalogue rendered its EMPTY state on ${flowOut.pathname} (${flowOut.shopShowLine || 'no product line'})`,
        });
      }
      if (!(flowOut.shopCards > 0)) {
        issues.push({
          level: 'fail',
          kind: 'flow',
          detail: `no product cards rendered on ${flowOut.pathname} (cards=${flowOut.shopCards})`,
        });
      }
    }
  }
  return issues;
}

/* ─────────────────────────────── main ────────────────────────────────── */

async function main() {
  if (!skipBuild) build();
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('[run] frontend/dist missing — build failed?');
    process.exit(1);
  }

  const browser = findBrowser();
  if (!browser) {
    console.error('[run] no Chrome/Edge found — set CHROME_PATH.');
    process.exit(1);
  }
  console.log(`[run] browser: ${browser}`);

  const matrix = buildMatrix();
  console.log(`[run] matrix: ${matrix.length} runs${only ? ` (only: ${only})` : ''}`);
  if (!matrix.length) {
    console.error('[run] nothing matched --only');
    process.exit(1);
  }

  const server = startServer();
  if (!(await waitForServer(15000, server))) {
    console.error('[run] static server did not come up');
    killServer(server);
    process.exit(1);
  }
  console.log('[run] server ready');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(__dirname, 'results', stamp);
  mkdirSync(outDir, { recursive: true });

  const profilesRoot = join(tmpdir(), `fa-audit-${process.pid}`);
  mkdirSync(profilesRoot, { recursive: true });

  const results = [];
  let idx = 0;
  const CONCURRENCY = 4;

  async function worker() {
    while (idx < matrix.length) {
      const my = idx++;
      const run = matrix[my];
      const profileDir = join(profilesRoot, String(my));
      mkdirSync(profileDir, { recursive: true });

      let res;
      try {
        res = await runBrowserCdp(browser, run, profileDir);
      } catch (e) {
        res = { harnessError: String(e && e.message ? e.message : e) };
      }
      res.id = run.id;
      res.vp = run.vp;
      res.route = run.route.id;
      res.dark = run.dark;
      res.expect = run.route.expect || null;
      res.issues = evaluate(res);
      results.push(res);

      const fails = res.issues.filter((i) => i.level === 'fail').length;
      process.stdout.write(
        `[${results.length}/${matrix.length}] ${run.id}${fails ? `  X ${fails} fail` : '  ok'}\n`
      );
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  killServer(server);
  try { rmSync(profilesRoot, { recursive: true, force: true }); } catch { /* best effort */ }

  // ── summary ──
  results.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(outDir, 'runs.json'), JSON.stringify(results, null, 2));

  const hardIssues = [];
  const advisories = [];
  const warns = [];
  for (const r of results) {
    for (const i of r.issues) {
      const line = `${r.id}: [${i.kind}] ${i.detail}`;
      if (i.level === 'fail') hardIssues.push(line);
      else if (i.level === 'warn') warns.push(line);
      else advisories.push(line);
    }
  }

  const lines = [];
  lines.push(`Responsive audit — ${new Date().toISOString()}`);
  lines.push(
    `runs: ${results.length}   fails: ${hardIssues.length}   advisories: ${advisories.length}   warns: ${warns.length}`
  );
  lines.push('');
  if (hardIssues.length) {
    lines.push('== FAILURES ==');
    hardIssues.forEach((l) => lines.push('  ' + l));
    lines.push('');
  }
  if (advisories.length) {
    lines.push('== ADVISORIES ==');
    advisories.forEach((l) => lines.push('  ' + l));
    lines.push('');
  }
  if (warns.length) {
    lines.push('== WARNINGS ==');
    warns.forEach((l) => lines.push('  ' + l));
    lines.push('');
  }
  lines.push('== overflow per viewport ==');
  for (const vp of VIEWPORTS) {
    const vpRuns = results.filter((r) => r.vp.w === vp.w);
    const ov = vpRuns.reduce(
      (n, r) => n + ((r.final && r.final.overflow && r.final.overflow.length) || 0),
      0
    );
    const sc = vpRuns.reduce(
      (n, r) => n + ((r.final && r.final.smallTargets && r.final.smallTargets.length) || 0),
      0
    );
    lines.push(
      `  ${vp.name.padEnd(20)} runs=${String(vpRuns.length).padStart(3)} overflow=${ov} smallTargets=${sc}`
    );
  }

  const summary = lines.join('\n');
  writeFileSync(join(outDir, 'summary.txt'), summary);
  console.log('\n' + summary);
  console.log(`[run] results: ${outDir}`);

  process.exit(hardIssues.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[run] fatal:', e);
  process.exit(1);
});
