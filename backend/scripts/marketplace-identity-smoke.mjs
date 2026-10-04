/**
 * PHASE 1 — MARKETPLACE IDENTITY + SHOP DIRECTORY + PUBLIC CATALOGUE HARDENING.
 *
 * Self-contained suite: own server (port 4107), own database
 * (Flora-Alchemy-Test-Marketplace), SEED_ON_START=false. Nothing here ever
 * touches dev or production data.
 *
 * What it proves, in order:
 *
 *   §1 BOOTSTRAP IDENTITY  — the canonical Flora Alchemy bootstrap Workspace is
 *      claimed ONLY by an onboarding dossier whose APPROVED identity IS that
 *      business. An unrelated first creator gets its OWN Workspace; a claimed
 *      bootstrap is never handed out again; a slug collision is retryable and
 *      leaves NO partial Workspace/User/Settings; concurrent activations can
 *      never both claim the same Workspace.
 *   §2 SHOP DIRECTORY      — GET /api/shops: 200, ACTIVE only, deterministic,
 *      bounded, and carrying ONLY { slug, displayName }. Suspended/PENDING
 *      shops are absent; unknown and malformed slugs 404; a suspended shop's
 *      storefront 404s.
 *   §3 PUBLIC ATTRIBUTION  — every public Product answers "which Shop?", the
 *      internal workspaceId NEVER appears in any public payload (deep scan of
 *      products / detail / collections / reviews / wishlist), and products of a
 *      suspended, PENDING or deleted Workspace are hidden + 404.
 *   §4 OWNERSHIP           — product ownership is server-authoritative: a
 *      smuggled workspaceId is ignored on create AND on update (a product can
 *      never move between shops), and a cross-shop delete 404s.
 *   §5 COLLECTIONS         — a collection may only reference its own shop's
 *      products (cross-shop reference → 422).
 *   §6 REVIEWS             — reviews resolve only for a valid PUBLIC product,
 *      and a helpful vote for a no-longer-public review does not mutate.
 *   §7 OWNER GOVERNANCE    — only the owner may govern Shop lifecycle
 *      (staff/customer 403, anonymous 401); suspend/reactivate is idempotent,
 *      takes effect on public discovery IMMEDIATELY (cached catalogue
 *      invalidated), and the owner still cannot touch inventory/orders/catalogue.
 *
 * Run: npm run test:marketplace
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { bootTestServer, stopTestServer, testMongoUri, loadBackendEnv } from './lib/testServer.mjs';

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import Collection from '../models/Collection.js';
import Review from '../models/Review.js';
import Settings from '../models/Settings.js';
import Invitation from '../models/Invitation.js';
import AdminApplication from '../models/AdminApplication.js';
import StaffEvent from '../models/StaffEvent.js';
import {
  activateAdminInvitation,
  CANONICAL_BOOTSTRAP_SLUG,
  isCanonicalBootstrapIdentity,
} from '../services/workspaceProvisioningService.js';

const PORT = 4107;
const DB_NAME = 'Flora-Alchemy-Test-Marketplace';

loadBackendEnv();
const TEST_URI = testMongoUri(process.env.MONGO_URI, DB_NAME);

// ══════════ harness ══════════
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✘ ${name} ${detail}`);
  }
}

const sha256 = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

// ── Deterministic start: drop the dedicated test DB, pre-build indexes ──
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });
await mongoose.connection.db.dropDatabase();
await Promise.all([
  Workspace.init(),
  User.init(),
  Customer.init(),
  Product.init(),
  Collection.init(),
  Review.init(),
  Settings.init(),
  Invitation.init(),
  AdminApplication.init(),
  StaffEvent.init(),
]);

const stamp = Date.now();
const suffix = String(stamp);

function pwd(tag) {
  return `${tag}-Passw0rd-${suffix}!`;
}
const ownerPassword = pwd('Owner');
const adminAPassword = pwd('AdminA');
const adminBPassword = pwd('AdminB');
const customerPassword = pwd('Customer');

// ══════════ §0 fixtures ══════════
console.log('\n— §0 FIXTURES —');

const owner = await User.create({
  email: `owner-${suffix}@marketplace.test`,
  passwordHash: await bcrypt.hash(ownerPassword, 12),
  role: 'admin',
  name: 'Marketplace Owner',
  isOwner: true,
  isFixture: false,
});

const wsA = await Workspace.create({ slug: 'petal-and-stem', displayName: 'Petal & Stem', status: 'ACTIVE' });
const wsB = await Workspace.create({ slug: 'marigold-lane', displayName: 'Marigold Lane', status: 'ACTIVE' });
const wsZeta = await Workspace.create({ slug: 'wild-fern-studio', displayName: 'Wild Fern Studio', status: 'ACTIVE' });
const wsSuspended = await Workspace.create({ slug: 'dormant-bloom', displayName: 'Dormant Bloom', status: 'SUSPENDED' });
const wsPending = await Workspace.create({ slug: 'new-bloom-atelier', displayName: 'New Bloom Atelier', status: 'PENDING' });

async function makeAdmin({ email, password, name, workspaceId }) {
  return User.create({
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: 'admin',
    name,
    workspaceId,
    isFixture: false,
  });
}

const adminA = await makeAdmin({ email: `admin-a-${suffix}@marketplace.test`, password: adminAPassword, name: 'Admin A', workspaceId: wsA._id });
const adminB = await makeAdmin({ email: `admin-b-${suffix}@marketplace.test`, password: adminBPassword, name: 'Admin B', workspaceId: wsB._id });

// A Workspace that is deleted while a product still points at it — the orphan
// case public discovery must never fabricate a shop for.
const wsOrphan = await Workspace.create({ slug: 'gone-florist', displayName: 'Gone Florist', status: 'ACTIVE' });
const orphanWorkspaceId = wsOrphan._id;
await Workspace.deleteOne({ _id: wsOrphan._id });

async function makeProduct({ name, slug, workspaceId, visibility = 'Visible' }) {
  return Product.create({
    name,
    slug,
    price: 1299,
    category: 'Bouquet',
    description: `${name} description`,
    visibility,
    stockTracked: false,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

const productA = await makeProduct({ name: 'Petal Prelude', slug: 'petal-prelude', workspaceId: wsA._id });
const productB = await makeProduct({ name: 'Marigold Morning', slug: 'marigold-morning', workspaceId: wsB._id });
const productZeta = await makeProduct({ name: 'Fern & Stone', slug: 'fern-and-stone', workspaceId: wsZeta._id });
const productSuspended = await makeProduct({ name: 'Dormant Rose', slug: 'dormant-rose', workspaceId: wsSuspended._id });
const productPending = await makeProduct({ name: 'Atelier Draft', slug: 'atelier-draft', workspaceId: wsPending._id });
const productOrphan = await makeProduct({ name: 'Ghost Bloom', slug: 'ghost-bloom', workspaceId: orphanWorkspaceId });
// Legacy / pre-migration row: no workspace at all (single-workspace compat).
const productCompat = await makeProduct({ name: 'Heirloom Posy', slug: 'heirloom-posy', workspaceId: null });

const collectionA = await Collection.create({
  name: 'Petal Favourites',
  slug: 'petal-favourites',
  description: 'Petal & Stem favourites',
  visibility: 'Visible',
  workspaceId: wsA._id,
  productSlugs: [productA.slug],
});
const collectionSuspended = await Collection.create({
  name: 'Dormant Edit',
  slug: 'dormant-edit',
  description: 'Suspended shop collection',
  visibility: 'Visible',
  workspaceId: wsSuspended._id,
  productSlugs: [productSuspended.slug],
});

check('fixtures built (5 live + 1 orphaned workspace)', !!(wsA && wsZeta && wsSuspended && orphanWorkspaceId));

const { child: SERVER, base } = await bootTestServer({
  port: PORT,
  db: DB_NAME,
  extraEnv: { SEED_ON_START: 'false' },
  label: 'marketplace-identity-smoke',
});
const BASE = `${base}/api`;

// One long-lived connection for direct-document assertions.
await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000 });

async function req(method, path_, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${path_}`, {
        method,
        headers: h,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* non-json body */
      }
      return { status: res.status, json };
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}

