import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  // Who this notification is for
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['admin', 'handler', 'customer'], required: true },

  // Notification content
  type: {
    type: String,
    enum: [
      'new_order',
      'order_status_change',
      'payment_received',
      'payment_failed',
      'low_stock',
      'critical_stock',
      'new_customer',
      'new_custom_request',
      'custom_request_status',
      'new_message',
      'system',
    ],
    required: true,
  },
  title: { type: String, required: true },
  message: { type: String, required: true },

  // Optional reference to related entity
  entityType: { type: String, enum: ['order', 'product', 'customer', 'custom_request', 'conversation', 'inventory', null], default: null },
  entityId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // Link to navigate when notification is clicked
  link: { type: String, default: null },

  // Read state
  read: { type: Boolean, default: false },
  readAt: { type: Date, default: null },
  // Phase 22.2 — tenant. Absent = unscoped; broadcasts are still
  // recipient-driven (userId/role), NOT workspace-filtered (known CRITICAL
  // finding, Phase 22.3).
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, sparse: true },
}, {
  timestamps: true,
});

// Index for efficient queries
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
// Phase 22.5 — workspace-scoped notification reads.
notificationSchema.index({ workspaceId: 1, read: 1 });

// Auto-delete old notifications after 90 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const Notification = mongoose.model('Notification', notificationSchema);

export default Notification;
