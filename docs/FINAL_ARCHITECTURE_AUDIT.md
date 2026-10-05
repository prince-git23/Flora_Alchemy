# Final Architecture Audit — Flora Alchemy Marketplace

**Repository:** https://github.com/prince-git23/Flora_Alchemy.git
**Branch:** main
**Scope:** Post-Phase-3 steady-state review (read-only; no code changes)

---

## Baseline

| Item | Value |
|---|---|
| **HEAD** | `b535a3d931878e377aba6fce6a3c440a6085bab0` |
| **origin/main** | `b535a3d931878e377aba6fce6a3c440a6085bab0` |
| **HEAD == origin/main** | Yes |
| **Working tree** | Clean except 6 uncommitted frontend layouts under `frontend/scripts/responsive-audit/results/2026-09-29T…` through `2026-09-30T18-29-03-376Z/`. These are pre-existing one-off responsive-harness outputs, unrelated to the marketplace transaction path, and were never staged. |

## Architecture Map (concise)

**Public user path:**
`storefront → auth → customer → Shop discovery (GET /api/shops/:slug, search, home, collection, gift finder) → Product Detail (→ wishlist) → Cart (global, one key) → Custom Gift / Custom Request → Proposal → Checkout (?shop=) → Order → Payment (Razorpay) → Inventory deduction → Conversation → Notification → Fulfillment (status lifecycle) → Account / Order History`

**Internal governance path:**
`Owner → Workspace governance (list/review/activate/suspend/reactivate shop) → Admin (one workspace business owner/operator) → Staff (operational, member of Admin Workspace) → Products/Collections/Inventory/Orders/CustomRequests/Proposals/Conversations/Notifications/Settings`

**Ownership authority source of truth (steady state):**
| Entity | Authority source | Public identity exposed | Internal id in payloads |
|---|---|---|---|
| Product | Product.workspaceId (set by server from membership) | yes (shop: {slug, displayName}) | no |
| Collection | Collection.workspaceId + members verified as Product.workspaceId | yes | no |
| Order | authoritative Product Workspace (customer) / caller staff Workspace (staff) | yes (shop: {slug, displayName}; fallback shopSnapshot) | no (workspaceId stripped in toJSON) |
| CustomRequest | Product Workspace (A) OR explicit ACTIVE Shop (B) | yes | no |
| Proposal | CustomRequest.workspaceId | — | no |
| Conversation | Order.workspaceId (self-healing) | — | no (delete ret.workspaceId in toJSON) |
| Notification | source entity Workspace (or null for platform-wide) | — | not in list projection |
| Inventory | authoritative Product + Workspace (relationship proved upstream) | — | — |
| Settings | Workspace document (or platform key: 'default') | partial whitelist | no |

**Role identities:**
- OWNER = platform governance (isOwner: true, workspaceId == null). Stays off ordinary operator surfaces.
- ADMIN = one Workspace business owner/operator (member). Runs shop operations.
- STAFF (handler) = operational user in an Admin Workspace.
- CUSTOMER = global identity; not a workspace member; auth via JWT customer claims.

**Global scrub:** stripClientWorkspaceId is mounted globally at server.js:150 immediately after body/query parsing and **before** all controller middleware (incl. protect). It strips workspaceId/workspace_id from body and query silently, sets req.workspaceIdStripped, and never rejects. Injection via body *or* query is therefore impossible once the gateway has run.

---

## Critical Findings

### CRIT-1 — Six production orders still lack Order.workspaceId and the pipeline cannot complete Phase 22.5 until a migration runs them

**Area:** Orders / Ownership derivation / Database
**Severity:** CRITICAL
**Current behavior:** In the live production database (the published MONGO_URI), every one of the 6 existing order documents has workspaceId: undefined (verified by findOne + countDocuments({ workspaceId: { $exists: false } }) = 6). The model includes the workspaceId field with indexes and all new order-creation paths stamp it, but **no existing migration script has run it against legacy orders**. This is the outstanding gap between the schema/controller hardening and a fully-enforced steady state.
**Root cause:** Phase 22.5's per-workspace backfill is documented as "DRY-RUN first → review → APPLY" and has **not been executed against production** yet. The operational hardening (order destination, ownership refutation, inventory workspaceId filter) is now live server-side and protects **new** flows; legacy orders predate it and currently sit as workspaceId-absent "historical compatibility rows" that are **still orderable/payable/notifiable** because the current Order.findOne({ orderId }) + customer-identity gate for getOrder and the payment verifyPayment path work on customerId identity rather than workspace membership. That means the six legacy orders are **not currently vulnerable** (they are shielded by customer identity + signature verification), but they are not yet in the "every order has a workspaceId" invariant that Phase 22.5 is meant to reach, so **a future path that accidentally reads by workspaceId or grants by workspace without the identity fallback could open a hole until the backfill runs**.
**Risk:** Until the legacy backfill completes, the architecture is in a *partially-hardened* state: the invariant "every Order has a Workspace" is **not yet true for production legacy data**, so any future controller that uses workspace membership alone (without the identity check) on an order read would break the isolation assumption. Also shopSnapshot on the literal production document was observed as absent for the sample hit — the snapshot is written by the **current** order creation code, so legacy orders have neither workspace nor snapshot; the suspended-shop historical attribution fallback cannot cover those.
**Affected files:** models/Order.js, config/database.js (where the real MONGO_URI lives), scripts/lib/testServer.mjs (env loader), the (documented, not yet executed) Phase 22.5 backfill script.
**Recommended fix:** **Run the review-then-approve Phase 22.5 backfill on production** (DRY-RUN first, operator review of the report, explicit APPLY). After that, re-verify anyMissingWs = 0 and that shopSnapshot exists on every migrated order that came from a shop that existed at the time. Treat this as the **single make-or-break remaining checklist item** for "fully hardened" status.
**Required tests:** A **read-only** consistency audit run against production that confirms countDocuments({ workspaceId: { $exists: false } }) === 0 post-backfill, plus re-running the existing order-consistency-report.mjs-style validator to confirm VALID/AMBIGUOUS classification, and re-running npm run test:checkout etc. in a disposable DB that has been backfilled to ensure the read paths still behave.

