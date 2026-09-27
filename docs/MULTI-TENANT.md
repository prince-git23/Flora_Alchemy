# Flora Alchemy — Multi-Tenant (Workspace) Architecture

> **Status: Phase 22.3 (operational tenant isolation) landed.** Every
> staff-facing route is gated at the router and every operational query is
> workspace-filtered; a two-workspace matrix suite proves isolation. This is
> **still not full multi-tenancy**: no `Workspace` document exists in any real
> database, onboarding/workspace UI is Phase 22.4, and the data backfill +
> composite indexes are Phase 22.5.
>
> Related: [DATABASE.md](./DATABASE.md), [ARCHITECTURE.md](./ARCHITECTURE.md),
> [API.md](./API.md), [MEMORY.md](./MEMORY.md).

---

## 1. The one-sentence version

Flora Alchemy is **one shop with many portals** today and becomes **many shops
(workspaces), each with its own portals**; Phase 22.2 built the foundation and
Phase 22.3 switched the server-side isolation on — invisibly, because no real
database contains a workspace yet.

---

## 2. CURRENT state (what is true right now)

| Aspect | Reality today |
|---|---|
| Workspaces in the database | **Zero** in dev/production. Tests create their own fixtures in dedicated `Flora-Alchemy-Test-*` databases. |
| Router gates | All 14 staff-facing routers mount a workspace gate (`requireWorkspace` / `requireWorkspaceForStaff` / `requireWorkspaceOrOwner` / `requireWorkspaceOrOwnerForStaff`). Customer and public routes deliberately do not. |
| Read/write paths | Operational controllers filter by `workspaceId` (orders, products, collections, inventory, movements, analytics, settings, conversations, custom requests, staff directory, operators, invitations, notifications). |
| Tenant authority | `req.user.workspaceId` re-read from the DB by `protect` on every request. Body/query `workspaceId` is scrubbed globally before any controller runs. |
| Customers | **Global identities with a RELATIONSHIP rule**: staff see only customers linked to their workspace through an order, conversation or custom request; unrelated → `404`. |
| Legacy rows | **Legacy-inclusive**: unattributed documents (`workspaceId` absent) stay visible to every workspace via `{ workspaceId: { $in: [id, null] } }` until the Phase 22.5 backfill. |
| Compat mode | A platform with **zero** Workspace documents lets unscoped staff through the gates (`req.workspaceCompat=true`), so single-workspace behaviour stays byte-for-byte unchanged. Once one workspace exists, unscoped staff fail closed with `403 WORKSPACE_REQUIRED`. |
| Settings | Per-workspace document keyed by `workspaceSlug` (cloned from the singleton on first staff write); the `key: 'default'` singleton remains the public/platform document. |
| Slugs | `Product.slug` / `Collection.slug` / `Inventory.productSlug` stay **globally unique** (composite `{ workspaceId, slug }` is Phase 22.5). |
| Owner / customer identities | **Unscoped by design** — owner passes §19 governance surfaces only; on operational surfaces it gets `403 WORKSPACE_REQUIRED`. |

---

## 3. WHAT PHASE 22.2 ADDED (the tenant core)

| Piece | File | Behaviour |
|---|---|---|
| **Workspace entity** | `backend/models/Workspace.js` | `slug` (unique, normalised), `displayName` (required, never auto-derived), `status` (`ACTIVE`/`SUSPENDED`/`PENDING`), `primaryAdminId`, timestamps, `toJSON → id`. |
| **Membership field** | `User.workspaceId` + 11 other models | ObjectId → `Workspace`, **sparse index**, **no default**: absent = unscoped. |
| **Tenancy helpers** | `backend/utils/tenancy.js` | `getWorkspaceId`, `workspaceScope`, `requestScope`, `workspaceIdScope`, `workspaceFilter` (fails closed → `403 WORKSPACE_REQUIRED`), `assertWorkspaceMember` (`403 WORKSPACE_MISMATCH`). |
| **Middleware** | `backend/middleware/workspaceMiddleware.js` | `stripClientWorkspaceId` (mounted globally) + the four gates. |
| **Body/query scrub** | `backend/server.js` | Runs after `express.json` (and after multer on the upload route): a client-supplied `workspaceId` / `workspace_id` is deleted from body, nested objects/arrays and query string before any controller runs. |
| **Server-side binding** | `staffInvitationController` | A handler invitation is stamped with the **inviter's** workspace — never the request body's. |
| **Activation inheritance** | `invitationController` | Activating a **handler** invitation assigns `Invitation.workspaceId` to the new `User`; an **admin** activation never does. |
| **Migration script** | `backend/scripts/backfill-workspaces.mjs` | `--report` (read-only) / `--apply` (guarded: explicit `--name` **and** `--slug`, refuses production). |
| **Tenant audit tool** | `backend/scripts/tenant-audit.mjs` + `scripts/lib/tenantAudit.mjs` | Read-only scanner over a scope manifest; `--json`, `--strict`. |
| **Test suite** | `backend/scripts/tenant-core-smoke.mjs` (`npm run test:tenant`) | 110 checks: entity / membership / helpers / gates / injection / binding / regression / migration / audit. |

