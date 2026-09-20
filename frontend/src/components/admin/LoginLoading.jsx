import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { Skeleton, SkeletonCircle } from '../Skeleton.jsx';

/**
 * LoginLoading — authentication-in-progress presentation for the
 * Handler Portal. Rendered ONLY after the operator submits valid-looking
 * credentials and the auth request is actually in flight; never used as
 * fake authentication. Reuses the Skeleton system so it respects
 * prefers-reduced-motion and inherits Light/Dark/System themes via the
 * shared tokens (no separate theme logic).
 */
export default function LoginLoading({
  title = 'Preparing your workspace',
  subtitle = 'Verifying your credentials securely…',
}) {
  return (
    <div
      className="min-h-screen bg-[var(--color-surface-bg)] flex items-center justify-center p-4"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="w-full max-w-md">
        <p className="sr-only">{title}</p>

        {/* Top brand — mirrors the sign-in card's brand header geometry */}
        <div className="flex items-center justify-center gap-3 mb-6" aria-hidden="true">
          <SkeletonCircle size={40} />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-2.5 w-24" />
          </div>
        </div>

        {/* Card — matches the sign-in card surface, padding and border */}
        <div className="bg-white dark:bg-[#1e1b18] rounded-2xl p-8 border border-[#e5e2dd] dark:border-[#3a3530] shadow-lg space-y-6" aria-hidden="true">
          <div className="text-center space-y-2.5">
            <Skeleton className="h-6 w-40 mx-auto" />
            <Skeleton className="h-3.5 w-56 mx-auto" />
          </div>

          {/* Compact form skeleton — two labeled fields matching input heights */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="h-11 w-full rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <Skeleton className="h-2.5 w-28" />
              <Skeleton className="h-11 w-full rounded-xl" />
            </div>
          </div>

          {/* Securely-working indicator */}
          <div className="flex items-center justify-center gap-2 text-[13px] font-semibold text-[var(--color-botanical-muted)]">
            <span
              className="w-4 h-4 border-2 border-[var(--color-botanical-muted)]/30 border-t-[var(--color-botanical-muted)] rounded-full animate-spin"
              aria-hidden="true"
            />
            <span>{subtitle}</span>
          </div>

          {/* Footer helper rows — keeps card height close to the real form */}
          <div className="pt-2 border-t border-[#e5e2dd] dark:border-[#3a3530] space-y-2.5">
            <Skeleton className="h-3 w-48 mx-auto" />
            <Skeleton className="h-2.5 w-36 mx-auto" />
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 text-[11px] text-[var(--color-botanical-subtle)] mt-6">
          <ShieldCheck className="w-4 h-4 text-[#5b6d54]" />
          <span>{title}</span>
        </div>
      </div>
    </div>
  );
}