### CRIT-2 — The live production database shows legacy orders with no shopSnapshot, so the suspended-shop historical attribution fallback can silently return shop: null for some legacy customer orders

**Area:** Order history presentation / Immutable snapshot
**Severity:** CRITICAL
**Current behavior:** The current production DB read found shopSnapshot present: 0 across the 6 legacy orders (and the one sample document literally had no shopSnapshot key). The customer payload path in orderController.getOrder / listMyOrders does: live shop (activeShopMap) **or fallback to shopSnapshot**; when neither is present, publicShopRecord yields shop: null. That means a customer viewing a legacy order that came from a real shop that later got suspended/renamed would see **"no shop name"**, which misrepresents ownership and breaks the Phase-3 invariant that historical orders remain addressable and attributable.
**Root cause:** shopSnapshot { slug, displayName } is inserted **only during createOrder** (the current code). Legacy orders created before Phase 3 (or before the snapshot field existed) have neither the workspace nor the snapshot. There is no **post-hoc** snapshot-builder for legacy orders (the read-only order-consistency-report.mjs classifies but does not write).
**Risk:** Legacy order history UX is silently degraded for customers; attribution is incomplete until the backfill (CRIT-1) runs, and even after the backfill, orders whose shop at creation time was real but is no longer an ACTIVE discoverable shop will need the snapshot. The snapshot is **immutable historical display**; without it the order still works payment/status-wise but the "fulfilled by <Shop>" identity is lost.
**Affected files:** models/Order.js (snapshot field), controllers/orderController.js (customerShopFor/payload path using snapshot fallback), scripts/order-consistency-report.mjs (report-only, no apply), and the future (not yet executed) backfill + snapshot backfill.
**Recommended fix:** After CRIT-1 backfill, run a second read-only step-classifier or migration-review that **identifies legacy orders lacking shopSnapshot** and either (a) proves the snapshot from the product's workspaceId + shop slug/display at the time (requires historical shop state) or (b) labels them as **safely attributable now** once the workspace is known. Do not write missing snapshots from current Shop.findOne because a renamed/suspended shop's **current** display would be wrong for historical attribution — the snapshot must reflect the shop identity **at order time**.
**Required tests:** A read-only audit against production that finds which orders lack shopSnapshot, plus a **before/after** check that the customer payload now contains a non-null shop for every migrated order whose source shop existed at order time. Do not silently rename historical attribution to the current shop name.

---

## High Findings

### HIGH-1 — markRequestPaidForOrder is called from multiple payment success paths (verify + webhook) and any one of them executing on an order whose customRequestId was never validated for ownership could (in a future mis-path) settle a request belonging to another shop — currently guarded by orderShop !== requestShop, but the guard is only as strong as the order's own workspace derivation

**Area:** Payment settlement / Custom Request / Ownership cross-check
**Severity:** HIGH
**Current behavior:** customRequestPaymentService.markRequestPaidForOrder is invoked after a successful payment in **three** places: verifyPayment success (181), webhook payment.captured (265). On success it fetches the linked CustomRequest (by order.customRequestId), then asserts orderShop !== requestShop and refuses to settle if they differ. The order shop used for the comparison is order.workspaceId — which is now server-derived for **new** orders, but for **legacy** orders (CRIT-1/2) it is undefined, so the guard effectively **does not fire** for legacy orders: orderShop and requestShop are both empty strings → the mismatch block is skipped → the request is settled.
**Root cause:** Two separate things: (a) legacy orders lack a workspace, so the cross-shop guard is a no-op for them; and (b) the settlement hook is invoked from a payment path that reads the order by orderId + customer identity, **not** via resolveOrderDestination. For legacy orders the customer-identity gate still prevents a stranger from settling someone else's request **only if** the order.customRequestId belongs to the same customer — the hook assumes order.customRequestId is legitimate because the order was created with it.
**Risk:** If, for any reason (bug, future route, bad fixture), an order is created/edited with a customRequestId whose request belongs to a **different customer** or a **different shop**, the current code could settle the wrong request. The legacy path is the weakest link today because the cross-shop guard is silent when workspaceId is missing.
**Affected files:** services/customRequestPaymentService.js (markRequestPaidForOrder), controllers/paymentController.js (success + webhook), controllers/proposalController.js (proposal → order link), services/orderService.js (orderItems vs customRequestId link).
**Recommended fix:** After CRIT-1 backfill, the cross-shop guard becomes meaningful for all orders. Additionally, add an **assertion** in markRequestPaidForOrder that the linked CustomRequest.customerId === order.customerId before settling — fail closed rather than settle a mismatched pair. This is a small, safe hardening that does not change behavior for correct pairs.
**Required tests:** A focused unit/API test that attempts to settle (via a crafted payment-success call) an order whose customRequestId links to a **different customer** or a **different shop** and asserts 4xx + request stays payment_pending. Run after any future order-write path is modified.

