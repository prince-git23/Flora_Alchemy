# Flora Alchemy — Project Status

**Last Updated:** October 10, 2026 — after Phase 4 (production QA, browser E2E and a
full classified regression sweep) and the Phase 5 customer-experience pass. The
structural counts below were re-derived from the committed source; the test totals
are those reported by the Phase 4 full sweep.

## Current Architecture

```
Flora_Alchemy/
├── frontend/          ← React/Vite application
│   ├── src/
│   │   ├── components/    (41 components incl. admin/ and reviews/)
│   │   ├── pages/         (69 pages: 25 storefront + 8 account + 36 portal)
│   │   ├── context/       (4 providers)
│   │   ├── hooks/         (1 hook — useStoreVersion)
│   │   └── services/      (34 service files; ONE HTTP client, apiClient.js)
│   ├── e2e/               (Playwright browser suite: stack.mjs + 9 specs + helpers)
│   ├── public/assets/     (18 product images)
│   └── vite.config.js
├── backend/           ← Express/MongoDB API
│   ├── config/            (2 files: customGiftPricing, db)
│   ├── controllers/       (24 controllers)
│   ├── middleware/        (5 files: auth, error, security, permission, workspace)
│   ├── models/            (22 schemas: Workspace + User + Catalogue + Commerce + Ops + 3D Studio)
│   ├── routes/            (27 route files → 27 mounted prefixes, 144 handlers)
│   ├── services/          (8 service files)
│   ├── scripts/           (30 test suites + run-all orchestrator + lib/testServer.mjs
│   │                       + migration/audit/footprint tooling)
│   └── seed/              (fixture data)
├── .freebuff/         ← development tooling
├── docs/              ← project documentation
└── root config        ← package.json, README, metadata
```

## Completed Features

### Customer Storefront
- ✅ Home page with a GSAP-driven spatial hero (motion only — no WebGL/three.js)
- ✅ Shop with filters (category, occasion, recipient, price, availability)
- ✅ Product detail with gallery, personalization, related products
- ✅ Gift Finder (5-step wizard with live catalogue recommendations)
- ✅ Custom Gift Builder (7-step with server-authoritative pricing)
- ✅ Custom Request form
- ✅ Search with popular searches and category suggestions
- ✅ Collections browsing
- ✅ Our Story, How It's Made, Flora Journal pages
- ✅ Responsive design (360-1440px)

### Commerce
- ✅ Product catalogue (10 seeded products)
- ✅ Collections (3 seeded collections)
- ✅ Cart (browser-local, becomes order on checkout)
- ✅ Checkout (3 steps: Account → Delivery → Review & Pay — the separate Payment
  stage was removed in Phase 20.4 because it chose a method but never charged one)
- ✅ Server-authoritative pricing (catalogue, custom gifts, add-ons)
- ✅ Order creation with inventory reservation
- ✅ Order lifecycle (7-stage forward-only)
- ✅ Inventory management (atomic, hold/release/deduct)

### Authentication
- ✅ Customer registration and login
- ✅ Admin/handler login
- ✅ JWT-based sessions (7-day expiry)
- ✅ Customer/admin session separation
- ✅ Session expiration handling (401 → clear + redirect)
- ✅ Protected routes (AdminRoute, StaffRoute, OwnerRoute, protect middleware)

### Staff Portals (Phase 21)
- ✅ Three distinct logins — `/owner/login`, `/admin/login`, `/staff/login` — over
  the one `POST /api/auth/login`, with the optional `portal` context validated
  server-side (`403 PORTAL_FORBIDDEN` on mismatch); a URL never grants a role
- ✅ Portal Access Gateway at `/access` (`/portal` redirects there) — navigation only
- ✅ Owner portal: executive dashboard, administrators directory (accounts **and**
  live administrator invitations, with dossiers, activity and lifecycle controls),
  application review ledger, staff directory, invitations
- ✅ Administrator portal: My Staff, handler invitations, staff lifecycle, operations
- ✅ Staff portal: handler operational dashboard and work queues only
- ✅ Owner is `role=admin` + `isOwner=true` — no `owner` role, and the owner badge
  is `OWN-…`, never `ADM-…`

### Customer Account
- ✅ Overview with welcome, quick actions
- ✅ Orders tab with tracking and conversation links
- ✅ Saved Gifts (wishlist)
- ✅ Addresses (CRUD)
- ✅ Profile editing

