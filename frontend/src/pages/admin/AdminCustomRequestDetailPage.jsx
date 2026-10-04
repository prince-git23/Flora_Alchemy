import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Plus, Trash2, Send, CheckCircle2, XCircle, Hammer, PackageCheck, Undo2, Loader2 } from 'lucide-react';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import {
  getCustomRequest,
  updateCustomRequestStatus,
  saveProposal,
  sendProposal,
  withdrawProposal,
} from '../../services/customRequestService.js';
import { getCustomers } from '../../services/customerService.js';
import { formatDate, formatINR } from '../../services/orderService.js';
import { AdminRequestStatusPill } from '../../components/admin/AdminStatusPill.jsx';
import ReferenceImage from '../../components/ReferenceImage.jsx';
import { useStore } from '../../context/StoreContext.jsx';

/**
 * CUSTOM REQUEST WORKSPACE (Admin / Staff).
 *
 * One page, the whole journey:
 *   REVIEW → ACCEPT / REJECT (with a persisted, customer-safe reason)
 *   → FULFILLMENT PLANNING: build the dynamic itemised proposal
 *   → SEND the proposal (server locks the totals)
 *   → customer decides in their own portal
 *   → PAID … IN PROGRESS … COMPLETED
 *
 * Every button calls a real endpoint; the server re-validates the transition,
 * the workspace and the actor's permissions on every action. Proposal items
 * are admin-defined line items for THIS request — they are not products and
 * never appear in the shop.
 */

const emptyRow = () => ({
  key: `new-${Math.random().toString(36).slice(2)}`,
  itemName: '',
  description: '',
  quantity: '1',
  unitPrice: '',
});

