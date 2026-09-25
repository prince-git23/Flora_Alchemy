import React from 'react';
import { NavLink } from 'react-router-dom';

export default function AdminSettingsTabs({ activeTab }) {
  const tabs = [
    { id: 'general', label: 'General Settings', to: '/admin/settings' },
    { id: 'commerce', label: 'Order & Commerce', to: '/admin/settings/commerce' },
    { id: 'access', label: 'Admin & Handler Access', to: '/admin/access' },
    { id: 'notifications', label: 'Notifications & Alerts', to: '/admin/settings/notifications' },
    { id: 'preferences', label: 'Store Preferences', to: '/admin/store-preferences' },
  ];

  return (
    <nav 
      aria-label="Settings Navigation"
      className="flex items-center gap-1 overflow-x-auto pb-1 border-b border-[var(--color-botanical-border)] scrollbar-none"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <NavLink
            key={tab.id}
            to={tab.to}
            className={`shrink-0 inline-flex items-center min-h-[44px] px-4 py-2 rounded-xl text-[13px] font-semibold tracking-[0.01em] whitespace-nowrap transition-all ${
              isActive
                ? 'bg-[var(--color-btn)] text-white shadow-sm'
                : 'text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-high)] hover:text-[var(--color-botanical-text)]'
            }`}
          >
            {tab.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
