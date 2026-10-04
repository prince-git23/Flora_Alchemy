/**
 * Phase 23 — STAFF ACTION CENTER / WORKBENCH
 *
 * The handler's operational surface: every action a handler is legitimately
 * allowed to perform, in one place, driven by the operational records the
 * workspace already has. There is deliberately NO new persistence here — an
 * order, a custom request, a stock alert and a customer conversation ARE the
 * work items. No Task collection, no duplicate order/request representation.
 *
 * Boundaries this module respects:
 *   · Work is read from the shared store / existing services only. Every one of
 *     those reads is authorized server-side (role + workspace + tenancy scope),
 *     so the Action Center can never widen what a handler can reach.
 *   · The permitted ACTION set mirrors backend/utils/operationalActions.js.
 *     The mirror exists so the UI does not render buttons that can only fail;
 *     the server re-decides every request, so a forged client still gets 403.
 */
import { getOrders, ORDER_STATUSES as ORDER_STATUS_DEFS, getStatusLabel } from './orderService.js';
import { getInventory, getLowStockItems } from './inventoryService.js';

/**
 * The canonical pipeline as status KEYS, in lifecycle order.
 * orderService exports ORDER_STATUSES as UI objects ({ key, label, … }), so
 * the keys are derived here once — and only here — instead of every call site
 * guessing at the shape.
 */
const ORDER_PIPELINE = ORDER_STATUS_DEFS.map((s) => s.key);

/** The single next stage in the lifecycle, or undefined at the end. */
export function nextOrderStage(status) {
  const idx = ORDER_PIPELINE.indexOf(status);
  return idx >= 0 ? ORDER_PIPELINE[idx + 1] : undefined;
}

/** The six studio work lanes — filters over work, not capabilities. */
export const WORK_AREAS = [
  'Packaging & Keepsake Boxes',
  'Floral Sculpting & Pipe Craft',
  'Letterpress & Deckled Stationery',
  'Petal Dyeing & Wire Binding',
  'Logistics & Courier Fulfillment',
  'Botanical Quality Assurance',
];

export const WORK_SOURCES = [
  { key: 'all', label: 'All work' },
  { key: 'order', label: 'Orders' },
  { key: 'custom_request', label: 'Custom requests' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'conversation', label: 'Conversations' },
];

/**
 * Which lane a work item's CURRENT stage belongs to. Stage-driven, because the
 * lane names the work being done right now (packing, dispatch, quality), not
 * the product's storefront category.
 */
const ORDER_STAGE_AREAS = {
  new: 'Floral Sculpting & Pipe Craft',
  confirmed: 'Floral Sculpting & Pipe Craft',
  in_production: 'Floral Sculpting & Pipe Craft',
  quality_check: 'Botanical Quality Assurance',
  ready_to_dispatch: 'Packaging & Keepsake Boxes',
  shipped: 'Logistics & Courier Fulfillment',
  delivered: 'Logistics & Courier Fulfillment',
};

/** Stationery commissions are worked at the letterpress bench, not the vase. */
const STATIONERY_HINTS = /card|stationery|letterpress|invit|note|deckle|envelope/i;
const DYEING_HINTS = /dye|dyeing|wire|binding|ribbon|petal|mesh|frame/i;
const SCULPT_HINTS = /resin|sculpt|pipe|clay|figure|keepsake|terrarium/i;

function laneForOrder(order) {
  const stage = order.orderStatus;
  const written = (order.items || [])
    .map((it) => `${it.name || ''} ${it.description || ''} ${it.palette || ''} ${it.ribbon || ''}`)
    .join(' ');
  // A stationery/dyeing/sculpting commission keeps its own bench through
  // production; only fulfilment stages override it (there the work IS packing).
  if (stage === 'new' || stage === 'confirmed' || stage === 'in_production') {
    if (STATIONERY_HINTS.test(written)) return 'Letterpress & Deckled Stationery';
    if (DYEING_HINTS.test(written)) return 'Petal Dyeing & Wire Binding';
    if (SCULPT_HINTS.test(written)) return 'Floral Sculpting & Pipe Craft';
  }
  return ORDER_STAGE_AREAS[stage] || 'Floral Sculpting & Pipe Craft';
}

