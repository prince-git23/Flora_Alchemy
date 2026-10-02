import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    // Public URL / storefront identifier (e.g. "dusty-rose-lavender-posy")
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '' },
    price: { type: Number, required: true, min: 0 },
    category: { type: String, default: 'Flowers & Bouquets' },
    description: { type: String, default: '' },
    // Primary storefront photo. Kept as the canonical single-image field so
    // every existing reader (order lines, catalogue cards, legacy clients)
    // keeps working; it always mirrors images[0].
    image: { type: String, default: '' },
    // The full uploaded gallery, in author/display order. Empty for products
    // created before multi-image support and for single-photo pieces.
    images: { type: [String], default: [] },
    palette: { type: String, default: '' },
    ribbon: { type: String, default: '' },
    occasion: { type: String, default: '' },
    // Catalogue items are stock-tracked; made-to-order custom gifts are not.
    stockTracked: { type: Boolean, default: true },
    visibility: {
      type: String,
      enum: ['Visible', 'Hidden'],
      default: 'Visible',
    },
    collections: [{ type: String }],
    // Phase 22.2 — tenant. Absent = unscoped (single-workspace today);
    // client-supplied workspaceId is scrubbed in server.js. Queries are NOT
    // workspace-filtered yet (see docs/MULTI-TENANT.md), and slug stays
    // globally unique until the Phase 22.5 composite index {workspaceId, slug}.
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, sparse: true },
    isFixture: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret.slug;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

productSchema.index({ name: 'text', category: 'text' });
// Phase 22.5 — per-workspace catalogue identity (the tenant-correct key).
// The global `slug` unique index is retained for now (documented limit).
productSchema.index({ workspaceId: 1, slug: 1 }, { unique: true });

const Product = mongoose.model('Product', productSchema);
export default Product;
