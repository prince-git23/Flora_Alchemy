/**
 * PHASE 4 — E2E stack bootstrapper.
 *
 * Brings up the two processes a real browser needs, so the Playwright suite
 * drives the ACTUAL application rather than a mock:
 *
 *   1. an isolated backend on :4000, booted through the same
 *      `bootTestServer` helper every backend smoke suite uses — which fails
 *      closed unless the database name carries a disposable marker, so an
 *      E2E run can never touch dev or production data.
 *   2. `vite preview` on :4300 serving the PRODUCTION bundle from frontend/dist
 *      (the same artifact `npm run build` emits and the deploy ships).
 *
 * Why this shape:
 *   - the frontend inlines VITE_API_URL at BUILD time, and the default is
 *     http://localhost:4000/api — so the built bundle talks to :4000 as-is and
 *     the backend must therefore live on :4000. No rebuild dance, and the
 *     grades come from the artifact customers actually download.
 *   - Playwright owns this file as its `webServer` command, so `npx playwright
 *     test` is the whole entry point; nothing has to be started by hand.
 *
 * Provider credentials are deliberately BLANKED for the suite:
 *   - Razorpay: no live or sandbox charge can ever occur. The backend then
 *     answers PAYMENT_NOT_CONFIGURED and checkout exercises its documented
 *     honest fallback (paymentStatus 'Sample') — the real code path, no money.
 *   - ImageKit: uploads land on the backend's local-storage path, which is
 *     fully verifiable on disk instead of depending on a third-party service.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import {
  bootTestServer,
  stopTestServer,
  loadBackendEnv,
  testMongoUri,
} from '../../backend/scripts/lib/testServer.mjs';
import { dbNameFromUri, isDisposableDbName } from '../../backend/utils/environmentGuard.js';
import { DEMO_CUSTOMER, DEMO_HANDLER } from '../../backend/seed/fixtures.js';
/* The seeded catalogue rows — the same numbers the seed writes, so the reset
   below cannot drift from the seed. */
import { FIXTURE_PRODUCTS } from '../../backend/seed/seed.js';

const FRONTEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const API_PORT = Number(process.env.E2E_API_PORT || 4000);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 4300);
const WEB_HOST = '127.0.0.1';
const WEB_ORIGIN = `http://${WEB_HOST}:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const DB_NAME = process.env.E2E_DB || 'Flora-Alchemy-Test-E2E';

/** The one shop the suite exercises, and the seeded staff identity inside it. */
export const SHOP_SLUG = 'e2e-botanical-studio';
const SHOP_NAME = 'E2E Botanical Studio';
const SEED_ADMIN_EMAIL = DEMO_HANDLER.email;
const SEED_CUSTOMER_EMAIL = DEMO_CUSTOMER.email;
const SEED_PRODUCT_SLUG = 'dusty-rose-lavender-posy';

/** Order reference the stack creates for review eligibility (exported for specs). */
export const DELIVERED_ORDER_ID = 'FA-E2E-1001';

/** A second, unrelated tenant used to prove shop isolation. */
export const SECOND_SHOP_SLUG = 'e2e-second-atelier';
const SECOND_SHOP_NAME = 'E2E Second Atelier';
const SECOND_SHOP_PRODUCT_SLUG = 'pressed-wildflower-cards';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(url) {
  try {
    const r = await fetch(url, { redirect: 'manual' });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(url, label, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await up(url)) return true;
    if (child && child.exitCode !== null) {
      console.error(`[e2e-stack] ${label} exited early (code ${child.exitCode})`);
      return false;
    }
    await sleep(300);
  }
  console.error(`[e2e-stack] ${label} did not answer ${url} within ${timeoutMs}ms`);
  return false;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  } catch {
    /* already gone */
  }
}

/**
 * The backend seed deliberately ships no Workspace: fixture documents must
 * never describe a tenant that does not exist, so seeding one would violate
 * the tenancy rules the suites exist to protect.
 *
 * Shop-scoped journeys (public shop address, shop attribution, the shop lock
 * on a custom request, the staff portal) therefore need a tenant created the
 * same way every backend suite creates one — `Workspace.create({ slug,
 * displayName })`, which defaults to ACTIVE, followed by attaching the seeded
 * catalogue and the seeded administrator to it. This runs ONLY against the
 * disposable test database derived from MONGO_URI.
 */
async function provisionTenant() {
  loadBackendEnv();
  const uri = testMongoUri(process.env.MONGO_URI, DB_NAME);
  if (!uri) throw new Error('MONGO_URI is not configured — cannot derive the E2E database.');

  const [
    { default: mongoose },
    { default: Workspace },
    { default: Product },
    { default: User },
    { default: Customer },
    { default: Order },
    { default: Inventory },
    { default: Review },
    { default: Wishlist },
  ] = await Promise.all([
    import('../../backend/node_modules/mongoose/index.js'),
    import('../../backend/models/Workspace.js'),
    import('../../backend/models/Product.js'),
    import('../../backend/models/User.js'),
    import('../../backend/models/Customer.js'),
    import('../../backend/models/Order.js'),
    import('../../backend/models/Inventory.js'),
    import('../../backend/models/Review.js'),
    import('../../backend/models/Wishlist.js'),
  ]);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });
  try {
    const ws = await Workspace.findOneAndUpdate(
      { slug: SHOP_SLUG },
      { $set: { displayName: SHOP_NAME, status: 'ACTIVE' }, $setOnInsert: { slug: SHOP_SLUG } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    /* The whole seeded catalogue belongs to this one shop, so a product page
       can show real shop attribution and the cart can group by shop. */
    const { modifiedCount } = await Product.updateMany(
      {},
      { $set: { workspaceId: ws._id } }
    );

    /* The seeded administrator works inside the same tenant, which is what the
       staff portal and the moderation console require. */
    await User.updateOne({ email: SEED_ADMIN_EMAIL }, { $set: { workspaceId: ws._id } });

    console.log(
      `[e2e-stack] tenant ready: ${SHOP_SLUG} (${ws.status}); products attached: ${modifiedCount}`
    );

    /* INVENTORY RESET. Checkout decrements real stock — that is the behaviour
       the suite verifies, so it must not be stubbed. But the database outlives
       the run, and the suite places several real orders against the same seeded
       piece, so without a reset the second or third run starts against a shop
       that has sold out and fails with "just went out of stock" instead of on
       the behaviour under test. Restoring the SEED's own levels (never a
       made-up one) makes every run start from the same world. */
    let restocked = 0;
    for (const p of FIXTURE_PRODUCTS) {
      const { matchedCount } = await Inventory.updateOne(
        { productSlug: p.slug },
        { $set: { currentStock: p.stock, reorderLevel: p.reorder, productName: p.name, sku: p.sku } }
      );
      if (matchedCount > 0) restocked += 1;
    }
    console.log(`[e2e-stack] inventory restored to seed levels: ${restocked} rows`);

    /* A SECOND, independent tenant. Without it "one order, one shop" and the
       multi-shop cart cannot be exercised at all: the refusal is the point of
       the rule, and a single-tenant database can never trigger it. */
    const ws2 = await Workspace.findOneAndUpdate(
      { slug: SECOND_SHOP_SLUG },
      { $set: { displayName: SECOND_SHOP_NAME, status: 'ACTIVE' }, $setOnInsert: { slug: SECOND_SHOP_SLUG } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await Product.updateOne(
      { slug: SECOND_SHOP_PRODUCT_SLUG },
      { $set: { workspaceId: ws2._id } }
    );
    await Inventory.updateOne(
      { productSlug: SECOND_SHOP_PRODUCT_SLUG },
      { $set: { workspaceId: ws2._id } }
    );
    console.log(`[e2e-stack] second tenant ready: ${SECOND_SHOP_SLUG}`);

    await provisionDeliveredOrder({ Product, Customer, Order, Review, Wishlist, workspaceId: ws._id });
  } finally {
    await mongoose.disconnect();
  }
}

/**
 * Reviews are reachable only through a real eligible purchase, so the suite
 * needs one DELIVERED order belonging to the seeded demo customer.
 *
 * The order is written directly (the same way seed.js does it) rather than by
 * driving checkout, because the point of the review journey is the review —
 * checkout has its own journey elsewhere in the suite.
 */
async function provisionDeliveredOrder({ Product, Customer, Order, Review, Wishlist, workspaceId }) {
  const product = await Product.findOne({ slug: SEED_PRODUCT_SLUG }).lean();
  if (!product) throw new Error(`seed product ${SEED_PRODUCT_SLUG} is missing — cannot build the review fixture.`);

  const customer = await Customer.findOne({ email: SEED_CUSTOMER_EMAIL });
  if (!customer) throw new Error(`seed customer ${SEED_CUSTOMER_EMAIL} is missing — cannot build the review fixture.`);

  const orderId = 'FA-E2E-1001';
  const price = product.price;
  await Order.updateOne(
    { orderId },
    {
      $set: {
        orderId,
        customerId: customer._id,
        customerName: customer.name,
        customerEmail: customer.email,
        workspaceId,
        items: [
          {
            productSlug: product.slug,
            name: product.name,
            price,
            quantity: 1,
            isCatalogue: true,
            image: product.image || '',
          },
        ],
        subtotal: price,
        shipping: 0,
        total: price,
        paymentStatus: 'Paid',
        paymentMethod: 'Sample',
        orderStatus: 'delivered',
        statusHistory: [{ status: 'delivered', note: 'E2E review-eligibility fixture' }],
        isFixture: true,
      },
    },
    { upsert: true }
  );
  console.log(`[e2e-stack] delivered order ready: ${orderId} for ${SEED_CUSTOMER_EMAIL}`);

  /* RE-RUNNABLE FIXTURES. The review journeys submit real reviews through the
     real endpoint, and the rule is one review per (product, customer) — so a
     second run would meet its own data and fail on the duplicate rule instead
     of on the behaviour under test. This database exists only for this suite
     (the guard above proves that), and the fixtures are the suite's own, so
     they are reset at boot. Nothing else is touched: no other customer's
     review, no product, no order. */
  const { deletedCount } = await Review.deleteMany({ customerId: customer._id });
  console.log(`[e2e-stack] reviews reset for ${SEED_CUSTOMER_EMAIL}: ${deletedCount} removed`);

  /* The wishlist is SERVER-side, so a saved product outlives the browser and
     would make "save → see it → remove it" depend on which run came before
     (the toggle would start from saved and unsave it). Reset the suite's own
     customer only. */
  const wishlists = await Wishlist.deleteMany({ customerId: customer._id });
  console.log(`[e2e-stack] wishlist reset for ${SEED_CUSTOMER_EMAIL}: ${wishlists.deletedCount} removed`);
}

/**
 * SAFETY GATE 1 — the bundle must not talk to a live API.
 *
 * The app inlines VITE_API_URL at BUILD time, and frontend/.env holds the
 * DEPLOYED origin. A build made with that value would point every browser
 * request — including checkout, which creates real orders — at production.
 * The suite is therefore only allowed to run against a bundle whose API origin
 * is loopback. This is checked against the emitted artifact, not the intent of
 * whoever ran the build, and it fails closed: an unreadable bundle is refused.
 */
function assertBundleTargetsLoopback() {
  const assetsDir = path.join(FRONTEND_DIR, 'dist', 'assets');
  if (!existsSync(assetsDir)) {
    console.error('[e2e-stack] frontend/dist/assets is missing — run `npm run build:e2e` first.');
    process.exit(1);
  }

  const bundles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  const origins = new Set();
  for (const file of bundles) {
    const src = readFileSync(path.join(assetsDir, file), 'utf8');
    for (const m of src.matchAll(/https?:\/\/[^"'`)\s]+?\/api/g)) {
      try {
        origins.add(new URL(m[0]).origin);
      } catch {
        origins.add(m[0]);
      }
    }
  }

  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const foreign = [...origins].filter((o) => {
    try {
      return !LOOPBACK.has(new URL(o).hostname);
    } catch {
      return true;
    }
  });

  if (foreign.length > 0) {
    console.error(
      `[e2e-stack] REFUSING TO RUN: the built bundle points its API at ${foreign.join(', ')}.\n` +
        '            Running the suite would mutate a live environment.\n' +
        '            Rebuild with `npm run build:e2e` (loopback API origin).'
    );
    process.exit(1);
  }
  if (origins.size === 0) {
    console.error(
      '[e2e-stack] REFUSING TO RUN: no API origin could be read from the built bundle, '
      + 'so its target cannot be verified. Rebuild with `npm run build:e2e`.'
    );
    process.exit(1);
  }
  console.log(`[e2e-stack] bundle API origin verified: ${[...origins].join(', ')}`);
}

