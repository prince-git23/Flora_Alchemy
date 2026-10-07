import React from 'react';
import { Heart } from 'lucide-react';

/**
 * Five-heart rating. SVG hearts only — never emoji, never a star glyph.
 *
 * `aria-hidden` by default: the rating is always accompanied by real text
 * ("4.7 · 12 reviews", or the review's own context), so the heart row is
 * decoration and a screen reader should not repeat it as five unlabelled
 * images. Pass `label` when a row stands alone.
 */
export default function HeartRating({ value, size = 16, className = '', label }) {
  const filled = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
  return (
    <span
      className={`inline-flex items-center gap-0.5 ${className}`}
      aria-hidden={label ? undefined : 'true'}
      {...(label ? { role: 'img', 'aria-label': label } : {})}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <Heart
          key={i}
          style={{ width: size, height: size }}
          className={i <= filled ? 'fill-current' : 'opacity-30'}
        />
      ))}
    </span>
  );
}
