import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { getOrders, getStatusCounts, formatDate } from '../../services/orderService.js';
import { getLowStockItems } from '../../services/inventoryService.js';
import { getUnreadCount } from '../../services/conversationService.js';
import { getAllCustomRequests } from '../../services/customRequestService.js';
import { AdminOrderStatusPill } from '../../components/admin/AdminStatusPill.jsx';

/**
 * Phase 20.6.3 / Phase 21 â€” Handler Dashboard (design ref: "Handler Dashboard").
 *
 * The operational counterpart to the admin console: a handler sees the work in
 * front of them, not the business. Deliberately ABSENT â€” and this is a
 * permission boundary, not a styling choice:
 *   Â· staff directory / personnel lifecycle
 *   Â· administrator or owner controls
 *   Â· admin applications
 *   Â· permission management
 * The backend refuses all of those anyway (403); this screen simply never
 * offers them, and it never calls an admin-scoped endpoint (note that unlike
 * the admin console it does not request /api/admin/users at all).
 *
 * Every number is a real slice of the shared operational store:
 *   Today's Orders            â†’ orders whose createdAt falls on today's date
 *   Pending Orders            â†’ orders currently in the crafting pipeline
 *   Low Stock                 â†’ inventory rows at or below their reorder level
 *   Unread Conversations      â†’ GET /api/conversations/unread (staff-scoped)
 *   Pending Custom Requests   â†’ GET /api/custom-requests?status=pending
 *   Priority Queue            â†’ the real pipeline orders, oldest first within stage
 *   Recent Activity           â†’ order statusHistory entries recorded by the backend
 * The two networked cards expose loading / error / retry states instead of
 * inventing numbers; nothing here is ever fabricated.
 */

const PIPELINE_STAGES = ['new', 'confirmed', 'in_production', 'quality_check'];
const DONE_STAGES = ['shipped', 'delivered'];

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/** Where an order sits inside its own flow, from its real status history. */
function stageProgress(order) {
  const seen = new Set((order.statusHistory || []).map((h) => h?.status).filter(Boolean));
  const reached = PIPELINE_STAGES.filter((s) => seen.has(s)).length;
  return { reached: Math.max(reached, 1), total: PIPELINE_STAGES.length };
}

function Kpi({ label, icon, value, suffix, caption, tone = 'primary', onRetry }) {
  const chip = {
    primary: 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] dark:bg-[#37332c] dark:text-[#f2efe9]',
    accent: 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]',
    sage: 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)]',
    danger: 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)]',
  }[tone];
  return (
    <div className="bg-[var(--color-surface-lowest)] dark:bg-[#1f1c19] rounded-2xl p-5 shadow-sm flex flex-col justify-between gap-3 border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-muted)]">
          {label}
        </span>
        <span className={`w-8 h-8 rounded-full ${chip} flex items-center justify-center shrink-0`}>
          <span className="material-symbols-outlined text-[18px]">{icon}</span>
        </span>
      </div>
      <div>
        <div className="flex items-baseline gap-2">
          <span className="font-serif text-[40px] leading-[48px] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
            {value}
          </span>
          {suffix && <span className="text-[16px] font-semibold text-[var(--color-botanical-subtle)]">{suffix}</span>}
        </div>
        <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] mt-1">{caption}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 inline-flex items-center gap-1 px-3 py-1 min-h-[26px] rounded-full text-[12px] font-semibold text-[var(--color-accent)] bg-[var(--color-surface-low)] hover:bg-[var(--color-surface-high)] transition-colors dark:bg-[#26221e]"
          >
            <span className="material-symbols-outlined text-[14px]">refresh</span>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

