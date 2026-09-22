import React from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getInventory, getLowStockItems, getCriticalStockItems, adjustStock } from '../../services/inventoryService.js';
import { formatDate } from '../../services/orderService.js';

export default function AdminLowStockPage() {
  const lowItems = getLowStockItems();
  const criticalItems = getCriticalStockItems();
  const inventory = getInventory();
  const lowItemsOnly = inventory.filter(i => i.status === 'Low Stock');

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Low Stock Management</h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">Items requiring immediate attention or restocking</p>
          </div>
          <Link to="/admin/inventory" className="px-4 py-2 text-[12px] font-semibold text-[var(--color-botanical-primary)] bg-[var(--color-surface-lowest)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] rounded-full transition shadow-xs">
            Back to Inventory
          </Link>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-[var(--color-surface-lowest)] p-5 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-[20px] text-[var(--color-danger)]">error</span>
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Critical Stock ({criticalItems.length})</h2>
            </div>
            <p className="text-[13px] text-[var(--color-botanical-muted)] mb-3">Items below half the reorder level. Immediate restocking recommended.</p>
            {criticalItems.length === 0 ? (
              <p className="text-[13px] text-[var(--color-botanical-sage)] font-medium py-4 text-center">All items are above critical thresholds</p>
            ) : (
              <div className="space-y-2">
                {criticalItems.map(item => (
                  <div key={item.productId} className="flex items-center justify-between p-2.5 rounded-lg bg-[#fff5f5] border border-[#ffe0e0]">
                    <div>
                      <p className="text-[13px] font-medium text-[var(--color-botanical-primary)]">{item.productName}</p>
                      <p className="text-[11px] text-[var(--color-botanical-subtle)]">{item.sku}</p>
                    </div>
                    <div className="text-right">
                      <span className="text-[14px] font-bold text-[var(--color-danger)]">{item.currentStock}</span>
                      <p className="text-[10px] text-[var(--color-danger)]">of {item.reorderLevel} min</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-[var(--color-surface-lowest)] p-5 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-[20px] text-[var(--color-accent)]">warning</span>
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Low Stock ({lowItemsOnly.length})</h2>
            </div>
            <p className="text-[13px] text-[var(--color-botanical-muted)] mb-3">Items at or below the reorder level. Plan restocking soon.</p>
            {lowItemsOnly.length === 0 ? (
              <p className="text-[13px] text-[var(--color-botanical-sage)] font-medium py-4 text-center">No low stock items</p>
            ) : (
              <div className="space-y-2">
                {lowItemsOnly.map(item => (
                  <div key={item.productId} className="flex items-center justify-between p-2.5 rounded-lg bg-[#fff8f5] border border-[#ffdad3]">
                    <div>
                      <p className="text-[13px] font-medium text-[var(--color-botanical-primary)]">{item.productName}</p>
                      <p className="text-[11px] text-[var(--color-botanical-subtle)]">{item.sku}</p>
                    </div>
                    <div className="text-right">
                      <span className="text-[14px] font-bold text-[var(--color-accent)]">{item.currentStock}</span>
                      <p className="text-[10px] text-[var(--color-accent)]">of {item.reorderLevel} min</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Full Low Stock Table */}
        <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
          <div className="px-6 py-4 border-b border-[var(--color-botanical-border)]">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">All Low Stock Items</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="bg-[var(--color-surface-low)] border-b border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] font-semibold tracking-wide uppercase text-[11px]">
                  <th className="py-3 px-4 font-semibold">Product</th>
                  <th className="py-3 px-4 font-semibold">SKU</th>
                  <th className="py-3 px-4 font-semibold text-center">Current</th>
                  <th className="py-3 px-4 font-semibold text-center">Reorder</th>
                  <th className="py-3 px-4 font-semibold">Status</th>
                  <th className="py-3 px-4 font-semibold">Last Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-divider)]">
                {lowItems.map(item => (
                  <tr key={item.productId} className="hover:bg-[var(--color-surface-low)]/50 transition-colors">
                    <td className="py-3 px-4 font-medium text-[var(--color-botanical-primary)]">{item.productName}</td>
                    <td className="py-3 px-4 text-[12px] font-mono text-[var(--color-botanical-subtle)]">{item.sku}</td>
                    <td className="py-3 px-4 text-center font-bold text-[var(--color-accent)]">{item.currentStock}</td>
                    <td className="py-3 px-4 text-center text-[var(--color-botanical-subtle)]">{item.reorderLevel}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${item.status === 'Critical' ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300' : 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]'}`}>{item.status}</span>
                    </td>
                    <td className="py-3 px-4 text-[11px] text-[var(--color-botanical-subtle)]">{formatDate(item.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
