# Flora Alchemy — Project Memory

Durable knowledge for future agents and maintainers. This is **not** a work log —
it records only things that should change how you act. Related:
[AGENTS.md](../AGENTS.md), [ARCHITECTURE.md](./ARCHITECTURE.md),
[DATABASE.md](./DATABASE.md), [TESTING.md](./TESTING.md), [DEPLOYMENT.md](../DEPLOYMENT.md).

---

## Project Identity

Flora Alchemy is a full-stack e-commerce boutique selling handcrafted botanical
keepsakes, floral art and personalized gifts, priced in **INR**. One repository
contains two surfaces:

- a **customer storefront** (browse, search, collections, gift finder, custom gift
  studio, cart, checkout, order tracking, account, wishlist, order messaging), and
- a **Handler Portal** (`/admin`) for staff (orders, products, collections,
  customers, inventory, analytics, settings, operator access, conversations,
  custom requests).

Stack: React 19 + Vite + Tailwind v4 frontend; Express + Mongoose backend on
MongoDB; stateless JWT auth; optional Razorpay (payments) and ImageKit (images).
Deployed as a Vercel static frontend + Render backend.

## Architecture Decisions

- **SPA + REST API, no shared code.** The browser only ever talks to its own
  `/api`. Third-party provider credentials never reach the client.
- **Single HTTP client.** All frontend HTTP goes through
  `frontend/src/services/apiClient.js`. Pages/components never call `fetch`
  directly. Domain services layer on top.
- **No local business-data mock.** `services/api.js` persists only the guest cart.
  Everything else is server-authoritative and hydrated into `services/dataStore.js`.
- **Context-based state, no state library.** `DataContext` (hydrated business data),
  `StoreContext` (cart + wishlist + toasts), `ThemeContext`, `AdminSessionContext`.
- **Route-level code splitting.** Every page is `lazy()`-loaded; admin chunks are
  never downloaded by storefront visitors.
- **Layered backend.** thin routes → validating controllers → reusable services →
  Mongoose models, with shared middleware for auth, errors and rate limiting.
- **Localized loading over global loaders.** A single mutation must update only its
  slice; a full-store re-hydration is reserved for genuine scope changes
  (login/logout).
- **Two independent status axes.** `orderStatus` (fulfilment lifecycle) and
  `paymentStatus` are deliberately decoupled — a paid order can still be `new`.

## Business Rules

- **Server-authoritative pricing.** Catalogue prices are re-read from `Product` at
  order time; shipping and totals are recomputed from `Settings`. Client-supplied
  prices are ignored for customer-originated items. Custom Gift Studio and add-on
  prices resolve from `backend/config/customGiftPricing.js` by configuration ID.
- **Orders are forward-only.** `new → confirmed → in_production → quality_check →
  ready_to_dispatch → shipped → delivered`. Backwards or unknown targets are
  rejected (`422 INVALID_TRANSITION`).
- **Inventory is authoritative in `Inventory.currentStock`**, keyed by
  `productSlug`, unique. There is no available/reserved split. Every change goes
  through `adjustStock()` and writes an `InventoryMovement`.
- **Stock is held, not consumed, on creation.** A pending-payment order holds stock
  (`item.stockDeducted = true`); failure/cancellation releases it; success keeps the
  single deduction. **One paid order = exactly one final deduction.**
- **No oversell, ever.** The atomic `findOneAndUpdate` filter requires
  `currentStock >= -delta` for deductions, and stock is pre-validated inside the
  order transaction before the Order document is written.
- **Made-to-order items are not stock-tracked** (`isCatalogue: false`): custom
  gifts and the packaging add-on.
- **A stock-tracked product with no inventory record means stock 0** (unavailable) —
  never silently purchasable.
- **Ownership and disclosure.** Customers may only read their own orders, profile,
  addresses, wishlist, notifications and conversations. Non-owners get **404**, not
  403, so record existence is never disclosed. Staff (`admin`/`handler`) read all.
- **One conversation per `(orderId, customerId)`.** Only staff may close/reopen.
- **Custom-request `adminNotes` are internal** and excluded from customer responses.
- **The last active administrator cannot be suspended, demoted, or deleted**, and
  operators cannot change their own role/status.
- **Guests get no fake accounts.** Wishlist saving requires sign-in; the cart is the
  only purely local commerce state.

## Critical Constraints

Things that look like small refactors but are load-bearing:

- **Order ids** are seeded from the database maximum and existence-checked, then
  fall back to a timestamp id. Restarting the process must never reuse an
  `FA-####` that is already persisted (a duplicate-key failure killed every
  subsequent order before this).
- **Concurrency errors must stay 4xx.** MongoDB `WriteConflict` / duplicate-key at
  the transaction level is retried once and then surfaced as
  `409 INSUFFICIENT_STOCK` — never a raw 500.
- **Idempotency of payment + stock.** Verification, webhooks and release/re-deduct
  are all flag- and state-guarded. Repeating any of them must not double-charge,
  double-deduct, or regress a paid order.
- **Legacy boolean fields must be read defensively.** `stockTracked !== false` and
  `product.stockTracked !== false` deliberately treat missing fields as *tracked*;
  reading the raw flag made older documents never deduct (oversell).
- **Slug is the product/collection identity.** Renaming a product must migrate its
  `Inventory` record, or stock is orphaned and the next order fails.
- **Public read caching is narrowly scoped.** Only public products, collections and
  settings are cached (30 s, write-invalidated). Orders, payments, inventory,
  notifications, customers and **all** admin views must never be cached. Stock is
  attached *after* the cache read so availability is always live.
- **`req.user` is always re-read from the database.** Never trust roles or identity
  from token claims; suspension must take effect on the next request.
- **Session-expiry flow** (401 → clear scope token → `fa:auth-expired` → correct
  login screen, preserving checkout context) is a contract, not convenience.
- **The guest cart is the only local commerce state** — do not "fix" persistence by
  caching orders or prices client-side as authority.

## Deployment Knowledge

**Development and production use distinct databases on the shared cluster**
(Phase 22.5): local development resolves to `flora_alchemy_dev`, and the deployed
Render service resolves to `Flora-Alchemy`. The former shared-database defect is
**resolved** — a local write no longer appears in the production API.

Rules that still hold:

- **Confirm the database target before any destructive QA/cleanup run.**
  `Flora-Alchemy` is production (protected by the migration scripts' confirmation
  gates); `flora_alchemy_dev` is disposable.
- **The cluster is shared and has a 500-collection cap** — clean up
  `Flora-Alchemy-Test-*` / `prod-smoke-*` databases; never drop `Flora-Alchemy` or
  `flora_alchemy_dev`.
