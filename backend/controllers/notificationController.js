import Notification from '../models/Notification.js';
import User from '../models/User.js';

/**
 * Ownership filter for the authenticated user.
 *
 * Customer-facing notifications are created against the linked Customer
 * record (order.customerId / request.customerId / conversation.customerId),
 * while staff notifications use the User _id. Both ids belong to the same
 * authenticated account, so accepting the pair here fixes the historical
 * field mismatch without ever trusting a client-supplied identifier.
 */
function ownerFilter(user) {
  const ids = [user._id];
  if (user.customerId) ids.push(user.customerId);
  return { userId: { $in: ids } };
}

/**
 * GET /api/notifications
 * List notifications for the current user. Supports ?unread=true filter.
 * Projection: only fields the UI renders — skips entityType/entityId/link
 * internals not displayed and keeps payloads small (Phase 17).
 */
const LIST_PROJECTION = 'type title message read readAt createdAt link';

export async function listNotifications(req, res) {
  try {
    const { unread } = req.query;
    const filter = ownerFilter(req.user);
    if (unread === 'true') filter.read = false;
    const notifications = await Notification.find(filter)
      .select(LIST_PROJECTION)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const unreadCount = await Notification.countDocuments({ ...filter, read: false });
    res.json({ notifications, unreadCount });
  } catch (err) {
    console.error('listNotifications error:', err);
    res.status(500).json({ message: 'Failed to load notifications.' });
  }
}

/**
 * GET /api/notifications/unread-count
 * Lightweight endpoint for badge polling (covered by { userId, read } index).
 */
export async function unreadCount(req, res) {
  try {
    const count = await Notification.countDocuments({ ...ownerFilter(req.user), read: false });
    res.json({ unreadCount: count });
  } catch (err) {
    console.error('unreadCount error:', err);
    res.status(500).json({ message: 'Failed to count notifications.' });
  }
}

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read (ownership enforced in the filter).
 */
export async function markRead(req, res) {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, ...ownerFilter(req.user) },
      { read: true, readAt: new Date() },
      { new: true },
    );
    if (!notification) return res.status(404).json({ message: 'Notification not found.' });
    const unreadCount = await Notification.countDocuments({ ...ownerFilter(req.user), read: false });
    res.json({ notification, unreadCount });
  } catch (err) {
    console.error('markRead error:', err);
    res.status(500).json({ message: 'Failed to update notification.' });
  }
}

/**
 * PATCH /api/notifications/read-all
 * Mark all notifications as read for the current user only.
 */
export async function markAllRead(req, res) {
  try {
    await Notification.updateMany(
      { ...ownerFilter(req.user), read: false },
      { read: true, readAt: new Date() },
    );
    res.json({ unreadCount: 0 });
  } catch (err) {
    console.error('markAllRead error:', err);
    res.status(500).json({ message: 'Failed to update notifications.' });
  }
}

/**
 * Helper: create a notification. Called from other controllers/services.
 */
export async function createNotification({ userId, role, type, title, message, entityType, entityId, link }) {
  try {
    return await Notification.create({
      userId, role, type, title, message,
      entityType: entityType || null,
      entityId: entityId || null,
      link: link || null,
    });
  } catch (err) {
    console.error('createNotification error:', err);
    return null; // Non-critical — don't break business flow
  }
}

/**
 * POST /api/notifications/elevation-request — Phase 20.6.2.
 *
 * The "Request Elevated Clearance" action on the Owner Access Required
 * screen. This is a REAL business event: every active owner admin receives a
 * notification naming the requester and the route that was denied. Nothing is
 * queued client-side; `requested` reports how many owners were actually
 * notified (0 = no owner account exists yet).
 */
export async function requestElevation(req, res) {
  try {
    const attemptedRoute = String(req.body?.path || '').slice(0, 300);
    const owners = await User.find({ role: 'admin', isOwner: true, status: 'ACTIVE' })
      .select('_id role name email');
    const recipients = owners.filter((o) => String(o._id) !== String(req.user._id));

    await createNotificationsForUsers(recipients, {
      role: 'admin',
      type: 'system',
      title: 'Elevated clearance requested',
      message: `${req.user.name || req.user.email} requested elevated clearance while accessing ${attemptedRoute || 'an owner-only area'}.`,
      link: '/admin/owner',
    });

    res.json({ success: true, requested: recipients.length });
  } catch (err) {
    console.error('requestElevation error:', err);
    res.status(500).json({ success: false, message: 'Failed to record the elevation request.' });
  }
}

/**
 * Helper: batch-create notifications for many users (one insertMany round
 * trip instead of N awaited creates — Phase 17 N+1 fix for staff broadcasts).
 * Same non-critical contract: failures never break the business flow.
 */
export async function createNotificationsForUsers(users, payload) {
  try {
    if (!Array.isArray(users) || users.length === 0) return [];
    const docs = users.map((u) => ({
      userId: u._id,
      role: u.role,
      type: payload.type,
      title:
        typeof payload.title === 'function' ? payload.title(u) : payload.title,
      message:
        typeof payload.message === 'function' ? payload.message(u) : payload.message,
      entityType: payload.entityType || null,
      entityId: payload.entityId || null,
      link: payload.link || null,
    }));
    return await Notification.insertMany(docs, { ordered: false });
  } catch (err) {
    console.error('createNotificationsForUsers error:', err);
    return []; // Non-critical
  }
}