async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  return r.json?.token || null;
}

const OWNER = await login(owner.email, ownerPassword);
const ADMIN_A = await login(adminA.email, adminAPassword);
const ADMIN_B = await login(adminB.email, adminBPassword);
check('staff sessions issued', !!(OWNER && ADMIN_A && ADMIN_B));

// A real customer (registered through the real endpoint — never fabricated).
const customerEmail = `buyer-${suffix}@marketplace.test`;
let reg = await req('POST', '/auth/register', {
  body: { name: 'Marketplace Buyer', email: customerEmail, password: customerPassword },
});
if (reg.status !== 201 && reg.status !== 200) {
  // The account may already exist from an earlier interrupted run — sign in.
  check('customer registration', false, `${reg.status} ${JSON.stringify(reg.json || {}).slice(0, 120)}`);
}
const CUSTOMER = await login(customerEmail, customerPassword);
check('customer session issued', !!CUSTOMER);

// ── Deep leak scan: no `workspaceId` key and no workspace ObjectId value ──
const workspaceIdStrings = new Set([
  String(wsA._id),
  String(wsB._id),
  String(wsZeta._id),
  String(wsSuspended._id),
  String(wsPending._id),
  String(orphanWorkspaceId),
]);

/** @returns {{keys:string[], values:string[]}} offending key names / id values */
function scanForLeaks(node, path = '$') {
  const keys = [];
  const values = [];
  const walk = (value, at) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${at}[${i}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (/workspaceId/i.test(k)) keys.push(`${at}.${k}`);
        walk(v, `${at}.${k}`);
      }
      return;
    }
    if (typeof value === 'string' && workspaceIdStrings.has(value)) values.push(`${at}=${value}`);
  };
  walk(node, path);
  return { keys, values };
}

