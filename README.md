# Flora Alchemy

Handcrafted botanical keepsakes, personalized gifts, and floral art boutique — full-stack ecommerce application.

## Architecture

```
Flora_Alchemy/
├── frontend/          ← React/Vite application
├── backend/           ← Express/MongoDB API
├── .freebuff/         ← development tooling
├── docs/              ← project documentation
└── root config        ← repository-level files
```

- **Frontend:** React 19 + Vite + Tailwind CSS v4 (every page is `lazy()`-loaded — route-level code splitting)
- **Backend:** Express.js + MongoDB/Mongoose
- **Auth:** JWT (customer + owner/admin/handler sessions, separate scopes)
- **Package Manager:** npm

## Project Surfaces

- **Customer Storefront** — `/` (browsing, search, collections, shop addresses, gift
  finder, custom gift studio, custom requests, cart, wishlist, checkout, order
  tracking, account, reviews)
- **Portal Access Gateway** — `/access` (navigation only; `/portal` redirects here)
- **Administrator Portal** — `/admin` (orders, products, collections, customers,
  inventory, reviews, custom requests, conversations, analytics, staff, settings)
  including the **3D Studio — Prepare Images** section on the product create/edit
  pages (upload product photos or flyers, background removal, review, accept —
  see [docs/IMAGE_STUDIO.md](docs/IMAGE_STUDIO.md))
- **Owner Portal** — `/owner` (owner console, applications ledger, shop governance,
  administrators, staff, invitations)
- **Staff / Handler Portal** — `/staff` (the handler's own operational workspace and
  work queues)

Each portal has its own login (`/admin/login`, `/owner/login`, `/staff/login`) and its
own server-side role gate; a URL never grants a role.

## Quick Start

### Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
```

### Backend

```bash
cd backend
npm install
cp .env.example .env   # configure MONGO_URI, JWT_SECRET
npm run dev            # http://localhost:4000
```

### Both (Windows PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File .freebuff/start-mongod.ps1
powershell -ExecutionPolicy Bypass -File .freebuff/start-backend.ps1
powershell -ExecutionPolicy Bypass -File .freebuff/start-server.ps1
```

### Root-Level Scripts

```bash
npm run dev          # Start frontend
npm run build        # Build frontend
npm run api          # Start backend
npm run api:dev      # Start backend in dev mode
npm run test         # Run all backend tests
npm run install:all  # Install all dependencies
```

## Environment Variables

### Frontend (frontend/.env)

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Backend API base URL (default: `http://localhost:4000/api`) |

### Backend (backend/.env)

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default: 4000) |
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Auth token signing key |
| `JWT_EXPIRES_IN` | Token lifetime (default: 7d) |
| `CORS_ORIGIN` | Allowed browser origins |
| `SEED_ON_START` | Auto-seed demo fixtures on boot (refused in production) |
| `REFERENCE_MEDIA_DIR` | Private root for reference-image original/cutout/preview files (default `backend/reference-media`) |
| `THREE_MEDIA_ROOT` | Private root for 3D candidates, approved GLBs and thumbnails (default `<backend>/uploads/3d-media`) |

