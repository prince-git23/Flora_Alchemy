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
          <h1 className="font-serif text-3xl sm:text-4xl text-[#180f0a] tracking-tight font-normal">Product & Customer Performance</h1>
          <p className="text-[14px] text-[#4e4540] mt-1">Catalog performance and customer engagement metrics</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Total Revenue</span><span className="material-symbols-outlined text-[16px]">payments</span></div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{formatINR(totalRevenue)}</div>
          </div>
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Units Sold</span><span className="material-symbols-outlined text-[16px]">inventory</span></div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{totalUnits}</div>
          </div>
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Active Products</span><span className="material-symbols-outlined text-[16px] text-[#5b6d54]">inventory_2</span></div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{productPerformance.length}</div>
          </div>
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Top Customer Spend</span><span className="material-symbols-outlined text-[16px] text-[#964735]">trending_up</span></div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{customerPerformance.length > 0 ? formatINR(customerPerformance[0].totalSpend) : '₹0'}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Product Performance */}
          <div className="bg-white rounded-xl border border-[#e5e2dd] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[#180f0a] font-medium mb-4">Product Performance</h2>
            <div className="space-y-3">
              {productPerformance.map((p, idx) => (
                <div key={idx} className="flex items-center justify-between py-2.5 border-b border-[#f0ede9] last:border-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-6 h-6 rounded-full bg-[#f6f3ee] text-[#80756f] text-[11px] font-bold flex items-center justify-center shrink-0">{idx + 1}</span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-[#180f0a] truncate">{p.name}</p>
                      <p className="text-[11px] text-[#80756f]">{p.category} · {p.units} units · {p.orders} orders</p>
                    </div>
                  </div>
                  <span className="text-[13px] font-mono font-semibold text-[#180f0a] shrink-0 ml-2">{formatINR(p.revenue)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Customer Performance */}
          <div className="bg-white rounded-xl border border-[#e5e2dd] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[#180f0a] font-medium mb-4">Customer Performance</h2>
            <div className="space-y-3">
              {customerPerformance.slice(0, 8).map((c, idx) => (
                <div key={c.id} className="flex items-center justify-between py-2.5 border-b border-[#f0ede9] last:border-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-[#180f0a] text-white flex items-center justify-center text-[10px] font-semibold shrink-0">
                      {c.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-[#180f0a] truncate">{c.name}</p>
                      <p className="text-[11px] text-[#80756f]">{c.city} · {c.orderCount} orders</p>
                    </div>
                  </div>
                  <span className="text-[13px] font-mono font-semibold text-[#180f0a] shrink-0 ml-2">{formatINR(c.totalSpend)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="text-center text-[12px] text-[#80756f] pt-4">Live data · All metrics derived from MongoDB records</div>
      </div>
    </AdminLayout>
  );
}