function noLeak(label, payload) {
  const { keys, values } = scanForLeaks(payload);
  check(
    label,
    keys.length === 0 && values.length === 0,
    keys.length ? `keys: ${keys.slice(0, 4).join(', ')}` : values.length ? `ids: ${values.slice(0, 4).join(', ')}` : ''
  );
}

const slugsOf = (rows) => (rows || []).map((p) => p.slug);

// ══════════ §1 bootstrap workspace identity ══════════
console.log('\n— §1 BOOTSTRAP IDENTITY (approved business decides the Workspace) —');

// The canonical migration target, exactly as the migration scripts leave it:
// ACTIVE, flagged isBootstrap, still unclaimed.
const bootstrap = await Workspace.create({
  slug: CANONICAL_BOOTSTRAP_SLUG,
  displayName: 'Flora Alchemy',
  status: 'ACTIVE',
  isBootstrap: true,
  primaryAdminId: null,
  isFixture: false,
});
await Settings.create({
  key: 'flora-alchemy',
  workspaceId: bootstrap._id,
  storeName: 'Flora Alchemy',
  isFixture: false,
});

check(
  'canonical identity predicate accepts the canonical slug and name',
  isCanonicalBootstrapIdentity({ inv: { workspaceSlug: 'flora-alchemy' } }) === true &&
    isCanonicalBootstrapIdentity({ application: { businessName: 'Flora Alchemy' } }) === true
);
check(
  'canonical identity predicate rejects an unrelated business',
  isCanonicalBootstrapIdentity({
    inv: { workspaceSlug: 'asha-resin-studio', workspaceName: 'Asha Resin Studio' },
    application: { businessName: 'Asha Resin Studio', proposedSlug: 'asha-resin-studio' },
  }) === false
);

let invSeq = 0;
async function makeAdminInvite({ email, name, businessName, proposedSlug }) {
  invSeq += 1;
  const app = await AdminApplication.create({
    applicationId: `APP-MKT-${suffix}-${invSeq}`,
    name,
    email,
    businessName,
    proposedSlug,
    status: 'INVITED',
    reason: 'marketplace identity verification',
    background: 'disposable verification run',
  });
  const rawToken = crypto.randomBytes(32).toString('hex');
  const inv = await Invitation.create({
    recipientEmail: email,
    recipientName: name,
    role: 'admin',
    status: 'INVITED',
    expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
    workspaceSlug: proposedSlug,
    workspaceName: businessName,
    application: app._id,
    inviter: owner._id,
    tokenHash: sha256(rawToken),
  });
  return { app, inv, rawToken };
}

