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
 */
export default function AdminRoute({ children }) {
  const { isAuthenticated, session } = useAdminSession();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  if (portalForSession(session) === 'staff') {
    return <Navigate to={staffPathFor(location.pathname) || '/staff/dashboard'} replace />;
  }

  return children;
}
