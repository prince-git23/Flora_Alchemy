import mongoose from 'mongoose';

const customRequestSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      // compound { customerId, createdAt: -1 } below covers the 'mine' query;
      // no separate single-field index needed (Phase 17 dedup).
    },
    description: {
      type: String,
      required: true,
      maxlength: 2000,
    },
    occasion: {
      type: String,
      default: '',
    },
    budget: {
      type: String,
      default: '',
    },
    colors: {
      type: String,
      default: '',
    },
    desiredDate: {
      type: Date,
    },
    imageUrl: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'reviewing', 'quoted', 'accepted', 'declined'],
      default: 'pending',
    },
    adminNotes: {
      type: String,
      default: '',
    },
    // Product context. When a customer starts a request from a catalogue
    // product ("commission a custom version of this"), the server stores the
    // product's IDENTITY and derives workspaceId from it — the client never
    // supplies a workspace. A general request from /custom-gifts has neither,
    // so it stays an unassigned platform request until staff triage it.
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    // Frozen display name so the request still reads correctly for staff and
    // the customer even if the product is later renamed or unpublished.
    productName: { type: String, default: '' },
    // Phase 22.2 — tenant. Absent = unscoped; requests remain scoped to
    // their owner customer only (Phase 22.3 adds the workspace dimension).
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, sparse: true },
  },
  { timestamps: true }
);

customRequestSchema.index({ status: 1, createdAt: -1 });
// Customer's own request list (GET /custom-requests/mine).
customRequestSchema.index({ customerId: 1, createdAt: -1 });
// Phase 22.5 — workspace-scoped request reads.
customRequestSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
// Requests that started from a specific catalogue product.
customRequestSchema.index({ productId: 1, createdAt: -1 }, { sparse: true });

const CustomRequest = mongoose.model('CustomRequest', customRequestSchema);

export default CustomRequest;
