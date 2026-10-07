import React from 'react';
import { ShieldCheck } from 'lucide-react';

/**
 * PHASE 3 — verified purchase badge.
 *
 * Renders ONLY when the backend says so. `review.verified` is derived on the
 * server by matching a real order containing the product to the review's
 * author, and the create endpoint ignores any client-supplied `verified`, so
 * this component has no way to be talked into showing a badge that is not
 * earned. When it is not true, it renders nothing at all — never a greyed-out
 * "unverified" label, which would be noise rather than information.
 */
export default function VerifiedPurchaseBadge({ verified, className = '', compact = false }) {
  if (!verified) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[var(--color-botanical-sage)] font-semibold ${compact ? 'text-[11px]' : 'text-[11px]'} ${className}`}
    >
      <ShieldCheck className="w-3 h-3 shrink-0" aria-hidden="true" />
      Verified purchase
    </span>
  );
}
