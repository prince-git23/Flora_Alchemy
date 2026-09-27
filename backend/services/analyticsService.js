import Order, { ORDER_STATUSES } from '../models/Order.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import Inventory from '../models/Inventory.js';
import { requestScope } from '../utils/tenancy.js';

/**
 * Revenue rule (documented, Phase 3E):
 *   revenue = orders with paymentStatus 'Paid' (verified real capture)
 *             + legacy 'Sample' orders from the pre-gateway prototype era
 *             (Sample was the prototype's stand-in for paid).
 *   Pending / Failed / Refunded are NEVER counted as revenue.
 * Analytics remain fully server-derived from MongoDB.
 *
 * Phase 22.3 — every computation takes the request and scopes its FIRST
 * `$match` (aggregations) or its filter (find/count) with `requestScope`, so
 * workspace A can never count workspace B's revenue, orders or stock. The
 * scope reaches the service straight from the router gate — a handler cannot
 * pass a different one.
 */
const REVENUE_STATUSES = ['Paid', 'Sample'];

function revenueMatch() {
  return { paymentStatus: { $in: REVENUE_STATUSES } };
}

/**
 * Customer analytics follow the same RELATIONSHIP rule as the customers page:
 * a customer counts for a workspace only when an order links them. With an
 * empty scope (compat mode / owner) the historical fixture-aware count stands.
 */
async function customerAnalyticsFilter(req) {
  const scope = requestScope(req);
  if (Object.keys(scope).length === 0) return { isFixture: { $ne: true } };
  const related = await Order.distinct('customerId', { ...requestScope(req) });
  return { _id: { $in: related } };
}

export async function computeOverview(req) {
  const customerFilter = await customerAnalyticsFilter(req);
  const [orderStats, customerCount, productCount, inventoryDocs] = await Promise.all([
    Order.aggregate([
      { $match: { ...requestScope(req), ...revenueMatch() } },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          revenue: { $sum: '$total' },
        },
      },
    ]),
    Customer.countDocuments(customerFilter),
    Product.countDocuments({ ...requestScope(req), visibility: 'Visible' }),
    Inventory.find({ ...requestScope(req) }),
  ]);

  const totals = orderStats[0] || { orders: 0, revenue: 0 };
  const byStatus = {};
  for (const s of ORDER_STATUSES) byStatus[s] = 0;
  const statusRows = await Order.aggregate([
    { $match: { ...requestScope(req) } },
    { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
  ]);
  for (const row of statusRows) {
    if (row._id in byStatus) byStatus[row._id] = row.count;
  }

  const lowStock = inventoryDocs.filter(
    (i) => i.currentStock <= i.reorderLevel
  ).length;

  return {
    totalOrders: totals.orders,
    totalRevenue: totals.revenue,
    averageOrderValue: totals.orders ? Math.round(totals.revenue / totals.orders) : 0,
    totalCustomers: customerCount,
    visibleProducts: productCount,
    statusDistribution: byStatus,
    lowStockItems: lowStock,
    pendingOrders: (byStatus.new || 0) + (byStatus.confirmed || 0),
    inProduction: byStatus.in_production || 0,
  };
}

export async function computeSales(req, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await Order.aggregate([
    { $match: { ...requestScope(req), createdAt: { $gte: since }, ...revenueMatch() } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        revenue: { $sum: '$total' },
        orders: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const productRows = await Order.aggregate([
    { $match: { ...requestScope(req), createdAt: { $gte: since }, ...revenueMatch() } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.name',
        revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
        quantity: { $sum: '$items.quantity' },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 8 },
  ]);

  return {
    days,
    daily: rows,
    topProducts: productRows.map((r) => ({
      name: r._id,
      revenue: r.revenue,
      quantity: r.quantity,
    })),
  };
}

export async function computePerformance(req) {
  const customerFilter = await customerAnalyticsFilter(req);
  const [customers, orders] = await Promise.all([
    Customer.find(customerFilter).sort({ createdAt: 1 }).lean(),
    Order.find({ ...requestScope(req) }).sort({ createdAt: -1 }).lean(),
  ]);

  const customerRows = customers.map((c) => {
    const own = orders.filter(
      (o) =>
        String(o.customerId) === String(c._id) &&
        REVENUE_STATUSES.includes(o.paymentStatus)
    );
    const spend = own.reduce((sum, o) => sum + o.total, 0);
    return {
      name: c.name,
      email: c.email,
      orders: own.length,
      spend: Math.round(spend),
      status: c.status,
    };
  });

  return {
    customerPerformance: customerRows.sort((a, b) => b.spend - a.spend).slice(0, 10),
  };
}
