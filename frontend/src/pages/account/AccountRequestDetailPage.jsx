import React, { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import {
  ArrowLeft, CheckCircle2, Circle, XCircle, Loader2, CreditCard, ExternalLink,
} from 'lucide-react';
import {
  getCustomRequest,
  acceptProposal,
  declineProposal,
} from '../../services/customRequestService.js';
import { RequestStatusPill, requestStatusNote } from '../../components/StatusPill.jsx';
import ReferenceImage from '../../components/ReferenceImage.jsx';
import {
  createPaymentOrder,
  verifyPayment,
  openRazorpayCheckout,
} from '../../services/paymentService.js';
import { formatINR, formatDate } from '../../services/orderService.js';
import { useStore } from '../../context/StoreContext.jsx';

/**
 * MY REQUEST — the customer-side tracker for one custom request.
 *
 * Every step shown here is derived from the REAL persisted server state
 * (request.status + the stored proposal + the order the proposal created).
 * There is no decorative timeline: if the request is declined, the tracker
 * says so; if the proposal is waiting for the customer, the decision buttons
 * are the real workflow endpoints.
 *
 * Payment reuses the EXISTING architecture (payments/create-order → Razorpay
 * Checkout → payments/verify); the server remains the only writer of a paid
 * state. No admin controls, no workspace terminology, no internal notes.
 */

function buildTracker(request, proposal) {
  const s = request.status;
  const step = (label, state, detail) => ({ label, state, detail });

  // Terminal branches keep their own honest rows — nothing is faked.
  if (s === 'declined') {
    return [
      step('Request submitted', 'done'),
      step('Studio review', 'done'),
      step('Request declined', 'failed', request.rejectionReason || 'This request could not be taken forward.'),
    ];
  }
  if (s === 'customer_declined') {
    return [
      step('Request submitted', 'done'),
      step('Studio review', 'done'),
      step('Proposal received', 'done'),
      step('Proposal declined', 'failed', proposal?.declineReason || 'You declined this proposal.'),
    ];
  }

  const labels = ['Request submitted', 'Studio review', 'Proposal', 'Your decision', 'Fulfillment', 'Completed'];
  const statesByStatus = {
    pending: ['done', 'current', 'next', 'next', 'next', 'next'],
    reviewing: ['done', 'current', 'next', 'next', 'next', 'next'],
    accepted: ['done', 'done', 'current', 'next', 'next', 'next'],
    quoted: ['done', 'done', 'done', 'current', 'next', 'next'],
    payment_pending: ['done', 'done', 'done', 'current', 'next', 'next'],
    paid: ['done', 'done', 'done', 'done', 'current', 'next'],
    in_progress: ['done', 'done', 'done', 'done', 'current', 'next'],
    completed: ['done', 'done', 'done', 'done', 'done', 'done'],
  };
  const states = statesByStatus[s] || ['done', 'current', 'next', 'next', 'next', 'next'];
  const details = [
    undefined,
    s === 'pending' || s === 'reviewing' ? 'Our studio is reviewing your brief.' : undefined,
    s === 'accepted' ? 'Your proposal is being prepared.' : undefined,
    s === 'quoted'
      ? 'Review the proposal below — accept to continue to payment.'
      : s === 'payment_pending'
        ? 'Complete the payment to begin fulfillment.'
        : undefined,
    s === 'paid'
      ? 'Our studio will begin crafting your gift.'
      : s === 'in_progress'
        ? 'Your gift is being crafted.'
        : undefined,
    s === 'completed' ? 'Your custom gift is complete.' : undefined,
  ];
  return labels.map((label, i) => step(label, states[i], details[i]));
}

const STEP_ICON = {
  done: <CheckCircle2 className="w-4 h-4 text-emerald-700" aria-hidden="true" />,
  current: <Loader2 className="w-4 h-4 text-[var(--color-accent)] animate-spin" aria-hidden="true" />,
  next: <Circle className="w-4 h-4 text-[var(--color-botanical-subtle)]" aria-hidden="true" />,
  failed: <XCircle className="w-4 h-4 text-red-600" aria-hidden="true" />,
};

export default function AccountRequestDetailPage() {
  const { requestId } = useParams();
  const { profile } = useOutletContext();
  const { showToast } = useStore();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [request, setRequest] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [order, setOrder] = useState(null);

  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState('');
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setNotFound(false);
    try {
      const res = await getCustomRequest(requestId, 'customer');
      setRequest(res.request);
      setProposal(res.proposal);
      setOrder(res.order);
    } catch (err) {
      if (err.status === 404) setNotFound(true);
      else setLoadError(err.message || 'Unable to load this request.');
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAccept = async () => {
    if (acting) return;
    setActing(true);
    setActionError('');
    try {
      const res = await acceptProposal(requestId);
      setRequest(res.request);
      setProposal(res.proposal);
      setOrder(res.order);
      showToast('Proposal accepted');
    } catch (err) {
      setActionError(err.message || 'The proposal could not be accepted. Please try again.');
    } finally {
      setActing(false);
    }
  };

  const handleDecline = async () => {
    if (acting) return;
    setActing(true);
    setActionError('');
    try {
      const res = await declineProposal(requestId, declineReason.trim());
      setRequest(res.request);
      setProposal(res.proposal);
      setDeclineOpen(false);
      showToast('Proposal declined');
    } catch (err) {
      setActionError(err.message || 'The proposal could not be declined. Please try again.');
    } finally {
      setActing(false);
    }
  };

  // Proceed to payment — the EXISTING Razorpay flow against the REAL order the
  // accepted proposal created. The client only receives public checkout data;
  // the server verifies the signature before the request becomes Paid.
  const handlePay = async () => {
    const orderRef = order?.orderId;
    if (!orderRef || paying) return;
    setPaying(true);
    setActionError('');
    try {
      const pay = await createPaymentOrder(orderRef);
      const result = await openRazorpayCheckout({
        keyId: pay.razorpayKeyId,
        orderId: pay.razorpayOrderId,
        amount: pay.amount,
        currency: pay.currency,
        name: profile?.name || '',
        email: profile?.email || '',
        phone: profile?.phone || '',
        description: `Custom request order ${orderRef}`,
      });
      if (result.success) {
        await verifyPayment(orderRef, {
          razorpay_payment_id: result.razorpay_payment_id,
          razorpay_order_id: result.razorpay_order_id,
          razorpay_signature: result.razorpay_signature,
        });
        showToast('Payment successful');
        await load();
      } else {
        await verifyPayment(orderRef, { outcome: 'failed', failureReason: result.reason }).catch(() => {});
        setActionError(result.reason || 'Payment was not completed. You can try again.');
      }
    } catch (err) {
      if (err.code === 'PAYMENT_NOT_CONFIGURED') {
        setActionError('Online payment is not available in this environment. Please contact the studio.');
      } else {
        setActionError(err.message || 'Payment could not be started. Please try again.');
      }
    } finally {
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-7 w-56 bg-[var(--color-surface-container)] rounded" />
        <div className="h-40 bg-[var(--color-surface-container)] rounded-3xl" />
        <div className="h-64 bg-[var(--color-surface-container)] rounded-3xl" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-10 text-center space-y-4">
        <h2 className="font-serif text-[22px] text-[var(--color-botanical-primary)]">Request not found</h2>
        <p className="text-[13px] text-[var(--color-botanical-subtle)]">
          This request does not exist, or it belongs to another account.
        </p>
        <Link
          to="/account/requests"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold"
        >
          All my requests
        </Link>
      </div>
    );
  }

  if (loadError || !request) {
    return (
      <div className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-8 text-center space-y-4">
        <p className="text-[13px] text-red-700">{loadError || 'Unable to load this request.'}</p>
        <button type="button" onClick={load} className="px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold">
          Retry
        </button>
      </div>
    );
  }

  const tracker = buildTracker(request, proposal);
  const showProposal = proposal && ['sent', 'accepted', 'declined'].includes(proposal.status);
  const showPaymentPanel =
    order && ['payment_pending', 'paid', 'in_progress', 'completed'].includes(request.status);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/account/requests"
          className="p-2 rounded-full hover:bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] transition-colors"
          aria-label="Back to my requests"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-serif text-[24px] text-[var(--color-botanical-primary)]">Your Custom Request</h2>
            <RequestStatusPill status={request.status} />
          </div>
          <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-0.5">
            Submitted {formatDate(request.createdAt)}
            {request.productName ? ` · started from ${request.productName}` : ''}
          </p>
        </div>
      </div>

      {/* ── Tracker (real persisted state only) ─────────────────────── */}
      <section className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6">
        <h3 className="font-serif text-[18px] text-[var(--color-botanical-primary)] mb-4">Progress</h3>
        <ol className="space-y-3">
          {tracker.map((s, i) => (
            <li key={`${s.label}-${i}`} className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0">{STEP_ICON[s.state] || STEP_ICON.next}</span>
              <div className="min-w-0">
                <p
                  className={`text-[14px] ${
                    s.state === 'next'
                      ? 'text-[var(--color-botanical-subtle)]'
                      : s.state === 'failed'
                        ? 'text-red-700 font-semibold'
                        : 'text-[var(--color-botanical-primary)] font-semibold'
                  }`}
                >
                  {s.label}
                </p>
                {s.detail && <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-0.5">{s.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-[12px] text-[var(--color-botanical-muted)] border-t border-[var(--color-botanical-border)] pt-3">
          {requestStatusNote(request.status)}
        </p>
        {request.status === 'declined' && request.rejectionReason && (
          <p className="mt-2 text-[12px] text-red-700">Reason: {request.rejectionReason}</p>
        )}
      </section>

      {/* ── Request summary ─────────────────────────────────────────── */}
      <section className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6 space-y-4">
        <h3 className="font-serif text-[18px] text-[var(--color-botanical-primary)]">Your Brief</h3>
        <p className="text-[14px] text-[var(--color-botanical-muted)] leading-relaxed whitespace-pre-wrap">{request.description}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]">
          <div>
            <p className="uppercase font-bold tracking-wider text-[10px] text-[var(--color-botanical-subtle)]">Occasion</p>
            <p className="text-[13px] text-[var(--color-botanical-primary)] mt-0.5">{request.occasion || '—'}</p>
          </div>
          <div>
            <p className="uppercase font-bold tracking-wider text-[10px] text-[var(--color-botanical-subtle)]">Budget</p>
            <p className="text-[13px] text-[var(--color-botanical-primary)] mt-0.5">{request.budget || '—'}</p>
          </div>
          <div>
            <p className="uppercase font-bold tracking-wider text-[10px] text-[var(--color-botanical-subtle)]">Colors</p>
            <p className="text-[13px] text-[var(--color-botanical-primary)] mt-0.5">{request.colors || '—'}</p>
          </div>
          <div>
            <p className="uppercase font-bold tracking-wider text-[10px] text-[var(--color-botanical-subtle)]">Desired date</p>
            <p className="text-[13px] text-[var(--color-botanical-primary)] mt-0.5">
              {request.desiredDate ? formatDate(request.desiredDate) : '—'}
            </p>
          </div>
        </div>
        <div>
          <p className="uppercase font-bold tracking-wider text-[10px] text-[var(--color-botanical-subtle)] mb-2">Reference image</p>
          <ReferenceImage src={request.imageUrl} alt="Your reference image" size="sm" />
        </div>
      </section>

      {/* ── Proposal ────────────────────────────────────────────────── */}
      {showProposal && (
        <section className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-serif text-[18px] text-[var(--color-botanical-primary)]">Your Custom Gift Proposal</h3>
            <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
              {proposal.status === 'sent'
                ? 'Awaiting your decision'
                : proposal.status === 'accepted'
                  ? 'Accepted'
                  : 'Declined'}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-[var(--color-botanical-subtle)] border-b border-[var(--color-botanical-border)]">
                  <th className="py-2 pr-3 font-bold">Item</th>
                  <th className="py-2 pr-3 font-bold text-right">Qty</th>
                  <th className="py-2 pr-3 font-bold text-right">Unit price</th>
                  <th className="py-2 text-right font-bold">Line total</th>
                </tr>
              </thead>
              <tbody>
                {proposal.items.map((item) => (
                  <tr key={item._id} className="border-b border-[var(--color-botanical-border-light)] last:border-0">
                    <td className="py-2.5 pr-3">
                      <p className="font-semibold text-[var(--color-botanical-primary)]">{item.itemName}</p>
                      {item.description && (
                        <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-0.5">{item.description}</p>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-[var(--color-botanical-muted)]">{item.quantity}</td>
                    <td className="py-2.5 pr-3 text-right text-[var(--color-botanical-muted)]">{formatINR(item.unitPrice)}</td>
                    <td className="py-2.5 text-right font-semibold text-[var(--color-botanical-primary)]">{formatINR(item.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-t border-[var(--color-botanical-border)] pt-3 space-y-1.5 text-[13px]">
            <div className="flex justify-between text-[var(--color-botanical-muted)]">
              <span>Subtotal</span>
              <span>{formatINR(proposal.subtotal)}</span>
            </div>
            <div className="flex justify-between text-[var(--color-botanical-muted)]">
              <span>Shipping</span>
              <span>{proposal.shipping > 0 ? formatINR(proposal.shipping) : 'Complimentary'}</span>
            </div>
            <div className="flex justify-between text-[16px] font-bold text-[var(--color-botanical-primary)] pt-1">
              <span>Total</span>
              <span>{formatINR(proposal.total)}</span>
            </div>
          </div>

          {actionError && (
            <p className="p-3 rounded-xl bg-red-50 border border-red-200 text-[12px] text-red-700" role="alert">{actionError}</p>
          )}

          {request.status === 'quoted' && proposal.status === 'sent' && (
            <div className="space-y-3">
              {declineOpen ? (
                <div className="space-y-2">
                  <label htmlFor="decline-reason" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)]">
                    Why are you declining? (optional)
                  </label>
                  <textarea
                    id="decline-reason"
                    rows={3}
                    value={declineReason}
                    onChange={(e) => setDeclineReason(e.target.value)}
                    maxLength={500}
                    placeholder="Let the studio know what didn't work — it helps with future requests."
                    className="w-full p-3 rounded-xl bg-[var(--color-surface-low)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] resize-none"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={acting}
                      onClick={handleDecline}
                      className="px-5 py-2.5 rounded-full bg-red-700 text-white text-[12px] font-semibold hover:bg-red-800 transition-colors disabled:opacity-60"
                    >
                      {acting ? 'Declining…' : 'Confirm Decline'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeclineOpen(false)}
                      className="px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)] text-[12px] font-semibold"
                    >
                      Keep reviewing
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={acting}
                    onClick={handleAccept}
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-60"
                  >
                    {acting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="w-4 h-4" aria-hidden="true" />}
                    {acting ? 'Accepting…' : 'Accept Proposal'}
                  </button>
                  <button
                    type="button"
                    disabled={acting}
                    onClick={() => setDeclineOpen(true)}
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors disabled:opacity-60"
                  >
                    <XCircle className="w-4 h-4" aria-hidden="true" />
                    Decline Proposal
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Payment (real order created from the accepted proposal) ─── */}
      {showPaymentPanel && (
        <section className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6 space-y-4">
          <h3 className="font-serif text-[18px] text-[var(--color-botanical-primary)]">Order &amp; Payment</h3>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">
                Order {order.orderId}
              </p>
              <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                {order.paymentStatus === 'Paid'
                  ? 'Payment received'
                  : order.paymentStatus === 'Sample'
                    ? 'Recorded — online payment is not configured in this environment'
                    : order.paymentStatus === 'Failed'
                      ? 'Last payment attempt failed — you can try again'
                      : 'Payment due'}
              </p>
            </div>
            <p className="text-[16px] font-bold text-[var(--color-botanical-primary)]">{formatINR(order.total)}</p>
          </div>

          {actionError && (
            <p className="p-3 rounded-xl bg-red-50 border border-red-200 text-[12px] text-red-700" role="alert">{actionError}</p>
          )}

          <div className="flex flex-wrap gap-2">
            {order.paymentStatus !== 'Paid' && order.paymentStatus !== 'Sample' && (
              <button
                type="button"
                disabled={paying}
                onClick={handlePay}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-60"
              >
                {paying ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <CreditCard className="w-4 h-4" aria-hidden="true" />}
                {paying ? 'Opening checkout…' : 'Proceed to Payment'}
              </button>
            )}
            <Link
              to={`/order-tracking/${order.orderId}`}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors"
            >
              Track Order <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
