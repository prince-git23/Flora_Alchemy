import Order, { ORDER_STATUSES, NEXT_STATUS } from '../models/Order.js';
import Product from '../models/Product.js';
import Inventory from '../models/Inventory.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { reserveStockForOrder } from './inventoryService.js';
import { isConfigured as razorpayConfigured, isRazorpayMethod } from './razorpayService.js';
import { calculateCustomGiftPrice, resolveAddOnPrice } from '../config/customGiftPricing.js';

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
      const docs = await Order.find({ orderId: /^FA-\d+$/ })
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

async function createOrderOnce({ customer, items, paymentMethod = 'Sample', shippingAddress, giftMessage = '', isRush = false, forceSamplePayment = false, allowLegacyPricing = false }) {
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
      ? await Product.find({ slug: { $in: slugs } }).session(session).lean()
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
        } else if (allowLegacyPricing) {
          // Staff-created bespoke order — accept client price under staff authority.
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

    const settings = await getShippingSettings(session);

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
      const invQuery = Inventory.find({ productSlug: { $in: [...qtyBySlug.keys()] } });
      invQuery.session(session);
      const invDocs = await invQuery.lean();
      const invBySlug = new Map(invDocs.map((d) => [d.productSlug, d]));
      for (const [slug, need] of qtyBySlug) {
        const prod = productBySlug.get(slug);
        const label = (prod && prod.name) || slug;
        const invDoc = invBySlug.get(slug);
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

    const shipping = isRush
      ? settings.shippingConfiguration.expressRate
      : subtotal >= settings.shippingConfiguration.freeShippingThreshold
        ? 0
        : settings.shippingConfiguration.standardRate;

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
          total: Math.round(subtotal + shipping),
          paymentStatus,
          paymentMethod: paymentMethod || 'Sample',
          paymentProvider,
          orderStatus: 'new',
          shippingAddress: shippingAddress || {},
          giftMessage: giftMessage || '',
          trackingNumber: nextTracking(orderId),
          statusHistory: [{ status: 'new', note: 'Order received' }],
        },
      ],
      { session }
    );
    order = order[0];

    // Hold catalogue stock for the order (compensating-release strategy). For
    // payment-pending orders the hold is flagged per item so a failed payment
    // can release it and a later confirmed payment re-deducts only if released.
    const pending = paymentStatus === 'Pending';
    await reserveStockForOrder({ items: normalized, orderId, createdBy: customer.name || 'customer', paymentPending: pending, session });
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

async function getShippingSettings(session) {
  const Settings = (await import('../models/Settings.js')).default;
  let settings = await Settings.findOne({ key: 'default' }).session(session);
  if (!settings) {
    settings = await Settings.create([{ key: 'default' }], { session });
    settings = settings[0];
  }
  return settings;
}
