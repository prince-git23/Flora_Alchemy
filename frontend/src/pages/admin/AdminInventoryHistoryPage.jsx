import React from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import InventoryHistoryView from '../../components/admin/InventoryHistoryView.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import { portalForSession, staffPathFor } from '../../services/authService.js';

export default function AdminInventoryHistoryPage() {
  const { session } = useAdminSession();
  const portal = portalForSession(session);
  const inventoryHref = (portal === 'staff' && staffPathFor('/admin/inventory')) || '/admin/inventory';
  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Inventory History</h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">Complete log of stock movements, adjustments, and restocks</p>
          </div>
          <Link to={inventoryHref} className="px-4 py-2 text-[12px] font-semibold text-[var(--color-botanical-primary)] bg-[var(--color-surface-lowest)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] rounded-full transition shadow-xs">
            ← Inventory
          </Link>
        </div>
        <InventoryHistoryView />
      </div>
    </AdminLayout>
  );
}
