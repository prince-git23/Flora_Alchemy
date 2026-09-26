import React from 'react';
import PortalLoginLayout from '../components/PortalLoginLayout.jsx';

/**
 * Phase 21.1 — Owner Portal login (/owner/login).
 *
 * Distinct route, distinct copy: this is the private proprietor gateway. It is
 * NOT a role selector — the portal is fixed by the URL, and the server refuses
 * any account that is not the owner (role admin + isOwner).
 */
export default function OwnerLoginPage() {
  return (
    <PortalLoginLayout
      portal="owner"
      icon="workspace_premium"
      eyebrow="Private Owner Portal"
      badge="Owner Access"
      title="Owner sign in"
      subtitle="This portal is restricted to the primary business proprietor."
      leftHeadline="Welcome back."
      leftBody="Manage the people, access and bespoke handcraft operations behind Flora Alchemy's boutique studio."
      doctrine="Owner credentials authenticate against the studio owner record. Session authority is re-checked from the database on every request."
    />
  );
}
