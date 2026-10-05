/**
 * PHASE 1 (marketplace identity) — the ONE canonical public Shop contract.
 *
 * A Shop is the customer-facing representation of a Workspace (the internal
 * tenant). Every public surface that answers "which shop does this belong to?"
 * must answer with the SAME shape:
 *
 *     shop = { slug, displayName }
 *
 * and nothing else. The internal tenant identifier (`workspaceId`) is never
 * part of a public payload; neither is `primaryAdminId`, `isBootstrap`,
 * membership, staff or owner data.
 *
 * `status` is deliberately NOT part of the contract: a non-ACTIVE workspace is
 * not a discoverable shop at all, so it resolves to `null` (excluded from the
 * catalogue, 404 on direct lookup) rather than to a shop with a status flag.
 *
 * This module exists so no controller invents its own projection: products,
 * collections, the shop directory and the wishlist all call these helpers.
 */
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import { SLUG_RE } from './workspaceSlug.js';

/** The public projection of a Workspace. `null` when there is nothing to show. */
export function publicShopIdentity(workspace) {
  if (!workspace || !workspace.slug) return null;
  return {
    slug: workspace.slug,
    displayName: workspace.displayName || workspace.slug,
  };
}

/**
 * PHASE 2 — resolve a SHOP SLUG to the ACTIVE workspace that owns it.
 *
 * The slug is the ONE tenant input a customer-facing flow may carry (a form
 * field or a `/shops/:slug` path): it is a LOOKUP key, never an authorization
 * grant. Malformed, unknown and non-ACTIVE slugs all answer `null`, so the
 * caller can refuse without disclosing whether the shop ever existed — the
 * same non-disclosure contract as `GET /api/shops/:slug` (Phase 1).
 *
 * @returns {Promise<{workspaceId: import('mongoose').Types.ObjectId, shop: {slug: string, displayName: string}}|null>}
 */
