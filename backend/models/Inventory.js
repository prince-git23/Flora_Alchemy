import mongoose from 'mongoose';

const inventorySchema = new mongoose.Schema(
  {
    productSlug: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    sku: { type: String, default: '' },
    productName: { type: String, default: '' },
    currentStock: { type: Number, default: 0, min: 0 },
    reorderLevel: { type: Number, default: 0 },
    unit: { type: String, default: 'units' },
    // Phase 22.2 — tenant. Absent = unscoped; stock logic (adjustStock) is
    // unchanged and NOT workspace-filtered yet (docs/MULTI-TENANT.md).
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, sparse: true },
    isFixture: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        ret.status =
          ret.currentStock <= 0
            ? 'Out of Stock'
            : ret.currentStock <= ret.reorderLevel
              ? 'Low Stock'
              : 'In Stock';
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Phase 22.5 — per-workspace stock identity.
inventorySchema.index({ workspaceId: 1, productSlug: 1 }, { unique: true });

const Inventory = mongoose.model('Inventory', inventorySchema);
export default Inventory;
