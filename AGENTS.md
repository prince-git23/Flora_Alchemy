# AGENTS.md — Instructions for AI coding agents

Flora Alchemy is a full-stack e-commerce boutique (handcrafted botanical keepsakes,
personalized gifts) with a customer storefront and a staff **Handler Portal**.

This file is the short, practical briefing. Deeper detail lives in
[`docs/`](./docs): [ARCHITECTURE](./docs/ARCHITECTURE.md),
[DESIGN](./docs/DESIGN.md), [MEMORY](./docs/MEMORY.md), [API](./docs/API.md),
[DATABASE](./docs/DATABASE.md), [TESTING](./docs/TESTING.md),
[IMAGE_STUDIO](./docs/IMAGE_STUDIO.md) (3D Studio Phase 1 — prepared product
reference images), [CONTRIBUTING](./docs/CONTRIBUTING.md), and
[DEPLOYMENT](./DEPLOYMENT.md).

---

## ⚠️ Production Safety — read this first

**Development and production use distinct databases on the shared cluster**
(Phase 22.5): local development resolves to `flora_alchemy_dev`, and the deployed
backend (`flora-alchemy.onrender.com`) resolves to `Flora-Alchemy`. The former
shared-database defect is **resolved** — a local write no longer appears in the
production API.

Therefore:

- **Never run destructive QA or cleanup scripts** (deletes, resets, `deleteMany`,
  bulk upserts) without first confirming the database target.
- **Check the environment/database target before any data mutation.** Inspect
  `backend/.env` → `MONGO_URI` and the hosting dashboard value, and compare the
  database name (the path segment before `?`). `Flora-Alchemy` is production and is
  protected by the migration scripts' confirmation gates.
- **Never create fixture/demo documents (`isFixture: true`) in production**, and
  clean up disposable `Flora-Alchemy-Test-*` / `prod-smoke-*` databases (the shared
  cluster has a 500-collection cap). Never drop `Flora-Alchemy` or
  `flora_alchemy_dev`.
- **Never expose credentials in frontend production builds.** Anything not behind
  `import.meta.env.DEV` ships to customers in the bundle. Demo credentials and
  developer helpers must be DEV-gated (see `LoginPage.jsx`,
  `AdminLoginPage.jsx`).
- **No demo/fixture accounts or documents exist in production** (verified
  2026-10-06: zero `isFixture: true` documents in `Flora-Alchemy`, and no
  `handler.admin@flora-alchemy.demo` account). Production holds real staff and
  customer identities only. The historical warning about a seeded demo handler
  needing rotation is **resolved/obsolete** — if one ever reappears it is a
  regression of the `SEED_ON_START`/environment guard, not routine state.
  Seeded fixture credentials (`seed.js`) must still never be created in
  production, and must never be added to or printed in source, docs, logs or
  commits.

Do not commit, push, or open a PR unless the user asks.

---

## Project purpose

A single-repository storefront + operations console:

- **Customer Storefront** (`/`) — browse, search, collections, gift finder,
  custom gift studio, cart, checkout, order tracking, account, wishlist,
  order-linked messaging.
- **Handler Portal** (`/admin`) — orders, products, collections, customers,
  inventory, analytics, settings, operator access, conversations, custom requests.

## Technology stack

| Layer | Stack |
|---|---|
| Frontend | React 19, Vite 6, Tailwind CSS v4 (`@tailwindcss/vite`), react-router-dom 7, GSAP (+ScrollTrigger), lucide-react |
| Backend | Node ≥18, Express 4.22, Mongoose 8, JWT (`jsonwebtoken`), `bcryptjs`, `helmet`, `cors`, `express-rate-limit`, `multer`, `dotenv` |
| Database | MongoDB (Atlas or local) |
| Auth | Stateless JWT Bearer tokens; **separate** customer and admin sessions |
| Integrations | Razorpay (TEST-mode adapter, optional), ImageKit (image CDN, optional) |
| Tests | Hand-rolled Node smoke suites in `backend/scripts` (no test framework) |

No TypeScript, no state-management library, no test runner, no `three.js`
(animation is GSAP + `requestAnimationFrame`).

## Structure

