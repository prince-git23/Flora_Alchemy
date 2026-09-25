import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import {
  getOrders,
  getStatusCounts,
  formatINR,
  formatDate,
} from '../../services/orderService.js';
import { getLowStockItems } from '../../services/inventoryService.js';
import { getOperators } from '../../services/adminUserService.js';
import { getAllCustomRequests } from '../../services/customRequestService.js';
import { AdminOrderStatusPill } from '../../components/admin/AdminStatusPill.jsx';

/* ── GSAP ── */
import gsap from 'gsap';

/**
 * Phase 20.6.2 — Admin Dashboard (design ref: "Admin Dashboard" console).
 *
 * Every number on this screen comes from a real API slice:
 *   · Orders Requiring Attention → orders currently in the crafting pipeline
 *     (new / confirmed / in_production / quality_check)
 *   · Low Stock Alerts          → inventory rows at or below reorder level
 *   · Active Handlers           → /api/admin/users (role=handler, ACTIVE)
 *   · Awaiting Review           → /api/custom-requests (pending / reviewing)
 *   · Craft Queue               → the real orders in the pipeline
 *   · Staff Snapshot            → the real operator roster
 *   · Material Restock          → real stock levels vs reorder thresholds
 *   · Atelier Activity          → real order statusHistory entries
 *     (status · note · changedBy · timestamp) recorded by the backend
 *
 * Nothing here is invented: empty states are shown as empty, and every action
 * opens the real record it refers to.
 */

const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const PIPELINE_STAGES = ['new', 'confirmed', 'in_production', 'quality_check'];

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

function roleLabelOf(role) {
  const r = String(role || '').toUpperCase();
  if (r === 'ADMINISTRATOR' || r === 'ADMIN') return 'Administrator';
  if (r === 'HANDLER') return 'Handler';
  return r || 'Staff';
}

function initialsOf(name, email) {
  const source = String(name || email || '').trim();
  if (!source) return 'FA';
  const parts = source.includes('@') ? [source.split('@')[0]] : source.split(/\s+/);
  return (parts.filter(Boolean).slice(0, 2).map((p) => p[0]).join('') || 'FA').toUpperCase();
}

