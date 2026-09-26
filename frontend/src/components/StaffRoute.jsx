import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAdminSession } from '../context/AdminSessionContext.jsx';
import { portalForSession, homePathForPortal } from '../services/authService.js';

/**
 * Phase 21.1 — Staff (handler) Portal guard for `/staff/*`.
 *
 * Only an authenticated handler session may pass. Anyone else is sent to their
 * own portal's home (an administrator or owner keep working in the Admin/Owner
 * portal; anonymous visitors get the Staff login). Frontend visibility is UX —
 * the backend is the authority for every handler-scoped request.
 */
export default function StaffRoute({ children }) {
  const { isAuthenticated, session } = useAdminSession();

  if (!isAuthenticated) {
    return <Navigate to="/staff/login" replace />;
  }

  const portal = portalForSession(session);
  if (portal !== 'staff') {
    return <Navigate to={homePathForPortal(portal || 'admin')} replace />;
  }

  return children;
}
