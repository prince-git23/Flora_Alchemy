import React from 'react';
import { Skeleton, SkeletonCard, SkeletonText } from './Skeleton.jsx';

/**
 * Phase 18.5.4 — Bootstrap skeleton shell.
 *
 * Replaces the generic "Preparing your experience" spinner with a
 * content-shaped skeleton that resembles the actual storefront while
 * the initial data hydration completes. Gives the user an immediate
 * sense of the page structure, similar to Instagram / YouTube loading.
 *
 * Phase 20.5 — two variants:
 *   full   legacy full-screen shell, including a navbar skeleton. Kept for any
 *          caller that needs to occupy the whole viewport.
 *   route  content-only skeleton used INSIDE the real <main>, because the real
 *          Navbar/PromoBar/Footer now render immediately: drawing a second
 *          navbar placeholder under the real one would be a visible defect.
 */
export default function BootstrapSkeleton({ variant = 'full' }) {
  const isRoute = variant === 'route';
  return (
    <div
      className={isRoute ? 'bg-[var(--color-surface-bg)]' : 'min-h-screen bg-[var(--color-surface-bg)]'}
      role="status"
      aria-live="polite"
      aria-label={isRoute ? 'Loading page content' : 'Loading Flora Alchemy'}
    >
      {/* Navbar skeleton — full-screen variant only (Phase 20.5). */}
      {!isRoute && (
      <div className="sticky top-0 z-40 border-b border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)]">
        <div className="max-w-[1440px] mx-auto flex items-center justify-between px-4 sm:px-6 lg:px-10 h-16">
          <Skeleton className="h-5 w-32 rounded-md" />
          <div className="hidden md:flex items-center gap-6">
            <Skeleton className="h-3.5 w-14 rounded-md" />
            <Skeleton className="h-3.5 w-14 rounded-md" />
            <Skeleton className="h-3.5 w-14 rounded-md" />
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-8 w-8 rounded-full" />
          </div>
        </div>
      </div>
      )}

      {/* Hero / page content skeleton */}
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-10 py-8 space-y-8">
        {/* Hero area */}
        <Skeleton className="w-full h-48 sm:h-64 lg:h-80 rounded-2xl" />

        {/* Section heading */}
        <div className="space-y-2 max-w-xs">
          <Skeleton className="h-6 w-48 rounded-md" />
          <Skeleton className="h-3.5 w-64 rounded-md" />
        </div>

        {/* Product grid skeleton */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