Both media roots hold **unreviewed, private** material and must live on a volume
that survives a deploy. On Render set them inside the persistent disk
(`/var/data/flora-alchemy/…`); moving an existing store is a verified copy, not a
config edit (`backend/scripts/migrate-private-media.mjs`). See
[DEPLOYMENT.md](DEPLOYMENT.md#private-media-reference-images--3d-models).

## Customer Flow

Browse → Shop → Product → Add to Bag → Cart → Checkout (Account → Delivery →
Review & Pay) → order creation with inventory reservation → Payment (Razorpay
adapter; the server recomputes the amount from the stored order total) → Order
Success → Order Tracking

## Staff Flow

`/access` → the portal that matches the identity → Dashboard → the surfaces that
portal owns. Administrators work in `/admin` (orders, products, collections,
customers, inventory, reviews, custom requests, conversations, analytics, staff,
settings); handlers work in `/staff` (the same operational queues, scoped to their
owner-assigned permissions); the platform Owner works in `/owner`.

Owner-only extras: `/admin/owner` (owner console) and `/admin/applications`
(review ledger), fed by the public `/apply/admin` intake —
application → owner approval → one-time invitation link → activation → login.

## API

Backend runs at `/api` with RESTful endpoints — **144 route handlers across 27
routers**, plus `/api/health` and `/api/readiness`. See
[docs/API.md](docs/API.md) for the per-endpoint reference.

| Prefix | Domain |
|---|---|
| `/api/auth` | register, login (all portals), logout, `me` |
| `/api/customers` | staff-facing customer records, profile, addresses |
| `/api/products` `/api/collections` | catalogue CRUD (public read, staff write) |
| `/api/reviews` `/api/admin/reviews` | customer reviews + staff moderation |
| `/api/shops` | public shop addresses (`GET /shops/:slug`) |
| `/api/orders` | customer creation, staff list/detail, forward-only status |
| `/api/inventory` | stock levels, adjustments, history |
| `/api/analytics` | overview, sales, performance |
| `/api/settings` | store configuration |
| `/api/wishlist` | customer-owned saved gifts |
| `/api/payments` | Razorpay create/verify/webhook (TEST-mode adapter) |
| `/api/conversations` | order-linked customer ↔ staff messaging |
| `/api/custom-requests` | customer submission, staff management, proposals |
| `/api/admin/users` `/api/admin/staff` `/api/admin/access` | operators, staff directory/lifecycle, granular permissions |
| `/api/admin/invitations` `/api/invitations` | staff invitations + public activation |
| `/api/admin-applications` `/api/owner` | admin application intake, owner review ledger, owner console |
| `/api/notifications` `/api/uploads` | per-user feed, media upload |
| `/api/references` | 3D Studio — prepared product reference images (original + transparent cutout + neutral preview, private storage) |
| `/api/3d` | 3D Studio — staff generation jobs/asset approval (`/api/3d/assets/…`), plus the public approved-model delivery (`GET /api/3d/public/…`) |

All business data is server-authoritative. Client prices are never trusted for order creation.

## Testing

There is **no frontend unit-test runner**. The backend suites are hand-rolled Node
scripts (no test framework), and storefront behaviour is covered by a Playwright
browser E2E suite that drives the real stack.

```bash
cd backend
npm test                   # orchestrator: 30 suites, 2701 assertions (2026-10-17, exit 0)
npm run test:guard         # 30  — database-identity guard (no server, no DB, no writes)
npm run test:pricing       # 22  — custom gift pricing authority
npm run test:api           # 125 — core API smoke
npm run test:integration   # 81  — admin users, notifications, collections, uploads
npm run test:payment       # 45  — payment lifecycle against a local mock Razorpay
npm run test:conversation  # 34  — order-linked messaging
npm run test:security      # 105 — server-side authz, ownership, rate limits, CORS
npm run test:onboarding    # 141 — client admin onboarding + workspace activation
npm run test:applications  # 82  — application intake → owner review → invitation
npm run test:references    # 120 — 3D Studio image preparation (engines, licence guard, review, tenancy, scoped cleanup)
npm run test:3d            # 188 — 3D Studio generation, approval and public 3D delivery
npm run test:3d-worker     # 52  — Phase 4 local-worker adapter contract (loopback stand-in, no GPU)
npm run test:3d-quality    # 84  — Phase 5 model quality gate
npm run test:media-storage # 75  — private media roots: absolute paths, traversal, immutability, typed failures
npm run test:marketplace   # 108 — shop identity / marketplace surfaces
npm run test:shop-services # 122 — shop serviceability + delivery promises
npm run test:checkout      # 111 — checkout ownership, totals, reservation/release
npm run test:custom-request# 78  — custom request workflow + proposals
npm run test:boot-gate     # clean-checkout boot/route-registration gate
npm run test:3d-real       # OPT-IN real generation: needs a live tools/3d-worker/worker.py

cd frontend
npm run test:e2e           # Playwright browser suite against an isolated stack
```

Every suite boots its **own** backend against its **own** `Flora-Alchemy-Test-*`
database, so tests never touch development or production data. The orchestratorfrees each suite's database as it goes, so a full sweep stays inside the shared
cluster's 500-collection cap. See [docs/TESTING.md](docs/TESTING.md) and the
measured record in [docs/RELEASE_STATUS.md](docs/RELEASE_STATUS.md).

## Canonical Order Lifecycle

`new` → `confirmed` → `in_production` → `quality_check` → `ready_to_dispatch` → `shipped` → `delivered`

## License

Private — Flora Alchemy.
