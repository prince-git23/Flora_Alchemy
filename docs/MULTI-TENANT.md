# Flora Alchemy — Multi-Tenant (Workspace) Architecture

> **Status: Phase 22.5 (migration + hardening) landed.** Every staff-facing
> route is gated at the router, every operational query is **strictly**
> workspace-filtered (`{ workspaceId }` — the legacy `$in [id, null]` window is
> gone), and an approved administrator activation provisions the first real
> `Workspace` (atomically with the admin account + its settings). The existing
> legacy data has been migrated to the production workspace, composite
> `{ workspaceId, … }` indexes are declared and built, the public
> `GET /api/shops/:slug` now resolves a workspace's own **catalogue**
> (`/products`, `/collections`, `/settings`), and wishlist rows were
> workspace-scoped. See §10.
>
> **Phase 1 (§11) and Phase 2 (§12) have since landed.** Shop identity is the
> public attribution contract; the wishlist is global per customer again; and
> custom requests, proposals, orders and conversations each carry one
> authoritative Workspace that is never derived from browser tenant state.
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
| Customers | **Global identities with a RELATIONSHIP rule**: staff see only customers linked to their workspace through an order, conversation or custom request; unrelated → `404`. **Phase 2:** staff operational endpoints are read-only for the global profile — a protected write (`name`, `phone`, `addresses`, `preferences`, `city`, `state`, `status`, `email`) answers `403 CUSTOMER_PROFILE_PROTECTED`, while the customer's own self-service edit path is unchanged. |
| Wishlist | **Global per customer (Phase 2).** Ownership is the authenticated `customerId` alone; a legacy `workspaceId` on old rows is ignored for reads and writes, and browsing `/shops/:slug` never switches the wishlist. |
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
| **Phase 1 (done)** | Marketplace identity + shop directory + public catalogue hardening (architecture, **not** a visual redesign). See §11. |
| **Phase 2 (done)** | Shop-owned services + customer relationships: global customer identity hardening, global wishlist + guarded merge migration, Custom Request destination rules (product-derived lock vs. standalone ACTIVE `shopSlug`), proposal/order/conversation Workspace inheritance, notification routing, Custom Gift fulfilment Shop. See §12. |

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

# Phase 2 focused suite (Flora-Alchemy-Test-ShopServices; own server on 4113)
npm run test:shop-services

# Global wishlist migration — DRY-RUN by default; --apply writes
node scripts/merge-wishlists-global.mjs
node scripts/merge-wishlists-global.mjs --apply

# Phase 3 focused suite (Flora-Alchemy-Test-Checkout; own server on 4114,
# mock Razorpay on 4128)
npm run test:checkout

