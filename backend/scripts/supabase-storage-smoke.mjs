/**
 * SUPABASE STORAGE SMOKE — the private-media object driver against a local,
 * STORAGE-EMULATING HTTP server.
 *
 * This suite is entirely MOCKED: it boots an in-process HTTP server that
 * implements the documented Supabase Storage REST surface (upload with
 * x-upsert/x-metadata, object info, authenticated download, prefix listing,
 * single + batch delete, the 50 MB free-plan upload ceiling, the CURRENT
 * key-format auth rules — apikey-only for `sb_secret_...`, both headers for
 * a legacy JWT, 401 Invalid JWT otherwise — and the documented 401/404/413
 * error shapes), plus the bucket-details endpoint the privacy guard reads —
 * and points `SUPABASE_URL` at it over loopback. It proves the DRIVER's
 * behaviour — configuration, credential discipline, key safety, round trips,
 * listing, deletion, failure translation, the production guard, the
 * fail-closed bucket-privacy guard and status honesty — WITHOUT a cloud
 * account, a database, or a single byte leaving this machine.
 *
 * IT DOES NOT PROVE a real Supabase connection. Real-bucket verification is
 * the owner's manual step (docs/IMAGE_STUDIO.md §Storage checklist) once a
 * project and private bucket exist. This suite never writes to any real
 * service and prints no credential values.
 *
 * Run: npm run test:supabase-storage   (from backend/)
 */

import http from 'node:http';
import crypto from 'node:crypto';

process.env.MEDIA_STORAGE_DRIVER = 'supabase';

const SECRET_KEY = `sb_secret_${crypto.randomBytes(24).toString('hex')}`;
let validKey = SECRET_KEY; // what the mock accepts (rotated by the legacy test)
const BUCKET = 'flora-private';
const FREE_PLAN_MAX_UPLOAD = 50 * 1000 * 1000; // Supabase Free: 50 MB per file

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok ${String(passed + failed).padStart(2)} ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (title) => console.log(`\n— ${title} —`);

/* ── the mock Supabase Storage REST server ─────────────────────────────── */

const objects = new Map(); // key -> { bytes: Buffer, contentType, metadata }
const requests = []; // every request the driver ever made (for assertions)
let failMode = null; // '500' | '401' | '413' | '404-bucket' | null
// Bucket-details state, independent of failMode: the privacy guard must be
// exercisable without also breaking the object routes it protects.
let bucketPublic = false;
let bucketDetailsMode = 'ok'; // 'ok' | 'missing' | '500' | 'no-public' | 'string-public' | 'not-json' | 'wrong-identity' | 'hang'
const hangingBucketResponses = [];

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

