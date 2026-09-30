import { Router } from 'express';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspaceOrOwnerForStaff } from '../middleware/workspaceMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  requestElevation,
} from '../controllers/notificationController.js';

const router = Router();

// Notifications are per-authenticated-user; staff and customers both may read
// their own feed. Creation happens server-side from real business events.
//
// Phase 22.3 — the gate admits customers (they are not members, their feed is
// ownership-scoped) and the owner (platform badge, §19), while staff must be a
// workspace member. Reads then apply workspaceScope as a second belt on top of
// the recipient filter (notificationController).
// GRANULAR STAFF ACCESS — a customer keeps their own feed (the recipient
// filter is ownership-scoped in the controller), while a HANDLER needs the
// matching permission: reading the feed and changing its state are separate
// authorities.
const feedView = requirePermission('notifications.view', { skipNonStaff: true });
const feedManage = requirePermission('notifications.manage', { skipNonStaff: true });
router.get('/', protect, requireWorkspaceOrOwnerForStaff, feedView, listNotifications);
router.get('/unread-count', protect, requireWorkspaceOrOwnerForStaff, feedView, unreadCount);
router.patch('/:id/read', protect, requireWorkspaceOrOwnerForStaff, feedManage, markRead);
router.patch('/read-all', protect, requireWorkspaceOrOwnerForStaff, feedManage, markAllRead);
// Phase 20.6.2 — staff-only "Request Elevated Clearance" (notifies owners).
router.post(
  '/elevation-request',
  protect,
  adminOrHandler,
  requireWorkspaceOrOwnerForStaff,
  requirePermission('notifications.manage'),
  requestElevation
);

export default router;
