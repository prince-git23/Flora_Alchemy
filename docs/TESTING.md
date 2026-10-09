# Flora Alchemy — Testing

> Documents the test system that actually exists in `backend/scripts/`.
> Related: [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](./CONTRIBUTING.md),
> [API.md](./API.md), [ARCHITECTURE.md](./ARCHITECTURE.md),
> [MEMORY.md](./MEMORY.md).

There is **no test framework** (no Jest/Vitest/Mocha). Each suite is a standalone
Node ES-module script that boots a real backend process, drives it over HTTP with
`fetch`, asserts, and reports a `passed / failed` summary line that the orchestrator
parses.

---

## Verified current result

Last verified full run (`npm test`, Phase 4) — **21 suites, 1729 assertions**.
The run was executed serially with per-suite elapsed time and exit status; the
counts below are what the suites themselves reported.

| Suite | Assertions | Result | Elapsed |
|---|---|---|---|
| Environment Guard (Phase 4) | 30 | ✅ 30 / 0 | 0.2s |
| Pricing | 22 | ✅ 22 / 0 | 17.7s |
| API | 125 | ✅ 125 / 0 | 38.7s |
| Integration | 81 | ✅ 81 / 0 | 42.3s |
| Payment (mock Razorpay) | 45 | ✅ 45 / 0 | 18.4s |
| Conversation | 34 | ✅ 34 / 0 | 13.9s |
| Provisioning (Phase 20.6.1) | 84 | ✅ 84 / 0 | 47.8s |
| Activation (Phase 20.6.2) | 44 | ✅ 44 / 0 | 25.7s |
| Invitation Link | 82 | ✅ 82 / 0 | 19.2s |
| Staff Lifecycle (Phase 20.6.3–20.6.5) | 146 | ✅ 146 / 0 | 53.8s |
| Portal Auth (Phase 21.1–21.2) | 58 | ✅ 58 / 0 | 36.9s |
| Personnel Lifecycle (Phase 21.4–21.7) | 110 | ✅ 110 / 0 | 36.9s |
| Application Flow (Phase 20.6.6) | 82 | ✅ 82 / 0 | 36.9s |
| Tenant Core (Phase 22.2) | 117 | ✅ 117 / 0 | 62.0s |
| Tenant Matrix (Phase 22.3) | 190 | ✅ 190 / 0 | 57.6s |
| Admin Onboarding (Phase 22.4–22.5) | 141 | ✅ 141 / 0 | 44.2s |
| Staff Permissions | 119 | ✅ 119 / 0 | 32.7s |
| Action Center | 84 | ✅ 84 / 0 | 39.9s |
| Legacy Backfill | 32 | ✅ 32 / 0 | 32.8s |
| Security | 78 | ✅ 78 / 0 | 26.1s |
| Production | 25 | ✅ 25 / 0 | 55.8s |
| **TOTAL** | **1729** | **✅ 1729 PASS / 0 FAIL** | ~12 min |

```
FULL RUN: ALL SUITES PASSED
```

