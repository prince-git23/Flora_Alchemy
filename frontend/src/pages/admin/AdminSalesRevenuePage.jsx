import React, { useMemo, useState } from 'react';
import { useServerAnalytics } from '../../hooks/useServerAnalytics.js';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { formatINR } from '../../services/orderService.js';
import { fetchAnalyticsOverview, fetchAnalyticsSales } from '../../services/analyticsService.js';

/**
 * Sales & Revenue.
 *
 * Revenue, AOV and order counts come from GET /api/analytics/overview; the
 * daily series and product ranking come from GET /api/analytics/sales. Nothing
 * here re-sums the hydrated order list, so a capped list cannot make revenue
 * look smaller than it is and the browser no longer owns a second definition of
 * "revenue" (Paid + legacy Sample).
 *
 * 90 days are fetched once and re-bucketed for the selected period — the
 * aggregation stays the server's; only the presentation window changes.
 */
const PERIODS = {
  '7d': { days: 7, label: '7 Days' },
  '30d': { days: 30, label: '30 Days' },
  '3m': { days: 90, label: '3 Months' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The API groups revenue with MongoDB's $dateToString, which is UTC. Bucket
// labels therefore use UTC days as well: using local days here shifted every
// bucket by one for IST and made "today" read yesterday's total.
const isoDay = (date) => date.toISOString().slice(0, 10);

function dayKeys(n) {
  const keys = [];
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86400000);
    keys.push({ key: isoDay(d), date: d });
  }
  return keys;
}

function buildBars(rows, days) {
  const byDay = new Map((rows || []).map((r) => [r._id, r]));

  if (days === 7) {
    return dayKeys(7).map(({ key, date }) => ({
      label: WEEKDAYS[date.getUTCDay()],
      value: Number(byDay.get(key)?.revenue) || 0,
    }));
  }

  if (days === 30) {
    const keys = dayKeys(30);
    const buckets = [];
    for (let i = 0; i < 6; i += 1) {
      const slice = keys.slice(i * 5, i * 5 + 5);
      buckets.push({
        label: `W${i + 1}`,
        value: slice.reduce((sum, { key }) => sum + (Number(byDay.get(key)?.revenue) || 0), 0),
      });
    }
    return buckets;
  }

  const now = new Date();
  const months = [];
  for (let i = 2; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      label: MONTHS[d.getMonth()],
      prefix: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      value: 0,
    });
  }
  for (const [key, row] of byDay.entries()) {
    const bucket = months.find((m) => String(key).startsWith(m.prefix));
    if (bucket) bucket.value += Number(row.revenue) || 0;
  }
  return months.map(({ label, value }) => ({ label, value }));
}

function monthlyBreakdown(rows) {
  const now = new Date();
  const months = [];
  for (let i = 2; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
      revenue: 0,
      orders: 0,
    });
  }
  for (const row of rows || []) {
    const bucket = months.find((m) => String(row._id).startsWith(m.key));
    if (!bucket) continue;
    bucket.revenue += Number(row.revenue) || 0;
    bucket.orders += Number(row.orders) || 0;
  }
  return months.map((m) => ({ ...m, aov: m.orders ? Math.round(m.revenue / m.orders) : 0 }));
}