```
frontend/src/
  App.jsx              routing (every page lazy-loaded) + auth-expiry handler
  main.jsx             provider nesting: Data → Store → AdminSession → App
  components/          shared storefront UI (+ components/admin/ for the portal)
  pages/               one file per route (+ pages/admin/)
  context/             Data, Store, Theme, AdminSession providers
  hooks/               useStoreVersion
  services/            apiClient (all HTTP), api (guest cart), dataStore, domain services
  lib/gsapSetup.js     GSAP + ScrollTrigger registration
  index.css            Tailwind import + design tokens (light/dark)

backend/
  server.js            app wiring, helmet/CORS/rate limits, graceful shutdown
  config/              db.js, customGiftPricing.js (authoritative gift pricing)
  routes/              Express routers (thin — wire path → controller)
  controllers/         request validation + response shaping
  services/            22 modules: the core eight (orderService, inventoryService,
                       conversationService, razorpayService, analyticsService,
                       workspaceProvisioningService, orderDestinationService,
                       customRequestPaymentService), the private-media pair
                       (privateMediaRoot.js = ONE place that resolves + probes both
                       roots, referenceAssetStorage.js), the image pipeline
                       (referenceImageService, referenceImageValidation,
                       bgRemoval/ engines behind one entry point) and the 3D studio
                       (3dModelProvider / 3dLocalWorkerProvider = provider registry,
                       never a paid fallback; 3dGenerationService, 3dAssetService,
                       3dAssetStorage, 3dModelValidation, 3dQualityAssessment,
                       3dMeshGeometry, 3dSilhouetteMetrics, product3dPublicResolution)
  models/              Mongoose schemas (22)
  middleware/          authMiddleware, errorMiddleware, securityMiddleware (rate limits),
                       permissionMiddleware (granular staff permissions), workspaceMiddleware
  utils/               publicCache (TTL cache), querySafety (regex escaping)
  scripts/             smoke suites + run-all orchestrator + lib/testServer.mjs
  seed/seed.js         fixture data (products, collections, customers, orders)

tools/
  3d-worker/            Phase 4: worker.py — real TripoSR inference over loopback HTTP
                        (+ shims/ marching-cubes stand-in). Source only; the venv,
                        model checkout and weights live OUTSIDE the repo (~/flora-3d).
```

### Where code belongs

- New storefront screen → `frontend/src/pages/`, registered in `App.jsx` via `lazy()`.
- New portal screen → `frontend/src/pages/admin/`, wrapped in `<AdminRoute>`.
- Reusable UI → `frontend/src/components/` (or `components/admin/`).
- New HTTP call → the relevant `frontend/src/services/*Service.js`, which must go
  through `services/apiClient.js`. **Never call `fetch` directly from a page/component.**
- New endpoint → `backend/routes/*Routes.js` → `backend/controllers/*.js`;
  put reusable business logic in `backend/services/`.
- New persisted field → `backend/models/*.js` (additive, with a default).
- New image-processing engine → `backend/services/bgRemoval/` behind
  `bgRemoval/index.js` (never import an engine from a controller).
- New cross-cutting request logic → `backend/middleware/`.

## Development commands

Run from the repository root unless noted.

```bash
npm run dev          # frontend dev server (Vite, port 3000)
npm run api:dev      # backend with --watch
npm run api          # backend (node server.js, default port 4000)
npm run api:seed     # seed fixtures (backend/seed/seed.js)
npm run build        # production frontend build
npm run install:all  # install frontend + backend dependencies
```

Local dev ports: frontend **3000**, backend **4000**. `VITE_API_URL` **must include
the `/api` suffix** (e.g. `http://localhost:4000/api`).

## Testing commands

Run from `backend/` (or `npm test` from the root).