# Legacy-order consistency report — READ-ONLY, report only (no --apply exists)
node scripts/order-consistency-report.mjs
```

**Safety properties worth knowing:**

- `--report` performs **zero writes**; the suite asserts collection counts are
  byte-identical before and after a report run.
- `--apply` refuses a database listed in `PRODUCTION_DB_NAMES` **before it even
  connects**, and refuses to invent a `displayName` or `slug`.
- `merge-wishlists-global.mjs` is **DRY-RUN by default**: it refuses a
  production database unless `CONFIRM_DATABASE_UNSAFE_OPERATION=<dbName>` **and**
  `WISHLIST_MIGRATION_CONFIRM=APPLY_PRODUCTION_WISHLIST_MERGE` are set, reports
  ambiguous rows instead of guessing, and is idempotent. **It has never been run
  against production.**
- The only implicit workspace creation is the **admin activation transaction**
  (`workspaceProvisioningService`) — and it only runs after a valid,
  single-use, Owner-approved invitation is consumed in the same transaction.
- The tenant + onboarding suites boot their own server on their own port
  (4103/4104/4105) against a dedicated, dropped-and-recreated test database.
- `order-consistency-report.mjs` is **read-only by construction**: it has no
  `--apply` and only classifies orders as `VALID`/`AMBIGUOUS`/`INVALID`. Legacy
  orders were never migrated automatically — an operator must read the report
  first, and ownership must be provable before anything is written.

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
12. **(Phase 1)** The canonical bootstrap Workspace is claimed ONLY by the
    canonical business identity (`isCanonicalBootstrapIdentity`) and only while
    unclaimed — never by "first administrator wins", never twice.
13. **(Phase 1)** `utils/publicShop.js` owns the public projection. Never
    hand-roll a shop/product serializer: `workspaceId` is stripped, `shop` is
    `{ slug, displayName }`, and a suspended/pending/deleted workspace makes the
    row non-public (excluded + `404`). Attribution is resolved **live** after the
    cache so a suspension is never masked.
14. **(Phase 1)** The owner governs Shop **lifecycle** only (list/suspend/
    reactivate). It is never a workspace member and must not gain inventory,
    order or catalogue access.
15. **(Phase 2)** Customer identity is global and **never** tenant-scoped — no
    `CustomerWorkspace`/`ShopCustomer` record exists. Staff relationship access
    is read-mostly: the global profile fields are writable by the customer
    alone (`403 CUSTOMER_PROFILE_PROTECTED` for a staff write), and the
    relationship check runs before any field decision, so unrelated staff read
    a plain `404`.
16. **(Phase 2)** The wishlist is global per customer: authority is the
    authenticated `customerId` only. Shop/storefront context is discovery UX and
    never decides which wishlist is read or written; `workspaceId` is never
    exposed in the payload.
17. **(Phase 2)** Every Custom Request has exactly one authoritative Workspace.
    Product-originated → `Product.workspaceId` (a contradicting client
    `shopSlug` answers `409 SHOP_MISMATCH` and creates nothing); standalone →
    resolved from an ACTIVE `shopSlug` (`422 SHOP_REQUIRED` / `SHOP_NOT_FOUND`).
    Proposal, order, conversation and notifications inherit that Workspace.
18. **(Phase 2)** A Conversation's Workspace ALWAYS comes from
    `Order.workspaceId` — never from `getWorkspaceId(user)`; customers have no
    workspace. `Message` carries no `workspaceId`; it is authorized through the
    conversation.
19. **(Phase 3)** The customer bag is **global**, never Shop-scoped: one storage
    key (`flora_alchemy_cart`) for every shop, guest and authenticated alike.
    Visiting, switching or leaving a Shop must not change bag contents. Legacy
    `flora_alchemy_cart::<tenant>` keys are merged once, de-duplicated, and
    removed.
20. **(Phase 3)** One checkout may contain products from **exactly one**
    Workspace. A bag spanning two Shops is never silently merged, never
    partially charged and never split: checkout is entered per Shop group
    (`/checkout?shop=<slug>`) and a mixed submission is refused with
    `409 MIXED_WORKSPACE_ORDER` before any Order, invoice or stock write.
21. **(Phase 3)** `Order.workspaceId` is **server-derived** — from the
    authoritative `Product.workspaceId` of its items (customer path) or from the
    authenticated staff member's own Workspace (staff path). A body/query
    `workspaceId` is scrubbed globally and can never select the tenant; a
    contradicting `shopSlug` answers `409 SHOP_MISMATCH`.
22. **(Phase 3)** Every catalogue item in an Order belongs to
    `Order.workspaceId`. `services/orderDestinationService.js` is the ONLY place
    an order's destination is decided; `services/orderService.js` re-asserts the
    ownership match before writing (`500 ORDER_WORKSPACE_MISMATCH` — reject and
    log, never silently repair).
23. **(Phase 3)** Catalogue pricing is **server-authoritative**: client
    `price`/`lineTotal`/`subtotal`/`shipping`/`total` are display-only. Line
    totals, shipping, shop tax and the total are recomputed from the stored
    Product and the order Workspace's Settings. Proposal and Custom Gift pricing
    keep their existing server-authoritative validation.
24. **(Phase 3)** Shop commerce rules are resolved from the **Order Workspace's**
    Settings document (workspace key, else the platform singleton): shipping
    configuration, payment methods, tax, minimum order value, maximum order
    items, acceptance (`acceptNewOrders`, `storeAvailability`). A Shop that is
    closed answers `409 ORDERS_CLOSED`; a suspended owner answers
    `422 SHOP_NOT_FOUND`.
25. **(Phase 3)** Inventory operations stay **Workspace-safe and atomic**:
    `adjustStock` keeps its single `findOneAndUpdate` guard and now proves
    ownership through the resolved Product/Workspace instead of trusting a
    bare `productSlug`. Concurrent buyers of the last unit still produce exactly
    one success.
26. **(Phase 3)** The payment amount is derived from the **stored server Order
    total** (integer paise). A client amount is never forwarded to the provider;
    a COD/Sample order can never be converted into a provider charge
    (`422 PAYMENT_METHOD_NOT_ALLOWED`), and signature verification remains
    order-bound and replay-safe.
27. **(Phase 3)** Cart clearing removes **only the purchased Shop group**. A
    settled payment (paid / COD / sample) leaves other Shops' lines untouched;
    a failed or pending payment clears nothing.
28. **(Phase 3)** Historical Orders stay **addressable after a Shop is
    suspended**: suspension stops discovery and new orders only. `Order.workspaceId`
    remains the authorization authority, `shopSnapshot {slug, displayName}`
    preserves the historical display name, and customer payloads expose `shop`
    without ever exposing `workspaceId`.

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
`?shop=` for wishlist reads. **Superseded in Phase 3:** the cart is no longer
tenant-namespaced — it is one global bag (§13).

**Public storefront.** `GET /api/shops/:slug` (+ `/products`, `/collections`,
`/settings`) resolves the ACTIVE workspace by slug and returns **public-safe**
projections: no stock/reorder levels (only `inStock`/`availability`), only
visible products/collections, and a whitelisted settings slice. Unknown,
malformed, reserved and suspended slugs all answer the same `404 SHOP_NOT_FOUND`.
`/shops/:workspaceSlug` (`ShopWorkspacePage`) hydrates this real catalogue.

**Client tenancy.** `frontend/src/services/tenantContext.js` (navigation
context only — never authorization) plus `ShopWorkspaceGate` set/clear the active
tenant; `StoreContext` reloads the **wishlist** on tenant switch. **Superseded in
Phase 3:** the cart is deliberately NOT namespaced any more — it is one global
bag, and a tenant switch must not touch it (§13). No secret is ever stored
client-side.

**Known limitation — no frontend automated test runner.** This repo has no
browser test framework. Cart/checkout/cache tenancy is covered by code review
plus the API-driven suites (Admin Onboarding §F2/§F3); the responsive harness is
layout-only and its synthetic input does not reach React handlers.
## 11. Phase 1 — marketplace identity and public catalogue hardening

Workspace remains the authoritative internal tenant. **Shop is the
customer-facing representation of a Workspace** and nothing else: there is no
Maker/Creator/Seller/Vendor/Merchant model, the Workspace is not replaced, and
no creator/payout/settlement concept is introduced. Slugs stay globally unique;
no slug migration is performed.

### 11.1 Bootstrap provisioning is gated on the approved business identity

**The rule:** the canonical Flora Alchemy bootstrap Workspace is reused ONLY by
an onboarding dossier that *is* the canonical Flora Alchemy business, and only
while it is still unclaimed.

Implementation — `services/workspaceProvisioningService.js`:

- `CANONICAL_BOOTSTRAP_SLUG` / `CANONICAL_BOOTSTRAP_NAME` — one definition of
  the canonical identity (no second source of truth).
- `isCanonicalBootstrapIdentity({ inv, application, suggestedSlug })` — true
  when the owner-approved slug **or** the owner-approved business name matches
  the canonical identity (normalised). Anything else, including a blank/derived
  identity, is **not** a claim.
- The claim additionally requires `isBootstrap: true`, `status: 'ACTIVE'`,
  `primaryAdminId: null` **and** `alreadyAttached === 0` (no non-owner
  administrator yet attached).

**Why the old rule was unsafe:** an ACTIVE unclaimed bootstrap could be reused
*before* the approved identity was resolved, so on a multi-creator marketplace
the first administrator to activate — whoever that was — inherited the canonical
business's Workspace. Under the new rule an unrelated first creator
("Asha Resin Studio", "Aurora Blooms") gets its **own** Workspace, and a claimed
bootstrap is never handed out again. Concurrent activations are safe: the
transaction plus the `alreadyAttached` count means exactly one claims it.

Slug collision is still a clean, retryable `409 WORKSPACE_SLUG_TAKEN`: the
transaction aborts, so **no** Workspace, User or Settings survives and the
invitation stays `INVITED`.

### 11.2 One canonical public Shop contract

`utils/publicShop.js` is the single source of the public projection:

- `publicShopIdentity(workspace)` → `{ slug, displayName }` — the **only** shop
  shape any public surface emits.
- `publicProduct(product, shop)` / `publicCollection(collection, shop)` — strip
  `workspaceId`, attach `shop` (or `null`).
- `activeShopMap(ids)` / `activeShopForId(id)` — resolve only `ACTIVE`
  workspaces, **live on every read** (never cached), so a suspension cannot be
  overridden by a cached result.
- `isPubliclyDiscoverable(doc, shopMap)` — a row with no `workspaceId` stays
  public (single-workspace compatibility); a row owned by a suspended, pending
  or deleted workspace is **excluded** and `404`s on direct lookup.

There is exactly one serializer: products, collections, the shop routes, the
wishlist and reviews all go through these helpers. The catalogue cache stores
only raw rows; attribution and the suspended-workspace exclusion run live
afterwards, with cache invalidation in the owner controller as a second belt.

### 11.3 Public surfaces

| Surface | Contract |
|---|---|
| `GET /api/shops` | **Shop directory** — `ACTIVE` only, deterministic (`displayName`, then `slug`), bounded to 200, rows are exactly `{ slug, displayName }` |
| `GET /api/shops/:slug` | Unchanged (`ACTIVE` only, otherwise `404 SHOP_NOT_FOUND`) |
| `GET /api/products` | `shop: { slug, displayName }`; no `workspaceId`; suspended/pending/orphaned rows excluded |
| `GET /api/products/:id` | Same; `404` for a non-discoverable shop |
| Collections / wishlist / reviews | Same projection; reviews resolve only for a valid public product |

`workspaceId` is scrubbed globally from request bodies/queries, so product and
collection **ownership is server-authoritative**: a smuggled `workspaceId` is
ignored on create *and* on update (a product can never move between shops), and
a collection may only reference its own workspace's products
(`422 PRODUCT_NOT_IN_WORKSPACE`).

### 11.4 Owner governance vs. operations

`GET /api/owner/shops`, `POST /api/owner/shops/:slug/suspend` and
`…/reactivate` (`protect + requireOwner`) are the **whole** platform-level
lifecycle control: list, suspend, reactivate. Both writes are idempotent,
audit a `SUSPENDED`/`REACTIVATED` `StaffEvent` carrying the governed
`workspaceId`, and invalidate the public catalogue cache.

The owner is a **governance identity only** and never a workspace member: it
cannot manage inventory, orders or a shop's catalogue — those answer
`403 WORKSPACE_REQUIRED` by design.

### 11.5 Proof

`backend/scripts/marketplace-identity-smoke.mjs` (`npm run test:marketplace`,
own server on 4107, own database `Flora-Alchemy-Test-Marketplace`) covers all
of the above in 108 assertions, including the concurrency and partial-state
cases. `scripts/workspace-bootstrap-check.mjs` (22 assertions) is the
service-level proof of the identity-gated bootstrap rule.

---

## 12. Phase 2 — shop-owned services and customer relationships

**The rule:** Flora Alchemy is ONE marketplace with global customers and many
Shops. A Shop (= Workspace) owns *operational* records — products, custom
requests, proposals, orders, conversations, notifications — while a Customer
owns their global identity and their wishlist. Shop/tenant context on the
frontend is **discovery UX only**; every authorization decision is made by the
backend from the record it can see in the database. No Maker/Creator/Seller/
Vendor/Merchant model, no per-shop customer record, no payouts or split
payments are introduced.

### 12.1 Global customer identity

`Customer` stays one global document per person. `PATCH /api/customers/:id`
(`controllers/customerController.js`) now declares:

- `CUSTOMER_SELF_FIELDS = name, phone, addresses, preferences, city, state` —
  writable by the authenticated customer through their own session (the account
  Edit Profile sheet and the address-book endpoints are unchanged);
- `CUSTOMER_NEVER_WRITABLE = status, email` — never writable by anyone through
  this endpoint;
- a **staff** write of ANY protected field (self fields + the never-writable
  pair) answers `403 CUSTOMER_PROFILE_PROTECTED`; the relationship check runs
  first, so an unrelated staff member still gets a plain `404` and never learns
  the record exists;
- a staff PATCH with no protected fields is an accepted no-op
  (`200 { unchanged: true }`), so existing operational screens keep working
  without being granted global writes.

Staff operational access is otherwise unchanged: the relationship rule
(`customerVisibleInScope`) still lets a workspace read the customers it served
through an order, conversation or custom request.

### 12.2 Global wishlist + guarded migration

`controllers/wishlistController.js` identifies the wishlist by the
authenticated `req.user.customerId` **only**. `?shop=` is deliberately ignored
and a client `workspaceId` is already scrubbed, so Shop navigation can never
switch the wishlist.

- Reads UNION every document the customer owns (capped at 20 legacy rows), with
  the canonical document = the unscoped one, else the oldest. Product lookups
  go through `activeShopMap`, so a product whose Shop left discovery becomes an
  `unavailableIds` entry instead of a stale visible row.
- Writes converge on the canonical document (`ensureCanonicalDoc`); removal is
  `updateMany({ customerId }, { $pull })` over every owned document; clear
  empties every document.
- Responses use the Phase 1 projection: `shop: { slug, displayName }` per
  product, `workspaceId` never appears.
- `models/Wishlist.js` keeps the unique `{ customerId, workspaceId }` index as
  the one-global-wishlist guard: `workspaceId` is now documented as DEPRECATED
  (legacy rows only) and new documents are unscoped.

**Migration — `scripts/merge-wishlists-global.mjs` (DRY-RUN by default).**
`--apply` is required to write. The planner (`buildWishlistMergePlan`) picks the
canonical document (unscoped, else oldest), de-duplicates the union, drops only
provably orphaned product slugs, and *reports* ambiguity (`multiple-documents`,
`cross-scope-reference`, `orphaned-reference`) instead of guessing; re-running
`--apply` is a no-op. Against a production database it refuses unless
`CONFIRM_DATABASE_UNSAFE_OPERATION=<dbName>` and
`WISHLIST_MIGRATION_CONFIRM=APPLY_PRODUCTION_WISHLIST_MERGE` are both set.
**Production has not been migrated** — the script ships DRY-RUN only.

### 12.3 Custom Request destination (rules A–D)

`controllers/customRequestController.js#resolveRequestDestination`:

