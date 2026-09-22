import api from './apiClient.js';

/**
 * GET /api/notifications
 * Returns { notifications: [...], unreadCount: number }
 *
 * Phase 20.1 — `scope` selects which stored session token is attached.
 * The backend route is `protect` (staff and customers both read their own
 * feed via ownerFilter), so the admin bell must send the admin token;
 * hard-coding 'customer' made every admin poll fail with 401.
 */
export async function fetchNotifications(unreadOnly = false, scope = 'customer') {
  const params = unreadOnly ? '?unread=true' : '';
  const res = await api.get(`/notifications${params}`, { scope });
  if (!res.ok) throw new Error(res.message || 'Failed to load notifications.');
  return res.data;
}

/**
 * GET /api/notifications/unread-count
 * Lightweight polling endpoint.
 */
export async function fetchUnreadCount(scope = 'customer') {
  const res = await api.get('/notifications/unread-count', { scope });
  if (!res.ok) throw new Error(res.message || 'Failed to count notifications.');
  return res.data.unreadCount ?? 0;
}

/**
 * PATCH /api/notifications/:id/read
 */
export async function markNotificationRead(id, scope = 'customer') {
  const res = await api.patch(`/notifications/${id}/read`, {}, { scope });
  if (!res.ok) throw new Error(res.message || 'Failed to update notification.');
  return res.data;
}

/**
 * PATCH /api/notifications/read-all
 */
export async function markAllNotificationsRead(scope = 'customer') {
  const res = await api.patch('/notifications/read-all', {}, { scope });
  if (!res.ok) throw new Error(res.message || 'Failed to update notifications.');
  return res.data;
}
