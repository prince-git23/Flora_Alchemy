/**
 * GRANULAR STAFF PERMISSIONS (single source of truth).
 *
 * Roles stay exactly what they were: `customer | handler | admin`, with the
 * Owner being an admin carrying `isOwner`. Nothing here changes the role model,
 * the tenancy gates or the workspace/owner architecture — this module only
 * decides the SECOND question a staff request asks:
 *
 *   1. MAY this identity touch THIS workspace at all?
 *      → middleware/workspaceMiddleware.js + the tenancy scope in controllers.
 *   2. MAY this identity perform THIS OPERATION inside that workspace?
 *      → this module + middleware/permissionMiddleware.js.
 *
 * ROLE = PERMISSION BUNDLE   ·   PERMISSIONS = ACTUAL AUTHORITY
 *
 * A handler's authority is the permission list stored on the account
 * (`User.permissions`, with `User.staffRole` naming the template it came from).
 * Administrators are not listed here at all: they keep every workspace
 * capability through the admin gate, and the catalogue deliberately contains NO
 * permission for owner/platform authority — so no bundle an admin can assign
 * can ever mint an owner, an administrator, a second workspace or platform
 * governance.
 *
 * LEGACY COMPATIBILITY (migration rule, see docs/report): a handler account
 * with NO stored permission list predates this model and resolves to
 * FULL_WORKSPACE_ACCESS. The moment an administrator saves an explicit set, the
 * stored set is the authority — which is what makes permission REMOVAL
 * enforceable.
 *
 * Every permission id below maps to a real backend operation. Ids with no
 * endpoint behind them are deliberately NOT defined (see ABSENT_PERMISSIONS for
 * the audit note) so the UI can never offer authority the server cannot honour.
 */

import { ORDER_STATUSES } from '../models/Order.js';
import { CUSTOM_REQUEST_STATUSES } from './operationalActions.js';
import { ApiError } from '../middleware/errorMiddleware.js';

/**
 * Permission groups — the shape the Admin permissions editor renders.
 * `id` is the stable contract; `label` is presentation only.
 */
export const PERMISSION_GROUPS = [
  {
    key: 'orders',
    label: 'Orders',
    icon: 'shopping_bag',
    permissions: [
      { id: 'orders.view', label: 'View orders', description: 'Read the order pipeline and order detail.' },
      { id: 'orders.create', label: 'Create orders', description: 'Book an order on a customer’s behalf.' },
      { id: 'orders.accept', label: 'Accept orders', description: 'Move a new order to confirmed.' },
      { id: 'orders.update_status', label: 'Update status', description: 'Advance production, quality and packing stages.' },
      { id: 'orders.fulfillment', label: 'Fulfillment', description: 'Mark an order shipped / dispatched.' },
      { id: 'orders.complete', label: 'Complete', description: 'Mark an order delivered (closes it).' },
    ],
  },
  {
    key: 'products',
    label: 'Products',
    icon: 'inventory_2',
    permissions: [
      { id: 'products.view', label: 'View products', description: 'See the workspace catalogue, including hidden drafts.' },
      { id: 'products.create', label: 'Create', description: 'Add a product to the workspace catalogue.' },
      { id: 'products.update', label: 'Update', description: 'Edit price, stock tracking, visibility and copy.' },
      { id: 'products.delete', label: 'Delete', description: 'Remove a product from the catalogue.' },
    ],
  },
  {
    key: 'collections',
    label: 'Collections',
    icon: 'auto_stories',
    permissions: [
      { id: 'collections.view', label: 'View collections', description: 'See the workspace collections.' },
      { id: 'collections.create', label: 'Create', description: 'Add a collection.' },
      { id: 'collections.update', label: 'Update', description: 'Edit a collection and its members.' },
      { id: 'collections.delete', label: 'Delete', description: 'Remove a collection.' },
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    icon: 'warehouse',
    permissions: [
      { id: 'inventory.view', label: 'View stock', description: 'Read stock levels and low-stock alerts.' },
      { id: 'inventory.movement.view', label: 'View movements', description: 'Read the stock movement ledger.' },
      { id: 'inventory.adjust', label: 'Adjust stock', description: 'Record a stock adjustment / movement.' },
    ],
  },
  {
    key: 'customers',
    label: 'Customers',
    icon: 'group',
    permissions: [
      { id: 'customers.view', label: 'View customers', description: 'Read customer profiles and order history.' },
      { id: 'customers.update', label: 'Update customers', description: 'Edit customer contact and delivery details.' },
    ],
  },
  {
    key: 'conversations',
    label: 'Conversations',
    icon: 'chat',
    permissions: [
      { id: 'conversations.view', label: 'View conversations', description: 'Read customer conversations and messages.' },
      { id: 'conversations.reply', label: 'Reply', description: 'Send a message to a customer.' },
      { id: 'conversations.resolve', label: 'Resolve', description: 'Change a conversation status (resolve / reopen).' },
    ],
  },
  {
    key: 'requests',
    label: 'Custom Requests',
    icon: 'draw',
    permissions: [
      { id: 'requests.view', label: 'View requests', description: 'Read bespoke commission requests.' },
      { id: 'requests.claim', label: 'Claim', description: 'Take a request into review.' },
      { id: 'requests.update', label: 'Update', description: 'Quote or accept a request.' },
    ],
  },
  {
    key: 'notifications',
    label: 'Notifications',
    icon: 'notifications',
    permissions: [
      { id: 'notifications.view', label: 'View notifications', description: 'Read the notification inbox and unread count.' },
      { id: 'notifications.manage', label: 'Manage notifications', description: 'Mark notifications read and request elevated clearance.' },
    ],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    icon: 'analytics',
    permissions: [
      { id: 'analytics.view', label: 'View analytics', description: 'Read workspace KPIs, sales and performance.' },
    ],
  },
];

/** Flat list of every assignable permission id. */
export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.id));

