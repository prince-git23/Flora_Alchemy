import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['open', 'closed'],
      default: 'open',
    },
    lastMessageAt: { type: Date, default: null },
    unreadCount: { type: Number, default: 0 },
    // Phase 22.2 — tenant. PHASE 2 §8: server-derived from Order.workspaceId
    // (never from the caller's session), and never part of an API payload —
    // the toJSON transform below strips it. Absent = a pre-onboarding order
    // with no shop to attribute.
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, sparse: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        // PHASE 2 — the internal tenant id is never a customer- (or staff-)
        // facing field: access is enforced server-side from Order.workspaceId.
        delete ret.workspaceId;
        return ret;
      },
    },
  }
);

conversationSchema.virtual('id').get(function () {
  return this._id;
});

// One conversation per order/customer pair.
conversationSchema.index({ orderId: 1, customerId: 1 }, { unique: true });
conversationSchema.index({ customerId: 1, lastMessageAt: -1 });
conversationSchema.index({ lastMessageAt: -1 });
// Phase 22.5 — workspace-scoped conversation reads.
conversationSchema.index({ workspaceId: 1, status: 1, lastMessageAt: -1 });

const Conversation = mongoose.model('Conversation', conversationSchema);

export default Conversation;