function Panel({ title, icon, eyebrow, right, children, className = '' }) {
  return (
    <section className={`bg-[var(--color-surface-lowest)] dark:bg-[#1f1c19] rounded-3xl p-6 shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-[20px] text-[var(--color-botanical-muted)]">{icon}</span>
          <div className="min-w-0">
            {eyebrow && (
              <span className="block text-[10px] font-bold uppercase tracking-widest text-[var(--color-accent)]">{eyebrow}</span>
            )}
            <h2 className="font-serif text-[22px] leading-tight text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
              {title}
            </h2>
          </div>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function EmptyLine({ icon, children }) {
  return (
    <div className="flex items-center gap-2.5 p-4 rounded-2xl bg-[var(--color-surface-low)] dark:bg-[#26221e] text-[13px] text-[var(--color-botanical-muted)]">
      <span className="material-symbols-outlined text-[19px] text-[var(--color-botanical-subtle)]">{icon}</span>
      {children}
    </div>
  );
}

export default function HandlerDashboardPage() {
  const storeVersion = useStoreVersion();
  const { session } = useAdminSession();
  const [tab, setTab] = useState('queue');

  const orders = useMemo(() => getOrders(), [storeVersion]);
  const counts = useMemo(() => getStatusCounts(), [storeVersion]);
  const lowStock = useMemo(() => getLowStockItems(), [storeVersion]);

  // Networked inbox counters â€” loading / error / retry, never fabricated.
  const [inbox, setInbox] = useState({ state: 'loading', unread: 0, pendingRequests: 0 });
  const loadInbox = useCallback(async () => {
    setInbox((prev) => ({ ...prev, state: 'loading' }));
    try {
      const [unreadRes, pending] = await Promise.all([
        getUnreadCount({ scope: 'admin' }),
        getAllCustomRequests('pending'),
      ]);
      setInbox({
        state: 'ready',
        unread: Number(unreadRes?.count || 0),
        pendingRequests: Array.isArray(pending) ? pending.length : 0,
      });
    } catch {
      setInbox((prev) => ({ ...prev, state: 'error' }));
    }
  }, []);
  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  const todayOrders = useMemo(
    () => orders.filter((o) => isToday(o.createdAt) || isToday(o.placedAt)),
    [orders]
  );

  const pipelineOrders = useMemo(
    () =>
      orders
        .filter((o) => PIPELINE_STAGES.includes(o.orderStatus))
        .sort((a, b) => {
          const rank = (s) => PIPELINE_STAGES.indexOf(s);
          if (rank(a.orderStatus) !== rank(b.orderStatus)) return rank(a.orderStatus) - rank(b.orderStatus);
          return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
        }),
    [orders]
  );

  const qcOrders = useMemo(() => orders.filter((o) => o.orderStatus === 'quality_check'), [orders]);

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
    return events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 6);
  }, [orders]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (session?.name || '').split(/\s+/)[0] || 'there';
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
  });

  return (
    <AdminLayout>
      {/* No entrance animation here: the handler screen is a work surface, and
          the data it renders comes from the shared store (no fetch spinner of
          its own), so there is nothing to mask with motion. */}
      <div className="max-w-7xl mx-auto space-y-6 sm:space-y-8 pb-10">
        {/* â”€â”€ Header â”€â”€ */}
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-5">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] text-[11px] font-bold uppercase tracking-wider">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-botanical-sage)]" />
                Handler Workspace
              </span>
              {session?.staffId && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--color-surface-container)] dark:bg-[#2e2a25] text-[var(--color-botanical-muted)] text-[11px] font-bold uppercase tracking-wider font-mono">
                  {session.staffId}
                </span>
              )}
              {session?.department && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--color-surface-container)] dark:bg-[#2e2a25] text-[var(--color-botanical-muted)] text-[11px] font-bold uppercase tracking-wider">
                  {session.department}
                </span>
              )}
            </div>
            <h1 className="font-serif text-[30px] leading-[38px] sm:text-[40px] sm:leading-[48px] tracking-[-0.015em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
              {greeting}, {firstName}
            </h1>
            <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)]">
              Your operational assignments for {today}. Work the priority queue in order and move finished
              pieces into the quality gate.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/staff/orders"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-[13px] font-semibold shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] hover:bg-[var(--color-surface-high)] transition-all"
            >
              <span className="material-symbols-outlined text-[18px]">local_shipping</span>
              All Orders
            </Link>
            <Link
              to="/staff/inventory"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-md hover:bg-[var(--color-btn-hover-alt)] transition-all active:translate-y-px"
            >
              <span className="material-symbols-outlined text-[18px]">inventory_2</span>
              Floor Inventory
            </Link>
          </div>
        </header>

        {/* â”€â”€ KPIs â€” operational work, every value real â”€â”€ */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          <Kpi
            label="Today's Orders"
            icon="today"
            value={todayOrders.length}
            suffix={todayOrders.length === 1 ? 'order' : 'orders'}
            caption="Placed since midnight"
          />
          <Kpi
            label="Pending Orders"
            icon="local_florist"
            value={pipelineOrders.length}
            suffix={pipelineOrders.length === 1 ? 'piece' : 'pieces'}
            caption={
              counts.inProduction
                ? `${counts.inProduction} actively in production`
                : 'Nothing in production right now'
            }
          />
          <Kpi
            label="Low Stock"
            icon="shelves"
            value={lowStock.length}
            suffix="items"
            tone={lowStock.length ? 'danger' : 'sage'}
            caption={lowStock.length ? 'At or below reorder level' : 'All materials above threshold'}
          />
          <Kpi
            label="Unread Conversations"
            icon="chat"
            value={inbox.state === 'loading' ? 'â€¦' : inbox.state === 'error' ? 'â€”' : inbox.unread}
            suffix={inbox.state === 'ready' && inbox.unread ? 'threads' : ''}
            tone={inbox.state === 'ready' && inbox.unread ? 'accent' : 'primary'}
            caption={
              inbox.state === 'loading'
                ? 'Loading inboxâ€¦'
                : inbox.state === 'error'
                  ? "Couldn't load the inbox"
                  : inbox.unread
                    ? 'Customer messages awaiting a reply'
                    : 'No unread messages'
            }
            onRetry={inbox.state === 'error' ? loadInbox : undefined}
          />
          <Kpi
            label="Pending Custom Requests"
            icon="draw"
            value={inbox.state === 'loading' ? 'â€¦' : inbox.state === 'error' ? 'â€”' : inbox.pendingRequests}
            suffix={inbox.state === 'ready' && inbox.pendingRequests ? 'requests' : ''}
            tone={inbox.state === 'ready' && inbox.pendingRequests ? 'accent' : 'primary'}
            caption={
              inbox.state === 'loading'
                ? 'Loading requestsâ€¦'
                : inbox.state === 'error'
                  ? "Couldn't load requests"
                  : inbox.pendingRequests
                    ? 'Awaiting review and a quote'
                    : 'No requests waiting'
            }
            onRetry={inbox.state === 'error' ? loadInbox : undefined}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* â”€â”€ Left: work queue / inventory / QC â”€â”€ */}
          <div className="lg:col-span-8 space-y-6">
            <Panel
              eyebrow="Queue & Station Live Run"
              icon="checklist"
              title="Today's Priority Work Queue"
              right={
                <div className="flex items-center gap-1 p-1 rounded-full bg-[var(--color-surface-container)] dark:bg-[#2e2a25]">
                  {[
                    { key: 'queue', label: 'Orders' },
                    { key: 'inventory', label: 'Materials' },
                    { key: 'qc', label: 'Quality' },
                  ].map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTab(t.key)}
                      className={`px-3 py-1 min-h-[44px] md:min-h-0 rounded-full text-[11px] font-bold uppercase tracking-wider transition-colors ${
                        tab === t.key
                          ? 'bg-[var(--color-btn)] text-white dark:bg-[#964735]'
                          : 'text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)]'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              }
            >
              {tab === 'queue' && (
                <div className="space-y-4">
                  {pipelineOrders.length === 0 && (
                    <EmptyLine icon="task_alt">
                      Nothing in the crafting pipeline. New orders appear here as soon as they are confirmed.
                    </EmptyLine>
                  )}
                  {pipelineOrders.slice(0, 6).map((o) => {
                    const progress = stageProgress(o);
                    const pct = Math.round((progress.reached / progress.total) * 100);
                    return (
                      <Link
                        key={o.id}
                        to={`/staff/orders/${o.id}`}
                        className="block p-5 rounded-2xl bg-[var(--color-surface-low)] hover:bg-[var(--color-surface-container)] transition-colors dark:bg-[#26221e] dark:hover:bg-[#2e2a25]"
                      >
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              <span className="font-serif text-[17px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                                #{String(o.id).slice(-8).toUpperCase()}
                              </span>
                              <AdminOrderStatusPill status={o.orderStatus} />
                            </div>
                            <p className="text-[13px] text-[var(--color-botanical-muted)] truncate">
                              {o.customerName || 'Guest'} Â· {(o.items || []).map((i) => `${i.name} Ã—${i.quantity}`).join(', ') || 'No line items'}
                            </p>
                          </div>
                          <div className="text-left md:text-right shrink-0">
                            <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                              Stage {progress.reached} of {progress.total}
                            </span>
                            <span className="text-[12px] text-[var(--color-botanical-muted)]">
                              Created {timeAgo(o.createdAt)}
                            </span>
                          </div>
                        </div>
                        <div className="w-full bg-[var(--color-surface-highest)] rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-[var(--color-accent)] transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}

              {tab === 'inventory' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {lowStock.length === 0 && (
                    <div className="md:col-span-2">
                      <EmptyLine icon="inventory">
                        Every material is above its reorder threshold â€” no floor restock tasks today.
                      </EmptyLine>
                    </div>
                  )}
                  {lowStock.slice(0, 6).map((item) => {
                    const stock = item.currentStock ?? item.quantity ?? 0;
                    const threshold = item.reorderLevel ?? item.lowStockThreshold ?? 0;
                    const pct = threshold > 0 ? Math.min(100, Math.round((stock / threshold) * 100)) : 0;
                    return (
                      <div key={item.id || item.productId} className="p-4 rounded-2xl bg-[var(--color-surface-low)] dark:bg-[#26221e]">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-[13px] font-semibold text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
                            {item.productName}
                          </span>
                          <span className={`text-[10px] font-bold uppercase tracking-wider ${item.status === 'Critical' ? 'text-[var(--color-danger)]' : 'text-[var(--color-accent)]'}`}>
                            {item.status}
                          </span>
                        </div>
                        <div className="w-full bg-[var(--color-surface-highest)] rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${item.status === 'Critical' ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-accent)]'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between mt-2 text-[12px] text-[var(--color-botanical-muted)]">
                          <span>Remaining: {stock}</span>
                          <span>Threshold: {threshold}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {tab === 'qc' && (
                <div className="space-y-3">
                  {qcOrders.length === 0 && (
                    <EmptyLine icon="verified">
                      No orders are waiting for inspection. Pieces enter this queue when production marks them ready.
                    </EmptyLine>
                  )}
                  {qcOrders.map((o) => (
                    <Link
                      key={o.id}
                      to={`/staff/orders/${o.id}`}
                      className="flex items-center justify-between gap-3 p-4 rounded-2xl bg-[var(--color-surface-low)] hover:bg-[var(--color-surface-container)] transition-colors dark:bg-[#26221e]"
                    >
                      <div className="min-w-0">
                        <span className="block text-[13px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                          #{String(o.id).slice(-8).toUpperCase()}
                        </span>
                        <span className="block text-[12px] text-[var(--color-botanical-muted)] truncate">
                          {o.customerName || 'Guest'} Â· {(o.items || []).length} line item(s)
                        </span>
                      </div>
                      <AdminOrderStatusPill status={o.orderStatus} />
                    </Link>
                  ))}
                </div>
              )}
            </Panel>

            <Panel
              eyebrow="Recorded by the backend"
              icon="history_edu"
              title="Recent Atelier Activity"
              right={<span className="w-2 h-2 rounded-full bg-[var(--color-accent)]" />}
            >
              {activity.length === 0 ? (
                <EmptyLine icon="history_toggle_off">
                  No order activity has been recorded yet. Status changes appear here as they happen.
                </EmptyLine>
              ) : (
                <div className="relative pl-6 space-y-5 before:content-[''] before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-[var(--color-divider-strong)]">
                  {activity.map((ev) => (
                    <div key={ev.key} className="relative">
                      <span className="absolute -left-6 top-1.5 w-3 h-3 rounded-full bg-[var(--color-accent)] ring-4 ring-[var(--color-surface-lowest)] dark:ring-[#1f1c19]" />
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                          #{String(ev.orderId).slice(-8).toUpperCase()}
                        </span>
                        <span className="text-[10px] uppercase tracking-wider text-[var(--color-botanical-subtle)] whitespace-nowrap">
                          {timeAgo(ev.at)}
                        </span>
                      </div>
                      <p className="text-[12px] text-[var(--color-botanical-muted)] mt-0.5 break-words">
                        {String(ev.status).replace(/_/g, ' ')}
                        {ev.by ? ` Â· ${ev.by}` : ''}
                        {ev.note ? ` â€” ${ev.note}` : ''}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          {/* â”€â”€ Right: workstation + support â”€â”€ */}
          <div className="lg:col-span-4 space-y-6">
            <Panel eyebrow="Your workstation" icon="badge" title="Handler Identity">
              <div className="p-4 rounded-2xl bg-[var(--color-surface-low)] space-y-2.5 dark:bg-[#26221e]">
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)] shrink-0">Name</span>
                  <span className="font-semibold text-[var(--color-botanical-text)] min-w-0 truncate dark:text-[#f0ede9]">{session?.name || 'â€”'}</span>
                </div>
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)] shrink-0">Staff ID</span>
                  <span className="font-mono text-[var(--color-botanical-text)] min-w-0 truncate dark:text-[#f0ede9]">{session?.staffId || 'â€”'}</span>
                </div>
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)] shrink-0">Role</span>
                  <span className="font-semibold text-[var(--color-botanical-text)] min-w-0 truncate dark:text-[#f0ede9]">
                    {session?.roleLabel || 'Handler'}
                  </span>
                </div>
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)] shrink-0">Department</span>
                  <span className="text-[var(--color-botanical-text)] min-w-0 truncate dark:text-[#f0ede9]">
                    {session?.department || 'Unassigned'}
                  </span>
                </div>
              </div>
              <p className="text-[11px] leading-snug text-[var(--color-botanical-subtle)] mt-3">
                Your access is operational only. Staff, permissions and administrator controls are managed by
                the atelier administrator.
              </p>
            </Panel>

            <Panel eyebrow="Shift" icon="support_agent" title="Need Floor Support?">
              <p className="text-[13px] leading-6 text-[var(--color-botanical-muted)]">
                Materials approvals, QC sign-offs and dispatch overrides go through your atelier
                administrator. Raise anything that blocks a bench in the order conversation so it stays on
                the order record.
              </p>
              <div className="flex flex-wrap gap-2 mt-4">
                <Link
                  to="/staff/orders"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[var(--color-surface-container)] dark:bg-[#2e2a25] text-[var(--color-botanical-text)] dark:text-[#f0ede9] text-[12px] font-semibold hover:bg-[var(--color-surface-high)] transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px]">chat</span>
                  Order conversations
                </Link>
                <Link
                  to="/staff/conversations"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[var(--color-surface-container)] dark:bg-[#2e2a25] text-[var(--color-botanical-text)] dark:text-[#f0ede9] text-[12px] font-semibold hover:bg-[var(--color-surface-high)] transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px]">forum</span>
                  Inbox
                </Link>
              </div>
            </Panel>

            <Panel eyebrow="Dispatch" icon="local_shipping" title="Ready To Move">
              <div className="space-y-2.5">
                {DONE_STAGES.map((stage) => (
                  <div key={stage} className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--color-surface-low)] dark:bg-[#26221e]">
                    <span className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-botanical-muted)]">
                      {stage.replace(/_/g, ' ')}
                    </span>
                    <span className="font-serif text-[20px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                      {orders.filter((o) => o.orderStatus === stage).length}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