const PERMISSION_SET = new Set(ALL_PERMISSIONS);

/** True for an id the server can actually enforce. */
export function isValidPermission(id) {
  return PERMISSION_SET.has(String(id));
}

/**
 * FULL WORKSPACE ACCESS — every ALLOWED workspace operation.
 *
 * It is deliberately "all of PERMISSION_GROUPS" and nothing else: there is no
 * owner, administrator-lifecycle, workspace-ownership, tenant-provisioning,
 * platform-settings or billing permission in this catalogue, so assigning this
 * bundle cannot widen authority beyond the workspace's operational work.
 */
export const FULL_WORKSPACE_ACCESS = [...ALL_PERMISSIONS];

/**
 * Permission ids the product brief suggested but which have NO backend
 * operation today. They are intentionally absent from the catalogue rather
 * than defined as decorative authority.
 *
 *   inventory.movement.create → the adjust endpoint IS the movement writer
 *   requests.complete         → the request lifecycle has no terminal
 *                               "completed" state (accepted is terminal)
 *   fulfillment.view/update   → fulfilment is an order STAGE
 *                               (orders.fulfillment), there is no /fulfillment API
 *   work.view/claim/update/complete
 *                             → Action-Center work items ARE orders, custom
 *                               requests, stock alerts and conversations; the
 *                               work categories stay FILTERS and the actions
 *                               are gated by the underlying resource
 *                               permissions above.
 */
export const ABSENT_PERMISSIONS = [
  'inventory.movement.create',
  'requests.complete',
  'fulfillment.view',
  'fulfillment.update',
  'work.view',
  'work.claim',
  'work.update',
  'work.complete',
];

/**
 * ROLE TEMPLATES — named bundles over the catalogue above. `custom` starts
 * empty: the administrator builds the set. `full_workspace` is the bundle
 * described in FULL_WORKSPACE_ACCESS.
 */
