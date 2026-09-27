# Flora Alchemy — Multi-Tenant (Workspace) Architecture

> **Status: Phase 22.5 (migration + hardening) landed.** Every staff-facing
> route is gated at the router, every operational query is **strictly**
> workspace-filtered (`{ workspaceId }` — the legacy `$in [id, null]` window is
> gone), and an approved administrator activation provisions the first real
> `Workspace` (atomically with the admin account + its settings). The existing
> legacy data has been migrated to the production workspace, composite
> `{ workspaceId, … }` indexes are declared and built, the public
> `GET /api/shops/:slug` now resolves a workspace's own **catalogue**
> (`/products`, `/collections`, `/settings`), and wishlist rows are
> workspace-scoped. See §10.
>
> Related: [DATABASE.md](./DATABASE.md), [ARCHITECTURE.md](./ARCHITECTURE.md),
> [API.md](./API.md), [MEMORY.md](./MEMORY.md).

---

## 1. The one-sentence version

Flora Alchemy is **one shop with many portals** today and becomes **many shops
(workspaces), each with its own portals**; Phase 22.2 built the foundation,
Phase 22.3 switched the server-side isolation on, and Phase 22.4 taught the
platform to create its first workspace when an approved administrator
activates — invisible until a real invitation is consumed.

---

## 2. CURRENT state (what is true right now)

| Aspect | Reality today |
|---|---|
| Workspaces in the database | **Real and migrated (Phase 22.5).** An approved administrator activation provisions a `Workspace` in the same transaction (Phase 22.4); the guarded `backfill-workspaces.mjs --apply` created the production workspace (`slug=flora-alchemy`, `status=ACTIVE`) and attached every legacy row to it. Tests create their own fixtures in dedicated `Flora-Alchemy-Test-*` databases. |
| Router gates | All 14 staff-facing routers mount a workspace gate (`requireWorkspace` / `requireWorkspaceForStaff` / `requireWorkspaceOrOwner` / `requireWorkspaceOrOwnerForStaff`). Customer and public routes deliberately do not. |
| Read/write paths | Operational controllers filter by `workspaceId` (orders, products, collections, inventory, movements, analytics, settings, conversations, custom requests, staff directory, operators, invitations, notifications). |
| Tenant authority | `req.user.workspaceId` re-read from the DB by `protect` on every request. Body/query `workspaceId` is scrubbed globally before any controller runs. |
| Customers | **Global identities with a RELATIONSHIP rule**: staff see only customers linked to their workspace through an order, conversation or custom request; unrelated → `404`. |
| Legacy rows | **Strictly scoped (Phase 22.5):** operational queries use `{ workspaceId }` with no `null` branch. The production backfill left **0 unscoped operational rows**; compat mode remains only for a zero-workspace platform, which no longer describes production. |
| Compat mode | A platform with **zero** Workspace documents lets unscoped staff through the gates (`req.workspaceCompat=true`), so single-workspace behaviour stays byte-for-byte unchanged. Once one workspace exists, unscoped staff fail closed with `403 WORKSPACE_REQUIRED`. |
| Settings | Per-workspace document keyed by `workspaceSlug` (cloned from the singleton on first staff write); the `key: 'default'` singleton remains the public/platform document. |
| Slugs | Uniqueness is **per workspace**: unique `{ workspaceId, slug }` on Product/Collection and `{ workspaceId, productSlug }` on Inventory (Phase 22.5), built by `ensure-workspace-indexes.mjs`. Settings uniqueness intentionally stays on the existing unique `key` index (key = slug). |
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
- Full suite: **1316 passed / 0 failed** across 16 suites (incl. the
  `admin-onboarding` suite, now 129 checks with storefront + wishlist tenancy).

---

## 5. WHAT PHASE 22.4 ADDED (onboarding + workspace activation)

The CRITICAL RULE: **an application is not an account, and a Workspace exists
only when an approved administrator invitation activates.** Nothing else in the
codebase creates a workspace implicitly.

### Public application intake → Owner review → invitation

