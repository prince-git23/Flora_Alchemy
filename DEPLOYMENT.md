# Flora Alchemy — Deployment Guide

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

Development and production must never resolve to the same MongoDB database.

Because `MONGO_URI` is set by hand in the hosting dashboard (`render.yaml`
leaves it `sync: false`), it is easy to paste the same connection string used
by a local `.env`. When that happens the deployed store and the local checkout
share one database, and every local seed, QA probe, or cleanup script writes
straight into the customer-facing store (and vice versa).

Verify before every deploy:

- [ ] Read `MONGO_URI` in the hosting dashboard for the API service.
- [ ] Compare its database name (the path segment before `?`) with the local `backend/.env`.
- [ ] They must differ — e.g. `…/flora_alchemy_prod` in production vs `…/flora_alchemy` locally.

The automated suites are already safe: each suite in `backend/scripts/run-all.mjs`
boots its own server against its own dedicated test database, so `npm test`
never touches either environment's data.

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
| `TRUST_PROXY` | **Yes** | No | Set to `true` behind reverse proxy |
| `RAZORPAY_KEY_ID` | No* | Yes | Live Razorpay key ID |
| `RAZORPAY_KEY_SECRET` | No* | Yes | Live Razorpay key secret |
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
- [ ] `CORS_ORIGIN` points to frontend domain
- [ ] `JWT_SECRET` is a strong random string (not development placeholder)

### Secrets
- [ ] `.env` files NOT committed to git
- [ ] Razorpay live keys configured (if payments enabled)
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
- [ ] Razorpay live keys set (if accepting real payments)
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
| API writes | 600/15min/IP |

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
