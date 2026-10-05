import Order, { NEXT_STATUS } from '../models/Order.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { assertValidTransition, createOrder } from '../services/orderService.js';
import { createNotification, createNotificationsForUsers } from './notificationController.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { evaluateOperationalAction } from '../utils/operationalActions.js';
import { permissionForOrderStatus } from '../utils/permissions.js';
import { assertPermission } from '../middleware/permissionMiddleware.js';
import { getWorkspaceId, requestScope, workspaceIdScope } from '../utils/tenancy.js';
import {
  activeShopBySlug,
  activeShopForId,
  activeShopMap,
  anyWorkspaceExists,
  publicShopRecord,
  singleActiveShop,
} from '../utils/publicShop.js';

/**
 * PHASE 2 §6 — the FULFILMENT SHOP for a customer order.
 *
 * The Custom Gift Studio keeps its shared static configuration and its
 * server-side pricing. What it gains is an explicit fulfilment shop: the
 * workspace that will actually make the gift, resolved HERE from stored data
 * (the browser's shop context is never an authorization input).
 *
 *   · an explicit `shopSlug` is validated against ACTIVE shops — malformed,
 *     unknown or suspended all refuse the order (SHOP_NOT_FOUND);
 *   · a STUDIO GIFT (`customGiftConfig`) without a slug resolves the single
 *     live shop when that is unambiguous, refuses when several shops could
 *     fulfil it (SHOP_REQUIRED — the customer must choose), and nothing else
 *     changes for ordinary catalogue orders;
 *   · a deployment with NO workspace at all keeps the historical unattributed
 *     behaviour (pre-onboarding compatibility).
 */
async function resolveOrderWorkspace({ shopSlug, items }) {
  const slug = String(shopSlug || '').trim().toLowerCase();
  if (slug) {
    const resolved = await activeShopBySlug(slug);
    if (!resolved) {
      throw new ApiError(422, 'This shop is not available right now.', 'SHOP_NOT_FOUND');
    }
    return resolved.workspaceId;
  }
  const hasStudioGift = (items || []).some(
    (item) => item && item.customGiftConfig && typeof item.customGiftConfig === 'object'
  );
  if (!hasStudioGift) return null;
  const only = await singleActiveShop();
  if (only) return only.workspaceId;
  if (await anyWorkspaceExists()) {
    throw new ApiError(422, 'Please choose the shop that should make your gift.', 'SHOP_REQUIRED');
  }
  return null;
}

export async function listOrders(req, res, next) {
  try {
    const status = safeString(req.query.status, 50);
    const q = safeString(req.query.q, 200);
    const match = {};
    if (status && status !== 'All') match.orderStatus = status;
    if (q) {
      const regex = { $regex: escapeRegExp(q), $options: 'i' };
      match.$or = [
        { orderId: regex },
        { customerName: regex },
        { customerEmail: regex },
      ];
    }
    // Portal order list is workspace-scoped (legacy rows stay visible until
    // the Phase 22.5 backfill) and never cached.
    const orders = await Order.find({ ...requestScope(req), ...match }).sort({ createdAt: -1 }).limit(500);
    res.json({ success: true, orders });
  } catch (err) {
    next(err);
  }
}

export async function listMyOrders(req, res, next) {
  try {
    // Bounded result: newest 100 orders for the authenticated customer
    // (supported by the { customerId, createdAt: -1 } index). The storefront
    // order-history page renders at most a handful; 100 is a generous ceiling
    // that keeps payloads bounded as order history grows (Phase 17).
    const docs = await Order.find({
      // Scoped by IDENTITY, not workspaceId: storefront orders carry no
      // workspace attribution in Phase 22.3 (no tenant context exists at
      // checkout yet), and the customerId filter alone hides every other
      // customer's orders (404-equivalent non-disclosure).
      customerId: req.user.customerId,
    }).sort({ createdAt: -1 }).limit(100).lean();
    // PHASE 2 — customer payloads carry the fulfilling Shop, never the
    // internal workspace id (staff payloads below keep it: operational need).
    const shopMap = await activeShopMap(docs.map((o) => o.workspaceId));
    const orders = docs.map((o) =>
      publicShopRecord(o, o.workspaceId ? shopMap.get(String(o.workspaceId)) || null : null)
    );
    res.json({ success: true, orders });
  } catch (err) {
    next(err);
  }
}