| Step | Where | Detail |
|---|---|---|
| 1. Apply | `POST /api/admin-applications` (`AdminApplyPage.jsx` at `/apply/admin`) | New fields: `businessName` (2–120 chars) and optional `preferredSlug` (validated against `SLUG_RE`, shown as `/shops/<slug>`). Submission response returns `proposedSlug`. |
| 2. Duplicate slug | `adminApplicationController` | `preferredSlug` already taken by a Workspace → `409 SLUG_TAKEN` (field error; the application still succeeds if the slug is cleared). |
| 3. Owner review | `OwnerApplicationsPage` dossier | Business name + proposed address shown; **Approve & Issue Invitation** stamps `Invitation.workspaceName` / `Invitation.workspaceSlug` (from `proposedSlug`, else slugified business name/email) and writes `AdminApplication.approvedWorkspaceSlug`. |
| 4. One-time link | `AdminActivatePage` at `/admin/activate/:token` | Role=admin activation shows "Workspace to be provisioned" from the invitation landing (`workspaceName`/`workspaceSlug`) and an editable **workspace address** field (prefilled, `/shops/` prefix, `SLUG_RE`); handler activations never see it. |

### Activation = one transaction (`services/workspaceProvisioningService.js`)

`POST /api/invitations/:token/activate` for an **admin** invitation now runs, in a
single MongoDB transaction (retry on `TransientTransactionError`):

1. consume the invitation (single-use token, INVITED→ACCEPTED, no reuse),
2. create the `User` with `role: 'admin'`, `workspaceId` bound,
3. create the `Workspace` (`slug` = body `workspaceSlug` → invitation
   `workspaceSlug` → application `proposedSlug` → slugify(displayName) →
   slugify(email); `status: ACTIVE`, `primaryAdminId` = new user),
4. create the per-workspace `Settings` document cloned from the platform
   singleton (same transaction, so an admin never sees empty settings),
5. mark the application `APPROVED`/`provisionedWorkspaceSlug` if present.

Failure codes (invitation stays `INVITED`, nothing persisted):

| Code | HTTP | Meaning |
|---|---|---|
| `WORKSPACE_SLUG_TAKEN` | 409 | Slug belongs to another workspace → client re-prompts on the address field. |
| `EMAIL_TAKEN` | 409 | An account already exists for that email. |
| `INVALID_SLUG` | 422 | Body slug fails `SLUG_RE`. |
| `SLUG_TAKEN` | 409 | Submission-time duplicate (application intake only). |

Handler activation is unchanged: it **inherits** `Invitation.workspaceId` and
never creates a workspace (`finishActivation` in `invitationController`).

### Session + portal context

- `authController` (login/me) returns `workspace: { id, slug, name, status }`
  (or `null`) — authorization still comes from the DB role/workspace re-read
  per request; the claim is display-only.
- `AdminSidebar` shows a workspace badge (name + `/slug`) for signed-in staff
  and, for the **owner**, trims navigation to **OWNER GOVERNANCE** + **ADMINISTRATION**
  (Settings relabelled "Platform Settings").
- `OwnerAdministratorsPage` gains a **Business / Workspace** column, dossier
  meta (Business / Workspace / Application) and a "View source application"
  link → `/owner/applications?id=<applicationId>`.
- `AdminApplicationsPage` shows business name + proposed slug in the ledger and
  the dossier.

### Public workspace address

- `GET /api/shops/:slug` (`routes/shopRoutes.js`, no auth) → `200
  { success, shop: { slug, displayName } }` or `404 SHOP_NOT_FOUND`; only
  `ACTIVE` workspaces resolve. It is **not** in the public read cache.
- Frontend `/shops/:workspaceSlug` → `ShopWorkspaceGate` (loading / 404 →
  `NotFoundPage` / error → retry) renders `ShopWorkspacePage` via route
  `Outlet` context; `/shops` redirects to `/`. Both routes are **light** in
  `routeDataRequirements.js` (critical: `[]`); catalogue-per-shop hydration is
  explicitly Phase 22.5 (`DataContext` §20 note).

