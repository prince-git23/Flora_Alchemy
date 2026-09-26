/**
 * Phase 14 integration smoke tests — admin users, notifications,
 * collection CRUD, upload authorization + REAL multipart upload,
 * product edit/delete consistency, custom requests.
 *
 * Self-contained: boots its OWN backend (port 4094) against its OWN database
 * (Flora-Alchemy-Test-Integration). No dev server required (Phase 16).
 *
 * Run: node scripts/integration-smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootTestServer, stopTestServer } from './lib/testServer.mjs';

const { child: API_CHILD, base: API_BASE } = await bootTestServer({
  port: 4094,
  db: 'Flora-Alchemy-Test-Integration',
  label: 'integration-smoke',
});
const BASE = `${API_BASE}/api`;

let passed = 0;
let failed = 0;
const failures = [];

async function req(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* binary */ }
  return { status: res.status, json };
}

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

async function main() {
  const stamp = Date.now();

  console.log('\n— SETUP —');
  let r = await req('POST', '/auth/login', { body: { email: 'handler.admin@flora-alchemy.demo', password: 'handler1234' } });
  check('admin login', r.status === 200);
  const ADMIN = r.json.token;

  r = await req('POST', '/auth/register', { body: { name: 'Integration A', email: `int-a-${stamp}@example.com`, password: 'secret123' } });
  check('customer registered', r.status === 201);
  const CUSTOMER = r.json.token;

  console.log('\n— ADMIN USER CRUD —');
  r = await req('GET', '/admin/users', { token: CUSTOMER });
  check('customer cannot list operators → 403', r.status === 403);
  r = await req('GET', '/admin/users');
  check('anonymous cannot list operators → 401', r.status === 401);
  r = await req('GET', '/admin/users', { token: ADMIN });
  check('admin lists operators → 200', r.status === 200 && Array.isArray(r.json.operators));
  check('no password hashes leak', r.json.operators.every((o) => o.passwordHash === undefined && o.password === undefined));

  r = await req('POST', '/admin/users', {
    token: ADMIN,
    body: { name: 'Test Handler', email: `handler-${stamp}@example.com`, role: 'HANDLER', password: 'temppass123' },
  });
  check('admin creates handler → 201', r.status === 201, JSON.stringify(r.json).slice(0, 150));
  const NEW_OP_ID = r.json.operator?.id;
  check('created operator has handler role', r.json.operator?.role === 'HANDLER');
  check('no tempPassword echo when explicit password given', r.json.tempPassword === undefined);

  r = await req('POST', '/admin/users', {
    token: ADMIN,
    body: { name: 'Dup Op', email: `handler-${stamp}@example.com`, role: 'HANDLER' },
  });
  check('duplicate operator email → 409', r.status === 409);

  // Phase 21 owner matrix — minting an administrator is owner-only on every
  // surface (staffController already refused it; /admin/users must match).
  r = await req('PATCH', `/admin/users/${NEW_OP_ID}/role`, { token: ADMIN, body: { role: 'admin' } });
  check('non-owner admin cannot mint an administrator → 403 OWNER_REQUIRED', r.status === 403 && r.json?.code === 'OWNER_REQUIRED', `${r.status} ${r.json?.code}`);

  // New operator can actually log in — proves the account is real.
  r = await req('POST', '/auth/login', { body: { email: `handler-${stamp}@example.com`, password: 'temppass123' } });
  check('created operator can log in', r.status === 200 && ['admin', 'handler'].includes(r.json.user?.role));

  r = await req('DELETE', `/admin/users/${NEW_OP_ID}`, { token: ADMIN });
  check('admin deletes operator → 200', r.status === 200);

  console.log('\n— NOTIFICATIONS —');
  r = await req('GET', '/notifications', { token: ADMIN });
  check('admin reads notifications → 200', r.status === 200 && Array.isArray(r.json.notifications) && typeof r.json.unreadCount === 'number');
  r = await req('GET', '/notifications', { token: CUSTOMER });
  check('customer reads own notifications → 200', r.status === 200);
  r = await req('GET', '/notifications');
  check('anonymous notifications → 401', r.status === 401);
  r = await req('GET', '/notifications/unread-count', { token: ADMIN });
  check('unread count endpoint → 200', r.status === 200 && typeof r.json.unreadCount === 'number');
  r = await req('PATCH', '/notifications/read-all', { token: ADMIN });
  check('mark all read → 200 unreadCount 0', r.status === 200 && r.json.unreadCount === 0);

  // Real event → notification: creating an order must notify staff.
  // Self-contained: create a dedicated product so the test never depends on
  // fixture stock (a persistent test DB depletes fixture stock across runs,
  // which made this check flaky with 409/422 order failures).
  r = await req('POST', '/products', { token: ADMIN, body: { name: `Notif Order Posy ${stamp}`, price: 250, initialStock: 50 } });
  check('notification-test product created', r.status === 201, JSON.stringify(r.json).slice(0, 120));
  const NOTIF_SLUG = r.json.product?.slug;
  r = await req('POST', '/orders', {
    token: CUSTOMER,
    body: {
      items: [{ productSlug: NOTIF_SLUG, quantity: 1 }],
      shippingAddress: { name: 'Integration A', address: '1 Test St', city: 'Mumbai', state: 'MH', pincode: '400001' },
    },
  });
  check('order created (notification source event)', r.status === 201, JSON.stringify(r.json).slice(0, 150));
  const NOTIF_ORDER = r.json.order?.orderId;
  r = await req('GET', '/notifications', { token: ADMIN });
  const hasNewOrderNotif = (r.json.notifications || []).some((n) => n.type === 'new_order' && n.title.includes(NOTIF_ORDER));
  check('new order generated a staff notification', hasNewOrderNotif, `looking for ${NOTIF_ORDER}`);

  // Mark one notification read and verify unreadCount decrements.
  const firstUnread = (r.json.notifications || []).find((n) => !n.read);
  if (firstUnread) {
    r = await req('PATCH', `/notifications/${firstUnread._id}/read`, { token: ADMIN });
    check('mark single read → 200', r.status === 200 && r.json.notification?.read === true);
  } else {
    check('mark single read → 200', false, 'no unread notification found to test');
  }

  console.log('\n— PRODUCT EDIT + INVENTORY CONSISTENCY —');
  r = await req('POST', '/products', { token: ADMIN, body: { name: `Edit Test Posy ${stamp}`, price: 700, initialStock: 10, reorderLevel: 4 } });
  check('product created with inventory params → 201', r.status === 201);
  const SLUG = r.json.product?.slug;

  r = await req('PATCH', `/products/${SLUG}`, { token: ADMIN, body: { description: 'Updated description', price: 825 } });
  check('product edit persists', r.status === 200 && r.json.product?.price === 825 && r.json.product?.description === 'Updated description');

  r = await req('GET', '/inventory', { token: ADMIN });
  const inv = r.json.inventory.find((i) => i.productSlug === SLUG);
  check('inventory created with initial stock', !!inv && inv.currentStock === 10 && inv.reorderLevel === 4);

  r = await req('DELETE', `/products/${SLUG}`, { token: ADMIN });
  check('product deleted → 200', r.status === 200);
  r = await req('GET', '/inventory', { token: ADMIN });
  check('inventory record removed with product (no orphan)', !r.json.inventory.find((i) => i.productSlug === SLUG));

  // Re-create same name → must NOT hit orphaned inventory unique index.
  r = await req('POST', '/products', { token: ADMIN, body: { name: `Edit Test Posy ${stamp}`, price: 700, initialStock: 3 } });
  check('re-create same product name succeeds (no orphan inventory)', r.status === 201, JSON.stringify(r.json).slice(0, 150));
  await req('DELETE', `/products/${SLUG}`, { token: ADMIN });

  console.log('\n— COLLECTION CRUD —');
  r = await req('POST', '/collections', {
    token: ADMIN,
    body: { name: `Integration Collection ${stamp}`, description: 'Created by integration smoke', productSlugs: ['desk-bloom-ceramic-pot'], visibility: 'Visible' },
  });
  check('collection created → 201', r.status === 201);
  const COL = r.json.collection?.slug;
  r = await req('PATCH', `/collections/${COL}`, {
    token: ADMIN,
    body: { description: 'Updated description', productSlugs: ['desk-bloom-ceramic-pot', 'botanical-wax-seal-kit'], visibility: 'Hidden' },
  });
  check('collection edit persists', r.status === 200 && r.json.collection?.description === 'Updated description' && r.json.collection?.productSlugs?.length === 2);
  r = await req('GET', `/collections/${COL}`);
  check('hidden collection hidden from public → 404', r.status === 404);
  r = await req('DELETE', `/collections/${COL}`, { token: ADMIN });
  check('collection deleted → 200', r.status === 200);

  console.log('\n— UPLOAD: AUTHORIZATION + REAL MULTIPART —');
  r = await req('POST', '/uploads/product-image');
  check('anonymous upload → 401', r.status === 401);
  r = await req('POST', '/uploads/product-image', { token: CUSTOMER });
  check('customer upload → 403', r.status === 403);

  // Real multipart upload as staff — Phase 14 regression (real image upload).
  const pngBytes = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
    'hex'
  );
  async function multipartUpload(token, buf, mime, filename, base = BASE) {
    const form = new FormData();
    form.append('image', new Blob([buf], { type: mime }), filename);
    const res = await fetch(`${base}/uploads/product-image`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    let json = null;
    try { json = await res.json(); } catch { /* binary */ }
    return { status: res.status, json };
  }
  const up = await multipartUpload(ADMIN, pngBytes, 'image/png', 'vax-seal.png');
  check('staff multipart upload → 201 with url', up.status === 201 && typeof up.json.url === 'string' && up.json.url.length > 0, JSON.stringify(up.json).slice(0, 120));
  check('upload reports local provider (no ImageKit creds)', up.json.provider === 'local', String(up.json.provider));
  check('stored filename is server-generated (no original name)', /\/uploads\/product-\d+-[0-9a-f]+\.png$/.test(up.json.url || ''), up.json.url);
  {
    const storedPath = path.resolve('..', 'frontend', 'public', up.json.url.replace(/^\//, ''));
    check('file actually persisted to disk', fs.existsSync(storedPath), storedPath);
    if (fs.existsSync(storedPath)) fs.unlinkSync(storedPath); // cleanup test artifact
  }
  const upText = await multipartUpload(ADMIN, Buffer.from('<?php echo 1; ?>'), 'application/php', 'evil.php');
  check('non-image MIME rejected → 422', upText.status === 422, String(upText.status));
  const upBig = await multipartUpload(ADMIN, Buffer.alloc(5 * 1024 * 1024 + 10, 0x41), 'image/png', 'big.png');
  check('oversized upload rejected → 413/422', [413, 422].includes(upBig.status), String(upBig.status));
  // Uploaded URL must be usable on a real product (storefront contract).
  r = await req('POST', '/products', { token: ADMIN, body: { name: `Upload Posy ${stamp}`, price: 300, images: [up.json.url] } });
  check('uploaded URL accepted on product create', r.status === 201, JSON.stringify(r.json).slice(0, 120));
  await req('DELETE', `/products/${r.json.product?.slug}`, { token: ADMIN });

  console.log('\n— CUSTOM REQUESTS (customer ↔ staff lifecycle) —');
  r = await req('POST', '/custom-requests', {
    token: CUSTOMER,
    body: { description: 'A peony and ranunculus bridal posy with gold ribbon', occasion: 'Wedding', budget: '₹3000-5000', colors: 'Blush & Gold' },
  });
  check('customer submits custom request → 201', r.status === 201, JSON.stringify(r.json).slice(0, 150));
  const CR_ID = r.json.request?._id || r.json.request?.id;
  check('request starts pending', r.json.request?.status === 'pending');
  r = await req('GET', '/custom-requests/mine', { token: CUSTOMER });
  check('customer lists own requests', r.status === 200 && (r.json.requests || []).some((x) => String(x._id) === String(CR_ID)));
  check('adminNotes withheld from customer payload', (r.json.requests || []).every((x) => x.adminNotes === undefined));
  r = await req('POST', '/custom-requests', { token: CUSTOMER, body: { description: 'short' } });
  check('too-short description rejected → 422', r.status === 422);
  r = await req('POST', '/custom-requests');
  check('anonymous submission → 401', r.status === 401);
  r = await req('GET', '/custom-requests');
  check('anonymous cannot list all requests → 401', r.status === 401);
  r = await req('GET', '/custom-requests', { token: CUSTOMER });
  check('customer cannot list ALL requests → 403', r.status === 403);
  r = await req('PATCH', `/custom-requests/${CR_ID}/status`, { token: CUSTOMER, body: { status: 'accepted' } });
  check('customer cannot update request status → 403', r.status === 403);
  r = await req('GET', '/custom-requests', { token: ADMIN });
  check('staff lists all requests → 200', r.status === 200 && (r.json.requests || []).some((x) => String(x._id) === String(CR_ID)));
  r = await req('PATCH', `/custom-requests/${CR_ID}/status`, { token: ADMIN, body: { status: 'reviewing' } });
  check('staff updates status → 200', r.status === 200 && r.json.request?.status === 'reviewing');
  r = await req('PATCH', `/custom-requests/${CR_ID}/status`, { token: ADMIN, body: { status: 'quoted', adminNotes: 'Quote ₹4,200 — peony sourcing' } });
  check('staff sets status + admin notes', r.status === 200 && r.json.request?.adminNotes === 'Quote ₹4,200 — peony sourcing');
  r = await req('PATCH', `/custom-requests/${CR_ID}/status`, { token: ADMIN, body: { status: 'exploded' } });
  check('invalid status enum rejected → 422', r.status === 422);
  r = await req('PATCH', '/custom-requests/000000000000000000000000/status', { token: ADMIN, body: { status: 'quoted' } });
  check('unknown request id → 404', r.status === 404);
  // Customer sees the status update but never the admin notes.
  r = await req('GET', '/custom-requests/mine', { token: CUSTOMER });
  const mine = (r.json.requests || []).find((x) => String(x._id) === String(CR_ID));
  check('customer sees staff status update', mine?.status === 'quoted');
  check('adminNotes still hidden after staff update', mine?.adminNotes === undefined);

  console.log('\n— UPLOAD STORAGE: PHASE 15A REGRESSION —');
  // Phase 15A: the upload controller must never crash startup on an
  // unwritable/absent local dir when ImageKit is configured, and must
  // lazily create a valid writable dir when falling back to local storage.
  //
  // Test A: boot a server WITH fake ImageKit creds against an UNUSABLE
  // UPLOAD_DIR (a path under a *file*, so mkdir must fail). Startup must
  // succeed and readiness must be OK — no EACCES crash at module load.
  {
    const barrierFile = path.join(os.tmpdir(), `flora-barrier-${stamp}`);
    fs.writeFileSync(barrierFile, 'not a directory');
    const badDir = path.join(barrierFile, 'uploads'); // mkdir here → ENOTDIR/EACCES
    const a = await bootTestServer({
      port: 4095,
      db: 'Flora-Alchemy-Test-UploadIK',
      label: 'upload-ik-startup',
      extraEnv: {
        NODE_ENV: 'development', // keep config validation out of the picture
        UPLOAD_DIR: badDir,
        IMAGEKIT_PRIVATE_KEY: 'test-private-key',
        IMAGEKIT_PUBLIC_KEY: 'test-public-key',
        IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/test-endpoint',
      },
    });
    try {
      const h = await fetch(`${a.base}/api/health`);
      check('A: server with ImageKit + unusable local dir boots', h.ok);
      const rd = await fetch(`${a.base}/api/readiness`);
      check('A: readiness ready with ImageKit + unusable local dir', rd.ok);
    } finally {
      await stopTestServer(a.child, a.base); // await so port 4095 frees before Test B
      fs.unlinkSync(barrierFile); // cleanup barrier
    }
  }

  // Test B/C: boot a server WITHOUT ImageKit and a custom UPLOAD_DIR under
  // the OS temp dir. Startup must succeed, a real multipart upload must
  // lazily create the directory, persist the file there, and return a
  // local-provider URL.
  {
    const customDir = path.join(os.tmpdir(), `flora-uploads-${stamp}`);
    const b = await bootTestServer({
      port: 4097, // 4096 is held by a local proxy controller on some dev machines
      db: 'Flora-Alchemy-Test-UploadLocal',
      label: 'upload-local-startup',
      extraEnv: {
        NODE_ENV: 'development',
        UPLOAD_DIR: customDir,
        IMAGEKIT_PRIVATE_KEY: '',
        IMAGEKIT_PUBLIC_KEY: '',
        IMAGEKIT_URL_ENDPOINT: '',
      },
    });
    try {
      const h = await fetch(`${b.base}/api/health`);
      check('B: server without ImageKit boots', h.ok);
      check('B: local dir NOT created at startup (lazy)', !fs.existsSync(customDir), customDir);

      const bl = await fetch(`${b.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'handler.admin@flora-alchemy.demo', password: 'handler1234' }) });
      const BADMIN = (await bl.json()).token;
      const upB = await multipartUpload(BADMIN, pngBytes, 'image/png', 'lazy-dir.png', `${b.base}/api`);
      check('B: upload succeeds → 201', upB.status === 201, JSON.stringify(upB.json).slice(0, 120));
      check('B: local dir lazily created on first upload', fs.existsSync(customDir), customDir);
      const storedName = (upB.json.url || '').replace('/uploads/', '');
      check('B: file persisted into custom UPLOAD_DIR', storedName && fs.existsSync(path.join(customDir, storedName)), upB.json.url);
      check('B: provider reported as local', upB.json.provider === 'local');
      if (storedName && fs.existsSync(path.join(customDir, storedName))) {
        fs.rmSync(customDir, { recursive: true, force: true }); // cleanup
      }
    } finally {
      await stopTestServer(b.child, b.base);
    }
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`INTEGRATION RESULT: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILURES:', failures.join(' | ')); process.exit(1); }
  console.log('ALL INTEGRATION TESTS PASSED');
}

main().catch((err) => {
  console.error('INTEGRATION RUNNER ERROR:', err);
  process.exitCode = 1;
}).finally(() => {
  stopTestServer(API_CHILD);
});
