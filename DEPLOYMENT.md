# Flora Alchemy — Deployment Guide

> Related: [AGENTS.md](./AGENTS.md) (agent + production-safety rules),
> [docs/DATABASE.md](./docs/DATABASE.md),
> [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md),
> [docs/TESTING.md](./docs/TESTING.md), [docs/MEMORY.md](./docs/MEMORY.md),
> [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md).
>
> **Phase 20.6 status:** both findings now have code-side mitigation. The
> live demo handler account is **suspended** (login returns 403
> `ACCOUNT_SUSPENDED`) and every local write path is guarded by
> `backend/utils/environmentGuard.js` (fail-closed). Owner-side actions
> remain: separate the Render `MONGO_URI` database from local development
> and provision a real owner/admin account — see
> [Data Isolation](#data-isolation) and [Deployment Security](#deployment-security).

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────┐
│   Frontend   │────▶│  Backend (Node)  │────▶│ MongoDB  │
│  (Vite SPA)  │     │  (Express API)   │     │ (Atlas)  │
└─────────────┘     └──────────────────┘     └──────────┘
                           │
                    ┌──────┴──────┐
                    │   Razorpay  │
                    │  (Payments) │
                    └─────────────┘
```

## Data Isolation

**The deployed service and local development currently resolve to the same
MongoDB database.** This is a verified finding, not a hypothetical: the Render
service and a local checkout use the same `MONGO_URI`, so a local write appears
in the live production API immediately (matching document `_id`s, `updatedAt`
timestamps, row counts and inventory values).

This is a deployment defect, **not** an intended architecture. Consequences:

- Local seeding, QA probes and cleanup scripts mutate **production** data that
  customers see.
- Deleting or restoring records locally is a production data operation.
- Development and production cannot be compared, because they are one dataset.
- Fixture/demo documents (`isFixture: true`) and QA residue accumulate in the live store.

Because `MONGO_URI` is set by hand in the hosting dashboard (`render.yaml`
leaves it `sync: false`), it is easy for the two to drift into the same value.

### Required fix (owner-side — cannot be fixed in application code)

Give the API service its **own** database (a distinct database name or cluster,
e.g. `…/flora_alchemy_prod`) and re-seed it.

Verify before every deploy:

- [ ] Read `MONGO_URI` in the hosting dashboard for the API service.
- [ ] Compare its database name (the path segment before `?`) with the local `backend/.env`.
- [ ] They must differ — e.g. `…/flora_alchemy_prod` in production vs `…/flora_alchemy` locally.

Until the values differ, treat every local data mutation as a production change:
never run destructive QA/cleanup scripts, never assume the environments are
isolated, and back up the exact documents before any delete.

> The automated suites are **not** affected: each suite in
> `backend/scripts/run-all.mjs` boots its own server against its own dedicated
> `Flora-Alchemy-Test-*` database, so `npm test` never touches either
> environment's data. **A green test run does not resolve this blocker.**

### Code-side mitigation added in Phase 20.6

Because `backend/.env` on a developer machine can hold the production
connection string, application code now refuses to be the thing that mutates
it. `backend/utils/environmentGuard.js` derives the **effective database name
from the URI** (never from `NODE_ENV` alone) and every write path fails closed
unless the database is unmistakably disposable (name contains
`test`/`qa`/`dev`/`smoke`/`sandbox`, or the host is localhost):

- `npm run seed` — refuses before connecting; fixture credentials are only
  ever created in disposable databases.
- `npm run dev` / `npm start` — boot logs the classified target and refuses
  to seed a non-disposable database.
- `scripts/backfill-inventory.mjs` — refuses writes (including
  `--purge-orphans`) against a non-disposable database; `--report` stays
  read-only.
- `scripts/lib/testServer.mjs` — refuses to boot a suite whose derived test
  database lacks a disposable marker or equals the configured base database.

So a mistaken local command can no longer *silently* mutate production — it
errors with `UNSAFE_DATABASE`. This is a guard, not a substitute for the
owner-side fix below.

### Environment matrix (Phase 20.6)

| Environment | Effective database | Source |
|---|---|---|
| Development | `flora_alchemy` (local mongod) | `backend/.env.example` default |
| Test | `Flora-Alchemy-Test-<Suite>` | `scripts/lib/testServer.mjs` (derived per suite) |
| QA | `Flora-Alchemy-Test-QA-*` | QA environment `MONGO_URI` |
| Production | `Flora-Alchemy` | Render dashboard `MONGO_URI` (owner-controlled) |

## Deployment Security

**Resolved in Phase 20.6 (verified against the live API).** The seeded demo
handler account in the production database was active with a password
published in `seed.js` — anyone with repository access could authenticate as
a production administrator. It is now **suspended** (`status=SUSPENDED`):
login returns 403 `ACCOUNT_SUSPENDED` and every protected request re-checks
status server-side, so pre-existing tokens are rejected too. The account was
suspended, not deleted, so it stays auditable and can be reactivated
deliberately.

Remaining owner actions:

- [ ] Provision a real owner/admin account (the fixture was the only admin —
      there are now zero active staff accounts by design).
- [ ] Decide whether to delete the suspended fixture rows
      (`handler.admin@flora-alchemy.demo`, `customer@example.com`) entirely.
- [ ] Confirm the Render dashboard has `SEED_ON_START=false`.
- [ ] Confirm no shared/default operator credentials remain before going live.

Do not record the credentials anywhere in this repository.

## Environment Variables

### Backend (Required for Production)

| Variable | Required | Secret | Description |
|---|---|---|---|
| `NODE_ENV` | **Yes** | No | Set to `production` |
| `PORT` | No | No | Default: 4000 |
| `MONGO_URI` | **Yes** | Yes | MongoDB Atlas/self-hosted connection string |
| `JWT_SECRET` | **Yes** | Yes | Strong random string for JWT signing |
| `JWT_EXPIRES_IN` | No | No | Default: 7d |
| `CORS_ORIGIN` | **Yes** | No | Comma-separated allowed origins |
| `SEED_ON_START` | **Yes** | No | Must be `false` in production |
| `TRUST_PROXY` | Recommended | No | Set to `true` behind reverse proxy (required for accurate rate limiting) |
| `UPLOAD_DIR` | No | No | Local image-storage override; defaults to `frontend/public/uploads` (dev) / `backend/uploads` (prod container) |
| `RATE_LIMIT_*` | No | No | Rate-limit tuning (`LOGIN_FAILED_MAX`, `REGISTER_MAX`, `PAYMENT_MAX`, `UPLOAD_MAX`, `NOTIFICATION_MAX`, `WEBHOOK_MAX`, `API_WRITE_MAX`) |
| `RAZORPAY_KEY_ID` | No* | Yes | Razorpay key ID — **TEST mode only**; the adapter is not wired for live keys |
| `RAZORPAY_KEY_SECRET` | No* | Yes | Razorpay key secret (TEST mode only) |
| `RAZORPAY_WEBHOOK_SECRET` | No* | Yes | Webhook signature secret |
| `IMAGEKIT_PRIVATE_KEY` | No* | Yes | ImageKit CDN private key |
| `IMAGEKIT_PUBLIC_KEY` | No* | No | ImageKit CDN public key |
| `IMAGEKIT_URL_ENDPOINT` | No* | No | ImageKit CDN URL endpoint |

*\* = optional; feature disabled gracefully when absent*

### Frontend (Required for Production)

| Variable | Required | Description |
|---|---|---|
| `VITE_API_URL` | **Yes** | Backend API URL (e.g., `https://api.floraalchemy.com/api`) |
| `VITE_RAZORPAY_KEY_ID` | No* | Razorpay public key for checkout |

## Pre-Deploy Checklist

### Environment
- [ ] MongoDB Atlas cluster created and configured
- [ ] Production `MONGO_URI` points at a database **dedicated to production** — never the same connection string a local checkout uses
- [ ] All environment variables set in hosting platform
- [ ] `SEED_ON_START=false`
- [ ] `TRUST_PROXY=true` (behind reverse proxy)
- [ ] Demo/default operator credentials rotated or removed (see [Deployment Security](#deployment-security))
- [ ] `CORS_ORIGIN` points to frontend domain
- [ ] `JWT_SECRET` is a strong random string (not development placeholder)

### Secrets
- [ ] `.env` files NOT committed to git
- [ ] Razorpay configuration reviewed — this adapter supports TEST-mode keys only
- [ ] ImageKit credentials configured (if CDN uploads required)
- [ ] No secrets in frontend build output (verified)

### Database
- [ ] MongoDB connection string valid
- [ ] Database created (e.g., `flora_alchemy_prod`)
- [ ] Production database is distinct from the development database (see [Data Isolation](#data-isolation))
- [ ] Indexes created (automatic via Mongoose schema)
- [ ] No `SEED_ON_START=true` in production

### Storage
- [ ] ImageKit configured for production image uploads (recommended)
- [ ] OR: Local filesystem storage acknowledged as non-durable

### Payment
- [ ] Razorpay configuration reviewed (TEST-mode adapter; live keys are intentionally refused by `npm run test:razorpay-real`)
- [ ] Webhook endpoint configured: `POST /api/payments/webhook`
- [ ] Webhook secret set to match Razorpay dashboard

### Domain / HTTPS
- [ ] Backend domain configured (e.g., `api.floraalchemy.com`)
- [ ] Frontend domain configured (e.g., `floraalchemy.com`)
- [ ] SSL certificates active
- [ ] CORS_ORIGIN includes both domains

## Deploy Steps

### Backend

```bash
# 1. Clone repository
git clone https://github.com/prince-git23/Flora_Alchemy.git
cd Flora_Alchemy/backend

# 2. Install dependencies
npm ci

# 3. Configure environment
cp .env.example .env
# Edit .env with production values

# 4. Verify startup
NODE_ENV=production node server.js

# 5. Check health
curl https://api.floraalchemy.com/api/health
# Expected: {"success":true,"service":"flora-alchemy-api","status":"ok","time":"..."}

# 6. Check readiness
curl https://api.floraalchemy.com/api/readiness
# Expected: {"success":true,"status":"ready"}
```

### Frontend

```bash
# 1. Install dependencies
cd ../frontend
npm ci

# 2. Configure API URL
echo "VITE_API_URL=https://api.floraalchemy.com/api" > .env

# 3. Build for production
npm run build

# 4. Deploy dist/ to static hosting
```

## Post-Deploy Verification

### Critical Path
```bash
# Health
curl https://api.floraalchemy.com/api/health

# Readiness
curl https://api.floraalchemy.com/api/readiness

# Products (public)
curl https://api.floraalchemy.com/api/products

# Settings (public)
curl https://api.floraalchemy.com/api/settings

# Collections (public)
curl https://api.floraalchemy.com/api/collections
```

### Auth Flow
- [ ] Customer can register
- [ ] Customer can login
- [ ] Admin can login
- [ ] Role protection works (customer → admin = 403)

### Commerce Flow
- [ ] Products load on shop page
- [ ] Add to cart works
- [ ] Checkout creates order
- [ ] Payment verification works (TEST mode)
- [ ] Order appears in customer account
- [ ] Admin can update order status
- [ ] Customer receives notification
- [ ] Customer tracking reflects status

### Webhook Flow
- [ ] Webhook endpoint accessible
- [ ] Invalid signatures rejected
- [ ] Valid signatures processed

## Rollback Procedure

### Frontend Rollback
```bash
# Rebuild previous version
git checkout <previous-sha>
cd frontend && npm run build
# Redeploy dist/
```

### Backend Rollback
```bash
# Rebuild previous version
git checkout <previous-sha>
cd backend && npm ci
# Restart server
```

### Database Compatibility
- Schema changes are additive (Mongoose `strict: true`)
- Previous code versions can read current data
- New fields have defaults or are optional

## Monitoring

### Health Endpoints
- `GET /api/health` — Liveness probe (process alive)
- `GET /api/readiness` — Readiness probe (MongoDB connected)

### Logs to Monitor
- `[server]` — Startup, shutdown
- `[db]` — MongoDB connection
- `[config]` — Configuration warnings
- `[seed]` — Fixture seeding (should NOT appear in production)

### Rate Limits (Production)
| Endpoint | Limit |
|---|---|
| Login failed | 10/15min/IP |
| Register | 20/15min/IP |
| Payments | 150/15min/IP |
| Uploads | 40/15min/IP |
| Notifications | 300/15min/IP |
| Payment webhook | 300/15min/IP |
| API writes | 600/15min/IP |

All limits are per-process and in-memory (a multi-instance deployment would need a
shared store). Override with `RATE_LIMIT_*` environment variables. Public product and
collection reads are deliberately **not** rate limited.

## Troubleshooting

### Server Won't Start
- Check `MONGO_URI` is set and valid
- Check `JWT_SECRET` is set
- Check `CORS_ORIGIN` is set
- Check `NODE_ENV=production`
- Check `SEED_ON_START=false`

### Readiness Returns 503
- MongoDB connection failed
- Check MongoDB Atlas network access
- Check connection string

### CORS Errors
- Frontend origin not in `CORS_ORIGIN`
- Add frontend domain to comma-separated list

### Image Uploads Fail
- ImageKit credentials not configured
- Local filesystem used (non-durable across redeployments)
- Configure `IMAGEKIT_*` environment variables
