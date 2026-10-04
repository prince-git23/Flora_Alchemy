import mongoose from 'mongoose';
import CustomRequest, {
  REQUEST_STATUSES,
  REQUEST_TRANSITIONS,
  SYSTEM_ONLY_REQUEST_STATUSES,
} from '../models/CustomRequest.js';
import Proposal from '../models/Proposal.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { createNotification, createNotificationsForUsers } from './notificationController.js';
import { getWorkspaceId, requestScope, workspaceIdScope } from '../utils/tenancy.js';
import { evaluateOperationalAction } from '../utils/operationalActions.js';
import { permissionForRequestStatus } from '../utils/permissions.js';
import { assertPermission } from '../middleware/permissionMiddleware.js';

/**
 * Normalise + validate the OPTIONAL reference image reference.
 *
 * Accepted (matching the app's storage conventions):
 *  · an absolute http(s) URL — e.g. an ImageKit CDN URL returned by the
 *    validated upload endpoint, or a link the customer pasted;
 *  · a relative `/uploads/<file>` path — the local-storage fallback the
 *    upload endpoint returns when ImageKit is not configured.
 *
 * Everything else (javascript:, data:, file:, oversized values) is refused
 * with an honest 422 so the admin page can never be handed a URL that only
 * exists to break rendering.
 */
export function normalizeImageUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.length > 2048) {
    throw new ApiError(422, 'The reference image link is too long.', 'VALIDATION_ERROR');
  }
  if (/^https?:\/\/[^\s]+$/i.test(value)) return value;
  if (/^\/uploads\/[A-Za-z0-9._-]+$/.test(value)) return value;
  throw new ApiError(
    422,
    'The reference image must be an uploaded file or a link starting with http:// or https://.',
    'VALIDATION_ERROR'
  );
}

export async function createCustomRequest(req, res, next) {
  try {
    const { description, occasion, budget, colors, desiredDate, imageUrl, productId } = req.body;
    if (!description || description.trim().length < 10) {
      throw new ApiError(422, 'Please describe your custom gift idea in at least 10 characters.');
    }

    // ── Product context ─────────────────────────────────────────────────
    // A request started from a catalogue product carries that product's
    // identity. The workspace is DERIVED here from the stored Product — the
    // client never supplies a workspace, so it cannot switch tenant context.
    // `workspaceId` is additionally scrubbed from every body in server.js
    // (stripClientWorkspaceId), so even a forged field cannot reach this line.
    //
    // `productId` is the storefront identifier the customer already has (the
    // product SLUG); a raw ObjectId is also accepted so internal callers work.
    // The product may legitimately have no workspace (single-workspace /
    // pre-migration catalogue), in which case the request stays unassigned.
    let product = null;
    if (productId) {
      const key = String(productId).trim();
      if (!key) throw new ApiError(422, 'That product could not be found.');
      // Read the product WITHOUT a tenant filter: this is the storefront
      // catalogue the customer can already see, and the product itself is the
      // source of truth for which workspace owns the request.
      const query = mongoose.isValidObjectId(key) ? { $or: [{ slug: key }, { _id: key }] } : { slug: key };
      product = await Product.findOne(query).select('name workspaceId').lean();
      if (!product) {
        throw new ApiError(422, 'That product could not be found.');
      }
    }

    const request = await CustomRequest.create({
      customerId: req.user.customerId,
      description: description.trim(),
      occasion: occasion || '',
      budget: budget || '',
      colors: colors || '',
      desiredDate: desiredDate || null,
      // Optional reference image — validated to an http(s)/uploads reference.
      imageUrl: normalizeImageUrl(imageUrl),
      productId: product ? product._id : undefined,
      productName: product ? product.name : '',
      // Server-derived tenancy. Absent for a general request → unassigned.
      workspaceId: product ? product.workspaceId || undefined : undefined,
      status: 'pending',
    });
    // Notify staff of new custom request — batched insertMany (Phase 17).
    const staffUsers = await User.find({
      role: { $in: ['admin', 'handler'] },
      // Only the workspace that OWNS the request hears about it. A request
      // derived from a product notifies that product's workspace; a general
      // request has no workspace and therefore reaches every active staff
      // member for triage (unchanged pre-22.3 behaviour).
      ...workspaceIdScope(getWorkspaceId(request)),
    }).select('_id role');
    await createNotificationsForUsers(staffUsers, {
      type: 'new_custom_request',
      title: 'New custom request',
      message: `A new custom gift request has been submitted (${occasion || 'general'}).`,
      entityType: 'custom_request',
      entityId: request._id,
      link: `/admin/custom-requests/${request._id}`,
      workspaceId: getWorkspaceId(request),
    });

    res.status(201).json({ success: true, request });
  } catch (err) {
    next(err);
  }
}

