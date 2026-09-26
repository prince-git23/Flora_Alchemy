import React from 'react';
import PortalLoginLayout from '../components/PortalLoginLayout.jsx';

/**
 * Phase 21.1 — Staff Portal login (/staff/login).
 *
 * The handler gateway. Signed-in handlers land on their operational workspace;
 * administrators and owners are refused here (their surfaces live in the Admin
 * and Owner portals), and a customer can never enter.
 */
export default function StaffLoginPage() {
  return (
    <PortalLoginLayout
      portal="staff"
      icon="assignment"
      eyebrow="Staff Portal"
      badge="Staff Access"
      title="Staff sign in"
      subtitle="Handlers sign in to their assigned operational work."
      leftHeadline="Your workbench is ready."
      leftBody="Craft assignments, fulfilment queues and material tasks, delivered to the artisan who owns them."
      doctrine="Handler accounts are created only by an administrator invitation. Your assigned work and permissions are resolved server-side."
    />
  );
}
