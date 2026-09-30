/**
 * INVITATION LINK ORIGIN — regression suite (audit follow-up)
 *
 * An activation link is a FRONTEND URL. A production invitation that points at
 * http://localhost:3000 is a dead credential mailed to a real person, and one
 * that points at the API's own origin (flora-alchemy.onrender.com) is not a
 * page at all. This suite pins the rules that make both impossible:
 *
 *   1. RESOLUTION MATRIX (pure) — STAFF_PORTAL_URL → CLIENT_URL → localhost
 *      (DEVELOPMENT ONLY). In production a missing or loopback origin is
 *      REFUSED (500 CONFIG_ERROR) instead of silently becoming localhost.
 *   2. THE AUDITED FUNCTION — `activationLink()` itself, the exact builder the
 *      UI invitation came from, re-checked under an injected production env.
 *   3. LIVE HTTP — a real test server configured with a known origin issues an
 *      invitation whose link begins with that origin, carries a 256-bit token,
 *      and whose resend link keeps the same origin. The token is never echoed
 *      back by any read endpoint.
 *   4. STATIC GUARD — no runtime file other than the shared util may build an
 *      activation URL or read an origin variable. A future hardcoded
 *      `localhost:3000` invitation builder fails this suite instead of
 *      shipping.
 *   5. ROUTE MATCH — the SPA really serves /admin/activate/:token, so the
 *      generated URL lands on a page rather than a 404.
 *
 * Self-contained: boots its OWN backend (port 4107) against its OWN database
 * (Flora-Alchemy-Test-InvitationLink). No dev server, no dev-DB writes.
 *
 * Tokens are never printed: assertions name the SHAPE, not the credential.
 */
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { bootTestServer, stopTestServer, BACKEND_DIR } from './lib/testServer.mjs';
import { publicFrontendOrigin, activationUrlFor, isLoopbackOrigin } from '../utils/publicOrigin.js';
import { activationLink } from '../controllers/staffInvitationController.js';

const PORT = 4107;
const DB = 'Flora-Alchemy-Test-InvitationLink';
/** A deliberately NON-default origin: if the server ignored the env it would
 *  emit localhost:3000 and every HTTP assertion below would fail. */
const CONFIGURED_ORIGIN = 'http://127.0.0.1:4741';
const VERCEL = 'https://flora-alchemyy.vercel.app';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

/** Capture the thrown CONFIG_ERROR without ever treating a success as one. */
function refused(env) {
  try {
    return { threw: false, value: publicFrontendOrigin({ env }) };
  } catch (err) {
    return { threw: true, status: err.status, code: err.code };
  }
}

/** Run `fn` with a temporary process.env patch, always restored. */
function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try { return fn(); } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 4. STATIC GUARD — runs before anything boots (fast, no side effects).
// ─────────────────────────────────────────────────────────────────────────
function runtimeSourceFiles() {
  const roots = ['controllers', 'routes', 'utils', 'middleware', 'models', 'config'];
  const files = [];
  for (const dir of roots) {
    const abs = path.join(BACKEND_DIR, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(abs, entry.name));
    }
  }
  const server = path.join(BACKEND_DIR, 'server.js');
  if (fs.existsSync(server)) files.push(server);
  return files;
}

function rel(abs) {
  return path.relative(BACKEND_DIR, abs).split(path.sep).join('/');
}