// §1a — an UNRELATED first creator must NOT inherit the canonical bootstrap.
const unrelated = await makeAdminInvite({
  email: `unrelated-${suffix}@marketplace.test`,
  name: 'Asha Rao',
  businessName: 'Asha Resin Studio',
  proposedSlug: 'asha-resin-studio',
});
let r = await req('POST', `/invitations/${unrelated.rawToken}/activate`, {
  body: { password: pwd('Asha') },
});
// Activation CREATES the account, so 2xx (201) is the success contract.
check('unrelated first creator activates', r.status === 201, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 160)}`);
check(
  'unrelated first creator gets its OWN shop (never the bootstrap)',
  r.json?.workspace?.slug === 'asha-resin-studio' && String(r.json?.workspace?.id) !== String(bootstrap._id),
  `slug=${r.json?.workspace?.slug}`
);
const bootstrapAfterUnrelated = await Workspace.findById(bootstrap._id).lean();
check(
  'canonical bootstrap still unclaimed after an unrelated activation',
  bootstrapAfterUnrelated.primaryAdminId == null
);
check(
  'unrelated creator owns exactly one workspace, no duplicate',
  (await Workspace.countDocuments({ primaryAdminId: { $ne: null } })) === 1
);

// §1b — CONCURRENT canonical-name claims: exactly one may take the bootstrap.
// Both dossiers carry the canonical DISPLAY NAME (so both match the canonical
// business) but different approved slugs (so the loser can still be provisioned).
async function activateDirect({ inv, app, email, name, password }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const call = () =>
    activateAdminInvitation({
      inv,
      application: app,
      email,
      passwordHash,
      name,
    });
  let last;
  for (let i = 0; i < 5; i += 1) {
    try {
      return await call();
    } catch (err) {
      last = err;
      const transient =
        /TransientTransactionError|lock|WriteConflict/i.test(err.message || '') ||
        (err.errorLabels && err.errorLabels.includes('TransientTransactionError'));
      if (!transient) throw err;
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw last;
}

const raceNorth = await makeAdminInvite({
  email: `race-north-${suffix}@marketplace.test`,
  name: 'North Desk',
  businessName: 'Flora Alchemy',
  proposedSlug: 'flora-alchemy-north',
});
const raceSouth = await makeAdminInvite({
  email: `race-south-${suffix}@marketplace.test`,
  name: 'South Desk',
  businessName: 'Flora Alchemy',
  proposedSlug: 'flora-alchemy-south',
});

const raceResults = await Promise.allSettled([
  activateDirect({ inv: raceNorth.inv, app: raceNorth.app, email: raceNorth.inv.recipientEmail, name: 'North Desk', password: pwd('North') }),
  activateDirect({ inv: raceSouth.inv, app: raceSouth.app, email: raceSouth.inv.recipientEmail, name: 'South Desk', password: pwd('South') }),
]);
const raceOk = raceResults.filter((x) => x.status === 'fulfilled').map((x) => x.value);
check('both concurrent canonical activations resolve', raceOk.length === 2, raceResults.map((x) => (x.status === 'rejected' ? x.reason.message : 'ok')).join(' | '));

const bootstrapClaimants = await User.find({
  workspaceId: bootstrap._id,
  role: 'admin',
  isOwner: { $ne: true },
}).lean();
check('exactly ONE concurrent activation claimed the bootstrap workspace', bootstrapClaimants.length === 1, `claimants=${bootstrapClaimants.length}`);
const distinctRaceWorkspaces = new Set(raceOk.map((x) => String(x.workspace.id)));
check('the two concurrent activations did not share a workspace', distinctRaceWorkspaces.size === raceOk.length, `distinct=${distinctRaceWorkspaces.size}`);
check(
  'no second bootstrap workspace was created',
  (await Workspace.countDocuments({ isBootstrap: true })) === 1
);

// §1c — a canonical-identity creator arriving AFTER the claim must get its own shop.
const latecomer = await makeAdminInvite({
  email: `latecomer-${suffix}@marketplace.test`,
  name: 'Late Desk',
  businessName: 'Flora Alchemy',
  proposedSlug: 'flora-alchemy-late',
});
r = await req('POST', `/invitations/${latecomer.rawToken}/activate`, { body: { password: pwd('Late') } });
check('late canonical-identity creator activates', r.status === 201, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 160)}`);
check(
  'a claimed bootstrap is never handed out again',
  r.json?.workspace?.slug === 'flora-alchemy-late' && String(r.json?.workspace?.id) !== String(bootstrap._id),
  `slug=${r.json?.workspace?.slug}`
);

// §1d — slug collision: retryable, and NO partial state survives.
const collision = await makeAdminInvite({
  email: `collision-${suffix}@marketplace.test`,
  name: 'Collision Desk',
  businessName: 'Asha Resin Studio',
  proposedSlug: 'asha-resin-studio', // already owned by the §1a activation
});
const beforeCollision = {
  workspaces: await Workspace.countDocuments({}),
  users: await User.countDocuments({}),
  settings: await Settings.countDocuments({}),
};
r = await req('POST', `/invitations/${collision.rawToken}/activate`, { body: { password: pwd('Coll') } });
check(
  'slug collision is refused with a retryable 409',
  r.status === 409 && r.json?.code === 'WORKSPACE_SLUG_TAKEN',
  `${r.status} ${r.json?.code}`
);
check(
  'failed activation created no Workspace',
  (await Workspace.countDocuments({})) === beforeCollision.workspaces
);
check('failed activation created no User', (await User.countDocuments({})) === beforeCollision.users);
check(
  'failed activation created no Settings',
  (await Settings.countDocuments({})) === beforeCollision.settings
);
check(
  'failed activation left the invitation usable (still INVITED)',
  String((await Invitation.findById(collision.inv._id).lean()).status) === 'INVITED'
);

// §1e — single-use: replaying the same invitation changes nothing.
const replayBefore = { workspaces: await Workspace.countDocuments({}), users: await User.countDocuments({}) };
r = await req('POST', `/invitations/${collision.rawToken}/activate`, { body: { password: pwd('Coll') } });
check('replayed activation refused (409)', r.status === 409, `${r.status} ${r.json?.code}`);
check(
  'replayed activation created nothing',
  (await Workspace.countDocuments({})) === replayBefore.workspaces &&
    (await User.countDocuments({})) === replayBefore.users
);

// ══════════ §2 public shop directory ══════════
console.log('\n— §2 PUBLIC SHOP DIRECTORY (GET /api/shops) —');

