import React, { useState, useMemo, useCallback } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getInventory, adjustStock, getInventoryHistory } from '../../services/inventoryService.js';
import { formatINR, formatDate } from '../../services/orderService.js';
import { getProducts } from '../../services/productService.js';

export default function AdminInventoryPage() {
  const storeVersion = useStoreVersion();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [expandedRow, setExpandedRow] = useState(null);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustType, setAdjustType] = useState('restock');
  const [adjustReason, setAdjustReason] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [toast, setToast] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historySearch, setHistorySearch] = useState('');

  const inventory = useMemo(() => getInventory(), [storeVersion]);
  const history = useMemo(() => getInventoryHistory(), [storeVersion]);
  const productCategories = useMemo(() => {
    const map = {};
    getProducts().forEach((p) => { map[p.id] = p.categoryLabel || p.category || ''; });
    return map;
  }, []);

  const totalProducts = inventory.length;
  const inStock = inventory.filter(i => i.status === 'In Stock').length;
  const lowStock = inventory.filter(i => i.status === 'Low Stock').length;
  const outOfStock = inventory.filter(i => i.status === 'Critical' || i.status === 'Out of Stock').length;
  const totalUnits = inventory.reduce((s, i) => s + i.currentStock, 0);

  const filtered = useMemo(() => {
    let list = [...inventory];
    if (statusFilter !== 'all') {
      list = list.filter(i => i.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(i => i.productName.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q));
    }
    return list;
  }, [statusFilter, searchQuery, inventory]);

  const filteredHistory = useMemo(() => {
    let list = [...history];
    if (historySearch.trim()) {
      const q = historySearch.toLowerCase();
      list = list.filter(h => h.product.toLowerCase().includes(q) || h.sku.toLowerCase().includes(q) || h.notes.toLowerCase().includes(q));
    }
    return list;
  }, [history, historySearch]);

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

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-5 pb-12">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="font-serif text-2xl sm:text-3xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Inventory</h1>
            <p className="text-[13px] text-[var(--color-botanical-muted)] mt-0.5">Stock levels, adjustments, and movement history</p>
          </div>
          <Link to="/admin/inventory/history" className="px-4 py-2 text-[12px] font-semibold text-[var(--color-botanical-primary)] bg-[var(--color-surface-lowest)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] rounded-full transition shadow-xs shrink-0">
            Full History
          </Link>
        </div>

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

        {/* Inventory List */}
        {filtered.length === 0 ? (
          <div className="p-10 sm:p-14 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-3 shadow-xs border border-[var(--color-botanical-border)]">
            <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-[var(--color-botanical-subtle)]">
              <span className="material-symbols-outlined text-[28px]">inventory_2</span>
            </div>
            <h3 className="font-serif text-xl text-[var(--color-botanical-primary)] font-medium">No matching inventory</h3>
            <p className="text-[13px] text-[var(--color-botanical-muted)]">Try a different search or filter.</p>
            <button type="button" onClick={() => { setStatusFilter('all'); setSearchQuery(''); }} className="px-4 py-1.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover-alt)] transition">Clear Filters</button>
          </div>
        ) : (
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
                    {filtered.map(item => (
                      <React.Fragment key={item.productId}>
                        <tr className={`hover:bg-[var(--color-surface-low)]/50 transition-colors ${expandedRow === item.productId ? 'bg-[var(--color-surface-low)]/30' : ''}`}>
                          <td className="py-2.5 px-4 font-medium text-[var(--color-botanical-primary)] max-w-[200px] truncate">{item.productName}</td>
                          <td className="py-2.5 px-4 text-[11px] font-mono text-[var(--color-botanical-subtle)]">{item.sku}</td>
                          <td className="py-2.5 px-4 text-center">
                            <span className={`font-bold text-[14px] ${item.currentStock <= 0 ? 'text-[var(--color-danger)]' : item.currentStock <= item.reorderLevel / 2 ? 'text-[var(--color-danger)]' : item.currentStock <= item.reorderLevel ? 'text-[var(--color-accent)]' : 'text-[var(--color-botanical-primary)]'}`}>
                              {item.currentStock}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-center text-[var(--color-botanical-subtle)]">{item.reorderLevel}</td>
                          <td className="py-2.5 px-4">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${item.status === 'In Stock' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : item.status === 'Critical' || item.status === 'Out of Stock' ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300' : 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]'}`}>
                              {item.status === 'Critical' || item.status === 'Out of Stock' ? item.status : item.status}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            <button type="button" onClick={() => { setExpandedRow(expandedRow === item.productId ? null : item.productId); setAdjustQty(''); setAdjustType('restock'); setAdjustReason(''); }}
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
                <span>Showing <strong className="text-[var(--color-botanical-primary)]">{filtered.length}</strong> products</span>
                <span>Backend-authoritative</span>
              </div>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden space-y-2.5">
              {filtered.map(item => (
                <div key={item.productId} className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
                  <div className="p-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[13px] font-semibold text-[var(--color-botanical-primary)] truncate">{item.productName}</h3>
                        <p className="text-[11px] text-[var(--color-botanical-subtle)] font-mono mt-0.5">{item.sku}</p>
                      </div>
                      <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${item.status === 'In Stock' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : item.status === 'Critical' || item.status === 'Out of Stock' ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300' : 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]'}`}>
                        {item.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-2.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-[20px] font-serif font-medium ${item.currentStock <= 0 ? 'text-[var(--color-danger)]' : item.currentStock <= item.reorderLevel / 2 ? 'text-[var(--color-danger)]' : item.currentStock <= item.reorderLevel ? 'text-[var(--color-accent)]' : 'text-[var(--color-botanical-primary)]'}`}>
                          {item.currentStock}
                        </span>
                        <span className="text-[11px] text-[var(--color-botanical-subtle)]">/ {item.reorderLevel} min</span>
                      </div>
                      <button type="button" onClick={() => { setExpandedRow(expandedRow === item.productId ? null : item.productId); setAdjustQty(''); setAdjustType('restock'); setAdjustReason(''); }}
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

            {/* Footer */}
            <div className="hidden md:block text-center text-[11px] text-[var(--color-botanical-subtle)]">
              Backend-authoritative — all adjustments persist to MongoDB
            </div>
          </>
        )}

        {/* Recent History Section */}
        <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
          <button type="button" onClick={() => setShowHistory(!showHistory)}
            className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-[var(--color-surface-low)]/50 transition-colors">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-[var(--color-botanical-subtle)]">history</span>
              <h2 className="font-serif text-[15px] text-[var(--color-botanical-primary)] font-medium">Recent Movements</h2>
              <span className="text-[11px] text-[var(--color-botanical-subtle)]">({filteredHistory.length})</span>
            </div>
            <span className={`material-symbols-outlined text-[18px] text-[var(--color-botanical-subtle)] transition-transform ${showHistory ? 'rotate-180' : ''}`}>expand_more</span>
          </button>
          {showHistory && (
            <div className="border-t border-[var(--color-botanical-border)]">
              <div className="px-5 py-2.5 bg-[var(--color-surface-low)]">
                <div className="relative max-w-sm">
                  <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] text-[var(--color-botanical-subtle)]">search</span>
                  <input type="search" value={historySearch} onChange={e => setHistorySearch(e.target.value)} placeholder="Search history..."
                    className="w-full text-[12px] bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg pl-8 pr-3 py-1.5 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
                </div>
              </div>
              <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
                <table className="w-full text-left border-collapse text-[12px]">
                  <thead className="sticky top-0 bg-[var(--color-surface-lowest)]">
                    <tr className="border-b border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] font-semibold uppercase text-[10px]">
                      <th className="py-2 px-4 font-semibold">Date</th>
                      <th className="py-2 px-4 font-semibold">Type</th>
                      <th className="py-2 px-4 font-semibold">Product</th>
                      <th className="py-2 px-4 font-semibold text-center">Change</th>
                      <th className="py-2 px-4 font-semibold text-center">Stock After</th>
                      <th className="py-2 px-4 font-semibold hidden sm:table-cell">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-divider)]">
                    {filteredHistory.slice(0, 20).map(h => (
                      <tr key={h.id} className="hover:bg-[var(--color-surface-low)]/30">
                        <td className="py-2 px-4 text-[11px] text-[var(--color-botanical-subtle)] whitespace-nowrap">{formatDate(h.date)}</td>
                        <td className="py-2 px-4">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold capitalize ${h.type === 'restock' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : h.type === 'release' || h.type === 'return' ? 'bg-purple-50 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300' : h.type === 'sale' ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'}`}>{h.type}</span>
                        </td>
                        <td className="py-2 px-4 font-medium text-[var(--color-botanical-primary)] max-w-[160px] truncate">{h.product}</td>
                        <td className="py-2 px-4 text-center">
                          <span className={`font-bold ${h.quantityChange > 0 ? 'text-[var(--color-botanical-sage)]' : 'text-[var(--color-accent)]'}`}>{h.quantityChange > 0 ? '+' : ''}{h.quantityChange}</span>
                        </td>
                        <td className="py-2 px-4 text-center font-medium text-[var(--color-botanical-primary)]">{h.stockAfter}</td>
                        <td className="py-2 px-4 text-[11px] text-[var(--color-botanical-muted)] max-w-[150px] truncate hidden sm:table-cell">{h.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredHistory.length > 20 && (
                <div className="px-5 py-2.5 bg-[var(--color-surface-low)] border-t border-[var(--color-botanical-border)] text-center">
                  <Link to="/admin/inventory/history" className="text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:underline">View all {filteredHistory.length} records →</Link>
                </div>
              )}
            </div>
          )}
        </div>
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
