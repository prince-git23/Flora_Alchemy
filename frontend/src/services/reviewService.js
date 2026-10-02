import api from './apiClient.js';

/**
 * reviewService — real customer proof only.
 *
 * Reads are public and return the server-computed aggregate: an empty
 * collection yields { count: 0, average: 0 } and the UI shows an honest
 * "be the first to share" state. Nothing here fabricates reviews.
 *
 * Writes require the customer session; the author is derived server-side from
 * the token, so no customerId is ever sent from the browser.
 */

export async function getProductReviews(slug) {
  const res = await api.get(`/products/${encodeURIComponent(slug)}/reviews`);
  if (!res.ok) {
    throw new Error(res.message || 'Reviews could not be loaded.');
  }
  return {
    reviews: res.data.reviews || [],
    summary: res.data.summary || { average: 0, count: 0, distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }, recommendPercent: 0, photoCount: 0, videoCount: 0 },
    media: res.data.media || [],
  };
}

export async function submitProductReview(slug, payload) {
  const res = await api.post(`/products/${encodeURIComponent(slug)}/reviews`, payload, {
    scope: 'customer',
  });
  if (!res.ok) {
    throw new Error(res.message || 'Your review could not be shared.');
  }
  return res.data.review;
}

export async function markReviewHelpful(reviewId) {
  const res = await api.post(`/reviews/${encodeURIComponent(reviewId)}/helpful`, undefined);
  if (!res.ok) {
    throw new Error(res.message || 'That could not be recorded.');
  }
  return res.data.review;
}
