import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAdminSession } from '../context/AdminSessionContext.jsx';
import { portalForSession, staffPathFor } from '../services/authService.js';

/**
 * Phase 21.1 — Administrator/Owner portal guard.
 *
 * `/admin/*` is the Administrator Portal. Authenticated administrators — and
 * the owner, who holds the administrator role — may use it. A handler session
 * is sent to the Staff Portal: operational surfaces map to their /staff/*
 * counterpart (one page behind two portal URLs — see staffPathFor), and
 * governance surfaces (staff members, invitations, access, settings, owner
 * pages) fall back to /staff/dashboard. This is NAVIGATION CONTROL only; the
 * backend authorizes every request regardless of which shell the browser is
 * showing.
 *
 * Phase 22.3 — the OWNER is redirected off operational surfaces (§18): the
 * owner is a platform identity, never a workspace member, so orders/products/
 * customers/analytics and friends now return 403 WORKSPACE_REQUIRED from the
 * server. The shell moves them to the Owner Console instead of rendering a
 * page that can only fail; governance surfaces (settings, staff, invitations,
 * access) remain reachable because the server keeps the owner on those (§19).
 */
const OWNER_OPERATIONAL_PREFIXES = [
  '/admin/orders',
  '/admin/products',
  '/admin/collections',
  '/admin/customers',
  '/admin/conversations',
  '/admin/custom-requests',
  '/admin/inventory',
  '/admin/analytics',
];

export default function AdminRoute({ children }) {
  const { isAuthenticated, session } = useAdminSession();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  if (portalForSession(session) === 'staff') {
    return <Navigate to={staffPathFor(location.pathname) || '/staff/dashboard'} replace />;
  }

  if (
    portalForSession(session) === 'owner' &&
    OWNER_OPERATIONAL_PREFIXES.some(
      (prefix) => location.pathname === prefix || location.pathname.startsWith(`${prefix}/`)
    )
  ) {
    return <Navigate to="/owner/dashboard" replace />;
  }

  return children;
}
