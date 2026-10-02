import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useData } from '../context/DataContext.jsx';
import { clearAllAuthState } from '../services/apiClient.js';
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
 *   PERMISSION_DENIED → the role is missing the permission this screen reads:
 *                       an access decision WITH a remedy, so it names the
 *                       remedy instead of a generic refusal.
 *   NOT_FOUND         → the route/resource is gone.
 *   anything else     → genuine network/server failure, unchanged: the
 *                       existing message + Retry.
 */

/** Map a hydration failure code to the state the user should actually see. */
function errorKind(code, status) {
  switch (code) {
    case 'ACCOUNT_SUSPENDED':
      return 'suspended';
    // The CUSTOMER profile was deactivated (`Customer.status: 'Inactive'`).
    // Deliberately a DIFFERENT state from ACCOUNT_SUSPENDED: the operator
    // lifecycle and the storefront-profile lifecycle are separate systems and
    // tell the visitor different things.
    case 'ACCOUNT_INACTIVE':
      return 'inactive';
    // GRANULAR STAFF ACCESS — the permission middleware refuses a staff role
    // that lacks the permission for THIS resource with its own code. It is a
    // distinct class: a workspace/role refusal (FORBIDDEN) says "this area is
    // not yours", while PERMISSION_DENIED says "this area is yours, but your
    // perfect bundle does not carry the permission it reads" — and only the
    // second one has a concrete remedy an administrator can apply. Collapsing
    // them into one screen would tell the staff member the wrong thing.
    case 'PERMISSION_DENIED':
      return 'permission';
    case 'FORBIDDEN':
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
  const { status, error, errorStatus, errorCode, errorScope, retry } = useData();
  const navigate = useNavigate();

  if (status === 'loading') {
    return <BootstrapSkeleton variant="route" />;
  }

  if (status === 'error') {
    const kind = errorKind(errorCode, errorStatus);

    // ── Account-state screens share ONE "start over" action ──────────────
    // Starting over must actually END the current session.
    //
    // This used to be a bare <Link to="/access">: it navigated but left the
    // token and the session markers in place, so the very next hydration
    // re-presented the same refused identity (the screen came straight back),
    // and a refused CUSTOMER was dropped on the STAFF portal gateway. Clearing
    // is strictly LOCAL — no account is deleted and no server-side status is
    // touched, so it can never "fix" a suspension or a deactivation.
    const startOver = () => {
      clearAllAuthState();
      // Staff/Handler → the portal gateway; refused staff must never be sent to
      // the customer-only login. Customer/unknown → the customer login.
      navigate(errorScope === 'staff' ? '/access' : '/login', { replace: true });
    };
    const browseAsGuest = () => {
      // The public storefront needs no session — but it cannot load while a
      // refused token is still attached to the hydration requests. Drop the
      // dead session so the storefront loads as the guest it really is.
      clearAllAuthState();
      navigate('/', { replace: true });
    };

    // ── Suspended operator account ───────────────────────────────────────
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
            <button type="button" onClick={startOver} className={`${primaryLink} inline-block`}>
              Sign in with a different account
            </button>
            <button type="button" onClick={browseAsGuest} className={`${secondaryLink} inline-block`}>
              Return to the storefront
            </button>
          </div>
        </ErrorFrame>
      );
    }

    // ── Deactivated CUSTOMER profile ─────────────────────────────────────
    // Customer.status was set to 'Inactive' on the business profile. Distinct
    // from a suspension: this is the storefront account state, and the remedy
    // is a support/administrator action on the customer record.
    if (kind === 'inactive') {
      return (
        <ErrorFrame
          icon="person_off"
          title="This account has been deactivated"
          message={error}
          note="This is an access decision, not a connection problem — retrying cannot reactivate the account."
        >
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <button type="button" onClick={startOver} className={`${primaryLink} inline-block`}>
              Sign in with a different account
            </button>
            <button type="button" onClick={browseAsGuest} className={`${secondaryLink} inline-block`}>
              Return to the storefront
            </button>
          </div>
        </ErrorFrame>
      );
    }

    // ── The role is missing the permission this screen reads ─────────────
    if (kind === 'permission') {
      return (
        <ErrorFrame
          icon="lock"
          title="Your staff role doesn’t include this permission"
          message={error}
          note="This is an access decision, not a connection problem — retrying cannot grant a permission. An administrator can grant it under Team → Staff → Access & Role."
        >
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <Link to="/staff/dashboard" className={primaryLink}>
              Back to Dashboard
            </Link>
            <Link to="/access" className={secondaryLink}>
              Go to the portals
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