export async function listMyCustomRequests(req, res, next) {
  try {
    // adminNotes are internal staff observations — never shipped to customers.
    const requests = await CustomRequest.find({
      // Identity-scoped by the JWT's customerId. Customer-authored requests
      // carry no workspaceId in Phase 22.3 — the STAFF side is what gets
      // workspace-scoped (listAllCustomRequests below).
      customerId: req.user.customerId,
    })
      .select('-adminNotes')
      .sort({ createdAt: -1 });
    res.json({ success: true, requests });
  } catch (err) {
    next(err);
  }
}

export async function listAllCustomRequests(req, res, next) {
  try {
    const { status } = req.query;
    const match = {};
    if (status && status !== 'All') {
      if (!REQUEST_STATUSES.includes(status)) throw new ApiError(422, 'Invalid status filter.');
      match.status = status;
    }
    const requests = await CustomRequest.find({ ...requestScope(req), ...match })
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ success: true, requests });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/custom-requests/:id
 *
 * One request for its OWNER (customer) or for staff in the request's
 * workspace. The same payload powers the customer tracker/proposal view and
 * the admin fulfillment workspace:
 *   { request, proposal, order }
 *
 *  · customer  → request WITHOUT adminNotes, their own proposal + order;
 *  · staff     → full request, workspace-scoped (cross-workspace id → 404).
 */
