# AGENTS.md — Instructions for AI coding agents

Flora Alchemy is a full-stack e-commerce boutique (handcrafted botanical keepsakes,
personalized gifts) with a customer storefront and a staff **Handler Portal**.

This file is the short, practical briefing. Deeper detail lives in
[`docs/`](./docs): [ARCHITECTURE](./docs/ARCHITECTURE.md),
[DESIGN](./docs/DESIGN.md), [MEMORY](./docs/MEMORY.md), [API](./docs/API.md),
[DATABASE](./docs/DATABASE.md), [TESTING](./docs/TESTING.md),
[CONTRIBUTING](./docs/CONTRIBUTING.md), and [DEPLOYMENT](./DEPLOYMENT.md).

---

## ⚠️ Production Safety — read this first

**Development and production currently share the same MongoDB database.**

The deployed backend (`flora-alchemy.onrender.com`) and a local checkout both
resolve to the same `MONGO_URI`, so **local seed / QA / cleanup operations write
to production data**, and production writes appear locally. This is a
**release blocker / deployment defect**, not an intended architecture — it is
documented as a known risk in [`docs/MEMORY.md`](./docs/MEMORY.md) and
[`docs/DATABASE.md`](./docs/DATABASE.md).

Therefore:

- **Never run destructive QA or cleanup scripts** (deletes, resets, `deleteMany`,
  bulk upserts) without first confirming the database target.
- **Never assume local and production databases are isolated.** They are not.
- **Check the environment/database target before any data mutation.** Inspect
  `backend/.env` → `MONGO_URI` and the hosting dashboard value, and compare the
  database name (the path segment before `?`).
- **Never expose credentials in frontend production builds.** Anything not behind
  `import.meta.env.DEV` ships to customers in the bundle. Demo credentials and
  developer helpers must be DEV-gated (see `LoginPage.jsx`,
  `AdminLoginPage.jsx`).
- A seeded **demo handler account still exists in production** and needs
  rotation/removal by the owner. Do not add or print its credentials anywhere.

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
  services/            orderService, inventoryService, conversationService, razorpayService, analyticsService
  models/              Mongoose schemas (13)
  middleware/          authMiddleware, errorMiddleware, securityMiddleware (rate limits)
  utils/               publicCache (TTL cache), querySafety (regex escaping)
  scripts/             smoke suites + run-all orchestrator + lib/testServer.mjs
  seed/seed.js         fixture data (products, collections, customers, orders)
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
npm test               # all 7 suites via scripts/run-all.mjs — currently 367 pass / 0 fail
npm run test:pricing   # 22
npm run test:api       # 120
npm run test:integration # 65
npm run test:payment   # 45 (local mock Razorpay)
npm run test:conversation # 34
npm run test:security  # 56
npm run test:razorpay-real # real sandbox; SKIPS without rzp_test_* keys
```

Every suite boots its **own** backend process against its **own** dedicated
`Flora-Alchemy-Test-*` MongoDB database, so tests never touch dev or production
data. See [`docs/TESTING.md`](./docs/TESTING.md).

**Passing tests do not mean the shared production/dev database problem is solved.**
The suites are isolated; the deployed service is not.

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
- `AdminRoute` route gating and the `import.meta.env.DEV` gates that keep
  dev-only helpers out of production bundles.

## Required validation after code changes

1. **Typecheck/build** the frontend: `npm run build` (Vite build is this repo's
   compile check — there is no separate typechecker).
2. **Run the backend suite**: `npm run test` (expect 367 pass / 0 fail), or at
   minimum the suites your change touches.
3. **Manually verify** the affected flow in the browser (storefront and/or
   `/admin`), checking console and network for errors.
4. Report what you ran and what you observed. Never claim a flow works because
   "the tests pass" when the change is UI-only, and never weaken or delete an
   assertion to make a suite go green.