/** Stock work is materials work — the dyeing/binding lane keeps it topped up. */
const INVENTORY_AREA = 'Petal Dyeing & Wire Binding';

const CUSTOM_REQUEST_AREAS = {
  pending: 'Floral Sculpting & Pipe Craft',
  reviewing: 'Floral Sculpting & Pipe Craft',
  quoted: 'Floral Sculpting & Pipe Craft',
  accepted: 'Floral Sculpting & Pipe Craft',
  payment_pending: 'Floral Sculpting & Pipe Craft',
  paid: 'Floral Sculpting & Pipe Craft',
  in_progress: 'Floral Sculpting & Pipe Craft',
  completed: 'Floral Sculpting & Pipe Craft',
  declined: 'Floral Sculpting & Pipe Craft',
  customer_declined: 'Floral Sculpting & Pipe Craft',
};

/** Human labels for the order pipeline's next step (the handler's action). */
const ORDER_ACTION_LABELS = {
  new: { label: 'Acknowledge order', note: 'Order acknowledged' },
  confirmed: { label: 'Start production', note: 'Production started' },
  in_production: { label: 'Send to quality check', note: 'Sent to quality check' },
  quality_check: { label: 'Mark packed & ready', note: 'Packed and ready to dispatch' },
  ready_to_dispatch: { label: 'Dispatch order', note: 'Dispatched' },
  shipped: { label: 'Mark delivered', note: 'Delivered' },
};

/**
 * The handler's permitted action set — mirrors
 * backend/utils/operationalActions.js. `isAdmin` widens it exactly where the
 * server does (declining a custom request, jumping order stages). A handler
 * advances ONE stage at a time, which is why every work item below offers the
 * single next step rather than a status picker.
 */
export function permittedActionsFor({ isAdmin = false } = {}) {
  return {
    order: ORDER_PIPELINE.filter((s) => ORDER_ACTION_LABELS[s]),
    customRequest: isAdmin
      ? ['pending', 'reviewing', 'quoted', 'accepted', 'paid', 'in_progress', 'completed', 'declined']
      : ['pending', 'reviewing', 'quoted', 'accepted', 'paid', 'in_progress', 'completed'],
    inventory: ['adjustment', 'restock', 'remove'],
    conversation: ['markRead'],
    adminOnly: isAdmin ? [] : ['custom_request:decline'],
  };
}

export const REQUEST_STATUS_LABELS = {
  pending: 'Pending review',
  reviewing: 'In review',
  accepted: 'Accepted',
  quoted: 'Proposal sent',
  payment_pending: 'Awaiting payment',
  paid: 'Paid',
  in_progress: 'In progress',
  completed: 'Completed',
  declined: 'Declined',
  customer_declined: 'Customer declined',
};

export const INVENTORY_STATUS_LABELS = {
  'Out of Stock': 'Out of stock',
  Critical: 'Critical stock',
  'Low Stock': 'Low stock',
  'In Stock': 'In stock',
};

function orderItemSummary(order) {
  const items = order.items || [];
  if (!items.length) return 'No line items';
  const first = items[0].name || 'Item';
  return items.length > 1 ? `${first} +${items.length - 1} more` : first;
}