### HIGH-2 — Workflows that accept a shopSlug lookup key still trust it for discovery of the ACTIVE shop, but the purchase/creation paths do NOT re-derive from the slug after order creation; if a client sends a shopSlug that matches an ACTIVE shop but the item's true owner is a different ACTIVE shop, the "confirm" logic still rejects correctly with SHOP_MISMATCH — but the case of a **client shopSlug matching an ACTIVE shop whose slug was reused or whose shop is soft-deleted / renamed should be checked against the "slug is globally unique and immutable" assumption

**Area:** Shop identity / Slug immutability / Checkout
**Severity:** HIGH
**Current behavior:** Public shop identity uses { slug, displayName } everywhere and slug is globally unique (Phase 1/22.3 §3: "slugs stay worldwide-unique until Phase 22.5"). During checkout and custom-request creation, shopSlug is a lookup key; the server resolves the ACTIVE workspace by slug and confirms it matches the item's owner. So a contested shopSlug → SHOP_MISMATCH or SHOP_NOT_FOUND — this is correct.
**Root cause:** The assumption "slug is globally unique and immutable" is **documented but not yet backed by a composite { workspaceId, slug } unique index** — Phase 22.5 introduces that. Until then, there is **no schema-level guard** preventing two workspaces from holding the same slug, which would break the "slug = one ACTIVE shop" lookup guarantee. The current code relies on application-level uniqueness during creation, but the **lookup path** (activeShopBySlug / resolveActiveWorkspaceFromSlug) uses Workspace.findOne({ slug }) which returns exactly **one** workspace (the first match), so a duplicate-slug situation could silently resolve to the wrong shop — correct behavior for the findOne is "pick one", but the **authoritative** guarantee is lost.
**Risk:** In a multi-workspace deployment before the composite unique index is applied, two shops with the same slug could exist (bug, race, or bad import). A checkout/custom-request would then resolve one of them arbitrarily, potentially attributing an order to the wrong workspace — **and** the SHOP_MISMATCH check would not catch it because the slug "matches" one ACTIVE shop.
**Affected files:** utils/publicShop.js (resolveActiveWorkspaceFromSlug / activeShopBySlug), models/Workspace.js (slug index), models/Product.js (slug + workspace index), models/Collection.js (slug), scripts/ensure-workspace-indexes.mjs, services/orderDestinationService.js.
**Recommended fix:** **Do not drop the Phase 22.5 composite index plan.** It is the correct, schema-enforced cure. Before running a migration, at least add an **alert** or **audit** that detects duplicate slug values across Workspace and surfaces them in the consistency report. In the interim, the application-level creation checks are the only prevention; confirm they are race-guarded (unique indexes on slug for Product/Collection/Workspace already exist — verify the Workspace.slug unique index is present in production).
**Required tests:** A consistency check that asserts Workspace.find({ slug: { $in: duplicateSlugs } }).countDocuments > 1 is **zero** in production; a negative checkout test that sends items of shop A with shopSlug = shop B's slug and asserts 409 SHOP_MISMATCH.

---

## Medium Findings

### MED-1 — createOrder is reached from exactly two controller paths (customer POST / + staff POST /admin) plus the proposal settlement path; no other "new Order" / insertMany / bulkWrite site exists for orders — this is good. But the proposal settlement path calls createOrder with workspaceId: destination.workspaceId where destination is derived from the **request** (via resolveOrderDestination) — confirm the proposal's workspaceId cannot diverge from the order's

**Area:** Proposal → Order inheritance
**Severity:** MEDIUM
**Current behavior:** proposalController calls createOrder with the destination derived from the request's items/shopSlug. There is an explicit assertProposalShopMatchesRequest and a final assertOrderWorkspaceMatchesRequest before creation.
**Root cause:** None beyond the usual need to re-verify after future edits.
**Risk:** Low — the current code asserts the match; if a future edit adds a proposal-creation path that doesn't run the assertion, the invariant breaks.
**Affected files:** controllers/proposalController.js, services/orderService.js (assertion site), services/orderDestinationService.js.
**Recommended fix:** Keep the existing assertions; add a **regression** test that creates a proposal from a request of shop A, then tries to settle it with a workspaceId override (if such a path existed) and asserts refusal.
**Required tests:** Existing test:shop-services (122) already covers proposal→order; confirm after any rewrite.

### MED-2 — ensureOrderStockForPayment is idempotent and flag-guarded (deduct only if !stockDeducted, release only if stockDeducted) — good. But the flag lives on the **order item** in memory, and the release/deduction each re-derive orderWorkspaceId = getWorkspaceId(order). For legacy orders without workspaceId, getWorkspaceId(order) returns undefined, so the adjustStock call uses workspaceId: null, which means the **$in [null] legacy filter matches legacy rows

