import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getOrders, getStatusCounts, ORDER_STATUS_STYLES, ORDER_STATUSES, formatINR, formatDate } from '../../services/orderService.js';
import { getLowStockItems } from '../../services/inventoryService.js';
import { getUnreadCount } from '../../services/conversationService.js';
import { isRevenue } from '../../services/analyticsService.js';
import { AdminOrderStatusPill } from '../../components/admin/AdminStatusPill.jsx';

/* ── GSAP ── */
import gsap from 'gsap';

const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function getStatusStyle(key) {
  const styles = ORDER_STATUS_STYLES || {};
  return styles[key] || 'bg-slate-100 text-slate-800';
}

export default function AdminDashboardPage() {
  const [revenuePeriod, setRevenuePeriod] = useState('7d'); // '7d' | '30d' | '3m'
  const [orderFilterStage, setOrderFilterStage] = useState(null);
  const [unreadConversations, setUnreadConversations] = useState(0);
  const pageRef = useRef(null);

  /* ── GSAP: operational entrance — fast, restrained ── */
  useEffect(() => {
    if (prefersReduced || !pageRef.current) return;
    const ctx = gsap.context(() => {
      gsap.from('[data-dash-kpi]', {
        y: 16, opacity: 0, duration: 0.45, ease: 'power2.out', stagger: 0.06, delay: 0.05,
      });
      gsap.from('[data-dash-panel]', {
        y: 20, opacity: 0, duration: 0.5, ease: 'power2.out', stagger: 0.08, delay: 0.2,
      });
    }, pageRef);
    return () => ctx.revert();
  }, []);

  useEffect(() => {
    getUnreadCount().then((r) => setUnreadConversations(r.count || 0)).catch(() => {});
  }, []);

  // Today's crafting queue derives from REAL orders currently in the
  // production pipeline (new → confirmed → in production → quality check).
  // Every entry is a live commission; the action opens that actual order.
  // No fake task system — nothing here is invented.
  const craftingTasks = useMemo(() => {
    const activeKeys = ['new', 'confirmed', 'in_production', 'quality_check'];
    return getOrders()
      .filter((o) => activeKeys.includes(o.orderStatus))
      .slice(0, 6)
      .map((o) => {
        const firstItem = o.items[0] || {};
        const palette =
          firstItem.palette ||
          (o.items.length > 1 ? `${o.items.length} handcrafted items` : 'Handcrafted commission');
        const transcript = firstItem.giftMessage || o.giftMessage || null;
        const stage = (ORDER_STATUSES.find((s) => s.key === o.orderStatus) || {}).label || o.orderStatus;
        const priority =
          o.orderStatus === 'new'
            ? 'High Priority'
            : o.orderStatus === 'confirmed'
            ? 'Priority'
            : 'In Queue';
        const priorityColor =
          priority === 'High Priority' ? 'bg-[#964735]/15 text-[#964735]' : 'bg-[#ebe8e3] text-[#4e4540]';
        return {
          id: o.id,
          title: `${o.id} · ${firstItem.name || 'Custom Gift'}`,
          priority,
          priorityColor,
          palette,
          transcript,
          due: `${stage} · ${formatDate(o.createdAt)}`,
          actionText: 'Open Order',
          status: 'pending'
        };
      });
  }, []);

  // Each crafting task references a real order — the action opens that order
  // instead of simulating a completed task that has no backend state.
  const navigate = useNavigate();
  const handleTaskAction = (taskId) => {
    navigate(`/admin/orders/${taskId}`);
  };

  const compactINR = (n) => {
    if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
    if (n >= 1000) return `₹${(n / 1000).toFixed(1)}k`;
    return `₹${Math.round(n)}`;
  };

  // Revenue Overview derives from the server-backed order data (no fake KPIs).
  // Only Paid + legacy Sample orders count as revenue (backend revenue rule).
  const revenueStats = useMemo(() => {
    const allOrders = getOrders();
    const orders = allOrders.filter(isRevenue);
    const days = revenuePeriod === '7d' ? 7 : revenuePeriod === '3m' ? 90 : 30;
    const step = days === 90 ? 7 : 1;
    const colCount = Math.ceil(days / step);
    const totals = new Array(colCount).fill(0);
    const now = Date.now();
    const periodOrders = orders.filter((o) => {
      const d = new Date(o.createdAt || 0).getTime();
      return !Number.isNaN(d) && d <= now && now - d < days * 864e5;
    });
    periodOrders.forEach((o) => {
      const diffDays = Math.floor((now - new Date(o.createdAt).getTime()) / 864e5);
      const col = Math.min(colCount - 1, Math.floor(diffDays / step));
      totals[col] += Number(o.total) || 0;
    });
    const max = Math.max(1, ...totals);
    const total = totals.reduce((a, b) => a + b, 0);
    const avg = periodOrders.length ? Math.round(total / periodOrders.length) : 0;
    const barLabel = (col) => {
      const date = new Date(now - ((colCount - 1 - col) * step + (step - 1) / 2) * 864e5);
      return step === 1
        ? date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
        : `Wk ${colCount - col}`;
    };
    return {
      total: formatINR(total),
      avg: `Avg order: ${formatINR(avg)}`,
      bars: totals.map((v, col) => ({
        label: barLabel(col),
        height: `${Math.max(4, (v / max) * 100)}%`,
        val: compactINR(v),
        isCurrent: col === colCount - 1,
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revenuePeriod, getOrders().length]);

  const recentOrders = useMemo(() => {
    const allOrders = getOrders().slice(0, 5);
    return allOrders.map(order => ({
      id: order.id,
      customer: order.customerName || 'Guest',
      items: order.items.map(i => i.name).join(', ').slice(0, 40),
      amount: formatINR(order.total || 0),
      status: order.orderStatus || 'new',
      statusStyle: getStatusStyle(order.orderStatus || 'new'),
      date: order.createdAt ? new Date(order.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—',
      trackingNumber: order.trackingNumber || null,
    }));
  }, []);

  const currentRevenue = revenueStats;
  const counts = getStatusCounts();
  const lowStockItems = useMemo(() => getLowStockItems(), []);

  return (
    <AdminLayout>
      <div ref={pageRef} className="max-w-7xl mx-auto space-y-6 sm:space-y-8 pb-8 sm:pb-12">
        {/* Welcome & Action Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-2xl sm:text-3xl lg:text-4xl text-[#180f0a] tracking-tight font-normal">
              Operations Overview
            </h1>
            <p className="text-[15px] text-[#4e4540] mt-1">
              Here’s what needs your attention today.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Quick Action Buttons */}
            <Link to="/admin/products"
              className="px-4 py-2 rounded-full border border-[#d1c4bd] bg-white text-[#180f0a] hover:bg-[#f6f3ee] text-[13px] font-semibold shadow-xs transition-all flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[17px]">add</span>
              <span>+ Add Product</span>
            </Link>

            <Link to="/admin/orders"
              className="relative px-5 py-2 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] text-[13px] font-semibold shadow-xs transition-all flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[17px]">add_circle</span>
              <span>+ Create Order</span>
            </Link>
            <Link to="/admin/conversations"
              className="relative px-4 py-2 rounded-full border border-[#d1c4bd] bg-white text-[#180f0a] hover:bg-[#f6f3ee] text-[13px] font-semibold shadow-xs transition-all flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[17px]">chat</span>
              <span>Messages</span>
              {unreadConversations > 0 && (
                <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[#964735] text-white text-[10px] font-bold flex items-center justify-center">
                  {unreadConversations}
                </span>
              )}
            </Link>
          </div>
        </div>

        {/* ACTIVE LIVE VIEW */}
        <div className="space-y-8">
            {/* 5-Card KPI Metrics Row */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
              {/* KPI 1: Total Orders */}
              <div data-dash-kpi className="p-4 bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] flex flex-col justify-between hover:shadow-[0_10px_30px_-8px_rgba(46,36,30,0.12)] hover:-translate-y-0.5 transition-all duration-300">
                <div className="flex items-center justify-between text-[#80756f]">
                  <span className="text-[11px] font-bold uppercase tracking-wider">Total Orders</span>
                  <span className="material-symbols-outlined text-[19px] text-[#5b6d54]">local_florist</span>
                </div>
                <div className="my-2">
                  <span className="font-serif text-3xl sm:text-4xl font-medium text-[#180f0a] leading-none">
                    {getStatusCounts().total}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-[12px] text-[#1d2918] font-medium">
                  <span className="material-symbols-outlined text-[15px]">trending_up</span>
                  <span>Live from server data</span>
                </div>
              </div>

              {/* KPI 2: Pending Orders */}
              <div data-dash-kpi className="p-4 bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] flex flex-col justify-between hover:shadow-[0_10px_30px_-8px_rgba(46,36,30,0.12)] hover:-translate-y-0.5 transition-all duration-300">
                <div className="flex items-center justify-between text-[#80756f]">
                  <span className="text-[11px] font-bold uppercase tracking-wider">New / Confirmed</span>
                  <span className="material-symbols-outlined text-[19px] text-[#964735]">pending_actions</span>
                </div>
                <div className="my-2">
                  <span className="font-serif text-3xl sm:text-4xl font-medium text-[#180f0a] leading-none">
                    {getStatusCounts().new + getStatusCounts().confirmed}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[12px] text-[#964735] font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#964735]"></span>
                  <span>Requires attention</span>
                </div>
              </div>

              {/* KPI 3: In Production */}
              <div data-dash-kpi className="p-4 bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] flex flex-col justify-between hover:shadow-[0_10px_30px_-8px_rgba(46,36,30,0.12)] hover:-translate-y-0.5 transition-all duration-300">
                <div className="flex items-center justify-between text-[#80756f]">
                  <span className="text-[11px] font-bold uppercase tracking-wider">In Production</span>
                  <span className="material-symbols-outlined text-[19px] text-[#180f0a]">precision_manufacturing</span>
                </div>
                <div className="my-2">
                  <span className="font-serif text-3xl sm:text-4xl font-medium text-[#180f0a] leading-none">
                    {getStatusCounts().inProduction}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[12px] text-[#4e4540]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#2e241e]"></span>
                  <span>Currently being crafted</span>
                </div>
              </div>

              {/* KPI 4: Ready to Dispatch */}
              <div data-dash-kpi className="p-4 bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] flex flex-col justify-between hover:shadow-[0_10px_30px_-8px_rgba(46,36,30,0.12)] hover:-translate-y-0.5 transition-all duration-300">
                <div className="flex items-center justify-between text-[#80756f]">
                  <span className="text-[11px] font-bold uppercase tracking-wider">Ready to Dispatch</span>
                  <span className="material-symbols-outlined text-[19px] text-[#964735]">package_2</span>
                </div>
                <div className="my-2">
                  <span className="font-serif text-3xl sm:text-4xl font-medium text-[#180f0a] leading-none">
                    {getStatusCounts().readyToDispatch}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-[12px] text-[#964735] font-medium">
                  <span className="material-symbols-outlined text-[15px]">schedule</span>
                  <span>Awaiting dispatch</span>
                </div>
              </div>

              {/* KPI 5: Total Revenue */}
              <div data-dash-kpi className="p-4 bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] flex flex-col justify-between col-span-2 sm:col-span-1 hover:shadow-[0_10px_30px_-8px_rgba(46,36,30,0.12)] hover:-translate-y-0.5 transition-all duration-300">
                <div className="flex items-center justify-between text-[#80756f]">
                  <span className="text-[11px] font-bold uppercase tracking-wider">Total Revenue</span>
                  <span className="material-symbols-outlined text-[19px] text-[#5b6d54]">payments</span>
                </div>
                <div className="my-2">
                  <span className="font-serif text-3xl sm:text-4xl font-medium text-[#180f0a] leading-none">
                    {formatINR(getOrders().filter(isRevenue).reduce((s, o) => s + (o.total || 0), 0))}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-[12px] text-[#1d2918] font-medium">
                  <span className="material-symbols-outlined text-[15px]">arrow_upward</span>
                  <span>Paid + Sample-payment orders</span>
                </div>
              </div>
            </div>

            {/* Order Pipeline (Canonical Workflow) */}
            <div data-dash-panel className="p-6 bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] hover:shadow-[0_10px_30px_-8px_rgba(46,36,30,0.08)] transition-shadow duration-300">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                <div>
                  <h2 className="font-serif text-xl sm:text-2xl text-[#180f0a] font-medium">
                    Order Pipeline
                  </h2>
                  <p className="text-[13px] text-[#4e4540]">
                    Track today’s orders through each operational stage.
                  </p>
                </div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#80756f]">
                  {counts.new + counts.confirmed + counts.inProduction + counts.qualityCheck + counts.readyToDispatch} Active Today
                </span>
              </div>

              {/* Workflow connecting track */}
              <div className="hidden lg:flex items-center px-2 mb-3">
                <div className="h-1.5 w-full bg-[#f0ede9] rounded-full overflow-hidden flex">
                  <div className="bg-[#e5e2dd] w-[14%]"></div>
                  <div className="bg-[#e5e2dd] w-[14%]"></div>
                  <div className="bg-[#180f0a] w-[14%]"></div>
                  <div className="bg-[#e5e2dd] w-[14%]"></div>
                  <div className="bg-[#e5e2dd] w-[14%]"></div>
                  <div className="bg-[#e5e2dd] w-[14%]"></div>
                  <div className="bg-[#e5e2dd] w-[16%]"></div>
                </div>
              </div>

              {/* Workflow Stages Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5">
                {/* Stage 1 */}
                <div
                  onClick={() => setOrderFilterStage(orderFilterStage === 1 ? null : 1)}
                  className={`p-3 rounded-xl transition-all cursor-pointer border ${
                    orderFilterStage === 1
                      ? 'bg-[#f0ede9] border-[#180f0a]'
                      : 'bg-[#f6f3ee] hover:bg-[#f0ede9] border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase text-[#80756f]">Stage 01</span>
                    <span className="px-1.5 py-0.5 rounded-full bg-[#e5e2dd] text-[#180f0a] text-[10px] font-bold">
                      {counts.new}
                    </span>
                  </div>
                  <div className="mt-3">
                    <span className="text-[13px] font-semibold text-[#180f0a] block">1. New</span>
                    <span className="text-[11px] text-[#80756f]">Payment confirmed</span>
                  </div>
                </div>

                {/* Stage 2 */}
                <div
                  onClick={() => setOrderFilterStage(orderFilterStage === 2 ? null : 2)}
                  className={`p-3 rounded-xl transition-all cursor-pointer border ${
                    orderFilterStage === 2
                      ? 'bg-[#f0ede9] border-[#180f0a]'
                      : 'bg-[#f6f3ee] hover:bg-[#f0ede9] border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase text-[#80756f]">Stage 02</span>
                    <span className="px-1.5 py-0.5 rounded-full bg-[#e5e2dd] text-[#180f0a] text-[10px] font-bold">
                      {counts.confirmed}
                    </span>
                  </div>
                  <div className="mt-3">
                    <span className="text-[13px] font-semibold text-[#180f0a] block">2. Confirmed</span>
                    <span className="text-[11px] text-[#80756f]">Stem assigned</span>
                  </div>
                </div>

                {/* Stage 3 (Active Highlight) */}
                <div
                  onClick={() => setOrderFilterStage(orderFilterStage === 3 ? null : 3)}
                  className="p-3 rounded-xl bg-[#2e241e] text-white flex flex-col justify-between shadow-md cursor-pointer relative overflow-hidden ring-2 ring-[#964735]/60"
                >
                  <div className="absolute right-0 top-0 w-12 h-12 bg-[#964735]/25 rounded-full blur-md"></div>
                  <div className="flex items-center justify-between relative z-10">
                    <span className="text-[10px] font-bold uppercase text-[#ffdad3]">Active Work</span>
                    <span className="px-1.5 py-0.5 rounded-full bg-[#964735] text-white text-[10px] font-bold">
                      {counts.inProduction}
                    </span>
                  </div>
                  <div className="mt-3 relative z-10">
                    <span className="text-[13px] font-bold text-white block">3. In Production</span>
                    <span className="text-[11px] text-[#ffdad3]/80">Pipe-cleaner craft</span>
                  </div>
                </div>

                {/* Stage 4 */}
                <div
                  onClick={() => setOrderFilterStage(orderFilterStage === 4 ? null : 4)}
                  className={`p-3 rounded-xl transition-all cursor-pointer border ${
                    orderFilterStage === 4
                      ? 'bg-[#f0ede9] border-[#180f0a]'
                      : 'bg-[#f6f3ee] hover:bg-[#f0ede9] border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase text-[#80756f]">Stage 04</span>
                    <span className="px-1.5 py-0.5 rounded-full bg-[#e5e2dd] text-[#180f0a] text-[10px] font-bold">
                      {counts.qualityCheck}
                    </span>
                  </div>
                  <div className="mt-3">
                    <span className="text-[13px] font-semibold text-[#180f0a] block">4. Quality Check</span>
                    <span className="text-[11px] text-[#80756f]">Petal inspection</span>
                  </div>
                </div>

                {/* Stage 5 */}
                <div
                  onClick={() => setOrderFilterStage(orderFilterStage === 5 ? null : 5)}
                  className={`p-3 rounded-xl transition-all cursor-pointer border ${
                    orderFilterStage === 5
                      ? 'bg-[#f0ede9] border-[#180f0a]'
                      : 'bg-[#f6f3ee] hover:bg-[#f0ede9] border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase text-[#80756f]">Stage 05</span>
                    <span className="px-1.5 py-0.5 rounded-full bg-[#e5e2dd] text-[#180f0a] text-[10px] font-bold">
                      {counts.readyToDispatch}
                    </span>
                  </div>
                  <div className="mt-3">
                    <span className="text-[13px] font-semibold text-[#180f0a] block">5. Ready to Dispatch</span>
                    <span className="text-[11px] text-[#80756f]">Wax seal & box</span>
                  </div>
                </div>

                {/* Stage 6 */}
                <div
                  onClick={() => setOrderFilterStage(orderFilterStage === 6 ? null : 6)}
                  className={`p-3 rounded-xl transition-all cursor-pointer border ${
                    orderFilterStage === 6
                      ? 'bg-[#f0ede9] border-[#180f0a]'
                      : 'bg-[#f6f3ee] hover:bg-[#f0ede9] border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase text-[#80756f]">Stage 06</span>
                    <span className="px-1.5 py-0.5 rounded-full bg-[#e5e2dd] text-[#180f0a] text-[10px] font-bold">
                      {counts.shipped}
                    </span>
                  </div>
                  <div className="mt-3">
                    <span className="text-[13px] font-semibold text-[#180f0a] block">6. Shipped</span>
                    <span className="text-[11px] text-[#80756f]">Handed to courier</span>
                  </div>
                </div>

                {/* Stage 7 */}
                <div
                  onClick={() => setOrderFilterStage(orderFilterStage === 7 ? null : 7)}
                  className={`p-3 rounded-xl transition-all cursor-pointer border ${
                    orderFilterStage === 7
                      ? 'bg-[#f0ede9] border-[#180f0a]'
                      : 'bg-[#f6f3ee] hover:bg-[#f0ede9] border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase text-[#80756f]">Stage 07</span>
                    <span className="px-1.5 py-0.5 rounded-full bg-[#e5e2dd] text-[#180f0a] text-[10px] font-bold">
                      {counts.delivered}
                    </span>
                  </div>
                  <div className="mt-3">
                    <span className="text-[13px] font-semibold text-[#180f0a] block">7. Delivered</span>
                    <span className="text-[11px] text-[#80756f]">Archived delivery</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Two-Column Operational Workspace (7 cols & 5 cols) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8">
              {/* LEFT COLUMN: Recent Orders & Revenue (7 cols) */}
              <div className="lg:col-span-7 space-y-8 min-w-0">
                {/* SECTION A: RECENT ORDERS TABLE */}
                <div data-dash-panel className="bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="font-serif text-xl text-[#180f0a] font-medium">
                        Recent Orders
                      </h2>
                      <p className="text-[13px] text-[#4e4540]">
                        Latest incoming client commissions and deliveries.
                      </p>
                    </div>
                    <Link to="/admin/orders"
                      className="text-[#964735] hover:text-[#180f0a] text-[13px] font-semibold transition-colors flex items-center gap-1"
                    >
                      View All Orders
                      <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                    </Link>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[13px] border-collapse">
                      <thead>
                        <tr className="text-[#80756f] text-[11px] font-bold uppercase tracking-wider border-b border-[#e5e2dd]">
                          <th className="py-2.5 px-2">Order ID</th>
                          <th className="py-2.5 px-2">Customer</th>
                          <th className="py-2.5 px-2">Items</th>
                          <th className="py-2.5 px-2 text-right">Amount</th>
                          <th className="py-2.5 px-2">Status</th>
                          <th className="py-2.5 px-2">Date</th>
                          <th className="py-2.5 px-2 text-center">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#f6f3ee] text-[#1c1c19]">
                        {recentOrders.map((order) => (
                          <tr key={order.id} className="hover:bg-[#f6f3ee]/50 transition-colors group">
                            <td className="py-3 px-2 font-semibold text-[#180f0a]">{order.id}</td>
                            <td className="py-3 px-2 font-medium">{order.customer}</td>
                            <td className="py-3 px-2 text-[#4e4540] truncate max-w-[130px]" title={order.items}>
                              {order.items}
                            </td>
                            <td className="py-3 px-2 font-semibold text-right text-[#180f0a]">{order.amount}</td>
                            <td className="py-3 px-2">
                              <AdminOrderStatusPill status={order.status} />
                            </td>
                            <td className="py-3 px-2 text-[12px] text-[#80756f]">{order.date}</td>
                            <td className="py-3 px-2 text-center">
                              <Link
                                to={`/admin/orders/${order.id}`}
                                className="p-1 rounded hover:bg-[#ebe8e3] text-[#80756f] group-hover:text-[#180f0a] transition-colors inline-flex"
                                title="Open Order"
                              >
                                <span className="material-symbols-outlined text-[18px]">visibility</span>
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* SECTION B: REVENUE OVERVIEW (Chart Card) */}
                <div data-dash-panel className="bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] p-6">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
                    <div>
                      <h2 className="font-serif text-xl text-[#180f0a] font-medium">
                        Revenue Overview
                      </h2>
                      <div className="flex items-baseline gap-2 mt-1">
                        <span className="font-serif text-2xl sm:text-3xl text-[#180f0a] font-semibold leading-none">
                          {currentRevenue.total}
                        </span>
                        <span className="text-[13px] text-[#80756f]">{currentRevenue.avg}</span>
                      </div>
                    </div>

                    {/* Period Switcher Tabs */}
                    <div className="flex items-center p-0.5 rounded-full bg-[#f0ede9] self-start sm:self-auto">
                      <button
                        type="button"
                        onClick={() => setRevenuePeriod('7d')}
                        className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-all ${
                          revenuePeriod === '7d'
                            ? 'bg-white text-[#180f0a] shadow-xs'
                            : 'text-[#4e4540] hover:text-[#180f0a]'
                        }`}
                      >
                        7 Days
                      </button>
                      <button
                        type="button"
                        onClick={() => setRevenuePeriod('30d')}
                        className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-all ${
                          revenuePeriod === '30d'
                            ? 'bg-white text-[#180f0a] shadow-xs'
                            : 'text-[#4e4540] hover:text-[#180f0a]'
                        }`}
                      >
                        30 Days
                      </button>
                      <button
                        type="button"
                        onClick={() => setRevenuePeriod('3m')}
                        className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-all ${
                          revenuePeriod === '3m'
                            ? 'bg-white text-[#180f0a] shadow-xs'
                            : 'text-[#4e4540] hover:text-[#180f0a]'
                        }`}
                      >
                        3 Months
                      </button>
                    </div>
                  </div>

                  {/* Visual Bar Chart */}
                  <div className="w-full pt-4">
                    <div className="h-44 w-full flex items-end justify-between gap-3 px-2 border-b border-[#f0ede9] pb-2">
                      {currentRevenue.bars.map((bar, idx) => (
                        <div key={idx} className="flex-1 flex flex-col items-center gap-2 h-full justify-end group cursor-pointer">
                          <div
                            className={`w-full max-w-[38px] rounded-t transition-all relative ${
                              bar.isCurrent
                                ? 'bg-[#180f0a] shadow-md group-hover:bg-[#2e241e]'
                                : bar.isSpecial
                                ? 'bg-[#964735] shadow-xs group-hover:bg-[#783020]'
                                : 'bg-[#ebe8e3] group-hover:bg-[#d1c4bd]'
                            }`}
                            style={{ height: bar.height }}
                          >
                            {bar.isCurrent && (
                              <div className="absolute -top-7 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-[#180f0a] text-white text-[9px] font-bold whitespace-nowrap shadow-sm">
                                {bar.val}
                              </div>
                            )}
                          </div>
                          <span
                            className={`text-[10px] font-bold ${
                              bar.isCurrent
                                ? 'text-[#180f0a]'
                                : bar.isSpecial
                                ? 'text-[#964735]'
                                : 'text-[#80756f]'
                            }`}
                          >
                            {bar.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* RIGHT COLUMN: Tasks, Alerts & Shortcuts (5 cols) */}
              <div className="lg:col-span-5 space-y-8 min-w-0">
                {/* CARD 1: TODAY'S CRAFTING QUEUE */}
                <div data-dash-panel className="bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-[20px] text-[#180f0a]">draw</span>
                      <h2 className="font-serif text-xl text-[#180f0a] font-medium">
                        Today’s Crafting Queue
                      </h2>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-[#ffdad3] text-[#783020] text-[10px] font-bold">
                      {craftingTasks.filter((t) => t.status === 'pending').length} pending
                    </span>
                  </div>

                  <div className="space-y-3">
                    {craftingTasks.map((task) => (
                      <div
                        key={task.id}
                        className={`p-3.5 rounded-xl border transition-all space-y-2 ${
                          task.status === 'completed'
                            ? 'bg-[#f6f3ee]/40 border-[#e5e2dd] opacity-70'
                            : 'bg-[#f6f3ee] hover:bg-[#f0ede9] border-[#e5e2dd]/60'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[12px] font-bold text-[#180f0a]">{task.title}</span>
                          <span className={`px-2 py-0.5 rounded text-[9px] uppercase font-bold ${task.priorityColor}`}>
                            {task.priority}
                          </span>
                        </div>
                        <div className="text-[12px] text-[#4e4540] flex flex-col gap-0.5">
                          <span>
                            Palette: <strong className="text-[#1c1c19]">{task.palette}</strong>
                          </span>
                          {task.transcript && (
                            <span className="italic text-[11px] text-[#80756f]">{task.transcript}</span>
                          )}
                        </div>
                        <div className="pt-1 flex items-center justify-between">
                          <span className="text-[11px] text-[#80756f] flex items-center gap-1">
                            <span className="material-symbols-outlined text-[14px]">timer</span>
                            {task.due}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleTaskAction(task.id)}
                            disabled={task.status === 'completed'}
                            className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-all ${
                              task.status === 'completed'
                                ? 'bg-[#d8e7cd] text-[#3d4a37]'
                                : task.id === 'FA-1048'
                                ? 'bg-[#180f0a] text-white hover:bg-[#964735]'
                                : 'bg-white text-[#180f0a] hover:bg-[#f0ede9] shadow-xs border border-[#d1c4bd]'
                            }`}
                          >
                            {task.actionText}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* CARD 2: LOW STOCK ALERTS */}
                <div data-dash-panel className="bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-[20px] text-[#ba1a1a]">warning</span>
                      <h2 className="font-serif text-xl text-[#180f0a] font-medium">
                        Low Stock Alerts
                      </h2>
                    </div>
                    <Link to="/admin/inventory"
                      className="text-[#964735] hover:text-[#180f0a] text-[12px] font-semibold transition-colors flex items-center gap-0.5"
                    >
                      Manage Inventory
                      <span className="material-symbols-outlined text-[15px]">arrow_forward</span>
                    </Link>
                  </div>

                  <div className="space-y-2">
                    {lowStockItems.length > 0 ? (
                      lowStockItems.map((item) => {
                        const isCritical = item.status === 'Critical' || item.status === 'Out of Stock';
                        return (
                          <div key={item.productSlug} className="p-2 flex items-center justify-between rounded-lg hover:bg-[#f6f3ee] transition-colors">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`w-2 h-2 rounded-full ${isCritical ? 'bg-[#ba1a1a] animate-ping' : 'bg-[#964735]'} shrink-0`}></span>
                              <span className="text-[13px] font-medium text-[#1c1c19] truncate">
                                {item.productName}
                              </span>
                            </div>
                            <span className={`text-[10px] font-bold whitespace-nowrap px-2 py-0.5 rounded-full ${isCritical ? 'bg-[#ffdad6] text-[#ba1a1a]' : 'bg-[#ffdad3] text-[#783020]'}`}>
                              {item.status} · {item.currentStock} {item.unit} left
                            </span>
                          </div>
                        );
                      })
                    ) : (
                      <div className="p-4 text-center text-[13px] text-[#80756f]">
                        No low stock items at the moment.
                      </div>
                    )}
                  </div>
                </div>

                {/* CARD 3: OPERATIONS SHORTCUTS */}
                <div data-dash-panel className="bg-white rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] p-6">
                  <h2 className="font-serif text-xl text-[#180f0a] font-medium mb-3">
                    Operations Shortcuts
                  </h2>
                  <div className="grid grid-cols-2 gap-3">
                    <Link to="/admin/orders"
                      className="p-3.5 rounded-xl bg-[#f6f3ee] hover:bg-[#ebe8e3] transition-all text-left flex flex-col justify-between group border border-[#e5e2dd]/40 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[20px] text-[#180f0a] group-hover:text-[#964735] transition-colors">
                        add_shopping_cart
                      </span>
                      <span className="mt-2 text-[13px] font-semibold text-[#180f0a]">Create Order</span>
                    </Link>

                    <Link to="/admin/products"
                      className="p-3.5 rounded-xl bg-[#f6f3ee] hover:bg-[#ebe8e3] transition-all text-left flex flex-col justify-between group border border-[#e5e2dd]/40 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[20px] text-[#180f0a] group-hover:text-[#964735] transition-colors">
                        post_add
                      </span>
                      <span className="mt-2 text-[13px] font-semibold text-[#180f0a]">Add Product</span>
                    </Link>

                    <Link to="/admin/inventory"
                      className="p-3.5 rounded-xl bg-[#f6f3ee] hover:bg-[#ebe8e3] transition-all text-left flex flex-col justify-between group border border-[#e5e2dd]/40 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[20px] text-[#180f0a] group-hover:text-[#964735] transition-colors">
                        edit_note
                      </span>
                      <span className="mt-2 text-[13px] font-semibold text-[#180f0a]">Update Inventory</span>
                    </Link>

                    <button
                      type="button"
                      onClick={() => {
                        const orders = getOrders();
                        const rows = [['Order ID', 'Customer', 'Amount', 'Status']];
                        orders.forEach(o => rows.push([o.id, o.customerName || 'Guest', formatINR(o.total || 0), o.orderStatus || 'new']));
                        const csv = rows.map(r => r.join(',')).join('\n');
                        const blob = new Blob([csv], { type: 'text/csv' });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = 'flora_alchemy_summary.csv';
                        link.click();
                        URL.revokeObjectURL(url);
                      }}
                      className="p-3.5 rounded-xl bg-[#f6f3ee] hover:bg-[#ebe8e3] transition-all text-left flex flex-col justify-between group border border-[#e5e2dd]/40 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[20px] text-[#180f0a] group-hover:text-[#964735] transition-colors">
                        ios_share
                      </span>
                      <span className="mt-2 text-[13px] font-semibold text-[#180f0a]">Export Summary</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

      </div>
    </AdminLayout>
  );
}
