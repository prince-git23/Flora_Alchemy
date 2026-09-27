import mongoose from 'mongoose';

/**
 * Customer wishlist — one document per (customer, workspace).
 *
 * Phase 22.5 — a GLOBAL customer identity can keep INDEPENDENT wishlist state
 * per workspace: (customerId, workspaceId) is the tenant identity, and the
 * compound unique index enforces it. Ownership is always derived from the
 * authenticated user on the backend; the browser never supplies an owner id or
 * a workspaceId (the workspace is resolved server-side from the shop slug or
 * the single active workspace).
 *
 * `workspaceId` is nullable so a legacy/platform wishlist (created before the
 * backfill, or on a zero-workspace platform) stays representable; the compound
 * unique still prevents two documents colliding per tenant.
 */
const wishlistSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    // Phase 22.5 — the workspace this wishlist belongs to (null = platform/
    // legacy). Server-assigned only; a client-supplied workspaceId is scrubbed.
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      default: null,
      index: true,
    },
    productIds: {
      // Product slugs (the storefront's public product ids).
      type: [String],
      default: [],
    },
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

// Phase 22.5 — the tenant identity of a wishlist. Replaces the former global
// unique `customerId` (which forbade a customer keeping separate wishlists).
wishlistSchema.index({ customerId: 1, workspaceId: 1 }, { unique: true });

const Wishlist = mongoose.model('Wishlist', wishlistSchema);
export default Wishlist;