export async function getOrder(req, res, next) {
  try {
    const order = await Order.findOne({
      orderId: req.params.id,
      ...requestScope(req),
    });
    if (!order) {
      throw new ApiError(404, 'Order not found.', 'ORDER_NOT_FOUND');
    }
    // Customer can only read their own order; staff can read all IN ITS
    // WORKSPACE (the scope above already returned 404 for other tenants).
    const isStaff = ['admin', 'handler'].includes(req.user.role);
    if (!isStaff && String(order.customerId) !== String(req.user.customerId || '')) {
      // Do not leak existence to other customers.
      throw new ApiError(404, 'Order not found.', 'ORDER_NOT_FOUND');
    }
    if (isStaff) return res.json({ success: true, order });
    // Customer payload: the fulfilling Shop, never the internal workspace id.
    const shop = await activeShopForId(order.workspaceId);
    res.json({ success: true, order: publicShopRecord(order.toJSON(), shop) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/orders — customer-only. Identity comes from the JWT; a client
 * supplied customerId is ignored. Prices/totals are recomputed server-side.
 */
export async function createCustomerOrder(req, res, next) {
  try {
    if (req.user.role !== 'customer' || !req.user.customerId) {
      throw new ApiError(403, 'Only authenticated customers can place orders.', 'FORBIDDEN');
    }
    const customer = await Customer.findOne({
      // Identity comes from the JWT, never the body. Customers are global
      // records with no workspaceId on the storefront side in Phase 22.3 —
      // they are re-hidden by ORDER ownership checks, not by membership.
      _id: req.user.customerId,
    });
    if (!customer) {
      throw new ApiError(404, 'Customer profile not found.', 'NOT_FOUND');
    }

    const { items, paymentMethod, shippingAddress, giftMessage, isRush, shopSlug } = req.body || {};
    // PHASE 2 §6 — the order's fulfilment shop, resolved server-side. The
    // explicit slug (studio selection / shop page context) is validated; a
    // studio gift with no slug resolves the single live shop when that is
    // unambiguous and is refused otherwise. No client `workspaceId` is ever
    // read (it is scrubbed globally in server.js).
    const workspaceId = await resolveOrderWorkspace({ shopSlug, items });
    const order = await createOrder({
      customer,
      items,
      paymentMethod,
      shippingAddress,
      giftMessage,
      isRush,
      workspaceId,
    });

    // Generate notification for admin/handler — one batched insertMany
    // instead of an awaited create per staff member (Phase 17 N+1 fix).
    const staffUsers = await User.find({
      role: { $in: ['admin', 'handler'] },
      // Phase 22.3 — only the workspace that OWNS the order is told. Customer
      // orders are unattributed in 22.3, so this resolves to {} and every
      // active staff member is notified, exactly as before; once storefront
      // orders carry a workspaceId the broadcast narrows by itself.
      ...workspaceIdScope(getWorkspaceId(order)),
    }).select('_id role');
    await createNotificationsForUsers(staffUsers, {
      type: 'new_order',
      title: `New order ${order.orderId}`,
      message: `${customer.name} placed an order for ₹${order.total.toLocaleString('en-IN')}.`,
      entityType: 'order',
      entityId: order._id,
      link: `/admin/orders/${order.orderId}`,
      workspaceId: getWorkspaceId(order),
    });

    // Customer-facing response: the fulfilling Shop, never the internal
    // workspace id (the checkout page holds this object in browser state).
    const shop = await activeShopForId(order.workspaceId);
    res.status(201).json({ success: true, order: publicShopRecord(order.toJSON(), shop) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/orders/admin — handler/admin creates an order for a chosen
 * existing customer (e.g. phone order). The customer must exist; prices and
 * totals are still recomputed server-side and inventory is deducted
 * transactionally. A handler can never impersonate a customer for their own
 * account operations — this is an explicit staff action on a verified customer.
 */
export async function createStaffOrder(req, res, next) {
  try {
    const { customerId, items, shippingAddress, giftMessage, paymentMethod, isRush } = req.body || {};
    if (!customerId) {
      throw new ApiError(422, 'A customer must be selected for this order.', 'VALIDATION_ERROR');
    }
    const customer = await Customer.findOne({
      // Global by design: customers are shared identities with no workspaceId
      // binding of their own; attribution lands on the ORDER instead.
      _id: customerId,
    });
    if (!customer) {
      throw new ApiError(404, 'Customer not found.', 'NOT_FOUND');
    }
    // Staff orders are recorded business transactions (e.g. a phone order) with
    // no customer-facing payment flow — they never enter Razorpay 'Pending'
    // limbo and always keep the prototype 'Sample' settlement marker.
    // The order is attributed to the calling staff member's workspace
    // (server-derived; a smuggled body value never reaches this point).
    const order = await createOrder({
      customer,
      items,
      shippingAddress,
      giftMessage,
      paymentMethod: paymentMethod === 'UPI' ? 'Sample' : paymentMethod,
      isRush,
      forceSamplePayment: true,
      allowLegacyPricing: true,
      workspaceId: getWorkspaceId(req.user),
    });
    res.status(201).json({ success: true, order });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/orders/:id/status — handler/admin only; forward transitions only.
 */
export async function updateOrderStatus(req, res, next) {
  try {
    const order = await Order.findOne({
      orderId: req.params.id,
      ...requestScope(req),
    });
    if (!order) {
      throw new ApiError(404, 'Order not found.', 'ORDER_NOT_FOUND');
    }
    const { status } = req.body || {};
    if (!status) {
      throw new ApiError(422, 'A target status is required.', 'VALIDATION_ERROR');
    }
    const nextStatus = String(status).toLowerCase();
    assertValidTransition(order, nextStatus);
    // Phase 23 — permitted-OPERATION check on top of the shared lifecycle
    // rule: a handler advances one stage at a time (no skipping the quality
    // gate), an administrator keeps the documented fast-forward.
    const verdict = evaluateOperationalAction(req.user, {
      resource: 'order',
      name: 'advanceStage',
      from: order.orderStatus,
      value: nextStatus,
    });
    if (!verdict.allowed) {
      throw new ApiError(403, verdict.message, verdict.code);
    }
    // GRANULAR STAFF ACCESS — the exact permission for the STAGE being written
    // (accept / production status / fulfilment / completion). Administrators
    // keep every stage; a handler needs the matching authority, so a role that
    // may pack an order still cannot declare it delivered.
    const stagePermission = permissionForOrderStatus(nextStatus);
    if (stagePermission) assertPermission(req.user, stagePermission);

    order.orderStatus = nextStatus;
    order.statusHistory.push({
      status: nextStatus,
      note: req.body.note || '',
      changedBy: req.user.name || req.user.email,
    });
    order.updatedAt = new Date();
    await order.save();

    // Notify customer of status change
    if (order.customerId) {
      await createNotification({
        userId: order.customerId,
        role: 'customer',
        type: 'order_status_change',
        title: `Order ${order.orderId} updated`,
        message: `Your order status has been updated to ${nextStatus}.`,
        entityType: 'order',
        entityId: order._id,
        link: `/order-tracking/${order.orderId}`,
        workspaceId: getWorkspaceId(order),
      });
    }

    res.json({ success: true, order, availableNext: NEXT_STATUS[nextStatus] || null });
  } catch (err) {
    next(err);
  }
}