```bash
npm test               # all suites via scripts/run-all.mjs — last full sweep 2701 pass / 0 fail across all 30 suites (2026-10-17)
npm run build:e2e      # frontend: build the E2E bundle (loopback API, gateway disabled)
npm run test:e2e       # frontend: build + the Playwright browser suite (real stack)
npm run test:guard     # 30 (database-identity guard; no server, no DB, no writes)
npm run test:pricing   # 22
npm run test:api       # 125
npm run test:integration # 81
npm run test:payment   # 45 (local mock Razorpay)
npm run test:conversation # 34
npm run test:applications # 82 (public application intake → owner review → invitation)
npm run test:security  # 105
npm run test:onboarding # 141 (client admin onboarding + workspace activation + storefront/wishlist tenancy, Phase 22.4–22.5)
npm run test:references # 111 — 3D Studio Phase 1 image pipeline (engines, licence guard, review, tenancy)
npm run test:3d        # 188 — 3D Studio Phase 2–3: provider policy, validation, storage, approval, public delivery
npm run test:3d-worker # 52  — 3D Studio Phase 4: local_worker adapter contract (loopback stand-in, no GPU, spends nothing)
npm run test:3d-real   # OPT-IN real generation via a live tools/3d-worker/worker.py (TripoSR on the local GPU); exit 2 without one, exit 3 when the quality gate refuses approval (artifacts still written); never in `test:all`
npm run test:3d-quality # 84  — 3D Studio Phase 5: the model quality gate (deterministic fixtures; no GPU, no credits)
npm run test:media-storage # 75 — private media: absolute/cwd-independent roots, traversal, immutability, typed write failures, missing bytes
npm run test:marketplace # 108 — shop identity / marketplace surfaces
npm run test:shop-services # 122 — shop serviceability + delivery promises
npm run test:checkout  # 111 — checkout ownership, totals, reservation/release
npm run test:custom-request # 78 — custom request workflow + proposals
npm run test:boot-gate # clean-checkout boot/route-registration gate (no DB, no writes)
npm run prod:probe     # OPT-IN read-only probe of the deployed API (needs PROD_PROBE_BASE_URL)
npm run media:migrate  # private-media migration (dry run by default; --apply to copy + verify)
npm run test:razorpay-real # real sandbox; SKIPS without rzp_test_* keys
```

Every suite boots its **own** backend process against its **own** dedicated
`Flora-Alchemy-Test-*` MongoDB database, so tests never touch dev or production
data. See [`docs/TESTING.md`](./docs/TESTING.md).

**Suite states are explicit.** `scripts/run-all.mjs` reports each suite as
`PASS`, `FAIL`, `ENVIRONMENTAL/TIMEOUT` (killed by the per-suite cap, or died
before printing a summary), `CAPACITY` (MongoDB refused to create collections) or
`NOT RUN` — never fold a timeout into a failure, and never raise the cap to make a
run look green. Re-run a suite alone first:
`node scripts/run-all.mjs --only="<Suite>"`.

**Browser E2E:** `npm run test:e2e` (from `frontend/`) runs Playwright against the
real stack — an isolated backend plus `vite preview` serving the production bundle.
It refuses to start unless the derived database carries a disposable marker, differs
from the configured one, and the **built bundle's API origin is loopback**, so a
stray `npm run build` can never point the suite at the deployed API.

**The shared cluster has a 500-collection cap.** A full 30-suite run needs ~660
collections, so the orchestrator **reclaims each suite's database immediately after
it reports** (delegating to the safety-gated `scripts/db-footprint.mjs
--drop-leftovers`; pass `--keep-databases` to keep them). Use
`node scripts/db-footprint.mjs` (read-only) to see the footprint and
`--drop-leftovers` to reclaim by hand. It never touches `Flora-Alchemy`,
`flora_alchemy_dev`, or another project's database.

**Passing tests do not mean the deployment is safe.** The suites run isolated
(each against its own `Flora-Alchemy-Test-*` database). There is **no frontend
unit-test runner**: storefront behaviour is covered by the Playwright suite above
plus `npm run build` and the layout-only responsive harness — never claim an
automated frontend unit test passed.

## Environment-variable rules

- Secrets live only in `backend/.env` / `frontend/.env` (git-ignored). Commit
  `.env.example` only. Never commit `.env*`, never print secret values into
  source, docs, logs, or commits.
