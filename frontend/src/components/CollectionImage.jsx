import React, { useState } from 'react';
import { Sprout } from 'lucide-react';

/**
 * PHASE 2 — COLLECTION IMAGE (one implementation, both collection surfaces).
 *
 * A collection's `image` is an admin-supplied URL, so it can be empty, stale or
 * pointing at an asset that no longer exists. The storefront UI system
 * (§ "Product images") requires a graceful missing-image state, so this renders
 * a quiet botanical placeholder instead of the browser's broken-image glyph —
 * the same rule the canonical ProductCard already follows for products.
 *
 * It is deliberately tiny and knows nothing about business data: the parent
 * owns the aspect box, this owns only the media.
 */
export default function CollectionImage({ src, alt, className = '' }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        className="w-full h-full flex items-center justify-center bg-[var(--color-surface-low)]"
        role="img"
        aria-label={`${alt} — image unavailable`}
      >
        <Sprout className="w-6 h-6 text-[var(--color-botanical-subtle)]" aria-hidden="true" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`w-full h-full object-cover fa-img-reveal ${className}`}
    />
  );
}
