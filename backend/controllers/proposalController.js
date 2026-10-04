import mongoose from 'mongoose';
import CustomRequest from '../models/CustomRequest.js';
import Proposal from '../models/Proposal.js';
import Order from '../models/Order.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { createNotification, createNotificationsForUsers } from './notificationController.js';
import { getWorkspaceId, requestScope, workspaceIdScope } from '../utils/tenancy.js';
import { createOrder, getShippingSettings } from '../services/orderService.js';

/**
 * PROPOSAL WORKFLOW — the bridge from an accepted custom request to a real,
 * payable order.
 *
 *   admin accepts request  →  builds dynamic itemised proposal (draft)
 *   → sends it             →  request quoted, proposal sent
 *   → customer accepts     →  request payment_pending + REAL order created
 *   → payment verified     →  request paid (paymentController hook)
 *   → admin fulfills       →  in_progress → completed
 *
 * Security contract (mirrors the rest of the platform):
 *  · staff only ever touch requests/proposals in THEIR workspace (requestScope
 *    → cross-workspace ids read as 404);
 *  · customers only ever touch their OWN request/proposal (JWT customerId);
 *  · every total is RECALCULATED server-side from stored data — a client can
 *    never submit or influence a lineTotal/subtotal/total;
 *  · the payable amount is the STORED proposal total, re-derived when the
 *    order is created; nothing from the request body is used for pricing.
 */

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const sumItems = (items) => round2(items.reduce((sum, item) => sum + item.lineTotal, 0));

function customerSafeOrder(order) {
  return {
    orderId: order.orderId,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    subtotal: order.subtotal,
    shipping: order.shipping,
    total: order.total,
    createdAt: order.createdAt,
  };
}

/** Load the request a STAFF caller may act on (workspace-scoped; 404 otherwise). */
async function loadStaffRequest(req) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Custom request not found.');
  const request = await CustomRequest.findOne({ _id: id, ...requestScope(req) });
  if (!request) throw new ApiError(404, 'Custom request not found.');
  return request;
}

/** Load the request a CUSTOMER caller owns (identity-scoped; 404 otherwise). */
async function loadOwnRequest(req) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Custom request not found.');
  const request = await CustomRequest.findOne({ _id: id, customerId: req.user.customerId });
  if (!request) throw new ApiError(404, 'Custom request not found.');
  return request;
}

/**
 * Validate + normalise admin-authored line items and calculate every total
 * server-side. Client-submitted lineTotal/subtotal/total fields are ignored
 * entirely — they are not even read.
 */
function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ApiError(422, 'A proposal needs at least one item.', 'VALIDATION_ERROR');
  }
  if (rawItems.length > 40) {
    throw new ApiError(422, 'A proposal supports at most 40 items.', 'VALIDATION_ERROR');
  }
  return rawItems.map((raw, index) => {
    const itemName = String(raw?.itemName ?? '').trim();
    if (!itemName) {
      throw new ApiError(422, `Item ${index + 1} needs a name.`, 'VALIDATION_ERROR');
    }
    if (itemName.length > 160) {
      throw new ApiError(422, `Item ${index + 1} has too long a name (max 160 characters).`, 'VALIDATION_ERROR');
    }
    const description = String(raw?.description ?? '').trim().slice(0, 500);
    const quantity = Math.floor(Number(raw?.quantity));
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) {
      throw new ApiError(422, `"${itemName}" needs a whole quantity between 1 and 99.`, 'VALIDATION_ERROR');
    }
    const unitPrice = round2(Number(raw?.unitPrice));
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1000000) {
      throw new ApiError(422, `"${itemName}" needs a unit price between 0 and 10,00,000.`, 'VALIDATION_ERROR');
    }
    // THE server calculation — quantity × unitPrice, computed here and stored.
    const lineTotal = round2(unitPrice * quantity);
    return { itemName, description, quantity, unitPrice, lineTotal, sortOrder: index };
  });
}

/**
 * Shipping follows the SAME rule the existing checkout applies (workspace
 * settings document, standard rate, free above the threshold). Locked in at
 * send time so the total the customer reviews is the total they pay.
 */
async function computeShipping(workspaceId, subtotal) {
  const settings = await getShippingSettings(null, workspaceId || null);
  const cfg = settings.shippingConfiguration || {};
  const threshold = Number(cfg.freeShippingThreshold) || 0;
  const standardRate = Number(cfg.standardRate) || 0;
  return subtotal >= threshold && threshold > 0 ? 0 : standardRate;
}

