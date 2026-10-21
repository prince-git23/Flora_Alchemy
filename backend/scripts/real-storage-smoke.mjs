/**
 * REAL Supabase Storage smoke — drives the SHIPPED driver against the LIVE
 * private bucket over the actual Storage REST API (opt-in, alongside the
 * mocked `test:supabase-storage`). Like `test:3d-real`, it states plainly
 * whether it ran and refuses to guess when configuration is absent.
 *
 * SAFETY
 *   · never prints the secret — only its shape/length, with a defensive
 *     redaction pass over every error string as well;
 *   · one tiny synthetic object under a unique `smoke-test/` prefix, removed
 *     by a finally-style cleanup — no product images, no customer data, no
 *     GLBs, no public bucket changes, no GPU work, NO filesystem fallback;
 *   · stops (exit 2) unless MEDIA_STORAGE_DRIVER=supabase points at a real
 *     https project (never loopback — that is the mock shape) with a usable
 *     `sb_secret_`/legacy-JWT secret key.
 *
 * Run (from backend/): npm run test:supabase-real
 * Exit: 0 = every live check passed · 1 = a check failed · 2 = not configured.
 */
import crypto from 'node:crypto';
import { loadBackendEnv } from './lib/testServer.mjs';

loadBackendEnv();

/* ── configuration report (names and shape ONLY — never the value) ─────── */
const driver = String(process.env.MEDIA_STORAGE_DRIVER || '').trim() || '(unset)';
const rawUrl = String(process.env.SUPABASE_URL || '').trim();
const bucket = String(process.env.SUPABASE_STORAGE_BUCKET || '').trim();
const secret = String(process.env.SUPABASE_SECRET_KEY || '').trim();

const keyShape = !secret ? '(unset)'
  : secret.startsWith('sb_secret_') ? 'sb_secret_ (current format)'
  : secret.startsWith('sb_publishable_') ? 'sb_publishable_ (PUBLIC key — unusable here)'
  : secret.split('.').length === 3 ? 'legacy JWT shape'
  : 'unknown shape';
let origin = '(unset)';
try { origin = rawUrl ? new URL(rawUrl).origin : '(unset)'; } catch { origin = '(invalid URL)'; }

console.log('REAL SUPABASE STORAGE SMOKE — live project, live bucket (this is NOT the mock)');
console.log(`  MEDIA_STORAGE_DRIVER     ${driver}`);
console.log(`  SUPABASE_URL (origin)    ${origin}`);
console.log(`  SUPABASE_STORAGE_BUCKET  ${bucket || '(unset)'}`);
console.log(`  SUPABASE_SECRET_KEY      ${keyShape}, length ${secret.length} (value never printed)`);

const stop = (why) => { console.error(`\nNOT RUN: ${why}`); process.exit(2); };
const isLoopback = (() => {
  try { const h = new URL(rawUrl).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'; }
  catch { return false; }
})();
if (driver !== 'supabase') stop('MEDIA_STORAGE_DRIVER is not "supabase" — refusing to touch any other backend (no fs fallback).');
if (!rawUrl || !bucket) stop('SUPABASE_URL / SUPABASE_STORAGE_BUCKET are missing — configure backend/.env first.');
if (isLoopback || !rawUrl.startsWith('https://')) stop('SUPABASE_URL must be the real https project URL — loopback is the mock configuration.');
if (!secret || secret.length < 16 || secret.startsWith('sb_publishable_')) {
  stop('SUPABASE_SECRET_KEY is missing or unusable (a public sb_publishable_ key cannot reach a private bucket).');
}

const storage = await import('../services/privateObjectStorage.js');
const redact = (text) => String(text ?? '').split(secret).join('[REDACTED]');

if (storage.storageDriver() !== 'supabase' || !storage.supabaseConfigured()) {
  stop(`the driver reports not configured: ${storage.supabaseMissingSettings().join(', ')}`);
}

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok ${String(passed + failed).padStart(2)} ${name}`); }
  else { failed += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}


const prefix = `smoke-test/real-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const key = `${prefix}/probe.bin`;
const payload = Buffer.from(`flora-real-storage-smoke ${new Date().toISOString()} ${crypto.randomBytes(8).toString('hex')}\n`);
const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');
let cleanupNote = '';

try {
  console.log('\n— live sequence against the Storage REST API —');

  // 1. connect: the bucket answers a bounded probe
  const st = await storage.objectStoreStatus({ probe: true });
  check('connects to the configured project; the bucket answers the probe',
    st.configured === true && st.usable === true && st.checked === true,
    redact(JSON.stringify({ configured: st.configured, usable: st.usable, checked: st.checked, reason: st.reason })));

  // Bucket exists with the EXACT configured name and is private — checked by the
  // SHIPPED guard (GET /storage/v1/bucket/<id>), not a suite-local substitute,
  // so a live pass here is evidence about the code that gates every write.
  const b = await storage.bucketPrivacy({ force: true });
  check('the bucket exists under the exact configured name and is PRIVATE',
    b.checked === true && b.private === true && b.public === false && b.bucket === bucket,
    redact(JSON.stringify({ checked: b.checked, private: b.private, public: b.public, reason: b.reason })));

  // 0. absent before the write
  check('the unique smoke key does not exist before the write',
    (await storage.headObject(key)) === null);

  // 2. write the tiny synthetic object
  const put = await storage.putObject({ key, buffer: payload, contentType: 'application/octet-stream' });
  check('the write reports the exact byte count and sha256',
    put?.bytes === payload.length && put?.sha256 === expectedSha,
    redact(JSON.stringify({ bytes: put?.bytes })));

  // 3. read back — byte-identical
  const back = await storage.getObject(key);
  check('read-back is byte-identical to what was written',
    back !== null && back.length === payload.length && Buffer.compare(back, payload) === 0);

  // 4. exists + stat
  const stat = await storage.headObject(key);
  check('exists/stat report the true size, hash, content type and last-modified',
    stat !== null && stat.bytes === payload.length && stat.sha256 === expectedSha &&
      stat.contentType === 'application/octet-stream' && Boolean(stat.lastModified),
    redact(JSON.stringify(stat)));

  // 5. prefix listing finds it
  const found = await storage.findObjectByPrefix(`${prefix}/probe`);
  check('prefix listing finds the test object', found?.key === key, redact(JSON.stringify(found?.key ?? null)));

  // 6. delete
  await storage.deleteObject(key);

  // 7. gone
  const gone = await storage.headObject(key);
  const goneGet = await storage.getObject(key);
  check('after deletion a fresh existence check confirms removal', gone === null && goneGet === null);
} catch (err) {
  check('the live sequence completed without an unexpected failure', false,
    redact(`code=${err?.code || '-'} status=${err?.status ?? '-'} ${err?.message ?? err}`));
} finally {
  try { await storage.deletePrefix(prefix); }
  catch (e) { cleanupNote = redact(`cleanup of ${prefix} failed (${e?.code || 'error'}): ${e?.message || e}`); }
}

if (cleanupNote) {
  console.log(`\nCLEANUP WARNING: ${cleanupNote}`);
  console.log(`Safe cleanup: in the Supabase dashboard open Storage → ${bucket} and delete the folder "${prefix}".`);
} else {
  console.log(`\ncleanup: removed ${prefix} from the bucket`);
}

console.log(`\nREAL SUPABASE STORAGE RESULT: ${passed} passed, ${failed} failed  (live bucket — not mocked)`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