function childrenOf(prefix) {
  // Immediate children of a folder prefix: {name, id}; id===null marks a folder.
  const out = new Map();
  for (const [key, value] of objects) {
    if (prefix && !key.startsWith(`${prefix}/`)) continue;
    const rest = prefix ? key.slice(prefix.length + 1) : key;
    const slash = rest.indexOf('/');
    if (slash === -1) out.set(rest, { name: rest, id: `file-${key}`, size: value.bytes.length, metadata: value.metadata, mimeType: value.contentType });
    else {
      const folder = rest.slice(0, slash);
      if (!out.has(folder)) out.set(folder, { name: folder, id: null });
    }
  }
  return [...out.values()];
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const apikey = req.headers.apikey || '';
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    requests.push({
      method: req.method,
      path: url.pathname,
      apikey,
      bearer,
      upsert: req.headers['x-upsert'] || '',
      xMetadata: req.headers['x-metadata'] || '',
      size: body.length,
    });

    // Current platform auth for BOTH key formats: a new `sb_secret_...` key
    // is NOT a JWT — an Authorization copy is parsed as one and REJECTED
    // ("Invalid JWT"); a legacy JWT key must appear in BOTH headers.
    const newFormat = validKey.startsWith('sb_secret_');
    const authOk = newFormat
      ? apikey === validKey && bearer === ''
      : apikey === validKey && bearer === validKey;
    if (!authOk) return json(res, 401, { message: 'Invalid JWT', error_code: 'InvalidJWT' });

    // Route shapes, mirroring the real storage-api:
    //   POST   /object/list/<bucket>
    //   GET    /object/info/<bucket>/<key>       GET /object/authenticated/<bucket>/<key>
    //   POST   /object/<bucket>/<key>            DELETE /object/<bucket>/<key>
    //   DELETE /object/<bucket>                  (batch delete: {prefixes:[...]})
    // `list`/`info`/`authenticated` can never be the bucket name here — the
    // configured bucket is `flora-private`.
    const parts = url.pathname.replace(/^\/storage\/v1\//, '').split('/');
    const kind = parts[0]; // object
    const route = ['list', 'info', 'authenticated'].includes(parts[1]) && parts.length > 2 ? parts[1] : '';
    const bucket = route ? parts[2] || '' : parts[1] || '';
    const key = (route ? parts.slice(3) : parts.slice(2)).map(decodeURIComponent).join('/');
    if (bucket !== BUCKET) return json(res, 404, { message: 'Bucket not found', error_code: 'BucketNotFound' });

    // Bucket details (the documented `GET /storage/v1/bucket/<id>`) — the shape
    // the privacy guard validates. Deliberately INDEPENDENT of `failMode`: the
    // object-route failure tests below still need a private, reachable bucket.
    if (kind === 'bucket' && req.method === 'GET') {
      if (bucketDetailsMode === 'hang') { hangingBucketResponses.push(res); return; }
      // LIVE-VERIFIED shape (real project, 2026-10-21): a missing bucket answers
      // 400 NoSuchBucket, not 404 — the guard must read that as "does not exist".
      if (bucketDetailsMode === 'missing') return json(res, 400, { message: 'Bucket not found', error_code: 'NoSuchBucket' });
      if (bucketDetailsMode === '500') return json(res, 500, { message: 'internal error', error_code: 'INTERNAL_ERROR' });
      if (bucketDetailsMode === 'not-json') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('not json'); }
      if (bucketDetailsMode === 'no-public') return json(res, 200, { id: BUCKET, name: BUCKET });
      if (bucketDetailsMode === 'string-public') return json(res, 200, { id: BUCKET, name: BUCKET, public: 'false' });
      if (bucketDetailsMode === 'wrong-identity') return json(res, 200, { id: 'another-bucket', name: 'another-bucket', public: false });
      return json(res, 200, { id: BUCKET, name: BUCKET, public: bucketPublic });
    }

    if (failMode === '401') return json(res, 401, { message: 'Invalid JWT', error_code: 'InvalidJWT' });
    if (failMode === '500') return json(res, 500, { message: 'internal error', error_code: 'INTERNAL_ERROR' });
    if (failMode === '404-bucket') return json(res, 404, { message: 'Bucket not found', error_code: 'BucketNotFound' });

    if (kind === 'object' && req.method === 'POST' && route === 'list') {
      let parsed = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { /* empty */ }
      const prefix = String(parsed.prefix || '');
      let rows = childrenOf(prefix);
      if (parsed.search) rows = rows.filter((r) => r.name.includes(String(parsed.search)));
      const offset = Number(parsed.offset || 0);
      const limit = Number(parsed.limit || 1000);
      return json(res, 200, rows.slice(offset, offset + limit).map((r) => ({ name: r.name, id: r.id })));
    }

    if (kind === 'object' && req.method === 'POST' && !route) {
      // upload (key may contain slashes)
      if (failMode === '413' || body.length > FREE_PLAN_MAX_UPLOAD) {
        return json(res, 413, { message: 'Payload too large', error_code: 'EntityTooLarge' });
      }
      if (!body.length) return json(res, 400, { message: 'Empty body', error_code: 'InvalidRequest' });
      let metadata = {};
      try { metadata = JSON.parse(Buffer.from(String(req.headers['x-metadata'] || ''), 'base64').toString('utf8') || '{}'); } catch { /* none */ }
      objects.set(key, { bytes: body, contentType: String(req.headers['content-type'] || 'application/octet-stream'), metadata });
      return json(res, 200, { message: 'Successfully uploaded', key });
    }

    if (kind === 'object' && req.method === 'GET' && route === 'info') {
      const hit = objects.get(key);
      // LIVE-VERIFIED shape (real project, 2026-10-20): a missing object on
      // /object/info answers 400 NoSuchKey, not 404 — the driver must read
      // THIS and the 404 NotFound download shape below as "absent".
      if (!hit) return json(res, 400, { message: 'The resource was not found', error_code: 'NoSuchKey' });
      // LIVE-VERIFIED shape (real project, 2026-10-20): snake_case
      // `content_type` at top level; `metadata` carries ONLY the custom
      // x-metadata fields; `last_modified` is an ISO string.
      return json(res, 200, {
        name: key,
        id: `file-${key}`,
        size: hit.bytes.length,
        content_type: hit.contentType,
        metadata: hit.metadata,
        last_modified: new Date().toISOString(),
      });
    }

    if (kind === 'object' && req.method === 'GET' && route === 'authenticated') {
      const hit = objects.get(key);
      if (!hit) return json(res, 404, { message: 'Object not found', error_code: 'NotFound' });
      res.writeHead(200, { 'Content-Type': hit.contentType });
      return res.end(hit.bytes);
    }

    if (kind === 'object' && req.method === 'DELETE' && !route && parts.length === 2) {
      // batch delete: { prefixes: [...] }
      let parsed = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { /* none */ }
      const removed = [];
      for (const k of parsed.prefixes || []) if (objects.delete(String(k))) removed.push(String(k));
      return json(res, 200, removed.map((name) => ({ name, id: 'x' })));
    }

    if (kind === 'object' && req.method === 'DELETE' && !route) {
      if (!objects.has(key)) return json(res, 404, { message: 'Object not found', error_code: 'NotFound' });
      objects.delete(key);
      return json(res, 200, { message: 'Successfully deleted' });
    }

    return json(res, 404, { message: 'Unknown route', error_code: 'NotFound' });
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
process.env.SUPABASE_URL = `http://127.0.0.1:${PORT}`;
process.env.SUPABASE_STORAGE_BUCKET = BUCKET;
process.env.SUPABASE_SECRET_KEY = SECRET_KEY;

const storage = await import('../services/privateObjectStorage.js');
const { MAX_KEY_LENGTH } = storage;

const requestCount = () => requests.length;
const lastRequest = () => requests[requests.length - 1];

try {
  /* ── §A driver selection + configuration ─────────────────────────────── */
  section('§A driver selection and configuration (no requests)');
  check('supabase driver selected', storage.storageDriver() === 'supabase' && storage.usingObjectStorage() === true);
  process.env.MEDIA_STORAGE_DRIVER = 'bogus-driver';
  check('an unknown driver value falls back to fs', storage.storageDriver() === 'fs' && storage.usingObjectStorage() === false);
  process.env.MEDIA_STORAGE_DRIVER = 'supabase';

  const savedUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'http://plain-example.com';
  check('a non-loopback plain-http URL is refused (the secret key must ride HTTPS)',
    storage.supabaseBase() === '' && storage.supabaseConfigured() === false &&
    storage.supabaseMissingSettings()[0].startsWith('SUPABASE_URL'), JSON.stringify(storage.supabaseMissingSettings()));
  process.env.SUPABASE_URL = savedUrl;
  check('the loopback mock URL is accepted', storage.supabaseBase() === `http://127.0.0.1:${PORT}`);
  check('fully configured reports configured', storage.supabaseConfigured() === true);

  const savedBucket = process.env.SUPABASE_STORAGE_BUCKET;
  delete process.env.SUPABASE_STORAGE_BUCKET;
  check('missing bucket is named in the diagnostic', storage.supabaseConfigured() === false &&
    storage.supabaseMissingSettings().includes('SUPABASE_STORAGE_BUCKET'), JSON.stringify(storage.supabaseMissingSettings()));
  process.env.SUPABASE_STORAGE_BUCKET = savedBucket;

  const savedKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SECRET_KEY = 'short';
  check('a too-short secret key is not accepted as configuration', storage.supabaseConfigured() === false &&
    storage.supabaseMissingSettings().includes('SUPABASE_SECRET_KEY'));

  const unconfigured = await storage.putObject({ key: 'never/sent.bin', buffer: Buffer.from('x') }).catch((e) => e);
  check('an operation without configuration fails typed BEFORE any request',
    unconfigured?.code === 'STORAGE_NOT_CONFIGURED' && requestCount() === 0, unconfigured?.code);
  process.env.SUPABASE_SECRET_KEY = savedKey;

  process.env.SUPABASE_SECRET_KEY = `sb_publishable_${crypto.randomBytes(12).toString('hex')}`;
  const publishable = await storage.putObject({ key: 'never/sent2.bin', buffer: Buffer.from('x') }).catch((e) => e);
  check('a public sb_publishable_ key is refused as not-configured, with the actionable reason',
    storage.supabaseConfigured() === false && publishable?.code === 'STORAGE_NOT_CONFIGURED' &&
      /publishable/.test(storage.supabaseMissingSettings().join(' ')) && requestCount() === 0,
    JSON.stringify({ code: publishable?.code, missing: storage.supabaseMissingSettings() }));
  process.env.SUPABASE_SECRET_KEY = savedKey;

  /* ── §B credential discipline ────────────────────────────────────────── */
  section('§B every request carries the server credential; the key never leaks');
  const marker = Buffer.from('credential pass');
  const credPut = await storage.putObject({ key: 'ws/cred/marker.bin', buffer: marker, contentType: 'application/octet-stream' });
  check('the new-format sb_secret_ key rides the apikey header ONLY (no Authorization echo)',
    lastRequest().apikey === SECRET_KEY && lastRequest().bearer === '');
  check('the upload declares x-upsert: true (idempotent retry semantics)', lastRequest().upsert === 'true');
  await storage.headObject('ws/cred/marker.bin');
  check('info requests are authenticated too', lastRequest().apikey === SECRET_KEY && lastRequest().bearer === '');
  await storage.getObject('ws/cred/marker.bin');
  check('downloads are authenticated too', lastRequest().path.startsWith('/storage/v1/object/authenticated/'));
  check('every request stayed within the object or bucket endpoints (no other surface is touched)',
    requests.every((r) => r.path.startsWith('/storage/v1/object/') || r.path.startsWith('/storage/v1/bucket/')));
  check('the write was gated by a bucket-privacy lookup before it was uploaded',
    requests.some((r) => r.method === 'GET' && r.path === `/storage/v1/bucket/${BUCKET}`) &&
      requests.findIndex((r) => r.method === 'POST' && r.path.startsWith('/storage/v1/object/') && !r.path.includes('/list/')) >
        requests.findIndex((r) => r.path === `/storage/v1/bucket/${BUCKET}`));

  check('no request ever carried an Authorization header while the new-format key was configured',
    requests.every((r) => r.bearer === ''));

  const LEGACY_KEY = `legacy.${crypto.randomBytes(16).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}.jwt`;
  validKey = LEGACY_KEY;
  process.env.SUPABASE_SECRET_KEY = LEGACY_KEY;
  await storage.putObject({ key: 'ws/cred/legacy.bin', buffer: marker });
  check('a legacy JWT key still sends BOTH apikey and Authorization (documented compat)',
    lastRequest().apikey === LEGACY_KEY && lastRequest().bearer === LEGACY_KEY);
  validKey = SECRET_KEY;
  process.env.SUPABASE_SECRET_KEY = savedKey;

  process.env.SUPABASE_SECRET_KEY = `sb_secret_WRONG-${crypto.randomBytes(8).toString('hex')}`;
  const rejected = await storage.putObject({ key: 'ws/cred/wrong.bin', buffer: marker }).catch((e) => e);
  const wrongKeyUsed = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SECRET_KEY = savedKey;
  check('a rejected credential becomes a typed safe failure (401 → STORAGE_UNAVAILABLE)',
    rejected?.code === 'STORAGE_UNAVAILABLE' && rejected?.status === 503, JSON.stringify({ code: rejected?.code, status: rejected?.status }));
  check('the failure message never contains the credential value',
    !String(rejected?.message || '').includes(wrongKeyUsed) && !String(rejected?.message || '').includes(SECRET_KEY));

  /* ── §C round trip: put → head → get, idempotent re-put ──────────────── */
  section('§C put / info / download round trip with sha256 metadata');
  const payload = Buffer.concat([marker, crypto.randomBytes(1024)]);
  const put = await storage.putObject({ key: 'ws/asset/model.glb', buffer: payload, contentType: 'model/gltf-binary', metadata: { source: 'suite' } });
  check('put reports the exact byte count and sha256', put.bytes === payload.length && put.sha256 === crypto.createHash('sha256').update(payload).digest('hex'));
  const sentMeta = JSON.parse(Buffer.from(lastRequest().xMetadata, 'base64').toString('utf8'));
  check('x-metadata carries {source, sha256} as base64 JSON', sentMeta.sha256 === put.sha256 && sentMeta.source === 'suite');

  const head = await storage.headObject('ws/asset/model.glb');
  check('info returns the same size and sha256 (metadata round trip)', head?.bytes === payload.length && head?.sha256 === put.sha256, JSON.stringify(head));
  check('info returns the content type', head?.contentType === 'model/gltf-binary');

  const read = await storage.getObject('ws/asset/model.glb');
  check('download returns byte-identical content', read && Buffer.compare(read, payload) === 0);

  const repeat = await storage.putObject({ key: 'ws/asset/model.glb', buffer: payload, contentType: 'model/gltf-binary' });
  check('a re-put of identical bytes is an idempotent success', repeat.sha256 === put.sha256);

  const empty = await storage.putObject({ key: 'ws/asset/empty.glb', buffer: Buffer.alloc(0) }).catch((e) => e);
  check('an empty body is refused client-side with no request sent',
    empty?.code === 'VALIDATION_ERROR', empty?.code);

  const missingHead = await storage.headObject('ws/asset/never-written.glb');
  const missingGet = await storage.getObject('ws/asset/never-written.glb');
  check('info (live 400 NoSuchKey shape) and download (404 shape) of a missing object answer null',
    missingHead === null && missingGet === null);

  /* ── §D key safety — nothing escapes, nothing is even SENT ───────────── */
  section('§D object-key safety (a client string never becomes a key)');
  const before = requestCount();
  const badKeys = ['../escape.bin', '/absolute.bin', 'a//b.bin', 'a/../b.bin', 'a\u0000b.bin', 'k/' + 'x'.repeat(MAX_KEY_LENGTH) + '.bin', ''];
  const badResults = [];
  for (const k of badKeys) badResults.push(await storage.putObject({ key: k, buffer: marker }).catch((e) => e));
  check('every invalid key is refused with STORAGE_KEY_INVALID before any request',
    badResults.every((e) => e?.code === 'STORAGE_KEY_INVALID') && requestCount() === before, JSON.stringify(badResults.map((e) => e?.code)));

  /* ── §E listing, find-by-prefix, deletion ────────────────────────────── */
  section('§E prefix search, scoped listing and deletion');
  await storage.putObject({ key: 'wsA/img1/original.png', buffer: Buffer.from('orig-a1') });
  await storage.putObject({ key: 'wsA/img1/cutout.png', buffer: Buffer.from('cut-a1') });
  await storage.putObject({ key: 'wsA/img2/original.png', buffer: Buffer.from('orig-a2') });
  await storage.putObject({ key: 'wsB/img3/original.png', buffer: Buffer.from('orig-b3') });

  const byStem = await storage.findObjectByPrefix('wsA/img1/original');
  check('find-by-prefix finds the extension-varying key', byStem?.key === 'wsA/img1/original.png', JSON.stringify(byStem));
  const absentStem = await storage.findObjectByPrefix('wsA/img1/nothing');
  check('find-by-prefix answers null when nothing matches', absentStem === null);
  const foreignStem = await storage.findObjectByPrefix('wsB/img1/original');
  check('find-by-prefix does not cross the folder boundary (no sibling-workspace leak)', foreignStem === null);

  await storage.deleteObject('wsA/img2/original.png');
  check('a deleted object answers null afterwards', (await storage.headObject('wsA/img2/original.png')) === null);
  const deleteMissing = await storage.deleteObject('wsA/img2/original.png').catch((e) => e);
  check('deleting a missing object is not an error', deleteMissing === undefined || deleteMissing?.code === undefined);

  await storage.deletePrefix('wsA/img1');
  check('deletePrefix removed every child of the asset directory',
    (await storage.headObject('wsA/img1/original.png')) === null && (await storage.headObject('wsA/img1/cutout.png')) === null);
  check('deletePrefix left other prefixes untouched',
    (await storage.headObject('wsB/img3/original.png')) !== null);
  const emptyTree = await storage.deletePrefix('wsA/never-existed').catch((e) => e);
  check('deletePrefix on an absent prefix is harmless', emptyTree === undefined || emptyTree?.code === undefined);

  /* ── §F failure translation ──────────────────────────────────────────── */
  section('§F service failures become typed, honest errors');
  failMode = '500';
  const e500 = await storage.putObject({ key: 'ws/fail/x.bin', buffer: marker }).catch((e) => e);
  check('a 500 is a retryable STORAGE_UNAVAILABLE with the safe-retry sentence',
    e500?.code === 'STORAGE_UNAVAILABLE' && /safe to retry/i.test(e500?.message || ''), e500?.code);
  const g500 = await storage.getObject('ws/asset/model.glb').catch((e) => e);
  check('a 500 on download is typed too', g500?.code === 'STORAGE_UNAVAILABLE');
  failMode = null;

  failMode = '413';
  const e413 = await storage.putObject({ key: 'ws/fail/huge.bin', buffer: marker }).catch((e) => e);
  check('the free plan 413 EntityTooLarge maps to STORAGE_TOO_LARGE', e413?.code === 'STORAGE_TOO_LARGE' && e413?.status === 413, e413?.code);
  failMode = null;

  failMode = '404-bucket';
  const noBucket = await storage.putObject({ key: 'ws/fail/x.bin', buffer: marker }).catch((e) => e);
  check('a missing bucket on upload is STORAGE_UNAVAILABLE (configuration), not "file missing"',
    noBucket?.code === 'STORAGE_UNAVAILABLE', noBucket?.code);
  failMode = null;

  const savedDown = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'http://127.0.0.1:9'; // closed port
  const unreachable = await storage.getObject('ws/asset/model.glb').catch((e) => e);
  process.env.SUPABASE_URL = savedDown;
  check('an unreachable host is a typed STORAGE_UNAVAILABLE, never a crash',
    unreachable?.code === 'STORAGE_UNAVAILABLE', unreachable?.code);

  /* ── §G production guard ─────────────────────────────────────────────── */
  section('§G production refuses ephemeral writes (STORAGE_NOT_DURABLE)');
  const savedNodeEnv = process.env.NODE_ENV;
  const savedDriver = process.env.MEDIA_STORAGE_DRIVER;
  process.env.NODE_ENV = 'production';
  process.env.MEDIA_STORAGE_DRIVER = 'fs';
  let guardErr = null;
  try { storage.assertDurableWriteAllowed({ root: process.cwd() + '/uploads', label: '3D media' }); } catch (e) { guardErr = e; }
  process.env.MEDIA_STORAGE_DRIVER = savedDriver;
  process.env.NODE_ENV = savedNodeEnv;
  check('fs driver in production with an app-tree root is refused with the exact fix',
    guardErr?.code === 'STORAGE_NOT_DURABLE' && /MEDIA_STORAGE_DRIVER=supabase/.test(guardErr?.message || ''), guardErr?.code);
  process.env.NODE_ENV = 'production';
  let guardOk = true;
  try { storage.assertDurableWriteAllowed({ root: process.cwd() + '/uploads' }); } catch { guardOk = false; }
  process.env.NODE_ENV = savedNodeEnv;
  check('the configured supabase driver is allowed in production', guardOk === true);

  /* ── §H status honesty ───────────────────────────────────────────────── */
  section('§H status describes reality and never contains the credential');
  const st = await storage.objectStoreStatus({ probe: true });
  check('status reports driver, configured, usable — all true against the mock',
    st.driver === 'supabase' && st.configured === true && st.usable === true && st.checked === true && st.durable === true, JSON.stringify(st));
  check('the serialized status contains no credential material',
    !JSON.stringify(st).includes(SECRET_KEY) && !JSON.stringify(st).includes(SECRET_KEY.slice(10)));

  process.env.SUPABASE_URL = 'http://127.0.0.1:9';
  const stDown = await storage.objectStoreStatus({ probe: true });
  process.env.SUPABASE_URL = savedDown;
  check('a probe against a dead endpoint reports usable=false, checked=true (never a silent pass)',
    stDown.usable === false && stDown.checked === true, JSON.stringify(stDown));

  process.env.SUPABASE_STORAGE_BUCKET = '';
  const stMissing = await storage.objectStoreStatus({ probe: false });
  process.env.SUPABASE_STORAGE_BUCKET = savedBucket;
  check('an unconfigured store names the missing variable in the reason',
    stMissing.configured === false && /SUPABASE_STORAGE_BUCKET/.test(stMissing.reason), stMissing.reason);

  process.env.MEDIA_STORAGE_DRIVER = 'fs';
  const stFs = await storage.objectStoreStatus({ probe: false });
  process.env.MEDIA_STORAGE_DRIVER = 'supabase';
  check('the fs driver reports itself honestly', stFs.driver === 'fs' && stFs.configured === false && /Filesystem/.test(stFs.reason));

  /* ── §I bucket privacy guard ─────────────────────────────────────────── */
  section('§I bucket privacy — verified before every write, fail closed');
  const privacyCalls = () =>
    requests.filter((r) => r.method === 'GET' && r.path === `/storage/v1/bucket/${BUCKET}`).length;
  const uploadCalls = () =>
    requests.filter((r) => r.method === 'POST' && r.path.startsWith('/storage/v1/object/') && !r.path.includes('/list/')).length;

  bucketPublic = false;
  bucketDetailsMode = 'ok';
  storage.resetBucketPrivacyCache();

  const confirmed = await storage.bucketPrivacy({ force: true });
  check('a private bucket is confirmed from bucket details, naming the exact bucket',
    confirmed.checked === true && confirmed.private === true && confirmed.public === false && confirmed.bucket === BUCKET,
    JSON.stringify({ checked: confirmed.checked, private: confirmed.private, bucket: confirmed.bucket }));

  const uploadsBefore = uploadCalls();
  const okWrite = await storage.putObject({ key: 'ws/privacy/allowed.bin', buffer: marker }).catch((e) => e);
  check('a confirmed-private bucket allows a normal write',
    okWrite?.sha256 === crypto.createHash('sha256').update(marker).digest('hex'), okWrite?.code);

  const callsAfterFirst = privacyCalls();
  await storage.putObject({ key: 'ws/privacy/allowed-2.bin', buffer: marker });
  check('the confirmation is cached — the next write pays no second metadata GET', privacyCalls() === callsAfterFirst);
  check('…and the cached path still reached the upload endpoint', uploadCalls() === uploadsBefore + 2);

  const forced = await storage.bucketPrivacy({ force: true });
  check('force bypasses the cache and reports a FRESH check (a cache is never presented as fresh)',
    forced.cached === false && forced.checked === true && privacyCalls() === callsAfterFirst + 1);
  const cachedView = await storage.bucketPrivacy();
  check('an unforced check inside the window is labelled cached, with its age and timestamp',
    cachedView.cached === true && cachedView.checked === true && cachedView.ageMs >= 0 && Boolean(cachedView.checkedAt));

  // A PUBLIC bucket is refused BEFORE an upload is attempted.
  bucketPublic = true;
  storage.resetBucketPrivacyCache();
  const uploadsBeforePublic = uploadCalls();
  const publicWrite = await storage.putObject({ key: 'ws/privacy/blocked.bin', buffer: marker }).catch((e) => e);
  check('a PUBLIC bucket blocks the write with STORAGE_BUCKET_PUBLIC (503)',
    publicWrite?.code === 'STORAGE_BUCKET_PUBLIC' && publicWrite?.status === 503, publicWrite?.code);
  check('the public-bucket refusal names the fix and warns about objects already written',
    /Public bucket: off/.test(publicWrite?.message || '') &&
      /review any object written while it was public/.test(publicWrite?.message || ''),
    String(publicWrite?.message || '').slice(0, 120));
  check('no upload was attempted while the bucket was public', uploadCalls() === uploadsBeforePublic);
  check('the refusal never contains the credential', !String(publicWrite?.message || '').includes(SECRET_KEY));

  const stPublic = await storage.objectStoreStatus({ probe: true });
  check('status reports storage blocked and unusable when the bucket is public',
    stPublic.usable === false && stPublic.writesBlocked === true && stPublic.privacy?.public === true &&
      stPublic.errorCode === 'STORAGE_BUCKET_PUBLIC',
    JSON.stringify({ usable: stPublic.usable, writesBlocked: stPublic.writesBlocked, code: stPublic.errorCode }));

  bucketPublic = false;

  // Every unverifiable shape must fail closed, never proceed and never fall back.
  for (const mode of ['missing', '500', 'no-public', 'string-public', 'not-json', 'wrong-identity']) {
    bucketDetailsMode = mode;
    storage.resetBucketPrivacyCache();
    const attempted = await storage.putObject({ key: `ws/privacy/${mode}.bin`, buffer: marker }).catch((e) => e);
    check(`a ${mode} bucket-details response fails CLOSED (STORAGE_PRIVACY_UNVERIFIED)`,
      attempted?.code === 'STORAGE_PRIVACY_UNVERIFIED', attempted?.code);
  }
  bucketDetailsMode = 'ok';

  // A privacy-check TIMEOUT must not become a filesystem write.
  bucketDetailsMode = 'hang';
  process.env.STORAGE_PRIVACY_TIMEOUT_MS = '250';
  storage.resetBucketPrivacyCache();
  const uploadsBeforeTimeout = uploadCalls();
  const started = Date.now();
  const timedOut = await storage.putObject({ key: 'ws/privacy/timeout.bin', buffer: marker }).catch((e) => e);
  const elapsed = Date.now() - started;
  check('a privacy-check TIMEOUT fails closed instead of falling back',
    timedOut?.code === 'STORAGE_PRIVACY_UNVERIFIED' && elapsed < 5000, `${timedOut?.code} after ${elapsed}ms`);
  check('…and no upload was attempted on timeout', uploadCalls() === uploadsBeforeTimeout);
  delete process.env.STORAGE_PRIVACY_TIMEOUT_MS;
  bucketDetailsMode = 'ok';
  for (const res of hangingBucketResponses.splice(0)) {
    try { json(res, 200, { id: BUCKET, name: BUCKET, public: false }); } catch { /* client already gave up */ }
  }

  // Status must distinguish "not verified" from "confirmed private".
  storage.resetBucketPrivacyCache();
  const unknownStatus = await storage.objectStoreStatus({ probe: false });
  check('status distinguishes UNVERIFIED privacy (probe off, no cache) from confirmed private',
    unknownStatus.privacy?.private === null && unknownStatus.privacy?.checked === false &&
      unknownStatus.writesBlocked === true && /not been checked/.test(unknownStatus.privacy?.reason || ''),
    JSON.stringify(unknownStatus.privacy));
  const privateStatus = await storage.objectStoreStatus({ probe: true });
  check('status confirms private storage with its verification time after a probe',
    privateStatus.usable === true && privateStatus.writesBlocked === false &&
      privateStatus.privacy?.private === true && privateStatus.privacy?.cached === false &&
      Boolean(privateStatus.privacy?.checkedAt), JSON.stringify(privateStatus.privacy));

  // The ordinary contract is unchanged for a private bucket.
  const survivor = await storage.putObject({ key: 'ws/privacy/survivor.bin', buffer: marker });
  check('upload/read-back still work for a private bucket after the guard was exercised',
    survivor?.sha256 && (await storage.getObject('ws/privacy/survivor.bin'))?.length === marker.length);
  check('listing still finds it', (await storage.findObjectByPrefix('ws/privacy/survivor'))?.key === 'ws/privacy/survivor.bin');
  await storage.deleteObject('ws/privacy/survivor.bin');
  check('deletion still works', (await storage.headObject('ws/privacy/survivor.bin')) === null);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\nSUPABASE STORAGE RESULT: ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
