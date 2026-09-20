import React, { useState, useMemo } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getOrders, formatINR, formatDate } from '../../services/orderService.js';
import { getAnalyticsSummary, getRevenueByPeriod } from '../../services/analyticsService.js';

export default function AdminSalesRevenuePage() {
  const storeVersion = useStoreVersion();
  const [period, setPeriod] = useState('30d');
  const summary = useMemo(() => getAnalyticsSummary(), [storeVersion]);
  const orders = useMemo(() => getOrders(), [storeVersion]);

  // Revenue only counts Paid (verified) + legacy Sample orders — mirrors the
  // backend revenue rule. Pending / Failed / Refunded are never revenue.
  const revenueOrders = useMemo(
    () => orders.filter(o => ['Paid', 'Sample'].includes(o.paymentStatus)),
    [orders]
  );

  // Build revenue bars from real revenue orders (no synthetic filler values).
  const revenueBars = useMemo(() => {
    const now = new Date();
    const bars = [];
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().split('T')[0];
      const dayRevenue = revenueOrders
        .filter(o => String(o.createdAt || '').split('T')[0] === dayStr)
        .reduce((s, o) => s + (o.total || 0), 0);
      bars.push({ label: dayLabels[d.getDay() === 0 ? 6 : d.getDay() - 1], value: dayRevenue });
    }
    return bars;
  }, [revenueOrders]);

  const maxBar = Math.max(1, ...revenueBars.map(b => b.value));

  // Monthly revenue derived from real revenue orders (last 3 months).
  const monthlyData = useMemo(() => {
    const now = new Date();
    const months = [];
    for (let i = 2; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const monthOrders = revenueOrders.filter(o => String(o.createdAt || '').startsWith(monthKey));
      const revenue = monthOrders.reduce((s, o) => s + (o.total || 0), 0);
      months.push({
        month: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
        revenue,
        orders: monthOrders.length,
        aov: monthOrders.length ? Math.round(revenue / monthOrders.length) : 0,
      });
    }
    return months;
  }, [revenueOrders]);

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[#180f0a] tracking-tight font-normal">Sales & Revenue</h1>
            <p className="text-[14px] text-[#4e4540] mt-1">Revenue trends, order value analysis, and financial metrics</p>
          </div>
          <div className="flex items-center p-1 rounded-full bg-[#ebe8e3] text-[12px]">
            {['7d', '30d', '3m'].map(p => (
              <button key={p} type="button" onClick={() => setPeriod(p)}
                className={`px-3 py-1 rounded-full font-semibold transition-all ${period === p ? 'bg-white shadow-xs text-[#180f0a]' : 'text-[#4e4540]'}`}>
                {p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : '3 Months'}
              </button>
            ))}
          </div>
        </div>

        {/* Revenue Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Total Revenue</span><span className="material-symbols-outlined text-[16px]">payments</span></div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{formatINR(summary.totalRevenue)}</div>
          </div>
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">AOV</span><span className="material-symbols-outlined text-[16px] text-[#964735]">trending_up</span></div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{formatINR(summary.aov)}</div>
          </div>
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Orders</span><span className="material-symbols-outlined text-[16px]">shopping_bag</span></div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{summary.totalOrders}</div>
          </div>
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Delivered</span><span className="material-symbols-outlined text-[16px] text-[#5b6d54]">check_circle</span></div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{summary.deliveredOrders}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Revenue Chart */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-[#e5e2dd] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[#180f0a] font-medium mb-4">Daily Revenue</h2>
            <div className="h-48 w-full flex items-end justify-between gap-2 px-1 border-b border-[#f0ede9] pb-2">
              {revenueBars.map((bar, idx) => (
                <div key={idx} className="flex-1 flex flex-col items-center gap-2 h-full justify-end group">
                  <div className="w-full max-w-[40px] rounded-t bg-[#ebe8e3] group-hover:bg-[#d1c4bd] transition-all relative"
                    style={{ height: `${maxBar > 0 ? (bar.value / maxBar) * 100 : 0}%` }}>
                    <div className="absolute -top-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-[#180f0a] text-white text-[9px] font-bold whitespace-nowrap shadow-sm opacity-0 group-hover:opacity-100 transition-opacity">
                      {formatINR(bar.value)}
                    </div>
                  </div>
                  <span className="text-[10px] font-bold text-[#80756f]">{bar.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Monthly Breakdown */}
          <div className="bg-white rounded-xl border border-[#e5e2dd] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[#180f0a] font-medium mb-4">Monthly Breakdown</h2>
            <div className="space-y-4">
              {monthlyData.map((m, idx) => (
                <div key={idx} className="p-3 bg-[#f6f3ee] rounded-xl">
                  <p className="text-[13px] font-semibold text-[#180f0a]">{m.month}</p>
                  <div className="flex items-center justify-between mt-2 text-[12px]">
                    <span className="text-[#80756f]">Revenue</span>
                    <span className="font-bold text-[#180f0a]">{formatINR(m.revenue)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[12px] mt-1">
                    <span className="text-[#80756f]">Orders</span>
                    <span className="font-medium text-[#4e4540]">{m.orders}</span>
                  </div>
                  <div className="flex items-center justify-between text-[12px] mt-1">
                    <span className="text-[#80756f]">AOV</span>
                    <span className="font-medium text-[#4e4540]">{formatINR(m.aov)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Order Value Distribution */}
        <div className="bg-white rounded-xl border border-[#e5e2dd] p-6 shadow-xs">
          <h2 className="font-serif text-lg text-[#180f0a] font-medium mb-4">Revenue by Product Category</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {Object.entries(summary.categoryRevenue).map(([cat, rev]) => (
              <div key={cat} className="p-4 bg-[#f6f3ee] rounded-xl text-center">
                <p className="text-[11px] uppercase font-bold tracking-wider text-[#80756f] mb-1">{cat}</p>
                <p className="text-xl font-serif font-medium text-[#180f0a]">{formatINR(rev)}</p>
                <p className="text-[11px] text-[#80756f] mt-1">{Math.round((rev / summary.totalRevenue) * 100)}% of total</p>
              </div>
            ))}
          </div>
        </div>

        <div className="text-center text-[12px] text-[#80756f] pt-4">Live data · Revenue calculated from live order records</div>
      </div>
    </AdminLayout>
  );
}
