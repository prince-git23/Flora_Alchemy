import api from './apiClient.js';
import { getOrders } from './orderService.js';
import { getProducts } from './productService.js';
import { getCustomers } from './customerService.js';
import { getInventory, getLowStockItems } from './inventoryService.js';

// Mirrors the backend revenue rule (backend/services/analyticsService.js):
// only Paid (verified capture) and legacy Sample orders count as revenue.
// Pending / Failed / Refunded are never revenue.
const REVENUE_STATUSES = ['Paid', 'Sample'];
export const isRevenue = (o) => REVENUE_STATUSES.includes(o.paymentStatus);

/**
 * Server-measured analytics.
 *
 * The API already aggregates these (backend/services/analyticsService.js) with
 * the SAME revenue rule the panels describe, and it does so inside the
 * workspace scope of the calling session. Panels use these reads instead of
 * re-deriving totals from the hydrated order list, which avoided two problems:
 * a capped list silently under-reporting totals, and browser code slowly
 * drifting from the server's definition of revenue.
 *
 * Errors carry the HTTP status so a page can distinguish "not allowed" from
 * "temporarily unavailable" and report it honestly.
 */
async function readAnalytics(path, scope = 'admin') {
  const res = await api.get(path, { scope });
  if (!res.ok) {
    const err = new Error(res.message || 'Analytics could not be loaded.');
    err.status = res.status;
    err.code = res.code;
    throw err;
  }
  return res.data.analytics;
}

/** GET /api/analytics/overview — totals, status distribution, low stock. */
export const fetchAnalyticsOverview = (scope = 'admin') => readAnalytics('/analytics/overview', scope);

/** GET /api/analytics/sales?days=N — per-day revenue and top products. */
export const fetchAnalyticsSales = (days = 30, scope = 'admin') =>
  readAnalytics(`/analytics/sales?days=${encodeURIComponent(days)}`, scope);

/** GET /api/analytics/performance — top customers by verified spend. */
export const fetchAnalyticsPerformance = (scope = 'admin') =>
  readAnalytics('/analytics/performance', scope);

export function getAnalyticsSummary() {
  const orders = getOrders();
  const products = getProducts();
  const customers = getCustomers();

  const revenueOrders = orders.filter(isRevenue);
  const totalRevenue = revenueOrders.reduce((sum, o) => sum + (o.total || 0), 0);
  const totalOrders = revenueOrders.length;
  const aov = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
  const deliveredOrders = revenueOrders.filter(o => o.orderStatus === 'delivered').length;
  const totalCustomers = customers.length;
  const totalProducts = products.length;

  const categoryRevenue = {};
  revenueOrders.forEach(order => {
    order.items.forEach(item => {
      const product = products.find(p => p.id === (item.productSlug || item.id));
      const cat = product?.categoryLabel || product?.category || 'Other';
      categoryRevenue[cat] = (categoryRevenue[cat] || 0) + ((item.price || 0) * (item.quantity || 1));
    });
  });

  return { totalRevenue, totalOrders, aov, deliveredOrders, totalCustomers, totalProducts, categoryRevenue };
}

export function getStatusCounts() {
  const orders = getOrders();
  const counts = { new: 0, confirmed: 0, in_production: 0, quality_check: 0, ready_to_dispatch: 0, shipped: 0, delivered: 0 };
  orders.forEach(o => {
    if (counts[o.orderStatus] !== undefined) counts[o.orderStatus]++;
  });
  return {
    total: orders.length,
    new: counts.new,
    confirmed: counts.confirmed,
    inProduction: counts.in_production,
    qualityCheck: counts.quality_check,
    readyToDispatch: counts.ready_to_dispatch,
    shipped: counts.shipped,
    delivered: counts.delivered,
  };
}

export function getRevenueByPeriod(period) {
  const orders = getOrders();
  const now = new Date();
  let cutoff;

  switch (period) {
    case '7d': cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 7); break;
    case '30d': cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 30); break;
    case '3m': cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - 3); break;
    default: cutoff = new Date(0);
  }

  const filtered = orders.filter(o => new Date(o.createdAt) >= cutoff);
  const total = filtered.reduce((sum, o) => sum + (o.total || 0), 0);
  const avg = filtered.length > 0 ? Math.round(total / filtered.length) : 0;

  return { total, avg, orderCount: filtered.length };
}

export function getProductPerformance() {
  const orders = getOrders();
  const products = getProducts();

  const perf = {};
  orders.forEach(order => {
    order.items.forEach(item => {
      const pid = item.productSlug || item.id;
      if (!perf[pid]) {
        const p = products.find(pr => pr.id === pid);
        perf[pid] = { name: item.name || p?.name || pid, category: p?.categoryLabel || 'Other', revenue: 0, units: 0 };
      }
      perf[pid].revenue += (item.price || 0) * (item.quantity || 1);
      perf[pid].units += (item.quantity || 1);
    });
  });

  return Object.values(perf).sort((a, b) => b.revenue - a.revenue);
}

export function getCustomerPerformance() {
  const orders = getOrders();
  const customers = getCustomers();

  return customers.map(c => {
    const co = orders.filter(o => o.customerId === c.id);
    return {
      ...c,
      orderCount: co.length,
      totalSpend: co.reduce((s, o) => s + (o.total || 0), 0),
    };
  }).sort((a, b) => b.totalSpend - a.totalSpend);
}
