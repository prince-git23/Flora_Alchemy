import { Router } from 'express';
import {
  getOrCreateByOrder,
  listMessages,
  createMessage,
  markConversationRead,
  updateStatus,
  unreadCount,
  listAll,
  listMine,
} from '../controllers/conversationController.js';
import { protect, adminOrHandler } from '../middleware/authMiddleware.js';
import {
  requireWorkspace,
  requireWorkspaceForStaff,
  requireWorkspaceOrOwnerForStaff,
} from '../middleware/workspaceMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';

const router = Router();

// All conversation routes require authentication
router.use(protect);

// GRANULAR STAFF ACCESS — conversations are shared with the customer who owns
// them, so every staff permission here carries `skipNonStaff`: a customer keeps
// the ownership-scoped path (the controller refetches the conversation and
// enforces ownership/404), while a HANDLER needs the permission.
const staffConversationRead = requirePermission('conversations.view', { skipNonStaff: true });

// Unread count (any authenticated user — customers skip the gate, staff must
// be a workspace member, the owner badge still reads).
router.get('/unread', requireWorkspaceOrOwnerForStaff, staffConversationRead, unreadCount);

// Get or create conversation for an order (customer or staff; staff path is
// workspace-checked inside the order lookup).
router.get('/order/:orderId', requireWorkspaceForStaff, staffConversationRead, getOrCreateByOrder);

// List customer's own conversations
router.get('/mine', listMine);

// List all conversations (admin/handler only, workspace members only)
router.get('/', adminOrHandler, requireWorkspace, requirePermission('conversations.view'), listAll);

// Messages for a conversation (ownership/404 enforced per conversation)
router.get('/:conversationId/messages', requireWorkspaceForStaff, staffConversationRead, listMessages);

// Send a message
router.post(
  '/:conversationId/messages',
  requireWorkspaceForStaff,
  requirePermission('conversations.reply', { skipNonStaff: true }),
  createMessage
);

// Mark conversation as read
router.patch('/:conversationId/read', requireWorkspaceForStaff, staffConversationRead, markConversationRead);

// Update conversation status (admin/handler only)
router.patch(
  '/:conversationId/status',
  adminOrHandler,
  requireWorkspace,
  requirePermission('conversations.resolve'),
  updateStatus
);

export default router;