| Case | Rule |
|---|---|
| Product-originated (`productId` = slug or ObjectId) | Workspace = `Product.workspaceId`. A client `shopSlug` resolving to a different Shop → `409 SHOP_MISMATCH` and **no record is created**. A product whose Shop is not publicly discoverable → `422 PRODUCT_NOT_FOUND`. |
| Standalone (`shopSlug`) | Resolve through `activeShopBySlug` (ACTIVE only). Unknown/malformed/suspended → `422 SHOP_NOT_FOUND`. |
| Standalone, no slug | One ACTIVE Shop → that Shop; several exist → `422 SHOP_REQUIRED`; zero workspaces → legacy unscoped row (compat mode only). |
| Any | A client-supplied `workspaceId` is scrubbed and can neither set nor widen ownership. |

Customer responses project the request (and its proposal) through
`publicShopRecord`, and `listMyCustomRequests` resolves attribution live via
`activeShopMap` — so `shop: { slug, displayName }` is present and `workspaceId`
absent everywhere customer-facing.

### 12.4 Request authorization hardening

Every custom-request endpoint was re-audited — this is the code the
pre-existing `tenant-audit` finding pointed at, and Phase 2 legitimately touches
it, so it was fixed here rather than carried forward:

- staff reads/updates resolve through `requestScope(req)`; a cross-workspace id
  answers `404`, and `tenant-audit --strict` is now **exit 0** for this file
  (the only remaining findings are the expected `partly-scoped`
  `invitationController` identity sites);
