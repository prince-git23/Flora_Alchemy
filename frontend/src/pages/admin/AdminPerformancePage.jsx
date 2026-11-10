import React from 'react';
import { useServerAnalytics } from '../../hooks/useServerAnalytics.js';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { formatINR } from '../../services/orderService.js';
import { fetchAnalyticsOverview, fetchAnalyticsPerformance } from '../../services/analyticsService.js';

/**
 * Product & Customer Performance.
 *
 * Phase 24 — both tables now come from GET /api/analytics/performance, which
 * measures product revenue from stored orders with the shared revenue rule
 * (Paid + legacy Sample) and an order count that counts ORDERS, not lines.
 * Previously this page rebuilt product revenue from the hydrated order list:
 * that list is capped at 500 rows, so the table could silently lose products,
 * and the page was a second definition of revenue.
 *
 * All-time by default; the footer says so, because a reader should not have to
 * guess whether "product performance" is this month or ever.
 */
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

function EmptyRow({ children }) {
  return <p className="py-8 text-center text-[12px] text-[var(--color-botanical-subtle)]">{children}</p>;
}

export default function AdminPerformancePage() {
  const overview = useServerAnalytics(() => fetchAnalyticsOverview(), []);
  const performance = useServerAnalytics(() => fetchAnalyticsPerformance(), []);

  const perf = performance.data;
  const products = perf?.productPerformance || [];
  const customers = perf?.customerPerformance || [];
  const totals = perf?.totals || { revenue: 0, orders: 0, units: 0, products: 0 };
  const topCustomerSpend = customers[0]?.spend || 0;
  const loading = overview.loading || performance.loading;
  const error = overview.error || performance.error;

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div>
          <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Product &amp; Customer Performance</h1>
          <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">All-time catalogue and customer metrics, measured by the API</p>
        </div>

        {error ? (
          <div className="rounded-xl border border-[var(--color-danger-soft-border)] bg-[var(--color-danger-soft-bg)] p-4 flex flex-col sm:flex-row sm:items-center gap-3" role="alert">
            <span className="material-symbols-outlined text-[20px] text-[var(--color-danger-soft-fg)]">error</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[var(--color-danger-soft-fg)]">Performance could not be measured</p>
              <p className="text-[12px] text-[var(--color-danger-soft-fg)]/90 mt-0.5">{error}</p>
            </div>
            <button type="button" onClick={() => { overview.retry(); performance.retry(); }}
              className="rounded-full bg-[var(--color-btn)] px-4 py-2 text-[12px] font-semibold text-white min-h-[44px] sm:min-h-0">
              Retry
            </button>
          </div>
        ) : null}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <Kpi label="Total Revenue" value={loading && !perf ? '—' : formatINR(totals.revenue)} hint="Paid + legacy Sample" icon="payments" />
          <Kpi label="Units Sold" value={loading && !perf ? '—' : totals.units.toLocaleString()} hint="Line quantities" icon="inventory" />
          <Kpi label="Products Sold" value={loading && !perf ? '—' : totals.products.toLocaleString()} hint="Distinct items" icon="inventory_2" />
          <Kpi label="Top Customer Spend" value={loading && !perf ? '—' : formatINR(topCustomerSpend)} hint={customers[0]?.name || 'No customer spend yet'} icon="trending_up" accent />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-1">Product Performance</h2>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mb-4">Ranked by realised revenue · orders counted once each</p>
            {loading && !perf ? (
              <div className="space-y-3" role="status" aria-label="Loading product performance">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-10 rounded-lg bg-[var(--color-surface-high)] animate-pulse" />
                ))}
              </div>
            ) : products.length ? (
              <div className="space-y-3">
                {products.map((p, idx) => (
                  <div key={`${p.productSlug || p.name}-${idx}`} className="flex items-center justify-between py-2.5 border-b border-[var(--color-botanical-border-light)] last:border-0">
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
            ) : (
              <EmptyRow>No revenue-eligible product sales yet.</EmptyRow>
            )}
          </div>

          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-1">Customer Performance</h2>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mb-4">Top 10 by verified spend</p>
            {loading && !perf ? (
              <div className="space-y-3" role="status" aria-label="Loading customer performance">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-10 rounded-lg bg-[var(--color-surface-high)] animate-pulse" />
                ))}
              </div>
            ) : customers.length ? (
              <div className="space-y-3">
                {customers.slice(0, 8).map((c, idx) => (
                  <div key={`${c.email || c.name}-${idx}`} className="flex items-center justify-between py-2.5 border-b border-[var(--color-botanical-border-light)] last:border-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-7 h-7 rounded-full bg-[var(--color-btn)] text-white flex items-center justify-center text-[10px] font-semibold shrink-0">
                        {(c.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2)}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-[var(--color-botanical-primary)] truncate">{c.name}</p>
                        <p className="text-[11px] text-[var(--color-botanical-subtle)] truncate">{c.orders} paid orders{c.status && c.status !== 'Active' ? ` · ${c.status}` : ''}</p>
                      </div>
                    </div>
                    <span className="text-[13px] font-mono font-semibold text-[var(--color-botanical-primary)] shrink-0 ml-2">{formatINR(c.spend)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyRow>No customer spend yet.</EmptyRow>
            )}
          </div>
        </div>

        <p className="text-center text-[11px] text-[var(--color-botanical-subtle)]">
          Measured by the API · all-time · Paid and legacy Sample orders only
        </p>
      </div>
    </AdminLayout>
  );
}
