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

- **Frontend:** React 19 + Vite + Tailwind CSS
- **Backend:** Express.js + MongoDB/Mongoose
- **Auth:** JWT (customer + admin/handler sessions)
- **Package Manager:** npm

## Project Surfaces

- **Customer Storefront** — `/` (public browsing, search, cart, wishlist, checkout)
- **Handler Portal** — `/admin` (orders, products, inventory, analytics, settings)

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
| `SEED_ON_START` | Auto-seed demo fixtures on boot |

## Customer Flow

Browse → Shop → Product → Add to Cart → Checkout → Authentication → Delivery → Payment → Review → Place Order → Order Success → Tracking

## Admin Flow

`/admin/login` → Dashboard → Orders / Products / Collections / Customers / Inventory / Analytics / Settings

## API

Backend runs at `/api` with RESTful endpoints:

- Auth: register, login, logout, current user
- Products: CRUD (public read, admin write)
- Collections: CRUD
- Orders: create (customer), list (admin), status update
- Inventory: stock levels, adjustments, history
- Analytics: overview, sales, performance
- Settings: read/write store configuration
- Wishlist: customer-owned, per-account
- Customers: profile, addresses
- Conversations: order-linked customer ↔ handler messaging
- Custom Requests: customer submission, admin management

All business data is server-authoritative. Client prices are never trusted for order creation.

## Testing

```bash
cd backend
npm run test:api         # 120 API smoke tests
npm run test:integration  # 65 integration tests
npm run test:payment     # 45 payment lifecycle tests
npm run test:conversation # 34 conversation tests
npm run test:pricing     # 22 custom gift pricing tests
npm test                 # Run all 9 suites (463 assertions incl. security + production)
```

## Canonical Order Lifecycle

`new` → `confirmed` → `in_production` → `quality_check` → `ready_to_dispatch` → `shipped` → `delivered`

## License

Private — Flora Alchemy.
