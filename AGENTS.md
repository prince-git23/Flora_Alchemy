# AGENTS.md — Instructions for AI coding agents

Flora Alchemy is a full-stack e-commerce boutique (handcrafted botanical keepsakes,
personalized gifts) with a customer storefront and a staff **Handler Portal**.

This file is the short, practical briefing. Deeper detail lives in
[`docs/`](./docs): [ARCHITECTURE](./docs/ARCHITECTURE.md),
[DESIGN](./docs/DESIGN.md), [MEMORY](./docs/MEMORY.md), [API](./docs/API.md),
[DATABASE](./docs/DATABASE.md), [TESTING](./docs/TESTING.md),
[IMAGE_STUDIO](./docs/IMAGE_STUDIO.md) (3D Studio Phase 1 — prepared product
reference images), [ATELIER](./docs/ATELIER.md) (the cinematic 3D workshop on the
storefront: chapters, tiers, fallbacks, the studio hand-off), [CINEMATIC_STAGE](./docs/CINEMATIC_STAGE.md)
(the homepage's one dedicated WebGL stage: a scroll-driven camera through six of the
repository's own photographs hung as depth-separated planes — the plane table, the
five-shot path, and the FLOW 43–51 camera-proof checks), [RECOVERY](./docs/RECOVERY.md) (production database recovery
runbook), [RECOVERY_WINDOW](./docs/RECOVERY_WINDOW.md) (what is and is not
recoverable from October 5–17), [BACKUP_AND_INTEGRITY](./docs/BACKUP_AND_INTEGRITY.md)
(scheduled backups, integrity monitoring, restore drills — Phase 8),
[THREE_PRODUCTION_PLAN](./docs/THREE_PRODUCTION_PLAN.md)
(durable media + provider, and the approvals they need),
[CONTRIBUTING](./docs/CONTRIBUTING.md), and [DEPLOYMENT](./DEPLOYMENT.md).

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
| Frontend | React 19, Vite 6, Tailwind CSS v4 (`@tailwindcss/vite`), react-router-dom 7, GSAP (+ScrollTrigger), lucide-react, Lenis (smooth scroll) |
| Storefront 3D | three.js, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing` — **only ever behind a lazy boundary**, never in the entry bundle |
| Backend | Node ≥18, Express 4.22, Mongoose 8, JWT (`jsonwebtoken`), `bcryptjs`, `helmet`, `cors`, `express-rate-limit`, `multer`, `dotenv` |
| Database | MongoDB (Atlas or local) |
| Auth | Stateless JWT Bearer tokens; **separate** customer and admin sessions |
| Integrations | Razorpay (TEST-mode adapter, optional), ImageKit (image CDN, optional) |
| Tests | Hand-rolled Node smoke suites in `backend/scripts` (no test framework) |

No TypeScript, no state-management library, no test runner. `three.js` is used
only in lazy chunks (the product 3D viewer), never in the entry bundle:
`FLOW 27` and `FLOW 41` fail the build if a renderer is reachable on first
paint.

## Structure

```
frontend/src/
  App.jsx              routing (every page lazy-loaded) + auth-expiry handler
  main.jsx             provider nesting: Data → Store → AdminSession → App
  components/          shared storefront UI (+ components/admin/ for the portal),
                       SmoothScroll (Lenis), CinematicRouteTransition
  atelier/             ISOLATED EXPERIMENT (not on any customer route): the 3D
                       workshop that predated the photographic redesign; kept
                       as a reference implementation behind its own lazy
                       boundary, reachable by nothing
  cinematic/           the shared motion primitives (MotionBits.jsx: SplitText,
                       Magnetic) used by the photographic homepage
  pages/               one file per route (+ pages/admin/)
  context/             Data, Store, Theme, AdminSession providers
  hooks/               useStoreVersion
  services/            apiClient (all HTTP), api (guest cart), dataStore, domain services
  lib/gsapSetup.js     GSAP + ScrollTrigger registration
  lib/cinematicMotion.js  the camera vocabulary (useCinematic + pullBack/pushIn/
                       trackX/crane/parallax/maskReveal/focusPull/sceneEnter)
                       every photographic scene shares
  components/cinematic/  MotionBits (SplitText/MaskedLines/WordReveal/EmphasisSettle/
                       Magnetic/SpotlightCard), the ONE sanctioned WebGL surface —
                       PhotoPlaneStage (a lazy R3F canvas, the only three.js/R3F the
                       storefront may reach: six real photographs as depth-separated
                       planes, one scroll-driven camera)
                       + SceneStage (its homepage section) + useStageCapability;
                       see docs/CINEMATIC_STAGE.md
  index.css            Tailwind import + design tokens (light/dark)

