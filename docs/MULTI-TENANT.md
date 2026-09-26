# Flora Alchemy — Multi-Tenant (Workspace) Architecture

> **Status: Phase 22.2 (tenant core) landed. Tenant isolation is NOT complete.**
> The `Workspace` entity, membership field, helpers, middleware and tooling now
> exist, but **no production query is filtered by workspace yet** and **no
> workspace exists in any real database**. Single-workspace behaviour is
> byte-for-byte unchanged.
>
> Related: [DATABASE.md](./DATABASE.md), [ARCHITECTURE.md](./ARCHITECTURE.md),
> [API.md](./API.md), [MEMORY.md](./MEMORY.md).

---

## 1. The one-sentence version

Today Flora Alchemy is **one shop with many portals** (owner / admin / staff);
Phase 22 turns it into **many shops (workspaces), each with its own portals** —
and this phase built the foundation without flipping a single behaviour.

---

## 2. CURRENT state (what is true right now)

| Aspect | Reality today |
|---|---|
| Workspaces in the database | **Zero.** No `Workspace` document exists in dev or production. |
| Data model | Every document is **unscoped** — `workspaceId` is absent everywhere. |
| Read paths | **No query filters on `workspaceId`.** Orders, products, inventory, analytics, settings, conversations, customers are read globally by anyone whose role/ownership check already allows it. |
| Staff directory / operators | **Global** across the platform (`staffController`, `adminUserController`). |
| Notifications | Recipient-driven (`userId` / `role`), **not** workspace-filtered — a staff broadcast reaches every matching account. |
| Settings | One singleton document (`key: 'default'`). |
| Slugs | `Product.slug` / `Collection.slug` / `Inventory.productSlug` are **globally unique** (and referenced by orders, inventory and URLs). |
| Owner / customer identities | **Unscoped by design** — `User.workspaceId` stays absent for them. |
| Behaviour | Identical to Phase 21. `requireWorkspace` is not mounted on any router. |

Every workspace-scoped router carries a one-line marker so the state is
explicit rather than implied:

```js
// PHASE-22.2: NOT YET TENANT-SCOPED — no requireWorkspace on this router (docs/MULTI-TENANT.md).
```

Marked routers: `productRoutes`, `collectionRoutes`, `orderRoutes`,
`inventoryRoutes`, `customerRoutes`, `conversationRoutes`,
`customRequestRoutes`, `analyticsRoutes`, `settingsRoutes`, `staffRoutes`,
`staffInvitationRoutes`, `adminUserRoutes`, `uploadRoutes`,
`notificationRoutes`.

---

## 3. WHAT PHASE 22.2 ADDED (the tenant core)

| Piece | File | Behaviour |
|---|---|---|
| **Workspace entity** | `backend/models/Workspace.js` | `slug` (unique, normalised), `displayName` (required, never auto-derived), `status` (`ACTIVE`/`SUSPENDED`/`PENDING`), `primaryAdminId`, timestamps, `toJSON → id`. |
| **Membership field** | `User.workspaceId` + 11 other models | ObjectId → `Workspace`, **sparse index**, **no default**: absent = unscoped. |
| **Tenancy helpers** | `backend/utils/tenancy.js` | `getWorkspaceId`, `workspaceFilter` (fails closed → `403 WORKSPACE_REQUIRED`), `assertWorkspaceMember` (`403 WORKSPACE_MISMATCH`; unscoped legacy docs still readable). |
| **Middleware** | `backend/middleware/workspaceMiddleware.js` | `stripClientWorkspaceId` (mounted globally) + `requireWorkspace` (available, **not mounted**). |
| **Body/query scrub** | `backend/server.js` | Runs after `express.json` (and after multer on the upload route): a client-supplied `workspaceId` / `workspace_id` is deleted from body, nested objects/arrays and query string before any controller runs. |
| **Server-side binding** | `staffInvitationController` | A handler invitation is stamped with the **inviter's** workspace — never the request body's. |
| **Activation inheritance** | `invitationController` | Activating a **handler** invitation assigns `Invitation.workspaceId` to the new `User`; an **admin** activation never does, even if the invitation carries a workspace. |
| **Migration script** | `backend/scripts/backfill-workspaces.mjs` | `--report` (default, read-only, always safe) / `--apply` (guarded: needs explicit `--name` **and** `--slug`, plus a disposable target database). |
| **Tenant audit tool** | `backend/scripts/tenant-audit.mjs` + `scripts/lib/tenantAudit.mjs` | Read-only scanner over a scope manifest; `--json`, `--strict`. |
| **Test suite** | `backend/scripts/tenant-core-smoke.mjs` (`npm run test:tenant`) | 100 checks across entity / membership / helpers / middleware / injection / binding / regression / migration / audit. |

### `requireWorkspace` contract (ready for Phase 22.3)

| Situation | Result |
|---|---|
| No `req.user` | `401 UNAUTHORIZED` |
| `role === 'customer'` | `403 WORKSPACE_FORBIDDEN` (customers own data, they are not workspace members) |
| Staff with no membership (owner, pre-migration) | `403 WORKSPACE_REQUIRED` |
| Membership pointing at a deleted workspace | `403 WORKSPACE_REQUIRED` |
| Workspace `SUSPENDED` | `403 WORKSPACE_SUSPENDED` (re-read per request — no token caching) |
| ACTIVE member | `next()` with `req.workspaceId` + `req.workspaceSlug` set |