- `getCustomRequest` uses a single tenant-scoped lookup site; the child proposal
  and order are additionally filtered by `workspaceIdScope(request.workspaceId)`;
- the route layer keeps the existing permission gates (`requests.view`,
  `requests.claim`/`requests.update`), and status transitions still validate the
  exact permission plus the persisted state.

### 12.5 Proposal → Order inheritance

`controllers/proposalController.js` adds `assertProposalShopMatchesRequest`
(`409 SHOP_MISMATCH`) and calls it on send, withdraw, accept, and *before* any
order is created. Draft creation/rebuild and send always re-stamp
`workspaceId: request.workspaceId || null`, so a forged proposal `workspaceId`
cannot survive. `createProposalOrder` in addition asserts the created
`Order.workspaceId` equals the request's (`500 SHOP_MISMATCH` rather than a
silent cross-shop order). `services/customRequestPaymentService.js` refuses to
mark a request paid when the order and the request carry different Shops.

### 12.6 Conversation Workspace comes from the Order

`services/conversationService.js#getOrCreateConversation` stamps
`orderWorkspaceId = getWorkspaceId(order)` — the Order's authoritative Workspace
— and self-heals a missing/mismatched stamp in place. Customers have no
workspace, so `getWorkspaceId(user)` is never the source. The lean payloads in
`listMyConversations`/`listConversations` and `models/Conversation.js`'s
`toJSON` strip `workspaceId`, which is therefore never exposed to customers.

