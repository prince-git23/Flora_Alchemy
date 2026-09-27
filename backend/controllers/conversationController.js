import {
  getOrCreateConversation,
  getConversationForOrder,
  getMessages,
  sendMessage,
  markAsRead,
  updateConversationStatus,
  getUnreadCount,
  listConversations,
  listMyConversations,
} from '../services/conversationService.js';

/**
 * GET /api/conversations/order/:orderId
 * Get or create conversation for an order.
 */
export async function getOrCreateByOrder(req, res, next) {
  try {
    const { conversation, order } = await getOrCreateConversation({
      orderId: req.params.orderId,
      user: req.user,
      req,
    });
    res.json({ success: true, conversation, order: { orderId: order.orderId, status: order.orderStatus } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/conversations/:conversationId/messages
 * List messages with pagination.
 */
export async function listMessages(req, res, next) {
  try {
    const { before, limit } = req.query;
    const messages = await getMessages({
      conversationId: req.params.conversationId,
      user: req.user,
      req,
      before,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    res.json({ success: true, messages });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/conversations/:conversationId/messages
 * Send a message.
 */
export async function createMessage(req, res, next) {
  try {
    const message = await sendMessage({
      conversationId: req.params.conversationId,
      body: req.body.body,
      user: req.user,
      req,
    });
    res.status(201).json({ success: true, message });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/conversations/:conversationId/read
 * Mark messages as read.
 */
export async function markConversationRead(req, res, next) {
  try {
    await markAsRead({
      conversationId: req.params.conversationId,
      user: req.user,
      req,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/conversations/:conversationId/status
 * Update conversation status (open/close).
 */
export async function updateStatus(req, res, next) {
  try {
    const result = await updateConversationStatus({
      conversationId: req.params.conversationId,
      status: req.body.status,
      user: req.user,
      req,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/conversations/unread
 * Get unread conversation count.
 */
export async function unreadCount(req, res, next) {
  try {
    const result = await getUnreadCount({ user: req.user, req });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/conversations/mine
 * List customer's own conversations.
 */
export async function listMine(req, res, next) {
  try {
    const conversations = await listMyConversations({ user: req.user });
    res.json({ success: true, conversations });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/conversations
 * List all conversations (admin/handler only).
 */
export async function listAll(req, res, next) {
  try {
    const { status, limit } = req.query;
    const conversations = await listConversations({
      user: req.user,
      req,
      status,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    res.json({ success: true, conversations });
  } catch (err) {
    next(err);
  }
}
