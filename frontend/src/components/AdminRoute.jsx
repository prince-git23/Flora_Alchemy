import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAdminSession } from '../context/AdminSessionContext.jsx';
import { portalForSession } from '../services/authService.js';

/**
 * Phase 21.1 — Administrator/Owner portal guard.
 *
 * `/admin/*` is the Administrator Portal. Authenticated administrators — and
 * the owner, who holds the administrator role — may use it. A handler session
 * is sent to the Staff Portal instead, because that is where their operational
 * navigation lives. This is NAVIGATION CONTROL only; the backend authorizes
 * every request regardless of which shell the browser is showing.
 */
export default function AdminRoute({ children }) {
  const { isAuthenticated, session } = useAdminSession();

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  if (portalForSession(session) === 'staff') {
    return <Navigate to="/staff/dashboard" replace />;
  }

  return children;
}