### What is deliberately NOT done

- No router mounts `requireWorkspace`.
- No controller query filters on `workspaceId`.
- No workspace is created in dev or production; no document has a `workspaceId`.
- Product/collection slugs stay **globally** unique (composite `{ workspaceId, slug }` is Phase 22.5).
- The Settings singleton stays global.
- The migration's `--apply` mode has **never been run against real data**.

---

## 4. TARGET state (end of Phase 22)

| Resource | Scoping rule |
|---|---|
| Products, collections, inventory, movements | `workspaceId` in every read/write filter; unique index becomes `{ workspaceId, slug }`. |
| Orders, conversations, messages, custom requests, wishlist | workspace **and** the existing customer ownership check (both, never one instead of the other). |
| Analytics, settings | aggregates/settings per workspace; Settings keyed by workspace, not `key: 'default'`. |
| Staff directory, operators, invitations, staff events | workspace-scoped: the directory stops being platform-global. |
| Notifications | workspace-scoped — a staff broadcast reaches that workspace's staff only. |
| Users | `workspaceId` set for workspace staff; owner and customer identities remain unscoped. |
| Uploads / media | assets tagged with the owning workspace. |

**Ownership ordering (unchanged):** JWT scope → `protect` (re-reads the user,
rejects suspended) → role gate → **workspace gate** → ownership/404 rules.
Adding a workspace dimension must never weaken the existing ones.

---

## 5. Known not-yet-scoped hot spots (from the Phase 22.1 audit)

| Severity | Where | Why it matters |
|---|---|---|
| **CRITICAL** | `notificationController` staff broadcasts (`orderController`, `customRequestController`) | Reach **all** matching staff accounts platform-wide. |
| **CRITICAL** | `staffController` / `adminUserController` directory reads | One shared roster for every portal, regardless of workspace. |
| **HIGH** | `isStaffRequest`-style checks that trust the JWT role claim | Role is re-derived from the DB by `protect`, but the *workspace* half of the question is not asked at all. |
| **HIGH** | `analyticsService` aggregates | Revenue/orders computed over the whole platform. |
| **MEDIUM** | Settings singleton | One store's configuration would configure every store. |
| **MEDIUM** | Public catalogue reads | A second workspace's hidden/visible products would appear on the first workspace's storefront. |

Run `node scripts/tenant-audit.mjs` for the live list (it prints every query
site that still lacks a workspace filter, with file + line).

---

## 6. Plan

| Phase | Scope |
|---|---|
| **22.2 (done)** | Tenant core: entity, membership, helpers, middleware, scrub, binding rules, report-only migration, audit tool, tests, docs. |
| **22.3** | Operational scoping: mount `requireWorkspace`, add `workspaceFilter` to orders/products/collections/inventory/analytics/settings/conversations/custom-requests, close the notification + directory hot spots. |
| **22.4** | Onboarding + portal UI: create a workspace when an administrator is activated, workspace switcher/labels in the owner portal, invitation flows showing workspace context. |
| **22.5** | Migration + hardening: run `backfill-workspaces --apply` with an owner-supplied name/slug, composite `{ workspaceId, slug }` indexes, tenant-audit `--strict` in CI, end-to-end two-workspace isolation proof. |

---

## 7. Operating the tooling

```bash
# From backend/

# Read-only migration report (safe against ANY database, including production)
node scripts/backfill-workspaces.mjs --report
node scripts/backfill-workspaces.mjs --report --slug flora-alchemy   # + slug availability

# Guarded migration (Phase 22.5; refuses production, requires explicit name+slug)
node scripts/backfill-workspaces.mjs --apply --name "Flora Alchemy" --slug flora-alchemy

# Tenant-discipline audit (read-only)
node scripts/tenant-audit.mjs
node scripts/tenant-audit.mjs --json
node scripts/tenant-audit.mjs --strict

# Tenant core suite (isolated Flora-Alchemy-Test-TenantCore database)
npm run test:tenant
```

**Safety properties worth knowing:**

- `--report` performs **zero writes**; the suite asserts collection counts are
  byte-identical before and after a report run.
- `--apply` refuses a database listed in `PRODUCTION_DB_NAMES` **before it even
  connects**, and refuses to invent a `displayName` or `slug`.
- Nothing in the codebase creates a workspace implicitly.

---

## 8. Invariants (do not break)

1. `workspaceId` is **server-assigned only** — the scrub runs before every controller.
2. Membership is **sparse**: *absent* means unscoped; it is never stored as `null` on `User`.
3. Owner and customer identities are **never** workspace members.
4. Helpers **fail closed** (`workspaceFilter` throws rather than widening the query).
5. `requireWorkspace` re-reads the workspace per request — a suspended tenant stops immediately.
6. Adding workspace scoping must **never** relax the existing role, ownership or 404 rules.
7. Do not claim isolation until Phase 22.5's two-workspace proof exists.