- Variable name is **`MONGO_URI`** (not `MONGODB_URI`).
- Backend: `PORT`, `NODE_ENV`, `MONGO_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
  `CORS_ORIGIN`, `SEED_ON_START`, `TRUST_PROXY`, optional `RAZORPAY_*`,
  `IMAGEKIT_*`, `UPLOAD_DIR`, `RATE_LIMIT_*`.
- Frontend: `VITE_API_URL` (include `/api`).
- Production requires `NODE_ENV=production`, `MONGO_URI`, `JWT_SECRET`,
  `CORS_ORIGIN`; the server **exits** if any is missing, and refuses
  `SEED_ON_START=true` in production.

## Naming conventions

- Files: components/pages `PascalCase.jsx`; modules/services `camelCase.js`;
  backend routes `xxxRoutes.js`, controllers `xxxController.js`,
  models `PascalCase.js`, services `xxxService.js`.
- React: function components, default export; hooks `useX`.
- API JSON: `{ success, ... }` on success; errors `{ success:false, message, code }`.
- Business ids: products/collections are keyed by **slug**; orders by
  `orderId` (`FA-####`); inventory by `productSlug`.
- Model `toJSON` transforms map `id` (slug for Product/Collection, `orderId` for
  Order) and strip `_id`/`__v`.

## Reuse before you create

- Search the existing services/components/routes first. There is already a
  service per domain, a single `apiClient`, shared UI components (`ProductCard`,
  `StatusPill`, `Skeleton`, `OrderStatusTracker`, admin shell pieces), and shared
  backend helpers (`adjustStock`, `publicCache`, `querySafety`, `errorMiddleware`).
- **Do not duplicate** existing services or components, add a second HTTP client,
  re-implement stock logic, or add a new dependency when the stack already covers
  the need (see CONTRIBUTING "no unnecessary dependencies").

## Rules for modifying sensitive areas

**Authentication** (`authController`, `authMiddleware`, `apiClient` token handling,
`AdminSessionContext`) — identity comes from the JWT and is re-read from the DB
on every protected request; roles are never trusted from token claims. Suspended
accounts must stay rejected at login *and* on every request. Do not weaken the
401 → session-clear → redirect flow, and keep customer/admin token scopes separate.

**Payments** (`paymentController`, `services/razorpayService.js`) — the server is
authoritative: amounts are recomputed from the stored order total, the Razorpay
order id must match the one the server created, and signatures are verified
server-side (HMAC, timing-safe). Payment endpoints are idempotent. Never trust a
client-supplied amount, order id, or "paid" claim.

**Orders** (`services/orderService.js`) — prices, shipping and totals are
recomputed from the catalogue/settings; client prices are ignored for
customer-originated items. The lifecycle is **forward-only**
(`new → confirmed → in_production → quality_check → ready_to_dispatch → shipped → delivered`)
and must stay so. Order creation runs in a MongoDB transaction with retry.

**Inventory** (`services/inventoryService.js`) — `Inventory.currentStock` is
authoritative. Deductions are atomic with a non-negative guard, run inside the
order transaction, and always write an `InventoryMovement`. The
reserve → release → re-deduct flow is flag-guarded (`item.stockDeducted`) and
must remain idempotent: one paid order = exactly one final deduction. Never set
stock directly; go through `adjustStock`.

**Customer data** — ownership is always derived from `req.user` (never a
client-supplied id); non-owners receive `404` so existence is not disclosed.
Address changes go through `normalizeAddress`. Email is an identity field and is
not editable through the profile-update path.

**Admin functionality** — portal routes are guarded by `AdminRoute` plus
`protect`/`adminOrHandler` on the server. Keep the last-active-administrator
guards (cannot suspend/demote yourself or the last admin) and never expose
`passwordHash`.

**Prepared reference images (3D Studio Phase 1)** — see
[IMAGE_STUDIO.md](./docs/IMAGE_STUDIO.md). Three rules are load-bearing: an
ORIGINAL upload is written once and never overwritten (a second write is refused
with `ORIGINAL_IMMUTABLE`); reference media lives in its own **private** root and
is served only through the authenticated `/api/references/:id/file/:kind` route
(never `public/`, never the CDN, never a cached public read); and a model whose
weights are not cleared for commercial use — including rembg's default
`bria-rmbg` — must stay refused in `services/bgRemoval/rembgProvider.js`,
explicit configuration included. Tenancy follows the usual rule: the workspace
comes from the session, and a mismatch is a 404.