### Admin Portal
- ✅ Dashboard with analytics
- ✅ Orders (list, detail, status update, create)
- ✅ Products (list, detail, create, edit)
- ✅ Collections (list, detail)
- ✅ Customers (list, detail)
- ✅ Inventory (overview, stock, adjust, low stock, history)
- ✅ Analytics (overview, sales, performance)
- ✅ Settings (general, commerce, notifications, access, store preferences)
- ✅ Custom Requests (list, detail, status update)
- ✅ Order conversations

### Payments
- ✅ Razorpay adapter (create order, verify signature, webhook)
- ✅ Idempotent payment handling
- ✅ Failed/cancelled payment flow
- ✅ Retry support
- ⏸️ Real Razorpay test mode (blocked on credentials)

### Messaging
- ✅ Order-linked conversations (customer ↔ handler)
- ✅ Message persistence (MongoDB)
- ✅ Read/unread tracking
- ✅ Entry points: Order Success, Account, Tracking

### Multi-Tenant Workspaces (Phase 22)
- ✅ Workspace entity + membership; owner/customer identities global by design
- ✅ Strict `{ workspaceId }` operational scope (legacy `$in [id, null]` removed)
- ✅ Composite/unique `{ workspaceId, … }` indexes (verified by `ensure-workspace-indexes.mjs`)
- ✅ Production workspace migrated (`flora-alchemy`); 0 unscoped operational rows
- ✅ Wishlist `(customerId, workspaceId)` tenancy; cart/checkout/storage namespaced per tenant
- ✅ Public storefront `/shops/:workspaceSlug` + `GET /api/shops/:slug[/products|/collections|/settings]` (public-safe projections)
- ⚠️ No frontend **unit/component** test runner. Storefront behaviour is covered by
  the Playwright browser suite (`cd frontend && npm run test:e2e`, 66 flows against
  an isolated stack) plus `npm run build` and the layout-only responsive harness

### Testing
- ✅ **30 backend suites — 0 failures**, `npm test` (2026-10-17 remediation sweep, exit 0; the
  per-suite counts are in [RELEASE_STATUS.md](./RELEASE_STATUS.md) and the full record in
  [TESTING.md](./TESTING.md))
- ✅ Database-identity guard — 30 assertions, no server and no writes (`test:guard`)
- ✅ Browser E2E — 66 Playwright flows against an isolated backend + production
  bundle (`cd frontend && npm run test:e2e`)
- ✅ Responsive audit — 856 runs × 13 viewports, **0 fails / 0 overflow / 0 JS errors**
  (`node frontend/scripts/responsive-audit/run.mjs`, Phase 22.4)

## Remaining Work

### P0 — Must Fix
None. All P0 items resolved.

### P1 — Important
- Tax/GST calculation (business decision needed)
- Refund flow (business decision needed)

### P2 — Quality/Performance
- Shared rate-limit store (Redis) only if deployed multi-instance
- Critical-path bundle work only if a real metric regresses: route-level code
  splitting is **already in place** (every page is `lazy()`-loaded; the entry chunk
  no longer carries the portal, the product page or the GSAP-heavy home chunk)

