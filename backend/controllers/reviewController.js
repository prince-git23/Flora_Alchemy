import mongoose from 'mongoose';
import Review from '../models/Review.js';
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { getWorkspaceId } from '../utils/tenancy.js';
import { activeShopForId } from '../utils/publicShop.js';

/**
 * Customer product reviews.
 *
 * Public read: aggregate rating, the 1–5 heart distribution and the latest
 * reviews, plus the customer-submitted media rail. Nothing is fabricated here:
 * an empty collection produces an empty summary (count 0, average 0) and the
 * storefront shows an honest "no reviews yet" state instead of invented stars.
 *
 * Authenticated write: the author is ALWAYS `req.user.customerId` — a
 * body/query `customerId` is never read, so a customer can only ever publish
 * under their own identity.
 */

/**
 * PHASE 3 — the ONLY definition of "this review is publicly visible".
 *
 * `$ne: 'HIDDEN'` rather than `=== 'PUBLISHED'` on purpose: reviews written
 * before moderation existed carry no `status` field at all, and a missing field
 * does not match an equality filter in MongoDB. Every public read (aggregate,
 * distribution, list, media rail, helpful vote) goes through this so a hidden
 * review cannot leak through an endpoint that forgot the rule.
 */
const PUBLIC_REVIEW = { status: { $ne: 'HIDDEN' } };

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanUrls(value, max, urlMax = 2048) {
  if (!Array.isArray(value)) return [];
  return value
    .map((url) => (typeof url === 'string' ? url.trim() : ''))
    .filter((url) => url.length > 0 && url.length <= urlMax)
    .slice(0, max);
}

/**
 * PHASE 1 — a review is only reachable through a VALID PUBLIC product.
 *
 * Reviews are Product-based (no review tenancy model): a review whose product
 * is missing, Hidden or owned by a suspended/deleted workspace must not stay
 * publicly discoverable through the review endpoints. Resolving the product
 * first and answering the SAME 404 as an unknown slug keeps existence opaque.
 *
 * @returns {Promise<object>} the public product row
 * @throws {ApiError} 404 when the product is not publicly available
 */
async function resolvePublicProduct(productSlug) {
  const product = await Product.findOne({ slug: productSlug })
    .select('slug name visibility workspaceId')
    .lean();
  if (!product || product.visibility === 'Hidden') {
    throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
  }
  if (product.workspaceId && !(await activeShopForId(product.workspaceId))) {
    throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
  }
  return product;
}

function shape(review) {
  return {
    id: String(review._id),
    productSlug: review.productSlug,
    customerName: review.customerName || 'Flora Alchemy customer',
    rating: review.rating,
    title: review.title || '',
    comment: review.comment || '',
    photos: Array.isArray(review.photos) ? review.photos : [],
    video: review.video || '',
    occasion: review.occasion || '',
    recipient: review.recipient || '',
    recommend: review.recommend !== false,
    helpfulCount: review.helpfulCount || 0,
    verified: !!review.verified,
    createdAt: review.createdAt,
  };
}

export async function listProductReviews(req, res, next) {
  try {
    const productSlug = String(req.params.id || '').trim().toLowerCase();
    if (!productSlug) throw new ApiError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    // PHASE 1 — reviews resolve only for a valid public product.
    await resolvePublicProduct(productSlug);

    const publicQuery = { productSlug, ...PUBLIC_REVIEW };
    const [total, recommendTotal, distribution, reviews] = await Promise.all([
      Review.countDocuments(publicQuery),
      Review.countDocuments({ ...publicQuery, recommend: { $ne: false } }),
      Review.aggregate([
        { $match: publicQuery },
        { $group: { _id: { $round: ['$rating', 0] }, count: { $sum: 1 } } },
      ]),
      Review.find(publicQuery).sort({ createdAt: -1 }).limit(40).lean(),
    ]);

    const buckets = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let weighted = 0;
    for (const row of distribution) {
      const heart = Math.min(5, Math.max(1, Math.round(Number(row._id) || 0)));
      buckets[heart] += row.count;
      weighted += heart * row.count;
    }
    const average = total > 0 ? Math.round((weighted / total) * 10) / 10 : 0;

    // Real customer media only — flattened from published reviews.
    const media = [];
    for (const review of reviews) {
      for (const url of Array.isArray(review.photos) ? review.photos : []) {
        media.push({
          url,
          type: 'image',
          reviewId: String(review._id),
          author: review.customerName || 'Flora Alchemy customer',
          rating: review.rating,
          caption: review.title || review.comment || '',
        });
      }
      if (review.video) {
        media.push({
          url: review.video,
          type: 'video',
          reviewId: String(review._id),
          author: review.customerName || 'Flora Alchemy customer',
          rating: review.rating,
          caption: review.title || review.comment || '',
        });
      }
    }

    res.json({
      success: true,
      reviews: reviews.map(shape),
      summary: {
        average,
        count: total,
        distribution: buckets,
        recommendPercent: total > 0 ? Math.round((recommendTotal / total) * 100) : 0,
        photoCount: media.filter((m) => m.type === 'image').length,
        videoCount: media.filter((m) => m.type === 'video').length,
      },
      media: media.slice(0, 16),
    });
  } catch (err) {
    next(err);
  }
}