- Never create fixture/demo documents (`isFixture: true`) in production.
- **`SEED_ON_START=false` in production** is enforced (the server exits otherwise).
- Prefer additive, reversible operations; back up documents before deletes.

Note: the automated test suites boot their own server against its own dedicated
`Flora-Alchemy-Test-*` database.

Also recorded in [DEPLOYMENT.md](../DEPLOYMENT.md) ("Data Isolation") and
[DATABASE.md](./DATABASE.md#production-data-isolation-resolved).

## Phase 21 — Multi-Portal Authentication

- **Three portals, one auth endpoint.** `/owner/login`, `/admin/login` and
  `/staff/login` are distinct surfaces, but all three post to the single
  `POST /api/auth/login`. The optional `portal` body field is a *navigation
  context*, never a grant: the server resolves the identity from the database
  and refuses a mismatch with `403 PORTAL_FORBIDDEN` (authority:
  `backend/utils/portals.js`). Omitting `portal` preserves the legacy path used
  by the storefront customer login.
- **Policy:** `owner` requires `role=admin && isOwner`; `admin` accepts any
  administrator (the owner included); `staff` accepts handlers only;
  administrators/owners are refused the Staff Portal and customers are refused
  every staff portal. Roles remain exactly `customer | handler | admin` — the
  Owner is an administrator with `isOwner=true`.
- **The hand-over is rendered by the login screen, so the login screen must
  survive it.** When an identity signs in at a portal the policy *permits*
  (an owner at `/admin/login`), the page shows a mismatch notice naming the
  account's portal and navigates to it ~2.2s later. That deferred navigation
  lives in the routed login page, so `RouteBootstrapGate` must not swap an
  auth-class screen (`route === 'auth'`: the three portal logins, `/login`,
  `/access`, the public activation/application forms) for the skeleton while a
  loading transition is in flight — the sign-in's own `auth` re-hydration is
  exactly such a transition. Gating it unmounted the page mid-hand-over: the
  notice never rendered, the pending redirect was cancelled by the page's
  unmount cleanup, and an authenticated owner was left on a silent login form.
  Regression coverage: the responsive audit's `auth-owner-admin` cases
  (`node frontend/scripts/responsive-audit/run.mjs --only=auth-`).
- **The gateway is not authorization.** `/portal` (Portal Access Gateway) only
  routes to a login form. Direct URLs, the sidebar and the header are UX; the
  server is the authority on every request (`protect` re-reads the user, so a
  suspended account loses access on the very next call and a forged JWT claim
  cannot grant ownership).
- **Owner bootstrap.** `npm run provision-admin` accepts `OWNER_EMAIL` /
  `OWNER_PASSWORD` (aliases of `PROVISION_ADMIN_EMAIL` / `PROVISION_ADMIN_PASSWORD`),
  creates exactly one owner (`role=admin`, `isOwner=true`, `isFixture=false`,
  `ACTIVE`), refuses a second run once any active administrator exists, and never
  prints or stores the plaintext password. The production confirmation gates are
  unchanged.
- **Owner-only API.** `GET /api/owner/overview` and `GET /api/owner/administrators`
  sit behind `protect + requireOwner` (Phase 21.2).
- **Known cluster constraint:** the shared MongoDB cluster has a 500-collection
  cap. Accumulated `Flora-Alchemy-Test-*` / `prod-smoke-*` databases filled it and
  caused a provisioning smoke failure (`cannot create a new collection -- already
  using 502 collections of 500`). Stale disposable test databases were dropped to
  free 424 collections. If suites start failing that way again, drop
  `Flora-Alchemy-Test-*` / `prod-smoke-*` databases — never `Flora-Alchemy`
  (production) or `flora_alchemy_dev`.

## Phase 21.4–21.7 — Personnel Lifecycle (OWNER → ADMIN → HANDLER)

- **Administrators are never created directly.** The only path to an
  `isOwner=false` administrator account is: public application → owner review →
  approval (atomic; mints **exactly one** invitation) → one-time invitation →
  activation. `POST /api/admin/invitations` fixes `role='handler'` and rejects
  anything else with `422`, so the handler-invite endpoint can never mint an
  administrator. A plain administrator therefore has no way to manufacture an
  administrator account.
- **Administrator invitations are owner-only.** `assertCanMutateInvitation` in
  `backend/controllers/staffInvitationController.js` refuses a non-owner
  administrator who tries to **resend or revoke** an invitation whose `role` is
  `admin` (`403 OWNER_REQUIRED`), checked *before* any state inspection so the
  refusal never leaks whether the link is live. Without it, resend would let a
  plain admin mint a fresh administrator activation link — the exact
  privilege-escalation the business rule forbids.
- **The Owner Administrators Directory exposes the invitation queue, not just
  accounts.** There is no "Add
  Administrator" control anywhere. `/owner/administrators` offers *Review
  Applications* / *Invite approved administrator* (both route to the approval
  ledger where the invitation is actually minted) and, per selected dossier,
  *Resend* / *Revoke* / *Suspend* / *Reactivate*. Pending administrator
  invitations appear as registry rows (`kind='invitation'`, `INV-…` badge) and
  carry **server-derived** `actions`, so the UI only ever offers a control the
  backend will accept.
- **Audit.** Every meaningful transition is a `StaffEvent` (application
  submitted/approved/rejected, invitation created/resent/revoked, account
  activated, login, suspended, reactivated). Events store actor, target, action
  and timestamp — never a token, hash or password.
- **`npm run test:lifecycle`** (`scripts/personnel-lifecycle-smoke.mjs`, 110
  assertions) proves the whole chain against a disposable DB with no seeded
  fixtures: owner → public application → atomic approval → invitation → admin
  activation (`ADM-…`) → `/admin/login` → handler invitation → activation
  (`HND-…`) → `/staff/login` → owner suspends admin (existing token dies on the
  next request) → reactivate → access restored, plus the full RBAC negative
  matrix and the invitation security properties.

## Phase 21.8–21.11 — Multi-Portal UI + Responsive Hardening

- **`/access` is the Portal Access Gateway.** It is canonical; `/portal` stays as
  a `<Navigate replace>` so older links survive. The page is pure navigation —
  three cards route to `/owner/login`, `/admin/login`, `/staff/login` — and it is
  in `routeDataRequirements.AUTH_SCREENS`, so it renders with `critical: []` and
  only background-warms the catalogue.
- **One shell, portal-aware copy.** `AdminLayout` names the portal the session
  actually belongs to (`Owner Console • Governance` / `Administrator Console •
  Operations` / `Staff Portal • Operational Work`). It used to call every console
  the "Handler Operations Portal". The owner badge is `OWN-…`, never `ADM-…`.
- **Dialogs trap focus.** `AdminModal` in `StaffPrimitives.jsx` moves focus into
  the dialog, traps Tab with wrap-around, closes on Escape and restores focus to
  the trigger, and locks body scroll. Two dialogs can stack (the owner directory
  opens a dossier and then a suspension confirmation), so a module-level
  `MODAL_STACK` ensures **only the topmost** dialog answers keystrokes. The
  lifecycle effect depends on `open` alone and reads `onClose` through a ref —
  with `onClose` in the deps it re-ran every render and its cleanup kept yanking
  focus back to the trigger. The dialog **container** takes initial focus
  (`tabIndex={-1}`) because a dossier's content arrives asynchronously and
  focusing its first control would lose focus when that control is replaced.
- **Touch targets.** Phone-only sizing (`max-md:min-h-[44px]`) lifts sub-24px
  controls to a real target without changing desktop density. Fixed on the owner
  directory (KPI footer link, search, filter chips, header actions) and the
  orders table shared by `/admin/orders` and `/staff/orders` (row/select-all
  checkboxes now sit inside a sized `<label>` — which also gives them accessible
  names — plus the order-number links and the payment filter).
- **Login form errors are programmatically associated.** The alert block carries
  `id="portal-login-error"`, and both inputs set `aria-invalid` and
  `aria-describedby` while an error is shown.
- **Known limitation — no automated interaction testing.** The responsive audit
  measures layout only: synthetic input (CDP mouse, Enter, or in-page
  `element.click()`) does not reliably reach the React handlers in the
  audit-probe environment — even the theme toggle stays inert — so dialog focus
  behaviour is covered by code plus a manual browser check (Escape → focus
  returns to the opening control was observed), not by automation.

## Phase 22 — Multi-Tenant (Workspace) Architecture

- **One database, many workspaces.** Every operational row carries a sparse
  `workspaceId`; staff identities are workspace members, while **owner and
  customer identities are global by design** (`workspaceId` absent).
- **The slug is a lookup key, never authorization.** `{ workspaceId }` comes from
  `req.user.workspaceId` (re-read from the DB each request), never from a body or
  query — `workspaceMiddleware.stripClientWorkspaceId` scrubs client `workspaceId`
  before any controller runs.
- **Strict scope (Phase 22.5).** Operational queries use `{ workspaceId }`; the
  legacy `$in [id, null]` migration window is **removed** — do not reintroduce it.
- **A workspace is created in exactly one runtime place:** the admin-invitation
  activation transaction (`services/workspaceProvisioningService.js`) — plus the
  guarded `backfill-workspaces.mjs` for existing data. Never implicitly, never
  from a request body.
- **Production is migrated.** The production `Workspace` (`slug=flora-alchemy`,
  `status=ACTIVE`, `primaryAdminId=null`) owns every legacy operational row; the
  post-migration audit reports **0 unscoped operational rows**.
- **Public storefront** `GET /api/shops/:slug` (+ `/products` `/collections`
  `/settings`) is tokenless and returns only public-safe data — no inventory
  quantities, no staff, no settings PII. Unknown/suspended/reserved slugs answer an
  indistinguishable `404 SHOP_NOT_FOUND`.
- **Migration scripts are guarded.** `backfill-workspaces.mjs` refuses production
  unless both `PRODUCTION_DB_NAMES` and `CONFIRM_DATABASE_UNSAFE_OPERATION=<db>`
  are set; `ensure-workspace-indexes.mjs` detects duplicates before writing and
  runs with `autoIndex=false`; `attach-wishlist-workspaces.mjs` requires exactly
  one ACTIVE workspace. Full detail: [MULTI-TENANT.md](./MULTI-TENANT.md).

## Pre-Merge Release Audit — 2026-10-13

Three defects found by an independent audit of the Phase 5–7 work, fixed on
`audit/phase7-premarge-fixes` with regression coverage. Each is the kind of
failure that hides behind a green test run, so each is recorded with the probe
that would catch it again.

- **A rejected browser origin answered HTTP 500, not 403.** The `cors` origin
  callback handed a plain `Error` to `next`, so the generic error handler read a
  policy decision as a server fault. Any unlisted origin made the API look down —
  and the 5xx could be raised at will from the open internet. It now fails
  closed with `403 ORIGIN_NOT_ALLOWED`, no `Access-Control-Allow-Origin`, a static
  body that never echoes the origin, and the request is not processed. `cors` runs
  before routing, so `/api/health` **with** a disallowed `Origin` is refused too;
  Render's probe sends no `Origin` and is unaffected. The allowlist is parsed by
  `backend/utils/corsOrigins.js`: entries are canonicalized (lower-case host, no
  trailing slash, no path) so `https://Store.Example.com/` matches the string a
  browser sends, unusable entries (`*`, `https://*.example.com`, scheme-less) are
  dropped with a boot warning, and a wildcard can never be configured. The
  effective list is logged once at startup. Rejected origins are verified against
  the REAL deployed API, not inferred: `https://flora-alchemyy.vercel.app` is
  allowlisted; a `www` variant and per-deployment Vercel Preview URLs are refused
  (they were refused before the fix too — as 500s), so no Preview origin is
  allowlisted. Coverage: the CORS block of `scripts/security-smoke.mjs` (27
  assertions, all green).
- **The route gate unmounted the login page during its own sign-in.** Committing a
  portal session signals an `auth` re-hydration; `RouteBootstrapGate` swapped any
  screen for the skeleton while that transition was in flight, including the
  auth-class screens (which need no store data at all). An operator signing in at
  a portal that ACCEPTS them but is not theirs was unmounted in the commit that
  should have shown the mismatch notice: the notice never rendered, the deferred
  hand-over was cancelled by the page unmount cleanup, and an authenticated
  operator sat on a silent login form. The gate now leaves `route === 'auth'`
  alone. Coverage: the responsive audit's `auth-owner-admin` cases and
  `frontend/e2e/specs/10-portal-auth.spec.js` (real stack: notice appears, shell
  never rendered for the wrong portal, hand-over completes, refusals stay
  explained).
- **A test asserted by wall clock.** `production-smoke.mjs` sampled `child.exitCode`
  after a fixed `sleep(5000)`; under concurrent load a freshly spawned server had
  not finished importing its module graph, so a correct server was reported as 8
  failures. It polls with a bounded `waitForExit(child)` now, and each rejection
  check additionally asserts a NON-ZERO exit status — a crash can no longer read as
  an honest refusal, and a still-running process is proven not to be reported as
  exited (negative control).

## Phase 2 — Generate and approve a 3D model (3D Studio model studio)

Upload product photographs (Phase 1) and, from the product's ACCEPTED reference set,
generate a validated GLB candidate that an administrator reviews and approves
before it can reach a customer. Nothing here fabricates a model: the generated bytes
are validated from the container first, and an already-approved model is never
destroyed — a replacement is APPROVED or REJECTED, which either DEPRECATES the
previous model or leaves it exactly as-is.

Pipeline — accepted references → GenerationJob (QUEUED → GENERATING → POST_PROCESSING
→ READY_FOR_REVIEW, terminal FAILED/CANCELLED) → validated CANDIDATE
Product3DAsset → APPROVED (previous APPROVED → DEPRECATED) or REJECTED.

Provider policy — LOCAL FIRST, Meshy 7.1 EXPLICITLY OPT-IN. `3D_PROVIDER` must be set
to `meshy` AND `MESHY_API_KEY` must be present; neither alone selects a provider, and
no endpoint ever returns a credential or makes a paid call without both. The default
deployment reports generation unavailable with a reason (no GPU, no runtime), which is
the honest state and is what the studio shows. The test double is registered only by
the test harness through `registerTestProvider`, and a suite that reached api.meshy.ai
is a suite defect, because the suite swaps the transport itself.

Storage — `services/3dAssetStorage.js` keeps GLBs in a PRIVATE root
(`backend/uploads/3d-media` by default, `THREE_MEDIA_ROOT`): a key is relative to that
root, reads resolve it back and refuse traversal, a second write is refused
(`ASSET_IMMUTABLE`), and the authenticated route re-derives the workspace on every
request (`GET /api/3d/media/:slug/:assetId/:kind`) and answers `private, no-store`.
No public read, no CDN, no cached public read, and no model is previewed unless it has
real validated bytes.

Three.js viewport — `components/admin/ThreeGlbPreview.jsx`, the lazy chunk the admin
product page renders for whichever asset it is looking at (a candidate under review
beats the approved model, and there is exactly one live WebGL context per page).
OrbitControls (drag rotate, scroll zoom, pan, reset), `loading` | `ready` |
`error` | `empty` states, and a `loadModel` async loader instead of a URL so the
authenticated blob fetch stays in the service, not the render path. `three` and the
GLTFLoader/OrbitControls addons are only pulled in with dynamic `import()`, which is
what keeps the initial portal bundle free of three.js (verified in the production
build: the entry chunk is clean, the 705 KB three module lands in its own chunk).

### Where the code lives
| Concern | Module |
|---|---|
| Job life cycle, tenancy-scoped reads | `backend/models/GenerationJob.js` |
| Asset life cycle (one approved per product, approve deprecates) | `backend/models/Product3DAsset.js` |
| Provider policy (local-first default, Meshy 7.1 opt-in) | `backend/services/3dModelProvider.js` |
| Job → provider → validated candidate orchestration | `backend/services/3dGenerationService.js` |
| Asset operations (approve / reject / archive / private reads) | `backend/services/3dAssetService.js` |
| GLB container validation from the bytes | `backend/services/3dModelValidation.js` |
| Private GLB media root | `backend/services/3dAssetStorage.js` |
| Staff HTTP surface (`/api/3d`) | `backend/routes/3dModelRoutes.js` + `3dGenerationController.js` + `3dAssetController.js` + `3dMediaController.js` |
| Admin 3D Model Studio (generate, poll, preview, approve/reject, history) | `frontend/src/components/admin/GenerationJobsForProduct.jsx` |
| Lazy three.js GLB preview | `frontend/src/components/admin/ThreeGlbPreview.jsx` |
| 3D client (correct authenticated media paths, no storage key leak) | `frontend/src/services/threeGlbService.js` |

### Verification
`npm run test:3d` — 143 assertions, own server (port 4127) and its own
`Flora-Alchemy-Test-3DStudio` database, own private media roots in the OS temp dir.
> **No AI inference is performed and none is claimed.** The provider implementation is an
> explicit test double (`registerTestProvider`); the transport can never make a network
> call, and the double's download is a genuine glTF Binary container built byte by byte.
> Every other stage is real: accepted reference rows and files, job row, claim,
> worker/poll loop, container validation, private write, candidate, approval + deprecation,
> tenancy scoping, and the HTTP routes and gates. In particular, a `POST` to api.meshy.ai
> would be a **suite defect** — it happened on the first run because the suite's opt-in env
> vars leaked into the child server, and the suite now restores them, forces them empty in
> the child, and asserts that it did.

## Phase 3 — The customer-facing 3D experience (approved models only)

An approved model reaches the storefront product page. The rules that make this safe, and
that a future change must not quietly break:

- **Two different surfaces, one shared root.** `/api/3d/media/...` stays staff-only and
  workspace-scoped; the storefront reads a SEPARATE, much smaller public surface
  (`/api/3d/products/:slug/public`, `.../model/:assetId/glb`, `.../model/:assetId/thumbnail`)
  that takes no storage key and no path — only `(productSlug, assetId, kind)` — and
  re-resolves all three against the database on **every** request. The private media root
  is never made public.
- **The projection is fixed and narrow.** `services/product3dPublicResolution.js` returns
  only `id, version, provider, hasModel, bytes, thumbnail, delivery.glb, validation,
  settings`. No workspace, job, reference image, creator, approval trail, storage key or
  hash — the key set is asserted in the suite, so adding a field is a deliberate act.
- **The model is resolved from the PRODUCT's workspace, not the caller's.** An anonymous
  visitor has no workspace; taking the owner from the product is what stops a second
  workspace's approved row (naming the same slug) from ever being projected.
- **Every refusal is a 404 `ASSET_NOT_FOUND`**, never a 403 — a 403 would confirm that
  something exists. Candidate, rejected, deprecated, foreign-workspace, unknown,
  unpublished-product and suspended-shop all answer identically.
- **Delivery re-validates the BYTES, not the row.** The controller re-reads the file and
  re-runs `validateGlb` before serving, so a truncated/replaced/corrupted file is refused
  instead of handed to a browser as a model. Type is `model/gltf-binary`, `nosniff`, and
  `Cache-Control: public, max-age=600, must-revalidate` — **bounded, never `immutable`**,
  because publishing decisions change even though the bytes do not.
- **The metadata projection is cached for the same 30 s as every other public read**
  (`utils/publicCache.js` key `3d:model:<slug>`) and is invalidated explicitly on
  approve / reject / delete and on every product write (which covers rename, unpublish and
  re-attribution). A miss is never cached, so the FIRST approved model appears immediately.
- **The viewer is lazy and separate.** `frontend/src/components/Product3dViewer.jsx` is a
  `React.lazy` chunk that reuses the Phase 2 viewport (`components/admin/ThreeGlbPreview.jsx`,
  which dynamic-imports `three`) and adds only the public loader plus the `Back to photos`
  exit — which lives in the product page's view toggle, OUTSIDE the viewport's state
  machine, so it exists even when WebGL is unavailable or the model 404s. Photos stay the
  default; no approved model means no 3D control at all (never a disabled one).
- **The GLB downloads only on demand.** Opening a product page fetches a few hundred bytes
  of metadata; the browser suite asserts NO `/model/.../glb` request happens before the 3D
  tab is clicked.

| Concern | Module |
|---|---|
| Safe public projection (+ the delivery URL builder) | `backend/services/product3dPublicResolution.js` |
| Public delivery controller (product + workspace + approval + byte re-validation) | `backend/controllers/3dPublicDeliveryController.js` |
| Public storefront routes (mounted on `/api/3d`, after the staff router) | `backend/routes/3dPublicRoutes.js` |
| Workspace-keyed approved lookup | `backend/services/3dAssetService.js` → `findApprovedInWorkspace` |
| Optional `product3d` on the public detail read | `backend/controllers/productController.js` → `getProduct` |
| Public 3D client (metadata + GLB object URL, no credentials) | `frontend/src/services/product3dService.js` |
| Storefront viewer wrapper | `frontend/src/components/Product3dViewer.jsx` |
| Gallery toggle + back-to-photos | `frontend/src/pages/ProductPage.jsx` |

### Verification
`npm run test:3d` — now **188** assertions: §J adds the public contract against a
separate server process, including an intruder row that IS servable in its own workspace
and must never be shown under this product, a real replacement through the pipeline
(candidate invisible → approval invalidates the running server's cache → the new model
downloads → the replaced one 404s → the detail converges), and unpublish/republish through
the real `PATCH` write path. `frontend/e2e/specs/12-product-3d.spec.js` drives the real
browser: `data-state="ready"` proves three.js parsed and drew the bytes, three.js is
asserted ABSENT from the entry bundle, and the 404-model and no-WebGL fallbacks plus the
390×844 layout are covered.

> **The model the browser suite opens is a FIXTURE** — `e2e/stack.mjs` writes an APPROVED
> row plus a real glTF Binary container built byte-by-byte in `e2e/support/fixtures.js`.
> **No inference runs** in that mode (the backend suite's provider is a test double
> regardless). It proves the customer path against real bytes; it does not prove any
> provider produces a good mesh. **Phase 4 closes that gap explicitly**: setting
> `THREE_E2E_REAL_GLB=<path>` makes the same six tests run against bytes a real TripoSR
> worker generated, with the log line naming the mode. Both modes passed 6/6 on
> 2026-10-15.

## Phase 4 — real local generation (3D Studio)

The provider slot Phase 2 left honestly empty now has a worker in it: real TripoSR
inference on this machine's GPU, reached over loopback HTTP by
`services/3dLocalWorkerProvider.js`, driven by the SAME job/validate/store/approve/Public
delivery pipeline. Full detail (environment, licence, measured numbers, how to run) in
[IMAGE_STUDIO.md — Phase 4](./IMAGE_STUDIO.md#phase-4--real-local-generation).

Decisions worth keeping:

- **Opt-in did not become automatic.** The default is still `local_unavailable`; the
  worker is selected only by `3D_PROVIDER=local_worker`, a local failure is never
  followed by a paid Meshy retry, and `THREE_WORKER_URL` must be loopback/RFC1918 or the
  adapter refuses with `WORKER_NOT_LOCAL` (that check is the provider path's SSRF guard).
- **One image in, honestly labelled.** TripoSR is single-view, so the plan advertises
  `maxInputs: 1` and `submit` sends exactly the PRIMARY accepted reference — the contract
  suite asserts the transmitted bytes equal that reference's cutout, so "which photo made
  this" is testable rather than assumed.
- **Two suites, two honest claims.** `npm run test:3d-worker` (52) proves the adapter and
  every stage around it with a loopback stand-in and no GPU; `npm run test:3d-real` is
  the opt-in generation run that exits 2 when no live worker is present, so it cannot
  report success without inference. `test:all` runs the former and never the latter.
- **TRELLIS.2 was ruled out on facts, not taste** (upstream: Linux-tested, ≥24 GB VRAM);
  this host is Windows with a 6 GB laptop GPU, where TripoSR's own ~6 GB estimate fits
  (measured peak 2379 MB).

### Verification

`npm run test:3d-real` (live worker): photograph → Phase 1 cutout (rembg/u2net,
confidence 0.749) → accepted reference → job **READY_FOR_REVIEW in 79 s** → 9320 verts /
18592 faces, watertight, **485 328-byte GLB** → validated → private storage → candidate →
**APPROVED** by the shipped service → public projection `provider: "TripoSR"`. Browser:
**6/6 in real-model mode and 6/6 in fixture mode**, the public route serving the
485 328 generated bytes. `npm run test:3d-worker` 52/0; `npm run test:3d` 188/0.

Re-verified **2026-10-16** (independent second run; same pipeline, nothing rebuilt beneath
it): **80.6 s** job, 9320 verts / 18592 faces, **485 328-byte GLB**, APPROVED, projection
`provider: "TripoSR"`. The container was re-read directly instead of trusting the pipeline:
18 592 triangles, 0 materials / 0 textures, normalised extents. Quality measured against
the source photograph: object silhouette aspect 1.56 vs the Phase 1 cutout's 1.53.
Browser **6/6 real-model**; `test:references` 111/0 · `test:3d-worker` 52/0 · `test:3d`
188/0 · `test:security` 105/0 · `npm run build` clean.

## Phase 5 — the model quality gate (3D Studio)

Phase 2–4 can produce a GLB that is structurally perfect and still a poor reconstruction of the
product. Phase 5 makes "valid container" insufficient: **approval now requires a current quality
verdict, measured on the server.** Metric definitions, thresholds and the calibration sample are
in [IMAGE_STUDIO.md — Phase 5](./IMAGE_STUDIO.md#phase-5--the-model-quality-gate).

Decisions worth keeping:

- **The gate is a measurement, not a checkmark.** It projects the stored mesh onto documented
  orthographic views (glTF convention: +Y up, −Z forward — the only convention the stored asset
  actually records), rasterises the projection, normalises both silhouettes and compares them
  with aspect error, foreground coverage, centroid offset, IoU and a contour distance. Nothing
  scores the provider's success status, the filename or a client-supplied field: a `quality`
  in a request body is **ignored**, because no route reads one.
- **Three outcomes, and the middle one is where an uncalibrated metric belongs.** `PASS`
  (IoU ≥ 0.75, aspect error ≤ 25%, clean structure) approves exactly as before; `REVIEW`
  (IoU 0.35–0.75, or any uncertainty) requires an explicit acknowledgement with a note;
  `BLOCKED` (IoU < 0.35, or invalid / empty / degenerate geometry) refuses normal approval.
  Bands are configurable (`THREE_QUALITY_PASS_IOU`, `THREE_QUALITY_BLOCK_IOU`, …) and recorded
  verbatim in every report, so a decision traces back to the numbers behind it. Bands that
  would invert (`passIou <= blockIou`) are refused with `QUALITY_THRESHOLDS_INVALID` rather
  than silently making everything pass.
- **The report is bound to a fingerprint** — GLB sha256 + reference ids + generation settings +
  assessment version. Change the model or the accepted reference set and the old verdict stops
  counting: approval re-measures before it decides (`ensureQualityReport`), and the review
  acknowledgement and any override are **cleared rather than inherited**. That is what makes a
  stale report safe instead of merely old.
- **View ambiguity is stated, not hidden.** A best-matching view that beats the runner-up by
  less than 0.05 is reported as `SILHOUETTE_VIEW_AMBIGUOUS`, because an orientation assumption
  is not evidence. Phase 4's TripoSR output carries no camera, so this fired on the genuine
  model — correctly. AI-invented viewpoints are never treated as extra photographs.
- **A doubtful reference downgrades a refusal to a review.** A severe mismatch measured against
  a cutout whose own Phase 1 confidence is below 0.6 is reported as
  `SILHOUETTE_SEVERE_MISMATCH_DOUBTFUL_REFERENCE` (REVIEW, not BLOCKED): the photograph may be
  the cause as much as the model, and refusing a model for a bad reference would be wrong.
- **Vertex colour is not PBR.** A TripoSR model with no materials or textures is reported as a
  `MATERIAL_VERTEX_COLOUR` warning — it renders, and material fidelity is explicitly *not*
  claimed for it. `THREE_QUALITY_REQUIRE_MATERIALS=1` promotes that warning to policy. A
  vertex-colour model is not auto-rejected.
- **An override is audited, not just allowed.** An administrator only, a reason required, and
  the record stores what it overrode (`previousDecision: 'BLOCKED'`) with actor and timestamp.
  A failed or blocked replacement still never deletes or replaces the live approved model, and
  every unapproved candidate stays a 404 on the public surface.

### Verification

The gate was pointed at the **genuine Phase 4 model** (9320 vertices / 18 592 triangles /
485 328 bytes, colour per vertex, no materials) against the same product's Phase 1 cutout —
twice, because the cutout is the variable that matters:

| Reference | Cutout confidence | IoU | Aspect error | Best view | Decision |
|---|---|---|---|---|---|
| rembg (u2net) | 0.749 | 0.431 | 53% | top (margin 0.048) | **REVIEW** — `SILHOUETTE_WEAK_MATCH` + view ambiguity |
| deterministic engine | 0.544 (doubtful) | 0.111 | 104% | right (margin 0.019) | **REVIEW** — the doubtful reference kept it out of BLOCKED |

Both verdicts are honest and unflattering, which is the point. **One genuine sample cannot
validate a band**: the report's own `calibration` says `genuineSamples: 1, provisional: true`,
and the policy that follows is that a borderline result becomes a human decision rather than a
confident number. The earlier 1.56-vs-1.53 aspect agreement from Phase 4 is retained as an
*observation*, never as a threshold justification. Evidence (gitignored):
`audit/phase5-quality/*.quality.json` and the `reference | model | overlay` diagnostics beside
them.

`npm run test:3d-quality` **80/0** (20.9s) · `test:references` 111/0 · `test:3d` 188/0 ·
`test:3d-worker` 52/0 · `npm run build` clean.

## Phase 6 — quality-gate validation & hardening (3D Studio)

Closes the three gaps Phase 5 documented. Nothing in Phases 1–5 was rebuilt, and **no
threshold was changed**.

**1. The review panel now has permanent browser coverage.**
`frontend/e2e/specs/13-quality-review.spec.js` (**FLOW 31–36**, renumbered so it does not
collide with spec 12's 25–30), run by `npm run test:e2e` with the rest of the suite. The
stack provisions a CANDIDATE for **every state the panel renders** through the shipped
services, and **asserts each fixture's intended verdict at boot**, so a drifted fixture
fails at startup instead of quietly making a test vacuous. What is fixture (geometry,
cutouts) and what is real (reference row, candidate row, private bytes, job row, report,
every API call) is stated in the spec header; the gate's *rules* stay proven by
`test:3d-quality`.

**2. Writing that coverage found two shipped defects.**
- `referenceAssetStorage.js` resolves its media root **once, at import time**, and the
  stack set `REFERENCE_MEDIA_DIR` *after* tenant cleanup had already imported the module.
  Fixture cutouts were written into `backend/reference-media/` while the backend child
  read `frontend/e2e/.media-references/`. It looked healthy at fixture time — the first
  assessment runs in the stack process, against the very module the write used, and
  reported IoU 1.0. It surfaced only when the browser clicked Approve and the **backend**
  re-measured a stale candidate: *"The accepted cutout has no bytes"* →
  `QUALITY_REVIEW_REQUIRED`. `stack.mjs` now pins both roots in `pinMediaRoots()` before
  any media import, asserts `mediaRoot()` at boot and reads every fixture cutout back
  after writing it.
- A failed UI decision timed out with no explanation; FLOW 34/35 now record the
  approve/reject request, body and response.

**3. Three genuine models were evaluated** — local TripoSR on the RTX 4050, real
catalogue photographs, real Phase 1 cutouts, measured by `3d-quality-report.mjs` against
the exact cutout each model was generated from:

| Subject (photograph) | Mesh | IoU | Aspect | Best view (margin) | Verdict |
|---|---|---|---|---|---|
| vase + lavender (`flora-asset-10`, named “Hamper Box”) | 9 320 v / 18 592 tri | 0.4311 | 52.9% | top (0.048) | **REVIEW** |
| wrapped posy (`flora-asset-01`) | 55 127 v / 110 202 tri | 0.6795 | 43.5% | front (0.003) | **REVIEW** |
| card + wax seal (`flora-asset-08`, named “Chenille Charm”) | 35 684 v / 71 364 tri | 0.5203 | 59.8% | left (0.024) | **REVIEW** |

All three are recognisable in TripoSR's own renders, all three are vertex-coloured with no
texture maps, and **all three landed in REVIEW — none passed, none was blocked**. My own
check of photograph vs cutout vs render vs the gate's overlay agrees with each verdict.

**Thresholds stayed exactly as they were, and stay provisional.** Relaxing `passIou` /
`passAspectError` / `minViewMargin` until three models pass would be tuning to a sample.
What the samples actually show is a property of the metric: it compares an **axis-aligned
orthographic projection** with a **perspective photograph of a posed object**, so a genuine
single-view reconstruction is unlikely to reach `passAspectError 0.25` whatever its
quality. Operationally: **a genuine model normally lands in REVIEW and a human decides.**
`calibration.genuineSamples` still reads 1 on purpose — that field records how many genuine
models the *bands* were set from, and this was an evaluation, not a re-derivation.

**Reproducibility, verified.** The Phase 6 model from `flora-asset-10.jpg` is
**byte-identical** (`d79f9170…`) to all four Phase 4 artifacts of that photograph, and
re-measuring it reproduced Phase 5's stored report on every value (REVIEW, IoU 0.4311,
view top, margin 0.0483, aspect 0.5289, contour 6.85 px). A fourth generation then went
through the **human-review path**: the gate refused normal approval
(`QUALITY_REVIEW_REQUIRED`), a review note after looking at it published the model, and
`quality.decision` stayed `REVIEW` with `quality.review.acknowledgedBy` set. Approval did
not overwrite what was measured.

Evidence (gitignored): `audit/phase6-quality/` (reports, diagnostics, an `index.html`
side-by-side page) and `audit/audit/phase6-quality/evaluation-set.json` (the record,
rebuilt by `audit/phase6-quality/build-evaluation-set.mjs`); the GLBs, accepted cutouts
and run JSONs are in `audit/phase4-real-generation/`.

**Verification — the first complete 25-suite sweep.** `npm test` →
**TOTAL PASS 2198 / FAIL 0, all 25 suites**, serially, on this tree (including
`test:3d-quality` at **84/0**, four assertions added for a re-assessment regression).
`npm run test:e2e` → **91 passed** (11.6m), including the new FLOW 31–36.
`npm run build` → clean, with `three.module` and `Product3dViewer` still lazy chunks.
No two sweeps ran at once; no run touched dev or production data.

## Phase 1 — 3D Studio (Smart Product Image Studio)

Upload product photographs (plain backdrops, busy scenes, flyers) and prepare a clean
reference set per product: untouched **original**, transparent **cutout**, neutral
**preview**. No 3D generation exists or is stubbed — Phase 2 consumes the accepted set.
Full detail in [IMAGE_STUDIO.md](./IMAGE_STUDIO.md).

Decisions worth keeping:

- **Two engines behind one entry point** (`services/bgRemoval/index.js`). A
  deterministic `sharp` flood-fill segmenter is the default because it needs no Python,
  no weights and no download, and it is honest about its limits (low confidence →
  `NEEDS_REVIEW` + crop tool). `rembg` is opt-in for genuinely hard images. Which engine
  and which model ran is stored per image, and a fallback is a recorded WARNING.
- **The licence guard is code, not a comment.** rembg's own default model (`bria-rmbg`)
  has non-commercial weights, and `isnet-general-use` has no licence statement, so
  `resolveModel()` refuses both even when configured, and `reference-image-smoke.mjs`
  asserts the refusal. MIT (rembg code, BiRefNet weights) and Apache-2.0 (U-2-Net)
  are the cleared choices.
- **rembg is driven through its LIBRARY, never its CLI.** The `i` subcommand takes the
  output path positionally and dropped `--output`, and the package ships no `__main__`,
  so `python -m rembg` is not portable; an invocation written from memory failed
  against the real release. A suite assertion now guards the wiring.
- **Reference media is private.** Its own root (outside `public/`, outside the CDN),
  served only through an authenticated, workspace-checked route with
  `private, no-store`; no payload ever exposes a path. The original is written once — a
  second write is refused (`ORIGINAL_IMMUTABLE`), so "never overwrite the original" is
  enforced rather than intended.
- **A reference set exists before the product does.** Rows are keyed by `draftKey` until
  a create attaches them, which is why they are their own collection rather than a
  `Product` subdocument.
- **Concurrent `run-all.mjs` runs corrupt each other.** Every suite binds a fixed port
  (`bootTestServer` refuses a port already in use), so two full runs at once make suites
  die at boot and the orchestrator reports them as environmental/timeout. Kill the
  earlier run before starting another; a red full run with port-shaped failures is
  that, not a regression.

## Security Knowledge

- **Frontend demo credentials were previously shipped to production.** Both sign-in
  pages rendered developer helpers unconditionally, so the production bundles
  contained a one-click "fill demo credentials" control for the **admin** portal and
  printed the handler credentials as plain text, plus the customer demo password in
  the forgot-password copy. All were fixed by moving them behind
  `import.meta.env.DEV`, which lets Vite dead-code-eliminate the helpers **and the
  credential strings** from production builds. Verified absent from the live bundles.
  **Lesson: any dev-only helper, credential, or internal hint must be DEV-gated; the
  reminder is in `AGENTS.md` and `CONTRIBUTING.md`.**
- **A seeded demo handler account still exists in production and authenticates.** It
  is reachable through the live API and grants full admin access. It requires
  rotation or removal by the owner. (No credentials are recorded anywhere in this
  repository's documentation.)
- Rate limiting is **in-memory per process**: the login limiter counts only *failed*
  attempts, and the generic write limiter is strict in production / permissive in
  development. A multi-instance deployment would need a shared store.
- **Staff invitations are hash-only, single-use and owner-gated (Phase 20.6.1/20.6.2).**
  The raw invitation token (`crypto.randomBytes(32).toString('hex')`, 72-hour TTL) is
  returned exactly once by the approving step and stored only as a SHA-256 hash
  (`Invitation.tokenHash`), so a database dump cannot replay an invitation.
  `POST /api/invitations/:token/activate` consumes it with an **atomic**
  `INVITED → ACTIVE` transition (concurrent activations cannot both succeed), the
  **role always comes from the invitation** (a client-supplied `role`/`isOwner` is
  ignored), and an already-registered email is refused **without** burning the token.
  The Owner is **not a fourth role**: it is `User.isOwner = true` on an `admin`,
  enforced server-side by `requireOwner`. Frontend `session.isOwner` only drives
  navigation (the Owner Access Required screen). `npm run provision-admin` creates the
  first owner with `isOwner=true`; activation never grants ownership.
- **Handler invitations and the staff lifecycle are complete (Phase 20.6.3–20.6.5).**
  Admins issue handler invitations from `/api/admin/invitations` (role **fixed to
  `handler`** — asking for anything else is `422`, so the endpoint can never mint an
  administrator); the recipient lands on `/admin/activate/:token`, accepts, sets a
  password and signs in through the **one** existing login endpoint. The raw token is
  returned exactly once and stored only as a SHA-256 hash, so **resend mints a new
  link and invalidates the old one**, and no read endpoint can re-display a link
  (the UI says so instead of pretending otherwise). `/api/admin/staff` is the
  directory + lifecycle API: only the **owner** may act on an administrator
  (`403 OWNER_REQUIRED`), nobody may act on themselves, fixture accounts are
  read-only, and suspension bites on the very next request because `protect`
  re-reads the user. `StaffEvent` is the minimal append-only audit trail; accounts
  created before it show an **empty timeline rather than invented history**.
  Staff identity badges (`HND-`/`ADM-`/`OWN-`) are **derived from the ObjectId**, not
  a counter — no migration, no sequence collection. Invitation links are built from
  `STAFF_PORTAL_URL` (falls back to `CLIENT_URL`, then `localhost:3000`).
- **Administration can never be locked out.** Every remaining active administrator is
  necessarily the acting account itself, and self-actions are refused before any
  write, so the active-admin count can never reach zero. The `LAST_ADMIN` branch in
  the controllers is defense-in-depth and is unreachable over HTTP by construction.
- Payments are protected by server-computed amounts, server-created provider order
  ids, and timing-safe HMAC verification; webhooks are HMAC-verified against the raw
  body. Never trust a client "paid" claim.
- Security headers (Helmet CSP) and an explicit CORS allowlist are enabled; origins
  not on the list are rejected.

## Testing Knowledge

The full suite currently passes **2062/2062** (0 failures across 23 suites), verified on
the 3D Studio Phase 3 sweep (2026-10-15, serial `--only` subsets; see
[TESTING.md](./TESTING.md) for the two suites that first hit the cluster cap and were
re-run alone to a clean pass):

| Suite | Assertions |
|---|---|
| Environment Guard | 30 |
| Pricing | 22 |
| API | 125 |
| Integration | 81 |
| Payment (mock Razorpay) | 45 |
| Conversation | 34 |
| Provisioning (Phase 20.6.1) | 84 |
| Activation (Phase 20.6.2) | 44 |
| Invitation Link | 82 |
| Staff Lifecycle (Phase 20.6.3–20.6.5) | 146 |
| Portal Auth (Phase 21.1–21.2) | 58 |
| Personnel Lifecycle (Phase 21.4–21.7) | 110 |
| Application Flow (Phase 20.6.6) | 82 |
| Tenant Core (Phase 22.2) | 117 |
| Tenant Matrix (Phase 22.3) | 190 |
| Admin Onboarding (Phase 22.4–22.5) | 141 |
| Staff Permissions | 119 |
| Action Center (Phase 23) | 84 |
| Legacy Backfill (Phase 22.5) | 32 |
| Security | 105 |
| Production | 32 |
| Reference Studio (Phase 1 images) | 111 |
| **3D Studio** (generation + approval + public delivery) | **188** |
| **Total** | **2062** |

- Orchestrated by `backend/scripts/run-all.mjs` via `npm test`; non-zero exit on any failure.
- **Each suite boots its own backend process against its own dedicated
  `Flora-Alchemy-Test-*` database** (shared bootstrap: `scripts/lib/testServer.mjs`).
  This is why tests never touch the shared dev/prod database.
- `npm run test:razorpay-real` talks to the real Razorpay sandbox and **skips** when
  `rzp_test_*` credentials are absent.
- **Passing tests do not mean the shared dev/prod database problem is solved** — the
  isolation is in the test harness, not in the deployment.
- Frontend verification is `npm run build` (Vite is this repo's compile check) plus
  manual browser verification. There is no frontend test suite.

See [TESTING.md](./TESTING.md).

## Important Historical Fixes

Durable lessons (not a chronology) from the recent hardening work:

1. **A frontend payload whitelist can silently destroy data.** The product create
   form collected initial stock / reorder level, but the service's payload whitelist
   dropped them, so every product created through the admin UI started at stock 0
   with no error anywhere. The backend always accepted the fields. **Lesson: the
   automated suites call the API directly, so a frontend-only mapping bug is
   invisible to them — verify UI-driven writes end-to-end, not just via API tests.**
2. **Never declare a React hook after a conditional return.** A `useState` placed
   below a "not found" early return changed the hook count between renders and
   white-screened every fresh load of that admin page. Hook order must be stable
   across all render paths.
3. **Dev-only UI must be DEV-gated, not just labelled.** A control whose button text
   said "(DEV ONLY)" still shipped to production and exposed admin credentials
   (see Security Knowledge). Labelling is not gating.
4. **Empty media sources break more than layout.** Rendering `src=""` makes the
   browser re-request the whole document; render an explicit placeholder instead.
5. **Read boolean flags defensively when the field may be absent** (see Critical
   Constraints — the `!== false` pattern) to avoid silently disabling a control.
6. **Cart UI must be re-priced and re-validated from live data.** Bag lines carry a
   price snapshot, but the server re-prices at order time; reconciling in the UI and
   re-checking stock before submit is what keeps the displayed total and the charged
   total identical.
7. **Multi-step flows must survive navigation and refresh.** Checkout step, delivery
   form and shipping choice are snapshotted (sessionStorage) so an auth round-trip
   does not restart the purchase; the auth gate returns to the exact pre-login
   context via a validated internal `?redirect=`.
8. **A failed payment must leave a recoverable state**, not an empty bag and no path
   forward: the order persists as pending, stock is released (idempotently), and a
   retry reuses the same order rather than creating a duplicate.
9. **Regression hygiene: prefer targeted slice refreshes over full re-hydration**,
   so a single mutation never triggers a global loader or unmounts the page.
10. **An unimported icon white-screens a whole section — and no suite notices.**
    The 3D Studio's preview tile rendered `<ImageIcon>` without importing it; the
    first render after the first upload threw `ReferenceError: ImageIcon is not
    defined` and the error boundary replaced the entire studio with "Something
    went wrong on this page". Every backend assertion passed, because there is no
    frontend unit runner. **Lesson: a component that has never been rendered in a
    browser has not been tested, however green the API suite is.** Load the page,
    upload a real file, and read the console.
11. **Duplicated server messages become duplicate React keys.** The engine and the
    quality heuristics both emitted "This image may contain multiple products.",
    and the review list used `key={message}`, so React logged "Encountered two
    children with the same key" and could have dropped or duplicated a warning
    row. Fixed at the source (the service merges engine + quality messages through
    a `Set`) and defensively in the render path (`uniqueMessages`). **Lesson: when
    two layers can produce the same sentence, dedupe where they are combined — a
    UI list keyed by content will find the collision for you, in the console, at
    the worst possible time.**
