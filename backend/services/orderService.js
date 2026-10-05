import Order, { ORDER_STATUSES, NEXT_STATUS } from '../models/Order.js';
import Product from '../models/Product.js';
import Inventory from '../models/Inventory.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { reserveStockForOrder } from './inventoryService.js';
import { isConfigured as razorpayConfigured, isRazorpayMethod } from './razorpayService.js';
import { calculateCustomGiftPrice, resolveAddOnPrice } from '../config/customGiftPricing.js';
import { activeShopForId } from '../utils/publicShop.js';

export { ORDER_STATUSES };

// Sequence is seeded from the database on first use so a server restart can
// never collide with orderIds already persisted in MongoDB (previously the
// random in-memory start could reuse FA-#### values after a restart and
// fail every subsequent order with a duplicate-key error).
let orderSeq = null;
let orderSeqPromise = null;

async function ensureOrderSeq() {
  if (orderSeq !== null) return;
  if (!orderSeqPromise) {
    orderSeqPromise = (async () => {
      // Scan all numeric FA- ids and start above the true maximum. Sorting by
      // createdAt is not enough — several orders can share the same timestamp
      // second, and a non-max pick would collide on the next insert.
      const docs = await Order.find({
        // Deliberately global: FA-#### is ONE platform-wide sequence, so this
        // scan crosses every workspaceId (scoping it would hand out duplicate
        // order ids; per-workspace sequences arrive with Phase 22.5).
        orderId: /^FA-\d+$/,
      })
        .select('orderId')
        .lean();
      let max = 1000;
      for (const d of docs) {
        const n = parseInt(String(d.orderId).replace('FA-', ''), 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
      orderSeq = max;
    })();
  }
  await orderSeqPromise;
}

async function nextOrderId() {
  await ensureOrderSeq();
  // Reserve the next id, but verify against MongoDB before returning it:
  // two server instances (or overlapping restarts) each hold an in-memory
  // counter and WILL race on the same FA-####. A checked skip keeps the
  // human-friendly sequential format while making duplicates impossible.
  let candidate = orderSeq + 1;
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const clash = await Order.exists({ orderId: `FA-${candidate}` });
    if (!clash) {
      orderSeq = candidate;
      return `FA-${candidate}`;
    }
    // Someone else already persisted this id — jump past it and re-sync.
    orderSeq = Math.max(orderSeq, candidate);
    candidate += 1;
  }
  // Exhausted retries (pathological contention): fall back to a timestamp id
  // which cannot collide within the same millisecond window.
  return `FA-${Date.now()}`;
}

function nextTracking(orderId) {
  return `FA-TRK-${orderId.replace('FA-', '')}`;
}

/**
 * PHASE 3 §15 — the canonical payment-method id behind the storefront label.
 *
 * The checkout sends the display label ('Instant UPI'); payment-smoke and the
 * proposal flow send the same. Only the canonical id decides which shop
 * setting applies, so a label can never bypass a disabled method.
 */
export function canonicalPaymentMethod(method) {
  const m = String(method || '').trim().toLowerCase();
  if (!m) return '';
  if (['sample', 'cod', 'upi', 'card'].includes(m)) return m;
  if (m.includes('delivery')) return 'cod';
  if (m.includes('upi')) return 'upi';
  if (m.includes('card') || m.includes('netbank')) return 'card';
  return 'other';
}

/**
 * PHASE 3 §10 — SERVER enforcement of the ORDER WORKSPACE's commerce settings.
 *
 * These rules were stored by the admin Settings page but never enforced: the
 * storefront displayed them, a direct API call ignored them. They are enforced
 * here, inside the order transaction, before any Order document exists:
 *
 *   · `storeAvailability: 'closed'` / `acceptNewOrders: false` → the shop is
 *     not taking orders (`409 ORDERS_CLOSED`);
 *   · `commerceConfiguration.minimumOrderValue` → `422 MINIMUM_ORDER_VALUE`;
 *   · `commerceConfiguration.maximumOrderItems` (total quantity) →
 *     `422 MAX_ITEMS_EXCEEDED`;
 *   · `commerceConfiguration.paymentMethods` → `422 PAYMENT_METHOD_NOT_ALLOWED`;
 *   · `customGiftConfiguration.enabled: false` → a studio gift is refused
 *     (`422 CUSTOM_GIFTS_DISABLED`).
 *
 * `autoConfirmOrders` is deliberately NOT applied to the created status: a new
 * order stays `new` so payment and fulfilment remain independent (the frozen
 * lifecycle), which docs/MULTI-TENANT.md §12.11 records as an explicit,
 * audited exception.
 */
function enforceCommerceSettings(settings, { items, paymentMethod, subtotal }) {
  const settingsDoc = settings || {};
  const commerce = settingsDoc.commerceConfiguration || {};

  if (settingsDoc.acceptNewOrders === false || settingsDoc.storeAvailability === 'closed') {
    throw new ApiError(
      409,
      'This shop is not accepting new orders right now. Please try again later.',
      'ORDERS_CLOSED'
    );
  }

  const minimum = Number(commerce.minimumOrderValue);
  if (Number.isFinite(minimum) && minimum > 0 && subtotal < minimum) {
    throw new ApiError(
      422,
      `This shop's minimum order value is ₹${minimum}. Please add more to your bag.`,
      'MINIMUM_ORDER_VALUE'
    );
  }

  const maxItems = Number(commerce.maximumOrderItems);
  const quantity = (items || []).reduce((n, i) => n + (Number(i.quantity) || 0), 0);
  if (Number.isFinite(maxItems) && maxItems > 0 && quantity > maxItems) {
    throw new ApiError(
      422,
      `This shop accepts at most ${maxItems} items in one order. Please reduce the quantity in your bag.`,
      'MAX_ITEMS_EXCEEDED'
    );
  }

  const canonical = canonicalPaymentMethod(paymentMethod);
  const pm = commerce.paymentMethods || {};
  const allowed =
    !canonical ||
    canonical === 'sample' ||
    (canonical === 'upi' && pm.upi !== false) ||
    (canonical === 'card' && (pm.cards !== false || pm.netbanking !== false)) ||
    (canonical === 'cod' && pm.cod === true);
  if (!allowed) {
    throw new ApiError(
      422,
      'This payment method is not available for this shop. Please choose another one.',
      'PAYMENT_METHOD_NOT_ALLOWED'
    );
  }

  const hasStudioGift = (items || []).some(
    (i) => i && i.customGiftConfig && typeof i.customGiftConfig === 'object'
  );
  if (hasStudioGift && settingsDoc.customGiftConfiguration && settingsDoc.customGiftConfiguration.enabled === false) {
    throw new ApiError(
      422,
      'The Custom Gift Studio is currently unavailable. Please remove the custom gift from your bag.',
      'CUSTOM_GIFTS_DISABLED'
    );
  }
}

/**
 * PHASE 3 §11 — shop-configured tax, computed from the ORDER WORKSPACE's
 * commerce settings. Disabled by default (taxEnabled false / taxRate 0), so
 * every existing order keeps its exact total. Rounded to whole rupees on the
 * item subtotal (shipping is not taxed) — the same integer the customer sees.
 */
function computeOrderTax(settings, subtotal) {
  const commerce = (settings && settings.commerceConfiguration) || {};
  const rate = Number(commerce.taxRate) || 0;
  if (commerce.taxEnabled !== true || rate <= 0) return 0;
  return Math.round((Number(subtotal) || 0) * (rate / 100));
}

/**
 * Validate an order can move to newStatus (forward-only lifecycle).
 */
export function assertValidTransition(order, newStatus) {
  if (!ORDER_STATUSES.includes(newStatus)) {
    throw new ApiError(422, `Unknown order status "${newStatus}".`, 'VALIDATION_ERROR');
  }
  const currentIndex = ORDER_STATUSES.indexOf(order.orderStatus);
  const nextIndex = ORDER_STATUSES.indexOf(newStatus);
  if (nextIndex <= currentIndex) {
    throw new ApiError(
      422,
      `Cannot move order from ${order.orderStatus} back to ${newStatus} (lifecycle is forward-only).`,
      'INVALID_TRANSITION'
    );
  }
  return true;
}

/**
 * Create a canonical order.
 *
 * Security rules enforced here (the server is authoritative):
 *  - catalogue prices are re-read from the Product catalog (client price ignored)
 *  - shipping/total are recomputed server-side
 *  - inventory is reserved after order creation risk is cleared; the whole
 *    sequence runs inside a Mongoose session transaction.
 *  - made-to-order (custom, non-catalogue) items carry bespoke pricing and are
 *    not stock-tracked, preserving the Phase 3A.5 behavior.
 *  - customer orders require productSlug or customGiftConfig; client price is
 *    never accepted for customer-originated orders.
 *  - staff orders (allowLegacyPricing) may accept client prices for bespoke
 *    items that cannot be represented by customGiftConfig.
 */
export async function createOrder(args) {
  // Phase 20.2 — race-safe wrapper. Two orders competing for the last unit
  // make MongoDB abort the loser's transaction with a WriteConflict
  // (code 112, TransientTransactionError). That error surfaces at the SESSION
  // level, so it never reaches the guarded adjustStock() call and used to
  // leak out as a raw 500. Retry once: the second attempt's stock pre-check
  // re-runs against fresh state and fails with the precise, customer-
  // readable 409 ("just went out of stock"). If the retry conflicts too
  // (multi-way race), throw that same clean business error. Exactly one
  // order can ever commit — stock is deducted atomically inside the
  // transaction, which the concurrent-order test verifies.
  try {
    return await createOrderOnce(args);
  } catch (err) {
    if (!isTransientTxConflict(err)) throw err;
  }
  try {
    return await createOrderOnce(args);
  } catch (err) {
    if (!isTransientTxConflict(err)) throw err;
  }
  throw new ApiError(
    409,
    'Stock changed while processing your order — please review your bag and try again.',
    'INSUFFICIENT_STOCK'
  );
}

/** MongoDB write-conflict / duplicate-key raised at the transaction level. */
function isTransientTxConflict(err) {
  if (!err) return false;
  if (err.code === 112 || err.code === 11000) return true;
  const labels = err.errorLabels || (err.errorResponse && err.errorResponse.errorLabels);
  return Array.isArray(labels) && labels.includes('TransientTransactionError');
}

async function createOrderOnce({ customer, items, paymentMethod = 'Sample', shippingAddress, giftMessage = '', isRush = false, forceSamplePayment = false, allowLegacyPricing = false, trustedItems = false, shippingOverride = null, customRequestId = null, proposalId = null, workspaceId = null }) {
  if (!customer) {
    throw new ApiError(401, 'An authenticated customer is required to place an order.', 'UNAUTHORIZED');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(422, 'An order must contain at least one item.', 'VALIDATION_ERROR');
  }

  const session = await Order.startSession();
  let order;
  try {
    session.startTransaction();

    const normalized = [];
    let subtotal = 0;
    // Batch-resolve all referenced catalogue products in ONE query instead of
    // one findOne per item (Phase 17 N+1 fix). Duplicate slugs in the payload
    // share the same resolved product; server-authoritative pricing unchanged.
    const slugs = [...new Set(items.filter((i) => i.productSlug).map((i) => i.productSlug))];
    const productDocs = slugs.length
      ? await Product.find({
          slug: { $in: slugs },
          // Deliberately NOT scoped by workspaceId: the storefront is a single
          // shared catalogue today and customer orders carry no workspace
          // attribution yet (Phase 22.3). Slugs are globally unique, so each
          // row resolves to exactly one product regardless of owner.
        }).session(session).lean()
      : [];
    const productBySlug = new Map(productDocs.map((p) => [p.slug, p]));

    for (const item of items) {
      const quantity = Math.floor(Number(item.quantity));
      if (!quantity || quantity < 1) {
        throw new ApiError(422, `Invalid quantity for "${item.name}".`, 'VALIDATION_ERROR');
      }

      if (item.productSlug) {
        const product = productBySlug.get(item.productSlug);
        if (!product) {
          throw new ApiError(404, `Product "${item.productSlug}" no longer exists.`, 'PRODUCT_NOT_FOUND');
        }
        // Server-authoritative price.
        const price = product.price;
        const line = {
          productSlug: product.slug,
          name: item.name || product.name,
          price,
          quantity,
          image: product.image,
          category: product.category,
          palette: item.palette || product.palette || '',
          ribbon: item.ribbon || product.ribbon || '',
          giftMessage: item.giftMessage || '',
          customDetails: item.customDetails || null,
          description: item.description || '',
          isAddOn: !!item.isAddOn,
          // Phase 20.2 — `!== false` so legacy product documents created
          // before the stockTracked field existed still count as tracked;
          // reading the raw flag treated them as never-deducted (oversell).
          isCatalogue: product.stockTracked !== false,
        };
        normalized.push(line);
        subtotal += price * quantity;
      } else {
        // Made-to-order custom item.
        // If the item carries a customGiftConfig (from the Custom Gift Studio),
        // the server calculates the price from the configuration IDs.
        // The client-supplied price is IGNORED for Studio items.
        let price;
        let customDetails = item.customDetails || null;

        if (item.customGiftConfig && item.customGiftConfig.baseId) {
          // Custom Gift Studio — server-authoritative pricing
          const result = calculateCustomGiftPrice(item.customGiftConfig);
          if (result.errors.length > 0) {
            throw new ApiError(422, `Invalid custom gift configuration: ${result.errors.join('; ')}`, 'VALIDATION_ERROR');
          }
          price = result.price;
          customDetails = { ...customDetails, pricingBreakdown: result.breakdown };
        } else if (item.isAddOn) {
          // Add-ons — server-authoritative pricing. Client sends addOnId; server resolves price.
          // The client-supplied price is IGNORED.
          const addOnResult = resolveAddOnPrice(item.addOnId);
          if (addOnResult.errors.length > 0) {
            throw new ApiError(422, `Invalid add-on: ${addOnResult.errors.join('; ')}`, 'VALIDATION_ERROR');
          }
          price = addOnResult.price;
        } else if (allowLegacyPricing || trustedItems) {
          // Server-authored bespoke pricing.
          //  · allowLegacyPricing — a staff-created order (phone order etc.).
          //  · trustedItems — an order built by the server itself from an
          //    ACCEPTED PROPOSAL: the caller (proposalController) constructed
          //    these items from the stored Proposal document, so the price is
          //    DB-derived and authoritative. The flag is passed by the trusted
          //    controller only — it never travels through an HTTP body.
          price = Number(item.price);
          if (!Number.isFinite(price) || price < 0) {
            throw new ApiError(422, `Invalid price for custom item "${item.name}".`, 'VALIDATION_ERROR');
          }
        } else {
          // Customer order without productSlug or customGiftConfig — REJECT.
          // Customers must use either a catalogue product or a validated custom gift.
          throw new ApiError(422, 'Each order item must include productSlug (catalogue product) or customGiftConfig (custom gift). Arbitrary client pricing is not permitted.', 'VALIDATION_ERROR');
        }

        normalized.push({
          productSlug: null,
          name: item.name || 'Custom Gift',
          price,
          quantity,
          image: item.image || '',
          category: item.category || 'Custom Gifts',
          palette: item.palette || '',
          ribbon: item.ribbon || '',
          giftMessage: item.giftMessage || giftMessage,
          customDetails,
          description: item.description || '',
          isAddOn: !!item.isAddOn,
          isCatalogue: false,
        });
        subtotal += price * quantity;
      }
    }

    // ── Order-workspace authority + commerce settings (PHASE 3) ─────
    // The workspace is resolved by the caller from STORED item ownership
    // (services/orderDestinationService.js). Two invariants are asserted here,
    // inside the transaction and before anything is written:
    //   1. the workspace must still be an ACTIVE shop (a suspension between
    //      checkout and submit refuses the order — nothing is created), and
    //   2. every catalogue item must belong to that same workspace, so a
    //      mismatched payload can never produce an order whose items belong to
    //      another shop. A mismatch is a hard 500 (refused + diagnostic), never
    //      a silent repair.
    let shopIdentity = null;
    if (workspaceId) {
      shopIdentity = await activeShopForId(workspaceId);
      if (!shopIdentity) {
        throw new ApiError(422, 'This shop is not accepting new orders right now.', 'SHOP_NOT_FOUND');
      }
    }
    // The product-ownership invariant governs catalogue orders. A
    // proposal-settling order (`trustedItems`) is governed by its own rule
    // instead — Order.workspaceId == Proposal.workspaceId ==
    // CustomRequest.workspaceId, asserted by the proposal controller — because
    // a bespoke quote may legitimately source parts from outside the shop.
    if (!trustedItems) {
      for (const product of productDocs) {
        if (workspaceId && product.workspaceId && String(product.workspaceId) !== String(workspaceId)) {
          throw new ApiError(
            500,
            'The order does not belong to the shop that owns its items — refusing to create it.',
            'ORDER_WORKSPACE_MISMATCH'
          );
        }
      }
    }

    // The ORDER WORKSPACE's settings (its own document, else the platform
    // singleton) govern shipping, tax and commerce enforcement. Client values
    // never take part.
    const settings = await getShippingSettings(session, workspaceId);
    enforceCommerceSettings(settings, { items, paymentMethod, subtotal });

    // ── Shipping ─────────────────────────────────────────────────────
    // A proposal-settling order uses the shipping the proposal LOCKED IN at
    // send time (same rule as below, applied by the proposal controller), so
    // the customer pays exactly the total they reviewed and accepted. Every
    // other order derives shipping here from the order-workspace settings.
    let shipping;
    if (Number.isFinite(shippingOverride)) {
      shipping = Math.max(0, Math.round(shippingOverride));
    } else {
      shipping = isRush
        ? settings.shippingConfiguration.expressRate
        : subtotal >= settings.shippingConfiguration.freeShippingThreshold
          ? 0
          : settings.shippingConfiguration.standardRate;
    }

    // PHASE 3 §11 — shop-configured tax (server-side, never from the client).
    // A proposal-settling order keeps the total the customer ACCEPTED (the
    // proposal locked shipping and subtotal at send time), so no tax is added
    // on that path — its total is reconciled to the rupee by the proposal
    // controller and must not move.
    const tax = Number.isFinite(shippingOverride) ? 0 : computeOrderTax(settings, subtotal);

    // ── Stock pre-validation (Phase 20.2) ──────────────────────────────
    // Fail with clean, customer-readable business errors BEFORE the Order
    // document exists: a missing or insufficient inventory record can never
    // first surface as a raw diagnostic at the final Review step, and no
    // partial state (order without stock / stock without order) is possible.
    // The atomic guard inside adjustStock remains the race backstop.
    const qtyBySlug = new Map();
    for (const line of normalized) {
      if (line.isCatalogue && line.productSlug) {
        qtyBySlug.set(line.productSlug, (qtyBySlug.get(line.productSlug) || 0) + line.quantity);
      }
    }
    if (qtyBySlug.size > 0) {
      const invQuery = Inventory.find({
        productSlug: { $in: [...qtyBySlug.keys()] },
        // Deliberately NOT scoped by workspaceId: stock is keyed by the globally
        // unique slug and the shared storefront can mix workspaces in one bag.
        // Each staff adjustment records which workspaceId it happened in.
      });
      invQuery.session(session);
      const invDocs = await invQuery.lean();
      const invBySlug = new Map(invDocs.map((d) => [d.productSlug, d]));
      for (const [slug, need] of qtyBySlug) {
        const prod = productBySlug.get(slug);
        const label = (prod && prod.name) || slug;
        const invDoc = invBySlug.get(slug);
        // PHASE 3 §13 — the inventory record must be owned by the order's
        // workspace when it carries attribution (a legacy row without one is
        // the documented pre-attribution exception). A record of ANOTHER shop
        // is refused loudly instead of being deducted.
        if (!trustedItems && invDoc && invDoc.workspaceId && workspaceId && String(invDoc.workspaceId) !== String(workspaceId)) {
          throw new ApiError(
            500,
            `Stock for "${label}" is not owned by this order's shop — refusing to deduct it.`,
            'ORDER_WORKSPACE_MISMATCH'
          );
        }
        if (!invDoc) {
          throw new ApiError(
            409,
            `"${label}" is currently unavailable. Please remove it from your bag to continue.`,
            'UNAVAILABLE'
          );
        }
        if (invDoc.currentStock < need) {
          throw new ApiError(
            409,
            invDoc.currentStock <= 0
              ? `"${label}" just went out of stock. Please remove it from your bag to continue.`
              : `Only ${invDoc.currentStock} of "${label}" available — please reduce the quantity in your bag.`,
            'INSUFFICIENT_STOCK'
          );
        }
      }
    }

    // Initial payment state — honest and environment-aware:
    //  - Razorpay configured: orders start 'Pending' (payment due before
    //    fulfillment); provider checkout methods are tagged 'razorpay'.
    //  - Razorpay NOT configured: the frozen prototype behavior is preserved
    //    (paymentStatus 'Sample' — clearly labeled, never a real charge).
    // Order status stays 'new' regardless; payment and fulfillment are
    // deliberately independent.
    let paymentStatus = 'Sample';
    let paymentProvider = '';
    if (razorpayConfigured() && !forceSamplePayment) {
      paymentStatus = 'Pending';
      paymentProvider = isRazorpayMethod(paymentMethod) ? 'razorpay' : '';
    }

    const orderId = await nextOrderId();
    order = await Order.create(
      [
        {
          orderId,
          customerId: customer._id,
          customerName: customer.name,
          customerEmail: customer.email,
          items: normalized,
          subtotal: Math.round(subtotal),
          shipping,
          tax,
          total: Math.round(subtotal + shipping + tax),
          paymentStatus,
          paymentMethod: paymentMethod || 'Sample',
          paymentProvider,
          orderStatus: 'new',
          shippingAddress: shippingAddress || {},
          giftMessage: giftMessage || '',
          trackingNumber: nextTracking(orderId),
          statusHistory: [{ status: 'new', note: 'Order received' }],
          // Server-derived attribution (PHASE 3): the workspace the caller
          // resolved from the items' Product ownership; a staff order uses the
          // caller's membership (verified against every item). Absent only in
          // the documented zero-workspace legacy deployment.
          ...(workspaceId ? { workspaceId } : {}),
          // Historical shop identity for customer display only (never an
          // authorization input); keeps an order readable after a suspension.
          ...(shopIdentity
            ? { shopSnapshot: { slug: shopIdentity.slug, displayName: shopIdentity.displayName } }
            : {}),
          // Proposal-settling orders carry the request/proposal they belong to
          // (server-derived; absent for every ordinary order).
          ...(customRequestId ? { customRequestId } : {}),
          ...(proposalId ? { proposalId } : {}),
        },
      ],
      { session }
    );
    order = order[0];

    // Hold catalogue stock for the order (compensating-release strategy). For
    // payment-pending orders the hold is flagged per item so a failed payment
    // can release it and a later confirmed payment re-deducts only if released.
    const pending = paymentStatus === 'Pending';
    await reserveStockForOrder({ items: normalized, orderId, createdBy: customer.name || 'customer', paymentPending: pending, session, workspaceId });
    if (pending) {
      for (const item of order.items) {
        if (item.isCatalogue) item.stockDeducted = true;
      }
      order.markModified('items');
      await order.save({ session });
    }

    await session.commitTransaction();
  } catch (err) {
    // A conflicted transaction may already be aborted — never let the abort
    // itself mask the original error.
    await session.abortTransaction().catch(() => {});
    throw err;
  } finally {
    session.endSession();
  }

  return order;
}

export async function getShippingSettings(session, workspaceId) {
  const Settings = (await import('../models/Settings.js')).default;
  // `session` may be null when called outside a transaction (the proposal
  // controller locks shipping at send time) — .session(null) is a no-op in
  // Mongoose, so the query stays correct either way.
  // Phase 22.3 — a workspace with its own settings document governs its own
  // shipping rates; a workspace that has none (or an unattributed order) falls
  // back to the legacy singleton, which keeps every pre-migration flow intact.
  let settings = workspaceId
    ? await Settings.findOne({ workspaceId }).session(session)
    : null;
  if (!settings) {
    settings = await Settings.findOne({
      // Deliberately unscoped by workspaceId: this IS the pre-migration
      // shared singleton every unattributed flow falls back to.
      key: 'default',
    }).session(session);
  }
  if (!settings) {
    settings = await Settings.create([{ key: 'default' }], { session });
    settings = settings[0];
  }
  return settings;
}
