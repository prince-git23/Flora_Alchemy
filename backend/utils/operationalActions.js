/**
 * Phase 23 — HANDLER OPERATIONAL ACTION POLICY (single source of truth).
 *
 * The Staff/Handler Action Center lets a handler work through every operational
 * action their workspace assigns them. Two questions are deliberately kept
 * apart, exactly like the Phase 21.1 portal policy:
 *
 *   1. MAY this identity touch this WORKSPACE at all?
 *      → middleware/workspaceMiddleware.js (requireWorkspace) + the tenancy
 *        scope every controller spreads into its own queries. Never decided
 *        here, and never decided from a client-supplied workspaceId (that field
 *        is stripped from the request body by stripClientWorkspaceId).
 *
 *   2. MAY this identity perform THIS OPERATION on a resource it can reach?
 *      → this module. Roles stay `customer | handler | admin` and the Owner is
 *        still an admin with `isOwner = true`; nothing about the role model
 *        changes here. What this module adds is the missing piece: an explicit,
 *        enumerable statement of which operations a HANDLER may perform, so a
 *        handler's reach is a decision rather than an accident of which router
 *        happened to use `adminOrHandler`.
 *
 * WORK AREAS are the studio's work lanes (packaging, floral sculpting,
 * letterpress, dyeing/binding, logistics, quality assurance). They are FILTERS
 * over operational work, not a capability list and not a permission — a work
 * item is labelled with the lane its current stage belongs to. They are NOT a
 * new persisted taxonomy: the platform has no WorkCategory collection, and this
 * phase deliberately does not invent one (orders, custom requests, inventory
 * movements, conversations and notifications remain the work sources).
 */

import { ORDER_STATUSES, NEXT_STATUS } from '../models/Order.js';

/** The six studio work lanes — filters, never capabilities. */
export const WORK_AREAS = [
  'Packaging & Keepsake Boxes',
  'Floral Sculpting & Pipe Craft',
  'Letterpress & Deckled Stationery',
  'Petal Dyeing & Wire Binding',
  'Logistics & Courier Fulfillment',
  'Botanical Quality Assurance',
];

/** Custom-request lifecycle (backend/models/CustomRequest.js). */
export const CUSTOM_REQUEST_STATUSES = ['pending', 'reviewing', 'quoted', 'accepted', 'declined'];

/**
 * The subset a HANDLER may set. Declining a bespoke commission is a business
 * decision (it ends the customer relationship for that request), so it stays
 * with the workspace owner — an administrator. Everything on the way there
 * (reviewing, quoted, accepted) is operational work a handler is assigned.
 */
export const HANDLER_CUSTOM_REQUEST_STATUSES = ['pending', 'reviewing', 'quoted', 'accepted'];

/** Operations reserved for administrators, refused for handlers with a reason. */
export const ADMIN_ONLY_OPERATIONS = ['custom_request:decline', 'order:skipStage'];

/** Human label for a pipeline stage, used in the refusal message. */
function stageLabel(status) {
  return String(status || '').replace(/_/g, ' ');
}

function refuse(code, message) {
  return { allowed: false, code, message };
}

/**
 * The one place a per-operation decision is made.
 *
 * @param {object|null} user  the DB-backed user (protect re-reads it per request)
 * @param {{resource: string, name: string, value?: any}} action
 * @returns {{allowed: boolean, code?: string, message?: string}}
 */
export function evaluateOperationalAction(user, action) {
  if (!user) {
    return refuse('UNAUTHORIZED', 'Authentication required.');
  }
  // Administrators and owners already hold every workspace capability; their
  // limits live in the workspace/tenancy gates, not here.
  if (user.role === 'admin') return { allowed: true };

  if (user.role !== 'handler') {
    return refuse('FORBIDDEN', 'You do not have permission to perform this action.');
  }

  const resource = action?.resource;
  const name = action?.name;

  if (resource === 'custom_request' && name === 'setStatus') {
    if (!HANDLER_CUSTOM_REQUEST_STATUSES.includes(String(action.value))) {
      return refuse(
        'ACTION_NOT_PERMITTED',
        'Declining a custom request is a business decision reserved for administrators. Move it to review, send a quote or accept it instead.'
      );
    }
  }

  // Orders: the lifecycle is shared, but a handler works it one stage at a
  // time. Advancing an order is a real hand-off (production → quality gate →
  // packing → dispatch), and the platform's forward-only rule alone would let
  // a handler declare an unbuilt order shipped. An administrator keeps the
  // fast-forward for genuine exceptions (this is what api-smoke asserts).
  if (resource === 'order' && name === 'advanceStage') {
    const from = String(action.from || '');
    const to = String(action.value || '');
    const next = NEXT_STATUS[from];
    if (!ORDER_STATUSES.includes(from) || !ORDER_STATUSES.includes(to)) {
      return refuse('VALIDATION_ERROR', `Unknown order status "${to}".`);
    }
    if (next !== to) {
      return refuse(
        'ACTION_NOT_PERMITTED',
        `Handlers advance an order one stage at a time. Move it to ${stageLabel(next || 'the next stage')} first — an administrator can jump stages for an exception.`
      );
    }
  }

  return { allowed: true };
}

/**
 * The operations a handler is explicitly permitted to perform, for clients that
 * want to render only the actions that can actually succeed. Presentation only:
 * the server re-decides every request through evaluateOperationalAction, so a
 * client that renders a forbidden button still gets the refusal above.
 */
export function permittedHandlerOperations() {
  return {
    workspaces: 'own-only',
    orders: ['view', 'advanceStage:one-step', 'createForCustomer'],
    customRequests: ['view', 'setStatus:' + HANDLER_CUSTOM_REQUEST_STATUSES.join('|')],
    inventory: ['view', 'history', 'recordMovement'],
    conversations: ['view', 'reply', 'markRead'],
    notifications: ['view', 'markRead', 'requestElevation'],
    catalogue: ['view', 'edit', 'create'],
    adminOnly: ADMIN_ONLY_OPERATIONS,
    ownerOnly: ['administrators', 'invitations', 'applications', 'platformSettings', 'workspaceLifecycle'],
  };
}