async function notifyStaffOfRequest(request, { type, title, message }) {
  const staffUsers = await User.find({
    role: { $in: ['admin', 'handler'] },
    ...workspaceIdScope(getWorkspaceId(request)),
  }).select('_id role');
  await createNotificationsForUsers(staffUsers, {
    type,
    title,
    message,
    entityType: 'custom_request',
    entityId: request._id,
    link: `/admin/custom-requests/${request._id}`,
    workspaceId: getWorkspaceId(request),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// STAFF — build / send / withdraw
// ─────────────────────────────────────────────────────────────────────────

/**
 * POST /api/custom-requests/:id/proposal
 * Create or replace the DRAFT proposal (only while the request is accepted and
 * nothing has been sent yet). Totals are always recalculated here.
 */
export async function saveProposalDraft(req, res, next) {
  try {
    const request = await loadStaffRequest(req);
    const existing = await Proposal.findOne({ customRequestId: request._id });

    if (request.status !== 'accepted') {
      throw new ApiError(
        409,
        request.status === 'quoted'
          ? 'A proposal is already with the customer — withdraw it before changing the items.'
          : 'The request must be accepted before a proposal can be built.',
        'INVALID_TRANSITION'
      );
    }
    if (existing && ['sent', 'accepted'].includes(existing.status)) {
      throw new ApiError(409, 'This proposal has already been sent — withdraw it before changing the items.', 'INVALID_TRANSITION');
    }

    const items = normalizeItems(req.body?.items);
    const subtotal = sumItems(items);
    const shipping = await computeShipping(request.workspaceId, subtotal);
    const total = round2(subtotal + shipping);

    const proposal = await Proposal.findOneAndUpdate(
      { customRequestId: request._id },
      {
        customRequestId: request._id,
        customerId: request.customerId,
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
        currency: 'INR',
        items,
        subtotal,
        shipping,
        total,
        status: 'draft',
        sentAt: null,
        respondedAt: null,
        declineReason: '',
        orderId: '',
        paidAt: null,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(existing?.status === 'withdrawn' ? 200 : 201).json({ success: true, request, proposal });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/custom-requests/:id/proposal/send
 * Lock the totals, mark the proposal sent and move the request to `quoted`.
 */
export async function sendProposal(req, res, next) {
  try {
    const request = await loadStaffRequest(req);
    if (request.status !== 'accepted') {
      throw new ApiError(409, 'Only an accepted request can be sent a proposal.', 'INVALID_TRANSITION');
    }
    const proposal = await Proposal.findOne({ customRequestId: request._id });
    if (!proposal) throw new ApiError(409, 'Build the proposal before sending it.', 'VALIDATION_ERROR');
    if (!proposal.items.length) throw new ApiError(422, 'A proposal needs at least one item.', 'VALIDATION_ERROR');
    if (proposal.status === 'sent') throw new ApiError(409, 'This proposal has already been sent.', 'INVALID_TRANSITION');

    // Recompute at send time — the number the customer sees is the number the
    // server just calculated from the stored items.
    const subtotal = sumItems(proposal.items);
    const shipping = await computeShipping(request.workspaceId, subtotal);
    proposal.subtotal = subtotal;
    proposal.shipping = shipping;
    proposal.total = round2(subtotal + shipping);
    proposal.status = 'sent';
    proposal.sentAt = new Date();
    proposal.respondedAt = null;
    proposal.declineReason = '';
    await proposal.save();

    const updated = await CustomRequest.findOneAndUpdate(
      { _id: request._id, status: 'accepted', ...requestScope(req) },
      { status: 'quoted', proposalSentAt: proposal.sentAt },
      { new: true }
    );
    if (!updated) {
      // Someone moved the request between our read and write — revert the
      // proposal so no "sent" state exists without its request.
      proposal.status = 'draft';
      proposal.sentAt = null;
      await proposal.save();
      throw new ApiError(409, 'This request changed while you were working — please reload.', 'CONFLICT');
    }

    await createNotification({
      userId: updated.customerId,
      role: 'customer',
      type: 'custom_request_proposal',
      title: 'Your custom gift proposal is ready',
      message: `Our studio prepared a proposal for your custom request — review it and accept to proceed with payment. Total ₹${Number(proposal.total).toLocaleString('en-IN')}.`,
      entityType: 'custom_request',
      entityId: updated._id,
      link: `/account/requests/${updated._id}`,
      workspaceId: getWorkspaceId(updated),
    });

    res.json({ success: true, request: updated, proposal });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/custom-requests/:id/proposal/withdraw
 * Withdraw a sent proposal the customer has NOT answered, so the studio can
 * rebuild it. The customer-visible record is never silently mutated.
 */
export async function withdrawProposal(req, res, next) {
  try {
    const request = await loadStaffRequest(req);
    const proposal = await Proposal.findOne({ customRequestId: request._id });
    if (!proposal) throw new ApiError(404, 'No proposal exists for this request.', 'NOT_FOUND');
    if (proposal.status !== 'sent') {
      throw new ApiError(409, 'Only a proposal the customer has not answered can be withdrawn.', 'INVALID_TRANSITION');
    }
    proposal.status = 'withdrawn';
    proposal.sentAt = null;
    await proposal.save();

    const updated = await CustomRequest.findOneAndUpdate(
      { _id: request._id, status: 'quoted', ...requestScope(req) },
      { status: 'accepted', proposalSentAt: null },
      { new: true }
    );
    if (!updated) throw new ApiError(409, 'This request changed while you were working — please reload.', 'CONFLICT');

    await createNotification({
      userId: updated.customerId,
      role: 'customer',
      type: 'custom_request_proposal',
      title: 'Your proposal is being revised',
      message: 'Our studio is revising the proposal for your custom request — a new version will be shared shortly.',
      entityType: 'custom_request',
      entityId: updated._id,
      link: `/account/requests/${updated._id}`,
      workspaceId: getWorkspaceId(updated),
    });

    res.json({ success: true, request: updated, proposal });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CUSTOMER — accept (→ real order) / decline
// ─────────────────────────────────────────────────────────────────────────

/**
 * Create the REAL order for an accepted proposal.
 *
 * The item list is constructed HERE from the stored proposal — the request
 * body is never read for pricing, quantity or workspace. `trustedItems` tells
 * the order service these prices are DB-derived and authoritative;
 * `shippingOverride` is the shipping locked in at send time, so the order
 * total equals the proposal total to the rupee.
 */
async function createProposalOrder({ request, proposal, customer }) {
  const items = proposal.items.map((item) => ({
    name: item.itemName,
    price: item.unitPrice,
    quantity: item.quantity,
    description: item.description || '',
    category: 'Custom Request',
    isCatalogue: false,
    customDetails: {
      source: 'custom-request-proposal',
      customRequestId: String(request._id),
      proposalItemId: String(item._id),
    },
  }));

  const defaultAddress =
    (customer.addresses || []).find((a) => a.isDefault) || (customer.addresses || [])[0] || {};

  const order = await createOrder({
    customer,
    items,
    paymentMethod: 'Instant UPI',
    shippingAddress: defaultAddress,
    giftMessage: request.occasion ? `Custom request — ${request.occasion}` : 'Custom request',
    forceSamplePayment: false,
    trustedItems: true,
    shippingOverride: proposal.shipping,
    customRequestId: request._id,
    proposalId: proposal._id,
    workspaceId: request.workspaceId || null,
  });

  // Reconcile against the proposal — this must hold to the rupee. If it ever
  // did not, the order is not chargeable and the customer must not see it.
  const expectedSubtotal = sumItems(proposal.items);
  if (
    Math.round(order.subtotal) !== Math.round(expectedSubtotal) ||
    Math.round(order.total) !== Math.round(expectedSubtotal + proposal.shipping)
  ) {
    throw new ApiError(500, 'The proposal total could not be reconciled — payment was not started.', 'TOTAL_MISMATCH');
  }
  return order;
}

/** POST /api/custom-requests/:id/proposal/accept — customer owner only. */
export async function acceptProposal(req, res, next) {
  try {
    const request = await loadOwnRequest(req);
    const proposal = await Proposal.findOne({ customRequestId: request._id });
    const customer = await Customer.findById(req.user.customerId).lean();
    if (!customer) throw new ApiError(404, 'Customer profile not found.', 'NOT_FOUND');

    // Already accepted (or paid) — idempotent continuation. If the order was
    // created, return it; if a previous attempt failed half-way, finish it.
    if (['payment_pending', 'paid'].includes(request.status)) {
      const existingOrder = await Order.findOne({
        customRequestId: request._id,
        customerId: req.user.customerId,
      }).sort({ createdAt: -1 });
      if (existingOrder) {
        return res.json({
          success: true,
          request,
          proposal,
          order: customerSafeOrder(existingOrder),
        });
      }
      if (proposal && proposal.status === 'accepted') {
        const order = await createProposalOrder({ request, proposal, customer });
        proposal.orderId = order.orderId;
        await proposal.save();
        return res.json({ success: true, request, proposal, order: customerSafeOrder(order) });
      }
      throw new ApiError(409, 'This request is not awaiting a proposal decision.', 'INVALID_TRANSITION');
    }

    if (request.status !== 'quoted') {
      throw new ApiError(422, 'There is no proposal waiting for your decision.', 'VALIDATION_ERROR');
    }
    if (!proposal || proposal.status !== 'sent') {
      throw new ApiError(409, 'This proposal is no longer available.', 'INVALID_TRANSITION');
    }

    // Claim the proposal atomically — a double-tap can never create two orders.
    const claimed = await Proposal.findOneAndUpdate(
      { _id: proposal._id, status: 'sent' },
      { status: 'accepted', respondedAt: new Date() },
      { new: true }
    );
    if (!claimed) throw new ApiError(409, 'This proposal has already been answered.', 'INVALID_TRANSITION');

    const updated = await CustomRequest.findOneAndUpdate(
      { _id: request._id, status: 'quoted' },
      { status: 'payment_pending', proposalRespondedAt: claimed.respondedAt },
      { new: true }
    );
    if (!updated) {
      claimed.status = 'sent';
      claimed.respondedAt = null;
      await claimed.save();
      throw new ApiError(409, 'This request changed while you were deciding — please reload.', 'CONFLICT');
    }

    const order = await createProposalOrder({ request: updated, proposal: claimed, customer });
    claimed.orderId = order.orderId;

    // Prototype environments (Razorpay not configured) settle as 'Sample' —
    // the frozen storefront behaviour — so the workflow stays honest and
    // unblocked. With Razorpay configured the order starts 'Pending' and the
    // request becomes `paid` only after the server verifies the payment.
    let finalRequest = updated;
    if (order.paymentStatus === 'Sample') {
      const settled = await CustomRequest.findOneAndUpdate(
        { _id: updated._id, status: 'payment_pending' },
        { status: 'paid' },
        { new: true }
      );
      if (settled) {
        finalRequest = settled;
        claimed.paidAt = new Date();
      }
    }
    await claimed.save();

    await notifyStaffOfRequest(finalRequest, {
      type: 'custom_request_accepted',
      title: 'Proposal accepted',
      message: `A customer accepted the proposal (₹${Number(claimed.total).toLocaleString('en-IN')}) — ${
        finalRequest.status === 'paid' ? 'payment recorded, fulfillment can begin.' : 'payment is due.'
      }`,
    });
    await createNotification({
      userId: finalRequest.customerId,
      role: 'customer',
      type: 'custom_request_proposal',
      title: 'Proposal accepted',
      message:
        finalRequest.status === 'paid'
          ? 'Thank you — your order is recorded and our studio will begin crafting your gift.'
          : `Thank you — your order ${order.orderId} is ready for payment.`,
      entityType: 'custom_request',
      entityId: finalRequest._id,
      link: `/account/requests/${finalRequest._id}`,
      workspaceId: getWorkspaceId(finalRequest),
    });

    res.json({
      success: true,
      request: finalRequest,
      proposal: claimed,
      order: customerSafeOrder(order),
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/custom-requests/:id/proposal/decline — customer owner only. */
export async function declineProposal(req, res, next) {
  try {
    const request = await loadOwnRequest(req);

    // Declining twice is a no-op, not a state error.
    if (request.status === 'customer_declined') {
      const proposal = await Proposal.findOne({ customRequestId: request._id });
      return res.json({ success: true, request, proposal });
    }
    if (request.status !== 'quoted') {
      throw new ApiError(422, 'There is no proposal waiting for your decision.', 'VALIDATION_ERROR');
    }
    const proposal = await Proposal.findOne({ customRequestId: request._id });
    if (!proposal || proposal.status !== 'sent') {
      throw new ApiError(409, 'This proposal is no longer available.', 'INVALID_TRANSITION');
    }

    proposal.status = 'declined';
    proposal.respondedAt = new Date();
    proposal.declineReason = String(req.body?.reason || '').trim().slice(0, 500);
    await proposal.save();

    const updated = await CustomRequest.findOneAndUpdate(
      { _id: request._id, status: 'quoted' },
      { status: 'customer_declined', proposalRespondedAt: proposal.respondedAt },
      { new: true }
    );
    if (!updated) throw new ApiError(409, 'This request changed while you were deciding — please reload.', 'CONFLICT');

    await notifyStaffOfRequest(updated, {
      type: 'custom_request_declined',
      title: 'Proposal declined',
      message: proposal.declineReason
        ? `A customer declined their custom request proposal. Reason: ${proposal.declineReason}`
        : 'A customer declined their custom request proposal.',
    });

    res.json({ success: true, request: updated, proposal });
  } catch (err) {
    next(err);
  }
}