export async function activeShopBySlug(slugRaw) {
  const slug = String(slugRaw || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  const workspace = await Workspace.findOne({ slug, status: 'ACTIVE' })
    .select('slug displayName')
    .lean();
  if (!workspace) return null;
  return { workspaceId: workspace._id, shop: publicShopIdentity(workspace) };
}

/**
 * PHASE 2 — the platform's single ACTIVE shop, or null.
 *
 * Unambiguous fulfilment: a flow that needs a shop but was not given one can
 * resolve it WITHOUT guessing only while exactly one shop is live. Zero or
 * several ACTIVE shops → null (the caller must ask the customer, or refuse).
 * Mirrors the pre-Phase-2 wishlist rule ("the single ACTIVE workspace when
 * unambiguous") and the bootstrap-provisioning gate.
 */
export async function singleActiveShop() {
  const rows = await Workspace.find({ status: 'ACTIVE' })
    .sort({ createdAt: 1 })
    .limit(2)
    .select('slug displayName')
    .lean();
  if (rows.length !== 1) return null;
  return { workspaceId: rows[0]._id, shop: publicShopIdentity(rows[0]) };
}

/**
 * PHASE 2 — does the platform have ANY workspace document at all?
 *
 * This is the ONE compatibility switch Phase 2 keeps (the same condition the
 * workspace middleware uses to admit an unscoped staff identity): while a
 * deployment has never been onboarded there is no shop that could own a
 * service, so a shop-less request/order stays representable. The moment a
 * single workspace exists — whatever its status — shop ownership becomes
 * MANDATORY and this returns true.
 */
export async function anyWorkspaceExists() {
  const found = await Workspace.exists({});
  return !!found;
}

/**
 * Resolve a Map<workspaceIdString, shop> for the ACTIVE workspaces among the
 * given ids. Suspended, missing and PENDING workspaces are absent from the map
 * — callers then exclude the owning product/collection or answer 404.
 *
 * Runs LIVE on every read (never cached), so a suspension takes effect on the
 * very next request; the write-side cache invalidation is a second belt.
 */
export async function activeShopMap(workspaceIds) {
  const ids = [...new Set((workspaceIds || []).map((v) => (v ? String(v) : '')).filter((v) => v && mongoose.isValidObjectId(v)))];
  if (ids.length === 0) return new Map();
  const rows = await Workspace.find({ _id: { $in: ids }, status: 'ACTIVE' })
    .select('slug displayName')
    .lean();
  return new Map(rows.map((w) => [String(w._id), publicShopIdentity(w)]));
}

/** Convenience for a single document read: the shop, or null. */
export async function activeShopForId(workspaceId) {
  if (!workspaceId) return null;
  const map = await activeShopMap([workspaceId]);
  return map.get(String(workspaceId)) || null;
}

/**
 * Is this catalogue row publicly discoverable?
 *
 *   · no workspace at all (single-workspace compatibility / pre-migration) → yes
 *   · workspace resolves to an ACTIVE shop                               → yes
 *   · workspace suspended, PENDING or deleted                            → NO
 *
 * Orphaned rows (a workspace that no longer exists) are therefore excluded
 * from public discovery and 404 on direct lookup — a shop is never fabricated.
 */
export function isPubliclyDiscoverable(doc, shopMap) {
  const workspaceId = doc && doc.workspaceId;
  if (!workspaceId) return true;
  return shopMap.has(String(workspaceId));
}

/**
 * Canonical public PRODUCT payload: the row with the internal tenant id
 * removed and the shop attribution attached. Works for lean documents,
 * serialized cache rows and Mongoose documents alike — every other field is
 * passed through untouched.
 */
/**
 * PHASE 2 — the canonical public payload for ANY shop-owned record that is
 * handed to a customer: the row with the internal tenant id (`workspaceId`,
 * and mongoose's `__v`) removed and the owning shop attached as
 * `{ slug, displayName }` (or null when the record is not shop-attributed,
 * e.g. pre-migration/platform data).
 *
 * `publicProduct`/`publicCollection` are the named forms of exactly this rule,
 * so a wishlist row, a custom request and a proposal order all answer "which
 * shop?" identically and no surface invents its own projection.
 */
export function publicShopRecord(record, shop = null) {
  if (!record) return record;
  const out = typeof record.toObject === 'function' ? record.toObject() : { ...record };
  delete out.workspaceId;
  delete out.__v;
  out.shop = shop || null;
  return out;
}

/**
 * PHASE 22.5 / MED-6 — the STRICT customer-safe ORDER payload.
 *
 * `publicShopRecord` only strips the tenant id; an Order document still
 * carries provider plumbing (`paymentProviderOrderId`,
 * `paymentProviderPaymentId`, `paymentReference`, `paymentSignatureVerified`,
 * `paymentVerifiedAt`, `paymentFailureReason`, `paymentProvider`), the
 * internal `isFixture` audit flag and per-entry `changedBy` staff identity.
 * None of that belongs in a customer response — so unlike the pass-through
 * helper above, this one is an explicit WHITELIST: only fields the customer
 * legitimately sees are emitted, plus the fulfilling `shop`.
 *
 * Deliberately kept (customer-facing by design):
 *   orderId, items, subtotal, shipping, tax, total, paymentStatus,
 *   paymentMethod, orderStatus, shippingAddress, giftMessage, shop,
 *   shopSnapshot, trackingNumber (the parcel code shown to the customer) and
 *   statusHistory sanitised to { status, note, at/createdAt } — the Journey
 *   Log timeline without the staff `changedBy` identity.
 *
 * Works for Mongoose documents, lean rows and plain serialized objects.
 */
export function customerOrderView(order, shop = null) {
  if (!order) return order;
  const src = typeof order.toObject === 'function' ? order.toObject() : { ...order };
  const history = Array.isArray(src.statusHistory)
    ? src.statusHistory.map((entry) => {
        const e = entry && typeof entry === 'object' ? entry : {};
        const safe = { status: e.status };
        if (e.note) safe.note = e.note;
        if (e.at) safe.at = e.at;
        if (e.changedAt) safe.changedAt = e.changedAt;
        if (e.createdAt) safe.createdAt = e.createdAt;
        return safe;
      })
    : [];
  // Line items are rebuilt field-by-field: the embedded subdocument carries an
  // `_id` and the internal `stockDeducted` inventory flag, neither of which a
  // customer needs (the frontend maps productSlug/name/price/quantity/image/
  // palette/ribbon/giftMessage/customDetails/description/isAddOn/isCatalogue).
  const items = (Array.isArray(src.items) ? src.items : []).map((raw) => {
    const it = raw && typeof raw === 'object' ? raw : {};
    return {
      productSlug: it.productSlug ?? null,
      name: it.name || '',
      price: it.price ?? 0,
      quantity: it.quantity ?? 1,
      image: it.image || '',
      category: it.category || '',
      palette: it.palette || '',
      ribbon: it.ribbon || '',
      giftMessage: it.giftMessage || '',
      customDetails: it.customDetails ?? null,
      description: it.description || '',
      isAddOn: !!it.isAddOn,
      isCatalogue: it.isCatalogue !== false,
    };
  });
  return {
    id: src.orderId,
    orderId: src.orderId,
    customerId: src.customerId ? String(src.customerId) : '',
    customerName: src.customerName || '',
    customerEmail: src.customerEmail || '',
    items,
    subtotal: src.subtotal ?? 0,
    shipping: src.shipping ?? 0,
    tax: src.tax ?? 0,
    total: src.total ?? 0,
    paymentStatus: src.paymentStatus || 'Pending',
    paymentMethod: src.paymentMethod || 'Sample',
    // Non-secret provider NAME ('razorpay') that predates this projection and
    // is asserted by the payment suites; the provider IDENTIFIERS
    // (paymentProviderOrderId/PaymentId/paymentReference/signature flags)
    // remain stripped below by omission.
    paymentProvider: src.paymentProvider || null,
    orderStatus: src.orderStatus || 'new',
    shippingAddress: src.shippingAddress || {},
    giftMessage: src.giftMessage || '',
    trackingNumber: src.trackingNumber || '',
    statusHistory: history,
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
    shop: shop || null,
    ...(src.shopSnapshot && src.shopSnapshot.slug ? { shopSnapshot: src.shopSnapshot } : {}),
  };
}

/** Canonical public PRODUCT payload: the row with the internal tenant id
 *  removed and the shop attribution attached. */
export function publicProduct(product, shop = null) {
  return publicShopRecord(product, shop);
}

/** Canonical public COLLECTION payload — same rules as a product. */
export function publicCollection(collection, shop = null) {
  return publicShopRecord(collection, shop);
}