r = await req('GET', '/shops');
check('GET /api/shops answers 200', r.status === 200, `${r.status}`);
check('GET /api/shops returns a shops array', Array.isArray(r.json?.shops), `${typeof r.json?.shops}`);
const directory = r.json?.shops || [];
check('GET /api/shops is bounded to 200 rows', directory.length <= 200, `${directory.length}`);

const directorySlugs = directory.map((s) => s.slug);
check(
  'directory lists ACTIVE shops',
  ['petal-and-stem', 'marigold-lane', 'wild-fern-studio', 'flora-alchemy'].every((s) => directorySlugs.includes(s)),
  directorySlugs.join(', ')
);
check(
  'directory hides the SUSPENDED shop',
  !directorySlugs.includes('dormant-bloom'),
  directorySlugs.join(', ')
);
check(
  'directory hides the PENDING shop',
  !directorySlugs.includes('new-bloom-atelier'),
  directorySlugs.join(', ')
);
check(
  'every directory row carries EXACTLY { slug, displayName }',
  directory.every((s) => Object.keys(s).sort().join(',') === 'displayName,slug'),
  JSON.stringify(directory[0] || {})
);
noLeak('directory rows leak no internal identifiers', directory);
check(
  'directory rows expose no admin association',
  directory.every((s) => !('primaryAdminId' in s) && !('status' in s) && !('id' in s))
);

r = await req('GET', '/shops');
check(
  'GET /api/shops is deterministic across calls',
  JSON.stringify((r.json?.shops || []).map((s) => s.slug)) === JSON.stringify(directorySlugs)
);

r = await req('GET', '/shops/petal-and-stem');
check('known shop resolves with its public identity', r.status === 200 && r.json?.shop?.slug === 'petal-and-stem' && r.json?.shop?.displayName === 'Petal & Stem', `${r.status} ${JSON.stringify(r.json || {})}`);
noLeak('shop profile leaks no internal identifiers', r.json);

r = await req('GET', '/shops/dormant-bloom');
check('suspended shop storefront 404s', r.status === 404 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);

r = await req('GET', '/shops/no-such-shop-xyz');
check('unknown shop slug 404s', r.status === 404 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);

r = await req('GET', '/shops/Not%20A%20Slug!');
check('malformed shop slug 404s (never 500)', r.status === 404, `${r.status}`);

// ══════════ §3 public product attribution + no internal leak ══════════
console.log('\n— §3 PUBLIC ATTRIBUTION & INTERNAL-IDENTIFIER HARDENING —');

r = await req('GET', '/products');
check('GET /api/products answers 200', r.status === 200, `${r.status}`);
const publicProducts = r.json?.products || [];
const publicSlugs = slugsOf(publicProducts);
check('public catalogue includes ACTIVE-shop products', ['petal-prelude', 'marigold-morning', 'fern-and-stone'].every((s) => publicSlugs.includes(s)), publicSlugs.join(', '));
check('public catalogue includes the legacy no-workspace row (compat)', publicSlugs.includes('heirloom-posy'), publicSlugs.join(', '));
check('public catalogue HIDES the suspended shop product', !publicSlugs.includes('dormant-rose'), publicSlugs.join(', '));
check('public catalogue HIDES the pending shop product', !publicSlugs.includes('atelier-draft'), publicSlugs.join(', '));
check('public catalogue HIDES the orphaned-workspace product', !publicSlugs.includes('ghost-bloom'), publicSlugs.join(', '));

const shopOf = (slug) => (publicProducts.find((p) => p.slug === slug) || {}).shop;
check(
  'each public product carries its canonical { slug, displayName }',
  JSON.stringify(shopOf('petal-prelude')) === JSON.stringify({ slug: 'petal-and-stem', displayName: 'Petal & Stem' }) &&
    JSON.stringify(shopOf('marigold-morning')) === JSON.stringify({ slug: 'marigold-lane', displayName: 'Marigold Lane' }),
  JSON.stringify(shopOf('petal-prelude'))
);
check('a legacy no-workspace product carries shop: null', shopOf('heirloom-posy') === null, JSON.stringify(shopOf('heirloom-posy')));
noLeak('public product list leaks no internal identifiers', r.json);

r = await req('GET', '/products/petal-prelude');
check('public product detail 200 with shop attribution', r.status === 200 && r.json?.product?.shop?.slug === 'petal-and-stem', `${r.status} ${JSON.stringify(r.json?.product?.shop || {})}`);
noLeak('public product detail leaks no internal identifiers', r.json);

r = await req('GET', '/products/dormant-rose');
check('suspended shop product detail 404s', r.status === 404 && r.json?.code === 'PRODUCT_NOT_FOUND', `${r.status} ${r.json?.code}`);

