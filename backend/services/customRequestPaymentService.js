import CustomRequest from '../models/CustomRequest.js';
import Proposal from '../models/Proposal.js';
import User from '../models/User.js';
import { createNotification, createNotificationsForUsers } from '../controllers/notificationController.js';
import { getWorkspaceId, workspaceIdScope } from '../utils/tenancy.js';

/**
 * PAYMENT SETTLEMENT HOOK — called by the EXISTING payment architecture
 * (signature verification and the Razorpay webhook) when an order becomes
 * Paid.
 *
 * When the order settles an accepted custom-request proposal
 * (order.customRequestId), the request moves payment_pending → paid here.
 *
 * Idempotent by construction: the update is filtered on the request still
 * being `payment_pending`, so duplicate verifications, webhook re-delivery and
 * the verify-then-webhook race can never double-apply or regress state.
 * Returns the updated request, or null when there was nothing to settle.
 */
export async function markRequestPaidForOrder(order) {
  if (!order?.customRequestId) return null;

  // PHASE 2 §7/§9 — settle ONLY the request this order actually belongs to.
  // When both sides carry a shop they must be the SAME one: a mismatch is a
  // data-integrity error, and the right response is to settle nothing rather
  // than mark another shop's request paid. Legacy pairs that predate shop
  // attribution (either side unscoped) keep their historical behaviour.
  const existing = await CustomRequest.findOne({ _id: order.customRequestId })
    .select('workspaceId status')
    .lean();
  if (!existing || existing.status !== 'payment_pending') return null; // ordinary · settled · not due
  const orderShop = order.workspaceId ? String(order.workspaceId) : '';
  const requestShop = existing.workspaceId ? String(existing.workspaceId) : '';
  if (orderShop && requestShop && orderShop !== requestShop) {
    console.error(
      '[custom-request] refusing to settle a request owned by another shop',
      { orderId: order.orderId, customRequestId: String(order.customRequestId) }
    );
    return null;
  }

  const request = await CustomRequest.findOneAndUpdate(
    { _id: order.customRequestId, status: 'payment_pending' },
    { status: 'paid' },
    { new: true }
  );
  if (!request) return null; // ordinary order · already settled · not awaiting payment

  if (order.proposalId) {
    await Proposal.updateOne(
      { _id: order.proposalId },
      { paidAt: new Date(), orderId: order.orderId }
    );
  }

  await createNotification({
    userId: request.customerId,
    role: 'customer',
    type: 'custom_request_paid',
    title: 'Payment received',
    message: 'Payment received for your custom request — our studio will begin crafting your gift.',
    entityType: 'custom_request',
    entityId: request._id,
    link: `/account/requests/${request._id}`,
    workspaceId: getWorkspaceId(request),
  });

  const staffUsers = await User.find({
    role: { $in: ['admin', 'handler'] },
    ...workspaceIdScope(getWorkspaceId(request)),
  }).select('_id role');
  await createNotificationsForUsers(staffUsers, {
    type: 'custom_request_paid',
    title: 'Custom request paid',
    message: `Payment received for custom request #${String(request._id).slice(-6).toUpperCase()} — fulfillment can begin.`,
    entityType: 'custom_request',
    entityId: request._id,
    link: `/admin/custom-requests/${request._id}`,
    workspaceId: getWorkspaceId(request),
  });

  return request;
}
