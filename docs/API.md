# Flora Alchemy — API Reference

> Generated from the actual route files and controllers in `backend/`.
> **67 feature endpoints** across 15 domains, plus 2 diagnostic endpoints (69 routes).
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
| `PRODUCT_NOT_FOUND` | 404 | Unknown product slug |
| `ORDER_NOT_FOUND` | 404 | Unknown/foreign order |
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
- **`POST /login`** — body `{ email, password }`. `200 { success, token, user, customer }`.
  `user` = `{ id, email, name, role, customerId, isFixture }`.
  Errors: `422` (missing fields), `401 INVALID_CREDENTIALS` (unknown user **or** wrong
  password — identical message), `403 ACCOUNT_SUSPENDED`.
  The limiter counts **failed** attempts only.
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
- **`PATCH /:id`** — allowed fields: `name, phone, addresses, preferences, city,
  state, status`. **Email is never editable here** (identity field), and only staff
  may change `status`.
- Non-owner access to `GET/PATCH /:id` → `404` (read) / `403` (write).

## Products — `/api/products`

No router-level auth; writes are staff-guarded.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Public (staff token reveals hidden) | List products |
| `GET` | `/:id` | Public (staff token reveals hidden) | Product by slug |
| `POST` | `/` | Staff | Create product (+ inventory record) |
| `PATCH` | `/:id` | Staff | Update product (inventory kept coherent) |
| `DELETE` | `/:id` | Staff | Delete product **and** its inventory record |

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
- `POST` body `{ name, description, image, occasion, productSlugs, visibility }`
  (`name` ≥ 2 chars). `PATCH` allows `description, image, occasion, productSlugs,
  visibility, name` — changing `name` re-derives the slug. `visibility` must be
  `Visible|Hidden`. `POST` returns `201`.

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

- **`POST /`** — body `{ items[], paymentMethod, shippingAddress, giftMessage?,
  isRush? }`. Identity comes from the JWT (any client `customerId` is ignored).
  Each item must carry `productSlug` (catalogue) **or** `customGiftConfig`/`addOnId`
  (validated, server-priced); arbitrary client prices are rejected for customers.
  Catalogue prices, shipping and totals are recomputed server-side. Runs in a
  transaction with a stock pre-check. `201 { success, order }`.
  Errors: `422 VALIDATION_ERROR`, `409 INSUFFICIENT_STOCK`, `409 UNAVAILABLE`,
  `404 PRODUCT_NOT_FOUND`.
- **`POST /admin`** — body `{ customerId, items[], shippingAddress, giftMessage?,
  paymentMethod?, isRush? }`. The customer must exist. Uses `forceSamplePayment`
  (no provider interaction, `paymentStatus: 'Sample'`) and allows staff-supplied
  prices for bespoke items. `201`.
- **`PATCH /:id/status`** — body `{ status, note? }`. Status is lower-cased and
  validated as a **forward-only** transition (`422 INVALID_TRANSITION` otherwise).
  Appends to `statusHistory` and notifies the customer.
  Returns `200 { success, order, availableNext }`.
- Statuses: `new | confirmed | in_production | quality_check | ready_to_dispatch |
  shipped | delivered`.

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
| `PATCH` | `/` | Staff | Update settings |

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

- Ownership is always derived from the token; the wishlist is created on first use.
- All responses: `{ success, wishlist: { productIds, products, unavailableIds } }`
  — slugs whose product no longer exists are reported in `unavailableIds`
  (product ids are normalised to lower-case slugs).
  `POST` with an unknown slug → `404 PRODUCT_NOT_FOUND`.

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
  Returns `{ success, payment: { razorpayKeyId, razorpayOrderId, amount, currency,
  displayTotal, receipt } }`. Errors: `403`, `404 ORDER_NOT_FOUND` (also for other
  customers' orders), `409 PAYMENT_ALREADY_COMPLETED`, `503 PAYMENT_NOT_CONFIGURED`.
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

## Custom requests — `/api/custom-requests`

`router.use(protect)`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/` | Customer | Submit a bespoke brief |
| `GET` | `/mine` | Customer | Own requests (`adminNotes` excluded) |
| `GET` | `/` | Staff | All requests (`?status=`, max 200) |
| `PATCH` | `/:id/status` | Staff | Set status (+ optional `adminNotes`) |

- `POST` body `{ description, occasion?, budget?, colors?, desiredDate?, imageUrl? }`
  — `description` ≥ 10 chars (else `422`). Staff are notified. `201`.
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
- Guards: you cannot change your own role/status or delete yourself; you cannot
  suspend, demote or delete the **last active administrator**; seed fixtures
  (`isFixture`) cannot be deleted.
- Suspension is enforced at login **and** on every protected request.

## Notifications — `/api/notifications`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Auth | List notifications (`?unread=true`), max 50, + `unreadCount` |
| `GET` | `/unread-count` | Auth | Unread count only |
| `PATCH` | `/:id/read` | Auth | Mark one read |
| `PATCH` | `/read-all` | Auth | Mark all read |

Stateless in shape: notifications are created server-side as a side effect of order,
payment, conversation and custom-request events. Ownership is enforced in the query
(`{ userId ∈ [user._id, user.customerId] }`), so a client id is never trusted.
`createdAt` has a 90-day TTL index (auto-expiry).

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
| `loginLimiter` | `POST /auth/login` (**failed** requests only) | 10 | 50 |
| `registerLimiter` | `POST /auth/register` | 20 | 150 |
| `paymentLimiter` | `/api/payments/*` | 150 | 150 |
| `uploadLimiter` | `/api/uploads/*` | 40 | 40 |
| `notificationLimiter` | `/api/notifications/*` | 300 | 300 |
| `webhookLimiter` | `POST /payments/webhook` | 300 | 300 |
| `apiWriteLimiter` | `/customers`, `/orders`, `/inventory`, `/wishlist`, `/conversations`, `/custom-requests`, `/admin/users` | 600 | 3000 |

`/api/products` and `/api/collections` are **not** rate limited so browsing is never
throttled. All limits are overridable via `RATE_LIMIT_*` environment variables.

Rate-limited responses: `429 { success:false, message, code:'RATE_LIMITED' }`.

## CORS

`CORS_ORIGIN` is a comma-separated allowlist (defaults to
`http://localhost:3000,http://127.0.0.1:3000`). Requests with **no** `Origin`
header (curl, node smoke suites) are allowed; any other origin is rejected.
Allowed methods: `GET, POST, PATCH, PUT, DELETE, OPTIONS`; allowed headers:
`Content-Type, Authorization`; preflight cached 86400 s.
