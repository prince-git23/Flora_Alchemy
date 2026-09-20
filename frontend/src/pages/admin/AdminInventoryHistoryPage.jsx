import React, { useState, useMemo } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getInventoryHistory } from '../../services/inventoryService.js';
import { formatDate } from '../../services/orderService.js';

export default function AdminInventoryHistoryPage() {
  const storeVersion = useStoreVersion();
  const [typeFilter, setTypeFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const history = useMemo(() => getInventoryHistory(), [storeVersion]);

  const filtered = useMemo(() => {
    let list = [...history];
    if (typeFilter !== 'all') list = list.filter(h => String(h.type || '').toLowerCase() === typeFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(h => h.product.toLowerCase().includes(q) || h.sku.toLowerCase().includes(q) || h.notes.toLowerCase().includes(q));
    }
    return list;
  }, [history, typeFilter, searchQuery]);

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[#180f0a] tracking-tight font-normal">Inventory History</h1>
            <p className="text-[14px] text-[#4e4540] mt-1">Complete log of stock movements, adjustments, and restocks</p>
          </div>
          <Link to="/admin/inventory" className="px-4 py-2 text-[12px] font-semibold text-[#180f0a] bg-white hover:bg-[#f6f3ee] border border-[#d1c4bd] rounded-full transition shadow-xs">
            ← Inventory
          </Link>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl border border-[#e5e2dd] p-3.5 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-[#80756f]">search</span>
              <input type="search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search by product, SKU, or notes..."
                className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg pl-9 pr-3 py-1.5 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
            </div>
            <div className="flex items-center gap-1.5">
              {[['all', 'All Types'], ['sale', 'Sale'], ['release', 'Release'], ['restock', 'Restock'], ['adjustment', 'Adjustment'], ['return', 'Return'], ['correction', 'Correction']].map(([value, label]) => (
                <button key={value} type="button" onClick={() => setTypeFilter(value)}
                  className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-all ${typeFilter === value ? 'bg-[#180f0a] text-white shadow-xs' : 'bg-[#f6f3ee] text-[#4e4540] hover:bg-[#ebe8e3]'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* History Table */}
        <div className="bg-white rounded-xl border border-[#e5e2dd] shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="bg-[#f6f3ee] border-b border-[#e5e2dd] text-[#80756f] font-semibold tracking-wide uppercase text-[11px]">
                  <th className="py-3 px-4 font-semibold">Date</th>
                  <th className="py-3 px-4 font-semibold">Type</th>
                  <th className="py-3 px-4 font-semibold">Product</th>
                  <th className="py-3 px-4 font-semibold">SKU</th>
                  <th className="py-3 px-4 font-semibold text-center">Qty Change</th>
                  <th className="py-3 px-4 font-semibold text-center">Stock After</th>
                  <th className="py-3 px-4 font-semibold">Reference</th>
                  <th className="py-3 px-4 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede9]">
                {filtered.map(h => (
                  <tr key={h.id} className="hover:bg-[#f6f3ee]/50 transition-colors">
                    <td className="py-3 px-4 text-[11px] text-[#80756f] whitespace-nowrap">{formatDate(h.date)}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${h.type === 'restock' ? 'bg-emerald-50 text-emerald-700' : h.type === 'adjustment' ? 'bg-amber-50 text-amber-800' : h.type === 'release' || h.type === 'return' ? 'bg-purple-50 text-purple-700' : 'bg-blue-50 text-blue-700'}`}>{h.type}</span>
                    </td>
                    <td className="py-3 px-4 font-medium text-[#180f0a] max-w-[200px] truncate">{h.product}</td>
                    <td className="py-3 px-4 text-[12px] font-mono text-[#80756f]">{h.sku}</td>
                    <td className="py-3 px-4 text-center">
                      <span className={`font-bold ${h.quantityChange > 0 ? 'text-[#5b6d54]' : 'text-[#964735]'}`}>{h.quantityChange > 0 ? '+' : ''}{h.quantityChange}</span>
                    </td>
                    <td className="py-3 px-4 text-center font-medium text-[#180f0a]">{h.stockAfter}</td>
                    <td className="py-3 px-4 text-[12px] font-mono text-[#80756f]">{h.reference || '—'}</td>
                    <td className="py-3 px-4 text-[12px] text-[#4e4540] max-w-[200px] truncate">{h.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-4 bg-[#f6f3ee] border-t border-[#e5e2dd] flex items-center justify-between text-[12px] text-[#80756f]">
            <span>Showing <strong className="text-[#180f0a]">{filtered.length}</strong> records</span>
            <span>Live data</span>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
