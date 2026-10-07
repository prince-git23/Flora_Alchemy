import { OCCASION_OPTIONS, RECIPIENT_OPTIONS } from '../../services/giftFinderService.js';

/**
 * PHASE 3 — shared review formatting.
 *
 * The reviews surface is extracted into components so the product page stays
 * readable, and these helpers are the single place where review metadata is
 * turned into human words. Nothing here invents a value: an unknown id falls
 * back to its own slug with underscores spaced, which is honest about the fact
 * that the taxonomy does not know it.
 */

const OCCASION_LABELS = new Map(OCCASION_OPTIONS.map((o) => [o.id, o.label]));
const RECIPIENT_LABELS = new Map(RECIPIENT_OPTIONS.map((r) => [r.id, r.label]));

export function labelForOccasion(id) {
  return OCCASION_LABELS.get(id) || String(id || '').replace(/_/g, ' ');
}

export function labelForRecipient(id) {
  return RECIPIENT_LABELS.get(id) || String(id || '').replace(/_/g, ' ');
}

export function formatReviewDate(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

/** The line under a review: "Anniversary · Partner", or nothing when unknown. */
export function reviewContext(review) {
  const parts = [];
  if (review?.occasion) parts.push(labelForOccasion(review.occasion));
  if (review?.recipient) parts.push(labelForRecipient(review.recipient));
  return parts.join(' · ');
}

/** Human file size for upload feedback — one shared implementation.
 *  Re-exported here so the review components keep a single import site. */
export { formatBytes } from '../../lib/formatBytes.js';
