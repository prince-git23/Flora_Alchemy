import Order from '../models/Order.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { requestScope } from '../utils/tenancy.js';
import { ensureOrderStockForPayment } from '../services/inventoryService.js';
import { markRequestPaidForOrder } from '../services/customRequestPaymentService.js';
import {
  isConfigured,
  getKeyId,
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  isWebhookConfigured,
  isRazorpayMethod,
} from '../services/razorpayService.js';

/**
 * POST /api/payments/create-order — authenticated customer only.
 *
 * Binds a server-created Razorpay order to the customer's Flora order.
 * The amount is recomputed from the STORED order total (integer paise);
 * any client-supplied amount is ignored. Reuses an existing pending
 * Razorpay order id for retries — one Razorpay order per business order.
 */
export async function createPaymentOrder(req, res, next) {
  try {
    if (req.user.role !== 'customer' || !req.user.customerId) {
      throw new ApiError(403, 'Only authenticated customers can pay for their orders.', 'FORBIDDEN');
    }
    if (!isConfigured()) {
      throw new ApiError(503, 'Online payment is not configured in this environment.', 'PAYMENT_NOT_CONFIGURED');
    }

    const { orderId } = req.body || {};
    if (!orderId) {
      throw new ApiError(422, 'An order reference is required.', 'VALIDATION_ERROR');
    }

    const order = await Order.findOne({ orderId });
    if (!order || String(order.customerId) !== String(req.user.customerId)) {
      // No existence leak to other customers.
      throw new ApiError(404, 'Order not found.', 'ORDER_NOT_FOUND');
    }
    if (order.paymentStatus === 'Paid') {
      throw new ApiError(409, 'This order has already been paid.', 'PAYMENT_ALREADY_COMPLETED');
    }
    // PHASE 3 §15 — only a provider-checkout method may create a provider
    // order. A COD/Sample order can never be converted into an online charge
    // by calling this endpoint directly; the amount itself always comes from
    // the STORED order total below, never from the client.
    if (!isRazorpayMethod(order.paymentMethod)) {
      throw new ApiError(
        422,
        'This order does not use online payment. Please complete the payment method you chose.',
        'PAYMENT_METHOD_NOT_ALLOWED'
      );
    }

    // Reuse the same Razorpay order across retries when one exists.
    let razorpayOrderId = order.paymentProviderOrderId;
    if (!razorpayOrderId) {
      const rzp = await createRazorpayOrder({
        amountInPaise: Math.round(Number(order.total) * 100),
        receipt: order.orderId,
      });
      razorpayOrderId = rzp.id;
      order.paymentProviderOrderId = razorpayOrderId;
      order.paymentProvider = 'razorpay';
      if (order.paymentStatus !== 'Paid') order.paymentStatus = 'Pending';
      order.paymentFailureReason = '';
      await order.save();
    }

    res.json({
      success: true,
      payment: {
        razorpayKeyId: getKeyId(),
        razorpayOrderId,
        amount: Math.round(Number(order.total) * 100), // integer paise
        currency: 'INR',
        // Display-only values — the server remains authoritative.
        displayTotal: order.total,
        receipt: order.orderId,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/verify — authenticated customer only.
 *
 * Two branches:
 *  - outcome === 'failed' (or 'cancelled'): record an honest Failed state so
 *    the order is never mistaken for paid; retry stays available.
 *  - signature payload: the server verifies HMAC against the Razorpay order id
 *    IT created for this Flora order (never the browser-claimed id alone).
 *
 * Idempotent: repeating the same verification never double-charges or
 * double-updates; already-paid orders are not regressed.
 */
export async function verifyPayment(req, res, next) {
  try {
    if (req.user.role !== 'customer' || !req.user.customerId) {
      throw new ApiError(403, 'Only authenticated customers can verify payments.', 'FORBIDDEN');
    }
    const { orderId, outcome, failureReason } = req.body || {};
    if (!orderId) {
      throw new ApiError(422, 'An order reference is required.', 'VALIDATION_ERROR');
    }

    const order = await Order.findOne({ orderId });
    if (!order || String(order.customerId) !== String(req.user.customerId)) {
      throw new ApiError(404, 'Order not found.', 'ORDER_NOT_FOUND');
    }

    // Failure / cancellation branch — honest state, no fake paid claim.
    // Held stock is RELEASED back to available (compensating-release strategy),
    // idempotently — only items still flagged stockDeducted are released.
    if (outcome === 'failed' || outcome === 'cancelled') {
      if (order.paymentStatus !== 'Paid') {
        order.paymentStatus = 'Failed';
        order.paymentFailureReason = failureReason || 'Payment was not completed.';
        await order.save();
        await ensureOrderStockForPayment({ order, paid: false });
      }
      return res.json({
        success: true,
        order: paymentSummary(order),
      });
    }

    // ── Success branch: mandatory server-side signature verification ──
    const { razorpay_payment_id: paymentId, razorpay_order_id: clientOrderId, razorpay_signature: signature } = req.body || {};

    if (!paymentId || !clientOrderId || !signature) {
      throw new ApiError(422, 'Payment verification data is incomplete.', 'VALIDATION_ERROR');
    }

    // The authoritative reference is the Razorpay order id the SERVER created.
    if (!order.paymentProviderOrderId || clientOrderId !== order.paymentProviderOrderId) {
      throw new ApiError(400, 'Payment order mismatch. Please retry payment.', 'INVALID_SIGNATURE');
    }

    const verified = verifyPaymentSignature({
      razorpayOrderId: order.paymentProviderOrderId,
      razorpayPaymentId: paymentId,
      signature,
    });

    if (!verified) {
      if (order.paymentStatus !== 'Paid') {
        order.paymentFailureReason = 'Payment signature verification failed.';
      }
      await order.save();
      throw new ApiError(400, 'Payment verification failed. Please try again.', 'INVALID_SIGNATURE');
    }

    // Already paid with the SAME payment id → idempotent success. The custom
    // request settlement hook is re-run here too (idempotent), so a previous
    // attempt that settled the payment but failed to settle the request is
    // completed by the retry.
    if (order.paymentStatus === 'Paid' && order.paymentProviderPaymentId === paymentId) {
      await markRequestPaidForOrder(order);
      return res.json({ success: true, order: paymentSummary(order) });
    }
    if (order.paymentStatus === 'Paid') {
      throw new ApiError(409, 'This order has already been paid.', 'PAYMENT_ALREADY_COMPLETED');
    }

    order.paymentStatus = 'Paid';
    order.paymentProviderPaymentId = paymentId;
    order.paymentReference = paymentId;
    order.paymentSignatureVerified = true;
    order.paymentVerifiedAt = new Date();
    order.paymentFailureReason = '';
    await order.save();

    // Exactly one final deduction: re-deduct only items that were released by a
    // previous failed attempt (flag-guarded — never a duplicate deduction).
    await ensureOrderStockForPayment({ order, paid: true });

    // Custom-request settlement: when this order settles an accepted proposal,
    // the request moves payment_pending → paid (idempotent). Runs for ordinary
    // orders as a no-op.
    await markRequestPaidForOrder(order);

    res.json({ success: true, order: paymentSummary(order) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/payments/:orderId/status — owner (customer) or staff.
 * Returns the payment state only; never provider secrets.
 */
export async function getPaymentStatus(req, res, next) {
  try {
    const isStaff = ['admin', 'handler'].includes(req.user.role);
    // PHASE 2 — a STAFF read is tenant-scoped: requestScope resolves the
    // caller's workspace (this route carries no workspace gate, so the scope
    // falls back to the identity; an unonboarded platform stays unscoped).
    // A customer keeps the ownership-scoped path and is filtered by
    // customerId below, so no other customer's payment is ever disclosed.
    const order = await Order.findOne({
      orderId: req.params.orderId,
      ...(isStaff ? requestScope(req) : {}),
    });
    if (!order || (!isStaff && String(order.customerId) !== String(req.user.customerId || ''))) {
      throw new ApiError(404, 'Order not found.', 'ORDER_NOT_FOUND');
    }
    res.json({ success: true, payment: paymentSummary(order) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/webhook — Razorpay event synchronization.
 *
 * The payload is only trusted after HMAC verification against
 * RAZORPAY_WEBHOOK_SECRET. Events handled: payment.captured (→ Paid) and
 * payment.failed (→ Failed). Both are idempotent: a captured event never
 * regresses a paid order, and stock is never touched here (it was reserved
 * once at order creation).
 */
export async function handlePaymentWebhook(req, res, next) {
  try {
    if (!isWebhookConfigured()) {
      throw new ApiError(501, 'Payment webhooks are not configured on this server.', 'WEBHOOK_NOT_CONFIGURED');
    }
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (!verifyWebhookSignature(rawBody, signature)) {
      throw new ApiError(400, 'Invalid webhook signature.', 'INVALID_SIGNATURE');
    }

    const event = req.body || {};
    const entity = event.payload?.payment?.entity || {};
    const razorpayOrderId = entity.order_id || '';
    const paymentId = entity.id || '';

    if (!razorpayOrderId) {
      return res.json({ success: true, ignored: true });
    }

    const order = await Order.findOne({ paymentProviderOrderId: razorpayOrderId });
    if (!order) {
      // Unknown to us — acknowledge so Razorpay stops retrying; nothing to do.
      return res.json({ success: true, ignored: true });
    }

    if (event.event === 'payment.captured' && order.paymentStatus !== 'Paid') {
      order.paymentStatus = 'Paid';
      order.paymentProviderPaymentId = paymentId;
      order.paymentReference = paymentId;
      order.paymentSignatureVerified = true;
      order.paymentVerifiedAt = new Date();
      order.paymentFailureReason = '';
      await order.save();
      // Same compensating rule as the verify endpoint — idempotent.
      await ensureOrderStockForPayment({ order, paid: true });
      // Same custom-request settlement hook — idempotent.
      await markRequestPaidForOrder(order);
    } else if (event.event === 'payment.failed' && order.paymentStatus !== 'Paid') {
      order.paymentStatus = 'Failed';
      order.paymentFailureReason = entity.error_description || entity.error_reason || 'Payment failed at the provider.';
      await order.save();
      // Release held stock back to available — idempotent.
      await ensureOrderStockForPayment({ order, paid: false });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

function paymentSummary(order) {
  return {
    orderId: order.orderId,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    paymentProvider: order.paymentProvider || '',
    paymentReference: order.paymentReference || '',
    paymentSignatureVerified: order.paymentSignatureVerified || false,
    paymentVerifiedAt: order.paymentVerifiedAt || null,
    paymentFailureReason: order.paymentFailureReason || '',
    total: order.total,
  };
}