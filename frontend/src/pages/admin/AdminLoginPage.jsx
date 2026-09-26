import React from 'react';
import PortalLoginLayout from '../../components/PortalLoginLayout.jsx';

/**
 * Phase 21.1 — Administrator Portal login (/admin/login).
 *
 * Rewritten from the Phase 20.6.2 "Staff Sign In" to share one login surface
 * with the Owner and Staff portals. The behaviour is unchanged and still
 * single-path: one POST /api/auth/login, server-resolved role, no role
 * selector. The portal is fixed by the URL and the server refuses a handler
 * or a customer here.
 */
export default function AdminLoginPage() {
  return (
    <PortalLoginLayout
      portal="admin"
      icon="admin_panel_settings"
      eyebrow="Administrator Portal"
      badge="Administrator Access"
      title="Administrator sign in"
      subtitle="Approved administrators manage staff, stock and daily operations."
      leftHeadline="Run the atelier with disciplined stewardship."
      leftBody="Handlers execute, administrators oversee, the owner safeguards — one operations console, role-scoped by the server."
      doctrine="Administrator accounts are created only through owner approval and a one-time invitation. Access is re-checked from the database on every request."
    />
  );
}