export default function AdminSalesRevenuePage() {
  const [period, setPeriod] = useState('30d');
  const { days } = PERIODS[period];

  const overview = useServerAnalytics(() => fetchAnalyticsOverview(), []);
  const sales = useServerAnalytics(() => fetchAnalyticsSales(90), []);

  const rows = sales.data?.daily || [];
  const bars = useMemo(() => buildBars(rows, days), [rows, days]);
  const monthly = useMemo(() => monthlyBreakdown(rows), [rows]);
  const maxBar = Math.max(1, ...bars.map((b) => b.value));
  const analytics = overview.data;
  const topProducts = (sales.data?.topProducts || []).slice(0, 6);
  const loading = overview.loading || sales.loading;
  const error = overview.error || sales.error;

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Sales & Revenue</h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">Server-measured revenue, order value and product mix</p>
          </div>
          <div className="flex items-center p-1 rounded-full bg-[var(--color-surface-high)] text-[12px]" role="group" aria-label="Reporting period">
            {Object.entries(PERIODS).map(([key, value]) => (
              <button key={key} type="button" onClick={() => setPeriod(key)} aria-pressed={period === key}
                className={`px-3 py-1 rounded-full font-semibold transition-all ${period === key ? 'bg-[var(--color-surface-lowest)] shadow-xs text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>
                {value.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="rounded-xl border border-[var(--color-danger-soft-border)] bg-[var(--color-danger-soft-bg)] p-4 flex flex-col sm:flex-row sm:items-center gap-3" role="alert">
            <span className="material-symbols-outlined text-[20px] text-[var(--color-danger-soft-fg)]">error</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[var(--color-danger-soft-fg)]">Revenue could not be measured</p>
              <p className="text-[12px] text-[var(--color-danger-soft-fg)]/90 mt-0.5">{error}</p>
            </div>
            <button type="button" onClick={() => { overview.retry(); sales.retry(); }}
              className="rounded-full bg-[var(--color-btn)] px-4 py-2 text-[12px] font-semibold text-white min-h-[44px] sm:min-h-0">
              Retry
            </button>
          </div>
        ) : null}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Total Revenue</span><span className="material-symbols-outlined text-[16px]">payments</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{loading && !analytics ? '—' : formatINR(analytics?.totalRevenue || 0)}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">AOV</span><span className="material-symbols-outlined text-[16px] text-[var(--color-accent)]">trending_up</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{loading && !analytics ? '—' : formatINR(analytics?.averageOrderValue || 0)}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Orders</span><span className="material-symbols-outlined text-[16px]">shopping_bag</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{loading && !analytics ? '—' : (analytics?.totalOrders || 0).toLocaleString()}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Delivered</span><span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-sage)]">check_circle</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{loading && !analytics ? '—' : (analytics?.statusDistribution?.delivered || 0).toLocaleString()}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <div className="flex items-baseline justify-between gap-3 mb-4">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">
                {days === 7 ? 'Daily Revenue' : days === 30 ? 'Weekly Revenue' : 'Monthly Revenue'}
              </h2>
              <span className="text-[11px] text-[var(--color-botanical-subtle)]">{PERIODS[period].label}</span>
            </div>
            <div className="h-48 w-full flex items-end justify-between gap-2 px-1 border-b border-[var(--color-botanical-border-light)] pb-2">
              {bars.map((bar, idx) => (
                <div key={`${bar.label}-${idx}`} className="flex-1 flex flex-col items-center gap-2 h-full justify-end group">
                  <div className="w-full max-w-[40px] rounded-t bg-[var(--color-surface-high)] group-hover:bg-[var(--color-border-strong)] transition-all relative"
                    style={{ height: `${bar.value > 0 ? Math.max((bar.value / maxBar) * 100, 2) : 0}%` }}>
                    {bar.value > 0 ? (
                      <div className="absolute -top-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-[var(--color-btn)] text-white text-[9px] font-bold whitespace-nowrap shadow-sm opacity-0 group-hover:opacity-100 transition-opacity">
                        {formatINR(bar.value)}
                      </div>
                    ) : null}
                  </div>
                  <span className="text-[10px] font-bold text-[var(--color-botanical-subtle)]">{bar.label}</span>
                </div>
              ))}
            </div>
            {!loading && bars.every((b) => !b.value) ? (
              <p className="mt-3 text-center text-[11px] text-[var(--color-botanical-subtle)]">No revenue-eligible orders in this period.</p>
            ) : null}
          </div>

          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Monthly Breakdown</h2>
            <div className="space-y-4">
              {monthly.map((m) => (
                <div key={m.key} className="p-3 bg-[var(--color-surface-low)] rounded-xl">
                  <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">{m.label}</p>
                  <div className="flex items-center justify-between mt-2 text-[12px]">
                    <span className="text-[var(--color-botanical-subtle)]">Revenue</span>
                    <span className="font-bold text-[var(--color-botanical-primary)]">{formatINR(m.revenue)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[12px] mt-1">
                    <span className="text-[var(--color-botanical-subtle)]">Orders</span>
                    <span className="font-medium text-[var(--color-botanical-muted)]">{m.orders}</span>
                  </div>
                  <div className="flex items-center justify-between text-[12px] mt-1">
                    <span className="text-[var(--color-botanical-subtle)]">AOV</span>
                    <span className="font-medium text-[var(--color-botanical-muted)]">{formatINR(m.aov)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
          <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-1">Top Products by Revenue</h2>
          <p className="text-[11px] text-[var(--color-botanical-subtle)] mb-4">Last 90 days · the API ranks products by realised revenue</p>
          {topProducts.length ? (
            <div className="divide-y divide-[var(--color-divider)]">
              {topProducts.map((p, idx) => (
                <div key={`${p.name}-${idx}`} className="flex items-center gap-3 py-2.5">
                  <span className="w-6 h-6 shrink-0 rounded-full bg-[var(--color-surface-low)] text-[11px] font-bold text-[var(--color-botanical-subtle)] flex items-center justify-center">{idx + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-[var(--color-botanical-primary)]">{p.name}</p>
                    <p className="text-[11px] text-[var(--color-botanical-subtle)]">{p.quantity} units</p>
                  </div>
                  <span className="font-mono text-[13px] font-semibold text-[var(--color-botanical-primary)]">{formatINR(p.revenue)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-[12px] text-[var(--color-botanical-subtle)]">
              {sales.loading ? 'Measuring…' : 'No revenue-eligible orders in the last 90 days.'}
            </p>
          )}
        </div>

        <p className="text-center text-[11px] text-[var(--color-botanical-subtle)]">
          Measured by the API · Paid and legacy Sample orders count as revenue; Pending, Failed and Refunded never do
        </p>
      </div>
    </AdminLayout>
  );
}