---

## 4. WHAT PHASE 22.3 ADDED (operational isolation)

### The four gates (`backend/middleware/workspaceMiddleware.js`)

| Gate | Members | Owner (§19) | Customers | Unscoped staff (zero-workspace platform) | Unscoped staff (≥1 workspace) |
|---|---|---|---|---|---|
| `requireWorkspace` | ✔ `req.workspaceId` | ✘ `403 WORKSPACE_REQUIRED` | ✘ `403 WORKSPACE_FORBIDDEN` | ✔ `req.workspaceCompat=true` | ✘ `403 WORKSPACE_REQUIRED` |
| `requireWorkspaceForStaff` | ✔ | ✘ `403 WORKSPACE_REQUIRED` | ✘ (guard) | ✔ compat | ✘ `403 WORKSPACE_REQUIRED` |
| `requireWorkspaceOrOwner` | ✔ | ✔ **unscoped platform scope** | ✘ | ✔ compat | ✘ `403 WORKSPACE_REQUIRED` |
| `requireWorkspaceOrOwnerForStaff` | ✔ | ✔ platform scope | ✘ (guard) | ✔ compat | ✘ `403 WORKSPACE_REQUIRED` |

Every gate re-reads the workspace per request: `SUSPENDED` →
`403 WORKSPACE_SUSPENDED` immediately (no token caching). Mounted order on the
protected routers: `protect` → role gate → workspace gate → controller.

### Where the gates are mounted

| Router | Gate |
|---|---|
| `productRoutes`, `collectionRoutes` (writes) | `requireWorkspace` — public GETs stay open (storefront + `catalogueContext` read-scoping) |
| `orderRoutes` | `requireWorkspace` (list/staff-create/status), `requireWorkspaceForStaff` (detail); customer `/mine`, `POST /` untouched |
| `inventoryRoutes`, `analyticsRoutes` | `requireWorkspace` (router-level) |
| `customerRoutes` (list) | `requireWorkspace`; detail/update → `requireWorkspaceForStaff`; `/me` untouched |
| `conversationRoutes` | `requireWorkspaceOrOwnerForStaff` (unread), `requireWorkspaceForStaff` (order/messages/read), `requireWorkspace` (list/status); `/mine` untouched |
| `customRequestRoutes` (staff list/status) | `requireWorkspace`; customer paths untouched |
| `settingsRoutes` (PATCH) | `requireWorkspaceOrOwner` (owner patches the platform singleton) |
| `staffRoutes`, `staffInvitationRoutes`, `adminUserRoutes` | `requireWorkspaceOrOwner` (router-level; owner keeps §19 platform governance) |
| `notificationRoutes` | `requireWorkspaceOrOwnerForStaff` (router-level) |
| `uploadRoutes` | `requireWorkspace` **before multer** (no disk writes for refused requests) |

`server.js` itself never mounts a gate — it only hosts the global scrub.

### Scoping rules in the controllers/services

- **Operational queries** carry `{ workspaceId: { $in: [id, null] } }` as a
  **single key** (composes with `$or`, matches missing legacy rows).
- **Server-derived attribution**: order/inventory/conversation/notification/invitation
  workspace comes from the caller (or the parent document), never the body.
- **Customers**: relationship rule (see §2); empty scope (compat/owner) = full list.
- **Notifications**: creation narrowed by the source document's workspace; reads
  carry the caller's scope, so a foreign-workspace notification addressed to me
  is hidden; owner elevation writes `workspaceId: null`.
- **Settings**: staff read their own workspace document (fallback: singleton);
  owner read/write hits the singleton only.
- **Inventory**: `adjustStock` includes the scope in the atomic filter →
  cross-workspace adjust → `404`; overdraw → `409 INSUFFICIENT_STOCK` (never
  negative). Order-driven deductions use the **order's** workspace.
- **Analytics**: first `$match` is scoped; every number equals the caller's own.
- **Uploads**: local filenames and ImageKit folders are prefixed with the
  workspace slug (`<slug>-product-…`, `…/workspaces/<slug>/…`).
- **Catalogue context** (`backend/utils/catalogueContext.js`): a member's
  workspace must exist and be `ACTIVE`; unscoped staff degrade to the public
  view once any workspace exists (membership is mandatory then).

### Deliberately global (documented exceptions)

FA-#### sequence scan, slug/email duplicate checks, invitation
pending-consumption guard, last-admin guards, TTL sweeps, public storefront
reads, order→product/order→inventory resolution, and Message reads keyed by a
workspace-checked `conversationId`.

### Frontend

`AdminRoute` redirects an **owner** session off operational admin paths
(`/admin/orders|products|collections|customers|conversations|custom-requests|inventory|analytics`)
to `/owner/dashboard`; governance surfaces (`/admin/staff`, `/admin/invitations`,
… ) remain reachable.

