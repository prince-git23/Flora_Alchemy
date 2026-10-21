# Flora Alchemy — Deployment Guide

> Related: [AGENTS.md](./AGENTS.md) (agent + production-safety rules),
> [docs/DATABASE.md](./docs/DATABASE.md),
> [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md),
> [docs/TESTING.md](./docs/TESTING.md), [docs/MEMORY.md](./docs/MEMORY.md),
> [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md).
>
> **Current status (verified 2026-10-06, carried forward):** the two Phase 20.6
> findings are closed. Production holds **no fixture documents** and **no demo
> handler account**, and the Render `MONGO_URI` resolves to a database
> (`Flora-Alchemy`) that is distinct from local development
> (`flora_alchemy_dev`) — see [Data Isolation](#data-isolation). Every local
> write path stays guarded by `backend/utils/environmentGuard.js` (fail-closed),
> so a future mistake fails loudly instead of touching production. The remaining
> owner actions are the **private-media disk**
> ([Private media](#private-media-reference-images--3d-models)) and confirming a
> real owner/admin account exists ([Deployment Security](#deployment-security)).

## Architecture

```
┌──────────────────┐      ┌────────────────────────────┐      ┌──────────┐
│ Storefront (SPA) │─────▶│ API  flora-alchemy.onrender │─────▶│ MongoDB  │
│ Vercel static    │      │ .com  (Express, 1 instance) │      │ (Atlas)  │
└──────────────────┘      └─────────────┬──────────────┘      └──────────┘
                                        │
                              ┌─────────┴─────────┐
                              │ /var/data (disk)  │  private media:
                              │  references/      │  originals, cutouts,
                              │  3d-media/        │  previews, GLBs
                              └───────────────────┘
```

**Hosts, as currently configured (not as a blueprint aspiration):**

| Piece | Host | Notes |
|---|---|---|
| API | Render web service `flora-alchemy-api` → `https://flora-alchemy.onrender.com` | health check `/api/health` |
| Storefront | Vercel static deployment | CORS expects the **canonical project domain**, not a per-deployment `<project>-<hash>.vercel.app` URL |
| Database | MongoDB Atlas, database `Flora-Alchemy` (production) vs `flora_alchemy_dev` (local) | see [Data Isolation](#data-isolation) |

The `flora-alchemy-frontend` block in [`render.yaml`](./render.yaml) is an
**unused alternative** — the frontend is not deployed there today. Do not treat
that file as evidence of where the storefront runs; `VITE_API_URL` in the Vercel
build is the only thing that decides which API a deployed bundle talks to.
Verifying the live bundle: open the deployed storefront, and in devtools check a
request to `/api/...` — its origin must be the Render API above (the E2E build
refuses to run unless a *local* bundle points at loopback).

## Data Isolation

**Development and production now resolve to distinct databases on the shared
cluster** (Phase 22.5): local development uses `flora_alchemy_dev`, and the
deployed Render service uses `Flora-Alchemy`. The former shared-database defect is
**resolved** — a local write no longer appears in the production API.

Because `MONGO_URI` is set by hand in the hosting dashboard (`render.yaml` leaves
it `sync: false`), the two can still drift. Verify before every deploy:

- [ ] Read `MONGO_URI` in the hosting dashboard for the API service.
- [ ] Compare its database name (the path segment before `?`) with the local `backend/.env`.
- [ ] They must differ — production `Flora-Alchemy` vs local `flora_alchemy_dev`.

Still true and worth respecting:

- `Flora-Alchemy` is **production** and is protected by the migration scripts'
  (`backfill-workspaces.mjs`, `ensure-workspace-indexes.mjs`,
  `attach-wishlist-workspaces.mjs`) confirmation gates.
- Never create fixture/demo documents (`isFixture: true`) in production.
- The two databases share one **cluster** with a **500-collection cap** — keep
  disposable `Flora-Alchemy-Test-*` / `prod-smoke-*` databases cleaned up.

> The automated suites are **not** affected: each suite in
> `backend/scripts/run-all.mjs` boots its own server against its own dedicated
> `Flora-Alchemy-Test-*` database, so `npm test` never touches either
> environment's data. There is also **no frontend automated test runner** —
> frontend verification is `npm run build`, the layout-only responsive harness, and
> manual browser checks.

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
| Development | `flora_alchemy_dev` | `backend/.env` → `MONGO_URI` (must **not** be the production database) |
| Test | `Flora-Alchemy-Test-<Suite>` | `scripts/lib/testServer.mjs` (derived per suite) |
| QA | `Flora-Alchemy-Test-QA-*` | QA environment `MONGO_URI` |
| Production | `Flora-Alchemy` | Render dashboard `MONGO_URI` (owner-controlled) |

## Deployment Security

**Resolved and verified.** The seeded demo handler account once existed in the
production database with a password published in `seed.js` — anyone with
repository access could authenticate as a production administrator. It was
suspended in Phase 20.6, and production was then verified on **2026-10-06** to
hold **zero** `isFixture: true` documents and **no**
`handler.admin@flora-alchemy.demo` account at all. The finding is therefore
closed, not merely mitigated: re-checking it is a regression test, not routine
state.

What must stay true (and is enforced by code, not by this document):

- `SEED_ON_START=true` is **refused** in production (`validateProductionConfig()`),
  and `seedIfEmpty()` additionally refuses to write fixtures into a database that
  is not unmistakably disposable.
- Login returns `403 ACCOUNT_SUSPENDED` for a suspended account, **and** every
  protected request re-reads the user's `status` from the database, so a token
  issued before suspension stops working.
- `scripts/environment-guard-smoke.mjs` is in the release gate: if a fixture or a
  demo credential could ever reach production again, it fails there first.

Remaining owner actions:

- [ ] Confirm a real owner/admin account exists and can sign in — see
      [Staff Provisioning](#staff-provisioning-phase-2061) for the exact command.
- [ ] Confirm the Render dashboard has `SEED_ON_START=false`.
- [ ] Confirm no shared/default operator credentials remain before going live.

Do not record the credentials anywhere in this repository.

## Staff Provisioning (Phase 20.6.1)

There is **no public staff signup**. `POST /api/auth/register` is customer-only
and rejects any `role` other than `customer` (`422 PRIVILEGED_ROLE_FORBIDDEN`).
Staff accounts come from exactly two places:

1. **First owner bootstrap** — guarded server-side command (not an HTTP
   endpoint, not a frontend flow):

   ```bash
   cd backend
   CONFIRM_DATABASE_UNSAFE_OPERATION=Flora-Alchemy \
   PROVISION_ADMIN_CONFIRM=CREATE_PRODUCTION_ADMIN \
   PROVISION_ADMIN_EMAIL=<owner@example.com> \
   npm run provision-admin
   # prompts for the password with hidden input (or set PROVISION_ADMIN_PASSWORD;
   # minimum 12 chars — never commit it, never put it in chat/logs)
   ```

   Rules enforced by the script:
   - target database is classified by `utils/environmentGuard.js`; a
     non-disposable database requires BOTH confirmations shown above (the
     Phase 20.6 guard itself is not weakened — ordinary writes stay refused)
   - refuses while an **active** administrator already exists (authorized
     recovery only: `PROVISION_ADMIN_RECOVERY=I_UNDERSTAND_AN_ADMIN_EXISTS`)
   - refuses duplicate emails; hashes with bcrypt-12; `role=admin`,
     `isFixture=false`; **never prints or stores the password in plaintext**

   For development the same command runs without confirmations (the dev
   database is disposable).

2. **An authorized admin** via `POST /api/admin/users` (Admin & Handler Access
   page at `/admin/access`) — admin-only route; password required, never
   echoed back; handlers/customers/anonymous are rejected (403/401).

Account lifecycle: `PATCH /api/admin/users/:id/status` suspends
(login → `403 ACCOUNT_SUSPENDED`, existing tokens rejected on the next request)
and reactivates without changing the role; `PATCH …/:id/role` changes roles;
self-suspension, self-demotion, self-deletion and removing the last active
administrator are all refused.

## Admin Applications (Phase 20.6.6)

The owner may accept public administrator applications end to end — this
introduces **no public staff signup** (register stays customer-only):

1. **Public intake** — `/apply/admin` (frontend) →
   `POST /api/admin-applications`. Creates an `AdminApplication` dossier only:
   no User, no credential, no Invitation, no JWT. Client-supplied
   `role` / `isOwner` / `status` / `userId` / `password` fields are never read.
   Rate-limited by `applicationLimiter`
   (`RATE_LIMIT_APPLICATION_MAX`: 10 per 15 min in production, 150 in
   development). Active owners receive a `system` notification linking to
   `/admin/applications`.
2. **Owner review** — `/admin/applications` (`AdminRoute` + `OwnerRoute` in the
   frontend; `protect, requireOwner` server-side — a plain administrator with
   `isOwner:false` gets 403). Tabs reflect whole-ledger counts from
   `GET /api/admin-applications`; a dossier deep-links via `?id=`.
3. **Approve** — `POST /api/admin-applications/:id/approve` runs ONE MongoDB
   transaction whose first statement is the claim gate
   (`SUBMITTED/PENDING_REVIEW → APPROVED`), so two concurrent approvals yield
   exactly one invitation (the loser gets 409, never a second credential).
   The invitation role is fixed to `admin`. The activation link is returned
   **exactly once** in the approve response; only its SHA-256 hash is stored.
   The link origin comes from `STAFF_PORTAL_URL` (the owner UI rewrites the
   pathname onto its own origin when copying).
4. **Reject** — `POST …/reject`, reason required (≥ 10 chars). Review
   decisions are one-way: approve-after-reject and reject-after-approve both
   answer 409 (mirrors the forward-only order lifecycle).
5. **Activate** — the recipient opens `/admin/activate/<token>` and sets a
   password through the existing Phase 20.6.2 flow. The dossier moves
   `APPROVED → INVITED` lazily when the landing link is opened, then
   `→ ACTIVATED` on activation; the new administrator can sign in at
   `/admin/login` but still cannot review applications (no `isOwner`).

Statuses: `SUBMITTED/PENDING_REVIEW → APPROVED → INVITED → ACTIVATED`, or
`→ REJECTED`; `EXPIRED` is reconciled lazily before owner reads when the
linked invitation passes its 72 h TTL. Endpoints, authz matrix, one-way
transitions and the approve race are covered by
`npm run test:applications` (82 assertions on an isolated test database).

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
| `UPLOAD_DIR` | No | No | Public product-image storage override; defaults to `frontend/public/uploads` (dev) / `backend/uploads` (prod container). **Public** — never point private media here |
| `REFERENCE_MEDIA_DIR` | Recommended | No | **Private** root for reference originals/cutouts/previews. Production: `/var/data/flora-alchemy/references` (see [Private media](#private-media-reference-images--3d-models)) |
| `THREE_MEDIA_ROOT` | Recommended | No | **Private** root for 3D candidates, approved GLBs, thumbnails. Production: `/var/data/flora-alchemy/3d-media` |
| `THREE_D_PROVIDER` | No | No | 3D generation provider. Unset = generation disabled; `local_gpu_agent` (production shape), `local_worker`, or `meshy` (requires `MESHY_API_KEY`; never a fallback). The old `3D_PROVIDER` name is a deprecated local alias only — Render rejects names beginning with a digit, so use this name |
| `THREE_WORKER_AGENT_TOKEN` | With `local_gpu_agent` | Yes | Machine secret (≥16 chars) shared by the API and `tools/3d-worker/agent.py` |
| `THREE_WORKER_AGENT_URL` | No | No | Public `/api` base the remote agent calls (display/diagnostics only on the server) |
| `MESHY_API_KEY` | No | Yes | Only with `THREE_D_PROVIDER=meshy`. A paid provider is never selected automatically |
| `THREE_WORKER_URL` | No | No | Address of a private 3D worker. The bundled worker is loopback-only and is **not** deployed |
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

## Private media (reference images + 3D models)

Unreviewed reference originals, their cutouts/previews, and **every** 3D model
(candidate or approved) live in two private roots on the API's filesystem. They
are not in the repository, not in the CDN and not in `public/`. On Render the
filesystem under the app directory is **replaced on every deploy**, so those
roots must sit on a persistent disk.

### One-time setup (owner action — paid, plan-dependent)

Creating a disk is an infrastructure and billing decision, so the blueprint does
**not** do it for you:

1. Render dashboard → the `flora-alchemy-api` service → **Disks** → **Add Disk**.
   Name `flora-alchemy-data`, mount path `/var/data`, size ≥ 1 GB. Check the
   current plan supports disks (Starter and above) before confirming.
2. Add the two variables (dashboard → Environment):
   ```
   REFERENCE_MEDIA_DIR=/var/data/flora-alchemy/references
   THREE_MEDIA_ROOT=/var/data/flora-alchemy/3d-media
   ```
3. Deploy. Then verify:
   ```bash
   curl -s https://flora-alchemy.onrender.com/api/health | jq .media
   ```
   Expected: `media.reference.durable` and `media.threeD.durable` are `true`, and
   `writable` is `true` (both roots were probed at boot and the probe write
   succeeded). If `configured` is `false` the root is the development default,
   which means the deploy is writing into its own (ephemeral) filesystem.

> ⚠️ **Do not set those variables before the disk exists.** A deploy that points
a root at `/var/data` without a mounted disk writes to the container filesystem
and loses those files at the next deploy — exactly the failure the disk prevents.

### Migrating an existing store

If media was already written under a deploy directory (or the plan changed),
copy it — never move it:

```bash
# 1. Dry run: inventory + plan, writes nothing
node backend/scripts/migrate-private-media.mjs \
     --kind=reference --from=<old-root> --to=/var/data/flora-alchemy/references

# 2. Copy with size + SHA-256 verification and a manifest
node backend/scripts/migrate-private-media.mjs \
     --kind=reference --from=<old-root> --to=/var/data/flora-alchemy/references --apply

# 3. Repeat with --kind=three for the 3D root, then set the env vars and deploy.
```

The tool refuses to overwrite, is safe to re-run, and never changes configuration.
Run it against the **old** disk (attach it read-only to a temporary job) or from a
backup; a container that has already been replaced has no files left to copy.

### Why this is not optional

Without the disk, a redeploy leaves database rows whose bytes are gone. The suite
now models this failure (`scripts/media-storage-smoke.mjs`) and the API reports it
explicitly: asset reads answer `available: false, missing: true`, processing fails
with `ORIGINAL_MISSING`, and `/api/health` says the root is not durable. It is
detectable — it is just not recoverable without the original file.

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
- [ ] ImageKit configured for production product-image uploads (recommended — the storefront's public images)
- [ ] **Persistent disk attached** to the API service, mounted at `/var/data` (see [Private media](#private-media-reference-images--3d-models))
- [ ] `REFERENCE_MEDIA_DIR` and `THREE_MEDIA_ROOT` point **inside** that disk — never inside the deploy directory
- [ ] `GET /api/health` reports `media.reference.durable: true` and `media.threeD.durable: true` with `writable: true`
- [ ] Existing media copied with `scripts/migrate-private-media.mjs` (dry run, then `--apply`) if the roots moved

### Payment
- [ ] Razorpay configuration reviewed (TEST-mode adapter; live keys are intentionally refused by `npm run test:razorpay-real`)
- [ ] Webhook endpoint configured: `POST /api/payments/webhook`
- [ ] Webhook secret set to match Razorpay dashboard

### Domain / HTTPS
- [ ] Backend domain configured (e.g., `api.floraalchemy.com`)
- [ ] Frontend domain configured (e.g., the Vercel project domain)
- [ ] SSL certificates active
- [ ] `CORS_ORIGIN` lists the **exact** frontend origin(s) — see [CORS Configuration (Production)](#cors-configuration-production)

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

### Media Rollback

Media is **not** deployed with the code, so rolling the code back does not roll media
back. Before any release that changes a media root:

1. Run the migration **dry run** and keep its manifest.
2. Copy (never move) — the old root stays intact and readable until the new one is
   verified.
3. Rolling back is then a config change: point the env var at the old root and
   redeploy. Nothing is deleted by the migration tool, so both roots remain valid.

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

## CORS Configuration (Production)

The API uses an **explicit, exact-match origin allowlist** — never a wildcard —
because every browser request carries a Bearer token. The behaviour below is
implemented in `backend/server.js`; do not "fix" a rejected origin by widening it.

### The variable

| Variable | Required in production | Parsing |
|---|---|---|
| `CORS_ORIGIN` | **Yes** — the server **exits at boot** when unset (`validateProductionConfig()`) | Comma-separated list of full origins; each entry is raw-parsed and **canonicalized** (`backend/utils/corsOrigins.js`); matching is **exact** (scheme + host + port) |

- **Development fallback:** when `CORS_ORIGIN` is unset in a non-production run it
defaults to `http://localhost:3000,http://127.0.0.1:3000`. That fallback can
never apply in production, because production refuses to start without the
variable.
- **Multiple origins:** supported — `https://a.example,https://b.example`.
- **Canonicalization (why a normal-looking URL works):** browsers send a
canonical serialized origin — lower-case host, no trailing slash, no path. Each
configured entry is therefore put through `new URL()` and stored as its
`origin`, so `https://Store.Example.com/` matches `https://store.example.com`.
This can never *widen* the allowlist: it only maps a valid http(s) URL onto the
single string a browser can send, and drops anything else.
- **Unusable entries are dropped and logged, never silently accepted.** A value
that cannot be canonicalized — `store.example.com` (no scheme), `*`,
`https://*.example.com`, `file://…` — is discarded at boot with
`[config] CORS_ORIGIN: ignoring N unusable entries …`. **A wildcard can never be
configured**: entries containing `*` are refused, and `isOriginAllowed()` is a
membership test, never a pattern match. Every boot logs the effective list:
`[config] CORS allowlist (1) → https://…`. Never edit the list to "make the
wildcard work"; add the exact origin instead.
- **Entry typos used to be invisible.** Before canonicalization, a
`https://store.example.com/` entry (with a trailing slash) could never equal a
browser-sent origin: the entire storefront was refused with no signal anywhere.
If the storefront fails with `ORIGIN_NOT_ALLOWED`, read the boot log's
`[config] CORS allowlist` line and compare it with the `Origin` the browser
actually sends (DevTools → Network → the failing request).
- **No-Origin clients:** requests without an `Origin` header (curl, server-to-server
calls, the backend smoke suites) are always allowed. This is why the API answers
`curl` normally even when a browser is being rejected.
- **Credentials:** *not* enabled. Auth uses a Bearer token in a header, not cookies,
so responses deliberately carry no `Access-Control-Allow-Credentials`.
- **Preflight:** `OPTIONS` is handled by the `cors` middleware, **before** routing,
authentication and rate limiting. Allowed methods are
`GET, POST, PATCH, PUT, DELETE, OPTIONS`; allowed headers are
`Content-Type, Authorization`; `Access-Control-Max-Age` is 86400.

### Canonical production storefront origin

| Origin | Whitelisted? | Notes |
|---|---|---|
| `https://flora-alchemyy.vercel.app` | **Yes** | The real storefront (Vercel project domain, stable across deployments). |
| `https://<project>-<hash>-<team>.vercel.app` | **No** | Per-deployment Vercel URLs are immutable, SSO-protected and throwaway. Never whitelist them. **Verified 2026-10-13:** the deployed API also refuses them (they answer `403 ORIGIN_NOT_ALLOWED`), so a Vercel **Preview** deployment cannot call the production API. That is intentional and unchanged by the 403 fix — a preview origin was refused before it too (as a 500). To make a specific preview URL work, add that **exact** origin to `CORS_ORIGIN` in the Render dashboard and redeploy; never use a wildcard or a `*.vercel.app` pattern. |
| `https://floraalchemy.com` / `https://www.floraalchemy.com` | **No** | Registered but **parked** (they do not serve the storefront). Add them only once they actually do. |

### Production fails closed (403, never 500)

When an `Origin` is not in the list, the `cors` origin callback rejects the
request through the error middleware. The signature is:

* **Rejected origin** → HTTP **403** `{"success":false,"message":"This origin is not allowed to access the API.","code":"ORIGIN_NOT_ALLOWED"}` with **no** `Access-Control-Allow-Origin` header, and the request is **never routed or authenticated**. The response body is static — it never echoes the supplied origin and carries no stack/internal fields.
* **Allowed origin** → HTTP **200/204** with `Access-Control-Allow-Origin` set to the exact origin and `Vary: Origin`.
* **No `Origin` header** → no CORS decision at all (curl, server-to-server, Render's health check). `GET /api/health` and `GET /api/readiness` answer normally.

A rejected origin is a **client** error. It used to answer `500 INTERNAL_ERROR`
because the callback handed a plain `Error` to the error handler, which meant
"a Vercel preview / a local dev server pointed at the API" and "the backend is
down" were indistinguishable in the logs — and any third party could raise 5xx
in monitoring at will, from the allowlist-free public internet. Fixed in the
pre-merge audit: 403 `ORIGIN_NOT_ALLOWED` (`backend/server.js`), with the
disallowed-origin assertions in `backend/scripts/security-smoke.mjs`.

Note the *ordering* consequence: `cors` is installed before routing, so a
`/api/health` request that **does** carry a disallowed browser `Origin` is also
refused with 403. The health check Render uses sends no `Origin`, so readiness
monitoring is unaffected.

### Verify it (from a shell, no secrets involved)

```bash
API=https://flora-alchemy.onrender.com
ORIGIN=https://flora-alchemyy.vercel.app

# Authorized origin → 204 + ACAO echoing the origin
curl -si -X OPTIONS "$API/api/products" \
  -H "Origin: $ORIGIN" \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: content-type' \
  | grep -iE '^HTTP/|^access-control-allow-origin|^vary'

# Unauthorized origin → 403 ORIGIN_NOT_ALLOWED with no ACAO (fail-closed)
curl -si -X OPTIONS "$API/api/products" \
  -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: GET' | grep -iE '^HTTP/|^access-control-allow-origin'

# Unauthorized origin on an ordinary GET → 403, and the request is not processed
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/products?limit=1" -H 'Origin: https://evil.example'

# No Origin header (curl / Render's health probe) → 200, no CORS decision
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/health"
```

Because `render.yaml` sets `CORS_ORIGIN` with `sync: false`, the value lives in the
**Render dashboard only** (Service → Environment). Changing it requires a redeploy;
the value is never committed.

## Production Data Hygiene

Audited 2026-10-06 against `Flora-Alchemy`. Metadata-only findings.

### No `isFixture` documents remain in production

`isFixture` is the internal fixture/audit flag (see AGENTS.md). Production now holds
**zero** documents with `isFixture: true` in any collection.

The last one was the **legacy settings singleton** (`key: 'default'`, no `workspaceId`,
created 2026-09-08). It carried the flag by accident: `models/Settings.js` declares
`isFixture: { default: true }`, and `legacySettings()` auto-creates the singleton via
`Settings.create({ key: 'default' })` without passing the field, so the schema default
applied. Workspace-scoped settings never had this problem because `workspaceSettings()`
explicitly passes `isFixture: false`.

- **Runtime impact: none.** No query filters `Settings` by `isFixture` and no code deletes
  by that flag, so the value was inert metadata.
- **Corrected** with a guarded, single-field, idempotent update (`$set: { isFixture: false }`).
  Only `isFixture` and `updatedAt` changed; shipping, commerce, notification and gift
  configuration were verified byte-identical before and after.
- **The schema default is unchanged.** A future cleanup may flip `Settings.isFixture` to
  `default: false` (a source change — require the full suite); until then the only affected
  document is the singleton already corrected.

### `isFixture` is still public in product/settings payloads

The public product and settings projections still include `isFixture`, so the storefront
receives an internal audit flag it never uses. It is now always `false` (harmless), but the
cleaner shape is to drop it from those projections the way `customerOrderView()` already
drops it from customer order payloads. Future projection cleanup, not a correctness issue.

### Parked custom domains

`floraalchemy.com` and `www.floraalchemy.com` are registered but parked — they do not serve
the storefront and are deliberately **not** in `CORS_ORIGIN`. Add them only after the domain
actually serves the storefront; until then a browser request from them is rejected by design.

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
- **A browser preflight returning HTTP 500 is the normal rejection signature** — the
origin is most likely simply not in the allowlist. See
[CORS Configuration (Production)](#cors-configuration-production) before changing anything.
- Confirm the origin you are browsing from: a per-deployment Vercel URL
(`<project>-<hash>-<team>.vercel.app`) is **expected** to be rejected — browse the
canonical project domain instead.
- To allow a new origin, add it to the comma-separated `CORS_ORIGIN` value in the Render
  dashboard and redeploy. Never add `*`, `localhost`, or a preview URL to the production value.

### Image Uploads Fail

Read the error `code`, not just the message — the private studios now distinguish the
failure instead of collapsing every case into `500 INTERNAL_ERROR`:

| `code` | HTTP | Meaning | Fix |
|---|---|---|---|
| `STORAGE_NOT_WRITABLE` | 503 | root exists, write refused (EACCES/EPERM/EROFS) | mount/permissions on the disk path |
| `STORAGE_MISSING` | 503 | root cannot be created (ENOENT) | check the mount is attached, then `REFERENCE_MEDIA_DIR` / `THREE_MEDIA_ROOT` |
| `STORAGE_FULL` | 503 | ENOSPC/EDQUOT | resize the disk, or remove abandoned drafts |
| `STORAGE_EXHAUSTED` | 503 | EMFILE/ENFILE | too many concurrent uploads for the process limit |
| `STORAGE_UNAVAILABLE` | 503 | EIO or unmapped `fs` error | the volume is failing — check the platform's disk status |
| `ORIGINAL_MISSING` | 409 | the row exists but its original file is gone | bytes lost to an ephemeral filesystem — re-upload; see [Private media](#private-media-reference-images--3d-models) |
| `ORIGINAL_IMMUTABLE` | 409 | a second write to an existing original | expected; delete and re-upload instead |
| `INVALID_IMAGE` / `IMAGE_TOO_LARGE` | 400/413 | decode or size limit | check the file, not the server |

Product images (`/api/uploads`) are a different path: those are **public** and use
ImageKit (or `UPLOAD_DIR`) — a failure there is a credentials/config problem.