### 12.7 Notification routing

Operational notifications are still created by the entity that owns the event,
using that entity's Workspace (`CustomRequest.workspaceId`,
`Proposal.workspaceId`, `Order.workspaceId`, `Conversation.workspaceId`), so a
Shop's staff hear only about their own requests, proposals and orders. The
requester's URL, the visited Shop and any client-supplied id are never
consulted.

### 12.8 Custom Gift fulfilment Shop

The Custom Gift Studio keeps its shared/static configuration and
server-authoritative pricing (no per-Shop pricing engine, no maker catalogue).
What changed is that a gift order now carries an explicit fulfilment Shop:
`POST /api/orders` accepts `shopSlug`, and `orderController.resolveOrderWorkspace`
validates it (`422 SHOP_NOT_FOUND` for an unavailable slug; a studio gift with
no slug resolves the single ACTIVE Shop, else `422 SHOP_REQUIRED`). Client
prices remain display-only — the server keeps its own. Customer order payloads
carry `shop: { slug, displayName }`, never `workspaceId`.

### 12.9 Proof

`backend/scripts/shop-services-smoke.mjs` (`npm run test:shop-services`, own
server on **4113**, own database `Flora-Alchemy-Test-ShopServices`) covers §A–§L
of the phase in **122 assertions**: customer authorization, global wishlist
semantics, the migration planner (unit) plus CLI DRY-RUN/APPLY/idempotent
re-APPLY, standalone requests, product-originated locking, invalid/suspended
Shop rejection, request isolation, proposal+order inheritance (including a
corrupted proposal Workspace in the database), conversation inheritance +
self-heal, notification routing, the gift Studio, and a deep no-`workspaceId`
leak scan.