### Proof

- `node scripts/tenant-audit.mjs --strict` → **PASS**: operational 0 unscoped,
  customer 0 unscoped; the 13 identity sites in `invitationController` are
  expected `partly-scoped` (token/activation flow, ownership-checked).
- `npm run test:tenant-matrix` (`scripts/tenant-matrix-smoke.mjs`) → **187
  checks** across two real workspaces (A/B): gates, disjoint lists, cross
  read/write → 404, relationship visibility, notification belt, per-workspace
  settings/analytics, uploads, three race proofs (inventory overdraw, cross-
  tenant write, invitation-token reuse), suspension mid-request, public
  regression.
- Full suite: **1182 passed / 0 failed** across 15 suites.

---

## 5. What is deliberately NOT done (limits of 22.3)

- **No workspace exists in dev/production** — real isolation activates only
  when the owner creates/backfills one (Phases 22.4/22.5). Until then every
  database runs in compat mode and behaves exactly like Phase 21.
- **Customer orders carry no workspace attribution** (the order document is
  stamped; customer identity itself is global by design).
- **Legacy rows stay visible to all workspaces** (`$in [id, null]`) until the
  22.5 backfill; this is a migration window, not the end state.
- **Slugs stay globally unique** — composite `{ workspaceId, slug }` indexes
  are Phase 22.5.
- **`invitationController` remains `partly-scoped`** (13 identity sites are
  token/activation lookups guarded by invitation state + ownership, not a
  workspace filter).
- The migration's `--apply` mode has **never been run against real data**.

---

## 6. Plan

| Phase | Scope |
|---|---|
| **22.2 (done)** | Tenant core: entity, membership, helpers, middleware, scrub, binding rules, report-only migration, audit tool, tests, docs. |
| **22.3 (done)** | Operational scoping: four gates mounted on all staff routers, controllers/services scoped, notification + directory hot spots closed, owner §18/§19 split, per-workspace settings/analytics, upload namespacing, `--strict` audit, two-workspace matrix proof. |
| **22.4** | Onboarding + portal UI: create a workspace when an administrator is activated, workspace switcher/labels in the owner portal, invitation flows showing workspace context. |
| **22.5** | Migration + hardening: run `backfill-workspaces --apply` with an owner-supplied name/slug, composite `{ workspaceId, slug }` indexes, tenant-audit `--strict` in CI, tight legacy visibility (drop the `$in null` branch). |

---

## 7. Operating the tooling

```bash
# From backend/

# Read-only migration report (safe against ANY database, including production)
node scripts/backfill-workspaces.mjs --report
node scripts/backfill-workspaces.mjs --report --slug flora-alchemy   # + slug availability

# Guarded migration (Phase 22.5; refuses production, requires explicit name+slug)
node scripts/backfill-workspaces.mjs --apply --name "Flora Alchemy" --slug flora-alchemy

# Tenant-discipline audit (read-only); --strict is the gate
node scripts/tenant-audit.mjs
node scripts/tenant-audit.mjs --json
node scripts/tenant-audit.mjs --strict

# Tenant foundation suite (Flora-Alchemy-Test-TenantCore database)
npm run test:tenant

# Two-workspace cross-tenant matrix (Flora-Alchemy-Test-TenantMatrix database)
npm run test:tenant-matrix
```

**Safety properties worth knowing:**

- `--report` performs **zero writes**; the suite asserts collection counts are
  byte-identical before and after a report run.
- `--apply` refuses a database listed in `PRODUCTION_DB_NAMES` **before it even
  connects**, and refuses to invent a `displayName` or `slug`.
- Nothing in the codebase creates a workspace implicitly.
- Both tenant suites boot their own server on their own port (4103/4104) against
  a dedicated, dropped-and-recreated test database.

---

## 8. Invariants (do not break)

1. `workspaceId` is **server-assigned only** — the scrub runs before every controller.
2. Membership is **sparse**: *absent* means unscoped; it is never stored as `null` on `User`.
3. Owner and customer identities are **never** workspace members; the owner gets
   §19 governance surfaces with an unscoped platform scope and `403` on §18
   operational surfaces.
4. Helpers **fail closed** (`workspaceFilter` throws rather than widening the query).
5. The gates re-read the workspace per request — a suspended tenant stops immediately
   (`403 WORKSPACE_SUSPENDED`), and its staff catalogue degrades to the public view.
6. Adding workspace scoping must **never** relax the existing role, ownership or 404 rules.
7. Compat mode exists only while the platform has **zero** workspaces; the moment one
   exists, unscoped staff fail closed — never widen the gate back.
8. Legacy-inclusive scope (`$in [id, null]`) is a **migration window**: keep it a
   single key, and remove it in Phase 22.5 — not before.
9. Do not claim **production** multi-tenancy until the Phase 22.5 backfill has run
   against real data.