/** A work item built from an order — the next pipeline step is its action. */
function workItemFromOrder(order, me) {
  const stage = order.orderStatus;
  const next = ORDER_ACTION_LABELS[stage];
  return {
    key: `order:${order.orderId}`,
    kind: 'order',
    source: 'Orders',
    reference: order.orderId,
    title: `Order ${order.orderId}`,
    subtitle: orderItemSummary(order),
    customer: order.customerName || order.customerEmail || 'Customer',
    status: stage,
    statusLabel: getStatusLabel(stage),
    workArea: laneForOrder(order),
    dueAt: null,
    href: `/staff/orders/${encodeURIComponent(order.orderId)}`,
    // One permitted mutation: advance the canonical lifecycle by one step. The
    // server validates the transition, so a stale card cannot skip a stage.
    action: next
      ? {
          key: 'order-advance',
          label: next.label,
          note: next.note,
          owner: 'order',
          mutation: { kind: 'order_status', orderId: order.orderId, nextStatus: nextOrderStage(stage) },
        }
      : null,
    secondary: [{ key: 'view', label: 'View', href: `/staff/orders/${encodeURIComponent(order.orderId)}` }],
    // "My work" without inventing an assignment model: the canonical order
    // lifecycle records changedBy on every step, so an order this account has
    // already acted on is provably theirs to pick back up.
    touchedByMe: !!me && (order.statusHistory || []).some((h) => h && h.changedBy === me),
    changedBy: (order.statusHistory || []).length
      ? order.statusHistory[order.statusHistory.length - 1].changedBy || ''
      : '',
  };
}

function workItemFromCustomRequest(request, { isAdmin }) {
  const status = request.status || 'pending';
  const nextStatus = {
    pending: 'reviewing',
    reviewing: 'quoted',
    accepted: 'quoted',
    paid: 'in_progress',
    in_progress: 'completed',
  }[status];
  const labels = {
    reviewing: { label: 'Start review', note: 'Moved to review' },
    quoted: { label: 'Send quote', note: 'Quote recorded' },
    accepted: { label: 'Send quote', note: 'Quote recorded' },
    in_progress: { label: 'Start fulfillment', note: 'Fulfillment started' },
    completed: { label: 'Mark completed', note: 'Request completed' },
  };
  const desired = request.desiredDate ? new Date(request.desiredDate) : null;
  return {
    key: `custom_request:${request._id || request.id}`,
    kind: 'custom_request',
    source: 'Custom requests',
    reference: String(request._id || request.id || '').slice(-6).toUpperCase(),
    title: `Custom request #${String(request._id || request.id || '').slice(-6).toUpperCase()}`,
    subtitle: (request.description || '').slice(0, 120),
    customer: request.customerName || request.occasion || 'Customer',
    status,
    statusLabel: REQUEST_STATUS_LABELS[status] || status,
    workArea: CUSTOM_REQUEST_AREAS[status] || 'Floral Sculpting & Pipe Craft',
    dueAt: desired ? desired.toISOString() : null,
    href: '/staff/custom-requests',
    action: nextStatus
      ? {
          key: 'custom-request-status',
          label: labels[nextStatus].label,
          note: labels[nextStatus].note,
          owner: 'custom_request',
          mutation: { kind: 'request_status', id: request._id || request.id, nextStatus },
        }
      : null,
    // Declining is a business decision: offered only where the server allows it.
    secondary: [
      { key: 'view', label: 'View', href: '/staff/custom-requests' },
      ...(isAdmin && status !== 'declined'
        ? [
            {
              key: 'decline',
              label: 'Decline',
              tone: 'danger',
              owner: 'custom_request',
              // The server REQUIRES a persisted, customer-safe reason when a
              // request is declined, so the action center collects it first.
              mutation: {
                kind: 'request_status',
                id: request._id || request.id,
                nextStatus: 'declined',
                requiresReason: true,
              },
            },
          ]
        : []),
    ],
    touchedByMe: !!request.adminNotes,
    changedBy: '',
  };
}

function workItemFromInventory(item) {
  return {
    key: `inventory:${item.productSlug}`,
    kind: 'inventory',
    source: 'Inventory',
    reference: item.sku || item.productSlug,
    title: item.productName || item.productSlug,
    subtitle: `${item.currentStock} ${item.unit} in stock · reorder at ${item.reorderLevel}`,
    customer: '',
    status: item.status,
    statusLabel: INVENTORY_STATUS_LABELS[item.status] || item.status,
    workArea: INVENTORY_AREA,
    dueAt: null,
    href: '/staff/inventory',
    action: {
      key: 'inventory-adjust',
      label: 'Record movement',
      note: 'Stock movement recorded',
      owner: 'inventory',
      mutation: { kind: 'inventory_adjust', productId: item.productSlug, suggested: item.reorderLevel || 10 },
    },
    secondary: [{ key: 'view', label: 'View', href: '/staff/inventory' }],
    touchedByMe: false,
    changedBy: '',
  };
}