backend/
  server.js            app wiring, helmet/CORS/rate limits, graceful shutdown
  config/              db.js, customGiftPricing.js (authoritative gift pricing)
  routes/              Express routers (thin — wire path → controller)
  controllers/         request validation + response shaping
  services/            25 modules: the core eight (orderService, inventoryService,
                       conversationService, razorpayService, analyticsService,
                       workspaceProvisioningService, orderDestinationService,
                       customRequestPaymentService), the private-media trio
                       (privateMediaRoot.js = ONE place that resolves + probes both
                       roots, referenceAssetStorage.js, privateObjectStorage.js = the
                       fs/object-storage driver seam — `MEDIA_STORAGE_DRIVER=supabase`,
                       a private Supabase Storage bucket over its REST API), the image pipeline
                       (referenceImageService, referenceImageValidation,
                       referenceViews = composite grid detection + panel cutting —
                       there is NO background-removal engine) and the 3D studio
                       (3dModelProvider / 3dLocalWorkerProvider / 3dGpuAgentProvider =
                       provider registry, never a paid fallback; 3dGenerationService,
                       3dAgentService (the machine claim/lease/result protocol),
                       3dAssetService, 3dAssetStorage, 3dModelValidation,
                       3dQualityAssessment, 3dMeshGeometry, 3dSilhouetteMetrics,
                       product3dPublicResolution)
  models/              Mongoose schemas (23)
  middleware/          authMiddleware, errorMiddleware, securityMiddleware (rate limits),
                       permissionMiddleware (granular staff permissions), workspaceMiddleware,
                       agentAuthMiddleware (the GPU agent's machine token)
  utils/               publicCache (TTL cache), querySafety (regex escaping)
  scripts/             smoke suites + run-all orchestrator + lib/testServer.mjs
  seed/seed.js         fixture data (products, collections, customers, orders)

tools/
  3d-worker/            Phase 4: worker.py — real TripoSR inference over loopback HTTP
                        (+ shims/ marching-cubes stand-in). Source only; the venv,
                        model checkout and weights live OUTSIDE the repo (~/flora-3d).
                        agent.py — the REMOTE GPU AGENT for THREE_D_PROVIDER=local_gpu_agent:
                        polls the deployed API over outbound HTTPS with a machine token
                        (THREE_WORKER_AGENT_URL + THREE_WORKER_AGENT_TOKEN), claims one job
                        at a time, downloads only that job's accepted references, runs the
                        same TripoSR inference, uploads the GLB, heartbeats while working.
                        `--diagnose` prints a credential-free CUDA/model/connection report;
                        `--once` handles exactly one job. It is NOT an HTTP server — the
                        deployed API never dials the PC.
```

### Where code belongs

- New storefront screen → `frontend/src/pages/`, registered in `App.jsx` via `lazy()`.
- New cinematic homepage scene → `frontend/src/pages/HomePage.jsx`, using the
  shared camera vocabulary in `frontend/src/lib/cinematicMotion.js` (never
  ad-hoc GSAP). Real photography only; no page may import three.js/R3F
  directly. The old 3D workshop in `frontend/src/atelier/` is an isolated
  experiment — it is not imported by any route and must stay that way.
- The **one sanctioned WebGL surface** is the homepage cinematic stage
  (`frontend/src/components/cinematic/PhotoPlaneStage.jsx`): a real scroll-driven
  camera travelling through six of the repository's own photographs hung as
  depth-separated textured planes — no model, no generated imagery, and no
  claim that a photograph has volumetric geometry — reached only via a **lazy
  `import()`** from `SceneStage` so three.js can never enter the HomePage chunk
  or the entry bundle (FLOW 41 enforces this; see
  [CINEMATIC_STAGE.md](./docs/CINEMATIC_STAGE.md)). Do not add a second
  full-page canvas, do not statically import the stage from a page, and do not
  reintroduce a decorative model GLB — the owner rejected that direction.
- New portal screen → `frontend/src/pages/admin/`, wrapped in `<AdminRoute>`.
- Reusable UI → `frontend/src/components/` (or `components/admin/`).
- New HTTP call → the relevant `frontend/src/services/*Service.js`, which must go
  through `services/apiClient.js`. **Never call `fetch` directly from a page/component.**
- New endpoint → `backend/routes/*Routes.js` → `backend/controllers/*.js`;
  put reusable business logic in `backend/services/`.
- New persisted field → `backend/models/*.js` (additive, with a default).
- New reference-analysis step → `backend/services/referenceViews.js` (or a sibling
  behind it), never inline in a controller. Do NOT reintroduce background removal
  into the REFERENCE STUDIO: it segmented petals, stems and wrapping out of real
  product photographs, and the studio's contract is that a panel crop removes
  SEPARATORS only, never product. (The 3D WORKER does segment — for the inference
  input only, fail-closed and measured; see PHASE H3 below. It never rewrites the
  stored original.)
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
npm test               # all suites via scripts/run-all.mjs — last full sweep 2850 pass / 0 fail across all 31 suites (2026-10-19)
npm run build:e2e      # frontend: build the E2E bundle (loopback API, gateway disabled)
npm run test:e2e       # frontend: build + the Playwright browser suite (real stack)
npm run test:guard     # 30 (database-identity guard; no server, no DB, no writes)
npm run test:pricing   # 22
npm run test:api       # 125
npm run test:integration # 81
npm run test:payment   # 45 (local mock Razorpay)
npm run test:conversation # 34
npm run test:applications # 82 (public application intake → owner review → invitation)
npm run test:security  # 111
npm run test:onboarding # 141 (client admin onboarding + workspace activation + storefront/wishlist tenancy, Phase 22.4–22.5)
npm run test:references # 90 — multi-view references: no segmentation, verbatim originals, 4×3/3×4
                        #       grid detection, panel geometry + idempotent re-confirm, correction,
                        #       labels/order/primary, accept+remove cascade, tenancy/auth
npm run test:3d        # 206 — 3D Studio Phase 2–3: provider policy (THREE_D_PROVIDER + deprecated alias), validation, storage, approval, public delivery
npm run test:3d-worker # 53  — 3D Studio Phase 4: local_worker adapter contract (loopback stand-in, no GPU, spends nothing)
npm run test:3d-real   # OPT-IN real generation via a live tools/3d-worker/worker.py (TripoSR on the local GPU); exit 2 without one, exit 3 when the quality gate refuses approval (artifacts still written); never in `test:all`
npm run test:3d-quality # 106 — 3D Studio Phase 5–7: the model quality gate (geometry, silhouette AND colour; deterministic fixtures; no GPU, no credits)
npm run test:3d-agent   # 68  — remote GPU agent protocol: machine auth, atomic claim, lease/heartbeat/abort,
                            #       input scoping, result idempotency, cancel, staff-payload leaks (mock agent, no GPU)
npm run test:supabase-storage # 72 — the Supabase Storage object driver against a local
                            #       Storage-REST-emulating mock (config diagnostics, credential
                            #       discipline, key-format header rules — apikey-only for
                            #       sb_secret_ keys, both headers for legacy JWTs — key safety,
                            #       round trips, listing, deletion, failures, production guard,
                            #       FAIL-CLOSED bucket-privacy guard, status honesty)
npm run test:media-storage # 75 — private media: absolute/cwd-independent roots, traversal, immutability, typed write failures, missing bytes
npm run test:marketplace # 108 — shop identity / marketplace surfaces
npm run test:shop-services # 122 — shop serviceability + delivery promises
npm run test:checkout  # 111 — checkout ownership, totals, reservation/release
npm run test:custom-request # 78 — custom request workflow + proposals
npm run test:backup   # 117 — backups & integrity: export/verify/encrypt, drift, freshness, alerts, real restore drill (Phase 8)
npm run test:boot-gate # clean-checkout boot/route-registration gate (no DB, no writes)
npm run prod:probe     # OPT-IN read-only probe of the deployed API (needs PROD_PROBE_BASE_URL)
npm run media:migrate  # private-media migration (dry run by default; --apply to copy + verify)
npm run test:razorpay-real # real sandbox; SKIPS without rzp_test_* keys
npm run test:supabase-real # OPT-IN live Supabase bucket round trip (write/read/stat/list/delete;
                            #       needs real backend/.env credentials, exit 2 without them;
                            #       never prints the secret). Last live run 2026-10-21: 8/8,
                            #       exit 0 — including the visibility check, after the owner
                            #       made the configured bucket private
```

Every suite boots its **own** backend process against its **own** dedicated
`Flora-Alchemy-Test-*` MongoDB database, so tests never touch dev or production
data. See [`docs/TESTING.md`](./docs/TESTING.md).

**Suites never inherit live storage credentials.** `lib/testServer.mjs` pins
`MEDIA_STORAGE_DRIVER=filesystem` and blanks `SUPABASE_*` for every child server, and
the suites that touch storage in-process call `pinFilesystemMediaDriver()`. Without
that pin, a developer `.env` configured for the live bucket made `test:3d` write its
fixture GLB into the real bucket and fail reading it back.

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

**The shared cluster has a 500-collection cap.** A full 31-suite run needs ~680
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
- 3D Studio: the provider flag is **`THREE_D_PROVIDER`** (`local_gpu_agent`,
  `local_worker`, `meshy`, or unset = disabled), plus `THREE_WORKER_AGENT_TOKEN` /
  `THREE_WORKER_AGENT_URL` for the remote agent and `MEDIA_STORAGE_DRIVER=supabase`
  with `SUPABASE_*` for durable private media. Never use the old `3D_PROVIDER`
  spelling in configuration: Render rejects environment names that begin with a
  digit. It survives only as a deprecated local alias that `THREE_D_PROVIDER`
  overrides — every read goes through `3dModelProvider.providerEnvSource()`.
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
`bria-rmbg` — the licence-cleared-only rule still governs any future engine. Tenancy follows the usual rule: the workspace
comes from the session, and a mismatch is a 404. Every object-storage write is
also gated by the bucket-privacy guard (`assertBucketPrivate`): a bucket that is
PUBLIC, missing, foreign, malformed or unverifiable refuses the write
(`STORAGE_BUCKET_PUBLIC` / `STORAGE_PRIVACY_UNVERIFIED`) with no filesystem
fallback, and its 60 s confirmation cache must never be presented as a fresh
check.

**Backups & data-integrity monitoring (Phase 8)** — see
[BACKUP_AND_INTEGRITY.md](./docs/BACKUP_AND_INTEGRITY.md). `scripts/backup.mjs`
is the scheduled-backup tool: `--status`/`--verify`/`--prune` are read-only,
`--export` never overwrites an existing artifact, `--upload` refuses an
unencrypted payload, and `--restore-drill` may only write to a protected-checked
disposable database (disposed afterwards through `db-footprint.mjs --only=`).
Production restores still belong to `scripts/recovery.mjs` with its confirmation
gate — the backup tool has no production-write path. Drift is measured against
the operator-accepted baseline (`--accept-baseline`), never hard-coded counts;

growth never alerts, and a check that cannot run reports `unknown`, never
pass. The nightly workflow (`.github/workflows/backup-nightly.yml`) is INACTIVE
until the owner sets its secrets — never claim backups are running without
verifying the Actions history and the newest artifact in the destination bucket.

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
- The **lazy boundary** around the atelier and the product 3D viewer, and the
  `SmoothScroll` line that sets `documentElement.scrollBehavior = 'auto'`. The
  storefront's `html { scroll-behavior: smooth }` plus Lenis makes every
  programmatic scroll a no-op; and `position: sticky` cannot hold the atelier
  stage under `body { overflow-x: hidden }` — the stage is pinned by
  ScrollTrigger for exactly that reason. Both are measured, not stylistic.
- The **atelier → studio hand-off contract**: `atelier/palette.js:studioHref()`
  may send only ids the studio itself offers (`base`, `palette`, `seal`,
  `ribbon`, `monogram`, `name`). The studio validates them against its own
  catalogues and keeps server-authoritative pricing; a scene must never send a
  price, a quantity or a line.

## Required validation after code changes

1. **Typecheck/build** the frontend: `npm run build` (Vite build is this repo's
   compile check — there is no separate typechecker).
2. **Run the backend suite**: `npm run test` (last full sweep: **2850 pass / 0
   fail across all 31 suites**, 2026-10-19), or at minimum the suites your change
   touches. Never run two sweeps at once: suites bind fixed ports and the second run
   reports port-shaped "environmental" failures that look like regressions.
1b. **Storefront UI**: the browser suite is the only automated coverage (there
   is no frontend unit runner). For the cinematic homepage and the 3D viewer:
   `cd frontend && npm run build:e2e && npx playwright test specs/14-cinematic-home.spec.js`
   (FLOW 40–42, 40b/40c) and `specs/12-product-3d.spec.js` (FLOW 25–30).

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
                                       opt-in (BOTH THREE_D_PROVIDER=meshy AND MESHY_API_KEY), never a
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

  PHASE 7 (colour fidelity — a correctly shaped model can still render black):
    services/3dMeshGeometry.js:measureColourTier() reads the colour facts out of the
    stored GLB (colour source: base-colour texture / COLOR_0 / none; the metallicity a
    PBR viewer will apply; the linear-light distribution), and
    services/3dQualityAssessment.js judges colour as its OWN section (reasons +
    warnings + report.colour) under ASSESSMENT_VERSION phase5-2: MATERIAL_MISSING_DIELECTRIC,
    MATERIAL_FULLY_METALLIC, COLOUR_DARK_COLLAPSE, COLOUR_GREY_COLLAPSE, COLOUR_PARTIAL_ALPHA
    (all REVIEW-grade) plus MATERIAL_NO_COLOUR_DATA / MATERIAL_NONE as warnings. Bands:
    THREE_QUALITY_MAX_NEAR_BLACK_FRACTION (0.35), THREE_QUALITY_MIN_MEAN_SATURATION (0.04) —
    provisional, like Phase 5's. Root cause it exists for: TripoSR exports COLOR_0 with no
    `materials` array, and glTF's fallback material is fully METALLIC, so the stored colour is
    multiplied away — tools/3d-worker/worker.py:ensure_dielectric_material() now writes a
    dielectric material (metallic 0, roughness 0.6) into a material-less GLB, BIN chunk copied
    byte for byte, never overriding a material the engine declared, and the job FAILS if it
    cannot. The viewer (components/admin/ThreeGlbPreview.jsx) adds a neutral RoomEnvironment
    IBL, NeutralToneMapping and a legacy-material repair (rendering only, never a claim that
    the asset is well-formed). RULES: `publicAssetProjection` in models/Product3DAsset.js is an
    allowlist and the review panel reads ONLY the projection — a report field that is not
    projected is invisible to the reviewer (this omission is what FLOW 32 caught); the colour
    numbers are measured from bytes, never from a screenshot, and no hue comparison against the
    photographs is made or implied.

  PHASE H3 (the inference input — no reconstructed room, and no destructive cutout):
    tools/3d-worker/worker.py:harden_reference() is the ONLY place an accepted reference becomes
    an inference input: segment (rembg, default `isnet-general-use`) → MEASURE the mask and
    REFUSE a bad one (`MASK_EMPTY` / `MASK_FULL_FRAME` / `MASK_WASHY` / `MASK_TOUCHES_BORDER` /
    `MASK_FRAGMENTED` / `MASK_SPECKS_ONLY`, all `MaskRejected` → the job FAILS with the reason
    and the per-image stats) → drop speck and disconnected-secondary islands (measured, only
    relative to the mask) → composite the product over neutral 0.5 grey and crop/square it.
    select_reference() scores up to 4 candidates AFTER masking and consumes exactly ONE;
    `inputUsed` + per-candidate mask facts + rejections are recorded. THIS IS SELECTION, NOT
    MULTI-VIEW: TripoSR is single-image, `describeProvider().inputMode === 'single_view'`, and no
    UI or doc may imply the stored views are used jointly. Segmenters are chosen explicitly
    (`--segmenter rembg|alpha|photo`); `photo` is an operator bypass that is MEASURED and
    flagged, never a silent fallback, and `alpha` fails closed when the reference has no matte.
    The ORIGINAL photo is never rewritten; there is no background shell and no white backdrop
    mesh — the model contains the product only, and the viewer's backdrop is CSS.
    The worker's diagnostics ride to the backend as a bounded query param
    (`?stats=`, ≤6 KB encoded, re-filtered by `pickResultMetrics`), are stored on
    `job.providerExtra.metrics`, and are written BEFORE the candidate is assessed
    (`recordProviderMetrics`) because the gate reads them. Consequences in
    services/3dQualityAssessment.js: the measured silhouette comes from the WORKER'S OWN mask
    (`maskSource: 'worker-foreground-mask'`, 128 px, so IoU is coarse by construction), the
    comparison reference is `inputUsed.id` rather than the nominal primary, and geometry is
    judged for fragmentation (`MESH_FRAGMENTED`, > 8 components or largest share < 60%) and
    depth against a CATEGORY band (`depthBandFor`: flat paper goods 1.5%, solid 3D goods 8%,
    explicit `THREE_QUALITY_MIN_DEPTH_RATIO` wins) — `THIN_OUTPUT` is REVIEW, never an automatic
    extrusion. Worker-side cleanup only drops components tiny against BOTH the whole mesh and
    the main body; a detached petal survives. Viewer: three-quarter default framing fitted to
    the frustum, Reset, drag/zoom, `data-vertex-colors`/`data-material-count`/`data-mesh-count`
    facts, and a staff-only wireframe aid (dense reconstructions read near-solid until zoomed —
    the numeric PIECES metric is the reliable signal).
