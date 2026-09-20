import React from 'react';

/**
 * Flora Alchemy skeleton loading primitives.
 * All skeletons use a soft neutral shimmer that matches the brand aesthetic.
 * Respects prefers-reduced-motion — shimmer is disabled automatically.
 */

export function Skeleton({ className = '', style }) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-[#e5e2dd] dark:bg-[#2a2520] ${className}`}
      style={style}
      aria-hidden="true"
    >
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/25 dark:via-white/8 to-transparent" />
    </div>
  );
}

export function SkeletonText({ lines = 3, className = '' }) {
  return (
    <div className={`space-y-2.5 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-3.5 rounded-md"
          style={{ width: i === lines - 1 ? '60%' : '100%' }}
        />
      ))}
    </div>
  );
}

export function SkeletonCircle({ size = 40, className = '' }) {
  return (
    <Skeleton
      className={`rounded-full ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export function SkeletonCard({ className = '' }) {
  return (
    <div className={`bg-white dark:bg-[#1e1b18] rounded-xl border border-[#e5e2dd] dark:border-[#3a3530] overflow-hidden ${className}`} aria-hidden="true">
      <Skeleton className="w-full aspect-[4/3]" style={{ borderRadius: 0 }} />
      <div className="p-4 space-y-2.5">
        <Skeleton className="h-3 w-1/3 rounded-md" />
        <Skeleton className="h-4 w-3/4 rounded-md" />
        <Skeleton className="h-3.5 w-1/4 rounded-md" />
      </div>
    </div>
  );
}

export function SkeletonRow({ className = '' }) {
  return (
    <div className={`flex items-center gap-4 p-4 ${className}`} aria-hidden="true">
      <SkeletonCircle size={48} />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3 rounded-md" />
        <Skeleton className="h-3 w-1/2 rounded-md" />
      </div>
      <Skeleton className="h-8 w-20 rounded-full" />
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 5, className = '' }) {
  return (
    <div className={`bg-white dark:bg-[#1e1b18] rounded-xl border border-[#e5e2dd] dark:border-[#3a3530] overflow-hidden ${className}`} aria-hidden="true">
      {/* Header */}
      <div className="flex gap-4 px-4 py-3 bg-[#f6f3ee] dark:bg-[#252220] border-b border-[#e5e2dd] dark:border-[#3a3530]">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 rounded-md" style={{ width: `${100 / cols}%` }} />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="flex gap-4 px-4 py-3 border-b border-[#f0ede9] dark:border-[#2a2520] last:border-0">
          {Array.from({ length: cols }).map((_, col) => (
            <Skeleton key={col} className="h-3.5 rounded-md" style={{ width: `${100 / cols}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonHero({ className = '' }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl bg-[#e5e2dd] dark:bg-[#2a2520] ${className}`} aria-hidden="true">
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/25 dark:via-white/8 to-transparent" />
      <div className="flex flex-col items-center justify-center min-h-[200px] sm:min-h-[280px] gap-4 p-8">
        <Skeleton className="h-8 w-48 rounded-md" />
        <Skeleton className="h-4 w-64 rounded-md" />
        <Skeleton className="h-10 w-32 rounded-full" />
      </div>
    </div>
  );
}

/* Shimmer keyframe (injected once) */
if (typeof document !== 'undefined' && !document.getElementById('fa-skeleton-keyframes')) {
  const style = document.createElement('style');
  style.id = 'fa-skeleton-keyframes';
  style.textContent = `
    @keyframes shimmer {
      100% { transform: translateX(100%); }
    }
    @media (prefers-reduced-motion: reduce) {
      .animate-\\[shimmer_1\\.8s_ease-in-out_infinite\\] {
        animation: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}