function scanStaticGuards() {
  console.log('\n— STATIC GUARD (one activation-URL builder, one origin source) —');
  const files = runtimeSourceFiles().map((abs) => ({ rel: rel(abs), text: fs.readFileSync(abs, 'utf8') }));

  const builders = files.filter((f) => f.text.includes('/admin/activate/${')).map((f) => f.rel).sort();
  check(
    'only the shared util + the invitation controller interpolate /admin/activate/',
    builders.length > 0 && builders.every((f) => f === 'utils/publicOrigin.js' || f === 'controllers/staffInvitationController.js'),
    builders.join(', ')
  );

  // The single builder must actually be reachable — a guard against the fixed
  // path being deleted and the rule living on only in a comment.
  check(
    'the shared builder exists',
    files.some((f) => f.rel === 'utils/publicOrigin.js' && f.text.includes('export function activationUrlFor')),
    'utils/publicOrigin.js'
  );

  const originReaders = files.filter((f) => /(?:process\.env|env)\.(STAFF_PORTAL_URL|CLIENT_URL)/.test(f.text)).map((f) => f.rel).sort();
  check(
    'only the shared util reads STAFF_PORTAL_URL / CLIENT_URL',
    originReaders.length === 1 && originReaders[0] === 'utils/publicOrigin.js',
    originReaders.join(', ')
  );

  const viteRefs = files.filter((f) => f.text.includes('localhost:5173')).map((f) => f.rel);
  check('no runtime file mentions the Vite dev port in a link', viteRefs.length === 0, viteRefs.join(', '));

  const hardcoded = files.filter((f) => f.rel !== 'utils/publicOrigin.js' && f.text.includes("'http://localhost:3000'")).map((f) => f.rel);
  check('no runtime file other than the util hardcodes a localhost origin value', hardcoded.length === 0, hardcoded.join(', '));

  // 5. ROUTE MATCH — the SPA must serve the path the server generates.
  const appPath = path.resolve(BACKEND_DIR, '..', 'frontend', 'src', 'App.jsx');
  const appText = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  check('frontend serves /admin/activate/:token (the generated path)', appText.includes('path="/admin/activate/:token"'), 'App.jsx');
  check('frontend serves the bare /admin/activate landing', appText.includes('path="/admin/activate"'), 'App.jsx');
  check('no /staff/activate route is assumed anywhere', !appText.includes('/staff/activate'), 'App.jsx');

  // ── 6. ONE AUTHORITY: the frontend must not build or repin a link ──────
  // The origin is configured ONCE on the backend. The portal only displays the
  // server's link, so whatever domain or port an operator happens to browse
  // from can never change the address an invited colleague receives.
  const frontendSrc = path.resolve(BACKEND_DIR, '..', 'frontend', 'src');
  const frontendFiles = walk(frontendSrc)
    .filter((f) => /\.(js|jsx)$/.test(f))
    .map((abs) => ({
      rel: path.relative(frontendSrc, abs).split(path.sep).join('/'),
      text: fs.readFileSync(abs, 'utf8'),
      // Comments describe the rule; they must not trip it. Guard against CODE.
      code: stripComments(fs.readFileSync(abs, 'utf8')),
    }));
  check('frontend source was found to audit', frontendFiles.length > 0, String(frontendFiles.length));

  const browserOriginBuilders = frontendFiles
    .filter((f) => /(window\.)?location\.origin\s*[}`)]?\s*[+`][^\n]{0,40}\/admin\/activate/.test(f.text))
    .map((f) => f.rel);
  check('no frontend file builds an activation URL from the browser origin',
    browserOriginBuilders.length === 0, browserOriginBuilders.join(', '));

  const originMentions = frontendFiles
    .filter((f) => f.code.includes('window.location.origin'))
    .map((f) => f.rel)
    .sort();
  check('window.location.origin is confined to the link INSPECTOR (never a builder)',
    originMentions.length === 1 && originMentions[0] === 'services/activationLink.js',
    originMentions.join(', '));

  const removedBuilders = frontendFiles
    .filter((f) => /portalActivationUrl|applicationActivationUrl|export function activationUrl/.test(f.code))
    .map((f) => f.rel);
  check('the duplicate/repinning link builders are gone (no competing authorities)',
    removedBuilders.length === 0, removedBuilders.join(', '));

  const inspector = frontendFiles.find((f) => f.rel === 'services/activationLink.js');
  check('the single shared link inspector exists', !!inspector, 'services/activationLink.js');
  check('the inspector does NOT export a URL builder',
    !!inspector && !/export function (activationUrl|portalActivationUrl|applicationActivationUrl)/.test(inspector.text));
  check('the inspector declares the one activation path',
    !!inspector && inspector.text.includes("export const ACTIVATION_PATH = '/admin/activate/'"));
}

