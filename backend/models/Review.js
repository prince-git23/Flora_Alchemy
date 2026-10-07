import mongoose from 'mongoose';

/**
 * Customer product review.
 *
 * Real customer proof only: nothing seeds this collection. A review exists
 * because an authenticated customer submitted one, and `verified` is set from
 * an actual order for that customer containing the product — never guessed.
 *
 * The author's display name is stored as a snapshot (`customerName`) because a
 * review is a published statement: renaming the account later must not rewrite
 * history, and the storefront must never join to the customer document to
 * render public content.
 *
 * PHASE 3 — moderation. A review is published by default and is only ever
 * removed from public view by an explicit staff action (`status: 'HIDDEN'`),
 * which is recorded with who did it and when. The public read path filters on
 * `status`, so hiding a review removes it from the rating aggregate, the
 * distribution and the customer-media rail at the same time — there is no
 * second place where a hidden review could leak.
 *
 * Customers can also report a review. A report is an append-only record of
 * WHO reported WHAT and WHEN; it never edits the review and never hides it by
 * itself. `reportedCount` exists so the moderation queue can sort by it.
 */
const reviewSchema = new mongoose.Schema(
  {
    // Public storefront product identifier — same key the URL uses.
    productSlug: { type: String, required: true, trim: true, lowercase: true, index: true },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    customerName: { type: String, default: 'Flora Alchemy customer', trim: true },
    // One to five hearts.
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: '', trim: true },
    comment: { type: String, default: '', trim: true },
    // Customer-submitted media (hosted URLs only — no inline base64).
    photos: { type: [String], default: [] },
    video: { type: String, default: '' },
    occasion: { type: String, default: '', trim: true },
    recipient: { type: String, default: '', trim: true },
    recommend: { type: Boolean, default: true },
    helpfulCount: { type: Number, default: 0, min: 0 },
    // True only when a real order for this customer contains this product.
    verified: { type: Boolean, default: false },
    // PHASE 3 — moderation state. `PUBLISHED` is the default, so every review
    // that existed before this field was added keeps rendering.
    status: {
      type: String,
      enum: ['PUBLISHED', 'HIDDEN'],
      default: 'PUBLISHED',
      index: true,
    },
    moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    moderatedAt: { type: Date, default: null },
    // PHASE 3 — customer reports. Append-only, one entry per reporting
    // customer (enforced in the controller), never edited afterwards.
    reports: {
      type: [
        new mongoose.Schema(
          {
            customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
            reason: { type: String, default: '', trim: true, maxlength: 300 },
            createdAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    reportedCount: { type: Number, default: 0, min: 0 },
    // Phase 22.2 — tenant. Absent = unscoped (single-workspace today); a
    // client-supplied workspaceId is scrubbed in server.js before it lands.
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, sparse: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// One review per customer per product — a customer edits or deletes rather
// than stacking duplicates.
reviewSchema.index({ productSlug: 1, customerId: 1 }, { unique: true });
reviewSchema.index({ productSlug: 1, createdAt: -1 });

const Review = mongoose.model('Review', reviewSchema);
export default Review;
