import mongoose from 'mongoose';

/**
 * Customer wishlist — PHASE 2: ONE GLOBAL WISHLIST PER CUSTOMER.
 *
 * The wishlist is a CUSTOMER-owned record: its authority is the customer
 * identity (`customerId`), never a shop or a workspace. A customer saves
 * products from any shop into the same document, and navigating between
 * /shops/<slug> addresses never changes which record is read or written.
 * Ownership is always derived from the authenticated user on the backend; the
 * browser never supplies an owner id (and a client `workspaceId` is scrubbed
 * globally in server.js).
 *
 * `workspaceId` is DEPRECATED — it survives only so documents written by the
 * Phase 22.5 per-(customer, workspace) model stay readable until
 * `scripts/merge-wishlists-global.mjs` consolidates them. New documents are
 * created unscoped (null) and the controller treats every owned document as a
 * candidate for the union it presents. The compound unique index is kept: it
 * now enforces at most one unscoped (global) document per customer.
 */
const wishlistSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    // DEPRECATED (Phase 2) — legacy tenant stamp. Never an authority; the
    // migration sets it to null on the canonical document.
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      default: null,
      index: true,
    },
    productIds: {
      // Product slugs (the storefront's public product ids) — global slugs, so
      // one wishlist can legitimately mix products from several shops.
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

// At most one document per (customerId, workspaceId) — after Phase 2 the
// workspace is always null, so this is the "one global wishlist" guard for new
// rows, while legacy scoped rows remain representable until the migration.
wishlistSchema.index({ customerId: 1, workspaceId: 1 }, { unique: true });

const Wishlist = mongoose.model('Wishlist', wishlistSchema);
export default Wishlist;