r = await req('GET', '/products/ghost-bloom');
check('orphaned-workspace product detail 404s', r.status === 404 && r.json?.code === 'PRODUCT_NOT_FOUND', `${r.status} ${r.json?.code}`);

r = await req('GET', '/collections');
check('public collections answer 200', r.status === 200, `${r.status}`);
const publicCollections = r.json?.collections || [];
check('public collections include the active shop collection', slugsOf(publicCollections).includes('petal-favourites'), slugsOf(publicCollections).join(', '));
check('public collections hide the suspended shop collection', !slugsOf(publicCollections).includes('dormant-edit'), slugsOf(publicCollections).join(', '));
check(
  'public collections carry shop attribution',
  JSON.stringify((publicCollections.find((c) => c.slug === 'petal-favourites') || {}).shop) ===
    JSON.stringify({ slug: 'petal-and-stem', displayName: 'Petal & Stem' })
);
noLeak('public collections leak no internal identifiers', r.json);

r = await req('GET', '/collections/dormant-edit');
check('suspended shop collection detail 404s', r.status === 404, `${r.status}`);

// Wishlist (customer surface) — same canonical projection.
r = await req('POST', `/wishlist/${productA.slug}`, { token: CUSTOMER, body: { shop: 'petal-and-stem' } });
check('customer wishlist add 200', r.status === 200, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 140)}`);
r = await req('GET', '/wishlist?shop=petal-and-stem', { token: CUSTOMER });
check('customer wishlist read 200', r.status === 200, `${r.status}`);
check(
  'wishlist products carry shop attribution',
  JSON.stringify(((r.json?.wishlist?.products || [])[0] || {}).shop) === JSON.stringify({ slug: 'petal-and-stem', displayName: 'Petal & Stem' }),
  JSON.stringify((r.json?.wishlist?.products || [])[0] || {})
);
noLeak('wishlist leaks no internal identifiers', r.json);

// Reviews — public aggregate + media rail.
r = await req('POST', `/products/${productA.slug}/reviews`, {
  token: CUSTOMER,
  body: { rating: 5, title: 'Lovely stems', comment: 'Arrived beautifully packed.' },
});
check('customer may review a public product (201)', r.status === 201, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 140)}`);
const reviewId = r.json?.review?.id;

r = await req('GET', `/products/${productA.slug}/reviews`);
check('public reviews read 200', r.status === 200, `${r.status}`);
noLeak('public reviews leak no internal identifiers', r.json);

// ══════════ §4 product ownership is server-authoritative ══════════
console.log('\n— §4 PRODUCT OWNERSHIP (server-authoritative) —');

