import React, { useMemo, useState } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { useServerAnalytics } from '../../hooks/useServerAnalytics.js';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getOrders, ORDER_STATUSES, ORDER_STATUS_STYLES, formatINR, formatDate } from '../../services/orderService.js';
import { fetchAnalyticsOverview, fetchAnalyticsSales } from '../../services/analyticsService.js';

/**
 * Analytics Overview.
 *
 * Headline numbers are the API's own aggregates, not a re-sum of the hydrated
 * order list: that list is capped at 500 rows, so re-summing would silently
 * under-report once a workspace outgrows it and would define revenue a second
 * time in the browser. The recent-orders list is a five-row preview only.
 */
const PERIOD_DAYS = { '7d': 7, '30d': 30, '3m': 90 };
const PERIOD_LABEL = { '7d': '7 Days', '30d': '30 Days', '3m': '3 Months' };

/** ORDER_STATUS_STYLES stores { bg, text, border, dot } — not a class string. */
const statusChipClass = (statusName) => {
  const tone = ORDER_STATUS_STYLES?.[statusName];
  return tone
    ? `${tone.bg} ${tone.text}`
    : 'bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)]';
};

function Kpi({ label, value, hint, icon, accent }) {
  return (
    <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
      <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5">
        <span className="text-[11px] uppercase tracking-wider font-semibold">{label}</span>
        <span className={`material-symbols-outlined text-[16px] ${accent ? 'text-[var(--color-accent)]' : ''}`}>{icon}</span>
      </div>
      <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{value}</div>
      {hint ? <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-2">{hint}</p> : null}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)]" role="status" aria-label="Loading analytics">
      <div className="h-2.5 w-20 rounded bg-[var(--color-surface-high)] animate-pulse" />
      <div className="mt-3 h-8 w-28 rounded bg-[var(--color-surface-high)] animate-pulse" />
    </div>
  );
}

export default function AdminAnalyticsOverviewPage() {
  const storeVersion = useStoreVersion();
  const [period, setPeriod] = useState('30d');
  const days = PERIOD_DAYS[period];

  const overview = useServerAnalytics(() => fetchAnalyticsOverview(), []);
  const sales = useServerAnalytics(() => fetchAnalyticsSales(days), [days]);
  const recentOrders = useMemo(() => getOrders().slice(0, 5), [storeVersion]);

  const analytics = overview.data;
  const status = analytics?.statusDistribution || {};
  const pipelineTotal = Object.values(status).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const topProducts = sales.data?.topProducts || [];
  const loading = overview.loading || sales.loading;
  const error = overview.error || sales.error;

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Analytics Overview</h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">Server-measured totals for this workspace</p>
          </div>
          <div className="flex items-center p-1 rounded-full bg-[var(--color-surface-high)] text-[12px]" role="group" aria-label="Reporting period">
            {Object.keys(PERIOD_DAYS).map((p) => (
              <button key={p} type="button" onClick={() => setPeriod(p)} aria-pressed={period === p}
                className={`px-3 py-1 rounded-full font-semibold transition-all ${period === p ? 'bg-[var(--color-surface-lowest)] shadow-xs text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="rounded-xl border border-[var(--color-danger-soft-border)] bg-[var(--color-danger-soft-bg)] p-4 flex flex-col sm:flex-row sm:items-center gap-3" role="alert">
            <span className="material-symbols-outlined text-[20px] text-[var(--color-danger-soft-fg)]">error</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[var(--color-danger-soft-fg)]">Analytics could not be measured</p>
              <p className="text-[12px] text-[var(--color-danger-soft-fg)]/90 mt-0.5">{error}</p>
            </div>
            <button type="button" onClick={() => { overview.retry(); sales.retry(); }}
              className="rounded-full bg-[var(--color-btn)] px-4 py-2 text-[12px] font-semibold text-white min-h-[44px] sm:min-h-0">
              Retry
            </button>
          </div>
        ) : null}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
          {loading && !analytics ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} />)
          ) : (
            <>
              <Kpi label="Total Revenue" value={formatINR(analytics?.totalRevenue || 0)} hint="Paid + legacy Sample only" icon="payments" />
              <Kpi label="Total Orders" value={(analytics?.totalOrders || 0).toLocaleString()} hint="Revenue-eligible orders" icon="shopping_bag" />
              <Kpi label="Avg. Order Value" value={formatINR(analytics?.averageOrderValue || 0)} hint="Revenue ÷ orders" icon="trending_up" accent />
              <Kpi label="Customers" value={(analytics?.totalCustomers || 0).toLocaleString()} hint="Workspace records" icon="group" />
              <Kpi label="Delivered" value={(status.delivered || 0).toLocaleString()} hint="Completed orders" icon="check_circle" />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-1">Order Pipeline</h2>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mb-4">All orders, by stage</p>
            <div className="space-y-3">
              {ORDER_STATUSES.map((s) => {
                const count = status[s.key] || 0;
                const pct = pipelineTotal > 0 ? Math.round((count / pipelineTotal) * 100) : 0;
                return (
                  <div key={s.key}>
                    <div className="flex items-center justify-between text-[12px] mb-1">
                      <span className="font-medium text-[var(--color-botanical-muted)]">{s.label}</span>
                      <span className="text-[var(--color-botanical-subtle)]">{count} ({pct}%)</span>
                    </div>
                    <div className="w-full h-2 bg-[var(--color-surface-container)] rounded-full overflow-hidden">
                      <div className="h-full bg-[var(--color-btn)] rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            {analytics?.lowStockItems ? (
              <p className="mt-4 rounded-lg bg-[var(--color-warning-soft-bg)] px-3 py-2 text-[11px] text-[var(--color-warning-soft-fg)]">
                {analytics.lowStockItems} item(s) at or below their reorder level.
              </p>
            ) : null}
          </div>

          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-1">Top Products by Revenue</h2>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mb-4">Last {days} days · server aggregate</p>
            {topProducts.length ? (
              <div>
                {topProducts.slice(0, 5).map((p, idx) => (
                  <div key={`${p.name}-${idx}`} className="flex items-center justify-between py-2 border-b border-[var(--color-botanical-border-light)] last:border-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-6 h-6 shrink-0 rounded-full bg-[var(--color-surface-low)] text-[11px] font-bold text-[var(--color-botanical-subtle)] flex items-center justify-center">{idx + 1}</span>
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-[var(--color-botanical-primary)] truncate">{p.name}</p>
                        <p className="text-[11px] text-[var(--color-botanical-subtle)]">{p.quantity} units sold</p>
                      </div>
                    </div>
                    <span className="text-[13px] font-mono font-semibold text-[var(--color-botanical-primary)] shrink-0">{formatINR(p.revenue)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-[12px] text-[var(--color-botanical-subtle)]">
                {sales.loading ? 'Measuring…' : 'No revenue-eligible orders in this period.'}
              </p>
            )}
          </div>
        </div>

        <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
          <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Recent Orders</h2>
          {recentOrders.length ? (
            <div className="divide-y divide-[var(--color-divider)]">
              {recentOrders.map((order) => (
                <div key={order.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[12px]">
                  <span className="font-mono font-semibold text-[var(--color-botanical-primary)]">{order.id}</span>
                  <span className="text-[var(--color-botanical-muted)]">{order.customerName || order.customer?.name || 'Customer'}</span>
                  <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusChipClass(order.orderStatus)}`}>
                    {order.orderStatus?.replace(/_/g, ' ')}
                  </span>
                  <span className="font-mono text-[var(--color-botanical-primary)]">{formatINR(order.total)}</span>
                  <span className="w-20 text-right text-[11px] text-[var(--color-botanical-subtle)]">{formatDate(order.createdAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-[12px] text-[var(--color-botanical-subtle)]">No orders yet.</p>
          )}
        </div>

        <p className="text-center text-[11px] text-[var(--color-botanical-subtle)]">
          Measured by the API · revenue counts Paid and legacy Sample orders only
        </p>
      </div>
    </AdminLayout>
  );
}
