import { Router } from 'express';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import { requireWorkspaceOrOwnerForStaff } from '../middleware/workspaceMiddleware.js';
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
router.get('/', protect, requireWorkspaceOrOwnerForStaff, listNotifications);
router.get('/unread-count', protect, requireWorkspaceOrOwnerForStaff, unreadCount);
router.patch('/:id/read', protect, requireWorkspaceOrOwnerForStaff, markRead);
router.patch('/read-all', protect, requireWorkspaceOrOwnerForStaff, markAllRead);
// Phase 20.6.2 — staff-only "Request Elevated Clearance" (notifies owners).
router.post('/elevation-request', protect, adminOrHandler, requireWorkspaceOrOwnerForStaff, requestElevation);

export default router;