---


## 13. Phase 3 — unified bag, shop-aware checkout, orders & fulfilment

**ONE GLOBAL BAG → SHOP GROUPING → ONE SHOP PER CHECKOUT → ONE WORKSPACE-OWNED
ORDER → SERVER-AUTHORITATIVE PRICING → SHOP-SPECIFIC COMMERCE SETTINGS →
INVENTORY → PAYMENT → FULFILMENT.**

Workspace is still the only tenant. Phase 3 adds no Maker/Creator/Seller/Vendor/
Merchant model, no split payment, no multi-Shop order and no settlement or payout
concept. A customer may keep products from many Shops in one bag and lose none
of them; a single checkout may only ever belong to one of them.

### 13.1 One global bag (the central frontend fix)

`frontend/src/services/api.js` stores the bag under ONE key —
`flora_alchemy_cart` — for guests and authenticated customers alike. The former
tenant namespacing (`flora_alchemy_cart::<tenant>`) is gone: browsing Shop A,
then Shop B, then the platform home could no longer fork the customer's bag.
`migrateLegacyCarts()` runs once, merges every legacy per-tenant key into the
global bag, de-duplicates lines by `lineKey()` (`productSlug`+options) and
deletes the old keys. `StoreContext` no longer re-reads the cart on a tenant
switch (it still re-reads the wishlist). The bag is **UI state only** — never
authority for price, stock, Workspace, payment amount or Shop ownership.