**One suite failed on the first pass and passed on its own re-run.** `Portal Auth`
hit the shared cluster's **500-collection cap** — its provisioning step could not
create a collection at all, so the failure was about the cluster being full, not
about the code. 285 collections belonging to finished suite databases were
reclaimed with `node scripts/db-footprint.mjs --drop-leftovers` (see "Cluster
footprint" below), after which the same suite passed 58/58. The orchestrator
reports that class distinctly so a cap failure is never read as an assertion
regression:

```
⚠ Portal Auth — ENVIRONMENTAL/TIMEOUT …
  Re-run it on its own and explain it before treating this run as a result
```

> ⚠️ **A cluster at the collection cap makes suites fail as though they were
> broken.** Run `node scripts/db-footprint.mjs` before a full sweep; it names every
> database that is reclaimable and never touches `Flora-Alchemy`,
> `flora_alchemy_dev`, or a database belonging to another project on the cluster.

> ⚠️ **A green suite does not mean the deployment is safe.** These suites run
> isolated from the real databases (each boots its own server against its own
> `Flora-Alchemy-Test-*` database). Development (`flora_alchemy_dev`) and
> production (`Flora-Alchemy`) are now distinct databases on the shared cluster
> (see [MEMORY.md](./MEMORY.md) and [DATABASE.md](./DATABASE.md)).
>
> There is **no frontend automated test runner** in this repo: the frontend is
> verified by `npm run build` plus the responsive harness (layout-only, synthetic
> input does not reach React handlers) and manual browser checks. Cart/checkout/
> cache tenancy is therefore covered by code review and the API-driven suites
> (Admin Onboarding §F2 / §F3) — never claim an automated frontend test passed.

## Commands

From the repository root:

```bash
npm test          # cd backend && npm test → scripts/run-all.mjs (all 17 suites)
npm run test:e2e  # frontend/admin: E2E build + Playwright (see "Browser E2E suite")
```

From `backend/`:

```bash
npm test                    # all suites (same orchestrator)
npm run test:guard          # 30  — database-identity guard (no server, no DB, no writes)
npm run test:pricing        # 22  — custom gift pricing authority
npm run test:api            # 125 — core API smoke
npm run test:integration    # 81  — admin users, notifications, collections, uploads, custom requests
npm run test:payment        # 45  — payment lifecycle against a local mock Razorpay
npm run test:conversation   # 34  — order-linked messaging
npm run test:provisioning   # 84  — first-owner bootstrap + staff access matrix (Phase 20.6.1)
npm run test:portal         # 58  — portal context + owner gate (Phase 21.1–21.2)
npm run test:lifecycle      # 110 — OWNER → ADMIN → HANDLER personnel lifecycle (Phase 21.4–21.7)
npm run test:applications   # 82  — public application intake → owner review → invitation (Phase 20.6.6, +22.4 business fields)
npm run test:tenant         # 117 — tenant foundation (Phase 22.2)
npm run test:tenant-matrix  # 190 — two-workspace cross-tenant isolation (Phase 22.3)
npm run test:onboarding     # 141 — client admin onboarding + workspace activation (Phase 22.4)
npm run test:security       # 78  — security controls
npm run test:razorpay-real  # real Razorpay sandbox; SKIPS (exit 0) without rzp_test_* keys

# No standalone script — runs inside `npm test` only:
node scripts/activation-smoke.mjs          # 44  — invitation activation (Phase 20.6.2, +22.4 workspace attach)
node scripts/staff-lifecycle-smoke.mjs     # 146 — staff invitation lifecycle (Phase 20.6.3–20.6.5)
node scripts/invitation-link-smoke.mjs     # 82  — invitation link handling
node scripts/staff-permissions-smoke.mjs   # 119 — granular staff permissions
node scripts/staff-action-center-smoke.mjs # 84  — staff action center
node scripts/legacy-backfill-smoke.mjs     # 32  — legacy ownership backfill
```

Maintenance utilities (never tests): `node scripts/backfill-inventory.mjs`, and
`node scripts/db-footprint.mjs` — the read-only cluster footprint report.

## Cluster footprint (`scripts/db-footprint.mjs`)

The shared MongoDB cluster enforces a **500-collection cap**, and every suite
leaves its own database behind (~19 collections each). When the cap is reached,
suites fail with `cannot create a new collection -- already using 500 collections
of 500`, which looks like a product regression and is not one.

```bash
node scripts/db-footprint.mjs                    # READ-ONLY report
node scripts/db-footprint.mjs --drop-leftovers   # reclaim finished-suite databases
```

The report lists every database with its collection count and marks the ones this
script will never touch (`Flora-Alchemy`, `flora_alchemy_dev`, anything in
`PRODUCTION_DB_NAMES`, and any database on the shared cluster that belongs to
another project). `--drop-leftovers` skips the E2E database by default because its
fixtures are expensive to recreate; pass `--keep=` to keep others.

## Isolation model — how suites avoid polluting data

This is the most important property of the suite, and it is what makes
`npm test` safe to run even while production shares the development database.

Every suite calls `bootTestServer()` from **`backend/scripts/lib/testServer.mjs`**,
which:

1. Loads `backend/.env` (`dotenv`, without overriding already-set variables) **before**
   computing URIs.
2. **Derives a dedicated test database** from the configured `MONGO_URI` by replacing
   the database pathname — `testMongoUri(baseUri, dbName)` → `Flora-Alchemy-Test-*`.
   If no base URI exists it **fails loudly** rather than silently falling back to the
   development database (a Phase 16 fix — suites previously wrote to dev data).
3. **Spawns its own `server.js` child process** on its own port with
   `NODE_ENV=development`, its own rate-limit store, and (where relevant) injected
   provider credentials.
4. Waits for `/api/health`, seeds what it needs, and kills the child afterwards.

Consequences:

- No dev server needs to be running; no dependency on ambient state.
- Suites cannot pollute each other — the Security suite may exhaust its own login
  limiter without affecting anything else.
- **The development/production database is never touched by `npm test`.**
- Ports and databases are fixed per suite so failures are reproducible.

| Suite | Backend port | Test database |
|---|---|---|
| Pricing | 4092 | `Flora-Alchemy-Test-Pricing` |
| Security | 4093 | `Flora-Alchemy-Test-Security` |
| Integration | 4094 (+ 4095 `UploadIK`, 4097 `UploadLocal`) | `Flora-Alchemy-Test-Integration`, `Flora-Alchemy-Test-UploadIK`, `Flora-Alchemy-Test-UploadLocal` |
| API | 4095 | `Flora-Alchemy-Test-Api` |
| Provisioning | 4091 | `Flora-Alchemy-Test-Provisioning` |
| Activation | 4090 | `Flora-Alchemy-Test-Activation` |
| Payment | 4097 (+ mock Razorpay 4098) | `Flora-Alchemy-Test-Payment` |
| Conversation | 4099 | `Flora-Alchemy-Test-Conversation` |
| Application Flow | 4100 | `Flora-Alchemy-Test-ApplicationFlow` |
| Staff Lifecycle / Portal Auth | 4101 (sequential) | `Flora-Alchemy-Test-Staff`, `Flora-Alchemy-Test-Portal` |
| Personnel Lifecycle | 4102 | `Flora-Alchemy-Test-Personnel` |
| Tenant Core | 4103 | `Flora-Alchemy-Test-TenantCore` |
| Tenant Matrix | 4104 | `Flora-Alchemy-Test-TenantMatrix` |
| **Admin Onboarding (22.4)** | **4105** | **`Flora-Alchemy-Test-AdminOnboarding`** |
| Production | free port from 4100 / 4110 | `prod-smoke-<port>` |
| Razorpay (real) | 4098 | `Flora-Alchemy-Test-Razorpay` |

*(Port 4096 is deliberately skipped — it is claimed by a local proxy controller on
some development machines.)*

## Orchestrator — `scripts/run-all.mjs`

Runs the suites in a **fixed, deterministic order** and exits non-zero if any suite
did not pass:

```
Environment Guard → Pricing → API → Integration → Payment → Conversation →
Provisioning → Activation → Invitation Link → Staff Lifecycle → Portal Auth →
Personnel Lifecycle → Application Flow → Tenant Core → Tenant Matrix →
Admin Onboarding → Staff Permissions → Action Center → Legacy Backfill →
Security → Production
```

Ordering rationale (from the source): fast functional suites first, **Security last**
because it deliberately exhausts its own server's login rate limiter.

### Suite states (Phase 4)

Every suite is reported as exactly one of four states, and the difference matters —
a run that lost suites to the per-suite cap used to be indistinguishable from one
that failed assertions:

| State | Meaning |
|---|---|
| `PASS` | Exited 0 |
| `FAIL` | Exited non-zero **with** its own summary line (a real assertion failure) |
| `ENVIRONMENTAL/TIMEOUT` | Killed by the per-suite cap, or died before printing a summary (boot failure, port clash, crash) |
| `NOT RUN` | Only in `--only` mode, for the suites you excluded |

Elapsed time is printed per suite. A timeout is **never** folded into `FAIL`, and it
is never silently absorbed: the orchestrator prints the exact re-run command for that
suite. Do not raise the cap to make a run look green — re-run the suite alone and
explain it first.

```bash
node scripts/run-all.mjs                       # every suite (5-minute cap)
node scripts/run-all.mjs --timeout=600         # longer cap only when justified
node scripts/run-all.mjs --only="API,Payment"  # serial re-run of a subset
```

## Browser E2E suite (Phase 4) — `frontend/e2e`

Playwright drives the **real** stack: an isolated backend (the same
`bootTestServer` helper every smoke suite uses) plus `vite preview` serving the
production bundle from `frontend/dist`.

```bash
cd frontend
npm run build:e2e    # build ONLY, against the loopback API (no suite)
npm run test:e2e     # build + run every spec
npx playwright test e2e/specs/03-tools.spec.js   # one spec (bundle already built)
```

- **Database:** `Flora-Alchemy-Test-E2E`, derived from `MONGO_URI` by
  `testMongoUri`, which fails closed unless the derived name carries a disposable
  marker **and** differs from the configured database. The stack additionally refuses
  to run at all if either check fails (see "Database safety" below).
- **Backend port:** 4000, **frontend:** 4300. Both children are killed by
  `e2e/stack.mjs` on exit.
- **Providers are blanked:** no Razorpay credentials, so no charge can be made (the
  checkout journey exercises the honest `PAYMENT_NOT_CONFIGURED` path); no ImageKit
  credentials, so uploads land on the local fallback and are verifiable on disk.
- **One worker, no retries.** The suite shares one backend and checkout really
  decrements stock, so parallel workers would race inventory; and a launch gate must
  not hide a flake behind a retry.
- **Browser:** the locally installed Google Chrome (`channel: 'chrome'`).

Specs: `01-discovery`, `02-product`, `03-tools` (gift finder, custom requests),
`04-account`, `05-cart-checkout`, `06-security`, `07-routes-a11y` (cold-load route
matrix, headings, focus rings, reduced motion, dark mode), `08-reviews-admin`,
`09-resilience` (slow / failed / empty catalogue, deterministic via route
interception).

### Bounded hydration — what the resilience spec proves

`fetch` has no default timeout, so a **stalled** catalogue request used to pin a
route to its skeleton forever: no error, no retry, no way forward. That was a
measured production symptom (the public catalogue spiked to 11–30 s under modest
concurrency), not a hypothetical, so the critical slices are now bounded in
`DataContext.jsx` (`HYDRATION_SLICE_TIMEOUT_MS`, 25 s) and `09-resilience.spec.js`
reproduces the conditions deterministically with route interception:

| Condition | Required behaviour | Test |
|---|---|---|
| Request fails | honest error naming the failure + working **Retry**; no articles invented | `§4 — a FAILED catalogue request…` |
| Request never answers | the app gives up by itself and offers the same recoverable state (a held response, so only the bound can end it) | `§4 — …NEVER ANSWERS is bounded, not eternal` |
| Response is genuinely empty | reads as empty — **not** as an outage and **not** as a fabricated catalogue, and offers no Retry | `§4 — a genuinely EMPTY catalogue…` |
| A late response from an abandoned request lands after a successful retry | it is **dropped**: `dataStore` keeps a per-slice write epoch and only the last-**started** request may commit, so a 35 s-old payload cannot replace the rows the retry confirmed | `§4 — a LATE response…cannot overwrite fresh data` |

`clearSessionData()` invalidates every in-flight slice write too, so a slow
`/orders` response belonging to the account that just signed out cannot repopulate
the store for a signed-out visitor.

### Database safety (E2E and every suite)

The database identity is the safety boundary, and it is checked in three places:

1. `testMongoUri` refuses a name without a `test`/`qa`/`dev`/`smoke`/`sandbox`
   marker, refuses a missing name, and refuses a derivation that resolves back to the
   configured database.
2. `e2e/stack.mjs` asserts the same two properties **before** it spawns anything, so
   the refusal comes first and is loud.
3. `environmentGuard.assertSafeDatabase` refuses a database listed in
   `PRODUCTION_DB_NAMES` regardless of `NODE_ENV`, and a generic
   `CONFIRM_DATABASE_UNSAFE_OPERATION` (`true`/`1`/`yes`) never authorises anything —
   only the exact database name does, for a deliberate one-off.

`npm run test:guard` (30 assertions, no server and no writes) proves those refusals,
including the production-target case. The E2E build has a fourth gate: the built
bundle's API origin must be loopback, verified against the emitted artifact, so
`npm run build && npx playwright test` can never point the suite at the deployed API.

### Known limitations of the E2E suite

- It talks to the **real Atlas cluster** (the disposable test database), so a
  machine with slow egress makes the whole suite slow. Assertions wait for content
  rather than asserting on the first frame — a route that is merely hydrating is not
  reported as broken.
- Public catalogue reads are cached server-side with a short TTL; the review
  journeys poll the public list instead of assuming instant invalidation.
- Uploads are verified against the **local fallback** storage path. Live ImageKit
  upload is an external check, not part of this suite.
- No automated *frontend unit* test runner exists: storefront logic is covered by
  this browser suite plus `npm run build` and the layout-only responsive harness.

## What each suite verifies

### Pricing — 22 assertions (`custom-gift-pricing-test.mjs`)
Custom Gift Studio **price authority**: a valid configuration is priced from server
constants (base + flower uplifts), a tampered client price is ignored, invalid
base/flower/missing-config inputs are rejected with `422`, and the packaging add-on
resolves from its `addOnId`.

### API — 125 assertions (`api-smoke.mjs`)
The core contract: register, login, `me`, product CRUD **including price integrity**,
order creation with ownership and lifecycle rules, inventory deduction and
adjustment, analytics derivation, settings persistence, and authorization negatives.

### Integration — 65 assertions (`integration-smoke.mjs`)
Cross-feature wiring: admin operator management, notifications, collection CRUD,
upload authorization **plus a real multipart upload** (both the ImageKit path and the
local-storage path, on separate servers), product edit/delete consistency
(including inventory record cleanup), and custom requests.

### Payment — 45 assertions (`payment-smoke.mjs`)
The payment matrix against a **local mock Razorpay server** and the real controllers:
verified payment → paid; failure → failed (never paid); cancelled/retry → same order
and same provider order with no duplicate; invalid signature → rejected; amount
tampering → server amount (from `order.total`) wins; customer A vs B → denied with
no leak; repeated verification → idempotent; repeated webhook → idempotent; a paid
order → **exactly one** inventory movement; a failed payment → no unintended deduction.

### Conversation — 34 assertions (`conversation-smoke.mjs`)
Full messaging lifecycle: customer creates the conversation → staff sees and replies
→ customer sees the reply → cross-customer access denied → unauthenticated access
denied → mark-read changes unread state → status open/close → duplicate-conversation
prevention → empty-body rejection → unread count.

### Provisioning — 74 assertions (`provisioning-smoke.mjs`)
Phase 20.6.1 — first-owner bootstrap (`provision-admin` guarded script) and the
staff access matrix (admin/handler/customer/anonymous across staff endpoints).

### Activation — 44 assertions (`activation-smoke.mjs`)
Phase 20.6.2/22.4 — invitation activation semantics: single-use token, TTL,
revoke/resend, no role escalation, `EMAIL_TAKEN` rollback, and (22.4) an
administrator activation **attaching its newly provisioned workspace** while a
handler activation only inherits one.

### Staff Lifecycle — 146 assertions (`staff-lifecycle-smoke.mjs`)
Phase 20.6.3–20.6.5 — invitation minting/resend/revoke, staff dossier actions,
StaffEvent audit trail, last-admin guards.

### Portal Auth — 58 assertions (`portal-auth-smoke.mjs`)
Phase 21.1–21.2 — portal context (`owner`/`admin`/`staff`), server-derived
`redirectTo`, owner gate, portal-forbidden matrix.

### Personnel Lifecycle — 110 assertions (`personnel-lifecycle-smoke.mjs`)
Phase 21.4–21.7 — OWNER → ADMIN → HANDLER hierarchy: creation, suspension,
reactivation, permission matrix, self-action and last-admin guards.

### Tenant Core — 113 assertions (`tenant-core-smoke.mjs`)
Phase 22.2 — Workspace entity, sparse membership, tenancy helpers, the four
gates, body/query scrub, compat mode, migration script + audit tool. (§32 was
**reversed by Phase 22.4**: admin activation now provisions its own workspace —
`workspaceId` set, ≠ the invitation's, `primaryAdminId` bound — while the
invitation's `workspaceId` stays untouched.)

### Tenant Matrix — 187 assertions (`tenant-matrix-smoke.mjs`)
Phase 22.3 — two real workspaces A/B: gate behaviour, disjoint operational
lists, cross-tenant read/write → 404, customer relationship visibility,
per-workspace settings/analytics, race proofs, suspension mid-request.

### Admin Onboarding — 110 assertions (`admin-onboarding-smoke.mjs`)
Phase 22.4 — client admin onboarding + workspace activation, E2E against an
isolated DB: business name/slug on submission (`SLUG_TAKEN`), owner approval
stamping `workspaceName`/`workspaceSlug`, **two independent workspaces** each
provisioned atomically (Workspace + admin User + Settings) from their own
approved application, slug precedence chain, transaction rollback on conflict
(no partial workspace/account/settings), invitation single-use, handler
activation never provisions, public `GET /api/shops/:slug` 200/404, owner
administrators directory enrichment + application linkage.

### Application Flow — 82 assertions (`application-flow-smoke.mjs`)

Phase 20.6.6 — the owner ←→ public admin application lifecycle, against an
EMPTY isolated database:

- **§23 public intake**: an anonymous submit creates ONLY an `AdminApplication`
  (no User, no Invitation, no JWT); client-supplied `role`/`isOwner`/`status`/
  `userId`/`password` are never honoured; 422 field validation; open duplicate
  → 409 `DUPLICATE_APPLICATION` while a rejected email may re-apply; owners
  notified; StaffEvent recorded; every owner endpoint refuses anonymous callers.
- **§24 owner authz matrix**: customer / handler / plain-admin sessions get
  403 `FORBIDDEN` on list, dossier, approve and reject with zero side effects.
- **§25 lifecycle**: approve mints exactly ONE invitation (role fixed to
  `admin`, only the SHA-256 hash stored — the raw token exists once in the
  approve response), one-way review decisions (409s in both directions),
  lazy `APPROVED → INVITED` on landing lookup, activation → `ACTIVATED` +
  sign-in (the new admin still cannot review), `EMAIL_TAKEN` rolls the claim
  back, dead invitations lazily reconcile to `EXPIRED`.
- **§26 approve race**: two concurrent approvals → exactly one 200 + one 409
  and exactly ONE invitation.

Isolation: own server (port 4100) and `Flora-Alchemy-Test-ApplicationFlow`.

### Security — 56 assertions (`security-smoke.mjs`)
Every assertion proves a control is enforced **server-side**: authentication and
role enforcement, ownership/404 (no existence disclosure), suspension taking effect
immediately, brute-force login limiting, rejections for tampered pricing, payment
signature enforcement, CORS behaviour, and rate-limit responses.

### Production — 25 assertions (`production-smoke.mjs`)
Deployment hardening, verifying the production **boot contract** rather than
business logic:

1. `/api/health` returns 200 with service info
2. `/api/readiness` returns 200 when MongoDB is connected
3. `SEED_ON_START=true` **exits non-zero** in production
4. Missing `MONGO_URI` exits non-zero
5. Missing `JWT_SECRET` exits non-zero
6. Missing `CORS_ORIGIN` exits non-zero
7. Graceful shutdown on `SIGTERM`
8. Graceful shutdown on `SIGINT`
9. Shutdown idempotency (a second signal does not crash)
10. Production startup with valid config (health + readiness)

It boots servers on dynamically discovered free ports with throwaway
`prod-smoke-<port>` databases.

### Razorpay (real) — `razorpay-real-smoke.mjs`
Talks to the **actual** Razorpay sandbox (never a mock). Requires genuine
`rzp_test_*` credentials via environment or `backend/.env`; **skips with exit 0 when
absent** and **refuses (exit 1) on live keys**. It deliberately strips ImageKit
credentials (for deterministic uploads) while keeping Razorpay credentials real.
Verified end-to-end: Flora order → real Razorpay order with the
server-authoritative paise amount, and retry reusing the same provider order id.

## Build & frontend verification

There is **no frontend test suite and no typechecker**. The compile check is the
production build:

```bash
npm run build          # from the repo root → cd frontend && vite build
```

Last verified build (Phase 22.4): **`✓ built` in 10.82 s** — entry chunk
**334.22 kB / 101.44 kB gzip**, shared chunk 70.46 kB / 27.81 kB gzip, CSS
140.70 kB / 21.22 kB gzip. Every portal page is route-split, so a storefront
visitor never downloads staff UI: `PortalGatewayPage` 8.80 kB / 2.45 kB gzip and
`OwnerAdministratorsPage` 27.87 kB / 6.39 kB gzip are separate chunks. The build
also acts as the syntax/module-resolution gate: an unresolved import or JSX
error fails it.

Frontend behaviour is verified **manually in the browser** (storefront and `/admin`),
inspecting console output, network requests, loading behaviour and data correctness.
Because screenshots cannot be captured in the cloud dev environment, visual checks
are done programmatically (computed styles / surface audits) rather than by image
diffing — there is **no visual regression automation**.

## Responsive audit harness

The one piece of automated frontend verification is a headless responsive
audit — it drives real Chrome over CDP and measures layout, so it catches the
regressions a build cannot:

```bash
node frontend/scripts/responsive-audit/run.mjs          # builds, then runs
node frontend/scripts/responsive-audit/run.mjs --no-build --only=owner-dir
```

- **Matrix:** every route in `run.mjs`'s `BASE_ROUTES` / `STATE_ROUTES` /
  `MENU_ROUTES` × up to 13 viewports (320, 360, 375, 390, 393, 412, 430,
  640 @200% zoom, 768, 820, 1024, 1280, 1440), plus a dark-mode pass on the base
  routes at 320/390/768/1440. Viewports are applied with
  `Emulation.setDeviceMetricsOverride` (Chrome clamps `--window-size`).
- **Fixtures, not production.** `scripts/responsive-audit/serve.mjs` serves
  `frontend/dist` with `audit.js` injected as the first child of `<head>`; the
  probe seeds a session, intercepts `window.fetch` and answers every API call
  from local fixtures. Production is never touched and no backend is needed.
- **What it fails on:** horizontal overflow, any JS error, a harness failure,
  and hard (sub-24px) touch targets on phone viewports. Elements between 24 and
  44 px are reported as `touch-small` **advisories** (usually table controls
  inside a deliberate horizontal scroll container), and scrollbar-induced
  viewport deltas as warnings.
- **Result (Phase 22.4):** `runs: 856  fails: 0  advisories: 2482  warns: 722` —
  **0 overflow and 0 JS errors at every viewport**, including the three portal
  logins, `/access`, the owner directory (with its dossiers and suspension
  modal), the owner and staff portal homes, the access-denied states, the
  public workspace route `/shops/:workspaceSlug`, and both admin-activation
  steps. Hard-touch failures on the storefront footer (first matrix route to
  render it) were fixed by widening its link targets to `py-1`.
  Snapshot committed under `scripts/responsive-audit/results/`.
- **The probe fails loudly.** A `window.onerror` trap writes
  `data-audit-error`, which the runner reports as `publish failed: <message>`
  instead of a silent 30-second timeout. Before it existed, one undefined
  fixture constant failed every route in the matrix with
  `timeout waiting for data-audit`.
- **Limitation — it does not exercise interaction.** Synthetic input does not
  reliably reach the app in this environment (even the theme toggle stays
  inert), so the audit proves *layout* and *that the page booted without a JS
  error*, not that a button's handler ran. Behaviour is verified in a real
  browser (see below).

## Required validation after a change

1. `npm run build` (frontend compile check) — for any frontend change.
2. `npm test` — expect **1316 pass / 0 fail**; or the specific suites your change
   touches while iterating, then the full run before committing.
3. Manual browser verification of the affected flow (storefront and/or `/admin`),
   including console and network inspection.

**Never weaken an assertion to make a suite pass.** If a suite fails, find out
whether the code or the expectation is wrong — these suites encode real security and
business invariants (server-authoritative pricing, ownership/404, idempotency,
exactly-one-deduction). Deleting or loosening such an assertion hides a real defect.

## Adding a test

- Prefer extending the closest existing suite; only add a new suite file if the
  domain is genuinely new.
- Follow the `bootTestServer({ port, db, env })` pattern and pick an **unused port
  and a dedicated `Flora-Alchemy-Test-*` database** — never the dev database.
- Always `stopTestServer(child)` in a `finally` block.
- Print a summary line matching the orchestrator's regex
  (`<NAME> RESULT: (\d+) passed, (\d+) failed`) and register the suite in the
  `SUITES` array of `scripts/run-all.mjs` so it runs in `npm test`.
