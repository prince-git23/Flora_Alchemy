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

Last verified full run — **3 consecutive runs, identical results**:

| Suite | Assertions | Result |
|---|---|---|
| Pricing | 22 | ✅ 22 passed, 0 failed |
| API | 120 | ✅ 120 passed, 0 failed |
| Integration | 65 | ✅ 65 passed, 0 failed |
| Payment (mock Razorpay) | 45 | ✅ 45 passed, 0 failed |
| Conversation | 34 | ✅ 34 passed, 0 failed |
| Provisioning (Phase 20.6.1) | 53 | ✅ 53 passed, 0 failed |
| Activation (Phase 20.6.2) | 43 | ✅ 43 passed, 0 failed |
| Staff Lifecycle (Phase 20.6.3–20.6.5) | 146 | ✅ 146 passed, 0 failed |
| Security | 56 | ✅ 56 passed, 0 failed |
| Production | 25 | ✅ 25 passed, 0 failed |
| **TOTAL** | **609** | **✅ 609 PASS / 0 FAIL** |

```
FULL RUN: ALL SUITES PASSED
```

> ⚠️ **A green suite does not mean the deployment is safe.** These suites are
> isolated from the shared production/development database. **Passing 609/609 says
> nothing about the shared production/dev database problem** documented in
> [MEMORY.md](./MEMORY.md) and [DATABASE.md](./DATABASE.md) — that is a deployment
> configuration defect, not a code defect, and no test asserts against it.

## Commands

From the repository root:

```bash
npm test          # cd backend && npm test → scripts/run-all.mjs (all 10 suites)
```

From `backend/`:

```bash
npm test                    # all suites (same orchestrator)
npm run test:pricing        # 22  — custom gift pricing authority
npm run test:api            # 120 — core API smoke
npm run test:integration    # 65  — admin users, notifications, collections, uploads, custom requests
npm run test:payment        # 45  — payment lifecycle against a local mock Razorpay
npm run test:conversation   # 34  — order-linked messaging
npm run test:provisioning   # 52  — first-owner bootstrap + staff access matrix (Phase 20.6.1)
npm run test:security       # 56  — security controls
npm run test:razorpay-real  # real Razorpay sandbox; SKIPS (exit 0) without rzp_test_* keys
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
| Payment | 4097 (+ mock Razorpay 4098) | `Flora-Alchemy-Test-Payment` |
| Conversation | 4099 | `Flora-Alchemy-Test-Conversation` |
| Production | free port from 4100 / 4110 | `prod-smoke-<port>` |
| Razorpay (real) | 4098 | `Flora-Alchemy-Test-Razorpay` |

*(Port 4096 is deliberately skipped — it is claimed by a local proxy controller on
some development machines.)*

## Orchestrator — `scripts/run-all.mjs`

Runs the suites in a **fixed, deterministic order** and exits non-zero if any suite
fails:

`Pricing → API → Integration → Payment → Conversation → Security → Production`

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

### API — 120 assertions (`api-smoke.mjs`)
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

Last verified build: **`✓ built` — 396.62 kB / 127.47 kB gzip** for the entry chunk
(route chunks are separate thanks to `lazy()` code splitting). The build also acts as
the syntax/module-resolution gate: an unresolved import or JSX error fails it.

Frontend behaviour is verified **manually in the browser** (storefront and `/admin`),
inspecting console output, network requests, loading behaviour and data correctness.
Because screenshots cannot be captured in the cloud dev environment, visual checks
are done programmatically (computed styles / surface audits) rather than by image
diffing — there is **no visual regression automation**.

## Required validation after a change

1. `npm run build` (frontend compile check) — for any frontend change.
2. `npm test` — expect **609 pass / 0 fail**; or the specific suites your change
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