### 13.2 Cart lines carry public Shop identity

Each line keeps `shop: { slug, displayName }` — the same public projection the
rest of Phase 1/2 uses, and never an internal id. A malformed, deleted,
hidden or suspended-shop line is still rendered, marked "no longer available —
remove to continue", and blocks only its own group. It is never silently
dropped and never charged.

### 13.3 Shop grouping and the checkout entry point

`frontend/src/services/cartGroups.js` groups the bag by `shop.slug`, carries each
group's availability, and builds `checkoutUrlFor(group) = /checkout?shop=<slug>`.
`CartPage` renders one card per Shop (real `displayName`, real products,
quantities, line totals) with an explicit **Checkout \<Shop\>** button per group.
No group is merged, no group is auto-selected and no group is dropped.
`CheckoutPage` reads `?shop=`, resolves that Shop's public settings for display
(`getShopSettings`), shows an "Ordering from \<Shop\>" banner plus a
"\<n\> other shops stay in your bag" note, and refuses to guess when the
selection is ambiguous (a dedicated selection-error screen instead).

### 13.4 Server-authoritative destination

`services/orderDestinationService.js#resolveOrderDestination` is the single
place an order's Workspace is decided, from stored data only (rules 1–7 in its
header): Product ownership is the authority; more than one owner →
`409 MIXED_WORKSPACE_ORDER`; the client `shopSlug` may only CONFIRM it
(`409 SHOP_MISMATCH`); a suspended owner → `422 SHOP_NOT_FOUND`; a hidden
product → `422 PRODUCT_NOT_FOUND`; staff items must belong to the caller's own
workspace (`403`); bespoke/gift-only lines inherit the workspace the catalogue
lines establish; legacy-unscoped rows keep the documented single-ACTIVE-shop
compatibility path (`422 SHOP_REQUIRED` when several shops are live, and the
historical unattributed behaviour only while zero workspaces exist). One batched
Product read backs the whole decision.

### 13.5 Server-authoritative pricing and the order Workspace's commerce rules

