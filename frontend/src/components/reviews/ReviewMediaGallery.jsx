import React from 'react';
import { Camera, Play } from 'lucide-react';
import HeartRating from './HeartRating.jsx';

/**
 * PHASE 3 — "Loved by our customers": the real customer-media rail.
 *
 * Every tile is a real photo or clip a customer attached to a published
 * review, flattened server-side from the reviews that actually exist. When
 * there is no customer media the section does not render at all (the product
 * page checks `media.length`), so the storefront never shows an empty
 * showcase or a stock image standing in for one.
 *
 * Tiles are buttons, not links: tapping opens the shared viewer, which owns
 * the keyboard contract (Escape, arrows, focus trap, focus return) and never
 * autoplays a clip with sound.
 */
export default function ReviewMediaGallery({ media = [], onOpen, className = '' }) {
  if (!media.length) return null;
  const items = media.slice(0, 8);

  return (
    <section className={`mt-12 lg:mt-20 ${className}`}>
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-5">
        <div>
          <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Customer media</span>
          <h2 className="font-serif text-[24px] sm:text-[28px] lg:text-[34px] text-[var(--color-botanical-primary)] mt-1">
            Loved by our customers
          </h2>
        </div>
        <p className="text-[12px] text-[var(--color-botanical-muted)] flex items-center gap-1.5">
          <Camera className="w-3.5 h-3.5" aria-hidden="true" /> Photos and clips shared by customers
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {items.map((item, idx) => (
          <button
            key={`${item.reviewId}-${item.url}-${idx}`}
            type="button"
            onClick={() => onOpen(items, idx)}
            aria-label={item.type === 'video' ? `Play customer video by ${item.author}` : `Open customer photo by ${item.author}`}
            className={`relative rounded-2xl overflow-hidden bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] hover:border-[var(--color-border-strong)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${idx % 4 === 0 ? 'lg:row-span-2 aspect-[3/4]' : 'aspect-square'}`}
          >
            {item.type === 'video' ? (
              <>
                <video src={item.url} preload="metadata" muted playsInline className="w-full h-full object-cover" />
                <span className="absolute top-3 right-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--color-botanical-primary)]/80 text-[var(--color-surface-bg)] text-[11px] font-semibold">
                  <Play className="w-3 h-3" aria-hidden="true" /> Video
                </span>
              </>
            ) : (
              <img src={item.url} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
            )}
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[var(--color-botanical-primary)]/85 to-transparent p-3 text-left">
              <HeartRating value={item.rating} size={12} className="text-[var(--color-accent)]" />
              <span className="block text-[11px] text-[var(--color-surface-bg)] mt-1 truncate">{item.author}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
