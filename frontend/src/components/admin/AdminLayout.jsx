import React, { useState } from 'react';
import AdminSidebar from './AdminSidebar.jsx';
import AdminHeader from './AdminHeader.jsx';

export default function AdminLayout({ children }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[var(--color-surface-bg)] text-[var(--color-botanical-text)] flex flex-col relative overflow-x-hidden">
      {/* Ambient page depth */}
      <div className="fixed top-0 right-0 w-[500px] h-[300px] rounded-full bg-[var(--color-badge-bg)]/6 blur-3xl pointer-events-none z-0 dark:bg-[#964735]/4" />
      {/* Sidebar (Desktop Persistent + Mobile Drawer) */}
      <AdminSidebar
        isOpen={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
      />

      {/* Main Container pushed right by sidebar on desktop */}
      <div className="md:pl-[260px] flex-1 flex flex-col min-h-screen">
        {/* Top Header */}
        <AdminHeader onOpenMobileMenu={() => setMobileMenuOpen(true)} />

        {/* Scrollable Page Content */}
        <main className="flex-1 w-full px-4 sm:px-6 lg:px-8 py-6 relative">
          {children}
        </main>

        {/* Admin Operational Footer */}
        <footer className="w-full bg-[var(--color-surface-low)] border-t border-[var(--color-botanical-border)] py-3 px-4 sm:px-8 mt-auto select-none dark:bg-[#1e1b18] dark:border-[#3a3530]">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[var(--color-botanical-subtle)] text-[12px] dark:text-[#8a8078]">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#964735]"></span>
              Flora Alchemy Handler Operations Portal • Operations Console
            </span>
            <span>All prices settled in Indian Rupee (INR · ₹)</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