/** KPI card — one real metric, its real breakdown, and an honest status line. */
function KpiCard({ label, icon, tone, value, suffix, caption, footer }) {
  const chip = tone === 'danger'
    ? 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)]'
    : tone === 'success'
    ? 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae]'
    : tone === 'accent'
    ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] dark:bg-[#3a241c] dark:text-[#ffb9ab]'
    : 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] dark:text-[#f2efe9]';
  const halo = tone === 'danger'
    ? 'bg-[var(--color-danger-soft-bg)]/25'
    : tone === 'success'
    ? 'bg-[var(--color-botanical-sage-light)]/25'
    : tone === 'accent'
    ? 'bg-[var(--color-badge-bg)]/25'
    : 'bg-[var(--color-surface-highest)]/40';

  return (
    <div className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-2xl p-5 shadow-sm flex flex-col justify-between gap-3 relative overflow-hidden border border-[var(--color-botanical-border)] dark:border-[#3a3530]" data-dash-kpi>
      <div className={`absolute -right-3 -top-3 w-16 h-16 rounded-full ${halo} pointer-events-none`}></div>
      <div className="flex items-center justify-between gap-3 z-10">
        <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">{label}</span>
        <span className={`w-8 h-8 rounded-full ${chip} flex items-center justify-center shrink-0`}>
          <span className="material-symbols-outlined text-[18px]">{icon}</span>
        </span>
      </div>
      <div className="z-10">
        <div className="flex items-baseline gap-2">
          <span className="font-serif text-[40px] leading-[48px] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">{value}</span>
          {suffix && <span className="text-[18px] leading-[26px] font-semibold text-[var(--color-botanical-subtle)]">{suffix}</span>}
        </div>
        <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-1">{caption}</p>
      </div>
      {footer && (
        <div className="z-10 pt-1 text-[11px] leading-4 font-bold uppercase tracking-[0.06em] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] flex items-center gap-1.5">
          {footer}
        </div>
      )}
    </div>
  );
}

export default function AdminDashboardPage() {
  const storeVersion = useStoreVersion();
  const navigate = useNavigate();
  const { session } = useAdminSession();
  const pageRef = useRef(null);

  const orders = useMemo(() => getOrders(), [storeVersion]);
  const counts = useMemo(() => getStatusCounts(), [storeVersion]);
  const lowStock = useMemo(() => getLowStockItems(), [storeVersion]);

  // Real staff roster (async — admin-scoped API).
  const [operators, setOperators] = useState([]);
  const [staffLoaded, setStaffLoaded] = useState(false);
  // Real custom requests (async — staff-scoped API).
  const [requests, setRequests] = useState([]);
  const [requestsLoaded, setRequestsLoaded] = useState(false);

  const [staffFilter, setStaffFilter] = useState('all');
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getOperators({})
      .then((list) => { if (!cancelled) { setOperators(Array.isArray(list) ? list : []); setStaffLoaded(true); } })
      .catch(() => { if (!cancelled) setStaffLoaded(true); });
    getAllCustomRequests()
      .then((list) => { if (!cancelled) { setRequests(Array.isArray(list) ? list : []); setRequestsLoaded(true); } })
      .catch(() => { if (!cancelled) setRequestsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (prefersReduced || !pageRef.current) return undefined;
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

  const triggerToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // ── Attention: orders in the crafting pipeline (real stages) ──
  const pipelineOrders = useMemo(
    () => orders
      .filter((o) => PIPELINE_STAGES.includes(o.orderStatus))
      .sort((a, b) => {
        const rank = (s) => PIPELINE_STAGES.indexOf(s);
        if (rank(a.orderStatus) !== rank(b.orderStatus)) return rank(a.orderStatus) - rank(b.orderStatus);
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      }),
    [orders]
  );
  const attentionTotal = pipelineOrders.length;
  const attentionCaption = [
    counts.new ? `${counts.new} new` : null,
    counts.inProduction ? `${counts.inProduction} in production` : null,
    counts.qualityCheck ? `${counts.qualityCheck} in QC` : null,
  ].filter(Boolean).join(' · ') || 'Pipeline is clear';

  // ── Custom requests awaiting review (real statuses) ──
  const awaitingReview = useMemo(
    () => requests.filter((r) => r.status === 'pending' || r.status === 'reviewing'),
    [requests]
  );
  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const reviewingCount = requests.filter((r) => r.status === 'reviewing').length;

  // ── Staff (real roster) ──
  const staffCounts = useMemo(() => {
    const admins = operators.filter((o) => roleLabelOf(o.role) === 'Administrator');
    const handlers = operators.filter((o) => roleLabelOf(o.role) === 'Handler');
    const active = operators.filter((o) => String(o.status || 'ACTIVE').toUpperCase() === 'ACTIVE');
    const suspended = operators.filter((o) => String(o.status || '').toUpperCase() === 'SUSPENDED');
    return { admins, handlers, active, suspended };
  }, [operators]);

  const filteredStaff = useMemo(() => {
    if (staffFilter === 'admins') return staffCounts.admins;
    if (staffFilter === 'handlers') return staffCounts.handlers;
    if (staffFilter === 'suspended') return staffCounts.suspended;
    return operators;
  }, [staffFilter, operators, staffCounts]);

  // ── Atelier Activity: real order status history (status · note · who · when) ──
  const activity = useMemo(() => {
    const events = [];
    orders.forEach((o) => {
      (o.statusHistory || []).forEach((h, idx) => {
        if (!h || !h.at) return;
        events.push({
          key: `${o.id}-${idx}-${h.at}`,
          orderId: o.id,
          status: h.status,
          note: h.note || '',
          by: h.changedBy || '',
          at: h.at,
        });
      });
    });
    return events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 4);
  }, [orders]);

  const handleExportQueue = () => {
    const rows = [
      ['Order', 'Status', 'Customer', 'Items', 'Total', 'Created'],
      ...pipelineOrders.map((o) => [
        o.id,
        o.orderStatus,
        o.customerName || 'Guest',
        o.items.map((i) => `${i.name} x${i.quantity}`).join(' | '),
        o.total,
        o.createdAt || '',
      ]),
    ];
    const csv = 'data:text/csv;charset=utf-8,' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const link = document.createElement('a');
    link.setAttribute('href', encodeURI(csv));
    link.setAttribute('download', 'flora_alchemy_craft_queue.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    triggerToast(`Exported ${pipelineOrders.length} pipeline order(s).`);
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (session?.name || '').split(/\s+/)[0] || 'there';
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

  const lowStockNames = lowStock.slice(0, 2).map((i) => i.productName).join(', ');
  const featured = pipelineOrders[0];

  return (
    <AdminLayout>
      <div ref={pageRef} className="max-w-7xl mx-auto space-y-6 sm:space-y-8 pb-8 sm:pb-12">

        {/* ── Header ── */}
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-5">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--color-surface-high)] dark:bg-[#37332c] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]"></span>
              <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em]">Administrative Management Console</span>
            </div>
            <h1 className="font-serif text-[40px] leading-[48px] tracking-[-0.015em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
              {greeting}, {firstName}
            </h1>
            <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
              Here’s what’s happening across your Flora Alchemy workshop operations — {today}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleExportQueue}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-[13px] leading-[18px] font-semibold shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] hover:bg-[var(--color-surface-high)] dark:hover:bg-[#33302a] transition-all"
            >
              <span className="material-symbols-outlined text-[18px] text-[var(--color-botanical-subtle)]">file_download</span>
              Export Craft Queue
            </button>
            <Link
              to="/admin/access"
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] leading-[18px] font-semibold shadow-md hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] transition-all active:translate-y-px"
            >
              <span className="material-symbols-outlined text-[18px]">person_add</span>
              + Add Handler
            </Link>
          </div>
        </header>

        {/* ── KPI grid (every number real) ── */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="Orders Requiring Attention"
            icon="priority_high"
            tone="accent"
            value={attentionTotal}
            caption={attentionCaption}
            footer={<><span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse"></span>In the crafting pipeline</>}
          />
          <KpiCard
            label="Low Stock Alerts"
            icon="inventory_2"
            tone="danger"
            value={lowStock.length}
            suffix={lowStock.length === 1 ? 'Material' : 'Materials'}
            caption={lowStockNames ? `${lowStockNames}${lowStock.length > 2 ? `, +${lowStock.length - 2} more` : ''}` : 'All materials above reorder level'}
            footer={<span>{lowStock.length > 0 ? 'At or below reorder threshold' : 'Stock levels healthy'}</span>}
          />
          <KpiCard
            label="Active Operational Handlers"
            icon="nature_people"
            tone="success"
            value={staffCounts.handlers.filter((h) => String(h.status || 'ACTIVE').toUpperCase() === 'ACTIVE').length}
            suffix="Active"
            caption={staffLoaded
              ? `${staffCounts.handlers.length} handler${staffCounts.handlers.length === 1 ? '' : 's'} · ${staffCounts.admins.length} administrator${staffCounts.admins.length === 1 ? '' : 's'} on the roster`
              : 'Loading staff roster…'}
            footer={<><span className="w-2 h-2 rounded-full bg-[var(--color-botanical-sage)]"></span>{staffCounts.suspended.length} suspended</>}
          />
          <KpiCard
            label="Custom Requests Awaiting Review"
            icon="checklist"
            tone="neutral"
            value={awaitingReview.length}
            suffix={awaitingReview.length === 1 ? 'Request' : 'Requests'}
            caption={requestsLoaded
              ? (awaitingReview.length
                ? `${pendingCount} pending · ${reviewingCount} in review`
                : 'No bespoke requests waiting')
              : 'Loading custom requests…'}
            footer={<span>{requests.length} total request{requests.length === 1 ? '' : 's'} recorded</span>}
          />
        </section>

        {/* ── Two-column operations layout ── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

          {/* ── Main column ── */}
          <div className="lg:col-span-8 flex flex-col gap-8 min-w-0">

            {/* Priority Orders & Craft Queue */}
            <section className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl p-5 xl:p-8 shadow-sm space-y-6 border border-[var(--color-botanical-border)] dark:border-[#3a3530]" data-dash-panel>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[var(--color-accent)] text-[20px]">palette</span>
                    <h2 className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">Priority Orders &amp; Craft Queue</h2>
                  </div>
                  <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-0.5">Bespoke commissions currently moving through the atelier</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.06em] bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] dark:bg-[#3a241c] dark:text-[#ffb9ab] px-3 py-1 rounded-full">
                    {attentionTotal} in pipeline
                  </span>
                  <Link to="/admin/orders" className="p-1.5 rounded-full hover:bg-[var(--color-surface-low)] dark:hover:bg-[#26221e] text-[var(--color-botanical-muted)]" title="All orders">
                    <span className="material-symbols-outlined text-[20px]">tune</span>
                  </Link>
                </div>
              </div>

              {featured ? (
                <>
                  {/* Featured queue item */}
                  <div className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-xl p-4 xl:p-5 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0 shadow-sm bg-[var(--color-surface-high)] dark:bg-[#37332c] flex items-center justify-center">
                        {featured.items[0]?.image ? (
                          <img className="w-full h-full object-cover" alt={featured.items[0].name} src={featured.items[0].image} />
                        ) : (
                          <span className="material-symbols-outlined text-[26px] text-[var(--color-accent)]">local_florist</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[11px] leading-4 font-bold uppercase bg-[var(--color-surface-highest)] dark:bg-[#454038] text-[var(--color-botanical-text)] dark:text-[#f2efe9] px-2 py-0.5 rounded">{featured.id}</span>
                          <AdminOrderStatusPill status={featured.orderStatus} />
                        </div>
                        <h3 className="text-[18px] leading-[26px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] mt-1 truncate">
                          {featured.items[0]?.name || 'Handcrafted commission'}
                          {featured.items.length > 1 ? ` +${featured.items.length - 1}` : ''}
                        </h3>
                        <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                          Client: <span className="font-medium text-[var(--color-botanical-text)] dark:text-[#f2efe9]">{featured.customerName || 'Guest'}</span> · {formatDate(featured.createdAt)} · {formatINR(featured.total)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 w-full md:w-auto justify-between md:justify-end">
                      <div className="flex flex-col md:items-end">
                        <span className="text-[13px] leading-[18px] font-semibold text-[var(--color-accent)]">{featured.items[0]?.palette || 'Atelier palette'}</span>
                        <span className="text-[11px] leading-4 font-bold uppercase text-[var(--color-botanical-subtle)] mt-0.5">
                          {featured.statusHistory?.[featured.statusHistory.length - 1]?.changedBy
                            ? `Last: ${featured.statusHistory[featured.statusHistory.length - 1].changedBy}`
                            : 'Awaiting assignment'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => navigate(`/admin/orders/${featured.id}`)}
                        className="px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] leading-[18px] font-semibold hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] shadow-sm transition-transform active:translate-y-px"
                      >
                        Inspect
                      </button>
                    </div>
                  </div>

                  {/* Remaining queue rows */}
                  {pipelineOrders.length > 1 && (
                    <div className="space-y-1">
                      {pipelineOrders.slice(1, 5).map((o) => (
                        <div key={o.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl hover:bg-[var(--color-surface-low)] dark:hover:bg-[#26221e] transition-colors gap-3">
                          <div className="flex items-center gap-4 min-w-0">
                            <div className="w-10 h-10 rounded-lg bg-[var(--color-surface-container)] dark:bg-[#2e2a25] flex items-center justify-center shrink-0 text-[var(--color-accent)]">
                              <span className="material-symbols-outlined text-[20px]">{o.orderStatus === 'quality_check' ? 'search' : 'local_florist'}</span>
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] leading-4 font-bold uppercase text-[var(--color-botanical-subtle)]">{o.id}</span>
                                <span className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate">
                                  {o.items[0]?.name || 'Handcrafted commission'}{o.items.length > 1 ? ` +${o.items.length - 1}` : ''}
                                </span>
                              </div>
                              <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] truncate">
                                {o.customerName || 'Guest'} · {formatDate(o.createdAt)} · {formatINR(o.total)}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center justify-between sm:justify-end gap-4">
                            <AdminOrderStatusPill status={o.orderStatus} />
                            <button
                              type="button"
                              onClick={() => navigate(`/admin/orders/${o.id}`)}
                              className="text-[13px] leading-[18px] font-semibold text-[var(--color-accent)] hover:underline"
                            >
                              Inspect →
                            </button>
                          </div>
                        </div>
                      ))}
                      {pipelineOrders.length > 5 && (
                        <Link to="/admin/orders" className="block text-center pt-2 text-[13px] leading-[18px] font-semibold text-[var(--color-accent)] hover:underline">
                          View all {pipelineOrders.length} pipeline orders →
                        </Link>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="py-10 text-center space-y-2">
                  <span className="material-symbols-outlined text-[36px] text-[var(--color-botanical-subtle)]">task_alt</span>
                  <p className="text-[15px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">No orders are in the crafting pipeline right now.</p>
                  <Link to="/admin/orders" className="inline-block text-[13px] font-semibold text-[var(--color-accent)] hover:underline">Open the order book →</Link>
                </div>
              )}
            </section>

            {/* Staff snapshot */}
            <section className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl p-5 xl:p-8 shadow-sm space-y-6 border border-[var(--color-botanical-border)] dark:border-[#3a3530]" data-dash-panel>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] text-[20px]">badge</span>
                    <h2 className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">My Staff Snapshot</h2>
                  </div>
                  <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-0.5">Live roster from staff access management</p>
                </div>
                <Link
                  to="/admin/access"
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-[var(--color-surface-high)] dark:bg-[#37332c] text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-[13px] leading-[18px] font-semibold hover:bg-[var(--color-surface-highest)] transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span> + Add Handler
                </Link>
              </div>

              {/* Real counts per filter */}
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {[
                  { key: 'all', label: `All Staff [${operators.length}]` },
                  { key: 'handlers', label: `Handlers [${staffCounts.handlers.length}]` },
                  { key: 'admins', label: `Administrators [${staffCounts.admins.length}]` },
                  { key: 'suspended', label: `Suspended [${staffCounts.suspended.length}]` },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setStaffFilter(tab.key)}
                    className={`px-4 py-1.5 rounded-full text-[13px] leading-[18px] font-semibold shrink-0 transition-colors ${
                      staffFilter === tab.key
                        ? 'bg-[var(--color-btn)] text-white dark:bg-[#964735]'
                        : 'bg-[var(--color-surface-container)] dark:bg-[#2e2a25] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] hover:bg-[var(--color-surface-high)]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="space-y-1">
                {!staffLoaded && (
                  <p className="py-6 text-center text-[15px] text-[var(--color-botanical-muted)]">Loading staff roster…</p>
                )}
                {staffLoaded && filteredStaff.length === 0 && (
                  <p className="py-6 text-center text-[15px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">No staff accounts match this filter.</p>
                )}
                {staffLoaded && filteredStaff.slice(0, 5).map((op) => {
                  const active = String(op.status || 'ACTIVE').toUpperCase() === 'ACTIVE';
                  return (
                    <div key={op.id || op.email} className="flex items-center justify-between p-4 rounded-xl bg-[var(--color-surface-low)] dark:bg-[#26221e] hover:bg-[var(--color-surface-container)] dark:hover:bg-[#2e2a25] transition-colors gap-3">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-10 h-10 rounded-full bg-[#2e241e] text-[#f1dfd5] flex items-center justify-center text-[13px] leading-[18px] font-semibold shrink-0">
                          {initialsOf(op.name, op.email)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[18px] leading-[26px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate">{op.name || op.email}</span>
                            <span className="text-[11px] leading-4 font-bold uppercase text-[var(--color-botanical-subtle)]">{roleLabelOf(op.role)}</span>
                          </div>
                          <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] truncate">{op.email}</p>
                        </div>
                      </div>
                      <span className={`text-[11px] leading-4 font-bold uppercase tracking-[0.06em] px-3 py-1 rounded-full flex items-center gap-1.5 shrink-0 ${
                        active
                          ? 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae]'
                          : 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)]'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-[var(--color-botanical-sage)]' : 'bg-[var(--color-danger)]'}`}></span>
                        {active ? 'Active' : 'Suspended'}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                  Showing {Math.min(filteredStaff.length, 5)} of {filteredStaff.length} staff
                </span>
                <Link to="/admin/access" className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] hover:text-[var(--color-accent)] inline-flex items-center gap-1">
                  Open staff access management
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </Link>
              </div>
            </section>
          </div>

          {/* ── Aside column ── */}
          <div className="lg:col-span-4 flex flex-col gap-8 min-w-0">

            {/* Material restock */}
            <section className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl p-5 xl:p-6 shadow-sm space-y-6 border border-[var(--color-botanical-border)] dark:border-[#3a3530]" data-dash-panel>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[var(--color-accent)] text-[20px]">shelves</span>
                  <h2 className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">Material Restock</h2>
                </div>
                {lowStock.length > 0 && (
                  <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.06em] bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] px-2 py-0.5 rounded-full">{lowStock.length} low</span>
                )}
              </div>
              <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] -mt-3">
                Crafting supplies at or below their reorder threshold.
              </p>

              {lowStock.length === 0 && (
                <p className="py-4 text-center text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                  Every material is above its reorder level.
                </p>
              )}

              {lowStock.slice(0, 3).map((item) => {
                const pct = item.reorderLevel > 0
                  ? Math.min(100, Math.round((item.currentStock / item.reorderLevel) * 100))
                  : null;
                const critical = item.status === 'Critical' || item.currentStock <= 0;
                return (
                  <div key={item.productId || item.productName} className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-xl p-4 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate" title={item.productName}>{item.productName}</span>
                      <span className={`text-[11px] leading-4 font-bold uppercase shrink-0 ${critical ? 'text-[var(--color-danger)]' : 'text-[var(--color-accent)]'}`}>{item.status}</span>
                    </div>
                    <div className="w-full bg-[var(--color-surface-high)] dark:bg-[#37332c] h-1.5 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${critical ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-accent)]'}`} style={{ width: `${pct === null ? 4 : Math.max(4, pct)}%` }}></div>
                    </div>
                    <div className="flex items-center justify-between text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                      <span>Remaining: {item.currentStock} {item.unit}</span>
                      <span className="font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">Threshold: {item.reorderLevel}</span>
                    </div>
                    <Link
                      to="/admin/inventory"
                      className="block w-full mt-1 py-1.5 rounded-lg bg-[var(--color-surface-highest)] dark:bg-[#454038] hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-[11px] leading-4 font-bold uppercase tracking-[0.06em] text-center transition-colors"
                    >
                      Adjust stock
                    </Link>
                  </div>
                );
              })}
              <Link to="/admin/inventory" className="block text-center text-[13px] leading-[18px] font-semibold text-[var(--color-accent)] hover:underline">
                Open inventory &amp; stock →
              </Link>
            </section>

            {/* Atelier activity — real order status history */}
            <section className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl p-5 xl:p-6 shadow-sm space-y-6 border border-[var(--color-botanical-border)] dark:border-[#3a3530]" data-dash-panel>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[var(--color-botanical-subtle)] text-[20px]">history_edu</span>
                  <h2 className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">Atelier Activity</h2>
                </div>
                <span className="w-2 h-2 rounded-full bg-[var(--color-accent)]"></span>
              </div>

              {activity.length === 0 ? (
                <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                  No order activity recorded yet — status changes appear here as the atelier progresses orders.
                </p>
              ) : (
                <div className="relative pl-6 space-y-5 before:content-[''] before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-[var(--color-surface-high)] dark:before:bg-[#37332c]">
                  {activity.map((ev, idx) => (
                    <div key={ev.key} className="relative space-y-1">
                      <span className={`absolute -left-6 top-1 w-3 h-3 rounded-full ${idx === 0 ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-botanical-sage)]'}`}></span>
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => navigate(`/admin/orders/${ev.orderId}`)}
                          className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] text-left hover:text-[var(--color-accent)]"
                        >
                          {ev.orderId} · {ev.status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                        </button>
                        <span className="text-[11px] leading-4 font-bold uppercase text-[var(--color-botanical-subtle)] shrink-0">{timeAgo(ev.at)}</span>
                      </div>
                      <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                        {ev.note || `Order moved to ${ev.status.replace(/_/g, ' ')}.`}
                        {ev.by ? ` — ${ev.by}` : ''}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              <Link
                to="/admin/orders"
                className="block w-full py-2.5 rounded-full bg-[var(--color-surface-low)] dark:bg-[#26221e] hover:bg-[var(--color-surface-container)] dark:hover:bg-[#2e2a25] text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-[13px] leading-[18px] font-semibold transition-colors text-center"
              >
                View the full order book →
              </Link>
            </section>
          </div>
        </div>
      </div>

      {/* Inline toast for real actions */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] border border-[var(--color-botanical-border)] dark:border-[#3a3530] shadow-lg rounded-xl px-4 py-3 flex items-center gap-2 max-w-xs" role="status">
          <span className="material-symbols-outlined text-[18px] text-[var(--color-success-soft-fg)] dark:text-[#93ab87]">check_circle</span>
          <span className="text-[13px] leading-5 text-[var(--color-botanical-text)] dark:text-[#f2efe9]">{toast}</span>
        </div>
      )}
    </AdminLayout>
  );
}
