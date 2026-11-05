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

/**
 * Product & customer performance.
 *
 * Phase 24 — this endpoint used to return only `customerPerformance`, so the
 * admin page had to rebuild product revenue from the hydrated (capped) order
 * list. Product revenue is now measured here, with the SAME revenue rule as
 * every other aggregate, the same request scope, and an optional `days`
 * window. `days = null` keeps the historical all-time behaviour.
 *
 * Revenue per line is price × quantity (never the client's total), and an
 * order count is a count of DISTINCT orders rather than line items — the old
 * browser code incremented once per line, which overstated orders for an order
 * that contained the same product twice.
 */
export async function computePerformance(req, days = null) {
  const since = Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86400000) : null;
  const scope = requestScope(req);
  const orderMatch = { ...scope, ...(since ? { createdAt: { $gte: since } } : {}) };
  const paidMatch = { ...orderMatch, ...revenueMatch() };

  const customerFilter = await customerAnalyticsFilter(req);

  const [customers, paidOrders, productRows, totalsRows] = await Promise.all([
    Customer.find(customerFilter).sort({ createdAt: 1 }).lean(),
    Order.find(paidMatch).select('customerId total').lean(),
    Order.aggregate([
      { $match: paidMatch },
      { $unwind: '$items' },
      {
        $group: {
          _id: {
            slug: { $ifNull: ['$items.productSlug', '$items.name'] },
            name: '$items.name',
          },
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          units: { $sum: '$items.quantity' },
          orderIds: { $addToSet: '$_id' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 20 },
    ]),
    Order.aggregate([
      { $match: { ...orderMatch, ...revenueMatch() } },
      {
        $group: {
          _id: null,
          revenue: { $sum: '$total' },
          orders: { $sum: 1 },
        },
      },
    ]),
  ]);

  // Category is a catalogue fact, not something an order line carries. Look it
  // up for the products that actually sold; unknown slugs stay "Other" rather
  // than being guessed from the item name.
  const slugs = productRows.map((r) => r._id.slug).filter(Boolean);
  const categoryDocs = slugs.length
    ? await Product.find({ ...scope, slug: { $in: slugs } }).select('slug category').lean()
    : [];
  const categoryBySlug = new Map(categoryDocs.map((p) => [p.slug, p.category]));

  const productPerformance = productRows.map((r) => ({
    productSlug: r._id.slug || null,
    name: r._id.name || r._id.slug || 'Unnamed item',
    category: categoryBySlug.get(r._id.slug) || 'Other',
    revenue: Math.round(r.revenue),
    units: r.units,
    orders: r.orderIds.length,
  }));

  const customerRows = customers.map((c) => {
    const own = paidOrders.filter((o) => String(o.customerId) === String(c._id));
    const spend = own.reduce((sum, o) => sum + o.total, 0);
    return {
      name: c.name,
      email: c.email,
      orders: own.length,
      spend: Math.round(spend),
      status: c.status,
    };
  });

  const totalsRow = totalsRows[0] || { revenue: 0, orders: 0 };

  return {
    rangeDays: since ? days : null,
    productPerformance,
    totals: {
      revenue: Math.round(totalsRow.revenue),
      orders: totalsRow.orders,
      units: productPerformance.reduce((sum, p) => sum + p.units, 0),
      products: productPerformance.length,
    },
    customerPerformance: customerRows.sort((a, b) => b.spend - a.spend).slice(0, 10),
  };
}
