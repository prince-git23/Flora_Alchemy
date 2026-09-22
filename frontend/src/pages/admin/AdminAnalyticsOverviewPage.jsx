import React, { useState, useMemo } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getOrders, ORDER_STATUSES, ORDER_STATUS_STYLES, formatINR, formatDate } from '../../services/orderService.js';
import { getCustomers } from '../../services/customerService.js';
import { getAnalyticsSummary } from '../../services/analyticsService.js';

export default function AdminAnalyticsOverviewPage() {
  const storeVersion = useStoreVersion();
  const [period, setPeriod] = useState('30d');
  const summary = useMemo(() => getAnalyticsSummary(), [storeVersion]);
  const orders = useMemo(() => getOrders(), [storeVersion]);
  const customers = useMemo(() => getCustomers(), [storeVersion]);

  const statusCounts = useMemo(() => {
    const counts = {};
    ORDER_STATUSES.forEach(s => { counts[s.key] = 0; });
    orders.forEach(o => { if (counts[o.orderStatus] !== undefined) counts[o.orderStatus]++; });
    return counts;
  }, [orders]);

  const topProducts = useMemo(() => {
    const productSales = {};
    orders.forEach(order => {
      order.items.forEach(item => {
        const pid = item.productSlug || item.id;
        if (!productSales[pid]) productSales[pid] = { name: item.name, revenue: 0, units: 0 };
        productSales[pid].revenue += item.price * item.quantity;
        productSales[pid].units += item.quantity;
      });
    });
    return Object.values(productSales).sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  }, [orders]);

  const recentOrders = orders.slice(0, 5);

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Analytics Overview</h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">Business insights derived from sample order data</p>
          </div>
          <div className="flex items-center p-1 rounded-full bg-[var(--color-surface-high)] text-[12px]">
            {['7d', '30d', '3m'].map(p => (
              <button key={p} type="button" onClick={() => setPeriod(p)}
                className={`px-3 py-1 rounded-full font-semibold transition-all ${period === p ? 'bg-[var(--color-surface-lowest)] shadow-xs text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>
                {p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : '3 Months'}
              </button>
            ))}
          </div>
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Total Revenue</span><span className="material-symbols-outlined text-[16px]">payments</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{formatINR(summary.totalRevenue)}</div>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-2">Paid + legacy Sample orders only</p>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Total Orders</span><span className="material-symbols-outlined text-[16px]">shopping_bag</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{summary.totalOrders}</div>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-2">Revenue-eligible orders</p>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Avg. Order Value</span><span className="material-symbols-outlined text-[16px] text-[var(--color-accent)]">trending_up</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{formatINR(summary.aov)}</div>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-2">Across all orders</p>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Customers</span><span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-primary)]">group</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{summary.totalCustomers}</div>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-2">Total records</p>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Delivered</span><span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-sage)]">check_circle</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{summary.deliveredOrders}</div>
            <p className="text-[11px] text-[var(--color-botanical-sage)] mt-2">Completed orders</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Order Pipeline */}
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Order Pipeline Distribution</h2>
            <div className="space-y-3">
              {ORDER_STATUSES.map(s => {
                const count = statusCounts[s.key] || 0;
                const pct = summary.totalOrders > 0 ? Math.round((count / summary.totalOrders) * 100) : 0;
                return (
                  <div key={s.key}>
                    <div className="flex items-center justify-between text-[12px] mb-1">
                      <span className="font-medium text-[var(--color-botanical-muted)]">{s.label}</span>
                      <span className="text-[var(--color-botanical-subtle)]">{count} ({pct}%)</span>
                    </div>
                    <div className="w-full h-2 bg-[var(--color-surface-container)] rounded-full overflow-hidden">
                      <div className="h-full bg-[var(--color-btn)] rounded-full transition-all" style={{ width: `${pct}%` }}></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Top Products */}
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Top Products by Revenue</h2>
            <div className="space-y-3">
              {topProducts.map((p, idx) => (
                <div key={idx} className="flex items-center justify-between py-2 border-b border-[var(--color-botanical-border-light)] last:border-0">
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-full bg-[var(--color-surface-low)] text-[var(--color-botanical-subtle)] text-[11px] font-bold flex items-center justify-center">{idx + 1}</span>
                    <div>
                      <p className="text-[13px] font-medium text-[var(--color-botanical-primary)]">{p.name}</p>
                      <p className="text-[11px] text-[var(--color-botanical-subtle)]">{p.units} units sold</p>
                    </div>
                  </div>
                  <span className="text-[13px] font-mono font-semibold text-[var(--color-botanical-primary)]">{formatINR(p.revenue)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Category Performance */}
        <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
          <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Category Performance</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {Object.entries(summary.categoryRevenue).map(([cat, rev]) => (
              <div key={cat} className="p-4 bg-[var(--color-surface-low)] rounded-xl text-center">
                <p className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] mb-1">{cat}</p>
                <p className="text-xl font-serif font-medium text-[var(--color-botanical-primary)]">{formatINR(rev)}</p>
                <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1">{Math.round((rev / summary.totalRevenue) * 100)}% of total</p>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
          <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Recent Orders</h2>
          <div className="divide-y divide-[var(--color-divider)]">
            {recentOrders.map(order => (
              <div key={order.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono font-semibold text-[var(--color-botanical-primary)] text-[13px]">#{order.id}</span>
                  <span className="text-[13px] text-[var(--color-botanical-muted)]">{order.customerName}</span>
                </div>
                <div className="text-right">
                  <span className="font-mono font-semibold text-[var(--color-botanical-primary)] text-[13px]">{formatINR(order.total)}</span>
                  <p className="text-[11px] text-[var(--color-botanical-subtle)]">{formatDate(order.createdAt)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="text-center text-[12px] text-[var(--color-botanical-subtle)] pt-4">Live data · All metrics derived from MongoDB records</div>
      </div>
    </AdminLayout>
  );
}
