# Flora Alchemy — API Reference

> Generated from the actual route files and controllers in `backend/`.
> **70 feature endpoints** across 15 domains, plus 2 diagnostic endpoints (72 routes).
> Nothing here is hypothetical. Related: [ARCHITECTURE.md](./ARCHITECTURE.md),
> [DATABASE.md](./DATABASE.md), [TESTING.md](./TESTING.md).

## Conventions

- **Base path** — all routes are mounted under `/api` (`backend/server.js`).
- **Auth** — `Authorization: Bearer <jwt>`.
  - *Public* = no token required.
  - *Auth* = valid token required (`protect`).
  - *Customer* / *Staff (admin|handler)* / *Admin only* = role enforced after `protect`.
- **Success envelope** — `{ success: true, ... }` (status 200/201).
- **Error envelope** — `{ success: false, message, code }` (from `errorMiddleware`).
- **No-existence-disclosure rule** — a non-owner requesting another entity's
  order/customer/conversation receives **`404`**, not `403`, for read paths.
- **Rate limits** are applied per prefix (see the table at the end).
- **Cache** — public `GET /products`, `GET /products/:id`, `GET /collections`,
  `GET /settings` are served from a 30 s TTL cache that is invalidated by any write.
  Stock availability is attached *after* the cache read, so it is always live.