### P3 — Optional
- Docker/PM2 deployment
- Structured logging
- API documentation (OpenAPI/Swagger)
- Newsletter backend — **no customer-facing form collects an email address until this
  exists** (the footer's non-functional signup form was removed in Phase 5)

### External — Requires Credentials/Decisions
- Real Razorpay test mode verification (needs rzp_test_* keys; `npm run test:razorpay-real` skips without them)
- ImageKit credentials for CDN image hosting (local-disk upload fallback is real and tested)
- Newsletter provider selection
- GST/tax rules
- Cancellation/refund policy

## Testing (Phase 16)

Every suite boots its OWN backend process against its OWN MongoDB test database
(`Flora-Alchemy-Test-*`) — the development database is never touched, suites
cannot pollute each other, and the security suite's rate-limiter exhaustion
stays contained in its own server process.

| Suite | Command (from backend/) | Assertions |
|---|---|---|
| Environment Guard (Phase 4) | `npm run test:guard` | 30 |
| Pricing | `npm run test:pricing` | 22 |
| API | `npm run test:api` | 125 |
| Integration | `npm run test:integration` | 81 |
| Marketplace | `npm run test:marketplace` | 108 |
| Shop Services | `npm run test:shop-services` | 122 |
| Checkout | `npm run test:checkout` | 111 |
| Custom Request | `npm run test:custom-request` | 78 |
| Payment (mock Razorpay) | `npm run test:payment` | 45 |
| Conversation | `npm run test:conversation` | 34 |
| Provisioning (Phase 20.6.1) | `npm run test:provisioning` | 84 |
| Activation (Phase 20.6.2/22.4) | runs inside `npm test` | 44 |
| Invitation Link | runs inside `npm test` | 82 |
| Staff Lifecycle (Phase 20.6.3–20.6.5) | runs inside `npm test` | 146 |
| Portal Auth (Phase 21.1–21.2) | `npm run test:portal` | 58 |
| Personnel Lifecycle (Phase 21.4–21.7) | `npm run test:lifecycle` | 110 |
| Application Flow (Phase 20.6.6) | `npm run test:applications` | 82 |
| Tenant Core (Phase 22.2) | `npm run test:tenant` | 117 |
| Tenant Matrix (Phase 22.3) | `npm run test:tenant-matrix` | 190 |
| Admin Onboarding (Phase 22.4–22.5) | `npm run test:onboarding` | 141 |
| Staff Permissions | runs inside `npm test` | 119 |
| Action Center (Phase 23) | runs inside `npm test` | 84 |
| Legacy Backfill (Phase 22.5) | `npm run test:legacy-backfill` | 32 |
| Reference Studio (3D Phase 1) | `npm run test:references` | 120 |
| 3D Studio (3D Phase 2–3) | `npm run test:3d` | 188 |
| 3D Worker Provider (3D Phase 4) | `npm run test:3d-worker` | 52 |
| Media Storage (Phase 10) | `npm run test:media-storage` | 75 |
| 3D Quality (3D Phase 5) | `npm run test:3d-quality` | 84 |
| Security | `npm run test:security` | 105 |
| Production | runs inside `npm test` | 32 |
| **Full run** | **`npm test`** | **2701** (30 suites, 2026-10-17) |

Shared bootstrap: `backend/scripts/lib/testServer.mjs`. Orchestrator:
`backend/scripts/run-all.mjs` (fixed order: functional suites → tenant suites →
Admin Onboarding → Security → Production; non-zero exit on any failure, and each
suite reported as `PASS` / `FAIL` / `ENVIRONMENTAL/TIMEOUT` / `CAPACITY` / `NOT RUN`).
The orchestrator drops each suite's disposable database as it goes, because the
shared cluster caps a project at 500 **collections** and a full sweep needs ~660.
`npm run test:razorpay-real` auto-skips (exit 0) without real rzp_test_* keys.

There is **no frontend unit-test runner**: storefront behaviour is covered by the
Playwright browser suite in `frontend/e2e` (`npm run test:e2e`) plus `npm run build`
and the layout-only responsive harness.

## Production Readiness

### Ready
- ✅ Frontend builds successfully
- ✅ Backend starts and connects to MongoDB
- ✅ All API endpoints functional
- ✅ Authentication working
- ✅ Authorization working
- ✅ Server-authoritative pricing
- ✅ Inventory management
- ✅ Order lifecycle
- ✅ Payment adapter ready
- ✅ Responsive design
- ✅ Error handling
- ✅ Rate limiting (failed-login, register, payments, uploads, webhooks)
- ✅ Security headers (Helmet CSP/HSTS) + CORS allowlist
- ✅ Operator status management (suspension enforced server-side)
- ✅ Automated test suite: 30 suites, isolated per-suite databases (orchestrator reclaims
  each one, so the 500-collection cluster cap is never reached)
- ✅ Browser E2E gate: 66 Playwright flows, disposable database, loopback API origin
  asserted against the built bundle

### Not Ready
- ❌ Structured logging
- ❌ Monitoring/health checks (beyond health/readiness endpoints)
- ❌ Real payment verification (needs rzp_test_* credentials — EXTERNAL)

## External Dependencies

- **MongoDB:** Local or Atlas (configured via backend/.env)
- **Razorpay:** Optional (configured via backend/.env)
- **Node.js:** >=18.0.0

## Environment Variables

### Frontend (frontend/.env)
- `VITE_API_URL` — Backend API base URL

### Backend (backend/.env)
- `PORT` — Server port (default: 4000)
- `MONGO_URI` — MongoDB connection string
- `JWT_SECRET` — Auth token signing key
- `JWT_EXPIRES_IN` — Token lifetime (default: 7d)
- `CORS_ORIGIN` — Allowed browser origins (REQUIRED in production)
- `NODE_ENV` — `production` enables strict rate limits
- `TRUST_PROXY` — `true` only behind a reverse proxy
- `SEED_ON_START` — Auto-seed demo fixtures on boot
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` — Razorpay (optional)
- `IMAGEKIT_*` — Image hosting CDN (optional; local-disk fallback is real)
- `RATE_LIMIT_*` — Rate-limit tuning (see backend/.env.example)
