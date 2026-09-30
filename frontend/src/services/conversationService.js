import api from './apiClient.js';

/**
 * conversationService — order-linked customer ↔ handler text chat.
 *
 * All requests go through the existing apiClient with proper
 * customer or admin token scope.
 *
 * IMPORTANT: scope must be passed explicitly so the apiClient knows
 * which localStorage token key to use (customer vs admin).
 */

/**
 * Get or create a conversation for an order.
 */
export async function getOrCreateConversation(orderId, { scope = 'customer' } = {}) {
  const res = await api.get(`/conversations/order/${orderId}`, { scope });
  if (!res.ok) throw new Error(res.message);
  return res.data.conversation;
}

/**
 * List messages for a conversation.
 */
export async function getMessages(conversationId, { before, limit = 50, scope = 'customer' } = {}) {
  const params = new URLSearchParams();
  if (before) params.set('before', before);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  const res = await api.get(`/conversations/${conversationId}/messages${qs ? `?${qs}` : ''}`, { scope });
  if (!res.ok) throw new Error(res.message);
  return res.data.messages;
}

/**
 * Send a message in a conversation.
 */
export async function sendMessage(conversationId, body, { scope = 'customer' } = {}) {
  const res = await api.post(`/conversations/${conversationId}/messages`, { body }, { scope });
  if (!res.ok) throw operationError(res);
  return res.data.message;
}

/**
 * Mark a conversation as read.
 */
export async function markAsRead(conversationId, { scope = 'customer' } = {}) {
  // Errors carry the server code (see operationError) so staff surfaces can
  // distinguish a permission refusal from a disappearing conversation.
  const res = await api.patch(`/conversations/${conversationId}/read`, {}, { scope });
  if (!res.ok) throw operationError(res);
  return true;
}

/**
 * Get unread conversation count.
 */
export async function getUnreadCount({ scope = 'customer' } = {}) {
  const res = await api.get('/conversations/unread', { scope });
  if (!res.ok) return { count: 0 };
  return res.data;
}

/**
 * List the current customer's own conversations.
 */
export async function getConversations({ scope = 'customer' } = {}) {
  const res = await api.get('/conversations/mine', { scope });
  if (!res.ok) throw new Error(res.message);
  return res.data.conversations;
}

/**
 * List all conversations (admin/handler only).
 */
export async function listConversations({ status, limit = 50, scope = 'admin' } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  const res = await api.get(`/conversations${qs ? `?${qs}` : ''}`, { scope });
  if (!res.ok) throw operationError(res);
  return res.data.conversations;
}

/**
 * Update conversation status (admin/handler only).
 */
export async function updateConversationStatus(conversationId, status, { scope = 'admin' } = {}) {
  const res = await api.patch(`/conversations/${conversationId}/status`, { status }, { scope });
  if (!res.ok) throw operationError(res);
  return res.data;
}

/**
 * apiClient never throws — it answers { ok, status, message, code }. Staff
 * mutation callers (the Phase 23 Action Center) need the SERVER's own code to
 * tell "you may not do this" from "that resource is gone", so carry it.
 */
function operationError(res) {
  const err = new Error(res.message || 'The conversation could not be updated.');
  err.status = res.status;
  err.code = res.code;
  return err;
}
