import { Router } from 'express';
import {
  createCustomRequest,
  listMyCustomRequests,
  getCustomRequest,
  listAllCustomRequests,
  updateCustomRequestStatus,
} from '../controllers/customRequestController.js';
import {
  saveProposalDraft,
  sendProposal,
  withdrawProposal,
  acceptProposal,
  declineProposal,
} from '../controllers/proposalController.js';
import { protect, adminOrHandler, requireRole } from '../middleware/authMiddleware.js';
import {
  requireWorkspace,
  requireWorkspaceForStaff,
} from '../middleware/workspaceMiddleware.js';
import {
  requirePermission,
  requireAnyPermission,
} from '../middleware/permissionMiddleware.js';

const router = Router();

router.use(protect);

// Customer: submit a custom request
router.post('/', createCustomRequest);

// Customer: list their own requests
router.get('/mine', listMyCustomRequests);

// Staff: list all requests (workspace members only)
router.get('/', adminOrHandler, requireWorkspace, requirePermission('requests.view'), listAllCustomRequests);

// One request with its proposal + order.
// Customers hit their OWN request (identity comes from the JWT; customers skip
// the staff gates); staff must be a workspace member holding requests.view and
// a cross-workspace id reads as 404.
router.get(
  '/:id',
  requireWorkspaceForStaff,
  requirePermission('requests.view', { skipNonStaff: true }),
  getCustomRequest
);

// Customer: accept / decline the proposal their studio sent.
// requireRole('customer') is the identity gate; ownership + workflow state are
// enforced in the controller from the JWT (never from the body).
router.post('/:id/proposal/accept', requireRole('customer'), acceptProposal);
router.post('/:id/proposal/decline', requireRole('customer'), declineProposal);

// Staff: build / send / withdraw the itemised proposal.
// Building a customer-visible quote is `requests.update` authority; the
// workspace gate answers 404 for another tenant's request.
router.post('/:id/proposal', adminOrHandler, requireWorkspace, requirePermission('requests.update'), saveProposalDraft);
router.post('/:id/proposal/send', adminOrHandler, requireWorkspace, requirePermission('requests.update'), sendProposal);
router.post('/:id/proposal/withdraw', adminOrHandler, requireWorkspace, requirePermission('requests.update'), withdrawProposal);

// Staff: update status (workspace members only; cross-workspace id → 404).
// The route admits anyone holding ANY request-write permission, then the
// controller re-checks the EXACT permission for the target status
// (reviewing → requests.claim, everything else → requests.update) through
// assertPermission, so a claim-only handler cannot quote or accept.
// Transitions are validated server-side against the request's persisted state.
router.patch(
  '/:id/status',
  adminOrHandler,
  requireWorkspace,
  requireAnyPermission(['requests.claim', 'requests.update']),
  updateCustomRequestStatus
);

export default router;