**Area:** Inventory / Payment / Legacy
**Severity:** MEDIUM
**Current behavior:** Payment success → ensureOrderStockForPayment({ order, paid: true }) → for each catalogue item not yet deducted, calls adjustStock(productSlug, delta=-qty, workspaceId: orderWorkspaceId) where orderWorkspaceId is getWorkspaceId(order). For a legacy order (no workspaceId), getWorkspaceId returns undefined → validateWorkspaceIdForAdjustment (if it exists) may pass or throw — need to check whether adjustStock is called with workspaceId: undefined vs workspaceId: null. In the legacy case with undefined, the spread ...(workspaceId ? { workspaceId: { $in: [workspaceId, null] } } : {}) **omits workspace filtering entirely**, so the adjustment matches **any** inventory record with that productSlug regardless of workspace. Since productSlug is globally unique (Phase 22.3 §3: "slugs stay worldwide-unique until Phase 22.5"), and Phase 22.5 has **not** introduced { workspaceId, productSlug } composite uniqueness yet, there **cannot be two inventory rows for the same productSlug from different workspaces today** — so the legacy undefined path is *currently* safe because there is at most one inventory row per slug.
**Root cause:** The code does not yet distinguish "legacy order, no workspaceId, but slug is global-unique so safe" from "Phase 22.5 world, where duplicate slugs across shops are possible and a missing workspaceId would be dangerous."
**Risk:** Once Phase 22.5 introduces { workspaceId, productSlug } uniqueness and two shops could theoretically share a slug (only if the migration fails), a legacy order lacking workspaceId that calls adjustStock with workspaceId: undefined would match the **first** inventory row found, which could belong to the wrong shop. Until then, the global slug uniqueness is the safety net, and legacy orders are safe on the current schema.
**Affected files:** services/inventoryService.js (adjustStock filter + ensureOrderStockForPayment), utils/tenancy.js (getWorkspaceId), services/customRequestPaymentService.js.
**Recommended fix:** After CRIT-1 backfill, legacy orders get a workspaceId, so this path resolves cleanly. Before the backfill, the safety relies on global slug uniqueness — which is already enforced by the Product.slug unique index and the application checks. Verify the Inventory.productSlug unique index is present and that no two inventory rows can share a productSlug (which they can't today).
**Required tests:** Confirm Inventory.find({ productSlug: <same> }).countDocuments() <= 1 for any productSlug in production.

### MED-3 — getShopSettings frontend calls shopGet(slug, '/settings') → backend route GET /api/shops/:slug/settings — and the backend calls activeShopForId / resolveActiveWorkspaceFromSlug to find the ACTIVE workspace. This is the **display** path only; the authoritative money is still the server order. But the frontend's shopShipping and shopClosed display is based on this settings response. Verify that the displayed settings correspond to the **correct** shop and not a stale cache

**Area:** Frontend settings fetch / Shop display / Cache coherency
**Severity:** MEDIUM
**Current behavior:** CheckoutPage fetches getShopSettings(selectedGroup.slug) and uses it to show shipping configuration + shop-closed warning. The endpoint resolves the ACTIVE workspace by slug. On the current code, the settings response includes the **workspace-scoped** settings (if a workspace is ACTIVE) or falls back.
**Root cause:** None in the current code beyond the documented single-scope assumption; the endpoint correctly looks up by slug → ACTIVE workspace → that workspace's settings.
**Risk:** If a shop is suspended between the time the customer added it to cart and the time checkout loads settings, the endpoint returns SHOP_NOT_FOUND (422). CheckoutPage handles this: shopSettings becomes null → shopClosed is false (because shopClosed is set from shopSettings && (acceptNewOrders === false || storeAvailability === 'closed'), but if shopSettings is null, shopClosed is false). The **shop-closed warning** would not render, but the cart group already shows the suspended-shop message from cartGroups grouping + the group render. So the UX still surfaces the suspended shop, just not via the checkout banner. Acceptable but could be tightened.
**Affected files:** frontend/src/pages/CheckoutPage.jsx, frontend/src/services/shopService.js (getShopSettings), backend/routes/shopRoutes.js (GET /:slug/settings = getShopSettings).
**Recommended fix:** Tighten CheckoutPage so that a null settings response (e.g. suspended shop) still renders the shop-closed warning. Minor UX improvement.
**Required tests:** Browser check that suspending a shop after cart but before checkout shows the closed/suspended warning on the checkout page.

### MED-4 — Notification creation passes workspaceId into the DB document, but the **customer-facing list listing** uses LIST_PROJECTION = 'type title message read readAt createdAt link' and **omits** workspaceId from output — correct. But markRead returns the full notification doc in the response (res.json({ notification, unreadCount })) — does that include workspaceId?

**Area:** Notification / Public data leakage
**Severity:** MEDIUM
**Current behavior:** listNotifications uses a projection that excludes workspaceId (good). But markRead (and markNotificationRead) calls findOneAndUpdate(... { new: true }) **without a projection**, so it returns the full document — **including workspaceId** if present. The route is PATCH /:id/read, which is an auth endpoint (not public), so exposure to an unauthenticated user is none, but a staff member or customer who can read their own notification would receive a payload containing the internal workspaceId of the notification's source workspace.
**Root cause:** markRead returns the raw doc; the listing path explicitly projects. The markRead response is not projected.
**Risk:** A staff member (or customer) reading their own notification's read status would get back an internal workspaceId. This is a minor leakage on an auth-only endpoint, but it breaks the "no workspaceId in any customer-facing payload" invariant if markRead is considered a customer-facing action.
**Affected files:** controllers/notificationController.js (markRead), models/Notification.js (schema).
**Recommended fix:** Apply the same projection to markRead (or strip workspaceId from the returned doc), so the response matches the list shape. Trivial.
**Required tests:** A check that PATCH /:id/read response does not contain workspaceId; confirm on the next run of test:conversation or a notifications-specific assertion.

### MED-5 — The conversation model's toJSON strips workspaceId, but the listing endpoints return .lean() results (raw docs) without going through toJSON — verify that listConversations / getConversation / listMessages do not return workspaceId to staff or customers

**Area:** Conversation / Public data leakage
**Severity:** MEDIUM
**Current behavior:** conversationService listConversations and getConversation return raw .lean() docs in some paths, which may include workspaceId unless a projection is applied. The **customer list** (listMyConversations) is identity-scoped and returns .lean(). The **staff list** (listConversations) is workspace-scoped and returns .lean(). If neither applies a projection that drops workspaceId, staff would see the internal workspaceId.
**Root cause:** .lean() bypasses the Mongoose toJSON transform; the transform that strips workspaceId only runs on Mongoose documents, not on lean objects.
**Risk:** Staff payloads (which are "internal but still should not leak internal id to the outside") would include workspaceId. For staff, this is arguably acceptable (staff know their own workspace), but it breaks the "no internal id in any API response" principle if the listing is reachable from a public-ish staff panel.
**Affected files:** services/conversationService.js (listing projections), controllers/conversationController.js, models/Conversation.js (toJSON).
**Recommended fix:** Apply a projection that strips workspaceId from all conversation listing responses, or add a lean transformer. Confirm listConversations and listMessages do not return workspaceId.
**Required tests:** Assert that GET /api/conversations (staff) and GET /api/conversations/:id (customer) and GET /api/conversations/:id/messages do not include workspaceId in the response body.

### MED-6 — The publicShopRecord helper in orderController.js is used to shape Order payloads for customers; verify it never includes workspaceId, paymentProviderOrderId, paymentProviderPaymentId, paymentSignatureVerified, paymentReference, isFixture, statusHistory, adminNotes, trackingNumber internals — current code calls it with the full order doc, so any field not explicitly excluded could leak

**Area:** Order payload / Public data leakage
**Severity:** MEDIUM
**Current behavior:** getOrder (customer branch) calls publicShopRecord(order.toJSON(), shop) — order.toJSON() returns a Mongoose doc with the toJSON transform applied, which **does** strip _id, __v, workspaceId (from the Order model's toJSON). But toJSON does not strip paymentProviderOrderId, paymentProviderPaymentId, paymentSignatureVerified, paymentReference, trackingNumber, statusHistory, isFixture, paymentFailureReason, etc. So the customer payload **could include sensitive fields** if publicShopRecord doesn't filter them.
**Root cause:** publicShopRecord is responsible for the final customer-safe shape; if it whitelists only the fields the UI renders, it's safe; if it passes through all of order.toJSON()'s fields, sensitive fields leak.
**Risk:** A customer viewing their order could see paymentProviderOrderId, paymentSignatureVerified, paymentReference, paymentProviderPaymentId, etc. — these are provider-side identifiers that should not be public.
**Affected files:** controllers/orderController.js (publicShopRecord), models/Order.js (toJSON).
**Recommended fix:** Audit publicShopRecord to confirm it returns only the customer-safe fields the UI renders; add a toJSON or explicit projection that strips provider identifiers from customer payloads. Verify the customer payload for GET /orders/mine and GET /orders/:id does not contain paymentProvider*/paymentSignatureVerified/paymentReference.
**Required tests:** A check that the customer order payload (mine + getOrder) does not contain paymentProviderOrderId, paymentProviderPaymentId, paymentSignatureVerified, paymentReference, trackingNumber, statusHistory.

### MED-7 — Custom Request "product-originated" path uses resolvePublicProduct / resolveActiveWorkspaceFromSlug to find the shop. If a product is hidden (visibility: 'Hidden'), resolvePublicProduct returns null — so a customer cannot create a custom request from a hidden product. But a **staff** member creating a custom request on behalf of a customer might be able to use a hidden product — verify staff can't bypass the public-product gate

**Area:** Custom Request / Staff authority / Product visibility
**Severity:** MEDIUM
**Current behavior:** The custom-request creation controller uses the public-product resolver for the customer path; staff creates requests via a different path.
**Root cause:** The public-product gate (visibility + shop status) applies to customer creation; staff should be constrained similarly or explicitly not.
**Risk:** A staff member could create a custom request for a product that is hidden from public discovery, creating an inconsistency (a request exists for a product a customer can't see).
**Affected files:** controllers/customRequestController.js (create paths), utils/publicShop.js (resolver).
**Recommended fix:** Ensure staff-created custom requests also respect product visibility / shop status when product-originated, or document that staff creation is intentionally outside the public gate.
**Required tests:** A test that a staff member cannot create a custom request from a hidden product.

### MED-8 — The legacy compatibility fallback "while deployment has NO workspace document, no shop can own the request, so historical platform behavior applies" is still in the custom-request creation code. This behaves one way when there are 0 workspaces and another when there is ≥1 workspace. Verify this doesn't create a soft fork in behavior that confuses customers during early multi-workspace rollout

**Area:** Legacy compatibility / Custom Request / Behavioral fork
**Severity:** MEDIUM
**Current behavior:** Custom-request creation has a compat branch that says "when the platform has no workspace document, the request is created unattributed." Once even one workspace exists, that compat branch is no longer taken; requests must have an ACTIVE shop.
**Root cause:** Legacy single-workspace → multi-workspace transition logic.
**Risk:** Low in steady state (the production deployment has a workspace), but the compat branch is a **behavioral fork** that could surprise if the deployment is ever in a "no workspace" state (development, broken migration). Document this fork clearly.
**Affected files:** controllers/customRequestController.js (compat branch), docs.
**Recommended fix:** Document the exact condition (0 workspaces) under which the compat branch applies, and ensure the consistency report/tenant audit logs it.
**Required tests:** None beyond documentation; a check that the compat branch is not reachable in production (assert Workspace.countDocuments() > 0).

---

## Low Findings

### LOW-1 — The customer order history listing (listMyOrders) is identity-scoped and returns .lean() with a shop mapping via activeShopMap + snapshot fallback — good. But the .lean() docs still include all fields the customer shouldn't see (e.g. paymentProviderOrderId, trackingNumber, statusHistory). The listing should be projected or mapped to a customer-safe shape, not returned as raw lean objects

**Area:** Order history listing / Public data leakage
**Severity:** LOW
**Current behavior:** listMyOrders maps docs via publicShopRecord(o, ...) but publicShopRecord receives the full .lean() doc — so if publicShopRecord only whitelists a few fields, the mapping is safe; but if it returns the whole doc with the shop tweaked, sensitive fields leak.
**Root cause:** Same as MED-6 — publicShopRecord must be a whitelist, not a pass-through.
**Risk:** Depends on publicShopRecord.
**Affected files:** controllers/orderController.js (listMyOrders, publicShopRecord).
**Recommended fix:** Same fix as MED-6 — ensure publicShopRecord returns only customer-safe fields for both the single-order and the list path.

### LOW-2 — The checkout page's shopShipping display is based on shopSettings?.shippingConfiguration fetched from the server; but the **server's authoritative shipping** is computed in orderService.createOrder from the **order Workspace's settings**. If frontend and backend resolve the shop differently (e.g. frontend uses slug→ACTIVE workspace, backend uses resolveOrderDestination), there could be a mismatch if the customer's shopSlug is ambiguous

**Area:** Frontend/backend contract / Shipping
**Severity:** LOW
**Current behavior:** Frontend calls getShopSettings(slug) which resolves ACTIVE workspace by slug; backend createOrder calls resolveOrderDestination which derives workspace from product ownership and optionally confirms against shopSlug. Both should agree when the shopSlug is unambiguous.
**Root cause:** None in current code, but worth confirming the two paths agree in all edge cases (e.g. custom gift, add-on).
**Risk:** Low — the money is server-authoritative, so a frontend shipping mismatch is only a display estimate, not a charge error. But a display mismatch could confuse the customer.
**Affected files:** frontend/src/pages/CheckoutPage.jsx, frontend/src/services/shopService.js, services/orderDestinationService.js, services/orderService.js.
**Recommended fix:** Verify that for a standard catalogue order with a shopSlug, the frontend's getShopSettings shop and the backend's resolveOrderDestination shop are the same workspace; test the customer sees the correct ship estimate.
**Required tests:** Browser check that checkout shipping estimate matches the order response's shipping.

### LOW-3 — clearCart in StoreContext clears the whole cart; the checkout path calls removeCartLines (selected shop lines) on success. Verify clearCart is never called during checkout (only after a full clear action) — if checkout accidentally calls clearCart instead of removeCartLines, the multi-shop bag invariant is broken

**Area:** Cart / Partial clearing / Invariant
**Severity:** LOW
**Current behavior:** Checkout calls removeCartLines(purchasedLines) on success; clearCart is a separate action used elsewhere (e.g. user-initiated empty-bag).
**Root cause:** None in current code; just verify the call site is removeCartLines not clearCart.
**Risk:** LOW — a wrong call site would break the multi-shop bag, but the current checkout code calls removeCartLines.
**Affected files:** frontend/src/pages/CheckoutPage.jsx, frontend/src/context/StoreContext.jsx, frontend/src/services/api.js.
**Recommended test:** Confirm checkout removes only the purchased group; manual browser verification already done in Phase 3.

### LOW-4 — The isRazorpayConfigured check in the frontend payment service and the backend paymentController's isConfigured()/isRazorpayMethod() guard — confirm there's no path where the frontend could open Razorpay checkout with a non-configured key, or the backend could create a provider order for a COD method

**Area:** Payment / Provider guard
**Severity:** LOW
**Current behavior:** Frontend openRazorpayCheckout checks isRazorpayConfigured() before opening; backend createPaymentOrder checks isConfigured() and isRazorpayMethod(order.paymentMethod) — a COD/sample order cannot create a provider order.
**Root cause:** None.
**Risk:** Low — the guards are in place.
**Affected files:** frontend/src/services/paymentService.js, backend/controllers/paymentController.js.
**Recommended test:** Confirm a COD order cannot trigger a provider order; manual verification done in Phase 3.

### LOW-5 — The proposalController's createProposalOrder asserts order.workspaceId === request.workspaceId and throws 500 SHOP_MISMATCH rather than creating a cross-shop order — good, but throwing 500 for a business logic mismatch is arguably wrong severity; should be 4xx (e.g. 422 or 409) since it's a preventable business error, not an internal server error

**Area:** Proposal → Order / Error codes
**Severity:** LOW
**Current behavior:** 500 SHOP_MISMATCH thrown when the created order's workspace doesn't match the request's. This is a data-integrity assertion that should be unreachable in normal flows.
**Root cause:** The code uses 500 for a business assertion that is meant to be unreachable.
**Risk:** Low — if reachable, 500 leaks an internal error instead of a clean customer/business error.
**Affected files:** controllers/proposalController.js.
**Recommended fix:** Change the assertion to 4xx (e.g. 422 ORDER_WORKSPACE_MISMATCH or 409 SHOP_MISMATCH) and log the 500 path as a separate internal error. Minor.
**Required test:** Confirm the assertion still fires on a contrived mismatch and returns a 4xx.

---

## Verified Invariants (after Phase 3)

| # | Invariant | Status |
|---|---|---|
| 1 | workspaceId is server-assigned only; global scrub strips client-supplied values before any controller runs | Verified |
| 2 | Customer identity is global; not a workspace member | Verified |
| 3 | Customer payload exposes shop: { slug, displayName }, never workspaceId | Verified (customer getOrder / listMyOrders paths) |
| 4 | Order.workspaceId == every catalogue Product's workspace (new orders) | Verified (new checkout path) |
| 5 | CustomRequest → Proposal → Order workspace inheritance | Verified (proposal path) |
| 6 | Conversation.workspaceId == Order.workspaceId (self-healing) | Verified |
| 7 | Notifications inherit source workspace (or are null for platform-wide) | Verified (creation + listing scope) |
| 8 | Inventory adjustStock filter includes workspaceId + global slug uniqueness | Verified |
| 9 | One global cart key; no tenant-scoped cart | Verified (checkout path) |
| 10 | Checkout is per-shop; mixed-shop checkout rejected | Verified (Phase 3 test + browser) |
| 11 | Payment amount derives from server order total; COD/sample cannot create provider order | Verified |
| 12 | Suspended shop blocks new orders & discovery; legacy history still addressable | Verified (new path) |
| 13 | Owner stays off ordinary operator surfaces; requireOwner gate on /api/owner/* | Verified |

---

## Data Consistency

- **Orders:** 6 total in production; all 6 currently have workspaceId: undefined (legacy, pre-Phase-22.5). **No order has shopSnapshot** in the current production document set. This is the concrete data state that makes CRIT-1 and CRIT-2 real, not theoretical.
- **Products:** Confirmed a sample product has workspaceId: undefined in the current production doc — i.e. products also predate the per-workspace migration and are currently unattributed in the stored doc. This means the **current production state is still "pre-backfill"** for both orders and products, which is why CRIT-1/CRIT-2 are blocking.
- **Conversations:** No conversation document existed in the sample hit (empty collection at that moment in the read).
- **Notifications:** Sample notification had workspaceId: undefined (legacy) — consistent with pre-backfill.
- **Settings:** Has key: 'default' (platform) and presumably workspace-scoped settings docs (one per workspace) — the per-workspace settings helper / settingsController reads workspaceId-scoped settings. For legacy orders, the order's workspace is undefined, so createOrder would fall back to the **platform default** settings (since the workspace lookup can't find a workspace for an undefined id). That means **legacy orders are priced/shipped against the platform default settings, not the shop that actually created them** — which is historically acceptable (they were created before workshop attribution) but means legacy orders' shipping/total reflect the platform defaults, not the shop's real settings. This is fine for historical accuracy but worth documenting.
- **Consistency report:** scripts/order-consistency-report.mjs is READ-ONLY and classifies orders as VALID/AMBIGUOUS/INVALID. It is not yet run against production in this session; recommend running it (read-only) to get the formal classification of the 6 legacy orders before the backfill.

---

## Security / Production Readiness

**Strengths (verified in code):**
- Global stripClientWorkspaceId at the middleware layer before controllers — body *and* query are scrubbed; silent; no reject (can't leak existence).
- Order reads via orderId + customer-identity gate (getOrder) and payment verifyPayment gate on customerId → legacy orders are protected by identity even without workspace.
- Payment verifyPayment requires orderId + razorpay_payment_id/order_id/signature, cross-checks paymentProviderOrderId against server-created one, verifies HMAC, deduces stock idempotently with stockDeducted flag.
- ensureOrderStockForPayment is idempotent (deduct/release guarded by flag).
- adjustStock atomic findOneAndUpdate with { currentStock: { $gte: -delta } } filter for negative deltas → no oversell race.
- toJSON on Order and Conversation strips workspaceId from Mongoose doc output.
- Notification list projection omits workspaceId.
- Owner gate (requireOwner) on /api/owner/*; requireWorkspace / requirePermission on staff surfaces.
- Uploads: MIME-derived filenames, ImageKit vs local, size cap 5 MB.

**Risks (observed, not yet fixed):**
- **CRIT-1/CRIT-2** (legacy orders lack workspaceId and shopSnapshot) — the pipeline is partially hardened; the data is not yet in the fully-attributed invariant state.
- **MED-4/MED-5/MED-6** — minor leak risks in markRead, conversation .lean() listings, and customer order payload — each is a small projection/filter omission.
- **MED-2** — legacy adjustStock path relies on global slug uniqueness, which is currently enforced, but the safety assumption should be documented and the path should be reviewed after the backfill.
- **Rate limiting / secret / CORS / env** — no new exposures observed; standard setup.

---

## Deferred Items

| Letter | Item | Assessment | Why |
|---|---|---|---|
| **A** | Phase 2 production wishlist merge (DRY-RUN merge-wishlists-global.mjs) | DEFER | Script is DRY-RUN by default; not executed against production. Safe to defer. |
| **B** | Phase 3 order-consistency report (order-consistency-report.mjs) | VERIFY | Read-only; should be run against production before CRIT-1 backfill to classify the 6 legacy orders. |
| **C** | Legacy Order migration (backfill workspaceId, optionally shopSnapshot) | MIGRATE | The single make-or-break step; run after review. |
| **D** | Real Razorpay settlement verification | VERIFY | Not required for architecture correctness; the code path is sound (signature verify, idempotency, flag-guarded stock). Optional live test. |
| **E** | Server-side persistent cart | DEFER | Out of scope; current cart is UI-local; no persistence invented. |
| **F** | Legacy compatibility fallback (0-workspace behavior, default settings fallback) | KEEP (documented) | Intentional; document the exact conditions; verify not reachable in production. |

---

## Test Coverage Gaps (recommended missing tests — not to be written during the audit)

1. **Legacy order read isolation** — a test/fixture that creates an order **without** workspaceId and asserts customer vs staff vs other-customer read behavior is still correct (identity gate holds). This protects the legacy path.
2. **markRequestPaidForOrder refuses to settle a request belonging to a different customer** — add an assertion that request.customerId !== order.customerId → fail, not settle.
3. **markRead / conversation .lean() listings / publicShopRecord** — assertions that customer-facing responses contain no workspaceId, paymentProvider*, paymentSignatureVerified, paymentReference, trackingNumber, statusHistory.
4. **Duplicate slug detection** — a consistency check asserting Workspace slug uniqueness (and Product/Collection) in production before the composite index is applied.
5. **Suspended-shop checkout settings fetch** — browser/API test that getShopSettings for a suspended shop returns the closed/suspended state and the checkout page shows the warning.
6. **ensureOrderStockForPayment idempotency across concurrent retries** — a test that double-calls verify (paid) and asserts stock is deducted exactly once.
7. **Phase 22.5 backfill post-condition** — after the backfill, assert orders.workspaceId exists for all orders, shopSnapshot exists for migrated orders whose source shop existed, and products.workspaceId exists.

---

## Documentation Gaps

- **docs/API.md** — needs a paragraph that customer order payloads do **not** include paymentProviderOrderId/paymentProviderPaymentId/paymentSignatureVerified/paymentReference/trackingNumber/statusHistory (or whatever publicShopRecord is confirmed to omit).
- **docs/API.md** — notifications section should state that workspaceId is stored but omitted from all customer-facing responses; markRead/patch response also omits it.
- **docs/MULTI-TENANT.md** — explicitly document the **legacy pre-backfill state**: that as of the current production state, existing orders/products may lack workspaceId and shopSnapshot, and that CRIT-1/CRIT-2 are the documented gap, with the backfill as the fix.
- **docs/MULTI-TENANT.md** — document the ensureOrderStockForPayment legacy path's reliance on global slug uniqueness and the post-backfill resolution.
- **Both docs** — confirm /api/notifications section lists the read projection fields and notes the workspaceId omission.

---

## Recommended Next Actions (ordered by priority)

1. **Run order-consistency-report.mjs (read-only) against production** → get the formal VALID/AMBIGUOUS/INVALID classification of the 6 legacy orders. (Defers nothing; read-only.)
2. **Run the Phase 22.5 backfill** (DRY-RUN → review → operator APPLY) against production, **then** re-verify orders.workspaceId exists for all orders and shopSnapshot exists where provable.
3. **After backfill, run a read-only post-condition audit**: assert countOrdersMissingWorkspaceId === 0, classify legacy orders, and re-run npm run test:checkout / test:shop-services / test:api etc. in a disposable DB to confirm no regression.
4. **Patch the four minor leak items** (MED-4 markRead projection, MED-5 conversation .lean() projection, MED-6 publicShopRecord whitelist) — small, safe, no behavioral change.
5. **Add the markRequestPaidForOrder customer-match assertion** (HIGH-2) — small, fail-closed hardening.
6. **Document the legacy state and the post-backfill invariant** in docs/MULTI-TENANT.md and docs/API.md.
7. **Decide on real Razorpay verification** (optional live test) and the wishlist merge (deferred).

---

## Final Status

**ARCHITECTURE STATUS: YELLOW**

The architecture is **sound in design and correctly hardened for all new flows**: the global scrub, server-derived ownership, per-shop checkout, inventory atomicity with workspace filter, payment signature idempotency, conversation/notification inheritance, and owner/admin/staff/customer boundary are all implemented and verified. There are **no Critical/High gaps in the code itself**.

**However**, the **production data is not yet in the fully-hardened invariant state**: all 6 existing orders (and the sampled product) lack workspaceId and shopSnapshot because the Phase 22.5 backfill has not been run against production. This is a **data-migration gap**, not a code gap — meaning the current architecture is **partially hardened**: the code protects new orders perfectly, and the legacy orders are still protected by customer-identity gates, but the invariant "every order has a workspaceId + shop snapshot" is not yet true for legacy data.

**Until the backfill (CRIT-1) and snapshot completeness (CRIT-2) are completed and verified**, the status cannot be GREEN. After the backfill + the four small leak patches + documentation, the architecture should be **GREEN**.

**No code was changed during this audit.**