export async function getCustomRequest(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Custom request not found.');
    const isStaff = ['admin', 'handler'].includes(req.user.role);

    let request;
    if (isStaff) {
      request = await CustomRequest.findOne({ _id: id, ...requestScope(req) }).lean();
    } else {
      request = await CustomRequest.findOne({
        _id: id,
        customerId: req.user.customerId,
      })
        .select('-adminNotes')
        .lean();
    }
    if (!request) throw new ApiError(404, 'Custom request not found.');

    const proposal = await Proposal.findOne({ customRequestId: request._id }).lean();
    const orderQuery = { customRequestId: request._id };
    if (!isStaff) orderQuery.customerId = req.user.customerId;
    const order = await Order.findOne(orderQuery)
      .select('orderId orderStatus paymentStatus total subtotal shipping items trackingNumber createdAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, request, proposal: proposal || null, order: order || null });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/custom-requests/:id/status — staff decision / fulfillment stage.
 *
 * Every transition is validated server-side against REQUEST_TRANSITIONS:
 *  · terminal states (declined · customer_declined · completed) accept nothing;
 *  · REJECTING (declined) requires a persisted, customer-safe reason;
 *  · payment/customer states (payment_pending · paid · customer_declined) are
 *    written by the workflow itself and can never be set by hand.
 */
export async function updateCustomRequestStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status, adminNotes, rejectionReason } = req.body;
    if (!REQUEST_STATUSES.includes(status)) {
      throw new ApiError(422, 'Invalid status.');
    }
    if (SYSTEM_ONLY_REQUEST_STATUSES.includes(status)) {
      throw new ApiError(
        422,
        'That status is set by the workflow itself (customer decision / verified payment) and cannot be chosen manually.',
        'VALIDATION_ERROR'
      );
    }
    // Phase 23 — permitted-OPERATION check, separate from the role and
    // workspace gates the router already applied: a handler may move a request
    // through the review path, but declining a bespoke commission is a business
    // decision reserved for the workspace administrator.
    const verdict = evaluateOperationalAction(req.user, {
      resource: 'custom_request',
      name: 'setStatus',
      value: status,
    });
    if (!verdict.allowed) {
      throw new ApiError(403, verdict.message, verdict.code);
    }
    // GRANULAR STAFF ACCESS — the exact permission for the transition:
    // taking a request into review is `requests.claim`, quoting or accepting it
    // is `requests.update`, so support staff can claim without being able to
    // commit the studio to a price.
    const requestPermission = permissionForRequestStatus(status);
    if (requestPermission) assertPermission(req.user, requestPermission);

    // Transition validation against the CURRENT persisted state. The update
    // below is filtered on that same state, so two racing decisions can never
    // both land (the loser gets a clean 409, not a silent overwrite).
    const existing = await CustomRequest.findOne({ _id: id, ...requestScope(req) }).select('status');
    if (!existing) throw new ApiError(404, 'Custom request not found.');

    // Same status + admin notes = an internal-notes save, not a transition.
    // (The workspace view keeps notes and decisions on one panel; without
    // this, saving notes on an unchanged status would read as a no-op move.)
    if (String(existing.status) === status) {
      if (adminNotes === undefined) {
        throw new ApiError(422, `This request is already ${status}.`, 'VALIDATION_ERROR');
      }
      const noted = await CustomRequest.findOneAndUpdate(
        { _id: id, ...requestScope(req) },
        { adminNotes },
        { new: true }
      );
      if (!noted) throw new ApiError(404, 'Custom request not found.');
      return res.json({ success: true, request: noted });
    }

    // Rejection must carry a concise, customer-safe reason.
    let normalizedReason = '';
    if (status === 'declined') {
      normalizedReason = String(rejectionReason || '').trim();
      if (normalizedReason.length < 3) {
        throw new ApiError(422, 'Please give a short reason for declining this request.', 'VALIDATION_ERROR');
      }
      if (normalizedReason.length > 500) {
        throw new ApiError(422, 'The rejection reason is too long (max 500 characters).', 'VALIDATION_ERROR');
      }
    }

    const allowed = REQUEST_TRANSITIONS[existing.status] || [];
    if (!allowed.includes(status)) {
      throw new ApiError(
        422,
        `Cannot move this request from ${existing.status} to ${status}.`,
        'INVALID_TRANSITION'
      );
    }

    const update = { status };
    if (adminNotes !== undefined) update.adminNotes = adminNotes;
    if (status === 'declined') update.rejectionReason = normalizedReason;
    const request = await CustomRequest.findOneAndUpdate(
      { _id: id, status: existing.status, ...requestScope(req) },
      update,
      { new: true }
    );
    if (!request) {
      throw new ApiError(409, 'This request changed while you were deciding — please reload and try again.', 'CONFLICT');
    }

    // Notify customer of status change
    if (request.customerId) {
      const statusLabels = {
        pending: 'has been reopened for review',
        reviewing: 'is being reviewed',
        quoted: 'has been quoted',
        accepted: 'has been accepted — our studio will prepare your proposal',
        declined: 'could not be taken forward',
        in_progress: 'is now being crafted',
        completed: 'is complete',
      };
      const suffix = status === 'declined' && request.rejectionReason ? ` Reason: ${request.rejectionReason}` : '';
      await createNotification({
        userId: request.customerId,
        role: 'customer',
        type: 'custom_request_status',
        title: 'Custom request updated',
        message: `Your custom request ${statusLabels[status] || 'has been updated'}.${suffix}`,
        entityType: 'custom_request',
        entityId: request._id,
        link: `/account/requests/${request._id}`,
        workspaceId: getWorkspaceId(request),
      });
    }

    res.json({ success: true, request });
  } catch (err) {
    next(err);
  }
}