export const ROLE_TEMPLATES = [
  {
    key: 'fulfillment',
    label: 'Fulfillment',
    description: 'Works the order pipeline end to end and answers customers on dispatch questions.',
    permissions: [
      'orders.view',
      'orders.create',
      'orders.accept',
      'orders.update_status',
      'orders.fulfillment',
      'orders.complete',
      'products.view',
      'inventory.view',
      'inventory.movement.view',
      'conversations.view',
      'conversations.reply',
      'requests.view',
      'requests.update',
      'notifications.view',
      'notifications.manage',
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    description: 'Owns stock accuracy: reads the catalogue, adjusts stock and keeps the ledger clean.',
    permissions: [
      'inventory.view',
      'inventory.movement.view',
      'inventory.adjust',
      'products.view',
      'products.update',
      'collections.view',
      'orders.view',
      'notifications.view',
      'notifications.manage',
    ],
  },
  {
    key: 'customer_support',
    label: 'Customer Support',
    description: 'Answers customers, keeps profiles current and takes bespoke requests into review.',
    permissions: [
      'customers.view',
      'customers.update',
      'conversations.view',
      'conversations.reply',
      'conversations.resolve',
      'requests.view',
      'requests.claim',
      'requests.update',
      'orders.view',
      'products.view',
      'inventory.view',
      'notifications.view',
      'notifications.manage',
    ],
  },
  {
    key: 'catalog_operations',
    label: 'Catalog Operations',
    description: 'Maintains products, collections and stock with full catalogue write access.',
    permissions: [
      'products.view',
      'products.create',
      'products.update',
      'products.delete',
      'collections.view',
      'collections.create',
      'collections.update',
      'collections.delete',
      'inventory.view',
      'inventory.movement.view',
      'inventory.adjust',
      'orders.view',
      'analytics.view',
      'notifications.view',
      'notifications.manage',
    ],
  },
  {
    key: 'custom',
    label: 'Custom Role',
    description: 'Start from an empty set and choose the exact permissions to grant.',
    permissions: [],
  },
  {
    key: 'full_workspace',
    label: 'Full Workspace Access',
    description: 'Every allowed workspace operation — no owner, administrator or platform authority.',
    permissions: [...FULL_WORKSPACE_ACCESS],
  },
];

const TEMPLATE_BY_KEY = new Map(ROLE_TEMPLATES.map((t) => [t.key, t]));

/** Template lookup by key (null when unknown). */
export function roleTemplate(key) {
  return TEMPLATE_BY_KEY.get(String(key || '')) || null;
}

/** Presentation label for a stored template key. */
export function roleLabel(key) {
  return TEMPLATE_BY_KEY.get(String(key || ''))?.label || 'Custom Role';
}

/** True when every id is a real, assignable permission. */
export function areValidPermissions(ids) {
  return Array.isArray(ids) && ids.every(isValidPermission);
}

/**
 * Validate + normalise a submitted permission list.
 * Unknown ids are NOT silently dropped — they raise, so a client that sends a
 * permission the server cannot enforce gets a 422 instead of a false "saved".
 */
export function normalizePermissions(ids) {
  if (!Array.isArray(ids)) {
    throw new ApiError(422, 'Permissions must be an array of permission ids.', 'VALIDATION_ERROR');
  }
  const unknown = ids.filter((id) => !isValidPermission(id));
  if (unknown.length) {
    throw new ApiError(
      422,
      `Unknown permission(s): ${[...new Set(unknown)].join(', ')}.`,
      'VALIDATION_ERROR'
    );
  }
  return [...new Set(ids.map(String))];
}

/**
 * The permission list a stored handler account actually holds.
 *
 * `null`/absent means "predates granular permissions" → full workspace access
 * (the migration rule). An explicit list — including an empty one — is the
 * authority, which is what makes a removal take effect on the next request.
 */
export function effectivePermissions(user) {
  const stored = user?.permissions;
  if (!Array.isArray(stored)) return [...FULL_WORKSPACE_ACCESS];
  return stored.filter(isValidPermission);
}

/** True when the account still runs on the legacy implicit bundle. */
export function isLegacyAccess(user) {
  return !Array.isArray(user?.permissions);
}

/** Convenience predicate used by middleware and the portal. */
export function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true; // admins keep the admin gate
  if (user.role !== 'handler') return false;
  return effectivePermissions(user).includes(String(permission));
}

/**
 * Which permission a given ORDER STATUS transition needs.
 *
 * The order lifecycle is the real fulfilment surface, so the suggested
 * accept/update/fulfilment/complete split is expressed as the stage being
 * written rather than as four endpoints that do not exist.
 */
export function permissionForOrderStatus(status) {
  const target = String(status || '');
  if (!ORDER_STATUSES.includes(target)) return null;
  if (target === 'confirmed') return 'orders.accept';
  if (target === 'shipped') return 'orders.fulfillment';
  if (target === 'delivered') return 'orders.complete';
  return 'orders.update_status'; // in_production · quality_check · ready_to_dispatch
}

/** Which permission a given CUSTOM REQUEST status transition needs. */
export function permissionForRequestStatus(status) {
  const target = String(status || '');
  if (!CUSTOM_REQUEST_STATUSES.includes(target)) return null;
  if (target === 'reviewing') return 'requests.claim';
  return 'requests.update'; // pending · quoted · accepted
}

/**
 * The permissions an identity holds, in UI shape: role key + label, the
 * explicit list, the effective list and whether it is the legacy implicit set.
 * Administrators are reported as holding the full workspace bundle for display
 * only — their real authority is the admin gate.
 */
export function accessView(user) {
  const legacy = user.role === 'handler' && isLegacyAccess(user);
  const explicit = Array.isArray(user.permissions) ? user.permissions.filter(isValidPermission) : null;
  const role = user.role === 'admin' ? 'administrator' : user.staffRole || (legacy ? 'full_workspace' : 'custom');
  return {
    role,
    roleLabel: user.role === 'admin' ? 'Administrator (workspace)' : legacy ? 'Full Workspace Access' : roleLabel(role),
    permissions: explicit,
    effective: user.role === 'admin' ? [...FULL_WORKSPACE_ACCESS] : effectivePermissions(user),
    isFullAccess:
      user.role === 'admin' ||
      (Array.isArray(explicit) && FULL_WORKSPACE_ACCESS.every((p) => explicit.includes(p))),
    legacyDefault: legacy,
    updatedAt: user.accessUpdatedAt || null,
  };
}

/** The catalogue payload the Admin permissions editor renders. */
export function permissionCatalogue() {
  return {
    groups: PERMISSION_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      icon: g.icon,
      permissions: g.permissions.map((p) => ({ id: p.id, label: p.label, description: p.description })),
    })),
    templates: ROLE_TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label,
      description: t.description,
      permissions: [...t.permissions],
    })),
    fullAccess: [...FULL_WORKSPACE_ACCESS],
    total: ALL_PERMISSIONS.length,
  };
}
