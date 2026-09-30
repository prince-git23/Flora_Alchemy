import React from 'react';
import { Link } from 'react-router-dom';
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
 * them: LOADING shows a content-shaped skeleton, ERROR shows a state that
 * matches WHY it failed, and ready renders the route. `status` only becomes
 * 'error' when a slice the CURRENT route genuinely depends on failed —
 * background hydration failures never reach this gate.
 *
 * Phase 22.x — an error is no longer rendered as one connection-outage screen.
 * Hydration failures carry the server's own `errorCode`/`errorStatus`, and
 * each class gets copy that is true for that class:
 *
 *   ACCOUNT_SUSPENDED → the account is suspended: say so, tell the user to
 *                       contact an administrator, drop the "temporary
 *                       connection problem" wording and do NOT offer Retry
 *                       (retrying cannot undo a suspension).
 *   FORBIDDEN / workspace refusals → an access decision, not an outage.
 *   NOT_FOUND         → the route/resource is gone.
 *   anything else     → genuine network/server failure, unchanged: the
 *                       existing message + Retry.
 */

/** Map a hydration failure code to the state the user should actually see. */
function errorKind(code, status) {
  switch (code) {
    case 'ACCOUNT_SUSPENDED':
      return 'suspended';
    case 'FORBIDDEN':
    // GRANULAR STAFF ACCESS — the permission middleware refuses a staff role
    // that lacks the permission for this resource with this code. It is an
    // access decision and must never be described as a connection problem.
    case 'PERMISSION_DENIED':
    case 'UNAUTHORIZED':
    case 'WORKSPACE_REQUIRED':
    case 'WORKSPACE_FORBIDDEN':
    case 'WORKSPACE_SUSPENDED':
    case 'WORKSPACE_MISMATCH':
      return 'forbidden';
    case 'NOT_FOUND':
    case 'PRODUCT_NOT_FOUND':
    case 'ORDER_NOT_FOUND':
    case 'SHOP_NOT_FOUND':
      return 'not-found';
    default:
      // NETWORK_ERROR (status 0), 5xx and anything unclassified stay on the
      // retryable connection/server state.
      void status;
      return 'connection';
  }
}

/** Shared shell so the four states stay visually consistent with the site. */
function ErrorFrame({ icon, emoji, title, message, note, children }) {
  return (
    <div className="min-h-[60vh] bg-[var(--color-surface-bg)] flex items-center justify-center px-6">
      <div className="max-w-md text-center space-y-4">
        {emoji ? (
          <p className="text-[40px]" aria-hidden="true">{emoji}</p>
        ) : (
          <span className="material-symbols-outlined text-[40px] text-[var(--color-botanical-subtle)]" aria-hidden="true">
            {icon}
          </span>
        )}
        <h1 className="font-serif text-[24px] text-[var(--color-botanical-text)]">{title}</h1>
        {message && (
          <p className="text-[14px] text-[var(--color-botanical-muted)]" role="alert">
            {message}
          </p>
        )}
        {note && <p className="text-[13px] text-[var(--color-botanical-subtle)]">{note}</p>}
        {children}
      </div>
    </div>
  );
}

const secondaryLink =
  'px-6 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[14px] font-semibold text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-container)] transition-colors';

const primaryLink =
  'px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[14px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors';

export default function RouteBootstrapGate({ children }) {
  const { status, error, errorStatus, errorCode, retry } = useData();

  if (status === 'loading') {
    return <BootstrapSkeleton variant="route" />;
  }

  if (status === 'error') {
    const kind = errorKind(errorCode, errorStatus);

    // ── Suspended account ────────────────────────────────────────────────
    // An access decision, not an outage. Retry is deliberately NOT offered:
    // it cannot restore access and would only re-run the failing request.
    if (kind === 'suspended') {
      return (
        <ErrorFrame
          icon="block"
          title="This account has been suspended"
          message={error}
          note="Contact an administrator to restore access. There is nothing wrong with your connection."
        >
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <Link to="/access" className={primaryLink}>
              Sign in with a different account
            </Link>
            <Link to="/" className={secondaryLink}>
              Return to the storefront
            </Link>
          </div>
        </ErrorFrame>
      );
    }

    // ── The server refused access ────────────────────────────────────────
    if (kind === 'forbidden') {
      return (
        <ErrorFrame
          icon="lock"
          title="You don’t have access to this area"
          message={error}
          note="The server declined this request for your account — this is an access decision, not a connection problem."
        >
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <Link to="/access" className={primaryLink}>
              Go to the portals
            </Link>
            <Link to="/" className={secondaryLink}>
              Return to the storefront
            </Link>
          </div>
        </ErrorFrame>
      );
    }

    // ── Route/resource is gone ───────────────────────────────────────────
    if (kind === 'not-found') {
      return (
        <ErrorFrame
          icon="search_off"
          title="We couldn’t find that page"
          message={error}
          note="The address may be wrong, or the page may have moved."
        >
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <Link to="/" className={primaryLink}>
              Back to the storefront
            </Link>
          </div>
        </ErrorFrame>
      );
    }

    // ── Genuine network / server failure — unchanged behaviour ───────────
    return (
      <ErrorFrame emoji="🌿" title="We couldn’t reach the studio server" message={error}>
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
          className={`${primaryLink} inline-block`}
        >
          Retry
        </button>
      </ErrorFrame>
    );
  }

  return children;
}
