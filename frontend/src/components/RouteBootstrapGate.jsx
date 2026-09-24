import React from 'react';
import { useData } from '../context/DataContext.jsx';
import BootstrapSkeleton from './BootstrapSkeleton.jsx';

/**
 * Phase 20.5 — route content gate.
 *
 * Before this phase the WHOLE application (navbar, footer, theme, background
 * and the route) was withheld behind a full-screen BootstrapSkeleton until a
 * global hydration of products + collections + settings (+ profile + orders)
 * finished. The shell therefore looked like "the entire website is loading"
 * even though the route chunks were already lazy-loaded.
 *
 * The gate now wraps ONLY the route content, so:
 *
 *   shell (Navbar / PromoBar / Footer / theme / background)  → renders at once
 *   route content                                            → skeleton while
 *                                                              its own required
 *                                                              slices load
 *
 * `useData()` reports three honest states and this component distinguishes
 * them: LOADING shows a content-shaped skeleton, ERROR shows a retryable
 * message, and ready renders the route. `status` only becomes 'error' when a
 * slice the CURRENT route genuinely depends on failed — background hydration
 * failures never reach this gate.
 */
export default function RouteBootstrapGate({ children }) {
  const { status, error, retry } = useData();

  if (status === 'loading') {
    return <BootstrapSkeleton variant="route" />;
  }

  if (status === 'error') {
    return (
      <div className="min-h-[60vh] bg-[var(--color-surface-bg)] flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-4">
          <p className="text-[40px]" aria-hidden="true">🌿</p>
          <h1 className="font-serif text-[24px] text-[var(--color-botanical-text)]">
            We couldn’t reach the studio server
          </h1>
          <p className="text-[14px] text-[var(--color-botanical-muted)]" role="alert">{error}</p>
          {import.meta.env.DEV ? (
            <p className="text-[13px] text-[var(--color-botanical-subtle)]">
              Start the API server (see <code className="text-[var(--color-accent)]">.freebuff/run.md</code>) then retry.
            </p>
          ) : (
            <p className="text-[13px] text-[var(--color-botanical-subtle)]">
              This is usually a temporary connection problem — please try again in a moment.
            </p>
          )}
          <button
            type="button"
            onClick={retry}
            className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[14px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return children;
}
