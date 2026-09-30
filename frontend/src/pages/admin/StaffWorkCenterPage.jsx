import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { StaffButton, AdminToast } from '../../components/admin/StaffPrimitives.jsx';
import { updateOrderStatus } from '../../services/orderService.js';
import { getAllCustomRequests, updateCustomRequestStatus } from '../../services/customRequestService.js';
import { adjustInventory } from '../../services/inventoryService.js';
import { listConversations, markAsRead } from '../../services/conversationService.js';
import {
  WORK_AREAS,
  WORK_SOURCES,
  WORK_BUCKETS,
  buildWorkItems,
  filterWorkItems,
  permittedActionsFor,
  storeOrders,
  storeStockWork,
} from '../../services/workCenter.js';

/**
 * Phase 23 — STAFF / HANDLER ACTION CENTER (/staff/work).
 *
 * One surface for every operational action a handler is assigned: the work
 * queue is assembled from the operational records the workspace already owns
 * (orders, custom requests, stock alerts, customer conversations) — there is no
 * Task model and no duplicate representation of an order or a request.
 *
 * What this page can and cannot do is decided by the SERVER, never by this
 * file: every read and every mutation below goes through an endpoint already
 * gated by protect → role → requireWorkspace → tenancy scope, and the
 * per-operation policy lives in backend/utils/operationalActions.js. The
 * frontend mirror (workCenter.js) only keeps buttons that can actually succeed
 * off the screen; a forged client still gets the server's 403.
 *
 * Deliberately ABSENT (handler-forbidden, and the backend refuses them anyway):
 * administrator management, invitations, admin applications, workspace
 * lifecycle, platform settings, billing/ownership.
 */

/** Turn a server refusal into the truth about what happened. */
function describeActionFailure(err, fallback) {
  const code = err?.code;
  switch (code) {
    case 'ACTION_NOT_PERMITTED':
      // The server's own explanation of the rule (e.g. declining a request).
      return err.message || fallback;
    case 'FORBIDDEN':
      return 'Your account does not have permission to perform that action.';
    case 'ACCOUNT_SUSPENDED':
      return 'This account has been suspended. Contact an administrator to restore access.';
    case 'WORKSPACE_REQUIRED':
      return 'This account is not attached to a workspace, so operational work is unavailable.';
    case 'WORKSPACE_SUSPENDED':
      return 'This workspace is suspended — operational work is paused.';
    case 'UNAUTHORIZED':
      return 'Your session has expired. Please sign in again.';
    case 'ORDER_NOT_FOUND':
    case 'NOT_FOUND':
      return 'That work item is no longer available — the list has been refreshed.';
    case 'VALIDATION_ERROR':
      return err.message || 'That value was rejected. Please check it and try again.';
    case 'NETWORK_ERROR':
      return 'We could not reach the studio server. Nothing was changed — try again.';
    default:
      return err?.message || fallback;
  }
}

const AREA_ACCENTS = {
  'Packaging & Keepsake Boxes': 'bg-[#f4e7d3] text-[#7a5a2e]',
  'Floral Sculpting & Pipe Craft': 'bg-[#e7efe0] text-[#41592f]',
  'Letterpress & Deckled Stationery': 'bg-[#e9e4f2] text-[#4b3f73]',
  'Petal Dyeing & Wire Binding': 'bg-[#f7e3e6] text-[#7c3a45]',
  'Logistics & Courier Fulfillment': 'bg-[#e2ebf2] text-[#2f4f66]',
  'Botanical Quality Assurance': 'bg-[#e6f1ea] text-[#2f6350]',
};

