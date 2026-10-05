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
import {
  activeShopBySlug,
  activeShopForId,
  activeShopMap,
  anyWorkspaceExists,
  publicShopRecord,
} from '../utils/publicShop.js';

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

/**
 * PHASE 2 §4 — resolve the ONE authoritative Shop for a new custom request.
 *
 * Pure server-side resolution from stored data:
 *
 *   RULE A  product-originated → `Product.workspaceId`. A client `shopSlug`
 *           must MATCH the product's shop (409 SHOP_MISMATCH otherwise); a
 *           product whose shop is suspended/pending/deleted is not a
 *           publicly discoverable creation and is refused (404).
 *   RULE B  standalone → the customer MUST name an ACTIVE shop (`shopSlug`).
 *   RULE C  malformed / unknown / suspended slug → 422 SHOP_NOT_FOUND, and
 *           nothing is created.
 *   COMPAT  while the deployment has NO workspace document at all there is no
 *           shop that could own the request, so the historical platform
 *           request stays representable (the same switch the workspace
 *           middleware uses to admit unscoped staff).
 *
 * @returns {Promise<{product: object|null, workspaceId: import('mongoose').Types.ObjectId|null, shop: object|null}>}
 */
async function resolveRequestDestination({ productId, shopSlug }) {
  const slug = String(shopSlug || '').trim().toLowerCase();
  let product = null;

  if (productId) {
    const key = String(productId).trim();
    // An unusable product context is a 422 (payload validation failure): the
    // submission cannot be accepted, which is also the pre-Phase-2 contract.
    if (!key) throw new ApiError(422, 'That product could not be found.', 'PRODUCT_NOT_FOUND');
    // Read the product WITHOUT a tenant filter: this is the storefront
    // catalogue the customer can already see, and the product itself is the
    // source of truth for which shop owns the request. `productId` is the
    // storefront identifier (slug); a raw ObjectId is also accepted.
    const query = mongoose.isValidObjectId(key)
      ? { $or: [{ slug: key }, { _id: key }] }
      : { slug: key };
    product = await Product.findOne(query).select('name slug workspaceId').lean();
    if (!product) throw new ApiError(422, 'That product could not be found.', 'PRODUCT_NOT_FOUND');
  }

  if (product && product.workspaceId) {
    // RULE A — the Product's shop is the destination, full stop. A product
    // whose shop is suspended/pending/deleted is not publicly discoverable,
    // so it cannot be commissioned.
    const owner = await activeShopForId(product.workspaceId);
    if (!owner) throw new ApiError(422, 'That product could not be found.', 'PRODUCT_NOT_FOUND');
    if (slug && slug !== owner.slug) {
      throw new ApiError(
        409,
        'This creation is fulfilled by a different shop — a request cannot be moved to another one.',
        'SHOP_MISMATCH'
      );
    }
    return { product, workspaceId: product.workspaceId, shop: owner };
  }

  // RULES B/C — standalone (or a legacy product with no shop of its own).
  if (slug) {
    const resolved = await activeShopBySlug(slug);
    if (!resolved) {
      throw new ApiError(
        422,
        'This shop is not available for custom requests right now.',
        'SHOP_NOT_FOUND'
      );
    }
    return { product, workspaceId: resolved.workspaceId, shop: resolved.shop };
  }
  if (await anyWorkspaceExists()) {
    throw new ApiError(
      422,
      'Please choose the shop that should make your gift.',
      'SHOP_REQUIRED'
    );
  }
  // Pre-onboarding/compatibility deployment: no shop exists to own it.
  return { product, workspaceId: null, shop: null };
}

