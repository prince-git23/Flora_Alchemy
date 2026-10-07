import React from 'react';
import HeartRating from './HeartRating.jsx';

/**
 * PHASE 3 — the review headline: real average, real count, real distribution.
 *
 * Every figure comes from the server aggregate (which itself counts only
 * PUBLISHED reviews). When there are no reviews this component is not rendered
 * by the page at all — an empty summary box would be a nicer-looking lie than
 * no box.
 *
 * `distribution` is the server's 1–5 buckets; the bar width is a percentage of
 * the reviews that actually exist, so a single 5-heart review reads as 100%,
 * not as an impressive-looking bar chart.
 */
export default function ReviewSummary({ summary, distribution, distTotal }) {
  const total = distTotal > 0 ? distTotal : 0;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 rounded-3xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5 sm:p-7">
      <div className="lg:col-span-4 flex flex-col items-center lg:items-start justify-center lg:border-r border-[var(--color-botanical-border)] lg:pr-7">
        <span className="font-serif text-[52px] leading-none text-[var(--color-botanical-primary)]">
          {summary.average.toFixed(1)}
        </span>
        <HeartRating
          value={summary.average}
          size={18}
          className="text-[var(--color-accent)] my-2"
          label={`${summary.average.toFixed(1)} out of 5 hearts`}
        />
        <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">
          {summary.count} review{summary.count === 1 ? '' : 's'}
        </p>
        <p className="text-[12px] text-[var(--color-botanical-muted)] mt-0.5">
          {summary.recommendPercent}% would recommend
        </p>
        {(summary.photoCount > 0 || summary.videoCount > 0) && (
          <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-1">
            {summary.photoCount > 0 ? `${summary.photoCount} photo${summary.photoCount === 1 ? '' : 's'}` : ''}
            {summary.photoCount > 0 && summary.videoCount > 0 ? ' · ' : ''}
            {summary.videoCount > 0 ? `${summary.videoCount} video${summary.videoCount === 1 ? '' : 's'}` : ''}
          </p>
        )}
      </div>
      <div className="lg:col-span-8 flex flex-col justify-center gap-2">
        {[5, 4, 3, 2, 1].map((heart) => {
          const n = distribution[heart] || 0;
          const pct = total > 0 ? Math.round((n / total) * 100) : 0;
          return (
            <div key={heart} className="flex items-center gap-3">
              <span className="w-16 text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] shrink-0">
                {heart} heart{heart === 1 ? '' : 's'}
              </span>
              <span className="flex-1 h-1.5 rounded-full bg-[var(--color-surface-low)] overflow-hidden">
                <span className="block h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
              </span>
              <span className="w-10 text-right text-[12px] text-[var(--color-botanical-muted)] tabular-nums">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