export async function createReview(req, res, next) {
  try {
    const productSlug = String(req.params.id || '').trim().toLowerCase();
    // PHASE 1 — the same public-product rule as the read path: no reviews can
    // be written against a Hidden product or a suspended shop's catalogue.
    const product = await resolvePublicProduct(productSlug);

    const rating = Math.round(Number(req.body && req.body.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      throw new ApiError(422, 'Choose a rating from one to five hearts.', 'VALIDATION_ERROR');
    }
    const title = clean(req.body && req.body.title, 120);
    const comment = clean(req.body && req.body.comment, 2000);
    if (!title && !comment) {
      throw new ApiError(422, 'Add a short note about this piece before sharing.', 'VALIDATION_ERROR');
    }

    // Identity comes from the session ONLY — a body customerId is ignored.
    const customerId = req.user && req.user.customerId;
    if (!customerId) {
      throw new ApiError(401, 'Sign in to share your experience.', 'UNAUTHENTICATED');
    }

    const existing = await Review.findOne({ productSlug, customerId });
    if (existing) {
      throw new ApiError(409, 'You have already shared a review for this piece.', 'DUPLICATE');
    }

    // Verified purchase is derived, never asserted by the client.
    const order = await Order.findOne({
      customerId,
      'items.productSlug': productSlug,
    })
      .select('_id')
      .lean();

    const workspaceId = getWorkspaceId(product);
    const review = await Review.create({
      productSlug,
      customerId,
      customerName: clean(req.user && req.user.name, 120) || 'Flora Alchemy customer',
      rating,
      title,
      comment,
      photos: cleanUrls(req.body && req.body.photos, 6),
      video: clean(req.body && req.body.video, 2048),
      occasion: clean(req.body && req.body.occasion, 60),
      recipient: clean(req.body && req.body.recipient, 60),
      recommend: !(req.body && req.body.recommend === false),
      verified: !!order,
      ...(workspaceId ? { workspaceId } : {}),
    });

    res.status(201).json({ success: true, review: shape(review) });
  } catch (err) {
    next(err);
  }
}

export async function markReviewHelpful(req, res, next) {
  try {
    const { reviewId } = req.params;
    if (!mongoose.isValidObjectId(reviewId)) {
      throw new ApiError(404, 'Review not found.', 'REVIEW_NOT_FOUND');
    }
    const review = await Review.findById(reviewId).lean();
    // PHASE 3 — a hidden review has no public counter to increment.
    if (!review || review.status === 'HIDDEN') {
      throw new ApiError(404, 'Review not found.', 'REVIEW_NOT_FOUND');
    }
    // PHASE 1 — resolve FIRST: a review of a no-longer-public product must
    // not even mutate (no vote on a Hidden/suspended catalogue entry).
    await resolvePublicProduct(String(review.productSlug || '').toLowerCase());
    const updated = await Review.findOneAndUpdate(
      { _id: review._id },
      { $inc: { helpfulCount: 1 } },
      { new: true }
    ).lean();
    if (!updated) throw new ApiError(404, 'Review not found.', 'REVIEW_NOT_FOUND');
    res.json({ success: true, review: shape(updated) });
  } catch (err) {
    next(err);
  }
}

/**
 * PHASE 3 — report a review.
 *
 * A report is a customer statement about someone else's review, so the author
 * is ALWAYS `req.user.customerId` (never a body field) and one customer may
 * report a given review once. The review itself is never edited, hidden or
 * deleted here: reporting only files it into the staff moderation queue, where
 * a human decides. Nothing about the reporter is exposed publicly.
 */
export async function reportReview(req, res, next) {
  try {
    const { reviewId } = req.params;
    if (!mongoose.isValidObjectId(reviewId)) {
      throw new ApiError(404, 'Review not found.', 'REVIEW_NOT_FOUND');
    }
    const customerId = req.user && req.user.customerId;
    if (!customerId) {
      throw new ApiError(401, 'Sign in to report a review.', 'UNAUTHENTICATED');
    }

    const review = await Review.findById(reviewId).lean();
    if (!review || review.status === 'HIDDEN') {
      throw new ApiError(404, 'Review not found.', 'REVIEW_NOT_FOUND');
    }
    // Same public-product rule as every other review read.
    await resolvePublicProduct(String(review.productSlug || '').toLowerCase());

    const reason = clean(req.body && req.body.reason, 300);
    const already = (review.reports || []).some(
      (r) => String(r.customerId) === String(customerId)
    );
    if (already) {
      // Idempotent: reporting twice is not an error, it just does not stack.
      return res.json({ success: true, reported: true, reportedCount: review.reportedCount || 0 });
    }

    const updated = await Review.findOneAndUpdate(
      { _id: review._id },
      {
        $push: { reports: { customerId, reason, createdAt: new Date() } },
        $inc: { reportedCount: 1 },
      },
      { new: true }
    ).lean();
    if (!updated) throw new ApiError(404, 'Review not found.', 'REVIEW_NOT_FOUND');

    res.json({
      success: true,
      reported: true,
      reportedCount: updated.reportedCount || 0,
    });
  } catch (err) {
    next(err);
  }
}

// ── STAFF MODERATION ────────────────────────────────────────────────────
// Guarded by the existing role gates on the route (protect + adminOrHandler,
// with delete restricted to administrators): the permission catalogue has no
// `reviews.*` entry, so moderation deliberately rides the role authority that
// already exists rather than inventing a permission the staff editor cannot
// assign. Nothing here trusts a client-supplied status or identity.

function moderationRow(review, productNameBySlug) {
  return {
    id: String(review._id),
    productSlug: review.productSlug,
    productName: productNameBySlug.get(review.productSlug) || review.productSlug,
    customerName: review.customerName || 'Flora Alchemy customer',
    rating: review.rating,
    title: review.title || '',
    comment: review.comment || '',
    photos: Array.isArray(review.photos) ? review.photos : [],
    video: review.video || '',
    verified: !!review.verified,
    status: review.status === 'HIDDEN' ? 'HIDDEN' : 'PUBLISHED',
    helpfulCount: review.helpfulCount || 0,
    reportedCount: review.reportedCount || 0,
    // Reasons only — never the reporting customers' identities.
    reportReasons: (review.reports || []).map((r) => r.reason).filter(Boolean).slice(0, 10),
    createdAt: review.createdAt,
    moderatedAt: review.moderatedAt || null,
  };
}

/**
 * Staff view of the moderation queue.
 *
 * Tabs: published · hidden · reported (anything a customer has reported, in any
 * status). Counts are whole-ledger counts, so applying a tab never changes what
 * a number means. No customer identifier or email is projected.
 */
export async function listReviewsForModeration(req, res, next) {
  try {
    const tab = String((req.query && req.query.tab) || 'published').toLowerCase();
    const limit = Math.min(50, Math.max(1, Number(req.query && req.query.limit) || 20));
    const page = Math.max(1, Number(req.query && req.query.page) || 1);

    const filters = {
      published: { status: { $ne: 'HIDDEN' } },
      hidden: { status: 'HIDDEN' },
      reported: { reportedCount: { $gt: 0 } },
    };
    const filter = filters[tab] || filters.published;

    const [rows, total, published, hidden, reported] = await Promise.all([
      Review.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Review.countDocuments(filter),
      Review.countDocuments(filters.published),
      Review.countDocuments(filters.hidden),
      Review.countDocuments(filters.reported),
    ]);

    const slugs = [...new Set(rows.map((r) => r.productSlug))];
    const products = slugs.length
      ? await Product.find({ slug: { $in: slugs } }).select('slug name').lean()
      : [];
    const nameBySlug = new Map(products.map((p) => [p.slug, p.name]));

    res.json({
      success: true,
      tab,
      page,
      limit,
      total,
      hasMore: page * limit < total,
      counts: { published, hidden, reported },
      reviews: rows.map((r) => moderationRow(r, nameBySlug)),
    });
  } catch (err) {
    next(err);
  }
}

/** Hide or restore one review. Idempotent — the returned row states the truth. */
export async function setReviewStatus(req, res, next) {
  try {
    const { reviewId } = req.params;
    if (!mongoose.isValidObjectId(reviewId)) {
      throw new ApiError(404, 'Review not found.', 'REVIEW_NOT_FOUND');
    }
    const requested = String((req.body && req.body.status) || '').toUpperCase();
    if (requested !== 'PUBLISHED' && requested !== 'HIDDEN') {
      throw new ApiError(422, 'Status must be PUBLISHED or HIDDEN.', 'VALIDATION_ERROR');
    }

    const updated = await Review.findByIdAndUpdate(
      reviewId,
      {
        status: requested,
        moderatedBy: req.user._id,
        moderatedAt: new Date(),
        // Restoring a review clears the report queue for it; the reports are
        // history, so they stay on the document but no longer flag it.
        ...(requested === 'PUBLISHED' ? { reportedCount: 0 } : {}),
      },
      { new: true }
    ).lean();
    if (!updated) throw new ApiError(404, 'Review not found.', 'REVIEW_NOT_FOUND');

    const product = await Product.findOne({ slug: updated.productSlug }).select('slug name').lean();
    const nameBySlug = new Map(product ? [[product.slug, product.name]] : []);
    res.json({ success: true, review: moderationRow(updated, nameBySlug) });
  } catch (err) {
    next(err);
  }
}

/** Remove a review permanently. Admin-only at the route level. */
export async function deleteReview(req, res, next) {
  try {
    const { reviewId } = req.params;
    if (!mongoose.isValidObjectId(reviewId)) {
      throw new ApiError(404, 'Review not found.', 'REVIEW_NOT_FOUND');
    }
    const deleted = await Review.findByIdAndDelete(reviewId).lean();
    if (!deleted) throw new ApiError(404, 'Review not found.', 'REVIEW_NOT_FOUND');
    res.json({ success: true, deletedId: String(deleted._id) });
  } catch (err) {
    next(err);
  }
}
