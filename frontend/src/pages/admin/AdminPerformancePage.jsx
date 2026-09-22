import React, { useMemo } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getOrders, formatINR } from '../../services/orderService.js';
import { getCustomers } from '../../services/customerService.js';
import { getProducts } from '../../services/productService.js';
import { isRevenue } from '../../services/analyticsService.js';

export default function AdminPerformancePage() {
  const storeVersion = useStoreVersion();
  const orders = useMemo(() => getOrders(), [storeVersion]);
  const customers = useMemo(() => getCustomers(), [storeVersion]);
  const products = useMemo(() => getProducts(), [storeVersion]);

  const productPerformance = useMemo(() => {
    const revenueOrders = orders.filter(isRevenue);
    const perf = {};
    revenueOrders.forEach(order => {
      order.items.forEach(item => {
        const pid = item.productSlug || item.id;
        if (!perf[pid]) {
          const p = products.find(pr => pr.id === pid);
          perf[pid] = { name: item.name, category: p?.categoryLabel || p?.category || 'Other', revenue: 0, units: 0, orders: 0 };
        }
        perf[pid].revenue += item.price * item.quantity;
        perf[pid].units += item.quantity;
        perf[pid].orders++;
      });
    });
    return Object.values(perf).sort((a, b) => b.revenue - a.revenue);
  }, [orders, products]);

  const customerPerformance = useMemo(() => {
    const revenueOrders = orders.filter(isRevenue);
    return customers.map(c => {
      const co = revenueOrders.filter(o => o.customerId === c.id);
      return { ...c, orderCount: co.length, totalSpend: co.reduce((s, o) => s + o.total, 0) };
    }).sort((a, b) => b.totalSpend - a.totalSpend);
  }, [customers, orders]);

  const totalRevenue = productPerformance.reduce((s, p) => s + p.revenue, 0);
  const totalUnits = productPerformance.reduce((s, p) => s + p.units, 0);

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div>
          <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Product & Customer Performance</h1>
          <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">Catalog performance and customer engagement metrics</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Total Revenue</span><span className="material-symbols-outlined text-[16px]">payments</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{formatINR(totalRevenue)}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Units Sold</span><span className="material-symbols-outlined text-[16px]">inventory</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{totalUnits}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Active Products</span><span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-sage)]">inventory_2</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{productPerformance.length}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Top Customer Spend</span><span className="material-symbols-outlined text-[16px] text-[var(--color-accent)]">trending_up</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{customerPerformance.length > 0 ? formatINR(customerPerformance[0].totalSpend) : '₹0'}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Product Performance */}
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Product Performance</h2>
            <div className="space-y-3">
              {productPerformance.map((p, idx) => (
                <div key={idx} className="flex items-center justify-between py-2.5 border-b border-[var(--color-botanical-border-light)] last:border-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-6 h-6 rounded-full bg-[var(--color-surface-low)] text-[var(--color-botanical-subtle)] text-[11px] font-bold flex items-center justify-center shrink-0">{idx + 1}</span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-[var(--color-botanical-primary)] truncate">{p.name}</p>
                      <p className="text-[11px] text-[var(--color-botanical-subtle)]">{p.category} · {p.units} units · {p.orders} orders</p>
                    </div>
                  </div>
                  <span className="text-[13px] font-mono font-semibold text-[var(--color-botanical-primary)] shrink-0 ml-2">{formatINR(p.revenue)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Customer Performance */}
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Customer Performance</h2>
            <div className="space-y-3">
              {customerPerformance.slice(0, 8).map((c, idx) => (
                <div key={c.id} className="flex items-center justify-between py-2.5 border-b border-[var(--color-botanical-border-light)] last:border-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-[var(--color-btn)] text-white flex items-center justify-center text-[10px] font-semibold shrink-0">
                      {c.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-[var(--color-botanical-primary)] truncate">{c.name}</p>
                      <p className="text-[11px] text-[var(--color-botanical-subtle)]">{c.city} · {c.orderCount} orders</p>
                    </div>
                  </div>
                  <span className="text-[13px] font-mono font-semibold text-[var(--color-botanical-primary)] shrink-0 ml-2">{formatINR(c.totalSpend)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="text-center text-[12px] text-[var(--color-botanical-subtle)] pt-4">Live data · All metrics derived from MongoDB records</div>
      </div>
    </AdminLayout>
  );
}