### Common error codes

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Bad/missing input |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired token |
| `ACCOUNT_SUSPENDED` | 403 | Operator account suspended |
| `FORBIDDEN` | 403 | Authenticated but wrong role/owner |
| `NOT_FOUND` | 404 | Missing record (also used to hide others' records) |
| `PRODUCT_NOT_FOUND` | 404 (422 in a custom-request product context) | Unknown product slug |
| `CUSTOMER_PROFILE_PROTECTED` | 403 | Staff tried to mutate a customer's global identity field |
| `SHOP_REQUIRED` | 422 | A standalone request/gift order needs an ACTIVE Shop and none was given |
| `SHOP_NOT_FOUND` | 422 on writes / 404 on `/shops/:slug` | Unknown, malformed or suspended `shopSlug` |
| `SHOP_MISMATCH` | 409 | Client `shopSlug` contradicts the authoritative owner |
| `ORDER_NOT_FOUND` | 404 | Unknown/foreign order |
| `MIXED_WORKSPACE_ORDER` | 409 | One checkout tried to span two Shops |
| `ORDERS_CLOSED` | 409 | The order Workspace is not accepting new orders |
| `MINIMUM_ORDER_VALUE` | 422 | Cart total is below the Workspace's minimum |
| `MAX_ITEMS_EXCEEDED` | 422 | More items than the Workspace's maximum |
| `PAYMENT_METHOD_NOT_ALLOWED` | 422 | Method disabled for this Workspace, or not a provider method |
| `CUSTOM_GIFTS_DISABLED` | 422 | Custom Gift Studio is off for this Workspace |
| `ORDER_WORKSPACE_MISMATCH` | 500 | Stored items do not belong to the order Workspace (logged, never silently repaired) |
| `DUPLICATE` | 409 | Unique constraint (e.g. slug/email taken) |
| `EMAIL_TAKEN` | 409 | Registration with existing email |
| `INSUFFICIENT_STOCK` | 409 | Not enough (or raced) stock |
| `UNAVAILABLE` | 409 | Stock-tracked product has no inventory record |
| `INVALID_TRANSITION` | 422 | Backwards/unknown order status change |
| `INVALID_SIGNATURE` | 400 | Payment signature verification failed |
| `PAYMENT_ALREADY_COMPLETED` | 409 | Order already paid |
| `PAYMENT_NOT_CONFIGURED` | 503 | Razorpay credentials absent |
| `WEBHOOK_NOT_CONFIGURED` | 501 | No `RAZORPAY_WEBHOOK_SECRET` |
| `CONVERSATION_CLOSED` | 409 | Message sent to a closed conversation |
| `CONVERSATION_CLOSED` / `RATE_LIMITED` | 429 | Too many requests |
| `MALFORMED_JSON` | 400 | Invalid JSON body |
| `UPLOAD_ERROR` / `UPLOAD_FAILED` | 413/422/502 | Multer/provider upload failure |
| `INTERNAL_ERROR` | 500 | Unexpected (details never leaked) |

---

## Diagnostics

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | Public | Liveness — `{ success, service, status:'ok', time }` |
| `GET` | `/api/readiness` | Public | Readiness — `200 ready` when Mongo `readyState === 1`, else `503 not_ready` |

## Auth — `/api/auth`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/register` | Public (registerLimiter) | Create a customer account |
| `POST` | `/login` | Public (loginLimiter) | Authenticate; returns a JWT |
| `POST` | `/logout` | Public | Contract endpoint; logout is client-side token discard |
| `GET` | `/me` | Auth | Current identity + linked customer profile |

- **`POST /register`** — body `{ name, email, password, phone?, role? }`.
  Validates name 2–100 chars, email format, password ≥ 6 chars, phone ≤ 15 digits.
  Creates the `Customer` profile **and** the `User` identity in one transaction.
  **Customer-only:** `role` must be absent or `customer`; any other value is
  rejected with `422 PRIVILEGED_ROLE_FORBIDDEN` (staff accounts are created only
  by an authorized admin or the `provision-admin` script — Phase 20.6.1).
  `201 { success, token, user, customer }`. Errors: `422 VALIDATION_ERROR`,
  `409 EMAIL_TAKEN`.
- **`POST /login`** — body `{ email, password, portal? }`.
  `200 { success, token, user, redirectTo, customer }`.
  `user` = `{ id, email, name, role, customerId, isFixture, isOwner, portal, staffId, roleLabel, department }`.
  Errors: `422` (missing fields), `401 INVALID_CREDENTIALS` (unknown user **or** wrong
  password — identical message), `403 ACCOUNT_SUSPENDED`, `403 PORTAL_FORBIDDEN`.
  The limiter counts **failed** attempts only.
  **Phase 21.1 — portal context.** `portal` is one of `owner` | `admin` | `staff`
  (the route the client is signing into: `/owner/login`, `/admin/login`,
  `/staff/login`). The server resolves the identity from the database and refuses
  a mismatch — a URL can never grant a role:

  | `portal` | permitted identity | everyone else |
  |---|---|---|
  | `owner` | `role=admin` **and** `isOwner=true` | `403 PORTAL_FORBIDDEN` |
  | `admin` | any `role=admin` (the owner included) | `403 PORTAL_FORBIDDEN` |
  | `staff` | `role=handler` only | administrators/owners → `403 PORTAL_FORBIDDEN` |

  Customers are refused every staff portal; omitting `portal` preserves the
  legacy "any staff account" behaviour (used by the storefront customer login).
  `user.portal` and `redirectTo` are **server-derived**; a client-supplied `role`
  or `isOwner` is ignored. See `backend/utils/portals.js` for the authority.
  **Phase 22.4 — workspace claim.** For staff, `user.workspace` is
  `{ id, slug, name, status }` (or `null` while unscoped). It is
  **display-only** (sidebar badge): authorization always re-reads the
  server-side role/workspace per request, and the claim is never trusted.
- **`GET /me`** — `200 { success, user, customer }` (`customer` is `null` for staff).

## Customers — `/api/customers`

`router.use(protect)` on the whole router.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/me` | Auth (customer) | Own profile |
| `GET` | `/me/addresses` | Customer | Own saved addresses |
| `POST` | `/me/addresses` | Customer | Add an address |
| `PATCH` | `/me/addresses/:addressId` | Customer | Update an address |
| `DELETE` | `/me/addresses/:addressId` | Customer | Delete an address |
| `GET` | `/` | Staff | List customers (`?q=` searches name/email, max 500) |
| `GET` | `/:id` | Owner or staff | Customer detail |
| `PATCH` | `/:id` | Owner or staff | Update profile |

- Address bodies are normalised: street ≥ 3 chars, city ≥ 2, state ≥ 2,
  pincode must match `^\d{5,6}$` (`422` otherwise). Label defaults to `Home`.
  Setting `isDefault` clears the flag on all others; the first address is always
  default; deleting the default promotes the first remaining address.
  `POST` returns `201 { success, customer }`.
- **`PATCH /:id` (Phase 2) — the global profile is self-service only.** The
  authenticated customer may edit `name, phone, addresses, preferences, city,
  state` through their own session (the address book has its own endpoints).
  `status` and `email` are never writable here by anyone. A **staff** PATCH that
  touches any protected field (those six plus `status`/`email`) →
  `403 CUSTOMER_PROFILE_PROTECTED`; the relationship check runs first, so an
  unrelated staff member still gets `404`. A staff PATCH with no protected
  fields is a no-op `200 { success, unchanged: true }`, which keeps operational
  forms working without granting global writes.
- Non-owner access to `GET/PATCH /:id` → `404`; a customer PATCHing another
  customer → `403 FORBIDDEN`.

## Products — `/api/products`

No router-level auth; writes are staff-guarded.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Public (staff token reveals hidden) | List products |
| `GET` | `/:id` | Public (staff token reveals hidden) | Product by slug |
| `POST` | `/` | Staff | Create product (+ inventory record) |
| `PATCH` | `/:id` | Staff | Update product (inventory kept coherent) |
| `DELETE` | `/:id` | Staff | Delete product **and** its inventory record |

- **Phase 1 — every public product answers "which Shop does this belong to?"**
  Public reads return the canonical projection from `utils/publicShop.js`:
  `workspaceId` is **stripped** and `shop: { slug, displayName }` is attached
  (`null` for a legacy row that has no workspace). The internal tenant id never
  appears in a public product payload; `shop` is the only attribution contract.
- **Phase 1 — suspended/missing workspaces are not public.** A product whose
  `workspaceId` resolves to a `SUSPENDED`, `PENDING` or deleted Workspace is
  **excluded from the public list** and answers the same
  `404 PRODUCT_NOT_FOUND` on direct lookup. Staff reads are unaffected (a
  suspended workspace member degrades to the public view). A legacy row with no
  `workspaceId` stays public (single-workspace compatibility).
  Attribution is resolved **live on every read**, after the cache, so a
  suspension can never be overridden by a cached listing.
- **Ownership is server-authoritative.** A `workspaceId` in the body/query is
  globally scrubbed; the owning workspace comes from the authenticated
  membership. It is ignored on `POST` **and** on `PATCH` — a product can never
  be moved between shops. `PATCH`/`DELETE` against another workspace's product
  answer `404` (no existence disclosure).

- **Query params** on the list: `?category=`, `?q=` (name/category/sku regex,
  escaped), `?visibility=` (staff only). Public reads return `visibility: 'Visible'`
  only; a **hidden** product returns `404` to the public. Max 500 rows, sorted by
  `createdAt`.
- **Availability** — stock-tracked products carry `stock` and `reorderLevel` in the
  response (attached live). A tracked product with no inventory record reports
  `stock: 0`.
- **`POST` body** — `{ name, price, sku, category, description, image, palette,
  ribbon, occasion, collections, visibility, stockTracked, initialStock, reorderLevel }`.
  `name` ≥ 2 chars, `price` a non-negative number; `slug` is derived via `slugify(name)`.
  When `stockTracked !== false`, an `Inventory` record is created with
  `initialStock` (default 0) and `reorderLevel` (default 5).
  `201 { success, product }`. Errors: `422`, `409 DUPLICATE`.
- **`PATCH`** — partial; a `name` change re-derives the slug and **migrates** the
  inventory record; `stockTracked` re-enable initialises a missing record.
  Note: `initialStock`/`reorderLevel` are **create-only** — stock later changes only
  through inventory adjustments.

## Collections — `/api/collections`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Public (staff token reveals hidden) | List collections |
| `GET` | `/:id` | Public (staff token reveals hidden) | Collection by slug |
| `POST` | `/` | Staff | Create collection |
| `PATCH` | `/:id` | Staff | Update collection |
| `DELETE` | `/:id` | Staff | Delete collection |

- Public list returns visible collections only (max 200, sorted `createdAt`); hidden
  collections return `404` to the public.
- **Phase 1 —** collections use the same canonical public projection as
  products (`utils/publicShop.js`): `workspaceId` is stripped, `shop: { slug,
  displayName }` is attached, and a collection of a suspended/pending/deleted
  workspace is excluded from the public list and `404`s on direct lookup.
- **Phase 1 — a collection has one authoritative workspace.** Every
  `productSlugs` entry must resolve to a product **owned by that collection's
  workspace**; an unknown slug or a cross-workspace reference is rejected with
  `422 PRODUCT_NOT_IN_WORKSPACE` on both `POST` and `PATCH` rather than silently
  stored. A client-supplied `workspaceId` is ignored.
- `POST` body `{ name, description, image, occasion, productSlugs, visibility }`
  (`name` ≥ 2 chars). `PATCH` allows `description, image, occasion, productSlugs,
  visibility, name` — changing `name` re-derives the slug. `visibility` must be
  `Visible|Hidden`. `POST` returns `201`.

## Reviews — `/api/products/:id/reviews` and `/api/reviews/:reviewId/helpful`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/products/:id/reviews` | Public | Aggregate + latest reviews + customer media rail |
| `POST` | `/api/products/:id/reviews` | Customer | Publish a review |
| `POST` | `/api/reviews/:reviewId/helpful` | Public | Increment the helpful counter |

- Reviews are **product-based** (no review tenancy model). The author is always
  `req.user.customerId` — a body `customerId` is ignored, so a review can never
  be attributed to somebody else. `verified` is **derived** from a real paid
  order, never asserted by the client. Re-publishing the same product is
  `409 DUPLICATE`.
- **Phase 1 — reviews resolve only for a VALID PUBLIC product.** `GET`, `POST`
  and the helpful vote all resolve the product first and answer the same
  `404 PRODUCT_NOT_FOUND` when it is missing, `Hidden`, or owned by a
  suspended/pending/deleted workspace — so a review cannot stay publicly
  discoverable through a shop that left discovery. The helpful vote resolves
  **before** mutating, so a no-longer-public review does not even record a vote.
- Review payloads never expose `workspaceId` or any internal tenant identifier.
  Unchanged: the public aggregate is real only — an empty set produces
  `count 0, average 0`, never invented stars.

## Shops — `/api/shops`

**Public, tokenless** (Phase 22.4 identity · Phase 22.5 catalogue hydration ·
Phase 1 shop directory + identity gating).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Public | **Shop directory** — every discoverable shop |
| `GET` | `/:slug` | Public | Workspace identity for the public shop address |
| `GET` | `/:slug/products` | Public | The workspace's own **visible** products |
| `GET` | `/:slug/collections` | Public | The workspace's own **visible** collections |
| `GET` | `/:slug/settings` | Public | The **public** settings slice |

- `200 { success, shop: { slug, displayName } }` — **only `ACTIVE`
  workspaces resolve**; unknown, malformed, reserved and suspended slugs all
  answer the same `404 SHOP_NOT_FOUND` (no existence disclosure).
- **`GET /` (Phase 1) — the public shop directory.**
  `200 { success, shops: [{ slug, displayName }] }`: every `ACTIVE` workspace,
  sorted `displayName` then `slug` (deterministic), bounded to **200** rows.
  Suspended and `PENDING` workspaces are absent. Each row carries **exactly**
  `{ slug, displayName }` — never `_id`/`id`, `status`, `isBootstrap`,
  `primaryAdminId`, counts or membership. The literal `/` path is declared
  before `/:slug`, so the directory can never be captured as a slug.
  The slug is a lookup key, never an authorization grant.
- `/products` and `/collections` return **public-safe projections**: visible rows
  only, and **no inventory quantities or reorder levels** — just
  `inStock`/`availability`. `/settings` returns only a whitelisted slice
  (`PUBLIC_SETTING_FIELDS`: store name, tagline, currency, …) — never contact
  PII, commerce/notification configuration or the pricing authority.
- Deliberately **not** in the public read cache (tenant identity must not be
  served stale), and never accepts or returns `workspaceId`. The slug is a
  **lookup key**, not authorization — the backend resolves the workspace itself.

## Orders — `/api/orders`

`router.use(protect)`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/mine` | Customer | Own orders (newest 100) |
| `GET` | `/` | Staff | All orders (`?status=`, `?q=` orderId/name/email, max 500, newest first) |
| `PATCH` | `/:id/status` | Staff | Advance lifecycle status |
| `POST` | `/` | Customer | Place an order |
| `POST` | `/admin` | Staff | Create an order for an existing customer |
| `GET` | `/:id` | Owner or staff | Order by `orderId` |

- **`POST /`** — body `{ items[], paymentMethod, shippingAddress, shopSlug?,
  giftMessage?, isRush? }`. Identity comes from the JWT (any client
  `customerId` is ignored).
  Each item must carry `productSlug` (catalogue) **or** `customGiftConfig`/`addOnId`
  (validated, server-priced); arbitrary client prices are rejected for customers.
  Catalogue prices, shipping and totals are recomputed server-side. Runs in a
  transaction with a stock pre-check. `201 { success, order }`.
  Errors: `422 VALIDATION_ERROR`, `409 INSUFFICIENT_STOCK`, `409 UNAVAILABLE`,
  `404 PRODUCT_NOT_FOUND`.
- **Phase 2 — `shopSlug` is the fulfilment Shop.** Resolved server-side through
  the Phase 1 ACTIVE-shop lookup; unknown/malformed/suspended →
  `422 SHOP_NOT_FOUND`. A **studio gift** with no slug resolves the single
  ACTIVE Shop, else `422 SHOP_REQUIRED` (never an unscoped order). The resolved
  Workspace is stored on the order; a client `workspaceId` is scrubbed and can
  never set it. Customer order payloads (`/mine`, `/:id`, create) carry
  `shop: { slug, displayName }` — resolved live and falling back to the stored
  `shopSnapshot`, so an order whose Shop later left discovery still names it —
  and never `workspaceId`.
- **`POST /admin`** — body `{ customerId, items[], shippingAddress, giftMessage?,
  paymentMethod?, isRush? }`. The customer must exist. Uses `forceSamplePayment`
  (no provider interaction, `paymentStatus: 'Sample'`) and allows staff-supplied
  prices for bespoke items. `201`.
- **Phase 3 — one Workspace per order, derived server-side.** The order's
  Workspace comes from the stored `Product.workspaceId` of its items (customer
  path) or from the authenticated staff member's own Workspace (`POST /admin`);
  a body/query `workspaceId` is scrubbed before the controller and can never
  select the tenant. `shopSlug` only CONFIRMS the resolved owner. New refusals:
  `409 MIXED_WORKSPACE_ORDER` (items from two Shops), `409 SHOP_MISMATCH`
  (slug contradicts the owning Shop), `422 SHOP_NOT_FOUND` (suspended owner),
  `422 PRODUCT_NOT_FOUND` (hidden/unavailable product), `403` (staff ordering
  another Workspace's product), `422 SHOP_REQUIRED` (legacy-unscoped items with
  several live Shops), `409 ORDERS_CLOSED` (`acceptNewOrders:false` or
  `storeAvailability:'closed'`), `422 MINIMUM_ORDER_VALUE`,
  `422 MAX_ITEMS_EXCEEDED`, `422 PAYMENT_METHOD_NOT_ALLOWED`,
  `422 CUSTOM_GIFTS_DISABLED`, `500 ORDER_WORKSPACE_MISMATCH`.
- **Phase 3 — server-authoritative money.** Client `price`, `lineTotal`,
  `subtotal`, `shipping` and `total` are ignored. Line totals, shipping, tax and
  the total are recomputed from the stored Product and the **order Workspace's**
  Settings (workspace key, else the platform singleton). Orders carry
  `tax` and `shopSnapshot: { slug, displayName }` (historical display only —
  authorization always stays on `workspaceId`).
- **`PATCH /:id/status`** — body `{ status, note? }`. Status is lower-cased and
  validated as a **forward-only** transition (`422 INVALID_TRANSITION` otherwise).
  Appends to `statusHistory` and notifies the customer.
  Returns `200 { success, order, availableNext }`.
- Statuses: `new | confirmed | in_production | quality_check | ready_to_dispatch |
  shipped | delivered`.
- **Suspension.** A suspended Workspace stops receiving new orders, but its
  historical orders stay readable: customer payloads resolve `shop` from the live
  shop and fall back to `shopSnapshot`, so order history keeps its Shop identity
  after a suspension.
- **Phase 22.5 — the customer order payload is a strict WHITELIST.** `GET /mine`,
  the customer branch of `GET /:id`, and the `201` of `POST /` all pass through
  `customerOrderView()` (`backend/utils/publicShop.js`) instead of serializing the
  document. It returns exactly: `id`, `orderId`, `customerId`, `customerName`,
  `customerEmail`, `items` (each rebuilt field-by-field: `productSlug`, `name`,
  `price`, `quantity`, `image`, `category`, `palette`, `ribbon`, `giftMessage`,
  `customDetails`, `description`, `isAddOn`, `isCatalogue`), `subtotal`,
  `shipping`, `tax`, `total`, `paymentStatus`, `paymentMethod`,
  `paymentProvider`, `orderStatus`, `shippingAddress`, `giftMessage`,
  `trackingNumber`, `statusHistory` (each entry reduced to `status`, `note`,
  `at`, `changedAt`, `createdAt` — never `changedBy`), `createdAt`, `updatedAt`,
  `shop` and, when stored, `shopSnapshot`.

  Deliberately **absent** from a customer payload: `workspaceId`,
  `paymentProviderOrderId`, `paymentProviderPaymentId`, `paymentSignatureVerified`,
  `paymentReference`, `paymentVerifiedAt`, `paymentFailureReason`, `isFixture`,
  `_id`/`__v` anywhere, and the internal per-line `stockDeducted` flag. Plain
  `paymentProvider` (the non-secret provider name, e.g. `razorpay`) is kept — it
  is display data, unlike the provider identifiers above. Staff/owner responses
  are **not** projected: `/admin` order views and `GET /:id` for staff keep the
  full document.
- **`shopSnapshot` semantics.** The snapshot is the Shop identity recorded at
  order time and is **not** guaranteed to exist on legacy orders: it is written
  only when the historical identity is provable, and otherwise stays `null`
  (`shop` then resolves live). Do not assume `shopSnapshot` is present on every
  historical order.
- **Legacy orders.** A pre-Workspace order that has not been backfilled is
  reported and left unchanged by the migration tooling; see
  [MULTI-TENANT.md §14](./MULTI-TENANT.md) for the ownership evidence rules.

## Inventory — `/api/inventory`

`router.use(protect, adminOrHandler)` — **staff only**.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Staff | All inventory rows + `summary { totalItems, lowStock, outOfStock }` |
| `GET` | `/history` | Staff | Latest 500 `InventoryMovement` rows |
| `GET` | `/:productId` | Staff | Inventory record by product slug |
| `POST` | `/:productId/adjust` | Staff | Adjust stock |

- **`POST /:productId/adjust`** — body `{ type, quantity, reason? }`.
  `quantity` must be a positive number. `type` must be one of
  `restock | remove | adjustment | sale | return | correction | correction-down`
  — **unknown types are rejected, never coerced**. `remove`/`sale`/`correction-down`
  subtract. Delegates to `adjustStock()`, which writes an `InventoryMovement`.
  Errors: `422`, `404 NOT_FOUND` (no record), `409 INSUFFICIENT_STOCK`.

## Analytics — `/api/analytics`

`router.use(protect, adminOrHandler)` — **staff only**.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/overview` | Staff | `{ totalOrders, totalRevenue, averageOrderValue, statusBreakdown, customers, products, inventory }` |
| `GET` | `/sales` | Staff | Daily revenue series + top products; `?days=` clamped to 1–365 (default 30) |
| `GET` | `/performance` | Staff | Customer/order performance aggregates |

**Revenue counts only `paymentStatus` in the revenue set** (`Paid`); `Pending`,
`Failed`, `Refunded` and `Sample` are never counted as revenue.

## Settings — `/api/settings`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Public | Storefront settings (creates the default doc if absent) |
| `PATCH` | `/` | Admin (owner or administrator) | Update settings — handlers cannot write store-wide configuration |

- `GET` returns `{ success, settings }` (cached 30 s).
- `PATCH` accepts only whitelisted top-level keys: `storeName, currency,
  storeAvailability, acceptNewOrders, shippingConfiguration,
  customGiftConfiguration, storeTagline, contactEmail, contactPhone, timezone,
  commerceConfiguration, notificationConfiguration`. Unknown keys are ignored;
  the cache is invalidated.

## Wishlist — `/api/wishlist`

`router.use(protect, requireRole('customer'))` — **customer only**.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Customer | Current wishlist |
| `POST` | `/:productId` | Customer | Add a product (by slug) |
| `DELETE` | `/:productId` | Customer | Remove a product |
| `DELETE` | `/` | Customer | Clear the wishlist |

- Ownership is always the authenticated `customerId`; the wishlist is created
  on first use. **Phase 2 — the wishlist is GLOBAL.** `?shop=` is deliberately
  ignored and a client `workspaceId` is already scrubbed, so browsing `/shops/a`
  then `/shops/b` never switches it. Reads union every document the customer
  owns (canonical = the unscoped one, else the oldest) and writes converge on
  it; the unique `{ customerId, workspaceId }` index remains the
  one-global-wishlist guard on legacy rows.
- All responses: `{ success, wishlist: { productIds, products, unavailableIds } }`
  — slugs whose product no longer exists, or whose Shop left public discovery,
  are reported in `unavailableIds` (product ids are normalised to lower-case
  slugs). Products use the Phase 1 projection `shop: { slug, displayName }`;
  `workspaceId` is never returned. `POST` with an unknown slug →
  `404 PRODUCT_NOT_FOUND`.
- Legacy scoped wishlists are merged by `scripts/merge-wishlists-global.mjs`
  (DRY-RUN by default; `--apply` writes; idempotent).

## Payments — `/api/payments`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/webhook` | Public (webhookLimiter, HMAC-verified) | Razorpay event sync |
| `POST` | `/create-order` | Customer | Bind a provider order to a Flora order |
| `POST` | `/verify` | Customer | Verify signature **or** record failure |
| `GET` | `/:orderId/status` | Owner or staff | Payment state (never secrets) |

- **`POST /create-order`** — body `{ orderId }`. Amount is recomputed from the
  stored `order.total` (integer paise); the client amount is ignored. Reuses an
  existing `paymentProviderOrderId` on retry (one provider order per business order).
  A COD/Sample order is refused with `422 PAYMENT_METHOD_NOT_ALLOWED` — an
  offline order can never be converted into an online charge.
  Returns `{ success, payment: { razorpayKeyId, razorpayOrderId, amount, currency,
  displayTotal, receipt } }`. Errors: `403`, `404 ORDER_NOT_FOUND` (also for other
  customers' orders), `409 PAYMENT_ALREADY_COMPLETED`, `503 PAYMENT_NOT_CONFIGURED`,
  `422 PAYMENT_METHOD_NOT_ALLOWED`.
- **`POST /verify`** — body is either `{ orderId, outcome:'failed'|'cancelled',
  failureReason? }` or `{ orderId, razorpay_payment_id, razorpay_order_id,
  razorpay_signature }`.
  - Failure branch → `paymentStatus: 'Failed'`, held stock **released** (idempotent).
  - Success branch → the server-created provider order id must match the client's,
    the HMAC is verified timing-safe, then `paymentStatus: 'Paid'` and exactly one
    final deduction (flag-guarded). Re-verifying the same payment id is idempotent.
  - Errors: `422`, `400 INVALID_SIGNATURE`, `400` order mismatch,
    `409 PAYMENT_ALREADY_COMPLETED`, `404`.
- **`GET /:orderId/status`** — `{ success, payment: { orderId, paymentStatus,
  paymentMethod, paymentProvider, paymentReference, paymentSignatureVerified,
  paymentVerifiedAt, paymentFailureReason, total } }`.
- **`POST /webhook`** — requires `x-razorpay-signature` HMAC over the raw body
  (`RAZORPAY_WEBHOOK_SECRET`). `payment.captured` → Paid; `payment.failed` → Failed;
  both idempotent and stock-consistent. Unknown orders are acknowledged (`ignored`)
  so the provider stops retrying. Errors: `501 WEBHOOK_NOT_CONFIGURED`,
  `400 INVALID_SIGNATURE`.

## Conversations — `/api/conversations`

`router.use(protect)`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/unread` | Auth | Unread count for the caller |
| `GET` | `/order/:orderId` | Owner or staff | Get-or-create the order's conversation |
| `GET` | `/mine` | Auth (customer) | Own conversations |
| `GET` | `/` | Staff | All conversations (`?status=`, `?limit=`) |
| `GET` | `/:conversationId/messages` | Participant | Messages (`?before=`, `?limit=` default 50) |
| `POST` | `/:conversationId/messages` | Participant | Send a message |
| `PATCH` | `/:conversationId/read` | Participant | Mark read |
| `PATCH` | `/:conversationId/status` | Staff | Set `open` \| `closed` |

- One conversation per `(orderId, customerId)`; `GET /order/:orderId` creates it on
  first access and returns `{ success, conversation, order: { orderId, status } }`.
- `POST .../messages` — body `{ body }` (required). `403` for non-participants,
  `409 CONVERSATION_CLOSED` for closed threads. `201 { success, message }`.
- Participant mismatch → `403 FORBIDDEN`; unknown conversation → `404 NOT_FOUND`.
- **Phase 2 — the conversation's Workspace comes from the Order.**
  `GET /order/:orderId` stamps `Conversation.workspaceId = Order.workspaceId`
  (self-healing a missing/mismatched stamp), never `getWorkspaceId(user)` —
  customers have no workspace. `workspaceId` is stripped from every conversation
  payload (`toJSON` + the lean lists); `Message` carries none and is authorized
  through its conversation.
- **Phase 22.5 — no `workspaceId` on any conversation path.** `GET /order/:orderId`
  and `GET /mine` serialize through the model's `toJSON` transform (which strips
  `_id`, `__v` and `workspaceId`), and the lean listing paths use the explicit
  `publicConversation()` projection. Authorization is unchanged and still derives
  from the Order server-side.

## Custom requests — `/api/custom-requests`

`router.use(protect)`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/` | Customer | Submit a bespoke brief |
| `GET` | `/mine` | Customer | Own requests (`adminNotes` excluded) |
| `GET` | `/:id` | Owner or staff | Request + proposal + order |
| `GET` | `/` | Staff | All requests (`?status=`, max 200) |
| `PATCH` | `/:id/status` | Staff | Set status (+ optional `adminNotes`) |
| `POST` | `/:id/proposal` | Staff | Save/replace the itemised proposal draft |
| `POST` | `/:id/proposal/send` | Staff | Send the proposal to the customer |
| `POST` | `/:id/proposal/withdraw` | Staff | Withdraw a sent proposal |
| `POST` | `/:id/proposal/accept` | Customer | Accept — creates the order |
| `POST` | `/:id/proposal/decline` | Customer | Decline the proposal |

- `POST` body `{ description, occasion?, budget?, colors?, desiredDate?,
  imageUrl?, productId?, shopSlug? }` — `description` ≥ 10 chars (else `422`).
  **Phase 2 — every request has exactly one authoritative Shop:**
  - `productId` (a product slug or ObjectId) → the request inherits
    `Product.workspaceId`; a `shopSlug` that resolves to a different Shop →
    `409 SHOP_MISMATCH` and nothing is created, and a product whose Shop left
    public discovery → `422 PRODUCT_NOT_FOUND`.
  - standalone (`shopSlug`) → resolved through the ACTIVE-shop lookup;
    unknown/malformed/suspended → `422 SHOP_NOT_FOUND`.
  - standalone with no slug → the single ACTIVE Shop, or `422 SHOP_REQUIRED`
    when several exist (a zero-workspace compat deployment keeps the historical
    unscoped behaviour).
  - A client `workspaceId` is scrubbed and can never set or widen ownership.
  Staff of the owning Workspace are notified. `201 { success, request }` with
  the customer projection `shop: { slug, displayName }`.
- **Phase 2 — proposal/order inheritance.** A proposal may only be created,
  sent, withdrawn or accepted while `Proposal.workspaceId ==
  CustomRequest.workspaceId` (`409 SHOP_MISMATCH` otherwise). The order created
  by an accepted proposal asserts `Order.workspaceId == request.workspaceId`
  before creation (mismatch → `500 SHOP_MISMATCH`, no partial order). Customer
  payloads project the request and its proposal with `shop` and never return
  `workspaceId`; staff reads/updates are Workspace-scoped, so a cross-workspace
  id answers `404`.
- `PATCH` status ∈ `pending | reviewing | quoted | accepted | declined`; the customer
  is notified of the change.

## Admin users (operators) — `/api/admin/users`

`router.use(protect, requireRole('admin'))` — **admin only**.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Admin | List operators (`?role=`, `?q=`; `passwordHash` never returned) |
| `POST` | `/` | Admin | Create an operator |
| `PATCH` | `/:id/role` | Admin | Change role |
| `PATCH` | `/:id/status` | Admin | Suspend / reactivate |
| `DELETE` | `/:id` | Admin | Delete an operator |

- `POST` body `{ name, email, role, password }` — **password required** (≥ 6
  chars, same rule as public registration); role must be `admin`/`handler`
  (or `ADMINISTRATOR`/`HANDLER`), anything else is `422`. The password is
  bcrypt-12 hashed server-side and **never returned by the API** (no generated
  temp password — Phase 20.6.1); the admin shares the initial password
  out-of-band. `201`. `409 DUPLICATE` on existing email.
- First-owner bootstrap (before any admin exists): guarded server-side command
  `npm run provision-admin` — never an HTTP endpoint (see DEPLOYMENT.md).
  It creates `role=admin` with `isOwner=true` — the **owner designation** is not
  a fourth role; it is a server-checked flag on an administrator
  (`requireOwner` middleware, Phase 20.6.2). Invitation activation never grants
  it.
- Guards: you cannot change your own role/status or delete yourself; you cannot
  suspend, demote or delete the **last active administrator**; seed fixtures
  (`isFixture`) cannot be deleted.
- Suspension is enforced at login **and** on every protected request.

## Admin applications — `/api/admin-applications`

Phase 20.6.6 intake + review, extended by **Phase 22.4** (business identity →
approved workspace slug).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/` | Public (`applicationLimiter`) | File an application — creates a review record only, **no account, no credential** |
| `GET` | `/` | Owner | Ledger with counts (`?status=`, `?q=`) |
| `GET` | `/:id` | Owner | Full dossier |
| `POST` | `/:id/approve` | Owner | Approve (atomic `SUBMITTED/PENDING_REVIEW → APPROVED` claim) + mint the one-time admin invitation |
| `POST` | `/:id/reject` | Owner | Reject with a reason (terminal) |

- `POST` body `{ name, email, phone?, message?, businessName, preferredSlug? }`
  — **`businessName` required (2–120)**; `preferredSlug` optional, validated
  against the same `SLUG_RE` + reserved-path rules as workspace slugs.
- The response returns the server-resolved **`proposedSlug`** (preferred →
  slugified business name → slugified email, each re-checked), which the
  success panel shows as `/shops/<proposedSlug>`.
- `409 SLUG_TAKEN` when the proposed slug already belongs to a Workspace —
  the applicant clears/edits the address and resubmits.
- On approval the invitation is stamped with `workspaceName`/`workspaceSlug`
  (from `proposedSlug`) and the application records
  `approvedWorkspaceSlug`; `409 ALREADY_APPROVED` / `409 APPLICATION_APPROVED`
  for repeat claims. Statuses: `SUBMITTED → PENDING_REVIEW → APPROVED → INVITED
  → ACTIVATED`, or `→ REJECTED`.

## Invitations — `/api/invitations`

**Public** (mounted with `invitationLimiter`). The invitation token IS the
credential — 256-bit (`crypto.randomBytes(32).toString('hex')`), stored only as
a SHA-256 hash, single-use, 72-hour TTL (Phase 20.6.1/20.6.2).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/:token` | Public | Landing data: role, recipient email, applicant name, expiry, status |
| `POST` | `/:token/activate` | Public | Consume the invitation once and create the staff account |

- `GET` responses never include the token hash, the raw token, or inviter
  identity. Malformed tokens are `404` before any database query.
- State errors: `404 INVITATION_NOT_FOUND`, `410 INVITATION_EXPIRED` (expiry is
  lazily persisted as `EXPIRED`), `403 INVITATION_REVOKED`,
  `409 INVITATION_ALREADY_ACTIVATED`.
- `POST` body `{ password }` — **password required** (≥ 6 chars, same rule as
  public registration), bcrypt-12 hashed; the server never accepts a `role`,
  `email` or `isOwner` from the client (role comes from the invitation).
- Single-use is an **atomic** `INVITED → ACTIVE` transition, so two concurrent
  activations cannot both succeed. A taken email is refused (`409 EMAIL_TAKEN`)
  **without** consuming the invitation.
- Success `201 { success, account: { email, name, role } }` — no token and no
  credential is echoed; the client then signs in through `POST /api/auth/login`.
- A linked `AdminApplication` moves to `ACTIVATED` and the inviter receives a
  notification. Neither is allowed to break the activation itself.
- Phase 20.6.3: the landing payload also carries `recipientName`, `roleLabel`,
  `department`, `invitationId` and `invitedByName`, and activation copies the
  invitation's `department`/`phone`/`inviter` onto the new account plus its
  derived `staffId`. Success includes
  `account: { email, name, role, roleLabel, staffId, department }`.
- **Phase 22.4 (administrator invitations):** the landing also carries
  `workspaceName`/`workspaceSlug` (stamped at approval) plus the resolved
  role, and the `POST` body may include an optional **`workspaceSlug`**
  (the editable `/shops/…` address on the activation page; `SLUG_RE` →
  `422 INVALID_SLUG`). For `role=admin` the activation runs in **one MongoDB
  transaction**: consume invitation → create the admin `User` (bound
  `workspaceId`) → create the `Workspace` → clone the platform `Settings`
  (`services/workspaceProvisioningService.js`). Slug precedence: body
  `workspaceSlug` → invitation `workspaceSlug` → application `proposedSlug` →
  slugify(displayName) → slugify(email). Conflicts:
  `409 WORKSPACE_SLUG_TAKEN` (invitation stays `INVITED`, nothing persisted),
  `409 EMAIL_TAKEN`, `422 INVALID_SLUG`. Success adds
  `workspace: { id, slug, name, status }`. **Handler** activations are
  unchanged — they inherit `Invitation.workspaceId` and never create a
  workspace.
- **Phase 1 — the bootstrap claim is gated on the APPROVED BUSINESS IDENTITY.**
  Before resolving an identity, activation checks
  `isCanonicalBootstrapIdentity({ inv, application, suggestedSlug })`
  (`services/workspaceProvisioningService.js`, exported alongside
  `CANONICAL_BOOTSTRAP_SLUG = 'flora-alchemy'`). The ACTIVE, unclaimed
  `isBootstrap` Workspace is reused **only** when the onboarding dossier *is*
  the canonical Flora Alchemy business (canonical slug, or canonical display
  name), **and** no non-owner administrator is attached yet. Every other
  business is genuinely new and gets its **own** Workspace — an unrelated first
  creator can no longer inherit the canonical workspace merely by activating
  first, and a claimed bootstrap is never handed out again. Slug precedence
  (unchanged): body `workspaceSlug` → invitation `workspaceSlug` →
  application `proposedSlug` → slugify(displayName) → slugify(email).

## Staff invitations (authenticated) — `/api/admin/invitations`

**Admin only** (`protect` + `requireRole('admin')`; handlers, customers → `403`).
Separate from the public router above on purpose: one is authorized by a
session, the other by token possession (Phase 20.6.3).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Admin | Ledger with `?status=`, `?role=`, `?q=` and roster-wide counts |
| `POST` | `/` | Admin | Issue a **HANDLER** invitation (`{ name, email, phone?, department?, notes? }`) |
| `GET` | `/:id` | Admin | One invitation (never the raw token) |
| `POST` | `/:id/resend` | Admin | Mint a NEW token, extend the TTL, invalidate the previous link |
| `POST` | `/:id/revoke` | Admin | Withdraw an unused invitation (idempotent) |

- The role is **fixed to `handler`**; a request asking for anything else is
  rejected (`422`) rather than silently coerced.
- Duplicates: existing account → `409 EMAIL_TAKEN`; a live pending invitation →
  `409 INVITATION_PENDING` (resend it instead of minting a second credential).
- The raw token/link appears in exactly **one** response — the create or resend
  that minted it — and is stored only as a SHA-256 hash. No read endpoint can
  return it, so the UI offers "Copy link" only for a link minted in-session.
- `resend` refuses consumed invitations (`409`) and revoked ones (`422`);
  `revoke` refuses consumed invitations (`409`).

## Staff directory & lifecycle — `/api/admin/staff`

**Admin only** (Phase 20.6.4). Handlers and customers get `403` — there is no
read-only roster for handlers, since it contains colleague contact details.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Admin | Unified roster (accounts + live invitations) with counts; `?role=`, `?status=`, `?q=`, `?sort=` |
| `GET` | `/:id` | Admin | Dossier for a User id **or** an invitation id, incl. server-derived `actions` |
| `GET` | `/:id/activity` | Admin | Real audit timeline (`StaffEvent`), newest first; may be empty |
| `POST` | `/:id/suspend` | Admin | `{ reason, note? }` → `SUSPENDED`, enforced on the next request |
| `POST` | `/:id/reactivate` | Admin | → `ACTIVE`, clears the suspension record |
| `PATCH` | `/:id` | Admin | `{ department?, phone?, notes? }` |

- Target-side permission matrix (enforced here, where the target's role is
  known): any admin may act on a **handler**; only the **owner** (`isOwner`) may
  act on an **administrator** (`403 OWNER_REQUIRED`); nobody may act on
  themselves (`422 SELF_ACTION_FORBIDDEN`); fixture accounts are read-only
  (`422 FIXTURE_READONLY`); suspension requires a reason (`422 VALIDATION_ERROR`).
- Suspension takes effect immediately because `protect` re-reads the user on
  every request (`403 ACCOUNT_SUSPENDED`) and login refuses suspended accounts.
- Every lifecycle action appends a `StaffEvent` (`INVITATION_CREATED`,
  `INVITATION_RESENT`, `INVITATION_REVOKED`, `ACCOUNT_ACTIVATED`, `LOGIN`,
  `SUSPENDED`, `REACTIVATED`, `PROFILE_UPDATED`).

## Owner portal — `/api/owner`

**Owner only** (Phase 21.2 — `protect` + `requireOwner`). A plain administrator
(`role=admin`, `isOwner=false`), a handler, a customer and an anonymous caller
all receive `403`/`401` — ownership is re-read from the database per request and
is never granted by an invitation.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/overview` | Owner | Executive KPI bundle + the 12 most recent `StaffEvent` entries |
| `GET` | `/administrators` | Owner | Administrators directory (accounts + live admin invitations); `?q=`, `?status=` |
| `GET` | `/shops` | Owner | **Shop governance** — every Workspace/Shop with lifecycle status; `?q=`, `?status=` |
| `POST` | `/shops/:slug/suspend` | Owner | Take a Shop out of public discovery (idempotent) |
| `POST` | `/shops/:slug/reactivate` | Owner | Return a Shop to public discovery (idempotent) |

- **`/overview`** → `200 { success, overview, activity }` where `overview` is
  `{ applications: { all, pending, approved, rejected, invited, activated },
  administrators: { total, active, suspended }, handlers: { total, active,
  suspended }, pendingInvitations }`. Every number is a live `countDocuments`/
  aggregate against the real collections — no fixtures, no invented metrics.
- **`/administrators`** → `200 { success, administrators, counts }`. Each row
  carries `kind` (`user` | `invitation`), `isOwner` (the owner is flagged, never
  hidden), `staffId`, `roleBadge`, `status`, `joinedLabel`, `lastActiveLabel` and
  `invitedByName`. `counts` = `{ all, owners, active, invited, suspended,
  expired, pendingApplications, pendingInvitations }` — the last two are the
  owner-side queues that gate administrator creation. `passwordHash` is never
  returned.
- **Invitation rows** (`kind: 'invitation'`, `INV-…` badge) are administrator
  invitations that have not produced an account yet. They carry
  `expiresAt` / `expiresLabel`, `resendCount` and server-derived `actions`
  (`canResend` / `canRevoke` true only while `INVITED` or `EXPIRED`), so the UI
  never offers a control the backend would refuse. No token or hash is returned.
  A handler invitation never appears here — the directory lists administrators
  only.
- Expired invitations are lazily persisted as `EXPIRED` on read, exactly as the
  staff ledger does.
- **Administrator invitations are owner-only to mutate (Phase 21.4).**
  `POST /api/admin/invitations/:id/resend` and `…/revoke` succeed for any
  administrator on a **handler** invitation, but refuse a non-owner on an
  **administrator** invitation with `403 OWNER_REQUIRED` — checked before any
  state inspection, so the refusal never leaks whether the link is live.
  `POST /api/admin/invitations` rejects a non-handler `role` with `422`, so it can
  never mint an administrator.
- **`/shops` (Phase 1) — Shop lifecycle governance, and nothing more.**
  `GET /api/owner/shops` → `200 { success, shops, counts }` for **every**
  workspace (including suspended and `PENDING` ones), each row carrying
  `{ id, slug, displayName, status, statusChangedAt, isBootstrap, createdAt,
  createdLabel, primaryAdmin, actions: { canSuspend, canReactivate } }` and
  `counts` = `{ all, active, suspended, pending }`. This is an owner-only
  surface — it legitimately carries the internal `id`, unlike the public
  directory.
  `POST …/suspend` and `…/reactivate` return `200 { success, shop }`, are
  **idempotent** (the update is conditional on the current status, so a repeat
  cannot flip a shop back), write a `SUSPENDED` / `REACTIVATED` `StaffEvent`
  carrying the governed `workspaceId`, and **invalidate the public catalogue
  cache** (`products:` / `collections:` prefixes). Because the public reads also
  resolve shop status live, a suspension takes effect on the very next request.
  An unknown slug answers `404 SHOP_NOT_FOUND`.
  The owner is a **governance identity only**: it never manages inventory,
  orders or a shop's catalogue — those surfaces answer
  `403 WORKSPACE_REQUIRED` for the owner by design, and it is never a workspace
  member.

## Notifications — `/api/notifications`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Auth | List notifications (`?unread=true`), max 50, + `unreadCount` |
| `GET` | `/unread-count` | Auth | Unread count only |
| `PATCH` | `/:id/read` | Auth | Mark one read |
| `PATCH` | `/read-all` | Auth | Mark all read |
| `POST` | `/elevation-request` | Staff | Notify every active owner (`{ path }` = denied route) |

- `POST /elevation-request` is the **real** action behind "Request Elevated
  Clearance" on the Owner Access Required screen. It returns
  `{ success, requested }` — `requested` is how many owner accounts were
  actually notified (`0` when no owner exists). The requester is never notified
  about their own request.

Stateless in shape: notifications are created server-side as a side effect of order,
payment, conversation and custom-request events. Ownership is enforced in the query
(`{ userId ∈ [user._id, user.customerId] }`), so a client id is never trusted.
`createdAt` has a 90-day TTL index (auto-expiry).

- **Phase 22.5 — response projection.** Every notification a customer or staff
  member receives is projected to the customer-safe field set
  (`type`, `title`, `message`, `read`, `readAt`, `createdAt`, `link`), including
  the `PATCH /:id/read` and `PATCH /read-all` responses, which previously
  returned the updated document. `workspaceId`, `userId`, `role`, `entityId` and
  `entityType` are never exposed; `/unread-count` keeps returning `{ count }`.
- **Legacy notifications.** A notification's `workspaceId` may legitimately be
  `null`: platform-wide `system` notifications are unscoped **by design** and are
  never converted into Shop notifications.

## Uploads — `/api/uploads`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/product-image` | Staff | Upload a product image (multipart, field `image`) |

- Accepts `image/jpeg|png|webp|gif|avif`, max **5 MB**.
- With ImageKit configured → uploads to the CDN (`memoryStorage`, no disk write) and
  returns `201 { success, url, provider: 'imagekit' }`.
- Without ImageKit → **real** local persistence (`diskStorage`, lazy directory
  creation) and returns `201 { success, url: '/uploads/<name>', provider: 'local' }`.
  Filenames are MIME-derived and randomised — the original name is never used.
- Errors: `422` unsupported type / missing file, `413 UPLOAD_ERROR` too large,
  `502 UPLOAD_FAILED` provider failure, `503` local storage unavailable.

---

## Rate limiting

Applied in `server.js` per prefix, implemented in `middleware/securityMiddleware.js`.
All windows are 15 minutes and all are **in-memory per process**.

| Limiter | Applies to | Production | Development |
|---|---|---|---|
| `loginLimiter` | `POST /auth/login` (**failed** requests only, all portals) | 10 | 50 |
| `registerLimiter` | `POST /auth/register` | 20 | 150 |
| `applicationLimiter` | public admin-application submissions (Phase 20.6.1) | 10 | 150 |
| `invitationLimiter` | `/api/invitations/*` (public token lookup/activation) | 60 | 300 |
| `paymentLimiter` | `/api/payments/*` | 150 | 150 |
| `uploadLimiter` | `/api/uploads/*` | 40 | 40 |
| `notificationLimiter` | `/api/notifications/*` | 300 | 300 |
| `webhookLimiter` | `POST /payments/webhook` | 300 | 300 |
| `apiWriteLimiter` | `/customers`, `/orders`, `/inventory`, `/wishlist`, `/conversations`, `/custom-requests`, `/admin/users`, `/admin/staff/*`, `/admin/invitations/*` | 600 | 3000 |

`/api/products` and `/api/collections` are **not** rate limited so browsing is never
throttled. All limits are overridable via `RATE_LIMIT_*` environment variables.

Rate-limited responses: `429 { success:false, message, code:'RATE_LIMITED' }`.

## CORS

`CORS_ORIGIN` is a comma-separated allowlist (defaults to
`http://localhost:3000,http://127.0.0.1:3000`). Requests with **no** `Origin`
header (curl, node smoke suites) are allowed; any other origin is rejected.
Allowed methods: `GET, POST, PATCH, PUT, DELETE, OPTIONS`; allowed headers:
`Content-Type, Authorization`; preflight cached 86400 s.
