import Inventory from '../models/Inventory.js';
import InventoryMovement from '../models/InventoryMovement.js';
import { ApiError } from '../middleware/errorMiddleware.js';

/**
 * Atomically change stock and record a movement.
 * type: 'sale' | 'restock' | 'adjustment' | 'return' | 'correction'
 * Use atomic findOneAndUpdate so two concurrent orders can never
 * double-deduct past zero.
 */
export async function adjustStock({
  productSlug,
  delta,
  type = 'adjustment',
  reason = '',
  orderId = null,
  createdBy = 'system',
  // Phase 20.2 — when provided, the deduction joins the caller's MongoDB
  // transaction so an aborted order can never leave stock partially deducted.
  session = null,
}) {
  if (!Number.isFinite(delta) || delta === 0) {
    throw new ApiError(422, 'Adjustment quantity must be a non-zero number.', 'VALIDATION_ERROR');
  }

  // Phase 20.2 — atomic sufficiency guard: for negative deltas the FILTER
  // itself requires enough stock, so $inc can never drive currentStock below
  // zero and two concurrent orders can never both consume the same last unit.
  const filter = { productSlug };
  if (delta < 0) filter.currentStock = { $gte: -delta };

  let inv = null;
  try {
    inv = await Inventory.findOneAndUpdate(
      filter,
      // $inc is atomic; the guard above makes it non-negative by construction.
      { $inc: { currentStock: delta } },
      { new: true, session }
    );
  } catch (err) {
    // Two transactions racing on the same inventory record produce a driver
    // write-conflict — translate it into a clean business error instead of
    // leaking a raw Mongo message to the caller.
    if (err && (err.code === 112 || err.code === 11000)) {
      throw new ApiError(
        409,
        `Stock for "${productSlug}" changed while processing — please try again.`,
        'INSUFFICIENT_STOCK'
      );
    }
    throw err;
  }

  if (!inv) {
    // Distinguish "no inventory record" from "not enough stock" with one read.
    const query = Inventory.findOne({ productSlug });
    if (session) query.session(session);
    const existing = await query;
    if (!existing) {
      throw new ApiError(404, `No inventory record exists for ${productSlug}.`, 'NOT_FOUND');
    }
    throw new ApiError(
      409,
      `Insufficient stock for "${existing.productName}" — only ${existing.currentStock} available.`,
      'INSUFFICIENT_STOCK'
    );
  }

  const previousStock = inv.currentStock - delta;

  await InventoryMovement.create(
    [
      {
        productSlug,
        sku: inv.sku,
        productName: inv.productName,
        delta,
        previousStock,
        newStock: inv.currentStock,
        type,
        reason,
        orderId,
        createdBy,
      },
    ],
    { session }
  );

  return inv;
}

/**
 * Reserve stock for an order's catalogue items. Called inside order creation.
 * The deduction is a HOLD at this point: the order is payment-pending, and
 * the item is flagged stockDeducted so payment failure can release it and a
 * later successful payment re-deducts only if it was released (never twice).
 * Returns the inventory docs updated.
 */
export async function reserveStockForOrder({ items, orderId, createdBy = 'customer', paymentPending = false, session = null }) {
  const updated = [];
  for (const item of items) {
    if (!item.isCatalogue) continue; // made-to-order custom gifts are not stock-tracked
    const inv = await adjustStock({
      productSlug: item.productSlug,
      delta: -item.quantity,
      type: 'sale',
      reason: paymentPending ? `Order ${orderId} (payment pending — held)` : `Order ${orderId}`,
      orderId,
      createdBy,
      session,
    });
    updated.push(inv);
  }
  return updated;
}

/**
 * Compensating-release strategy (Phase 3E.1).
 *
 * The schema has a single currentStock field (no available/reserved split), so
 * pending-payment stock is HELD at order creation and released back when the
 * payment is not completed. Both helpers are idempotent — they are driven by
 * the item.stockDeducted flag, so repeated failure events or repeated webhooks
 * never mutate stock twice.
 *
 *   paid   → every catalogue item with stockDeducted=false is re-deducted
 *            (only possible when a release happened), then flagged true.
 *   failed → every catalogue item with stockDeducted=true is released (+qty),
 *            then flagged false.
 *
 * Net guarantee: one paid order = exactly one final deduction.
 */
export async function ensureOrderStockForPayment({ order, paid }) {
  if (!order || !Array.isArray(order.items)) return [];
  const updated = [];
  for (const item of order.items) {
    if (!item.isCatalogue) continue; // made-to-order custom gifts are not stock-tracked
    if (paid && item.stockDeducted) continue; // already held/sold — never deduct twice
    if (!paid && !item.stockDeducted) continue; // already released — never release twice

    if (paid) {
      const inv = await adjustStock({
        productSlug: item.productSlug,
        delta: -item.quantity,
        type: 'sale',
        reason: `Order ${order.orderId} (payment confirmed)`,
        orderId: order.orderId,
        createdBy: 'payment',
      });
      item.stockDeducted = true;
      updated.push(inv);
    } else {
      const inv = await adjustStock({
        productSlug: item.productSlug,
        delta: item.quantity,
        type: 'release',
        reason: `Order ${order.orderId} (payment not completed — released)`,
        orderId: order.orderId,
        createdBy: 'payment',
      });
      item.stockDeducted = false;
      updated.push(inv);
    }
  }
  if (updated.length > 0) {
    order.markModified('items');
    await order.save();
  }
  return updated;
}
