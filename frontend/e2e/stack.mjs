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
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

import {
  bootTestServer,
  stopTestServer,
  loadBackendEnv,
  testMongoUri,
} from '../../backend/scripts/lib/testServer.mjs';
import { dbNameFromUri, isDisposableDbName } from '../../backend/utils/environmentGuard.js';
import { DEMO_CUSTOMER, DEMO_HANDLER } from '../../backend/seed/fixtures.js';
import { makeGlb } from './support/fixtures.js';
/* The seeded catalogue rows — the same numbers the seed writes, so the reset
   below cannot drift from the seed. */
import { FIXTURE_PRODUCTS } from '../../backend/seed/seed.js';
/* The products the 3D Studio spec creates through the real form, shared with
   that spec so the reset below and the spec cannot disagree about what has to
   be cleaned up. */
import { STUDIO_PRODUCT_NAMES, QUALITY_FIXTURES, PROVIDER_SECRET_CANARY } from './support/fixtures.js';

const FRONTEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 3D STUDIO (Phase 3) — the PRIVATE 3D media root for the E2E run, pinned to a
 * path under `e2e/` (gitignored) and handed to the backend child explicitly.
 *
 * Both processes must agree on it: the stack writes the approved fixture model
 * here and the backend serves it from the private root through the public
 * delivery route. Leaving it to the module default would make both sides derive
 * the directory from their own process CWD — which differs here (the stack runs
 * from `frontend/`, the backend from `backend/`) and would silently put the
 * bytes somewhere the server never looks.
 */
const THREE_MEDIA_ROOT = path.join(FRONTEND_DIR, 'e2e', '.media-3d');