`services/orderService.js#createOrder` ignores every client money field and
recomputes line totals, subtotal, shipping, tax and total from the stored
Product plus the **order Workspace's** Settings document (workspace key, else
the platform singleton). `enforceCommerceSettings` turns stored-but-unenforced
settings into refusals — `acceptNewOrders:false` / `storeAvailability:'closed'`
→ `409 ORDERS_CLOSED`; `422 MINIMUM_ORDER_VALUE`, `MAX_ITEMS_EXCEEDED`,
`PAYMENT_METHOD_NOT_ALLOWED`, `CUSTOM_GIFTS_DISABLED`. `computeOrderTax` applies
the workspace's `taxEnabled`/`taxRate` (skipped on the proposal path, where the
customer already accepted a locked total), and `canonicalPaymentMethod`
normalizes the method before it is validated. Proposal-settling and Custom Gift
pricing keep their Phase 2 server-authoritative validation untouched.

### 13.6 Inventory: Workspace-safe and atomic

`services/inventoryService.js#adjustStock` keeps its single atomic
`findOneAndUpdate` (no read-modify-write window, so concurrent buyers of the
last unit still yield exactly one success) and now filters on
`{ productSlug, workspaceId: { $in: [workspaceId, null] } }`. The strict form is
the ownership proof; the `null` branch only tolerates legacy-unattributed rows,
whose owner was already proven upstream by `resolveOrderDestination`. No stock
operation is ever resolved from a bare slug supplied by a client.

### 13.7 Payments

`createPaymentOrder` still derives the amount from the **stored** order total
(integer paise) and now refuses a non-provider method outright
(`422 PAYMENT_METHOD_NOT_ALLOWED`), so a COD/Sample order can never be turned
into an online charge. Signature verification stays order-bound and
replay-safe: a forged or replayed callback leaves `paymentStatus` untouched. No
payout or settlement surface was introduced.

### 13.8 Order history attribution, snapshots and suspension

Customer order payloads expose `shop: { slug, displayName }` (live shop when it
resolves, else the stored `shopSnapshot`) and never `workspaceId`. `Order` gained
`tax` and `shopSnapshot { slug, displayName }` — **historical display only**;
`Order.workspaceId` remains the authorization authority for every staff/admin
transition (`load → resolve workspace → authorize → validate transition →
mutate`). A suspended Shop leaves discovery and loses the ability to receive new
orders, Custom Requests and checkout, but its historical orders stay readable
by the customer and by its own staff.

### 13.9 Cart clearing removes only what was purchased

`CheckoutPage` records the exact lines it bought and calls
`removeCartLines(lines)` (`StoreContext`) only when the outcome is settled —
paid, COD, or the provider-less sample path. A failed or pending payment clears
nothing, and the checkout snapshot keeps `pendingPaymentOrder` so a refresh
resumes the SAME order instead of creating a duplicate. Shopping Shop A leaves
Shop B's lines in the bag.

### 13.10 Legacy order data — report only

`backend/scripts/order-consistency-report.mjs` is a **read-only** classifier
(`VALID` / `AMBIGUOUS` / `INVALID`, with the reason) for orders with a missing
or invalid `workspaceId`, mixed item ownership, or a CustomRequest/Proposal
mismatch. It has no `--apply`. Nothing was migrated automatically: production
data was never modified in this phase.

### 13.11 Proof

`backend/scripts/checkout-ownership-smoke.mjs` (`npm run test:checkout`, own
server on **4114** with a mock Razorpay on **4128**, own database
`Flora-Alchemy-Test-Checkout`) covers §D–§Z of the phase in **111 assertions**:
single-shop attribution, mixed rejection, forged workspace/slug, product
ownership, staff orders, shop-specific shipping, commerce enforcement, server
pricing, inventory ownership + atomicity under concurrency, payment amount and
signature safety, status authorization, suspended shops, stale carts, shop
attribution/snapshots, customer isolation, conversation + notification
inheritance and a no-leak scan.

---
