import api from './apiClient.js';

/**
 * PHASE 3 — staff review moderation.
 *
 * Reads and mutations use the ADMIN token scope; the server re-reads the
 * account on every request and decides what the caller may do (hide/restore
 * for staff, delete for administrators only). Nothing here is authorization —
 * hiding a button in the UI would not stop a request, and the UI never pretends
 * to be the gate.
 */

export async function listReviewsForModeration({ tab = 'published', page = 1, limit = 20 } = {}) {
  const qs = new URLSearchParams({ tab, page: String(page), limit: String(limit) });
  const res = await api.get(`/admin/reviews?${qs.toString()}`, { scope: 'admin' });
  if (!res.ok) {
    throw new Error(res.message || 'The moderation queue could not be loaded.');
  }
  return {
    reviews: res.data.reviews || [],
    counts: res.data.counts || { published: 0, hidden: 0, reported: 0 },
    total: res.data.total || 0,
    page: res.data.page || page,
    hasMore: Boolean(res.data.hasMore),
  };
}

export async function setReviewStatus(reviewId, status) {
  const res = await api.patch(
    `/admin/reviews/${encodeURIComponent(reviewId)}/status`,
    { status },
    { scope: 'admin' }
  );
  if (!res.ok) {
    throw new Error(res.message || 'That review could not be updated.');
  }
  return res.data.review;
}

export async function deleteReview(reviewId) {
  const res = await api.delete(`/admin/reviews/${encodeURIComponent(reviewId)}`, { scope: 'admin' });
  if (!res.ok) {
    throw new Error(res.message || 'That review could not be deleted.');
  }
  return res.data;
}
