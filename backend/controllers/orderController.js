import Order, { NEXT_STATUS } from '../models/Order.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { assertValidTransition, createOrder } from '../services/orderService.js';
import { resolveOrderDestination } from '../services/orderDestinationService.js';
import { createNotification, createNotificationsForUsers } from './notificationController.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { evaluateOperationalAction } from '../utils/operationalActions.js';
import { permissionForOrderStatus } from '../utils/permissions.js';
import { assertPermission } from '../middleware/permissionMiddleware.js';
import { getWorkspaceId, requestScope, workspaceIdScope } from '../utils/tenancy.js';
import {
  activeShopForId,
  activeShopMap,
  customerOrderView,
} from '../utils/publicShop.js';

/**
 * PHASE 3 §17 — the SHOP IDENTITY attached to a CUSTOMER order payload.
 *
 * The live ACTIVE shop wins; when the shop has since been suspended (or
 * renamed), the order's own `shopSnapshot` keeps the customer's history
 * readable — an order never loses its shop because the shop changed state.
 * Authorization is untouched: it always uses the authoritative `workspaceId`,
 * never this display value.
 */
async function customerShopFor(order) {
  const live = await activeShopForId(order.workspaceId);
  if (live) return live;
  const snap = order.shopSnapshot;
  return snap && snap.slug
    ? { slug: snap.slug, displayName: snap.displayName || snap.slug }
    : null;
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
    const orders = docs.map((o) => {
      const live = o.workspaceId ? shopMap.get(String(o.workspaceId)) || null : null;
      // PHASE 3 — a suspended/renamed shop falls back to the order's own
      // historical snapshot so order history stays attributable.
      const snap = o.shopSnapshot;
      const historical = snap && snap.slug
        ? { slug: snap.slug, displayName: snap.displayName || snap.slug }
        : null;
      return customerOrderView(o, live || historical);
    });
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
    // Customer payload: the fulfilling Shop (live, else the historical
    // snapshot), never the internal workspace id — and strictly whitelisted
    // (Phase 22.5 MED-6): no provider ids, no signature flags, no staff
    // identity inside statusHistory.
    const shop = await customerShopFor(order);
    res.json({ success: true, order: customerOrderView(order, shop) });
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
    // PHASE 3 §6 — ONE ORDER, ONE WORKSPACE. The destination is derived from
    // the STORED ownership of every item (services/orderDestinationService
    // .js): products of several shops are refused outright
    // (409 MIXED_WORKSPACE_ORDER), a suspended shop refuses the order, and a
    // client `shopSlug` may only CONFIRM the items' own shop. No client
    // `workspaceId` is ever read (it is scrubbed globally in server.js).
    const destination = await resolveOrderDestination({ items, shopSlug, requireOrderable: true });
    const order = await createOrder({
      customer,
      items,
      paymentMethod,
      shippingAddress,
      giftMessage,
      isRush,
      workspaceId: destination.workspaceId,
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
    // Strict whitelist (Phase 22.5 MED-6) — same shape as GET /orders/:id.
    const shop = await customerShopFor(order);
    res.status(201).json({ success: true, order: customerOrderView(order, shop) });
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
    //
    // PHASE 3 §7 — the authenticated staff member's OWN workspace is the
    // authority: every catalogue item must belong to it (a shop-A staffer can
    // never book shop B's product into an A order) and the order is attributed
    // to it. Both values are server-derived — a smuggled body `workspaceId`
    // never reaches this point (it is scrubbed globally in server.js).
    const staffWorkspaceId = getWorkspaceId(req.user);
    const destination = await resolveOrderDestination({ items, staffWorkspaceId });
    const order = await createOrder({
      customer,
      items,
      shippingAddress,
      giftMessage,
      paymentMethod: paymentMethod === 'UPI' ? 'Sample' : paymentMethod,
      isRush,
      forceSamplePayment: true,
      allowLegacyPricing: true,
      workspaceId: destination.workspaceId,
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
