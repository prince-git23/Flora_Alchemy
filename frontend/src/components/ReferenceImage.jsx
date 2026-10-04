import React, { useState } from 'react';
import { ImageOff, ExternalLink } from 'lucide-react';

/**
 * ReferenceImage — renders a custom request's OPTIONAL reference image.
 *
 * Three honest states, no broken <img> ever reaches the page:
 *  · no image   → "No reference image provided." (the request is still valid);
 *  · broken URL → "The reference image could not be loaded." + the link so the
 *                 studio can still open the original;
 *  · valid      → the image itself, opening full-size in a new tab.
 *
 * The `onError` fallback is the fix for the admin-side "reference image error":
 * a URL the browser cannot fetch degrades to an explanation instead of a
 * broken-image icon (and never throws during render).
 */
export default function ReferenceImage({
  src,
  alt = 'Reference image',
  className = '',
  size = 'md',
  emptyLabel = 'No reference image provided.',
}) {
  const [failed, setFailed] = useState(false);

  if (!src) {
    return (
      <div
        className={`flex items-center gap-2 rounded-xl border border-dashed border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] px-4 py-3 text-[12px] text-[var(--color-botanical-subtle)] ${className}`}
      >
        <ImageOff className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{emptyLabel}</span>
      </div>
    );
  }

  if (failed) {
    return (
      <div
        className={`rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] px-4 py-3 space-y-1 ${className}`}
      >
        <p className="flex items-center gap-2 text-[12px] font-semibold text-[var(--color-botanical-muted)]">
          <ImageOff className="w-4 h-4 shrink-0" aria-hidden="true" />
          The reference image could not be loaded.
        </p>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
        >
          Open the link <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </a>
      </div>
    );
  }

  const imageClass =
    size === 'sm' ? 'max-h-40' : 'max-h-96';

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className={`block rounded-xl overflow-hidden bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] ${className}`}
      title="Open full size"
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={`w-full object-contain ${imageClass}`}
      />
    </a>
  );
}
