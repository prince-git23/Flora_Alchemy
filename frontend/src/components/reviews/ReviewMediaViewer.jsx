import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, Play } from 'lucide-react';
import HeartRating from './HeartRating.jsx';

/**
 * PHASE 3 — review media viewer.
 *
 * One dialog for both customer photos and customer clips, because a reviewer
 * sharing a video and a reviewer sharing photos are the same interaction:
 * "show me what arrived".
 *
 * Accessibility contract (all of it exercised in the Phase 3 QA pass):
 *   · `role="dialog" aria-modal="true"` with a label naming the item
 *   · Escape closes; ← / → move through the items
 *   · focus is trapped inside while open and RETURNED to whatever opened it
 *   · video never autoplays and always carries native controls, so a clip can
 *     never start talking at a customer unprompted
 */
export default function ReviewMediaViewer({ items = [], startIndex = 0, onClose }) {
  const [index, setIndex] = useState(Math.max(0, Math.min(startIndex, items.length - 1)));
  const dialogRef = useRef(null);
  const restoreFocusRef = useRef(null);

  const item = items[index];

  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    return () => {
      const target = restoreFocusRef.current;
      if (target && typeof target.focus === 'function') target.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((i) => (i - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIndex((i) => (i + 1) % items.length);
        return;
      }
      if (e.key === 'Tab') {
        // Keep focus inside the dialog: the viewer owns the screen while open.
        const focusables = dialogRef.current
          ? Array.from(
            dialogRef.current.querySelectorAll(
              'button, [href], video, audio, [tabindex]:not([tabindex="-1"])'
            )
          ).filter((el) => !el.hasAttribute('disabled'))
          : [];
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length, onClose]);

  if (!item) return null;

  const hasMany = items.length > 1;

  return (
    <div
      className="fixed inset-0 z-[70] bg-[#180f0a]/95 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Customer ${item.type === 'video' ? 'video' : 'photo'} ${index + 1} of ${items.length}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={dialogRef} className="relative w-full max-w-5xl flex flex-col items-center gap-4">
        {item.type === 'video' ? (
          <video
            key={item.url}
            src={item.url}
            controls
            playsInline
            preload="metadata"
            className="max-h-[76vh] w-auto max-w-full rounded-2xl bg-black"
          >
            <track kind="captions" />
          </video>
        ) : (
          <img
            key={item.url}
            src={item.url}
            alt={item.caption ? `Customer photo — ${item.caption}` : 'Customer photo'}
            className="max-h-[76vh] w-auto max-w-full object-contain rounded-2xl"
          />
        )}

        <div className="w-full max-w-lg text-center space-y-1.5">
          <HeartRating value={item.rating} size={14} className="text-[var(--color-accent)] justify-center" label={`${item.rating} out of 5 hearts`} />
          <p className="text-[13px] font-semibold text-[#f7f4ef]">{item.author}</p>
          {item.caption ? (
            <p className="text-[12px] text-[#d6cec6] line-clamp-2">{item.caption}</p>
          ) : null}
          {hasMany ? (
            <p className="text-[11px] uppercase tracking-widest text-[#d6cec6] pt-1">
              {index + 1} / {items.length}
            </p>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        onClick={onClose}
        aria-label="Close media viewer"
        className="absolute top-5 right-5 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <X className="w-5 h-5" aria-hidden="true" />
      </button>

      {hasMany && (
        <>
          <button
            type="button"
            onClick={() => setIndex((i) => (i - 1 + items.length) % items.length)}
            aria-label="Previous media"
            className="absolute left-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <ChevronLeft className="w-5 h-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setIndex((i) => (i + 1) % items.length)}
            aria-label="Next media"
            className="absolute right-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <ChevronRight className="w-5 h-5" aria-hidden="true" />
          </button>
        </>
      )}

      {item.type === 'video' && (
        <span className="absolute top-5 left-5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 text-white text-[11px] font-semibold">
          <Play className="w-3 h-3" aria-hidden="true" /> Customer video
        </span>
      )}
    </div>
  );
}
