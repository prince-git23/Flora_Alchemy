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
    // HOMEPAGE HERO — optional, additive catalogue metadata. A product is only
    // promoted into the pinned hero when an administrator explicitly sets
    // `hero`; the storefront then orders by `heroOrder` and falls back to the
    // static hero when fewer than two are flagged.
    hero: { type: Boolean, default: false, index: true },
    heroOrder: { type: Number, default: 0, min: 0 },
    tagline: { type: String, default: '', trim: true, maxlength: 180 },
    // Tier 2/3 studio media. Empty strings mean "not supplied": the storefront
    // must fall back to the product's ordinary photograph, never invent art.
    heroCutout: { type: String, default: '', trim: true },
    model: { type: String, default: '', trim: true },
    turntable: { type: [String], default: [] },
    accent: { type: String, default: '', trim: true },
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
productSchema.index({ hero: 1, heroOrder: 1 });
// Phase 22.5 — per-workspace catalogue identity (the tenant-correct key).
// The global `slug` unique index is retained for now (documented limit).
productSchema.index({ workspaceId: 1, slug: 1 }, { unique: true });

const Product = mongoose.model('Product', productSchema);
export default Product;
