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

**Development and production currently share the same MongoDB database.**

This is verified, not assumed: the deployed Render service and a local checkout
resolve to the same `MONGO_URI`, and a local data change appeared in the live
production API within seconds (matching document `_id`s, timestamps, row counts and
inventory values).

Consequences — all of them real:

- **Local QA/seed/cleanup writes affect production data.** Seeding, fixture resets,
  test-product creation and cleanup scripts mutate what customers see.
- **Deleting/restoring data locally is a production operation.** Treat every local
  data mutation as a production change.
- **Dev/prod behavioural drift is hidden.** The two environments cannot be compared
  because they are the same data.
- Conversely, production traffic and real orders are visible in local views.

Rules that follow:

- **Never run destructive QA/cleanup scripts** without first confirming the database
  target (compare the database name in `backend/.env` `MONGO_URI` with the hosting
  dashboard value).
- **Never assume local and production are isolated.** They are not.
- Prefer additive, reversible operations; back up documents before deletes.
- Fix = give the production service its **own** database (and re-seed it) — an
  owner-side configuration change. Do not attempt to "fix" it in application code.
- **`SEED_ON_START=false` in production** is enforced (the server exits otherwise) —
  this protects against fixture seeding, but not against manual local runs.

Note: the automated test suites are **not** affected — each boots its own server
against its own dedicated `Flora-Alchemy-Test-*` database.

Also recorded in [DEPLOYMENT.md](../DEPLOYMENT.md) ("Data Isolation") and
[DATABASE.md](./DATABASE.md#release-blocker-shared-productiondevelopment-database).

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
- Payments are protected by server-computed amounts, server-created provider order
  ids, and timing-safe HMAC verification; webhooks are HMAC-verified against the raw
  body. Never trust a client "paid" claim.
- Security headers (Helmet CSP) and an explicit CORS allowlist are enabled; origins
  not on the list are rejected.

## Testing Knowledge

The full suite currently passes **367/367** (0 failures), verified across three
consecutive runs:

| Suite | Assertions |
|---|---|
| Pricing | 22 |
| API | 120 |
| Integration | 65 |
| Payment (mock Razorpay) | 45 |
| Conversation | 34 |
| Security | 56 |
| Production | 25 |
| **Total** | **367** |

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
