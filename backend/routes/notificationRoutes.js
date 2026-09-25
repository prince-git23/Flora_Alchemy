import { Router } from 'express';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
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
router.get('/', protect, listNotifications);
router.get('/unread-count', protect, unreadCount);
router.patch('/:id/read', protect, markRead);
router.patch('/read-all', protect, markAllRead);
// Phase 20.6.2 — staff-only "Request Elevated Clearance" (notifies owners).
router.post('/elevation-request', protect, adminOrHandler, requestElevation);

export default router;
