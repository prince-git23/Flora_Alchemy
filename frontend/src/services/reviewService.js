import api, { postForm } from './apiClient.js';

/**
 * reviewService — real customer proof only.
 *
 * Reads are public and return the server-computed aggregate: an empty
 * collection yields { count: 0, average: 0 } and the UI shows an honest
 * "be the first to share" state. Nothing here fabricates reviews.
 *
 * Writes require the customer session; the author is derived server-side from
 * the token, so no customerId is ever sent from the browser.
 *
 * PHASE 3 — uploads and reporting live here too, so no page or component talks
 * to the API directly. Media goes through the shared multipart transport in
 * apiClient (validated server-side by the same MIME + size whitelist every
 * other upload uses), and a report is an authenticated statement that only
 * files the review for staff moderation — it never hides anything by itself.
 */

export const REVIEW_PHOTO_LIMIT = 4;
export const REVIEW_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const REVIEW_VIDEO_MAX_BYTES = 25 * 1024 * 1024;
export const REVIEW_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

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

/**
 * Report a review. Idempotent on the server: reporting twice never stacks.
 * Returns the server's report count so the UI can reflect the real state.
 */
export async function reportReview(reviewId, reason = '') {
  const res = await api.post(`/reviews/${encodeURIComponent(reviewId)}/report`, { reason }, {
    scope: 'customer',
  });
  if (!res.ok) {
    throw new Error(res.message || 'That report could not be sent.');
  }
  return res.data;
}

/**
 * Upload one review photo and return its hosted URL.
 * Validation happens twice on purpose: the browser refuses an obviously wrong
 * file immediately (fast, no wasted bytes), and the server enforces the same
 * MIME + size whitelist regardless of what the client claims.
 */
export async function uploadReviewPhoto(file, { onProgress } = {}) {
  if (!file) throw new Error('Choose a photo to upload.');
  if (!String(file.type || '').startsWith('image/')) {
    throw new Error('Photos must be JPEG, PNG, WebP, GIF or AVIF.');
  }
  if (file.size > REVIEW_PHOTO_MAX_BYTES) {
    throw new Error('Each photo must be 5 MB or smaller.');
  }
  const body = new FormData();
  body.append('image', file);
  const res = await postForm('/uploads/review-image', body, { scope: 'customer', onProgress });
  if (!res.ok || !res.data?.url) {
    throw new Error(res.message || 'That photo could not be uploaded.');
  }
  return res.data.url;
}

/**
 * Upload one review video and return its hosted URL.
 * The clip is validated against the same server-side whitelist the video
 * endpoint enforces (MP4 / WebM / MOV, 25 MB) — the browser check is a
 * courtesy, the server check is the authority.
 */
export async function uploadReviewVideo(file, { onProgress } = {}) {
  if (!file) throw new Error('Choose a video to upload.');
  if (!REVIEW_VIDEO_TYPES.includes(file.type)) {
    throw new Error('Videos must be MP4, WebM or MOV.');
  }
  if (file.size > REVIEW_VIDEO_MAX_BYTES) {
    throw new Error('A review video must be 25 MB or smaller.');
  }
  const body = new FormData();
  body.append('video', file);
  const res = await postForm('/uploads/review-video', body, { scope: 'customer', onProgress });
  if (!res.ok || !res.data?.url) {
    throw new Error(res.message || 'That video could not be uploaded.');
  }
  return res.data.url;
}