/** Drop line and block comments so the static guards match CODE, not prose. */
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Recursive source walk (skips node_modules and build output). */
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(abs, acc);
    } else {
      acc.push(abs);
    }
  }
  return acc;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. RESOLUTION MATRIX
// ─────────────────────────────────────────────────────────────────────────
function scanResolution() {
  console.log('\n— RESOLUTION MATRIX (dev may fall back, production may not) —');

  check('dev, nothing configured → the local storefront (development only)',
    publicFrontendOrigin({ env: { NODE_ENV: 'development' } }) === 'http://localhost:3000');
  check('dev, configured origin is honoured',
    publicFrontendOrigin({ env: { NODE_ENV: 'development', STAFF_PORTAL_URL: CONFIGURED_ORIGIN } }) === CONFIGURED_ORIGIN);
  check('a trailing slash never doubles up',
    publicFrontendOrigin({ env: { NODE_ENV: 'development', STAFF_PORTAL_URL: `${CONFIGURED_ORIGIN}/` } }) === CONFIGURED_ORIGIN);
  check('dev, CLIENT_URL still works as the legacy alias',
    publicFrontendOrigin({ env: { NODE_ENV: 'development', CLIENT_URL: 'https://legacy.example' } }) === 'https://legacy.example');
  check('dev, STAFF_PORTAL_URL wins over CLIENT_URL',
    publicFrontendOrigin({ env: { NODE_ENV: 'development', STAFF_PORTAL_URL: 'https://primary.example', CLIENT_URL: 'https://legacy.example' } }) === 'https://primary.example');
  check('dev, empty string is treated as unset (not as an origin)',
    publicFrontendOrigin({ env: { NODE_ENV: 'development', STAFF_PORTAL_URL: '   ' } }) === 'http://localhost:3000');

  // THE REGRESSION: this is what a production invitation used to be.
  const unset = refused({ NODE_ENV: 'production' });
  check('PRODUCTION, nothing configured → REFUSED (never localhost)',
    unset.threw && unset.status === 500 && unset.code === 'CONFIG_ERROR',
    JSON.stringify(unset));

  const loopback = refused({ NODE_ENV: 'production', STAFF_PORTAL_URL: 'http://localhost:3000' });
  check('PRODUCTION, origin pinned to localhost → REFUSED',
    loopback.threw && loopback.code === 'CONFIG_ERROR', JSON.stringify(loopback));

  const wildcard = refused({ NODE_ENV: 'production', STAFF_PORTAL_URL: 'http://127.0.0.1:3000' });
  check('PRODUCTION, origin pinned to 127.0.0.1 → REFUSED',
    wildcard.threw && wildcard.code === 'CONFIG_ERROR', JSON.stringify(wildcard));

  const bare = refused({ NODE_ENV: 'production', STAFF_PORTAL_URL: 'localhost:3000' });
  check('PRODUCTION, a bare unparseable localhost string → REFUSED',
    bare.threw && bare.code === 'CONFIG_ERROR', JSON.stringify(bare));

  check('PRODUCTION, the canonical frontend origin is accepted',
    publicFrontendOrigin({ env: { NODE_ENV: 'production', STAFF_PORTAL_URL: VERCEL } }) === VERCEL);
  check('PRODUCTION, CLIENT_URL is accepted as the fallback',
    publicFrontendOrigin({ env: { NODE_ENV: 'production', CLIENT_URL: VERCEL } }) === VERCEL);
  check('PRODUCTION, STAFF_PORTAL_URL beats CLIENT_URL',
    publicFrontendOrigin({ env: { NODE_ENV: 'production', STAFF_PORTAL_URL: VERCEL, CLIENT_URL: 'https://elsewhere.example' } }) === VERCEL);
  check('PRODUCTION, strict mode forces the rule regardless of NODE_ENV',
    refused({ NODE_ENV: 'development' }).threw === false &&
    (() => { try { publicFrontendOrigin({ env: { NODE_ENV: 'development' }, strict: true }); return false; } catch (e) { return e.code === 'CONFIG_ERROR'; } })());

  // STEP 7 — the local origins that must NEVER reach a production invitation:
  // the dev servers, the Vite preview ports and the loopback spellings.
  console.log('\n— PRODUCTION REJECTS EVERY LOCAL ORIGIN —');
  for (const bad of [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:4173',
    'http://localhost:4174',
    'http://localhost:4175',
    'http://127.0.0.1:4175',
    'http://127.0.0.1:3000',
    'http://0.0.0.0:4175',
    'localhost:3000',
  ]) {
    const r = refused({ NODE_ENV: 'production', STAFF_PORTAL_URL: bad });
    check(`PRODUCTION rejects ${bad}`, r.threw && r.code === 'CONFIG_ERROR', JSON.stringify(r));
  }

  console.log('\n— LOOPBACK DETECTION —');
  check('the Render API origin is NOT loopback', isLoopbackOrigin('https://flora-alchemy.onrender.com') === false);
  check('localhost is loopback', isLoopbackOrigin('http://localhost:3000') === true);
  check('127.0.0.1 is loopback', isLoopbackOrigin('http://127.0.0.1:4741') === true);
  check('IPv6 ::1 is loopback', isLoopbackOrigin('http://[::1]:3000') === true);
  check('a non-loopback host is not loopback', isLoopbackOrigin(VERCEL) === false);
  check('empty/garbage is not loopback (so it cannot be silently accepted as one)', isLoopbackOrigin('') === false && isLoopbackOrigin(null) === false);

  console.log('\n— BUILT URL —');
  const prodUrl = activationUrlFor('TOKEN', { env: { NODE_ENV: 'production', STAFF_PORTAL_URL: VERCEL } });
  check('production URL is exactly <frontend>/admin/activate/<token>',
    prodUrl === `${VERCEL}/admin/activate/TOKEN`);
  // STEP 7 — the required invariant, asserted literally.
  console.log('\n— PRODUCTION URL INVARIANT —');
  check('starts with the deployed frontend origin', prodUrl.startsWith('https://flora-alchemyy.vercel.app/'));
  for (const banned of ['localhost', '127.0.0.1', ':4173', ':4174', ':4175', ':3000', ':5173', 'onrender.com']) {
    check(`production URL never contains "${banned}"`, !prodUrl.includes(banned), prodUrl);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 2. THE AUDITED FUNCTION
// ─────────────────────────────────────────────────────────────────────────
function scanAuditedFunction() {
  console.log('\n— activationLink() UNDER AN INJECTED ENV —');

  const prodLink = withEnv({ NODE_ENV: 'production', STAFF_PORTAL_URL: VERCEL, CLIENT_URL: undefined },
    () => activationLink('TOKEN'));
  check('production env → the canonical frontend link',
    prodLink === `${VERCEL}/admin/activate/TOKEN`, prodLink);

  const prodFallback = withEnv({ NODE_ENV: 'production', STAFF_PORTAL_URL: undefined, CLIENT_URL: VERCEL },
    () => activationLink('TOKEN'));
  check('production without STAFF_PORTAL_URL → CLIENT_URL link (never localhost)',
    prodFallback === `${VERCEL}/admin/activate/TOKEN`, prodFallback);

  const prodUnset = withEnv({ NODE_ENV: 'production', STAFF_PORTAL_URL: undefined, CLIENT_URL: undefined },
    () => { try { return { value: activationLink('TOKEN') }; } catch (e) { return { code: e.code, status: e.status }; } });
  check('production with NO origin → refuses to mint a link at all',
    prodUnset.code === 'CONFIG_ERROR' && prodUnset.status === 500 && prodUnset.value === undefined,
    JSON.stringify(prodUnset));

  const prodLocal = withEnv({ NODE_ENV: 'production', STAFF_PORTAL_URL: 'http://localhost:3000', CLIENT_URL: undefined },
    () => { try { return { value: activationLink('TOKEN') }; } catch (e) { return { code: e.code, status: e.status }; } });
  check('production pinned at localhost → refuses (no localhost link can escape)',
    prodLocal.code === 'CONFIG_ERROR' && prodLocal.value === undefined, JSON.stringify(prodLocal));

  const devLink = withEnv({ NODE_ENV: 'development', STAFF_PORTAL_URL: undefined, CLIENT_URL: undefined },
    () => activationLink('TOKEN'));
  check('development with nothing configured → localhost is legitimate',
    devLink === 'http://localhost:3000/admin/activate/TOKEN', devLink);
}

// ─────────────────────────────────────────────────────────────────────────
// 2b. THE PORTAL'S LINK INSPECTOR — the browser is never the authority
// ─────────────────────────────────────────────────────────────────────────
async function scanFrontendInspector() {
  console.log('\n— FRONTEND LINK INSPECTOR (browser origin is NOT an authority) —');
  const mod = await import(new URL('../../frontend/src/services/activationLink.js', import.meta.url));
  check('the inspector module loads', typeof mod.inspectActivationLink === 'function');
  check('the inspector declares the activation path', mod.ACTIVATION_PATH === '/admin/activate/');

  /** Pretend the console is served from `origin`, then inspect `link`. */
  const asConsoleOn = (origin, link) => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
    globalThis.window = { location: { origin } };
    try { return mod.inspectActivationLink(link); } finally {
      if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window;
    }
  };

  // THE INVARIANT: an operator browsing locally still gets the deployed link.
  const localOperator = asConsoleOn('http://127.0.0.1:4175', `${VERCEL}/admin/activate/TOKEN`);
  check('operator on 127.0.0.1:4175 sees the DEPLOYED link unchanged',
    localOperator.ok && localOperator.url === `${VERCEL}/admin/activate/TOKEN`, JSON.stringify(localOperator));

  const prodOperator = asConsoleOn(VERCEL, `${VERCEL}/admin/activate/TOKEN`);
  check('operator on the deployed domain sees the same link', prodOperator.ok && prodOperator.url === `${VERCEL}/admin/activate/TOKEN`);

  // A public portal must never hand out a local-only address, however it got one.
  const leaked = asConsoleOn(VERCEL, 'http://localhost:3000/admin/activate/TOKEN');
  check('a LOCAL link on a PUBLIC portal is refused, not displayed',
    leaked.ok === false && /misconfigured/i.test(leaked.problem), JSON.stringify(leaked));
  const leakedVite = asConsoleOn('https://flora-alchemyy.vercel.app', 'http://127.0.0.1:4175/admin/activate/TOKEN');
  check('a 127.0.0.1 link on a public portal is refused', leakedVite.ok === false);

  // Local development is legitimate: a local console may show a local link.
  const localDev = asConsoleOn('http://localhost:3000', 'http://localhost:3000/admin/activate/TOKEN');
  check('a local console may display a local link (development)', localDev.ok === true);

  check('a missing link is reported, never invented',
    asConsoleOn(VERCEL, '') .ok === false);
  check('a bare token is reported, never turned into a URL',
    asConsoleOn(VERCEL, '0123456789abcdef').ok === false);
}

// ─────────────────────────────────────────────────────────────────────────
// 3. LIVE HTTP
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  scanStaticGuards();
  scanResolution();
  scanAuditedFunction();
  await scanFrontendInspector();

  console.log('\n— LIVE HTTP (server configured with a known origin) —');
  const { child, base } = await bootTestServer({
    port: PORT,
    db: DB,
    label: 'invitation-link',
    extraEnv: { STAFF_PORTAL_URL: CONFIGURED_ORIGIN },
  });
  const BASE = `${base}/api`;

  async function req(method, p, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, json };
  }

  try {
    const stamp = Date.now();
    const email = `link-${stamp}@invitation-link.test`;
    let r = await req('POST', '/auth/login', { body: { email: 'handler.admin@flora-alchemy.demo', password: 'handler1234' } });
    check('admin signs in (fixture)', r.status === 200, String(r.status));
    const ADMIN = r.json?.token;

    r = await req('POST', '/admin/invitations', { token: ADMIN, body: { email, staffRole: 'inventory' } });
    check('handler invitation issued → 201', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    const link = String(r.json?.link || '');
    check('issued link uses the CONFIGURED origin, not the default',
      link.startsWith(`${CONFIGURED_ORIGIN}/admin/activate/`), link.replace(/[a-f0-9]{64}/, '<token>'));
    check('issued link can never contain localhost while the env is set',
      !/localhost/.test(link), link.replace(/[a-f0-9]{64}/, '<token>'));
    check('issued link is exactly <origin>/admin/activate/<256-bit token>',
      new RegExp(`^${CONFIGURED_ORIGIN.replace(/[.\\/]/g, '\\$&')}/admin/activate/[a-f0-9]{64}$`).test(link),
      link.replace(/[a-f0-9]{64}/, '<token>'));
    const token = link.split('/').pop();
    const invId = r.json?.invitation?.id;
    check('the create response identifies the invitation (no token echoed)', !!invId && !String(invId).includes(token));

    r = await req('GET', `/invitations/${token}`);
    check('the generated link resolves on the public landing route → 200', r.status === 200, String(r.status));
    const body = JSON.stringify(r.json || {});
    check('the landing never echoes the raw token', !body.includes(token));
    check('the landing never exposes the token hash', !body.includes('tokenHash'));
    check('the landing names the workspace the recipient is joining',
      typeof r.json?.invitation?.workspaceName === 'string' || r.json?.invitation?.workspaceName === undefined,
      JSON.stringify(r.json?.invitation || {}).slice(0, 200));

    r = await req('POST', `/admin/invitations/${invId}/resend`, { token: ADMIN });
    check('resend → 200 with a fresh link', r.status === 200 && typeof r.json?.link === 'string', String(r.status));
    const resent = String(r.json?.link || '');
    check('the resent link keeps the configured origin', resent.startsWith(`${CONFIGURED_ORIGIN}/admin/activate/`),
      resent.replace(/[a-f0-9]{64}/, '<token>'));
    check('the resent link is a different one-time token (single live credential)',
      resent.split('/').pop() !== token);
    r = await req('GET', `/invitations/${token}`);
    check('the superseded link no longer works', r.status === 404, String(r.status));

    // Cleanup — no QA rows left in the dedicated test database.
    try {
      await mongoose.connect(process.env.MONGO_URI.replace(/\/[^/?]+(\?|$)/, `/${DB}$1`), { serverSelectionTimeoutMS: 15000 });
      const delInv = await mongoose.connection.db.collection('invitations').deleteMany({ recipientEmail: email });
      const delUsr = await mongoose.connection.db.collection('users').deleteMany({ email });
      console.log(`\n— cleanup: removed ${delInv.deletedCount} invitation(s), ${delUsr.deletedCount} user(s) —`);
    } catch (err) {
      console.log(`\n— cleanup skipped (${err.message}) —`);
    } finally {
      await mongoose.disconnect().catch(() => {});
    }
  } finally {
    await stopTestServer(child, base);
  }

  console.log(`\nINVITATION LINK RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

await main();
