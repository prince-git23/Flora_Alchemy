import React, { useState, useMemo, useCallback } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { Link, useSearchParams } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import InventoryHistoryView, { movementBadgeClass } from '../../components/admin/InventoryHistoryView.jsx';
import { getInventory, adjustStock, getInventoryHistory } from '../../services/inventoryService.js';
import { formatDate } from '../../services/orderService.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'low', label: 'Low Stock' },
  { id: 'products', label: 'Stock by Product' },
  { id: 'history', label: 'History' },
];
const TAB_IDS = TABS.map((t) => t.id);

export default function AdminInventoryPage() {
  const storeVersion = useStoreVersion();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab = TAB_IDS.includes(rawTab) ? rawTab : 'overview';

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [expandedRow, setExpandedRow] = useState(null);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustType, setAdjustType] = useState('restock');
  const [adjustReason, setAdjustReason] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [toast, setToast] = useState(null);

  const inventory = useMemo(() => getInventory(), [storeVersion]);
  const history = useMemo(() => getInventoryHistory(), [storeVersion]);

  const totalProducts = inventory.length;
  const inStock = inventory.filter(i => i.status === 'In Stock').length;
  const lowStock = inventory.filter(i => i.status === 'Low Stock').length;
  const outOfStock = inventory.filter(i => i.status === 'Critical' || i.status === 'Out of Stock').length;
  const totalUnits = inventory.reduce((s, i) => s + i.currentStock, 0);

  // Everything at or below its reorder level, most urgent first — the
  // "Needs attention" set behind the Low Stock tab (search-independent on
  // Overview so a stale query never hides alerts).
  const attentionBase = useMemo(
    () => inventory.filter(i => i.status !== 'In Stock').sort((a, b) => a.currentStock - b.currentStock),
    [inventory]
  );

  const matchesSearch = useCallback((i, q) => {
    if (!q) return true;
    return i.productName.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q);
  }, []);

  const productsList = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return inventory.filter(i => matchesSearch(i, q)).filter(i => statusFilter === 'all' || i.status === statusFilter);
  }, [statusFilter, searchQuery, inventory, matchesSearch]);

  const attentionList = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return attentionBase.filter(i => matchesSearch(i, q));
  }, [attentionBase, searchQuery, matchesSearch]);

  const setTab = useCallback((id) => {
    setExpandedRow(null);
    if (id === 'overview') setSearchParams({}, { replace: true });
    else setSearchParams({ tab: id }, { replace: true });
  }, [setSearchParams]);

  const triggerToast = useCallback((msg, isError = false) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleQuickAdjust = useCallback(async (item) => {
    if (!adjustQty || Number(adjustQty) <= 0) return;
    setSavingId(item.productId);
    try {
      const qty = Number(adjustQty);
      await adjustStock(item.productId, qty, adjustType, `Quick adjust: ${adjustType} ${qty} — ${adjustReason || 'No reason given'}`);
      triggerToast(`${item.productName}: ${adjustType === 'restock' ? '+' : '−'}${qty} units saved`);
      setExpandedRow(null);
      setAdjustQty('');
      setAdjustReason('');
    } catch (err) {
      triggerToast(err.message || 'Adjustment failed', true);
    } finally {
      setSavingId(null);
    }
  }, [adjustQty, adjustType, adjustReason, triggerToast]);

  const startAdjust = (productId) => {
    setExpandedRow(expandedRow === productId ? null : productId);
    setAdjustQty('');
    setAdjustType('restock');
    setAdjustReason('');
  };

  const adjustFromOverview = (productId) => {
    setTab('low');
    setExpandedRow(productId);
    setAdjustQty('');
    setAdjustType('restock');
    setAdjustReason('');
  };

  const clearFilters = () => {
    setStatusFilter('all');
    setSearchQuery('');
  };

  const statusBadge = (item) => (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${item.status === 'In Stock' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : item.status === 'Critical' || item.status === 'Out of Stock' ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300' : 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]'}`}>
      {item.status}
    </span>
  );

  const stockColor = (item) => (
    item.currentStock <= 0 ? 'text-[var(--color-danger)]'
      : item.currentStock <= item.reorderLevel / 2 ? 'text-[var(--color-danger)]'
        : item.currentStock <= item.reorderLevel ? 'text-[var(--color-accent)]'
          : 'text-[var(--color-botanical-primary)]'
  );

  const renderTableSection = (list, tab) => {
    if (list.length === 0) {
      const healthy = tab === 'low' && attentionBase.length === 0 && !searchQuery.trim();
      return (
        <div className="p-10 sm:p-14 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-3 shadow-xs border border-[var(--color-botanical-border)]">
          <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-[var(--color-botanical-subtle)]">
            <span className="material-symbols-outlined text-[28px]">{healthy ? 'check_circle' : 'inventory_2'}</span>
          </div>
          <h3 className="font-serif text-xl text-[var(--color-botanical-primary)] font-medium">
            {healthy ? 'All stock levels healthy' : 'No matching inventory'}
          </h3>
          <p className="text-[13px] text-[var(--color-botanical-muted)]">
            {healthy ? 'Nothing is at or below its reorder level right now.' : 'Try a different search or filter.'}
          </p>
          {!healthy && (searchQuery.trim() || statusFilter !== 'all') && (
            <button type="button" onClick={clearFilters} className="px-4 py-1.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover-alt)] transition">Clear Filters</button>
          )}
        </div>
      );
    }
    return (
      <>
        {/* Desktop Table */}
        <div className="hidden md:block bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="bg-[var(--color-surface-low)] border-b border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] font-semibold tracking-wide uppercase text-[11px]">
                  <th className="py-2.5 px-4 font-semibold">Product</th>
                  <th className="py-2.5 px-4 font-semibold">SKU</th>
                  <th className="py-2.5 px-4 font-semibold text-center">Stock</th>
                  <th className="py-2.5 px-4 font-semibold text-center">Reorder</th>
                  <th className="py-2.5 px-4 font-semibold">Status</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-divider)] text-[var(--color-botanical-text)]">
                {list.map(item => (
                  <React.Fragment key={item.productId}>
                    <tr className={`hover:bg-[var(--color-surface-low)]/50 transition-colors ${expandedRow === item.productId ? 'bg-[var(--color-surface-low)]/30' : ''}`}>
                      <td className="py-2.5 px-4 font-medium text-[var(--color-botanical-primary)] max-w-[200px] truncate">{item.productName}</td>
                      <td className="py-2.5 px-4 text-[11px] font-mono text-[var(--color-botanical-subtle)]">{item.sku}</td>
                      <td className="py-2.5 px-4 text-center">
                        <span className={`font-bold text-[14px] ${stockColor(item)}`}>{item.currentStock}</span>
                      </td>
                      <td className="py-2.5 px-4 text-center text-[var(--color-botanical-subtle)]">{item.reorderLevel}</td>
                      <td className="py-2.5 px-4">{statusBadge(item)}</td>
                      <td className="py-2.5 px-4 text-right">
                        <button type="button" onClick={() => startAdjust(item.productId)}
                          className={`px-3 py-1 text-[11px] font-semibold rounded-full transition ${expandedRow === item.productId ? 'bg-[var(--color-btn)] text-white' : 'text-[var(--color-botanical-primary)] bg-[var(--color-surface-low)] hover:bg-[var(--color-surface-high)] border border-[var(--color-botanical-border)]'}`}>
                          {expandedRow === item.productId ? 'Close' : 'Adjust'}
                        </button>
                      </td>
                    </tr>
                    {expandedRow === item.productId && (
                      <tr>
                        <td colSpan={6} className="px-4 py-3 bg-[var(--color-surface-low)] border-b border-[var(--color-botanical-border)]">
                          <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3 max-w-2xl">
                            <div className="flex-1 min-w-0">
                              <label className="block text-[11px] font-semibold text-[var(--color-botanical-muted)] mb-1">Type</label>
                              <div className="flex gap-1.5">
                                <button type="button" onClick={() => setAdjustType('restock')}
                                  className={`flex-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border transition ${adjustType === 'restock' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 border-emerald-300' : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-low)]'}`}>
                                  + Add
                                </button>
                                <button type="button" onClick={() => setAdjustType('remove')}
                                  className={`flex-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border transition ${adjustType === 'remove' ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] border-[var(--color-badge-bg)]' : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-low)]'}`}>
                                  − Remove
                                </button>
                              </div>
                            </div>
                            <div className="w-full sm:w-24">
                              <label className="block text-[11px] font-semibold text-[var(--color-botanical-muted)] mb-1">Qty</label>
                              <input type="number" min="1" value={adjustQty} onChange={e => setAdjustQty(e.target.value)} placeholder="0"
                                className="w-full text-[13px] bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-2.5 py-1.5 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <label className="block text-[11px] font-semibold text-[var(--color-botanical-muted)] mb-1">Reason</label>
                              <input type="text" value={adjustReason} onChange={e => setAdjustReason(e.target.value)} placeholder="Optional note"
                                className="w-full text-[12px] bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-2.5 py-1.5 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
                            </div>
                            <button type="button" onClick={() => handleQuickAdjust(item)} disabled={!adjustQty || Number(adjustQty) <= 0 || savingId === item.productId}
                              className="px-4 py-1.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover-alt)] transition shadow-xs disabled:opacity-40 disabled:cursor-not-allowed shrink-0 flex items-center gap-1.5">
                              {savingId === item.productId && (
                                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true" />
                              )}
                              {savingId === item.productId ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-5 py-3 bg-[var(--color-surface-low)] border-t border-[var(--color-botanical-border)] flex items-center justify-between text-[11px] text-[var(--color-botanical-subtle)]">
            <span>Showing <strong className="text-[var(--color-botanical-primary)]">{list.length}</strong> products</span>
            <span>Backend-authoritative</span>
          </div>
        </div>

        {/* Mobile Cards */}
        <div className="md:hidden space-y-2.5">
          {list.map(item => (
            <div key={item.productId} className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
              <div className="p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[13px] font-semibold text-[var(--color-botanical-primary)] truncate">{item.productName}</h3>
                    <p className="text-[11px] text-[var(--color-botanical-subtle)] font-mono mt-0.5">{item.sku}</p>
                  </div>
                  {statusBadge(item)}
                </div>
                <div className="flex items-center justify-between mt-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`text-[20px] font-serif font-medium ${stockColor(item)}`}>{item.currentStock}</span>
                    <span className="text-[11px] text-[var(--color-botanical-subtle)]">/ {item.reorderLevel} min</span>
                  </div>
                  <button type="button" onClick={() => startAdjust(item.productId)}
                    className={`px-3 py-1.5 text-[11px] font-semibold rounded-full transition ${expandedRow === item.productId ? 'bg-[var(--color-btn)] text-white' : 'text-[var(--color-botanical-primary)] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)]'}`}>
                    {expandedRow === item.productId ? 'Close' : 'Adjust'}
                  </button>
                </div>
              </div>
              {expandedRow === item.productId && (
                <div className="px-3.5 pb-3.5 pt-0 border-t border-[var(--color-botanical-border-light)] space-y-2.5">
                  <div className="flex gap-1.5 pt-2.5">
                    <button type="button" onClick={() => setAdjustType('restock')}
                      className={`flex-1 px-2.5 py-2 rounded-lg text-[12px] font-semibold border transition ${adjustType === 'restock' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 border-emerald-300' : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)]'}`}>
                      + Add Stock
                    </button>
                    <button type="button" onClick={() => setAdjustType('remove')}
                      className={`flex-1 px-2.5 py-2 rounded-lg text-[12px] font-semibold border transition ${adjustType === 'remove' ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] border-[var(--color-badge-bg)]' : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)]'}`}>
                      − Remove
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <input type="number" min="1" value={adjustQty} onChange={e => setAdjustQty(e.target.value)} placeholder="Qty"
                      className="flex-1 text-[13px] bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
                    <input type="text" value={adjustReason} onChange={e => setAdjustReason(e.target.value)} placeholder="Reason"
                      className="flex-1 text-[12px] bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
                  </div>
                  <button type="button" onClick={() => handleQuickAdjust(item)} disabled={!adjustQty || Number(adjustQty) <= 0 || savingId === item.productId}
                    className="w-full px-4 py-2 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover-alt)] transition shadow-xs disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5">
                    {savingId === item.productId && (
                      <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true" />
                    )}
                    {savingId === item.productId ? 'Saving…' : 'Save Adjustment'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="hidden md:block text-center text-[11px] text-[var(--color-botanical-subtle)]">
          Backend-authoritative — all adjustments persist to MongoDB
        </div>
      </>
    );
  };

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-5 pb-12">
        {/* Header + Tabs */}
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h1 className="font-serif text-2xl sm:text-3xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Inventory</h1>
              <p className="text-[13px] text-[var(--color-botanical-muted)] mt-0.5">Stock levels, adjustments, and movement history</p>
            </div>
            <Link to="/admin/inventory/history" className="px-4 py-2 text-[12px] font-semibold text-[var(--color-botanical-primary)] bg-[var(--color-surface-lowest)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] rounded-full transition shadow-xs shrink-0 self-start sm:self-auto">
              Full History
            </Link>
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label="Inventory views">
            {TABS.map(t => (
              <button key={t.id} type="button" role="tab" aria-selected={activeTab === t.id} onClick={() => setTab(t.id)}
                className={`px-3.5 py-1.5 rounded-full text-[12px] font-semibold whitespace-nowrap transition-all ${activeTab === t.id ? 'bg-[var(--color-btn)] text-white shadow-xs' : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] border border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-low)]'}`}>
                {t.label}
                {t.id === 'low' && attentionBase.length > 0 ? ` (${attentionBase.length})` : ''}
              </button>
            ))}
          </div>
        </div>

        {activeTab === 'overview' && (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-[var(--color-surface-lowest)] p-3.5 sm:p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
                <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1"><span className="text-[10px] sm:text-[11px] uppercase tracking-wider font-semibold">Total</span><span className="material-symbols-outlined text-[15px]">inventory_2</span></div>
                <div className="text-2xl sm:text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{totalProducts}</div>
                <p className="text-[10px] sm:text-[11px] text-[var(--color-botanical-subtle)] mt-1.5">{totalUnits.toLocaleString()} units</p>
              </div>
              <div className="bg-[var(--color-surface-lowest)] p-3.5 sm:p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
                <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1"><span className="text-[10px] sm:text-[11px] uppercase tracking-wider font-semibold">In Stock</span><span className="material-symbols-outlined text-[15px] text-[var(--color-botanical-sage)]">check_circle</span></div>
                <div className="text-2xl sm:text-3xl font-serif font-medium text-[var(--color-botanical-sage)] leading-none">{inStock}</div>
              </div>
              <div className="bg-[var(--color-surface-lowest)] p-3.5 sm:p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
                <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1"><span className="text-[10px] sm:text-[11px] uppercase tracking-wider font-semibold">Low Stock</span><span className="material-symbols-outlined text-[15px] text-[var(--color-accent)]">warning</span></div>
                <div className="text-2xl sm:text-3xl font-serif font-medium text-[var(--color-accent)] leading-none">{lowStock}</div>
              </div>
              <div className="bg-[var(--color-surface-lowest)] p-3.5 sm:p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
                <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1"><span className="text-[10px] sm:text-[11px] uppercase tracking-wider font-semibold">Out / Critical</span><span className="material-symbols-outlined text-[15px] text-[var(--color-danger)]">error</span></div>
                <div className="text-2xl sm:text-3xl font-serif font-medium text-[var(--color-danger)] leading-none">{outOfStock}</div>
              </div>
            </div>

            <div className="grid lg:grid-cols-2 gap-3">
              {/* Needs attention */}
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--color-botanical-border)]">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px] text-[var(--color-accent)]">warning</span>
                    <h2 className="font-serif text-[15px] text-[var(--color-botanical-primary)] font-medium">Needs Attention</h2>
                    {attentionBase.length > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]">{attentionBase.length}</span>
                    )}
                  </div>
                  {attentionBase.length > 0 && (
                    <button type="button" onClick={() => setTab('low')} className="text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:underline px-2 -mx-2 py-1 min-h-[24px]">View all →</button>
                  )}
                </div>
                {attentionBase.length === 0 ? (
                  <div className="px-5 py-8 text-center space-y-1.5">
                    <span className="material-symbols-outlined text-[26px] text-[var(--color-botanical-sage)]">check_circle</span>
                    <p className="text-[13px] text-[var(--color-botanical-primary)] font-medium">All stock levels healthy</p>
                    <p className="text-[12px] text-[var(--color-botanical-muted)]">Nothing is at or below its reorder level.</p>
                  </div>
                ) : (
                  attentionBase.slice(0, 6).map(item => (
                    <div key={item.productId} className="flex items-center gap-3 px-5 py-2.5 border-b border-[var(--color-divider)] last:border-0">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-[var(--color-botanical-primary)] truncate">{item.productName}</p>
                        <p className="text-[10px] text-[var(--color-botanical-subtle)] font-mono">{item.sku}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className={`text-[15px] font-serif font-medium ${stockColor(item)}`}>{item.currentStock}</span>
                        <span className="text-[10px] text-[var(--color-botanical-subtle)]"> / {item.reorderLevel}</span>
                      </div>
                      <div className="shrink-0">{statusBadge(item)}</div>
                      <button type="button" onClick={() => adjustFromOverview(item.productId)}
                        className="px-3 py-1 text-[11px] font-semibold rounded-full text-[var(--color-botanical-primary)] bg-[var(--color-surface-low)] hover:bg-[var(--color-surface-high)] border border-[var(--color-botanical-border)] transition shrink-0">
                        Adjust
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Recent movements */}
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--color-botanical-border)]">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px] text-[var(--color-botanical-subtle)]">history</span>
                    <h2 className="font-serif text-[15px] text-[var(--color-botanical-primary)] font-medium">Recent Movements</h2>
                    <span className="text-[11px] text-[var(--color-botanical-subtle)]">({history.length})</span>
                  </div>
                  <button type="button" onClick={() => setTab('history')} className="text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:underline px-2 -mx-2 py-1 min-h-[24px]">View all →</button>
                </div>
                {history.length === 0 ? (
                  <div className="px-5 py-8 text-center space-y-1.5">
                    <span className="material-symbols-outlined text-[26px] text-[var(--color-botanical-subtle)]">history</span>
                    <p className="text-[13px] text-[var(--color-botanical-muted)]">No stock movements recorded yet.</p>
                  </div>
                ) : (
                  history.slice(0, 6).map(h => (
                    <div key={h.id} className="flex items-center gap-3 px-5 py-2.5 border-b border-[var(--color-divider)] last:border-0">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold capitalize shrink-0 ${movementBadgeClass(String(h.type || '').toLowerCase())}`}>{h.type}</span>
                      <span className="text-[13px] text-[var(--color-botanical-text)] truncate flex-1 min-w-0">{h.product}</span>
                      <span className={`text-[13px] font-bold shrink-0 ${h.quantityChange > 0 ? 'text-[var(--color-botanical-sage)]' : 'text-[var(--color-accent)]'}`}>{h.quantityChange > 0 ? '+' : ''}{h.quantityChange}</span>
                      <span className="text-[11px] text-[var(--color-botanical-subtle)] shrink-0 hidden sm:block">{formatDate(h.date)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}

        {activeTab === 'low' && (
          <>
            {/* Search (status chips live on the Stock by Product tab) */}
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-3 shadow-xs">
              <div className="relative max-w-md">
                <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-[var(--color-botanical-subtle)]">search</span>
                <input type="search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search product or SKU..."
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg pl-8 pr-3 py-1.5 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
            </div>
            {renderTableSection(attentionList, 'low')}
          </>
        )}

        {activeTab === 'products' && (
          <>
            {/* Filter Bar */}
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-3 shadow-xs">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                <div className="relative flex-1 min-w-0">
                  <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-[var(--color-botanical-subtle)]">search</span>
                  <input type="search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search product or SKU..."
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg pl-8 pr-3 py-1.5 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
                </div>
                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 sm:pb-0">
                  {['all', 'In Stock', 'Low Stock', 'Critical', 'Out of Stock'].map(s => (
                    <button key={s} type="button" onClick={() => setStatusFilter(s)}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-all ${statusFilter === s ? 'bg-[var(--color-btn)] text-white shadow-xs' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-high)]'}`}>
                      {s === 'all' ? 'All' : s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {renderTableSection(productsList, 'products')}
          </>
        )}

        {activeTab === 'history' && <InventoryHistoryView />}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-5 py-3 rounded-full shadow-2xl ${toast.isError ? 'bg-[#ba1a1a] text-white' : 'bg-[var(--color-btn)] text-white'}`}>
          <span className={`w-2 h-2 rounded-full ${toast.isError ? 'bg-[var(--color-surface-lowest)]' : 'bg-[#964735]'}`}></span>
          <span className="text-[13px] font-medium">{toast.msg}</span>
        </div>
      )}
    </AdminLayout>
  );
}
