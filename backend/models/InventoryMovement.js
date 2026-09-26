import mongoose from 'mongoose';

const movementSchema = new mongoose.Schema(
  {
    productSlug: { type: String, index: true },
    sku: { type: String, default: '' },
    productName: { type: String, default: '' },
    // signed delta, e.g. -1 (sale/remove) or +10 (restock)
    delta: { type: Number, required: true },
    previousStock: { type: Number, required: true },
    newStock: { type: Number, required: true },
    type: {
      type: String,
      // 'correction-down' is a documented negative-direction adjustment type
      // (API.md) — without it in the enum the stock $inc committed but the
      // movement insert failed, leaving a silent partial write (stock changed,
      // no audit row, client told 422 → a retry would double-deduct).
      enum: ['sale', 'restock', 'adjustment', 'return', 'correction', 'correction-down', 'release'],
      default: 'adjustment',
    },
    reason: { type: String, default: '' },
    orderId: { type: String, default: null },
    createdBy: { type: String, default: 'system' },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

movementSchema.index({ createdAt: -1 });
// Per-product movement history (inventory detail views + audits).
movementSchema.index({ productSlug: 1, createdAt: -1 });

const InventoryMovement = mongoose.model('InventoryMovement', movementSchema);
export default InventoryMovement;