export default function AdminCustomRequestDetailPage() {
  const { requestId } = useParams();
  const { showToast } = useStore();

  const [request, setRequest] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [order, setOrder] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Internal notes
  const [notes, setNotes] = useState('');

  // Decision
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  // Proposal builder (admin-defined dynamic rows)
  const [rows, setRows] = useState([]);
  const [rowsDirty, setRowsDirty] = useState(false);

  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    setNotFound(false);
    try {
      const data = await getCustomRequest(requestId, 'admin');
      setRequest(data.request);
      setProposal(data.proposal);
      setOrder(data.order);
      setNotes(data.request.adminNotes || '');
    } catch (err) {
      if (err.status === 404) setNotFound(true);
      else setLoadError(err.message || 'Unable to load this custom request.');
    } finally {
      setLoaded(true);
    }
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  // Mirror the stored proposal into editable rows whenever it changes.
  useEffect(() => {
    if (proposal && Array.isArray(proposal.items) && proposal.items.length) {
      setRows(
        proposal.items.map((item, i) => ({
          key: item._id || `row-${i}`,
          itemName: item.itemName || '',
          description: item.description || '',
          quantity: String(item.quantity ?? 1),
          unitPrice: String(item.unitPrice ?? ''),
        }))
      );
    }
    setRowsDirty(false);
  }, [proposal]);

  const customerName = useMemo(() => {
    try {
      const key = String(request?.customerId || '');
      const c = getCustomers().find((x) => String(x.id || x._id) === key);
      return c ? c.name || c.email : 'Customer';
    } catch {
      return 'Customer';
    }
  }, [request]);

  const status = request?.status || '';
  const busyNow = Boolean(busy);

  const run = async (label, fn, successMessage) => {
    if (busyNow) return;
    setBusy(label);
    setActionError('');
    try {
      await fn();
      if (successMessage) showToast(successMessage);
    } catch (err) {
      setActionError(err.message || 'The action could not be completed. Please try again.');
    } finally {
      setBusy('');
    }
  };

  // ── Decision actions ─────────────────────────────────────────────────
  const handleAccept = () =>
    run(
      'accept',
      async () => {
        await updateCustomRequestStatus(requestId, 'accepted');
        await load();
      },
      'Request accepted — build the proposal next'
    );

  const handleReject = () => {
    const reason = rejectReason.trim();
    if (reason.length < 3) {
      setActionError('Please give a short reason for declining this request.');
      return;
    }
    return run(
      'reject',
      async () => {
        await updateCustomRequestStatus(requestId, 'declined', undefined, reason);
        await load();
      },
      'Request declined'
    );
  };

  // ── Proposal builder ─────────────────────────────────────────────────
  const updateRow = (index, patch) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    setRowsDirty(true);
  };
  const addRow = () => {
    setRows((prev) => [...prev, emptyRow()]);
    setRowsDirty(true);
  };
  const removeRow = (index) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
    setRowsDirty(true);
  };

  const rowsToItems = () =>
    rows.map((r) => ({
      itemName: r.itemName.trim(),
      description: r.description.trim(),
      quantity: Math.floor(Number(r.quantity)),
      unitPrice: Number(r.unitPrice),
    }));

  const validateRows = () => {
    if (rows.length === 0) return 'Add at least one item to the proposal.';
    for (const [i, r] of rows.entries()) {
      if (!r.itemName.trim()) return `Item ${i + 1} needs a name.`;
      const qty = Math.floor(Number(r.quantity));
      if (!Number.isFinite(qty) || qty < 1 || qty > 99) return `Item ${i + 1} needs a quantity between 1 and 99.`;
      const price = Number(r.unitPrice);
      if (!Number.isFinite(price) || price < 0) return `Item ${i + 1} needs a valid unit price.`;
    }
    return '';
  };

  const previewTotals = useMemo(() => {
    const subtotal = rows.reduce((sum, r) => {
      const qty = Math.floor(Number(r.quantity)) || 0;
      const price = Number(r.unitPrice) || 0;
      return sum + qty * price;
    }, 0);
    return { subtotal: Math.round(subtotal * 100) / 100 };
  }, [rows]);

  const handleSaveDraft = () => {
    const problem = validateRows();
    if (problem) {
      setActionError(problem);
      return;
    }
    return run(
      'saveProposal',
      async () => {
        const res = await saveProposal(requestId, rowsToItems());
        setRequest(res.request);
        setProposal(res.proposal);
      },
      'Proposal draft saved'
    );
  };

  const handleSend = () => {
    const problem = validateRows();
    if (problem) {
      setActionError(problem);
      return;
    }
    return run(
      'sendProposal',
      async () => {
        // Save first so the customer receives exactly what the admin sees.
        const saved = await saveProposal(requestId, rowsToItems());
        setRequest(saved.request);
        setProposal(saved.proposal);
        const sent = await sendProposal(requestId);
        setRequest(sent.request);
        setProposal(sent.proposal);
      },
      'Proposal sent to the customer'
    );
  };

  const handleWithdraw = () =>
    run(
      'withdraw',
      async () => {
        const res = await withdrawProposal(requestId);
        setRequest(res.request);
        setProposal(res.proposal);
      },
      'Proposal withdrawn — you can rebuild it'
    );

  // ── Fulfillment / notes ──────────────────────────────────────────────
  const handleFulfillment = (next, message) =>
    run(
      next,
      async () => {
        const updated = await updateCustomRequestStatus(requestId, next);
        setRequest(updated);
      },
      message
    );

  const handleSaveNotes = () =>
    run(
      'notes',
      async () => {
        const updated = await updateCustomRequestStatus(requestId, status, notes);
        setRequest(updated);
      },
      'Notes saved'
    );

  // ── States ───────────────────────────────────────────────────────────
  if (!loaded) {
    return (
      <AdminLayout>
        <div className="max-w-5xl mx-auto space-y-6 pb-12">
          <div className="h-8 w-56 bg-[var(--color-surface-container)] rounded animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 h-72 bg-[var(--color-surface-container)] rounded-xl animate-pulse" />
            <div className="h-72 bg-[var(--color-surface-container)] rounded-xl animate-pulse" />
          </div>
        </div>
      </AdminLayout>
    );
  }

  if (notFound) {
    return (
      <AdminLayout>
        <div className="max-w-3xl mx-auto pb-12">
          <div className="p-12 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-4 border border-[var(--color-botanical-border)]">
            <h3 className="font-serif text-2xl text-[var(--color-botanical-primary)]">Request Not Found</h3>
            <p className="text-[14px] text-[var(--color-botanical-muted)]">
              This custom request does not exist, or it belongs to another workspace.
            </p>
            <Link
              to="/admin/custom-requests"
              className="inline-block px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold"
            >
              Return to Custom Requests
            </Link>
          </div>
        </div>
      </AdminLayout>
    );
  }

  if (loadError || !request) {
    return (
      <AdminLayout>
        <div className="max-w-3xl mx-auto pb-12">
          <div className="p-8 rounded-2xl text-center space-y-4 border border-[#f5c6bd] bg-[#fdecea]">
            <p className="text-[14px] text-[#8a2a18]">{loadError || 'Unable to load this custom request.'}</p>
            <button
              type="button"
              onClick={load}
              className="px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold"
            >
              Retry
            </button>
          </div>
        </div>
      </AdminLayout>
    );
  }

  const canDecide = ['pending', 'reviewing'].includes(status);
  const canBuild = status === 'accepted' && (!proposal || ['draft', 'withdrawn'].includes(proposal.status));
  const proposalSent = proposal?.status === 'sent';
  const proposalAnswered = proposal && ['accepted', 'declined'].includes(proposal.status);
  const showReadOnlyProposal = proposal && (proposalSent || proposalAnswered);
  const showServerTotals = proposal && !canBuild;

  return (
    <AdminLayout>
      <div className="max-w-6xl mx-auto space-y-6 pb-12">
        {/* Header */}
        <div className="flex items-start gap-3">
          <Link
            to="/admin/custom-requests"
            className="p-2 rounded-xl hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)] transition-colors"
            aria-label="Back to custom requests"
          >
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-serif text-2xl sm:text-3xl text-[var(--color-botanical-primary)] tracking-tight font-normal">
                Custom Request
              </h1>
              <AdminRequestStatusPill status={status} size="lg" />
            </div>
            <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-1">
              Submitted {formatDate(request.createdAt)} · by {customerName} ·{' '}
              <span className="font-mono">#{String(request._id || requestId).slice(-6).toUpperCase()}</span>
            </p>
          </div>
        </div>

        {actionError && (
          <div className="p-3.5 rounded-xl bg-[#fdecea] border border-[#f5c6bd] text-[13px] text-[#8a2a18]" role="alert">
            {actionError}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* ── LEFT: the request dossier ─────────────────────────────── */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">The Idea</h2>
              <p className="text-[14px] text-[var(--color-botanical-muted)] leading-relaxed whitespace-pre-wrap">
                {request.description}
              </p>
              {request.productName && (
                <div className="pt-4 border-t border-[var(--color-botanical-border)]">
                  <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">
                    Started from
                  </p>
                  <p className="text-[14px] text-[var(--color-botanical-primary)] font-semibold mt-1">
                    {request.productName}
                  </p>
                  <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-0.5">
                    This request is routed to the product&apos;s workspace.
                  </p>
                </div>
              )}
            </div>

            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Customer" value={customerName} />
              <Field label="Occasion" value={request.occasion || '—'} capitalize />
              <Field label="Budget" value={request.budget || '—'} />
              <Field label="Desired Date" value={request.desiredDate ? formatDate(request.desiredDate) : '—'} />
              <Field label="Preferred Colors" value={request.colors || '—'} className="sm:col-span-2" />
            </div>

            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
              <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] mb-3">
                Reference Image
              </p>
              <ReferenceImage src={request.imageUrl} alt={`Reference for custom request by ${customerName}`} />
            </div>

            {status === 'declined' && request.rejectionReason && (
              <div className="bg-[#fdecea] rounded-xl border border-[#f5c6bd] p-4">
                <p className="text-[11px] uppercase font-bold tracking-wider text-[#8a2a18]">Rejection reason (shown to customer)</p>
                <p className="text-[13px] text-[#8a2a18] mt-1">{request.rejectionReason}</p>
              </div>
            )}

            {proposalAnswered && (
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-5">
                <p className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">
                  Customer decision
                </p>
                <p className="text-[14px] text-[var(--color-botanical-primary)] font-semibold mt-1">
                  {proposal.status === 'accepted' ? 'Proposal accepted' : 'Proposal declined'}
                  {proposal.respondedAt ? ` · ${formatDate(proposal.respondedAt)}` : ''}
                </p>
                {proposal.status === 'declined' && proposal.declineReason && (
                  <p className="text-[12px] text-[var(--color-botanical-muted)] mt-1">Reason: {proposal.declineReason}</p>
                )}
                {proposal.declineReason === '' && proposal.status === 'declined' && (
                  <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-1">No reason given.</p>
                )}
              </div>
            )}

            {order && (
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Linked order</p>
                  <p className="text-[14px] font-semibold text-[var(--color-botanical-primary)] mt-1">
                    {order.orderId} · {formatINR(order.total)}
                  </p>
                  <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                    Payment: {order.paymentStatus} · Status: {order.orderStatus}
                  </p>
                </div>
                <Link
                  to={`/admin/orders/${order.orderId}`}
                  className="px-4 py-2 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
                >
                  Open Order
                </Link>
              </div>
            )}
          </div>

          {/* ── RIGHT: actions ────────────────────────────────────────── */}
          <div className="space-y-6">
            {/* Decision */}
            {canDecide && (
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
                <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Your Decision</h2>
                {rejectOpen ? (
                  <div className="space-y-2">
                    <label htmlFor="reject-reason" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)]">
                      Reason for declining (shown to the customer)
                    </label>
                    <textarea
                      id="reject-reason"
                      rows={3}
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      maxLength={500}
                      placeholder="e.g. We can't source this in the requested colours before your date."
                      className="w-full rounded-xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] px-3 py-2.5 text-[13px] resize-y focus:ring-1 focus:ring-[var(--color-focus)] focus:border-[var(--color-focus)]"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busyNow}
                        onClick={handleReject}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-red-700 text-white text-[12px] font-semibold hover:bg-red-800 transition-colors disabled:opacity-60"
                      >
                        {busy === 'reject' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                        {busy === 'reject' ? 'Declining…' : 'Confirm Decline'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRejectOpen(false)}
                        className="px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)] text-[12px] font-semibold"
                      >
                        Keep reviewing
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-[13px] text-[var(--color-botanical-muted)]">
                      Accept the request to start planning the fulfillment and build the customer proposal.
                    </p>
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        disabled={busyNow}
                        onClick={handleAccept}
                        className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-60"
                      >
                        {busy === 'accept' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                        {busy === 'accept' ? 'Accepting…' : 'Accept Request'}
                      </button>
                      <button
                        type="button"
                        disabled={busyNow}
                        onClick={() => setRejectOpen(true)}
                        className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full border border-[#f5c6bd] text-[#8a2a18] text-[13px] font-semibold hover:bg-[#fdecea] transition-colors disabled:opacity-60"
                      >
                        <XCircle className="w-4 h-4" /> Reject Request
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Proposal builder */}
            {canBuild && (
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Fulfillment Proposal</h2>
                  {rowsDirty && <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Unsaved</span>}
                </div>
                <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                  What will you make or prepare for this request? Add your own items — they are specific to this
                  request and never appear in the shop.
                </p>

                <div className="space-y-3">
                  {rows.length === 0 && (
                    <p className="text-[12px] text-[var(--color-botanical-subtle)] border border-dashed border-[var(--color-botanical-border)] rounded-xl px-4 py-3">
                      No items yet — add the first line of the proposal.
                    </p>
                  )}
                  {rows.map((row, index) => {
                    const qty = Math.floor(Number(row.quantity)) || 0;
                    const price = Number(row.unitPrice) || 0;
                    const lineTotal = Math.round(qty * price * 100) / 100;
                    return (
                      <div key={row.key} className="rounded-xl border border-[var(--color-botanical-border)] p-3 space-y-2 bg-[var(--color-surface-low)]/40">
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={row.itemName}
                            onChange={(e) => updateRow(index, { itemName: e.target.value })}
                            placeholder="Item name (e.g. Preserved rose arrangement)"
                            aria-label={`Item ${index + 1} name`}
                            className="flex-1 px-3 py-2 rounded-lg bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[13px] focus:ring-1 focus:ring-[var(--color-focus)]"
                          />
                          <button
                            type="button"
                            onClick={() => removeRow(index)}
                            className="p-2 rounded-lg text-[#8a2a18] hover:bg-[#fdecea] transition-colors"
                            aria-label={`Remove item ${index + 1}`}
                            title="Remove item"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <input
                          type="text"
                          value={row.description}
                          onChange={(e) => updateRow(index, { description: e.target.value })}
                          placeholder="Description (optional)"
                          aria-label={`Item ${index + 1} description`}
                          className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[12px] focus:ring-1 focus:ring-[var(--color-focus)]"
                        />
                        <div className="grid grid-cols-3 gap-2 items-center">
                          <label className="text-[11px] text-[var(--color-botanical-subtle)]">
                            Qty
                            <input
                              type="number"
                              min="1"
                              max="99"
                              value={row.quantity}
                              onChange={(e) => updateRow(index, { quantity: e.target.value })}
                              aria-label={`Item ${index + 1} quantity`}
                              className="mt-1 w-full px-2.5 py-1.5 rounded-lg bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[13px]"
                            />
                          </label>
                          <label className="text-[11px] text-[var(--color-botanical-subtle)]">
                            Unit price (₹)
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={row.unitPrice}
                              onChange={(e) => updateRow(index, { unitPrice: e.target.value })}
                              aria-label={`Item ${index + 1} unit price`}
                              className="mt-1 w-full px-2.5 py-1.5 rounded-lg bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[13px]"
                            />
                          </label>
                          <div className="text-[11px] text-[var(--color-botanical-subtle)]">
                            Line total
                            <p className="mt-1 text-[13px] font-semibold text-[var(--color-botanical-primary)]">
                              {formatINR(lineTotal)}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={addRow}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Item
                </button>

                <div className="border-t border-[var(--color-botanical-border)] pt-3 text-[13px] space-y-1">
                  <div className="flex justify-between text-[var(--color-botanical-muted)]">
                    <span>Subtotal (preview)</span>
                    <span>{formatINR(previewTotals.subtotal)}</span>
                  </div>
                  <p className="text-[11px] text-[var(--color-botanical-subtle)]">
                    Shipping and the final total are calculated by the server when you save / send.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busyNow}
                    onClick={handleSaveDraft}
                    className="px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors disabled:opacity-60"
                  >
                    {busy === 'saveProposal' ? 'Saving…' : 'Save Draft'}
                  </button>
                  <button
                    type="button"
                    disabled={busyNow}
                    onClick={handleSend}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-60"
                  >
                    {busy === 'sendProposal' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    {busy === 'sendProposal' ? 'Sending…' : 'Send Proposal'}
                  </button>
                </div>
              </div>
            )}

            {/* Sent / answered proposal (read-only) */}
            {showReadOnlyProposal && (
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Proposal</h2>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                    {proposal.status === 'sent' ? 'Sent — awaiting customer' : proposal.status === 'accepted' ? 'Accepted' : 'Declined'}
                  </span>
                </div>
                {proposal.items.map((item) => (
                  <div key={item._id} className="flex items-start justify-between gap-3 text-[13px] border-b border-[var(--color-botanical-border-light)] last:border-0 pb-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-[var(--color-botanical-primary)]">{item.itemName}</p>
                      {item.description && <p className="text-[12px] text-[var(--color-botanical-subtle)]">{item.description}</p>}
                    </div>
                    <p className="shrink-0 text-[var(--color-botanical-muted)]">
                      {item.quantity} × {formatINR(item.unitPrice)} = <span className="font-semibold text-[var(--color-botanical-primary)]">{formatINR(item.lineTotal)}</span>
                    </p>
                  </div>
                ))}
                <div className="text-[13px] space-y-1 pt-1">
                  <div className="flex justify-between text-[var(--color-botanical-muted)]">
                    <span>Subtotal</span>
                    <span>{formatINR(proposal.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-[var(--color-botanical-muted)]">
                    <span>Shipping</span>
                    <span>{proposal.shipping > 0 ? formatINR(proposal.shipping) : 'Complimentary'}</span>
                  </div>
                  <div className="flex justify-between font-bold text-[var(--color-botanical-primary)] text-[15px]">
                    <span>Total</span>
                    <span>{formatINR(proposal.total)}</span>
                  </div>
                </div>
                {proposalSent && (
                  <button
                    type="button"
                    disabled={busyNow}
                    onClick={handleWithdraw}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] transition-colors disabled:opacity-60"
                  >
                    <Undo2 className="w-3.5 h-3.5" /> Withdraw Proposal
                  </button>
                )}
              </div>
            )}

            {/* Fulfillment */}
            {['paid', 'in_progress', 'completed'].includes(status) && (
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-3">
                <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Fulfillment</h2>
                {status === 'paid' && (
                  <>
                    <p className="text-[13px] text-[var(--color-botanical-muted)]">
                      Payment received. Start working on the gift and update the stage as you go.
                    </p>
                    <button
                      type="button"
                      disabled={busyNow}
                      onClick={() => handleFulfillment('in_progress', 'Marked in progress')}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-60"
                    >
                      {busy === 'in_progress' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Hammer className="w-4 h-4" />}
                      Mark In Progress
                    </button>
                  </>
                )}
                {status === 'in_progress' && (
                  <>
                    <p className="text-[13px] text-[var(--color-botanical-muted)]">Your studio is crafting this gift.</p>
                    <button
                      type="button"
                      disabled={busyNow}
                      onClick={() => handleFulfillment('completed', 'Marked completed')}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-60"
                    >
                      {busy === 'completed' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackageCheck className="w-4 h-4" />}
                      Mark Completed
                    </button>
                  </>
                )}
                {status === 'completed' && (
                  <p className="text-[13px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
                    This custom request is complete. The customer can see the completed status.
                  </p>
                )}
              </div>
            )}

            {['declined', 'customer_declined'].includes(status) && (
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6">
                <p className="text-[13px] text-[var(--color-botanical-muted)]">
                  {status === 'declined'
                    ? 'This request was declined — the workflow is closed. The customer can see the reason.'
                    : 'The customer declined this proposal — the workflow is closed.'}
                </p>
              </div>
            )}

            {/* Internal notes */}
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-3">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Internal Notes</h2>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="Internal notes about this request — never shown to the customer."
                className="w-full rounded-xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] px-3 py-2.5 text-[13px] resize-y focus:ring-1 focus:ring-[var(--color-focus)]"
              />
              <button
                type="button"
                disabled={busyNow}
                onClick={handleSaveNotes}
                className="px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-60"
              >
                {busy === 'notes' ? 'Saving…' : 'Save Notes'}
              </button>
            </div>

            {/* Server-calculated totals reference (draft saved state) */}
            {showServerTotals && proposal && (
              <p className="text-[11px] text-[var(--color-botanical-subtle)]">
                Server-calculated totals on record: subtotal {formatINR(proposal.subtotal)} · shipping{' '}
                {proposal.shipping > 0 ? formatINR(proposal.shipping) : 'free'} · total {formatINR(proposal.total)}.
              </p>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}

function Field({ label, value, capitalize = false, className = '' }) {
  return (
    <div className={className}>
      <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">{label}</p>
      <p className={`text-[14px] text-[var(--color-botanical-primary)] font-semibold mt-1 ${capitalize ? 'capitalize' : ''}`}>
        {value}
      </p>
    </div>
  );
}