### Proof

- `npm run test:onboarding` (`scripts/admin-onboarding-smoke.mjs`, port 4105,
  `Flora-Alchemy-Test-AdminOnboarding`) → **110 checks / 0 failed**: two
  independent workspaces provisioned from two approved applications end-to-end,
  slug precedence + duplicate-slug handling, transaction rollback (no partial
  workspace/account/settings), invitation single-use, handler non-provisioning,
  public directory 200/404, owner directory enrichment + application linkage.
- Full suite: **1316 passed / 0 failed** across 16 suites.
- `node scripts/tenant-audit.mjs --strict` → exit 0 (×2) after the changes.

---

## 6. What remains deliberate (limits after 22.5)

- **Customer and owner identities stay global** — `User.workspaceId` is absent
  for them by design; ownership and customer records are platform-level.
- **`invitationController` remains `partly-scoped`** (13 identity sites are
  token/activation lookups guarded by invitation state + ownership, not a
  workspace filter). This is intentional, not unfinished.
- **Settings uniqueness stays on the existing unique `key` index** (key = slug).
  A same-key unique `{ workspaceId, key }` would conflict with the platform
  singleton, so composite uniqueness is only declared where it cannot collide.
- **`/shops/<slug>` is public and read-only** — no cart, no checkout, no
  authentication. It renders only the resolved workspace's visible catalogue and
  the public settings slice; it is never a staff or write surface.
- **Compat mode** still exists for a zero-workspace platform, but the
  production database now has its workspace, so it no longer applies there.

---

## 7. Plan

| Phase | Scope |
|---|---|
| **22.2 (done)** | Tenant core: entity, membership, helpers, middleware, scrub, binding rules, report-only migration, audit tool, tests, docs. |
| **22.3 (done)** | Operational scoping: four gates mounted on all staff routers, controllers/services scoped, notification + directory hot spots closed, owner §18/§19 split, per-workspace settings/analytics, upload namespacing, `--strict` audit, two-workspace matrix proof. |
| **22.4 (done)** | Onboarding + activation: business name/slug on the application, Owner-only approval, atomic Workspace+Admin+Settings provisioning at activation, owner portal governance trim, administrators directory/dossier upgrade, public `GET /api/shops/:slug` + `/shops/:slug`, isolated two-workspace onboarding suite. |
| **22.5 (done)** | Migration + hardening: production workspace migrated (`backfill-workspaces.mjs --apply`), composite `{ workspaceId, … }` + unique `{ workspaceId, slug }` indexes (`ensure-workspace-indexes.mjs`), strict legacy visibility (`$in null` removed), wishlist `(customerId, workspaceId)` tenancy (`attach-wishlist-workspaces.mjs`), per-shop catalogue hydration (`/shops/:slug` + `/products` `/collections` `/settings`), client cart/checkout/storage tenant namespacing. |

---

## 8. Operating the tooling

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

