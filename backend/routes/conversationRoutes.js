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

const router = Router();

// PHASE-22.2: NOT YET TENANT-SCOPED — no requireWorkspace on this router (docs/MULTI-TENANT.md).

// All conversation routes require authentication
router.use(protect);

// Unread count (any authenticated user)
router.get('/unread', unreadCount);

// Get or create conversation for an order (customer or staff)
router.get('/order/:orderId', getOrCreateByOrder);

// List customer's own conversations
router.get('/mine', listMine);

// List all conversations (admin/handler only)
router.get('/', adminOrHandler, listAll);

// Messages for a conversation
router.get('/:conversationId/messages', listMessages);

// Send a message
router.post('/:conversationId/messages', createMessage);

// Mark conversation as read
router.patch('/:conversationId/read', markConversationRead);

// Update conversation status (admin/handler only)
router.patch('/:conversationId/status', adminOrHandler, updateStatus);

export default router;
