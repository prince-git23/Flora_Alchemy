import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAdminSession } from '../context/AdminSessionContext.jsx';
import OwnerAccessRequiredPage from '../pages/admin/OwnerAccessRequiredPage.jsx';

/**
 * Phase 20.6.2 — owner-route guard.
 *
 * Renders `children` only for an authenticated ADMIN session carrying the
 * owner designation; everyone else sees the Owner Access Required dossier
 * with their real attempted route and identity. This is NAVIGATION VISIBILITY
 * only — the backend's requireOwner middleware is the authority for every
 * owner-only capability (frontend visibility is UX, never security).
 *
 * With no children mounted yet (owner-only pages arrive with Phase 20.6.1),
 * an owner passing this guard is sent to the console dashboard instead of a
 * dead end.
 */
export default function OwnerRoute({ children }) {
  const { session } = useAdminSession();

  if (!session) {
    return <Navigate to="/admin/login" replace />;
  }

  const isOwner = session.role === 'admin' && session.isOwner === true;
  if (!isOwner) {
    return <OwnerAccessRequiredPage />;
  }

  return children ?? <Navigate to="/admin/dashboard" replace />;
}
