import React, { useState } from 'react';
import { Heart, Play, Flag } from 'lucide-react';
import HeartRating from './HeartRating.jsx';
import VerifiedPurchaseBadge from './VerifiedPurchaseBadge.jsx';
import { formatReviewDate, reviewContext } from './reviewFormat.js';

/**
 * PHASE 3 — one customer review.
 *
 * The card answers four questions in this order: who said it (and whether they
 * actually bought it), how they rated it, what they wrote, and what they were
 * willing to show. Media is a compact thumbnail row rather than a gallery —
 * reviews must never be visually louder than the product they describe.
 *
 * The report control exists because customer content needs a customer-side
 * safety valve; it files the review for staff moderation and never hides
 * anything by itself.
 */
export default function ReviewCard({ review, onHelpful, helpfulDisabled, onOpenMedia, onReport }) {
  const photos = Array.isArray(review.photos) ? review.photos : [];
  const hasVideo = Boolean(review.video);
  const mediaItems = [
    ...photos.map((url) => ({
      url,
      type: 'image',
      author: review.customerName,
      rating: review.rating,
      caption: review.title || review.comment || '',
    })),
    ...(hasVideo
      ? [{
        url: review.video,
        type: 'video',
        author: review.customerName,
        rating: review.rating,
        caption: review.title || review.comment || '',
      }]
      : []),
  ];
  const context = reviewContext(review);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportState, setReportState] = useState('idle'); // idle | sending | sent | error
  const [reportError, setReportError] = useState('');

  const sendReport = async () => {
    if (!onReport) return;
    setReportState('sending');
    setReportError('');
    try {
      await onReport(review.id, reportReason.trim());
      setReportState('sent');
      setReportOpen(false);
      setReportReason('');
    } catch (err) {
      setReportState('error');
      setReportError(err.message || 'That report could not be sent.');
    }
  };

  return (
    <article className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-full bg-[var(--color-surface-low)] text-[var(--color-botanical-primary)] font-serif text-[16px] flex items-center justify-center shrink-0">
            {(review.customerName || 'F').trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)] truncate">{review.customerName}</p>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] flex items-center gap-2 flex-wrap">
              <VerifiedPurchaseBadge verified={review.verified} />
              <span>{formatReviewDate(review.createdAt)}</span>
            </p>
          </div>
        </div>
        <HeartRating value={review.rating} size={14} className="text-[var(--color-accent)]" label={`${review.rating} out of 5 hearts`} />
      </div>

      {review.title && (
        <h3 className="font-serif text-[17px] text-[var(--color-botanical-primary)] leading-snug">{review.title}</h3>
      )}
      {review.comment && (
        <p className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">{review.comment}</p>
      )}

      {context && (
        <p className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-botanical-subtle)]">{context}</p>
      )}

      {mediaItems.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {mediaItems.map((item, idx) => (
            <button
              key={`${item.url}-${idx}`}
              type="button"
              onClick={() => onOpenMedia(mediaItems, idx)}
              aria-label={item.type === 'video' ? 'Play customer video' : 'Open customer photo'}
              className="relative w-20 h-20 rounded-xl overflow-hidden bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] hover:border-[var(--color-border-strong)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            >
              {item.type === 'video' ? (
                <>
                  <video src={item.url} preload="metadata" muted playsInline className="w-full h-full object-cover" />
                  <span className="absolute inset-0 flex items-center justify-center bg-[#180f0a]/35">
                    <span className="w-7 h-7 rounded-full bg-white/90 flex items-center justify-center">
                      <Play className="w-3.5 h-3.5 text-[#180f0a]" aria-hidden="true" />
                    </span>
                  </span>
                </>
              ) : (
                <img src={item.url} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
              )}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2 border-t border-[var(--color-botanical-border)]">
        <button
          type="button"
          onClick={() => onHelpful(review.id)}
          disabled={helpfulDisabled}
          className="inline-flex items-center gap-1.5 min-h-[44px] text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] disabled:opacity-60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded-full"
        >
          <Heart className={`w-3.5 h-3.5 ${helpfulDisabled ? 'fill-[var(--color-accent)] text-[var(--color-accent)]' : ''}`} aria-hidden="true" />
          Helpful · {review.helpfulCount || 0}
        </button>

        <div className="flex items-center gap-3">
          {reportState === 'sent' ? (
            <span className="text-[11px] text-[var(--color-botanical-muted)]">Reported — thank you</span>
          ) : (
            <button
              type="button"
              onClick={() => { setReportOpen((v) => !v); setReportError(''); }}
              className="inline-flex items-center gap-1.5 min-h-[44px] text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded-full"
              aria-expanded={reportOpen}
            >
              <Flag className="w-3.5 h-3.5" aria-hidden="true" />
              Report
            </button>
          )}
          {!reportOpen && review.recommend ? (
            <span className="text-[11px] text-[var(--color-botanical-sage)] font-semibold">Would recommend</span>
          ) : null}
        </div>
      </div>

      {reportOpen && (
        <div className="rounded-xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] p-3.5 space-y-2.5">
          <label htmlFor={`report-${review.id}`} className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">
            What is wrong with this review?
          </label>
          <textarea
            id={`report-${review.id}`}
            rows={2}
            maxLength={300}
            value={reportReason}
            onChange={(e) => setReportReason(e.target.value)}
            placeholder="Optional — a short note helps the studio review it faster."
            className="w-full p-3 rounded-xl bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] resize-none"
          />
          {reportError ? (
            <p role="alert" className="text-[12px] text-[var(--color-danger)]">{reportError}</p>
          ) : (
            <p className="text-[11px] text-[var(--color-botanical-subtle)]">
              Reports go to studio moderation. The review is not hidden automatically.
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={sendReport}
              disabled={reportState === 'sending'}
              className="min-h-[40px] px-4 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[12px] font-semibold transition-colors disabled:opacity-50"
            >
              {reportState === 'sending' ? 'Sending…' : 'Send report'}
            </button>
            <button
              type="button"
              onClick={() => { setReportOpen(false); setReportError(''); }}
              className="min-h-[40px] px-4 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