function workItemFromConversation(conversation) {
  const unread = Number(conversation.unreadCount || 0);
  return {
    key: `conversation:${conversation.id || conversation._id}`,
    kind: 'conversation',
    source: 'Conversations',
    reference: conversation.orderId || '',
    title: `Order ${conversation.orderId || ''}`.trim(),
    subtitle: unread ? `${unread} unread message${unread === 1 ? '' : 's'}` : 'No unread messages',
    customer: '',
    status: conversation.status || 'open',
    statusLabel: conversation.status === 'closed' ? 'Closed' : 'Open',
    workArea: 'Logistics & Courier Fulfillment',
    dueAt: conversation.lastMessageAt || null,
    href: conversation.orderId
      ? `/staff/orders/${encodeURIComponent(conversation.orderId)}/conversation`
      : '/staff/conversations',
    action: unread
      ? {
          key: 'conversation-read',
          label: 'Mark read',
          note: 'Conversation marked read',
          owner: 'conversation',
          mutation: { kind: 'conversation_read', id: conversation.id || conversation._id },
        }
      : null,
    secondary: [
      {
        key: 'view',
        label: 'Open',
        href: conversation.orderId
          ? `/staff/orders/${encodeURIComponent(conversation.orderId)}/conversation`
          : '/staff/conversations',
      },
    ],
    touchedByMe: false,
    changedBy: '',
  };
}

/**
 * Assemble the work queue from the operational records already loaded for this
 * workspace. Orders and stock come from the hydrated store; request and
 * conversation slices are passed in by the page (they are networked reads).
 */
export function buildWorkItems({
  orders = [],
  customRequests = [],
  inventory = [],
  conversations = [],
  isAdmin = false,
  me = '',
}) {
  return [
    ...orders.map((o) => workItemFromOrder(o, me)),
    ...customRequests.map((r) => workItemFromCustomRequest(r, { isAdmin })),
    ...inventory.map(workItemFromInventory),
    ...conversations.map(workItemFromConversation),
  ];
}

/** Store-backed slices (same source the handler dashboard reads). */
export function storeOrders() {
  return getOrders();
}

/** Stock work = the items that actually need a movement, not the whole ledger. */
export function storeStockWork() {
  const low = getLowStockItems();
  return low.length ? low : getInventory().slice(0, 0);
}

/** ISO helpers for the date buckets (Due today / Overdue). */
export function isOverdue(iso, now = Date.now()) {
  if (!iso) return false;
  return new Date(iso).getTime() < now;
}

export function isDueToday(iso, now = new Date()) {
  if (!iso) return false;
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  );
}

/**
 * Queue buckets. "Touched by me" is derived — the platform has no work
 * ASSIGNMENT model (no claim/assignee field on orders or requests), so the one
 * honest definition of "my work" is the work this account has already acted
 * on, recorded by the canonical lifecycle's changedBy.
 */
export const WORK_BUCKETS = [
  { key: 'all', label: 'All work' },
  { key: 'due_today', label: 'Due today' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'touched', label: 'Touched by me' },
];

/**
 * Apply the three filters (bucket · source · work area) plus the status filter.
 * Filtering is presentation over server-authorized data — it can only ever hide
 * items the handler already legitimately holds.
 */
export function filterWorkItems(
  items,
  { bucket = 'all', source = 'all', area = 'all', status = 'all', now = new Date() } = {}
) {
  return items.filter((item) => {
    if (source !== 'all' && item.kind !== source) return false;
    if (area !== 'all' && item.workArea !== area) return false;
    if (status !== 'all' && item.status !== status) return false;
    if (bucket === 'due_today' && !isDueToday(item.dueAt, now)) return false;
    if (bucket === 'overdue' && !isOverdue(item.dueAt, now.getTime())) return false;
    if (bucket === 'touched' && !item.touchedByMe) return false;
    return true;
  });
}