# Client admin onboarding + workspace activation (Flora-Alchemy-Test-AdminOnboarding)
npm run test:onboarding
```

**Safety properties worth knowing:**

- `--report` performs **zero writes**; the suite asserts collection counts are
  byte-identical before and after a report run.
- `--apply` refuses a database listed in `PRODUCTION_DB_NAMES` **before it even
  connects**, and refuses to invent a `displayName` or `slug`.
- The only implicit workspace creation is the **admin activation transaction**
  (`workspaceProvisioningService`) — and it only runs after a valid,
  single-use, Owner-approved invitation is consumed in the same transaction.
- The tenant + onboarding suites boot their own server on their own port
  (4103/4104/4105) against a dedicated, dropped-and-recreated test database.

---

## 9. Invariants (do not break)

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
8. Legacy-inclusive scope (`$in [id, null]`) is **removed** (Phase 22.5):
   operational queries carry a strict `{ workspaceId }`. Do not reintroduce the
   `null` branch — it would re-widen tenancy.
9. Do not claim **production** multi-tenancy until the Phase 22.5 backfill has run
   against real data.
10. A `Workspace` is created in **exactly one place**: the admin-invitation
    activation transaction (`workspaceProvisioningService`), after the
    single-use invitation is consumed — never from a request body, never
    implicitly, and always with its admin + settings in the same transaction.
11. The public shop surface resolves only `ACTIVE` workspaces and exposes only
    public data: identity (`{ slug, displayName }`), the workspace's **visible**
    products and collections, and a whitelisted settings slice. It never exposes
    inventory quantities, reorder levels, staff, customers, counts or the
    existence of non-active statuses (`404`). The slug is a lookup key, never an
    authorization grant.

---

## 10. What Phase 22.5 added (migration + hardening)

**Migration (production).** `backfill-workspaces.mjs --apply` created the
production `Workspace` (`slug=flora-alchemy`, `status=ACTIVE`,
`primaryAdminId=null`, `isFixture=false`) and attached every legacy operational
row to it in one pass: products, collections, orders, inventories, inventory
movements, conversations, custom requests, staff events and notifications.
After the run, **0 unscoped operational rows** remain. The script refuses
production unless both `PRODUCTION_DB_NAMES` and
`CONFIRM_DATABASE_UNSAFE_OPERATION=<dbname>` (plus
`WORKSPACE_MIGRATION_CONFIRM=APPLY_PRODUCTION_WORKSPACE_MIGRATION`) are set, and
it refuses to run on a database that already has a workspace.

**Composite indexes.** Every tenanted model declares a composite
`{ workspaceId, … }` index and, where a slug is the public id, a **unique**
`{ workspaceId, slug }` (Product, Collection) / `{ workspaceId, productSlug }`
(Inventory). Performance indexes cover orders, conversations, custom requests,
invitations, staff events, notifications and users.
`scripts/ensure-workspace-indexes.mjs` builds and verifies them (report / apply,
duplicate detection before write, `autoIndex=false`, wishlist legacy-index
drop). Settings uniqueness stays on the existing unique `key` index (key = slug).

**Strict scope.** `utils/tenancy.js`, `workspaceMiddleware.js`,
`req.workspaceScope` and `inventoryService` use strictly `{ workspaceId }`; the
legacy `$in [id, null]` branch is gone. Owner/customer/compat paths stay
deliberately unscoped.

**Wishlist tenancy.** `Wishlist` is now unique on `(customerId, workspaceId)`
with nullable `workspaceId`; `wishlistController` resolves the workspace
server-side from `?shop=<slug>` (or the single ACTIVE workspace) and scopes
product lookups. `scripts/attach-wishlist-workspaces.mjs` migrated the existing
rows (legacy unique `customerId_1` dropped; 0 duplicates). The frontend sends
`?shop=` and namespaces its cart.

**Public storefront.** `GET /api/shops/:slug` (+ `/products`, `/collections`,
`/settings`) resolves the ACTIVE workspace by slug and returns **public-safe**
projections: no stock/reorder levels (only `inStock`/`availability`), only
visible products/collections, and a whitelisted settings slice. Unknown,
malformed, reserved and suspended slugs all answer the same `404 SHOP_NOT_FOUND`.
`/shops/:workspaceSlug` (`ShopWorkspacePage`) hydrates this real catalogue.

**Client tenancy.** `frontend/src/services/tenantContext.js` (navigation
context only — never authorization) plus `ShopWorkspaceGate` set/clear the active
tenant; `StoreContext` reloads cart + wishlist on tenant switch; the cart key is
namespaced (`flora_alchemy_cart::<tenant>`); the checkout sessionStorage
snapshot and the storage keys are namespaced. No secret is ever stored
client-side.

**Known limitation — no frontend automated test runner.** This repo has no
browser test framework. Cart/checkout/cache tenancy is covered by code review
plus the API-driven suites (Admin Onboarding §F2/§F3); the responsive harness is
layout-only and its synthetic input does not reach React handlers.