const API_PORT = Number(process.env.E2E_API_PORT || 4000);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 4300);
const WEB_HOST = '127.0.0.1';
const WEB_ORIGIN = `http://${WEB_HOST}:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
/**
 * PHASE 6 — the private root for REFERENCE media (Phase 1 cutouts), pinned the
 * same way as the 3D root below and handed to the backend child explicitly, so
 * both processes agree on where a cutout lives. Read by
 * `referenceAssetStorage.js` at import time.
 */
const REFERENCE_MEDIA_DIR = path.join(FRONTEND_DIR, 'e2e', '.media-references');

const DB_NAME = process.env.E2E_DB || 'Flora-Alchemy-Test-E2E';

/** The one shop the suite exercises, and the seeded staff identity inside it. */
export const SHOP_SLUG = 'e2e-botanical-studio';
const SHOP_NAME = 'E2E Botanical Studio';
const SEED_ADMIN_EMAIL = DEMO_HANDLER.email;
const SEED_CUSTOMER_EMAIL = DEMO_CUSTOMER.email;
const SEED_PRODUCT_SLUG = 'dusty-rose-lavender-posy';

/** Order reference the stack creates for review eligibility (exported for specs). */
export const DELIVERED_ORDER_ID = 'FA-E2E-1001';

/* ── PHASE 6 — THE QUALITY-GATE REVIEW FIXTURES ──────────────────────────────
 *
 * WHY THEY EXIST: the quality review panel only renders for a CANDIDATE asset,
 * and nothing in this stack ever created one — so the panel had never been
 * drawn in a browser, which is the exact gap this project was bitten by once
 * before (an unimported icon white-screened the whole studio while every
 * backend assertion stayed green). These fixtures close it permanently.
 *
 * WHAT IS REAL: the reference row, the candidate row, its private bytes, the
 * job row and the quality report. Every one is written through the SHIPPED
 * services (`createCandidateFromGeneration` → `assessAssetQuality`), which is
 * the path a real generation takes; only the BYTES are fixtures.
 *
 * WHAT IS NOT: the geometry and the cutout come from
 * `backend/scripts/lib/meshFixtures.mjs` — deterministic shapes whose answer is
 * known in advance — and every row is labelled `e2e-fixture` /
 * `e2e-fixture-engine`. Nothing here is a generated model, and no report, log
 * line or screen can present one as such.
 *
 * The map itself lives in `support/fixtures.js` so a SPEC can import it without
 * executing this file (see the note there).
 */

/**
 * The OWNER fixture (role admin + `isOwner`, deliberately WITHOUT a workspace —
 * the platform-scoped identity). It exists because ONE portal flow cannot be
 * reached by any other account: signing in at a portal the policy ACCEPTS but
 * that is not the account's own (an owner at `/admin/login`), which is the
 * portal-mismatch notice and hand-over.
 *
 * The email is an identity, the PASSWORD is generated per run and handed to the
 * specs through a gitignored file (`e2e/.owner-credentials.json`) instead of
 * living in source: this account exists only in the disposable E2E database, and
 * a credential that never enters the repository cannot be mistaken for one that
 * does. `seed.js` never creates it — no owner is seeded anywhere.
 */
const OWNER_EMAIL = 'owner@flora-alchemy.demo';
export const OWNER_CREDENTIALS_FILE = path.join(FRONTEND_DIR, 'e2e', '.owner-credentials.json');

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
/**
 * Point BOTH private media roots at this run's E2E directories, before any
 * backend media module is imported in this process.
 *
 * WHY THIS IS ITS OWN FUNCTION, AND WHY IT RUNS FIRST
 * --------------------------------------------------
 * `referenceAssetStorage.js` resolves its root ONCE, at import time. Setting
 * the variable afterwards does not move it: a second `import()` of an already
 * loaded module returns the CACHED module and never re-reads the environment.
 * This file used to set `REFERENCE_MEDIA_DIR` inside the quality-fixture block,
 * but tenant cleanup had already imported the module — so the stack wrote every
 * fixture cutout into the DEFAULT root while the backend child (given the E2E
 * root) read a directory with nothing in it. The damage was invisible at
 * fixture time: the initial assessment ran in THIS process against the module
 * the write used, and reported a healthy IoU. It only surfaced much later, when
 * the browser clicked Approve and the BACKEND re-measured: "The accepted cutout
 * has no bytes." Hence one pinning point, called before the first import, and
 * asserted right after the import so a future reordering fails loudly here
 * instead of as a mystery 422 in a browser suite.
 *
 * (`3dAssetStorage.js` reads its root per call, so it is order-insensitive —
 * but pinning it here too keeps both processes agreeing by construction.)
 */
function pinMediaRoots() {
  process.env.REFERENCE_MEDIA_DIR = REFERENCE_MEDIA_DIR;
  process.env.THREE_MEDIA_ROOT = THREE_MEDIA_ROOT;
}

async function provisionTenant() {
  loadBackendEnv();
  /* Before the first backend media import below. */
  pinMediaRoots();
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
    { default: ProductReferenceImage },
    { default: Product3DAsset },
    { default: GenerationJob },
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
    import('../../backend/models/ProductReferenceImage.js'),
    import('../../backend/models/Product3DAsset.js'),
    import('../../backend/models/GenerationJob.js'),
  ]);

  /* Imported AFTER loadBackendEnv(): the module resolves its media root from
     `REFERENCE_MEDIA_DIR` at import time, so importing it earlier would clean
     the wrong directory. */
  const { removeImageAssets } = await import('../../backend/services/referenceAssetStorage.js');

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

    /* The OWNER identity (role admin + isOwner, deliberately WITHOUT a
       workspace — the platform-scoped owner). The suite needs it for the one
       portal flow no other fixture can reach: an identity signing in at a
       portal the policy ACCEPTS but that is not its own (owner at
       `/admin/login`), which renders the portal-mismatch notice and hands the
       operator over. Written directly, like the other fixtures, and only ever
       against the disposable E2E database guarded at the top of this file. */
    const { default: bcrypt } = await import('../../backend/node_modules/bcryptjs/index.js');
    const ownerPassword = crypto.randomBytes(18).toString('base64url');
    await User.updateOne(
      { email: OWNER_EMAIL },
      {
        $set: {
          email: OWNER_EMAIL,
          name: 'Demo Owner',
          role: 'admin',
          isOwner: true,
          workspaceId: null,
          passwordHash: await bcrypt.hash(ownerPassword, 12),
        },
      },
      { upsert: true }
    );
    /* Hand the generated password to the specs. Written after the user exists,
       so a spec that can read it is a spec whose owner can sign in. */
    writeFileSync(
      OWNER_CREDENTIALS_FILE,
      JSON.stringify({ email: OWNER_EMAIL, password: ownerPassword }),
      'utf8'
    );
    console.log('[e2e-stack] owner fixture ready (platform-scoped, no workspace)');

    /* 3D STUDIO RESET (Phase 1). The studio spec drives the REAL create-product
       form, so it leaves a real product behind — and the prepared reference
       image attached to it — in a database that outlives the run. A second run
       would then meet its own product and fail on the duplicate-name rule
       instead of on the behaviour under test, which is precisely how the first
       pass of that spec failed. Only the suite's own rows are removed: the
       products the spec itself names, the references attached to them, and the
       references left UNATTACHED in the create form — an unattached reference
       can only be a studio leftover here, because nothing else in this database
       ever writes one. Their private media files go with them, so
       `backend/reference-media` does not grow by two photographs per run. */
    const studioNames = Object.values(STUDIO_PRODUCT_NAMES);
    const staleProducts = await Product.find({ name: { $in: studioNames } })
      .select('_id slug name')
      .lean();
    const staleSlugs = staleProducts.map((p) => p.slug);
    const staleRefs = await ProductReferenceImage.find({
      $or: [
        { productId: { $in: staleProducts.map((p) => p._id) } },
        { productSlug: { $in: staleSlugs } },
        { productId: null, productSlug: '' },
      ],
    })
      .select('_id storageNamespace')
      .lean();
    for (const ref of staleRefs) {
      await removeImageAssets(ref._id, ref.storageNamespace || 'platform');
    }
    if (staleRefs.length > 0) {
      await ProductReferenceImage.deleteMany({ _id: { $in: staleRefs.map((r) => r._id) } });
    }
    if (staleProducts.length > 0) {
      await Product.deleteMany({ _id: { $in: staleProducts.map((p) => p._id) } });
      /* A tracked product carries an Inventory row, and the create form gives
         the suite's products stock; the row would otherwise point at a slug
         that no longer exists. */
      await Inventory.deleteMany({ productSlug: { $in: staleSlugs } });
    }
    console.log(
      `[e2e-stack] 3D Studio reset: ${staleProducts.length} product(s), ${staleRefs.length} reference image(s) removed`
    );

    /* 3D STUDIO (Phase 3) — one product with an ADMINISTRATOR-APPROVED model,
       so the storefront's 3D journey has something real to open. Generation
       itself needs a GPU provider and is out of scope for a browser suite, so
       the fixture is written directly: an APPROVED asset row plus a genuine
       glTF Binary container on disk. */
    await provisionApproved3dModel({ Product, Product3DAsset, workspaceSlug: ws.slug });

    /* PHASE 6 — the quality-gate review candidates, so the panel the browser
       suite could never reach now has a fixture behind every state it renders. */
    const adminUser = await User.findOne({ email: SEED_ADMIN_EMAIL }).select('_id').lean();
    await provisionQualityCandidates({
      workspaceSlug: ws.slug,
      workspaceId: ws._id,
      adminId: adminUser?._id || null,
      models: { Product3DAsset, ProductReferenceImage, GenerationJob },
    });

    await provisionDeliveredOrder({ Product, Customer, Order, Review, Wishlist, workspaceId: ws._id });
  } finally {
    await mongoose.disconnect();
  }
}

/**
 * PHASE 6 — provision the quality-gate review candidates (see QUALITY_FIXTURES).
 *
 * Runs inside the stack process against the disposable E2E database, through the
 * same services the running backend uses, so the report the browser reads is the
 * one the server really produced. The intended verdict of every fixture is
 * ASSERTED here: a fixture that drifts (a geometry tweak, a threshold change)
 * fails loudly at boot instead of quietly turning the browser spec into a test
 * of nothing.
 */
async function provisionQualityCandidates({ workspaceSlug, workspaceId, adminId, models }) {
  const { Product3DAsset, ProductReferenceImage, GenerationJob } = models;

  /* The replacement fixture must be the product the APPROVED fixture is
     published for, or that check would quietly test nothing. */
  if (QUALITY_FIXTURES.replacement.productSlug !== SEED_PRODUCT_SLUG) {
    throw new Error(
      '[e2e-stack] QUALITY_FIXTURES.replacement must name the product the approved fixture is ' +
        `published for (${SEED_PRODUCT_SLUG}).`
    );
  }

  pinMediaRoots();

  const [fixturesLib, referenceMedia, storage, assets] = await Promise.all([
    import('../../backend/scripts/lib/meshFixtures.mjs'),
    import('../../backend/services/referenceAssetStorage.js'),
    import('../../backend/services/3dAssetStorage.js'),
    import('../../backend/services/3dAssetService.js'),
  ]);
  const { buildBoxGlb, buildSphereGlb, buildReferencePng } = fixturesLib;

  /* Prove the two processes agree on where a cutout lives — see pinMediaRoots
     for the failure this prevents. */
  const wantedRoot = path.resolve(REFERENCE_MEDIA_DIR);
  if (referenceMedia.mediaRoot() !== wantedRoot) {
    throw new Error(
      `[e2e-stack] reference media root is ${referenceMedia.mediaRoot()} but this run needs ` +
        `${wantedRoot}: the module was imported before pinMediaRoots() ran. Fixture cutouts ` +
        'would be written where the backend will not look for them.'
    );
  }

  /** The `req` shape the services expect: identity + the workspace it acts in. */
  const req = { user: { _id: adminId, role: 'admin', workspaceId }, workspaceSlug };
  const slugs = [...new Set(Object.values(QUALITY_FIXTURES).map((f) => f.productSlug))];

  /* RE-RUNNABLE: this database outlives the run, so the previous run's rows and
     their private files go first — otherwise the fixture files accumulate and a
     second run meets its own leftovers instead of the behaviour under test. */
  /* Everything this function created last run — EXCEPT the approved fixture model
     that `provisionApproved3dModel` publishes for the replacement product. That
     row belongs to the Phase 3 fixture, so deleting it would take the storefront
     model away from a product mid-suite (the first version of this cleanup did
     exactly that, and the replacement check failed with "cannot read properties
     of null" because the product had no live model at all). */
  const owned = {
    productSlug: { $in: slugs },
    $nor: [{ productSlug: SEED_PRODUCT_SLUG, status: 'APPROVED' }],
  };
  const staleAssets = await Product3DAsset.find(owned).select('_id').lean();
  for (const row of staleAssets) await storage.removeAssetFiles(row._id, workspaceSlug);
  await Product3DAsset.deleteMany(owned);
  const staleRefs = await ProductReferenceImage.find({ productSlug: { $in: slugs } })
    .select('_id storageNamespace')
    .lean();
  for (const row of staleRefs) {
    await referenceMedia.removeImageAssets(row._id, row.storageNamespace || workspaceSlug);
  }
  await ProductReferenceImage.deleteMany({ productSlug: { $in: slugs } });
  await GenerationJob.deleteMany({ productSlug: { $in: slugs } });

  /* The known-answer pairings, taken from the Phase 5 suite so the two suites
     cannot disagree about what a box, a sphere or a wide band should score. */
  const boxTall = buildBoxGlb({ width: 1, height: 4, depth: 0.5, segments: 5 });
  const boxWide = buildBoxGlb({ width: 1, height: 8, depth: 1, segments: 5 });
  /* Vertex colours on purpose: the realistic generated asset is colour-per-vertex
     with no texture maps, and that is the material state the panel must describe
     honestly. The view stays ambiguous either way, so it is still a REVIEW. */
  const sphere = buildSphereGlb({ vertexColors: true });
  const [rectTall, rectWide, disc] = await Promise.all([
    buildReferencePng({ width: 50, height: 200 }),
    buildReferencePng({ width: 200, height: 50 }),
    buildReferencePng({ width: 120, height: 120, shape: 'disc' }),
  ]);

  /** An ACCEPTED reference with a REAL cutout on disk, labelled as a fixture. */
  async function makeReference(productSlug, cutout) {
    const doc = await ProductReferenceImage.create({
      workspaceId,
      productSlug,
      status: 'READY',
      accepted: true,
      isPrimary: true,
      order: 0,
      label: 'E2E deterministic fixture (not a generated model)',
      original: { fileName: 'e2e-fixture.png', format: 'png', hasAlpha: true },
      cutout: { format: 'png', hasAlpha: true },
      processing: {
        engine: 'e2e-fixture-engine',
        model: 'deterministic-fixture',
        modelLicence: 'not applicable — a deterministic fixture, no model weights',
        attempts: 1,
        finishedAt: new Date(),
      },
      confidence: 0.95,
      warnings: [],
      isFixture: true,
    });
    const written = await referenceMedia.writeAsset({
      imageId: doc._id,
      workspaceSlug,
      kind: 'cutout',
      buffer: cutout,
      format: 'png',
    });
    doc.cutout = {
      ...(typeof doc.cutout?.toObject === 'function' ? doc.cutout.toObject() : doc.cutout || {}),
      storageKey: written.storageKey,
      bytes: written.bytes,
    };
    await doc.save();

    /* Read it straight back. A cutout key that the server cannot read is the
       difference between a PASS fixture and a 422 discovered three minutes
       later in a browser, so the fixture proves its own bytes exist now. */
    const readBack = await referenceMedia.readAsset(written.storageKey).catch(() => null);
    if (!readBack?.length) {
      throw new Error(
        `[e2e-stack] the fixture cutout for ${productSlug} was written to ` +
          `${written.storageKey} but could not be read back — the report the browser reads ` +
          'would be measuring a reference that is not on disk.'
      );
    }
    return doc;
  }

  /** A candidate made the SHIPPED way, so its report is a real measurement. */
  async function makeCandidate(productSlug, referenceId, glb) {
    const job = await GenerationJob.create({
      workspaceId,
      productSlug,
      status: 'READY_FOR_REVIEW',
      provider: 'e2e-fixture',
      providerModel: 'E2E Fixture Model',
      source: {
        referenceIds: [referenceId],
        viewCount: 1,
        label: 'E2E deterministic fixture (not a generated model)',
      },
      settings: { quality: 'standard', notes: '' },
      createdBy: adminId,
    });
    const asset = await assets.createCandidateFromGeneration(req, { job, glbBuffer: glb });
    return { job, asset };
  }

  const plan = [
    { key: 'pass', glb: boxTall, cutout: rectTall },
    { key: 'review', glb: sphere, cutout: disc },
    { key: 'blocked', glb: boxWide, cutout: rectWide },
    { key: 'stale', glb: boxTall, cutout: rectTall },
    { key: 'failed', glb: boxTall, cutout: rectTall },
    { key: 'replacement', glb: sphere, cutout: disc },
  ];

  for (const item of plan) {
    const fixture = QUALITY_FIXTURES[item.key];
    const reference = await makeReference(fixture.productSlug, item.cutout);
    const { asset } = await makeCandidate(fixture.productSlug, reference._id, item.glb);

    if (fixture.stale) {
      /* The generation settings are part of the fingerprint, so changing one is
         exactly the "assessment settings changed" case the rules name. The bytes
         and the references are deliberately untouched. */
      asset.settings.quality = 'high';
      await asset.save();
    }
    if (fixture.assessmentFailed) {
      /* Remove the stored model itself and re-assess: the assessment genuinely
         cannot read bytes that are gone, so the failure state is real rather
         than seeded. */
      await storage.removeAssetFiles(asset._id, workspaceSlug);
      await assets.assessAssetQuality(req, asset, {});
    }

    const decision = asset.quality?.decision || '';
    const stale = !assets.qualityIsCurrent(asset);
    if (decision !== fixture.decision || stale !== Boolean(fixture.stale)) {
      throw new Error(
        `[e2e-stack] quality fixture "${item.key}" produced decision=${decision || '<none>'} ` +
          `stale=${stale} for ${fixture.productSlug}, expected ` +
          `decision=${fixture.decision} stale=${Boolean(fixture.stale)}. ` +
          'The fixture no longer exercises that state — fix the FIXTURE, not the assertion.'
      );
    }
    console.log(
      `[e2e-stack] quality fixture ready: ${fixture.productSlug} → ${decision}` +
        `${stale ? ' (stale)' : ''}, IoU ${asset.quality?.report?.silhouette?.iou ?? 'n/a'}, ` +
        `${asset.quality?.report?.geometry?.triangles ?? 0} triangles — a DETERMINISTIC FIXTURE, not a generated model`
    );
  }
}

/**
 * PHASE 4 — use a GENUINELY GENERATED model when one is handed to the suite.
 *
 * `THREE_E2E_REAL_GLB=<path>` (with an optional `THREE_E2E_REAL_REPORT=<path>`
 * pointing at the JSON `scripts/3d-real-generation.mjs` writes) makes the suite
 * publish the bytes a REAL worker generated, so the customer journey is proven
 * against a model that a provider actually produced. Without it the suite keeps
 * its deterministic fixture, which is what an ordinary CI run needs: a browser
 * suite cannot assume a GPU provider, and a gate that silently passes without
 * one would be worse than no gate.
 *
 * The switch is reported LOUDLY either way, so a pass can never be mistaken for
 * the other kind of pass.
 */
function loadRealGeneratedModel() {
  const wanted = String(process.env.THREE_E2E_REAL_GLB || '').trim();
  if (!wanted) return null;
  const glbPath = path.resolve(wanted);
  if (!existsSync(glbPath)) {
    console.error(
      `[e2e-stack] THREE_E2E_REAL_GLB points at ${glbPath}, which does not exist — ` +
        'using the deterministic fixture instead. THIS RUN DOES NOT PROVE GENERATION.'
    );
    return null;
  }
  let report = null;
  const reportPath = String(process.env.THREE_E2E_REAL_REPORT || '').trim();
  if (reportPath && existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch (err) {
      console.error(`[e2e-stack] could not read THREE_E2E_REAL_REPORT (${err.message}); continuing without it`);
    }
  }
  return { buffer: readFileSync(glbPath), report, path: glbPath };
}

/**
 * PHASE 3 — the approved 3D model the storefront opens.
 *
 * WHAT THIS IS: an asset row in the `APPROVED` state plus real glTF Binary bytes
 * written into the private 3D root the backend was told to use. It exercises the
 * whole customer path — approval gate, public delivery route, lazy viewer,
 * three.js parse — against bytes a browser really renders.
 *
 * WHICH BYTES: with `THREE_E2E_REAL_GLB` set it is a model a real worker
 * generated (Phase 4); otherwise it is the deterministic container built by
 * `makeGlb()`. The asset row records which, and the provider identity makes the
 * distinction visible from the API, so a spec can assert it instead of trusting
 * a comment.
 *
 * THE VALIDATION BLOCK IS MEASURED, NOT ASSERTED: the bytes go through the same
 * `validateGlb` the backend uses, so the row describes the container that was
 * really written (a fixture that quietly stopped being valid GLB would fail here
 * rather than in a customer's browser).
 *
 * RE-RUNNABLE: the previous run's rows AND files for this product are removed
 * first. The one-approved-asset-per-product index would otherwise refuse a
 * second write, and the suite would fail on its own leftovers instead of on the
 * behaviour under test.
 */
async function provisionApproved3dModel({ Product, Product3DAsset, workspaceSlug }) {
  process.env.THREE_MEDIA_ROOT = THREE_MEDIA_ROOT;
  const { writeAsset, removeAssetFiles } = await import('../../backend/services/3dAssetStorage.js');
  const { validateGlb } = await import('../../backend/services/3dModelValidation.js');
  const real = loadRealGeneratedModel();

  const product = await Product.findOne({ slug: SEED_PRODUCT_SLUG }).lean();
  if (!product) throw new Error(`seed product ${SEED_PRODUCT_SLUG} is missing — cannot build the 3D fixture.`);

  const stale = await Product3DAsset.find({ productSlug: SEED_PRODUCT_SLUG })
    .select('_id')
    .lean();
  for (const row of stale) await removeAssetFiles(row._id, workspaceSlug);
  const { deletedCount } = await Product3DAsset.deleteMany({ productSlug: SEED_PRODUCT_SLUG });

  const glb = real?.buffer || makeGlb();
  const validation = validateGlb(glb);
  if (!validation.ok) {
    throw new Error(
      `the ${real ? 'generated' : 'fixture'} GLB is not a valid container (${validation.code}: ${validation.message})`
    );
  }
  const asset = await Product3DAsset.create({
    workspaceId: product.workspaceId,
    productSlug: SEED_PRODUCT_SLUG,
    status: 'APPROVED',
    version: 1,
    provider: real ? 'local_worker' : 'e2e-fixture',
    providerModel: real
      ? real.report?.worker?.model || real.report?.task?.model || 'TripoSR'
      : 'E2E Fixture Model',
    providerModelVersion: real ? real.report?.worker?.modelVersion || '' : '',
    source: real
      ? { viewCount: 1, label: 'generated from the accepted catalogue photograph' }
      : { viewCount: 0, label: 'fixture' },
    validation: {
      ok: true,
      magic: validation.magic,
      gltfVersion: validation.gltfVersion,
      declaredBytes: validation.declaredBytes,
      meshes: validation.meshes,
      materials: validation.materials,
      textures: validation.textures,
      notes: real
        ? `GENERATED by ${real.report?.worker?.model || 'TripoSR'} on ${real.report?.worker?.gpuName || 'a GPU'} (validated from the bytes).`
        : 'E2E fixture container (not a generated model).',
    },
    approval: { approvedAt: new Date() },
  });

  const written = await writeAsset({
    fileId: asset._id,
    workspaceSlug,
    kind: 'glb',
    buffer: glb,
    format: 'glb',
  });
  asset.storage.glb = { storageKey: written.storageKey, bytes: written.bytes, sha256: written.sha256 };
  await asset.save();

  console.log(
    real
      ? `[e2e-stack] approved 3D model for ${SEED_PRODUCT_SLUG} is a REAL GENERATED MODEL: ` +
          `${written.bytes} bytes from ${path.basename(real.path)} ` +
          `(provider ${asset.provider}/${asset.providerModel}, ${validation.meshes} mesh, ` +
          `${validation.materials} material, ${validation.textures} texture)`
      : `[e2e-stack] approved 3D fixture ready for ${SEED_PRODUCT_SLUG}: ` +
          `${written.bytes} byte GLB in ${THREE_MEDIA_ROOT} (replaced ${deletedCount} previous row(s)) ` +
          '— NOT a generated model; set THREE_E2E_REAL_GLB to verify the real one'
  );
  return asset;
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
      // 3D STUDIO (Phase 3) — the private media root the fixture model lives in.
      THREE_MEDIA_ROOT,
      // 3D STUDIO (Phase 1) — the private reference-media root, so the server
      // reads the same cutouts the stack wrote (both resolve it at import time).
      REFERENCE_MEDIA_DIR,
      // No charge can be made, on purpose (see the file header).
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '',
      RAZORPAY_WEBHOOK_SECRET: '',
      /* PHASE 6 — a CANARY provider credential, so the "no secret reaches the
         browser" check tests a VALUE rather than the vocabulary of a setup hint.
         The key alone does not select the metered provider (that needs
         `3D_PROVIDER=meshy` too, see services/3dModelProvider.js), so nothing is
         spent and the provider still reports itself unconfigured. */
      MESHY_API_KEY: PROVIDER_SECRET_CANARY,
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

  /* PHASE 6 — provisioning runs AFTER the backend is listening, so a failure in
     it (a fixture assertion, a write that cannot be made) must take the backend
     down with it. Without this the child survived the exit holding :4000, and
     the NEXT run then failed with "port 4000 is already in use" — a confusing
     red that had nothing to do with the real fault. */
  try {
    await provisionTenant();
  } catch (err) {
    console.error(`[e2e-stack] provisioning failed: ${err && err.message ? err.message : err}`);
    await stopTestServer(api, API_ORIGIN).catch(() => {});
    process.exit(1);
  }

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
