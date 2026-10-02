import React from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAdminSession } from '../context/AdminSessionContext.jsx';
import { portalForSession, homePathForPortal } from '../services/authService.js';
import { sessionHasPermission } from '../services/staffAccessService.js';
import { requiredStaffPermissions } from '../services/staffRouteAccess.js';

/**
 * Phase 21.1 — Staff (handler) Portal guard for `/staff/*`.
 *
 * Only an authenticated handler session may pass. Anyone else is sent to their
 * own portal's home (an administrator or owner keep working in the Admin/Owner
 * portal; anonymous visitors get the Staff login). Frontend visibility is UX —
 * the backend is the authority for every handler-scoped request.
 *
 * GRANULAR STAFF ACCESS — this guard now also refuses a DIRECT navigation to a
 * staff resource the session holds no permission for. The sidebar already hides
 * such links, but the sidebar is not in the path of a typed URL, a deep link or
 * a bookmark, so the route used to mount anyway and render an empty
 * "No Customers Found" (a slice the plan had deliberately not hydrated) or a 403
 * frame inside a page that should never have opened. The map lives in
 * services/staffRouteAccess.js and mirrors the server's requirePermission calls.
 *
 * This gate makes NO request and never weakens authorization: the server still
 * re-reads the account from the database and answers 403 PERMISSION_DENIED on
 * every gated endpoint, whatever the client renders. A session whose permission
 * list is unknown (an older session, or a legacy full-workspace handler) is NOT
 * filtered here — the server stays the only authority, exactly as the backend's
 * own `effectivePermissions` treats an absent array.
 */
export default function StaffRoute({ children }) {
  const { isAuthenticated, session } = useAdminSession();
  const { pathname } = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/staff/login" replace />;
  }

  const portal = portalForSession(session);
  if (portal !== 'staff') {
    return <Navigate to={homePathForPortal(portal || 'admin')} replace />;
  }

  const required = requiredStaffPermissions(pathname);
  const allowed =
    !required || required.any.length === 0 || required.any.some((id) => sessionHasPermission(session, id));

  if (!allowed) {
    return <StaffAccessRefusal label={required.label} permission={required.any[0]} />;
  }

  return children;
}

/**
 * The honest state for a staff route the role does not hold.
 *
 * Deliberately NOT the generic connection/error frame: nothing failed, nothing
 * was unreachable, and Retry cannot grant a permission. It names the missing
 * permission and the surface an administrator changes it on, so the staff
 * member knows this is an access decision.
 */
function StaffAccessRefusal({ label, permission }) {
  return (
    <div className="min-h-screen bg-[var(--color-surface-bg)] flex items-center justify-center px-6">
      <div className="max-w-md text-center space-y-4">
        <span
          className="material-symbols-outlined text-[40px] text-[var(--color-botanical-subtle)]"
          aria-hidden="true"
        >
          lock
        </span>
        <h1 className="font-serif text-[24px] text-[var(--color-botanical-text)]">
          You don’t have access to {label || 'this area'}
        </h1>
        <p className="text-[14px] text-[var(--color-botanical-muted)]" role="alert">
          Your staff role doesn’t include the{' '}
          <code className="text-[var(--color-accent)]">{permission}</code> permission, which is what this
          screen reads.
        </p>
        <p className="text-[13px] text-[var(--color-botanical-subtle)]">
          This is an access decision, not a connection problem — the server refused it for your account and
          retrying cannot change it. An administrator can grant the permission under Team → Staff → Access
          &amp; Role.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <Link
            to="/staff/dashboard"
            className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[14px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
          >
            Back to Dashboard
          </Link>
          <Link
            to="/access"
            className="px-6 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[14px] font-semibold text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-container)] transition-colors"
          >
            Go to the portals
          </Link>
        </div>
      </div>
    </div>
  );
}