function WorkCard({ item, onAction, busyKey, movementForm, onOpenMovement, onCloseMovement, onSubmitMovement }) {
  const isOpen = movementForm?.key === item.key;
  const busy = busyKey === item.key;
  return (
    <article
      data-work-item={item.key}
      data-work-kind={item.kind}
      data-work-area={item.workArea}
      data-work-status={item.status}
      className="flex flex-col gap-3 p-4 sm:p-5 rounded-2xl bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] border border-[var(--color-botanical-border)] dark:border-[#3a3530] shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-subtle)]">
            {item.source}
            {item.reference ? <span className="ml-2 font-mono normal-case tracking-normal">{item.reference}</span> : null}
          </p>
          <h3 className="font-serif text-[19px] leading-6 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] break-words">
            {item.title}
          </h3>
        </div>
        <span className="shrink-0 inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-[0.06em] bg-[var(--color-surface-container)] dark:bg-[#2e2a25] text-[var(--color-botanical-muted)] dark:text-[#d8d1c8]">
          {item.statusLabel}
        </span>
      </div>

      {item.subtitle && (
        <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] break-words">
          {item.subtitle}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span
          data-work-area-badge={item.workArea}
          className={`px-2.5 py-1 rounded-full font-semibold break-words ${
            AREA_ACCENTS[item.workArea] || 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]'
          }`}
        >
          {item.workArea}
        </span>
        {item.customer && (
          <span className="text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">• {item.customer}</span>
        )}
        {item.dueAt && (
          <span className="text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
            • due {new Date(item.dueAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
          </span>
        )}
      </div>

      {isOpen && (
        <form
          data-work-movement={item.key}
          className="flex flex-col sm:flex-row sm:items-end gap-2 p-3 rounded-xl bg-[var(--color-surface-low)] dark:bg-[#26221e]"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmitMovement(item);
          }}
        >
          <label className="flex-1 text-[12px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">
            Quantity
            <input
              id={`movement-qty-${item.key}`}
              type="number"
              min="1"
              step="1"
              defaultValue={movementForm.quantity}
              onChange={(e) => onOpenMovement({ key: item.key, quantity: e.target.value, type: movementForm.type })}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-[var(--color-surface-bg)] dark:bg-[#222019] border border-[var(--color-botanical-border)] dark:border-[#3a3530] text-[14px]"
            />
          </label>
          <label className="flex-1 text-[12px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">
            Movement
            <select
              id={`movement-type-${item.key}`}
              value={movementForm.type}
              onChange={(e) => onOpenMovement({ key: item.key, quantity: movementForm.quantity, type: e.target.value })}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-[var(--color-surface-bg)] dark:bg-[#222019] border border-[var(--color-botanical-border)] dark:border-[#3a3530] text-[14px] min-h-[44px]"
            >
              <option value="restock">Restock</option>
              <option value="remove">Remove</option>
              <option value="adjustment">Adjustment</option>
            </select>
          </label>
          <div className="flex gap-2">
            <StaffButton type="submit" size="sm" loading={busy} data-work-action="inventory-confirm">
              Confirm
            </StaffButton>
            <StaffButton type="button" size="sm" variant="ghost" onClick={onCloseMovement}>
              Cancel
            </StaffButton>
          </div>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-auto pt-1">
        {item.action && (
          <StaffButton
            size="sm"
            loading={busy}
            data-work-action={item.action.key}
            onClick={() =>
              item.action.owner === 'inventory' ? onOpenMovement(item) : onAction(item, item.action)
            }
          >
            {item.action.label}
          </StaffButton>
        )}
        {(item.secondary || []).map((s) =>
          s.href ? (
            <Link
              key={s.key}
              to={s.href}
              className="inline-flex items-center px-3 py-2 min-h-[44px] rounded-full text-[13px] font-semibold text-[var(--color-accent)] hover:bg-[var(--color-surface-container)] transition-colors"
            >
              {s.label}
            </Link>
          ) : (
            <StaffButton
              key={s.key}
              size="sm"
              variant={s.tone === 'danger' ? 'dangerSoft' : 'secondary'}
              loading={busy}
              data-work-action={s.key}
              onClick={() => onAction(item, s)}
            >
              {s.label}
            </StaffButton>
          )
        )}
      </div>
    </article>
  );
}

export default function StaffWorkCenterPage() {
  const storeVersion = useStoreVersion();
  const { session } = useAdminSession();
  const isAdmin = session?.role === 'admin';

  const [bucket, setBucket] = useState('all');
  const [source, setSource] = useState('all');
  const [area, setArea] = useState('all');
  const [status, setStatus] = useState('all');

  const [network, setNetwork] = useState({ state: 'loading', requests: [], conversations: [], error: '' });
  const [busyKey, setBusyKey] = useState(null);
  const [movementForm, setMovementForm] = useState(null);
  const [toast, setToast] = useState(null);
  const inFlightRef = useRef(false);

  const loadNetworked = useCallback(async () => {
    setNetwork((prev) => ({ ...prev, state: prev.requests.length || prev.conversations.length ? prev.state : 'loading' }));
    try {
      const [requests, conversations] = await Promise.all([
        getAllCustomRequests(),
        listConversations({ status: 'open', limit: 25, scope: 'admin' }),
      ]);
      setNetwork({
        state: 'ready',
        requests: Array.isArray(requests) ? requests : [],
        conversations: Array.isArray(conversations) ? conversations : [],
        error: '',
      });
    } catch (err) {
      setNetwork((prev) => ({ ...prev, state: 'error', error: describeActionFailure(err, 'The work queue could not be loaded.') }));
    }
  }, []);

  useEffect(() => {
    loadNetworked();
  }, [loadNetworked]);

  const orders = useMemo(() => storeOrders(), [storeVersion]);
  const stock = useMemo(() => storeStockWork(), [storeVersion]);

  const items = useMemo(
    () =>
      buildWorkItems({
        orders,
        customRequests: network.requests,
        inventory: stock,
        conversations: network.conversations,
        isAdmin,
        me: session?.name || '',
      }),
    [orders, network.requests, network.conversations, stock, isAdmin, session?.name]
  );

  const counts = useMemo(
    () => ({
      all: items.length,
      dueToday: filterWorkItems(items, { bucket: 'due_today' }).length,
      overdue: filterWorkItems(items, { bucket: 'overdue' }).length,
      lowStock: stock.length,
    }),
    [items, stock]
  );

  const visible = useMemo(
    () => filterWorkItems(items, { bucket, source, area, status }),
    [items, bucket, source, area, status]
  );

  // Status options come from the work actually on screen for the chosen source,
  // so the filter never offers a state this workspace has no work in.
  const statusOptions = useMemo(() => {
    const scoped = items.filter((i) => (source === 'all' ? true : i.kind === source));
    const seen = new Map();
    scoped.forEach((i) => seen.set(i.status, i.statusLabel));
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [items, source]);

  const permitted = useMemo(() => permittedActionsFor({ isAdmin }), [isAdmin]);

  const runAction = useCallback(
    async (item, action) => {
      if (inFlightRef.current) return;
      // The UI mirror is presentation; the server decides. This guard only
      // stops the double-click, not the policy.
      inFlightRef.current = true;
      setBusyKey(item.key);
      try {
        if (action.mutation?.kind === 'order_status') {
          await updateOrderStatus(action.mutation.orderId, action.mutation.nextStatus);
        } else if (action.mutation?.kind === 'request_status') {
          await updateCustomRequestStatus(action.mutation.id, action.mutation.nextStatus);
          await loadNetworked();
        } else if (action.mutation?.kind === 'conversation_read') {
          await markAsRead(action.mutation.id, { scope: 'admin' });
          await loadNetworked();
        } else if (action.mutation?.kind === 'inventory_adjust') {
          const qty = Number(movementForm?.quantity ?? action.mutation.suggested) || 1;
          const type = movementForm?.type || 'restock';
          await adjustInventory(action.mutation.productId, qty, type, null, `${session?.name || 'Handler'} — work center`);
          setMovementForm(null);
        } else {
          throw Object.assign(new Error('That action is not wired to an endpoint.'), { code: 'UNSUPPORTED' });
        }
        setToast({
          tone: 'success',
          message: `${action.note || action.label} — ${item.title}`,
          code: null,
        });
      } catch (err) {
        setToast({
          tone: 'error',
          message: describeActionFailure(err, 'That action could not be completed.'),
          code: err?.code || null,
        });
      } finally {
        setBusyKey(null);
        inFlightRef.current = false;
      }
    },
    [movementForm, session?.name, loadNetworked]
  );

  const openMovement = useCallback((item) => {
    setMovementForm((prev) =>
      prev && prev.key === item.key
        ? prev
        : { key: item.key, quantity: String(item.action?.mutation?.suggested || 10), type: 'restock' }
    );
  }, []);

  const clearFilters = useCallback(() => {
    setBucket('all');
    setSource('all');
    setArea('all');
    setStatus('all');
  }, []);

  const selectClass =
    'w-full px-3 py-2 min-h-[44px] rounded-xl bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] border border-[var(--color-botanical-border)] dark:border-[#3a3530] text-[13px] text-[var(--color-botanical-text)] dark:text-[#f2efe9]';

  return (
    <AdminLayout>
      <div className="relative w-full pb-10" data-staff-work={network.state}>
        {/* Inline action feedback: the toast is transient, this stays put and
            carries the same server reason for screen readers and for tests. */}
        {toast && (
          <div
            data-action-state={toast.tone === 'error' ? 'error' : 'success'}
            data-action-code={toast.code || ''}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={`mb-5 flex items-start gap-2 p-3.5 rounded-xl text-[13px] leading-5 border ${
              toast.tone === 'error'
                ? 'bg-[var(--color-danger-soft-bg)] border-[var(--color-danger-soft-border)] text-[var(--color-danger-soft-fg)]'
                : 'bg-[var(--color-success-soft-bg,#e6f1ea)] border-[var(--color-success-soft-border,#cbe0d2)] text-[var(--color-botanical-primary)] dark:text-[#f2efe9]'
            }`}
          >
            <span className="material-symbols-outlined text-[18px] shrink-0 mt-px">
              {toast.tone === 'error' ? 'error' : 'task_alt'}
            </span>
            <span>{toast.message}</span>
          </div>
        )}

        <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--color-accent)]">Work station</p>
            <h1 className="font-serif text-[30px] sm:text-[38px] leading-tight text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
              Action Center
            </h1>
            <p className="text-[14px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] max-w-2xl mt-1">
              Every operational action available to you in this workspace — orders, bespoke requests, stock movements and
              customer conversations in one queue. Your permissions are resolved by the server on every action.
            </p>
          </div>
          <StaffButton size="sm" variant="secondary" onClick={loadNetworked} data-work-action="refresh">
            Refresh
          </StaffButton>
        </header>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Open work', value: counts.all },
            { label: 'Due today', value: counts.dueToday },
            { label: 'Overdue', value: counts.overdue },
            { label: 'Stock alerts', value: counts.lowStock },
          ].map((kpi) => (
            <div
              key={kpi.label}
              className="p-4 rounded-2xl bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] border border-[var(--color-botanical-border)] dark:border-[#3a3530]"
            >
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-subtle)]">
                {kpi.label}
              </p>
              <p className="font-serif text-[26px] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">{kpi.value}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3" role="tablist" aria-label="Work buckets">
          {WORK_BUCKETS.map((b) => (
            <button
              key={b.key}
              type="button"
              role="tab"
              aria-selected={bucket === b.key}
              data-work-bucket={b.key}
              onClick={() => setBucket(b.key)}
              className={`px-4 py-2 min-h-[44px] rounded-full text-[13px] font-semibold transition-colors ${
                bucket === b.key
                  ? 'bg-[var(--color-btn)] text-white'
                  : 'bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] text-[var(--color-botanical-muted)] dark:text-[#d8d1c8] border border-[var(--color-botanical-border)] dark:border-[#3a3530]'
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <label className="text-[12px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">
            Work source
            <select
              id="work-filter-source"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setStatus('all');
              }}
              className={`mt-1 ${selectClass}`}
            >
              {WORK_SOURCES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">
            Work category
            <select
              id="work-filter-area"
              value={area}
              onChange={(e) => setArea(e.target.value)}
              className={`mt-1 ${selectClass}`}
            >
              <option value="all">All categories</option>
              {WORK_AREAS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">
            Status
            <select
              id="work-filter-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className={`mt-1 ${selectClass}`}
            >
              <option value="all">All statuses</option>
              {statusOptions.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <p className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]" data-work-count={visible.length}>
            Showing <strong>{visible.length}</strong> of {items.length} work items
          </p>
          {(bucket !== 'all' || source !== 'all' || area !== 'all' || status !== 'all') && (
            <button
              type="button"
              onClick={clearFilters}
              data-work-action="clear-filters"
              className="text-[13px] font-semibold text-[var(--color-accent)] hover:underline min-h-[44px]"
            >
              Clear filters
            </button>
          )}
        </div>

        {network.state === 'loading' && !items.length ? (
          <div className="p-6 rounded-2xl bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
            <p className="text-[14px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">Loading the work queue…</p>
          </div>
        ) : network.state === 'error' ? (
          <div
            data-work-error="network"
            className="flex flex-col gap-3 p-6 rounded-2xl bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] border border-[var(--color-botanical-border)] dark:border-[#3a3530]"
          >
            <p className="text-[14px] text-[var(--color-botanical-text)] dark:text-[#f2efe9]" role="alert">
              {network.error}
            </p>
            <div>
              <StaffButton size="sm" onClick={loadNetworked}>
                Retry
              </StaffButton>
            </div>
          </div>
        ) : visible.length ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {visible.map((item) => (
              <WorkCard
                key={item.key}
                item={item}
                onAction={runAction}
                busyKey={busyKey}
                movementForm={movementForm}
                onOpenMovement={openMovement}
                onCloseMovement={() => setMovementForm(null)}
                onSubmitMovement={(it) => runAction(it, it.action)}
              />
            ))}
          </div>
        ) : (
          <div
            data-work-empty={bucket !== 'all' || source !== 'all' || area !== 'all' || status !== 'all' ? 'filtered' : 'none'}
            className="p-8 rounded-2xl bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] border border-[var(--color-botanical-border)] dark:border-[#3a3530] text-center"
          >
            <p className="text-[15px] text-[var(--color-botanical-text)] dark:text-[#f2efe9] font-semibold">
              {bucket !== 'all' || source !== 'all' || area !== 'all' || status !== 'all'
                ? 'No work matches these filters.'
                : 'Nothing in your queue right now.'}
            </p>
            <p className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-1">
              {bucket !== 'all' || source !== 'all' || area !== 'all' || status !== 'all'
                ? 'Try another work category, source or status.'
                : 'New orders, bespoke requests and stock alerts appear here as the workspace receives them.'}
            </p>
          </div>
        )}

        {/* What this account may do — mirrors the server policy. */}
        <p className="mt-8 text-[12px] leading-5 text-[var(--color-botanical-subtle)]">
          You may {permitted.order.length ? 'advance orders through the studio pipeline' : 'view orders'}, work bespoke
          requests ({permitted.customRequest.join(', ')}) and record stock movements. Administrator and owner controls —
          personnel, invitations, applications, workspace settings — are not part of this workspace role.
        </p>

        <AdminToast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </AdminLayout>
  );
}