export async function createCustomRequest(req, res, next) {
  try {
    const { description, occasion, budget, colors, desiredDate, imageUrl, productId, shopSlug } = req.body;
    if (!description || description.trim().length < 10) {
      throw new ApiError(422, 'Please describe your custom gift idea in at least 10 characters.');
    }

    // ── Authoritative destination (PHASE 2 §4) ─────────────────────────
    // Every request MUST have exactly ONE owning Shop, resolved HERE from
    // stored data — never from browser/tenant state:
    //
    //   · product-originated → the Product's own workspace, and a client
    //     `shopSlug` must MATCH it (mismatch → 409 SHOP_MISMATCH, nothing
    //     created); a suspended/non-discoverable shop cannot receive the
    //     request at all;
    //   · standalone → an explicit ACTIVE `shopSlug` (unknown/malformed/
    //     suspended → rejected); once the platform has ANY workspace, a
    //     missing shop is a 422 SHOP_REQUIRED — no unassigned request exists
    //     to float between shops;
    //   · a deployment that has never been onboarded (no Workspace document
    //     at all) keeps the historical platform behaviour.
    //
    // `workspaceId` is scrubbed from every body in server.js
    // (stripClientWorkspaceId), so a forged tenant field cannot reach this
    // line, and `shopSlug` is only ever a slug to be LOOKED UP.
    const { product, workspaceId, shop } = await resolveRequestDestination({ productId, shopSlug });

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
      // Server-derived tenancy (never client-supplied).
      workspaceId: workspaceId || undefined,
      status: 'pending',
    });
    // Notify ONLY the staff of the workspace that OWNS the request — batched
    // insertMany (Phase 17). With a shop resolved above this broadcast can
    // never cross tenants (an unonboarded deployment notifies its staff as
    // it always did).
    const staffUsers = await User.find({
      role: { $in: ['admin', 'handler'] },
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

    // Customer-facing payload: the owning Shop, never the internal tenant id.
    res.status(201).json({ success: true, request: publicShopRecord(request, shop) });
  } catch (err) {
    next(err);
  }
}

export async function listMyCustomRequests(req, res, next) {
  try {
    // adminNotes are internal staff observations — never shipped to customers.
    const docs = await CustomRequest.find({
      // Identity-scoped by the JWT's customerId. Customer-authored requests
      // carry no workspaceId in Phase 22.3 — the STAFF side is what gets
      // workspace-scoped (listAllCustomRequests below).
      customerId: req.user.customerId,
    })
      .select('-adminNotes')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    // Customer payloads carry the owning SHOP (Phase 1 projection) and never
    // the internal workspace id.
    const shopMap = await activeShopMap(docs.map((d) => d.workspaceId));
    res.json({
      success: true,
      requests: docs.map((d) =>
        publicShopRecord(d, d.workspaceId ? shopMap.get(String(d.workspaceId)) || null : null)
      ),
    });
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

    // ONE lookup site for both identities:
    //   · staff     → the request must live in the caller's workspace
    //                 (requestScope → a cross-tenant id reads as 404);
    //   · customer  → the request must be owned by the JWT's customerId
    //                 (customers are global identities with no workspace, so
    //                  requestScope(req) is {} for them by design).
    const requestQuery = CustomRequest.findOne({
      _id: id,
      ...(isStaff ? requestScope(req) : { customerId: req.user.customerId }),
    });
    if (!isStaff) requestQuery.select('-adminNotes');
    const request = await requestQuery.lean();
    if (!request) throw new ApiError(404, 'Custom request not found.');

    // Child records are read against the SAME workspace the request belongs to
    // (a genuinely unscoped legacy request keeps its historical behaviour),
    // and a customer additionally sees only their own order.
    const proposal = await Proposal.findOne({
      customRequestId: request._id,
      ...workspaceIdScope(request.workspaceId),
    }).lean();
    const order = await Order.findOne({
      customRequestId: request._id,
      ...workspaceIdScope(request.workspaceId),
      ...(isStaff ? {} : { customerId: req.user.customerId }),
    })
      .select('orderId orderStatus paymentStatus total subtotal shipping items trackingNumber createdAt')
      .sort({ createdAt: -1 })
      .lean();

    if (isStaff) {
      return res.json({ success: true, request, proposal: proposal || null, order: order || null });
    }
    // Customer payload: the owning Shop, never the internal tenant id — the
    // proposal belongs to the same shop as the request (Phase 2 §7), so it is
    // projected with that same shop identity.
    const shop = await activeShopForId(request.workspaceId);
    res.json({
      success: true,
      request: publicShopRecord(request, shop),
      proposal: proposal ? publicShopRecord(proposal, shop) : null,
      order: order || null,
    });
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
