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
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  { id: 'dashboard', path: '/admin/dashboard' },
  { id: 'dashboard-handler', path: '/admin/dashboard?role=handler' },
  { id: 'staff', path: '/admin/staff' },
  { id: 'staff-handler', path: '/admin/staff?role=handler' },
  { id: 'invitations', path: '/admin/invitations' },
  { id: 'access', path: '/admin/access' },
  { id: 'activate-step1', path: '/admin/activate/audit-token' },
  { id: 'activate-step2', path: '/admin/activate/audit-token?actions=accept' },
];

const STATE_ROUTES = [
  { id: 'staff-dossier', path: '/admin/staff?actions=dossier' },
  { id: 'staff-suspend', path: '/admin/staff?actions=dossier,suspend' },
  { id: 'staff-drawer', path: '/admin/staff?actions=drawer' },
  { id: 'inv-revoke', path: '/admin/invitations?actions=revoke' },
  { id: 'access-add-op', path: '/admin/access?actions=addOperator' },
];

const MENU_ROUTES = [
  { id: 'sidebar-open', path: '/admin/dashboard?actions=menu' },
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

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return true;
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
  if (!(await waitForServer(15000))) {
    console.error('[run] static server did not come up');
    server.kill();
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

  try { server.kill(); } catch { /* already gone */ }
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
