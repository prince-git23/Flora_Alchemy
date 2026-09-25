# Flora Alchemy — Project Status

**Last Updated:** September 19, 2026 (Phase 17 — Repository Cleanup)

## Current Architecture

```
Flora_Alchemy/
├── frontend/          ← React/Vite application
│   ├── src/
│   │   ├── components/    (17 components incl. admin/)
│   │   ├── pages/         (49 pages: 21 customer + 28 admin)
│   │   ├── context/       (3 providers)
│   │   └── services/      (20 service files)
│   ├── public/assets/     (18 product images)
│   └── vite.config.js
├── backend/           ← Express/MongoDB API
│   ├── config/            (2 files: customGiftPricing, db)
│   ├── controllers/       (15 controllers)
│   ├── middleware/         (3 files: auth, error, security)
│   ├── models/            (13 MongoDB models)
│   ├── routes/            (15 route files, 67 endpoints)
│   ├── services/          (5 service files)
│   ├── scripts/           (9 test suites + run-all orchestrator + lib/testServer.mjs)
│   └── seed/              (seed data)
├── .freebuff/         ← development tooling
├── docs/              ← project documentation
└── root config        ← package.json, README, metadata
```

## Completed Features

### Customer Storefront
- ✅ Home page with 3D botanical canvas
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
- ✅ Checkout (4-step: Account → Delivery → Payment → Review)
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
- ✅ Protected routes (AdminRoute, protect middleware)

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

### Testing
- ✅ API smoke tests (120 assertions)
- ✅ Payment lifecycle tests (45 tests)
- ✅ Conversation tests (34 tests)
- ✅ Custom gift pricing tests (22 tests)

## Remaining Work

### P0 — Must Fix
None. All P0 items resolved.

### P1 — Important
- Tax/GST calculation (business decision needed)
- Refund flow (business decision needed)

### P2 — Quality/Performance
- Code splitting / lazy loading (1.41 MB single chunk)
- Shared rate-limit store (Redis) only if deployed multi-instance

### P3 — Optional
- Docker/PM2 deployment
- Structured logging
- API documentation (OpenAPI/Swagger)
- Newsletter backend

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
| Pricing | `npm run test:pricing` | 22 |
| API | `npm run test:api` | 120 |
| Integration | `npm run test:integration` | 65 |
| Payment (mock Razorpay) | `npm run test:payment` | 45 |
| Conversation | `npm run test:conversation` | 34 |
| Application Flow (Phase 20.6.6) | `npm run test:applications` | 82 |
| Security | `npm run test:security` | 56 |
| Production | runs inside `npm test` (no standalone script) | 25 |
| **Full run** | **`npm test`** | **691** |

Shared bootstrap: `backend/scripts/lib/testServer.mjs`. Orchestrator:
`backend/scripts/run-all.mjs` (fixed order Pricing → API → Integration →
Payment → Conversation → Security → Production; non-zero exit on any failure).
`npm run test:razorpay-real` auto-skips (exit 0) without real rzp_test_* keys.

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
- ✅ Automated test suite: 691 assertions, isolated per-suite databases

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
