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

const router = Router();

// All conversation routes require authentication
router.use(protect);

// Unread count (any authenticated user — customers skip the gate, staff must
// be a workspace member, the owner badge still reads).
router.get('/unread', requireWorkspaceOrOwnerForStaff, unreadCount);

// Get or create conversation for an order (customer or staff; staff path is
// workspace-checked inside the order lookup).
router.get('/order/:orderId', requireWorkspaceForStaff, getOrCreateByOrder);

// List customer's own conversations
router.get('/mine', listMine);

// List all conversations (admin/handler only, workspace members only)
router.get('/', adminOrHandler, requireWorkspace, listAll);

// Messages for a conversation (ownership/404 enforced per conversation)
router.get('/:conversationId/messages', requireWorkspaceForStaff, listMessages);

// Send a message
router.post('/:conversationId/messages', requireWorkspaceForStaff, createMessage);

// Mark conversation as read
router.patch('/:conversationId/read', requireWorkspaceForStaff, markConversationRead);

// Update conversation status (admin/handler only)
router.patch('/:conversationId/status', adminOrHandler, requireWorkspace, updateStatus);

export default router;
