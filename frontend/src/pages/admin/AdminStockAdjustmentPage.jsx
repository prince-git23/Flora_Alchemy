import React, { useState } from 'react';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getInventory, adjustStock, getInventoryHistory } from '../../services/inventoryService.js';
import { formatINR, formatDate } from '../../services/orderService.js';

export default function AdminStockAdjustmentPage() {
  const [selectedProduct, setSelectedProduct] = useState('');
  const [adjustmentType, setAdjustmentType] = useState('add');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [toastMessage, setToastMessage] = useState(null);

  const [recentAdjustments, setRecentAdjustments] = useState(() => getInventoryHistory());

  const inventory = getInventory();
  const triggerToast = (msg) => { setToastMessage(msg); setTimeout(() => setToastMessage(null), 3000); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedProduct || !quantity || !reason) return;
    const qty = adjustmentType === 'add' ? Math.abs(parseInt(quantity)) : -Math.abs(parseInt(quantity));
    try {
      await adjustStock(selectedProduct, qty, adjustmentType === 'add' ? 'restock' : 'remove', reason);
      setRecentAdjustments(getInventoryHistory());
      triggerToast(`Stock adjustment saved to the backend: ${adjustmentType === 'add' ? '+' : ''}${qty} units`);
      setSelectedProduct(''); setQuantity(''); setReason('');
    } catch (err) {
      triggerToast(err.message || 'Stock adjustment failed.');
    }
  };

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div>
          <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Stock Adjustment</h1>
          <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">Add, remove, or adjust inventory stock levels</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Adjustment Form */}
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">New Adjustment</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Product</label>
                <select value={selectedProduct} onChange={e => setSelectedProduct(e.target.value)} className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-xl px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition">
                  <option value="">Select a product...</option>
                  {inventory.map(i => <option key={i.productId} value={i.productId}>{i.productName} (Stock: {i.currentStock})</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Adjustment Type</label>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAdjustmentType('add')} className={`flex-1 px-3 py-2 rounded-xl text-[13px] font-semibold border transition ${adjustmentType === 'add' ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)] hover:bg-[#ebe8e3]'}`}>
                    <span className="material-symbols-outlined text-[16px] align-middle mr-1">add</span> Addition
                  </button>
                  <button type="button" onClick={() => setAdjustmentType('subtract')} className={`flex-1 px-3 py-2 rounded-xl text-[13px] font-semibold border transition ${adjustmentType === 'subtract' ? 'bg-[#ffdad3] text-[#783020] border-[#edd1cc]' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)] hover:bg-[#ebe8e3]'}`}>
                    <span className="material-symbols-outlined text-[16px] align-middle mr-1">remove</span> Subtraction
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Quantity</label>
                <input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-xl px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition" placeholder="Enter quantity" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Reason</label>
                <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-xl px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition resize-none" placeholder="Describe the reason for this adjustment..." />
              </div>
              <button type="submit" className="w-full px-5 py-2.5 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold hover:bg-[#2e241e] transition shadow-sm">
                Submit Adjustment
              </button>
            </form>
          </div>

          {/* Recent Adjustments */}
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Recent Adjustments</h2>
            <div className="divide-y divide-[#f0ede9]">
              {recentAdjustments.slice(0, 10).map(adj => (
                <div key={adj.id} className="py-3 flex items-start gap-3">
                  <span className={`material-symbols-outlined text-[18px] mt-0.5 ${adj.type === 'Addition' || adj.type === 'Restock' ? 'text-[#5b6d54]' : 'text-[#964735]'}`}>
                    {adj.type === 'Addition' || adj.type === 'Restock' ? 'add_circle' : 'remove_circle'}
                  </span>
                  <div className="flex-1">
                    <p className="text-[13px] font-medium text-[var(--color-botanical-primary)]">{adj.product}</p>
                    <p className="text-[12px] text-[var(--color-botanical-muted)]">{adj.notes || adj.reason || ''}</p>
                    <div className="flex items-center gap-3 mt-1 text-[11px] text-[var(--color-botanical-subtle)]">
                      <span>{formatDate(adj.date)}</span>
                      <span className={`font-bold ${(adj.quantityChange || 0) >= 0 ? 'text-[#5b6d54]' : 'text-[#964735]'}`}>{(adj.quantityChange || 0) >= 0 ? '+' : ''}{adj.quantityChange || adj.quantity || 0} units</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {toastMessage && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 bg-[#180f0a] text-white px-5 py-3 rounded-full shadow-2xl">
            <span className="w-2 h-2 rounded-full bg-[#964735]"></span>
            <span className="text-[13px] font-medium">{toastMessage}</span>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
