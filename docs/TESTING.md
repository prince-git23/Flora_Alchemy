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

Last verified full run (`npm test`, Phase 22.4) — **16 suites, 1296 assertions**:

| Suite | Assertions | Result |
|---|---|---|
| Pricing | 22 | ✅ 22 passed, 0 failed |
| API | 125 | ✅ 125 passed, 0 failed |
| Integration | 65 | ✅ 65 passed, 0 failed |
| Payment (mock Razorpay) | 45 | ✅ 45 passed, 0 failed |
| Conversation | 34 | ✅ 34 passed, 0 failed |
| Provisioning (Phase 20.6.1) | 74 | ✅ 74 passed, 0 failed |
| Activation (Phase 20.6.2) | 44 | ✅ 44 passed, 0 failed |
| Staff Lifecycle (Phase 20.6.3–20.6.5) | 146 | ✅ 146 passed, 0 failed |
| Portal Auth (Phase 21.1–21.2) | 58 | ✅ 58 passed, 0 failed |
| Personnel Lifecycle (Phase 21.4–21.7) | 110 | ✅ 110 passed, 0 failed |
| Application Flow (Phase 20.6.6) | 82 | ✅ 82 passed, 0 failed |
| Tenant Core (Phase 22.2) | 113 | ✅ 113 passed, 0 failed |
| Tenant Matrix (Phase 22.3) | 187 | ✅ 187 passed, 0 failed |
| **Admin Onboarding (Phase 22.4)** | **110** | ✅ 110 passed, 0 failed |
| Security | 56 | ✅ 56 passed, 0 failed |
| Production | 25 | ✅ 25 passed, 0 failed |
| **TOTAL** | **1296** | **✅ 1296 PASS / 0 FAIL** |

```
FULL RUN: ALL SUITES PASSED
```

> ⚠️ **A green suite does not mean the deployment is safe.** These suites are
> isolated from the shared production/development database. **Passing 1296/1296 says
> nothing about the shared production/dev database problem** documented in
> [MEMORY.md](./MEMORY.md) and [DATABASE.md](./DATABASE.md) — that is a deployment
> configuration defect, not a code defect, and no test asserts against it.

## Commands

From the repository root:

```bash
npm test          # cd backend && npm test → scripts/run-all.mjs (all 16 suites)
```

From `backend/`:

```bash
npm test                    # all suites (same orchestrator)
npm run test:pricing        # 22  — custom gift pricing authority
npm run test:api            # 125 — core API smoke
npm run test:integration    # 65  — admin users, notifications, collections, uploads, custom requests
npm run test:payment        # 45  — payment lifecycle against a local mock Razorpay
npm run test:conversation   # 34  — order-linked messaging
npm run test:provisioning   # 74  — first-owner bootstrap + staff access matrix (Phase 20.6.1)
npm run test:portal         # 58  — portal context + owner gate (Phase 21.1–21.2)
npm run test:lifecycle      # 110 — OWNER → ADMIN → HANDLER personnel lifecycle (Phase 21.4–21.7)
npm run test:applications   # 82  — public application intake → owner review → invitation (Phase 20.6.6, +22.4 business fields)
npm run test:tenant         # 113 — tenant foundation (Phase 22.2)
npm run test:tenant-matrix  # 187 — two-workspace cross-tenant isolation (Phase 22.3)
npm run test:onboarding     # 110 — client admin onboarding + workspace activation (Phase 22.4)
npm run test:security       # 56  — security controls
npm run test:razorpay-real  # real Razorpay sandbox; SKIPS (exit 0) without rzp_test_* keys

# No standalone script — runs inside `npm test` only:
node scripts/activation-smoke.mjs       # 44  — invitation activation (Phase 20.6.2, +22.4 workspace attach)
node scripts/staff-lifecycle-smoke.mjs  # 146 — staff invitation lifecycle (Phase 20.6.3–20.6.5)
```

Additional utility: `node scripts/backfill-inventory.mjs` (maintenance, not a test).

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
fails:

```
Pricing → API → Integration → Payment → Conversation → Provisioning →
Activation → Staff Lifecycle → Portal Auth → Personnel Lifecycle →
Application Flow → Tenant Core → Tenant Matrix → Admin Onboarding →
Security → Production
```

Ordering rationale (from the source): fast functional suites first, **Security last**
because it deliberately exhausts its own server's login rate limiter. Each suite has
a 5-minute timeout. The orchestrator parses each suite's summary line, prints a
`SUITE SUMMARY` table, and on failure shows that suite's output tail so assertions
are visible without a re-run.

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
2. `npm test` — expect **1296 pass / 0 fail**; or the specific suites your change
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