/**
 * SAFETY GATE 2 — the database must be unmistakably disposable and must not be
 * the configured one. `testMongoUri` enforces this too (and every backend suite
 * relies on it); asserting it before anything is spawned or written keeps the
 * refusal first, loud, and independent of the boot path.
 */
function assertDisposableDatabase() {
  loadBackendEnv();
  const configured = process.env.MONGO_URI;
  if (!configured) {
    console.error('[e2e-stack] MONGO_URI is not configured (backend/.env) — refusing to run.');
    process.exit(1);
  }
  const configuredDb = dbNameFromUri(configured);
  if (!isDisposableDbName(DB_NAME)) {
    console.error(
      `[e2e-stack] REFUSING TO RUN: "${DB_NAME}" carries no test/qa/dev/smoke/sandbox marker.`
    );
    process.exit(1);
  }
  if (configuredDb && configuredDb.toLowerCase() === DB_NAME.toLowerCase()) {
    console.error(
      `[e2e-stack] REFUSING TO RUN: the E2E database resolves to the configured database "${configuredDb}".`
    );
    process.exit(1);
  }
  console.log(
    `[e2e-stack] database guard ok: configured="${configuredDb || '<none>'}" → e2e="${DB_NAME}"`
  );
}

async function main() {
  assertBundleTargetsLoopback();
  assertDisposableDatabase();

  if (!existsSync(path.join(FRONTEND_DIR, 'dist', 'index.html'))) {
    console.error('[e2e-stack] frontend/dist/index.html is missing — run `npm run build:e2e` first.');
    process.exit(1);
  }

  console.log(`[e2e-stack] backend :${API_PORT} → database ${DB_NAME}`);
  /* Two attempts. The backend fails fast when server selection times out
     (5s) — correct behaviour, but on a loaded machine that is an
     environmental hiccup rather than a broken build, and a browser gate must
     not report a false red for it. The failure is printed either way. */
  let api = null;
  for (let attempt = 1; attempt <= 2 && !api; attempt += 1) {
    try {
      ({ child: api } = await bootTestServer({
        port: API_PORT,
        db: DB_NAME,
        label: 'e2e',
        /* A browser gate boots a whole app; on a loaded developer machine the
           Atlas cold connect can outlast the backend suites' 60s default.
           90s per attempt, so the retry still fits inside Playwright's own
           webServer budget (90 + 3 + 90 = 183s). */
        healthTimeoutMs: 90_000,
        extraEnv: {
      // The browser page is served from WEB_ORIGIN, so that origin must be
      // allowed — nothing else local is added.
      CORS_ORIGIN: `${WEB_ORIGIN},http://localhost:${WEB_PORT}`,
      // No charge can be made, on purpose (see the file header).
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '',
      RAZORPAY_WEBHOOK_SECRET: '',
          IMAGEKIT_PRIVATE_KEY: '',
          IMAGEKIT_PUBLIC_KEY: '',
          IMAGEKIT_URL_ENDPOINT: '',
        },
      }));
    } catch (err) {
      console.error(`[e2e-stack] backend boot attempt ${attempt} failed: ${err.message.split('\n')[0]}`);
      if (attempt === 2) throw err;
      await sleep(3_000);
    }
  }
  console.log(`[e2e-stack] backend healthy on ${API_ORIGIN}`);

  await provisionTenant();

  const web = spawn(
    process.execPath,
    [
      path.join(FRONTEND_DIR, 'node_modules', 'vite', 'bin', 'vite.js'),
      'preview',
      '--port', String(WEB_PORT),
      '--strictPort',
      '--host', WEB_HOST,
    ],
    { cwd: FRONTEND_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let webLog = '';
  web.stdout.on('data', (d) => { webLog += d; });
  web.stderr.on('data', (d) => { webLog += d; });

  if (!(await waitFor(`${WEB_ORIGIN}/`, 'vite preview', web, 60000))) {
    console.error(webLog.slice(-600));
    killTree(web);
    await stopTestServer(api, API_ORIGIN);
    process.exit(1);
  }
  console.log(`[e2e-stack] frontend ready on ${WEB_ORIGIN}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('[e2e-stack] shutting down');
    killTree(web);
    await stopTestServer(api, API_ORIGIN);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Playwright tears the webServer down by killing this process, which is why
  // both children are killed explicitly rather than left to the OS.
}

main().catch((err) => {
  console.error('[e2e-stack] fatal:', err && err.message ? err.message : err);
  process.exit(1);
});
