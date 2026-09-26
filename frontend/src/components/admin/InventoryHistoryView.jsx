import React, { useState, useMemo } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { getInventoryHistory } from '../../services/inventoryService.js';
import { formatDate } from '../../services/orderService.js';

const TYPE_FILTERS = [
  ['all', 'All Types'],
  ['sale', 'Sale'],
  ['release', 'Release'],
  ['restock', 'Restock'],
  ['adjustment', 'Adjustment'],
  ['return', 'Return'],
  ['correction', 'Correction'],
  ['correction-down', 'Correction Down'],
];

export function movementBadgeClass(type) {
  if (type === 'restock') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300';
  if (type === 'adjustment' || type === 'correction-down') return 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300';
  if (type === 'release' || type === 'return') return 'bg-purple-50 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300';
  return 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300';
}

/**
 * Complete stock-movement log — shared by the Inventory History page
 * (/admin/inventory/history, /staff/inventory/history) and the History tab
 * of the Inventory workspace. Columns: Date, Product, Movement, Quantity,
 * Reason, Order, Performed By (plus SKU / Stock After for context).
 */
export default function InventoryHistoryView() {
  const storeVersion = useStoreVersion();
  const [typeFilter, setTypeFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const history = useMemo(() => getInventoryHistory(), [storeVersion]);

  const filtered = useMemo(() => {
    let list = [...history];
    if (typeFilter !== 'all') list = list.filter(h => String(h.type || '').toLowerCase() === typeFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(h =>
        h.product.toLowerCase().includes(q) ||
        h.sku.toLowerCase().includes(q) ||
        h.notes.toLowerCase().includes(q) ||
        String(h.reference || '').toLowerCase().includes(q) ||
        String(h.performedBy || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [history, typeFilter, searchQuery]);

  return (
    <>
      {/* Filters */}
      <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-3.5 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-[var(--color-botanical-subtle)]">search</span>
            <input type="search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search by product, SKU, order, notes..."
              className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg pl-9 pr-3 py-1.5 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {TYPE_FILTERS.map(([value, label]) => (
              <button key={value} type="button" onClick={() => setTypeFilter(value)}
                className={`px-3 py-1.5 rounded-full text-[12px] font-medium whitespace-nowrap transition-all ${typeFilter === value ? 'bg-[var(--color-btn)] text-white shadow-xs' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-high)]'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* History Table */}
      <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-[13px]">
            <thead>
              <tr className="bg-[var(--color-surface-low)] border-b border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] font-semibold tracking-wide uppercase text-[11px]">
                <th className="py-3 px-4 font-semibold">Date</th>
                <th className="py-3 px-4 font-semibold">Product</th>
                <th className="py-3 px-4 font-semibold">Movement</th>
                <th className="py-3 px-4 font-semibold">SKU</th>
                <th className="py-3 px-4 font-semibold text-center">Qty Change</th>
                <th className="py-3 px-4 font-semibold text-center">Stock After</th>
                <th className="py-3 px-4 font-semibold">Reason</th>
                <th className="py-3 px-4 font-semibold">Order</th>
                <th className="py-3 px-4 font-semibold">Performed By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-divider)]">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-[13px] text-[var(--color-botanical-muted)]">No movements match this filter.</td>
                </tr>
              ) : (
                filtered.map(h => (
                  <tr key={h.id} className="hover:bg-[var(--color-surface-low)]/50 transition-colors">
                    <td className="py-3 px-4 text-[11px] text-[var(--color-botanical-subtle)] whitespace-nowrap">{formatDate(h.date)}</td>
                    <td className="py-3 px-4 font-medium text-[var(--color-botanical-primary)] max-w-[200px] truncate">{h.product}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${movementBadgeClass(String(h.type || '').toLowerCase())}`}>{h.type}</span>
                    </td>
                    <td className="py-3 px-4 text-[12px] font-mono text-[var(--color-botanical-subtle)]">{h.sku}</td>
                    <td className="py-3 px-4 text-center">
                      <span className={`font-bold ${h.quantityChange > 0 ? 'text-[var(--color-botanical-sage)]' : 'text-[var(--color-accent)]'}`}>{h.quantityChange > 0 ? '+' : ''}{h.quantityChange}</span>
                    </td>
                    <td className="py-3 px-4 text-center font-medium text-[var(--color-botanical-primary)]">{h.stockAfter}</td>
                    <td className="py-3 px-4 text-[12px] text-[var(--color-botanical-muted)] max-w-[200px] truncate" title={h.notes}>{h.notes || '—'}</td>
                    <td className="py-3 px-4 text-[12px] font-mono text-[var(--color-botanical-subtle)] whitespace-nowrap">{h.reference || '—'}</td>
                    <td className="py-3 px-4 text-[12px] text-[var(--color-botanical-text)] max-w-[140px] truncate" title={h.performedBy}>{h.performedBy || 'system'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-4 bg-[var(--color-surface-low)] border-t border-[var(--color-botanical-border)] flex items-center justify-between text-[12px] text-[var(--color-botanical-subtle)]">
          <span>Showing <strong className="text-[var(--color-botanical-primary)]">{filtered.length}</strong> records</span>
          <span>Live data</span>
        </div>
      </div>
    </>
  );
}
