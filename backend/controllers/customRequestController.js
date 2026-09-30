import CustomRequest from '../models/CustomRequest.js';
import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { createNotification, createNotificationsForUsers } from './notificationController.js';
import { getWorkspaceId, requestScope, workspaceIdScope } from '../utils/tenancy.js';
import { CUSTOM_REQUEST_STATUSES, evaluateOperationalAction } from '../utils/operationalActions.js';
import { permissionForRequestStatus } from '../utils/permissions.js';
import { assertPermission } from '../middleware/permissionMiddleware.js';

export async function createCustomRequest(req, res, next) {
  try {
    const { description, occasion, budget, colors, desiredDate, imageUrl } = req.body;
    if (!description || description.trim().length < 10) {
      throw new ApiError(422, 'Please describe your custom gift idea in at least 10 characters.');
    }
    const request = await CustomRequest.create({
      customerId: req.user.customerId,
      description: description.trim(),
      occasion: occasion || '',
      budget: budget || '',
      colors: colors || '',
      desiredDate: desiredDate || null,
      imageUrl: imageUrl || '',
      status: 'pending',
    });
    // Notify staff of new custom request — batched insertMany (Phase 17).
    const staffUsers = await User.find({
      role: { $in: ['admin', 'handler'] },
      // Only the workspace that OWNS the request hears about it; customer
      // submissions are unattributed in Phase 22.3, so this is every active
      // staff member — exactly the pre-22.3 behaviour.
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
    if (status && status !== 'All') match.status = status;
    const requests = await CustomRequest.find({ ...requestScope(req), ...match })
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ success: true, requests });
  } catch (err) {
    next(err);
  }
}

export async function updateCustomRequestStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status, adminNotes } = req.body;
    if (!CUSTOM_REQUEST_STATUSES.includes(status)) {
      throw new ApiError(422, 'Invalid status.');
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
    const update = { status };
    if (adminNotes !== undefined) update.adminNotes = adminNotes;
    // Filter-form update so the scope rides along: a request belonging to
    // another workspace reads as 404 instead of accepting the transition.
    const request = await CustomRequest.findOneAndUpdate(
      { _id: id, ...requestScope(req) },
      update,
      { new: true }
    );
    if (!request) throw new ApiError(404, 'Custom request not found.');

    // Notify customer of status change
    if (request.customerId) {
      const statusLabels = {
        reviewing: 'is being reviewed',
        quoted: 'has been quoted',
        accepted: 'has been accepted',
        declined: 'has been declined',
      };
      await createNotification({
        userId: request.customerId,
        role: 'customer',
        type: 'custom_request_status',
        title: 'Custom request updated',
        message: `Your custom request ${statusLabels[status] || 'has been updated'}.`,
        entityType: 'custom_request',
        entityId: request._id,
        link: `/account`,
        workspaceId: getWorkspaceId(request),
      });
    }

    res.json({ success: true, request });
  } catch (err) {
    next(err);
  }
}