r = await req('POST', '/products', {
  token: ADMIN_A,
  body: { name: 'Ownership Probe', price: 990, workspaceId: String(wsB._id) },
});
check('admin A creates a product (201)', r.status === 201, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 160)}`);
const ownedProbe = await Product.findOne({ slug: 'ownership-probe' }).lean();
check(
  'smuggled body workspaceId is ignored on create',
  ownedProbe && String(ownedProbe.workspaceId) === String(wsA._id),
  `ws=${ownedProbe?.workspaceId}`
);

r = await req('PATCH', '/products/ownership-probe', {
  token: ADMIN_A,
  body: { name: 'Ownership Probe', workspaceId: String(wsB._id) },
});
const movedProbe = await Product.findOne({ slug: 'ownership-probe' }).lean();
check(
  'a product can never be moved to another workspace',
  movedProbe && String(movedProbe.workspaceId) === String(wsA._id),
  `ws=${movedProbe?.workspaceId}`
);

r = await req('DELETE', '/products/marigold-morning', { token: ADMIN_A });
check('cross-workspace product delete 404s', r.status === 404, `${r.status}`);
check(
  'the other shop product survives the refused delete',
  !!(await Product.findOne({ slug: 'marigold-morning' }).lean())
);

r = await req('PATCH', '/products/marigold-morning', { token: ADMIN_A, body: { price: 1 } });
check('cross-workspace product update 404s', r.status === 404, `${r.status}`);
check(
  'the other shop product is unmodified',
  (await Product.findOne({ slug: 'marigold-morning' }).lean())?.price === 1299
);

// ══════════ §5 collection ownership ══════════
console.log('\n— §5 COLLECTION OWNERSHIP (one authoritative Workspace) —');

r = await req('POST', '/collections', {
  token: ADMIN_A,
  body: { name: 'Cross Shop Attempt', productSlugs: ['marigold-morning'] },
});
check(
  'cross-workspace product reference is rejected (422)',
  r.status === 422 && r.json?.code === 'PRODUCT_NOT_IN_WORKSPACE',
  `${r.status} ${r.json?.code}`
);
check(
  'the rejected collection was not created',
  !(await Collection.findOne({ slug: 'cross-shop-attempt' }).lean())
);

r = await req('POST', '/collections', {
  token: ADMIN_A,
  body: { name: 'Own Shop Selection', productSlugs: ['petal-prelude'] },
});
check('own-workspace product reference is accepted (201)', r.status === 201, `${r.status} ${JSON.stringify(r.json || {}).slice(0, 160)}`);
const ownCollection = await Collection.findOne({ slug: 'own-shop-selection' }).lean();
check(
  'the created collection is owned by the creator workspace',
  ownCollection && String(ownCollection.workspaceId) === String(wsA._id)
);

// ══════════ §6 reviews resolve only for public products ══════════
console.log('\n— §6 REVIEWS (public-product resolution) —');

r = await req('POST', '/products/dormant-rose/reviews', {
  token: CUSTOMER,
  body: { rating: 5, title: 'Hidden', comment: 'Should never be accepted.' },
});
check('reviewing a suspended shop product 404s', r.status === 404 && r.json?.code === 'PRODUCT_NOT_FOUND', `${r.status} ${r.json?.code}`);

r = await req('POST', '/products/ghost-bloom/reviews', {
  token: CUSTOMER,
  body: { rating: 4, title: 'Ghost', comment: 'Orphaned product.' },
});
check('reviewing an orphaned-workspace product 404s', r.status === 404, `${r.status}`);

check(
  'no review was written for a non-public product',
  (await Review.countDocuments({ productSlug: { $in: ['dormant-rose', 'ghost-bloom'] } })) === 0
);

r = await req('GET', '/products/dormant-rose/reviews');
check('review read for a suspended shop product 404s', r.status === 404, `${r.status}`);

// A review that becomes unreachable when its shop is suspended: the helpful
// vote must be refused BEFORE the counter mutates.
const seededReview = await Review.create({
  productSlug: productB.slug,
  customerId: (await Customer.findOne({ email: customerEmail }))?._id,
  customerName: 'Marketplace Buyer',
  rating: 5,
  title: 'Marigold morning',
  comment: 'Gorgeous colour.',
  helpfulCount: 7,
});

r = await req('POST', `/reviews/${seededReview._id}/helpful`);
check('helpful vote on a still-public review succeeds', r.status === 200 && r.json?.review?.helpfulCount === 8, `${r.status} ${r.json?.review?.helpfulCount}`);

await Workspace.updateOne({ _id: wsB._id }, { $set: { status: 'SUSPENDED' } });
const beforeBlockedVote = (await Review.findById(seededReview._id).lean())?.helpfulCount;
r = await req('POST', `/reviews/${seededReview._id}/helpful`);
check('helpful vote for a suspended shop product 404s', r.status === 404, `${r.status} ${r.json?.code}`);
check(
  'the refused helpful vote did NOT mutate the counter',
  (await Review.findById(seededReview._id).lean())?.helpfulCount === beforeBlockedVote,
  `${beforeBlockedVote} -> ${(await Review.findById(seededReview._id).lean())?.helpfulCount}`
);
await Workspace.updateOne({ _id: wsB._id }, { $set: { status: 'ACTIVE' } });

// ══════════ §7 owner governance ══════════
console.log('\n— §7 OWNER SHOP GOVERNANCE —');

r = await req('GET', '/owner/shops', { token: ADMIN_A });
check('plain administrator refused the owner shop list (403)', r.status === 403, `${r.status}`);
r = await req('GET', '/owner/shops', { token: CUSTOMER });
check('customer refused the owner shop list (403)', r.status === 403, `${r.status}`);
r = await req('GET', '/owner/shops');
check('anonymous refused the owner shop list (401)', r.status === 401, `${r.status}`);
r = await req('POST', '/owner/shops/petal-and-stem/suspend', { token: ADMIN_A });
check('plain administrator refused shop suspension (403)', r.status === 403, `${r.status}`);

r = await req('GET', '/owner/shops', { token: OWNER });
check('owner lists every shop (200)', r.status === 200, `${r.status}`);
const ownerShops = r.json?.shops || [];
check(
  'owner shop list includes suspended and pending shops too',
  ['dormant-bloom', 'new-bloom-atelier', 'petal-and-stem'].every((s) => ownerShops.some((row) => row.slug === s)),
  ownerShops.map((s) => s.slug).join(', ')
);
check(
  'owner shop list reports lifecycle status and actions',
  ownerShops.find((s) => s.slug === 'dormant-bloom')?.status === 'SUSPENDED' &&
    ownerShops.find((s) => s.slug === 'dormant-bloom')?.actions?.canReactivate === true &&
    ownerShops.find((s) => s.slug === 'petal-and-stem')?.actions?.canSuspend === true
);

// ── Prime the public catalogue cache, then suspend and re-read immediately. ──
r = await req('GET', '/products');
check(
  'catalogue cache primed with the shop product present',
  slugsOf(r.json?.products).includes('petal-prelude'),
  slugsOf(r.json?.products).join(', ')
);

const staffEventCountBefore = await StaffEvent.countDocuments({ type: 'SUSPENDED' });

r = await req('POST', '/owner/shops/petal-and-stem/suspend', { token: OWNER });
check('owner suspends a shop (200)', r.status === 200 && r.json?.shop?.status === 'SUSPENDED', `${r.status} ${r.json?.shop?.status}`);

r = await req('GET', '/shops');
check('suspended shop disappears from the directory IMMEDIATELY', !((r.json?.shops || []).map((s) => s.slug)).includes('petal-and-stem'));
r = await req('GET', '/shops/petal-and-stem');
check('suspended shop storefront 404s immediately', r.status === 404, `${r.status}`);
r = await req('GET', '/products');
check(
  'suspended shop product leaves the CACHED catalogue immediately',
  !slugsOf(r.json?.products).includes('petal-prelude'),
  slugsOf(r.json?.products).join(', ')
);
r = await req('GET', '/products/petal-prelude');
check('suspended shop product detail 404s immediately', r.status === 404, `${r.status}`);
r = await req('GET', '/collections');
check(
  'suspended shop collections leave the catalogue immediately',
  !slugsOf(r.json?.collections).includes('petal-favourites')
);

check(
  'suspension is recorded in the staff audit trail',
  (await StaffEvent.countDocuments({ type: 'SUSPENDED' })) === staffEventCountBefore + 1
);
const suspendEvent = await StaffEvent.findOne({ type: 'SUSPENDED' }).sort({ at: -1 }).lean();
check('audit event carries the governed workspace', String(suspendEvent?.workspaceId) === String(wsA._id), `${suspendEvent?.workspaceId}`);

r = await req('POST', '/owner/shops/petal-and-stem/suspend', { token: OWNER });
check('repeated suspension is idempotent (200, still SUSPENDED)', r.status === 200 && r.json?.shop?.status === 'SUSPENDED', `${r.status} ${r.json?.shop?.status}`);
check(
  'repeated suspension writes no second audit event',
  (await StaffEvent.countDocuments({ type: 'SUSPENDED' })) === staffEventCountBefore + 1
);

// ── Owner governance is NOT operational access. ──
r = await req('GET', '/orders', { token: OWNER });
check('owner refused the order list (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('GET', '/inventory', { token: OWNER });
check('owner refused inventory (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
r = await req('POST', '/products', { token: OWNER, body: { name: 'Owner Must Not', price: 100 } });
check('owner refused product create (403 WORKSPACE_REQUIRED)', r.status === 403 && r.json?.code === 'WORKSPACE_REQUIRED', `${r.status} ${r.json?.code}`);
check('the owner create attempt wrote nothing', !(await Product.findOne({ slug: 'owner-must-not' }).lean()));

// ── Reactivate restores public discovery. ──
r = await req('POST', '/owner/shops/petal-and-stem/reactivate', { token: OWNER });
check('owner reactivates a shop (200)', r.status === 200 && r.json?.shop?.status === 'ACTIVE', `${r.status} ${r.json?.shop?.status}`);

r = await req('GET', '/shops');
check('reactivated shop returns to the directory immediately', ((r.json?.shops || []).map((s) => s.slug)).includes('petal-and-stem'));
r = await req('GET', '/products');
check(
  'reactivated shop product returns to the cached catalogue immediately',
  slugsOf(r.json?.products).includes('petal-prelude'),
  slugsOf(r.json?.products).join(', ')
);
r = await req('GET', '/products/petal-prelude');
check(
  'reactivated product detail carries its shop again',
  r.status === 200 && r.json?.product?.shop?.slug === 'petal-and-stem',
  `${r.status} ${JSON.stringify(r.json?.product?.shop || {})}`
);

r = await req('POST', '/owner/shops/no-such-shop-xyz/suspend', { token: OWNER });
check('suspending an unknown shop 404s', r.status === 404 && r.json?.code === 'SHOP_NOT_FOUND', `${r.status} ${r.json?.code}`);

// ══════════ cleanup + result ══════════
try {
  for (const name of [
    'users',
    'customers',
    'workspaces',
    'products',
    'collections',
    'reviews',
    'settings',
    'invitations',
    'adminapplications',
    'staffevents',
    'wishlists',
    'inventories',
  ]) {
    try {
      await mongoose.connection.db.collection(name).deleteMany({});
    } catch {
      /* collection may not exist */
    }
  }
  console.log(`\n— cleanup: cleared ${DB_NAME} —`);
} catch (err) {
  console.log(`\n— cleanup skipped (${err.message}) —`);
}

console.log(`\nMARKETPLACE RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
}

try {
  await mongoose.disconnect().catch(() => {});
} finally {
  await stopTestServer(SERVER, base);
}