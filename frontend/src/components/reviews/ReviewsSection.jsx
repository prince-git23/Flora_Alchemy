import React from 'react';
import { MessageSquarePlus } from 'lucide-react';
import HeartRating from './HeartRating.jsx';
import ReviewSummary from './ReviewSummary.jsx';
import ReviewCard from './ReviewCard.jsx';
import { Skeleton, SkeletonText } from '../Skeleton.jsx';

/**
 * PHASE 3 — the customer trust section, composed once.
 *
 * Reading order is deliberate and matches how a shopper decides whether to
 * believe the page at all: the headline figures first, then the distribution,
 * then the media filter (only when real media exists), then the reviews
 * themselves, newest first.
 *
 * Honest states included here rather than left to each caller:
 *   · loading → skeleton, never a fake average
 *   · error   → the server's own message
 *   · empty   → "no reviews yet" with the real way to be the first
 *   · photo filter with no photo reviews → says so instead of showing nothing
 */
export default function ReviewsSection({
  sectionRef,
  loading,
  error,
  summary,
  distribution,
  distTotal,
  visibleReviews,
  photoFilter,
  onTogglePhotoFilter,
  helpfulIds,
  onHelpful,
  onOpenMedia,
  onReport,
  onOpenForm,
}) {
  const showPhotoFilter = summary.photoCount > 0;

  return (
    <section ref={sectionRef} id="reviews" className="mt-12 lg:mt-20 scroll-mt-24">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Customer reviews</span>
          <h2 className="font-serif text-[24px] sm:text-[28px] lg:text-[34px] text-[var(--color-botanical-primary)] mt-1">
            What customers say
          </h2>
        </div>
        <button
          type="button"
          onClick={onOpenForm}
          className="self-start sm:self-auto min-h-[44px] px-5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold flex items-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        >
          <MessageSquarePlus className="w-4 h-4" aria-hidden="true" /> Share your experience
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-5 text-[13px] text-[var(--color-danger)] bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 rounded-2xl px-4 py-3">
          {error}
        </p>
      )}

      {loading ? (
        <div className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-6 space-y-3">
          <Skeleton className="h-6 w-40 rounded-md" />
          <SkeletonText lines={3} />
        </div>
      ) : summary.count === 0 ? (
        <div className="rounded-3xl border border-dashed border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-6 py-12 text-center">
          <HeartRating value={0} size={18} className="text-[var(--color-accent)] justify-center" />
          <h3 className="font-serif text-[20px] text-[var(--color-botanical-primary)] mt-3">No reviews yet</h3>
          <p className="text-[13px] text-[var(--color-botanical-muted)] mt-2 max-w-md mx-auto">
            This piece has not been reviewed yet. If it has arrived with you, your honest words help the
            next person decide.
          </p>
          <button
            type="button"
            onClick={onOpenForm}
            className="mt-5 min-h-[44px] px-5 rounded-full bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-lowest)] transition-colors"
          >
            Be the first to review
          </button>
        </div>
      ) : (
        <>
          <ReviewSummary summary={summary} distribution={distribution} distTotal={distTotal} />

          {showPhotoFilter && (
            <div className="flex items-center gap-2 mt-5">
              <button
                type="button"
                onClick={() => onTogglePhotoFilter(false)}
                aria-pressed={!photoFilter}
                className={`px-3.5 py-1.5 rounded-full text-[12px] font-semibold transition-colors ${!photoFilter ? 'bg-[var(--color-btn)] text-white' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-lowest)]'}`}
              >
                All reviews
              </button>
              <button
                type="button"
                onClick={() => onTogglePhotoFilter(true)}
                aria-pressed={photoFilter}
                className={`px-3.5 py-1.5 rounded-full text-[12px] font-semibold transition-colors ${photoFilter ? 'bg-[var(--color-btn)] text-white' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-lowest)]'}`}
              >
                With photos ({summary.photoCount})
              </button>
            </div>
          )}

          <div className="mt-5 space-y-4">
            {visibleReviews.length === 0 ? (
              <p className="text-[13px] text-[var(--color-botanical-muted)] rounded-2xl border border-dashed border-[var(--color-botanical-border)] px-4 py-6 text-center">
                No photo reviews yet — switch back to all reviews.
              </p>
            ) : visibleReviews.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                helpfulDisabled={helpfulIds.includes(review.id)}
                onHelpful={onHelpful}
                onOpenMedia={onOpenMedia}
                onReport={onReport}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