**Deployment configuration** — see [DEPLOYMENT.md](./DEPLOYMENT.md) and the
"Data Isolation" section. `render.yaml` leaves `MONGO_URI`/`CORS_ORIGIN`/
`VITE_API_URL` as manual dashboard values. Changing deployment config can affect
live data; confirm with the owner first.

## Do Not Change Casually

- The **order lifecycle order and forward-only rule**.
- **Server-authoritative pricing** (`config/customGiftPricing.js`, catalogue re-pricing).
- The **inventory hold/release/re-deduct** strategy and `stockDeducted` semantics.
- **JWT scope separation** and the 401 session-expiry behaviour.
- Ownership/404 rules on orders, customers, conversations, notifications, wishlist.
- Rate-limit strategy (failed-login counting, `apiWriteLimiter` prod/dev split).
- The public read cache scope (`utils/publicCache.js`) — orders, payments,
  inventory, notifications, customers and all admin views are deliberately
  **not** cached.
- Design tokens in `frontend/src/index.css` — use the existing
  `--color-*` variables; do not hardcode new colours.
- The **auth-screen exemption in `RouteBootstrapGate`** (`route === 'auth'`
  renders the screen, never the skeleton, during a loading transition). A portal
  sign-in commits the session and signals an `auth` re-hydration; gating that
  screen on `status === 'loading'` unmounts the login page in the same commit,
  which drops the portal-mismatch notice and cancels the deferred hand-over
  (see [MEMORY.md](./docs/MEMORY.md#phase-21--multi-portal-authentication)).
- `AdminRoute` route gating and the `import.meta.env.DEV` gates that keep
  dev-only helpers out of production bundles.

## Required validation after code changes

1. **Typecheck/build** the frontend: `npm run build` (Vite build is this repo's
   compile check — there is no separate typechecker).
2. **Run the backend suite**: `npm run test` (last full sweep: **2701 pass / 0
   fail across all 30 suites**, 2026-10-17), or at minimum the suites your change
   touches. Never run two sweeps at once: suites bind fixed ports and the second run
   reports port-shaped "environmental" failures that look like regressions.
2b. **Boot gate** when you touch `server.js`, a route, a controller import or
   `render.yaml`: `npm run test:boot-gate`. It boots the API from a clean, committed
   view of the tree with an empty uploads/media root and asserts every mounted route
   answers — the failure mode it exists for (a router importing a file that was never
   committed, so the deploy boots only on the author's machine) cannot be caught by
   `npm run build` or by suites that run in the working tree.
3. **Manually verify** the affected flow in the browser (storefront and/or
   `/admin`), checking console and network for errors.
4. Report what you ran and what you observed. Never claim a flow works because
   "the tests pass" when the change is UI-only, and never weaken or delete an
   assertion to make a suite go green.

  3D STUDIO (Phase 1 image studio + Phase 2 model generation/approval):
    services/3dModelProvider.js       provider policy: local-first default, Meshy 7.1 explicit
                                       opt-in (BOTH 3D_PROVIDER=meshy AND MESHY_API_KEY), never a
                                       paid fallback; models/GenerationJob.js and
                                       models/Product3DAsset.js (one approved asset per product,
                                       approve deprecates the previous); services/3dGenerationService.js
                                       (job -> provider -> validated candidate), services/3dAssetService.js
                                       (life cycle + private reads), services/3dModelValidation.js
                                       (glyf container validation from the bytes), services/3dAssetStorage.js
                                       (PRIVATE root, ASSET_IMMUTABLE, traversal-refused), routes/3dModelRoutes.js
                                       + controllers/3d*Controller.js; admin 3D Model Studio =
                                       GenerationJobsForProduct.jsx (generate, poll jobs, preview,
                                       approve/reject, version history) with the lazy Three.js viewer
                                       (components/admin/ThreeGlbPreview.jsx, lazy chunk, drag-to-rotate /
                                       scroll-to-zoom / reset / loading | error | empty states).
                                       Every read/write is workspace-scoped; a mismatch is a 404.
                                       The generated model is a CANDIDATE first; approval (not
                                       regeneration) makes it live, and a rejected or failed
                                       replacement never touches the live model.
  PHASE 3 (customer 3D, approved models only):
    services/product3dPublicResolution.js (narrow public projection + delivery URL),
    controllers/3dPublicDeliveryController.js, routes/3dPublicRoutes.js (mounted on
    /api/3d AFTER the staff router), services/3dAssetService.js:findApprovedInWorkspace,
    the optional `product3d` on GET /api/products/:slug; frontend services/product3dService.js,
    components/Product3dViewer.jsx (a lazy chunk REUSING components/admin/ThreeGlbPreview.jsx)
    and the ProductPage gallery's "3D View" toggle. Rules: the projection exposes ONLY
    {id, version, provider, hasModel, bytes, thumbnail, delivery.glb, validation, settings};
    the model is resolved from the PRODUCT's workspace (a visitor has none); every refusal
    is a 404 ASSET_NOT_FOUND, never a 403; the bytes are re-validated as a GLB on every
    delivery; the GLB is `public, max-age=600, must-revalidate` (bounded, never immutable);
    the metadata projection is cached 30s under `3d:model:<slug>` and invalidated on
    approve/reject/delete and every product write; the private media root and the staff
    media route are untouched, and the GLB is fetched only when the customer opens 3D View.

  PHASE 5 (the model quality gate — a valid GLB is not automatically a product model):
    services/3dQualityAssessment.js (verdicts PASS/REVIEW/BLOCKED, thresholds, fingerprint),
    services/3dMeshGeometry.js (GLB geometry reader + documented orthographic projection),
    services/3dSilhouetteMetrics.js (masks, normalisation, IoU, contour distance, view
    selection), services/3dAssetService.js (assessAssetQuality / ensureQualityReport /
    approveAsset — THE enforcement point — plus reassessAsset behind
    POST /api/3d/assets/:assetId/assess), models/Product3DAsset.js `quality`
    (decision, report, fingerprint, review, override); admin UI = GenerationJobsForProduct.jsx
    (decision, per-metric values, warnings, review acknowledgement, administrator override
    with a reason); scripts/3d-quality-smoke.mjs (`npm run test:3d-quality`) and
    scripts/3d-quality-report.mjs (measures a REAL model into the gitignored
    audit/phase5-quality/). Rules: a verdict is only ever produced server-side from the
    stored bytes + the accepted reference + the configured thresholds, and is bound to a
    fingerprint of them — a changed model, reference set or setting invalidates it and
    clears the review acknowledgement and any override before a new assessment runs; a
    `quality`/`score`/`decision` field in a request is IGNORED; BLOCKED refuses normal
    approval and only an administrator may override, with a reason, which records the
    verdict it overrode; an uncertain view or a doubtful reference requires REVIEW, never a
    silent pass. `THREE_QUALITY_*` configures the bands.

  PHASE 6 (validation & hardening — browser coverage + genuine-model evaluation):
    frontend/e2e/specs/13-quality-review.spec.js (FLOW 31–36) draws the review panel in a
    real browser for PASS / REVIEW / BLOCKED / failed / stale / rejected-replacement
    states; frontend/e2e/stack.mjs provisions every candidate through the shipped
    services and ASSERTS each fixture's intended verdict at boot (fixtures shared via
    frontend/e2e/support/fixtures.js, never imported from stack.mjs — that file EXECUTES).
    The stack PINS BOTH private media roots in pinMediaRoots() BEFORE the first backend
    media import: referenceAssetStorage resolves its root once at import time, so a later
    assignment writes fixture cutouts where the backend never looks and the failure only
    surfaces when approval re-measures. Three genuine TripoSR models (rigid vase, floral
    posy, decorated card) were generated on the local GPU and measured with
    scripts/3d-quality-report.mjs; all three scored REVIEW, so the bands were left
    UNCHANGED and explicitly provisional — a genuine single-view reconstruction measured
    against an angled catalogue photograph cannot reach passAspectError 0.25, which is a
    limitation of comparing an orthographic projection with a photograph, not a defect in
    the models. Do not "fix" that by tuning bands to three samples. Real generation now
    writes its artifacts (GLB + accepted cutout + verdict) BEFORE approval and exits 3
    when the gate refuses, so a refusal still leaves evidence.
