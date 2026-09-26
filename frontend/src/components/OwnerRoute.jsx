import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAdminSession } from '../context/AdminSessionContext.jsx';
import { portalForSession } from '../services/authService.js';
import OwnerAccessRequiredPage from '../pages/admin/OwnerAccessRequiredPage.jsx';

/**
 * Phase 21.1 — Owner Portal guard for `/owner/*`.
 *
 * Renders `children` only for an authenticated session whose server-derived
 * portal is 'owner' (role admin + isOwner). Everyone else sees the Owner Access
 * Required dossier with their real attempted route and identity. This is
 * NAVIGATION VISIBILITY only — the backend's requireOwner middleware is the
 * authority for every owner-only capability.
 */
export default function OwnerRoute({ children }) {
  const { session } = useAdminSession();

  if (!session) {
    return <Navigate to="/owner/login" replace />;
  }

  if (portalForSession(session) !== 'owner') {
    return <OwnerAccessRequiredPage />;
  }

  return children ?? <Navigate to="/owner/dashboard" replace />;
}
