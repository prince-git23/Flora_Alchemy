import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Order from '../models/Order.js';
import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { createNotification, createNotificationsForUsers } from '../controllers/notificationController.js';
import { getWorkspaceId, requestScope, workspaceIdScope } from '../utils/tenancy.js';

/**
 * conversationService — order-linked customer ↔ handler text chat.
 *
 * Ownership is always derived server-side from the authenticated user;
 * no client-supplied customerId or senderRole is ever trusted.
 *
 * Phase 22.3 — two layers of tenant control, deliberately in this order:
 *   1. the ORDER lookup is scoped (a staff member never reaches a
 *      conversation belonging to another workspace — 404 instead of 403, so
 *      existence is not disclosed);
 *   2. conversations and notifications are stamped with the workspace that
 *      created them, so later reads and staff broadcasts narrow by owner.
 * Messages themselves carry no workspaceId field; they are reached only
 * through an already workspace-checked conversation.
 */

// ─── Conversation ─────────────────────────────────────────────────────

/**
 * Get or create the conversation for a given order.
 * Enforces: one conversation per order/customer pair.
 */
export async function getOrCreateConversation({ orderId, user, req }) {
  const order = await Order.findOne({
    orderId,
    ...requestScope(req),
  });
  if (!order) {
    throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
  }

  // Customers can only access their own order conversations.
  if (user.role === 'customer') {
    if (String(order.customerId) !== String(user.customerId)) {
      throw new ApiError(403, 'You do not have access to this order conversation.', 'FORBIDDEN');
    }
  }
  // Admin/handler may access any conversation INSIDE its workspace — the
  // scoped order lookup above already refused other tenants' orders.

  const conversationWorkspaceId = getWorkspaceId(user);
  const conversation = await Conversation.findOneAndUpdate(
    {
      orderId,
      customerId: order.customerId,
      // Not scoped by workspaceId here on purpose: the ORDER read above
      // already enforced the tenant boundary, and the unique
      // { orderId, customerId } index must keep resolving to one document.
    },
    {
      $setOnInsert: {
        orderId,
        customerId: order.customerId,
        status: 'open',
        ...(conversationWorkspaceId ? { workspaceId: conversationWorkspaceId } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return { conversation, order };
}

/**
 * Get conversation for an order (returns null if none exists).
 */
export async function getConversationForOrder({ orderId, user, req }) {
  const order = await Order.findOne({
    orderId,
    ...requestScope(req),
  });
  if (!order) {
    throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
  }

  if (user.role === 'customer') {
    if (String(order.customerId) !== String(user.customerId)) {
      throw new ApiError(403, 'You do not have access to this order conversation.', 'FORBIDDEN');
    }
  }

  // Derived from the scoped order above — same single-document guarantee.
  const conversation = await Conversation.findOne({
    // workspaceId was enforced on the ORDER read above; the unique
    // { orderId, customerId } index guarantees this resolves to one document.
    orderId,
    customerId: order.customerId,
  });
  return { conversation, order };
}

// ─── Messages ─────────────────────────────────────────────────────────

/**
 * List messages for a conversation (newest-last, with pagination).
 */
export async function getMessages({ conversationId, user, before, limit = 50, req }) {
  const conversation = await Conversation.findOne({
    _id: conversationId,
    ...requestScope(req),
  });
  if (!conversation) {
    throw new ApiError(404, 'Conversation not found.', 'NOT_FOUND');
  }

  // Ownership check
  if (user.role === 'customer') {
    if (String(conversation.customerId) !== String(user._id) &&
        String(conversation.customerId) !== String(user.customerId)) {
      throw new ApiError(403, 'Access denied.', 'FORBIDDEN');
    }
  }

  const messages = await Message.find({
    // Messages hang off a conversationId that was already workspace-checked
    // above; the Message schema carries no workspaceId field in Phase 22.3.
    conversationId,
    ...(before ? { createdAt: { $lt: new Date(before) } } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 100))
    .lean();

  return messages.reverse(); // oldest-first for display
}

/**
 * Send a message in a conversation.
 * Server derives sender identity from the authenticated user.
 */
export async function sendMessage({ conversationId, body, user, req }) {
  if (!body || !body.trim()) {
    throw new ApiError(422, 'Message body is required.', 'VALIDATION_ERROR');
  }

  const conversation = await Conversation.findOne({
    _id: conversationId,
    ...requestScope(req),
  });
  if (!conversation) {
    throw new ApiError(404, 'Conversation not found.', 'NOT_FOUND');
  }

  if (conversation.status === 'closed') {
    throw new ApiError(409, 'This conversation is closed.', 'CONVERSATION_CLOSED');
  }

  // Ownership check
  if (user.role === 'customer') {
    if (String(conversation.customerId) !== String(user._id) &&
        String(conversation.customerId) !== String(user.customerId)) {
      throw new ApiError(403, 'Access denied.', 'FORBIDDEN');
    }
  }

  // Determine sender role from server-side user object
  const senderRole = ['admin', 'handler'].includes(user.role) ? user.role : 'customer';
  const senderName = user.name || user.email || (senderRole === 'customer' ? 'Customer' : 'Flora Alchemy');

  const message = await Message.create({
    conversationId,
    senderUserId: user._id,
    senderRole,
    senderName,
    body: body.trim(),
    readBy: [user._id],
  });

  // Update conversation metadata
  await Conversation.findByIdAndUpdate(conversationId, {
    $set: { lastMessageAt: message.createdAt },
    $inc: { unreadCount: 1 },
  });

  // Notify the other party
  const order = await Order.findOne({
    orderId: conversation.orderId,
    ...requestScope(req),
  }).select('orderId customerName').lean();
  if (senderRole === 'customer') {
    // Notify the staff of the workspace that OWNS this conversation — batched
    // insertMany (Phase 17 N+1 fix). An unowned (legacy) conversation still
    // reaches every active staff member, exactly as before Phase 22.3.
    const staffUsers = await User.find({
      role: { $in: ['admin', 'handler'] },
      ...workspaceIdScope(getWorkspaceId(conversation)),
    }).select('_id role');
    await createNotificationsForUsers(staffUsers, {
      type: 'new_message',
      title: `New message from ${order?.customerName || 'customer'}`,
      message: body.trim().substring(0, 120),
      entityType: 'conversation',
      entityId: conversation._id,
      link: `/admin/conversations`,
      workspaceId: getWorkspaceId(conversation),
    });
  } else {
    // Notify the customer
    await createNotification({
      userId: conversation.customerId,
      role: 'customer',
      type: 'new_message',
      title: `Flora Alchemy replied to order ${conversation.orderId}`,
      message: body.trim().substring(0, 120),
      entityType: 'conversation',
      entityId: conversation._id,
      link: `/order/${conversation.orderId}/conversation`,
      workspaceId: getWorkspaceId(conversation),
    });
  }

  return message;
}

/**
 * Mark messages as read by a user.
 */
export async function markAsRead({ conversationId, user, req }) {
  const conversation = await Conversation.findOne({
    _id: conversationId,
    ...requestScope(req),
  });
  if (!conversation) {
    throw new ApiError(404, 'Conversation not found.', 'NOT_FOUND');
  }

  // Ownership check
  if (user.role === 'customer') {
    if (String(conversation.customerId) !== String(user._id) &&
        String(conversation.customerId) !== String(user.customerId)) {
      throw new ApiError(403, 'Access denied.', 'FORBIDDEN');
    }
  }

  // Mark all messages not yet read by this user.
  await Message.updateMany(
    {
      // Scoped by the conversation id just checked above — Message carries no
      // workspaceId field of its own in Phase 22.3.
      conversationId,
      readBy: { $ne: user._id },
    },
    { $addToSet: { readBy: user._id } }
  );

  // Reset unread count for this conversation
  await Conversation.findByIdAndUpdate(conversationId, {
    // The conversationId was checked against the caller's workspaceId in the
    // scoped read at the top of this function.
    $set: { unreadCount: 0 },
  });

  return { success: true };
}

/**
 * Update conversation status (open/close).
 */
export async function updateConversationStatus({ conversationId, status, user, req }) {
  if (!['open', 'closed'].includes(status)) {
    throw new ApiError(422, 'Status must be "open" or "closed".', 'VALIDATION_ERROR');
  }

  const conversation = await Conversation.findOne({
    _id: conversationId,
    ...requestScope(req),
  });
  if (!conversation) {
    throw new ApiError(404, 'Conversation not found.', 'NOT_FOUND');
  }

  // Only staff may close/reopen conversations
  if (!['admin', 'handler'].includes(user.role)) {
    throw new ApiError(403, 'Only staff may update conversation status.', 'FORBIDDEN');
  }

  await Conversation.findByIdAndUpdate(conversationId, {
    // workspaceId already verified by the scoped conversation read above.
    $set: { status },
  });
  return { success: true, status };
}

/**
 * Get unread conversation count for the dashboard indicator.
 */
export async function getUnreadCount({ user, req }) {
  // Admin/handler: count conversations with unread messages IN THIS WORKSPACE
  if (['admin', 'handler'].includes(user.role)) {
    const count = await Conversation.countDocuments({
      unreadCount: { $gt: 0 },
      ...requestScope(req),
    });
    return { count };
  }
  // Customer: count their conversations with unread messages
  const customerId = user.customerId || user._id;
  const count = await Conversation.countDocuments({ customerId, unreadCount: { $gt: 0 } });
  return { count };
}

/**
 * List conversations for a customer (only their own).
 */
export async function listMyConversations({ user, limit = 50 }) {
  const customerId = user.customerId || user._id;
  const conversations = await Conversation.find({
    // Identity-scoped: customer conversations carry no workspaceId of their
    // own; the tenant boundary for staff is applied in listConversations.
    customerId,
  })
    .sort({ lastMessageAt: -1 })
    .limit(limit)
    .lean();
  return conversations;
}

/**
 * List conversations for admin/handler (this workspace's conversations).
 */
export async function listConversations({ user, status, limit = 50, req }) {
  const conversations = await Conversation.find({
    // Staff list is workspace-scoped straight from the router gate; the
    // optional status predicate composes with it as a second key.
    ...(status ? { status } : {}),
    ...requestScope(req),
  })
    .sort({ lastMessageAt: -1 })
    .limit(limit)
    .lean();

  return conversations;
}
