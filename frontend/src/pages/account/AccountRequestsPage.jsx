import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles, Plus } from 'lucide-react';
import { getMyCustomRequests } from '../../services/customRequestService.js';
import { RequestStatusPill, requestStatusNote } from '../../components/StatusPill.jsx';
import { formatDate } from '../../services/orderService.js';

/**
 * MY REQUESTS — every bespoke request this customer has sent the studio.
 *
 * The status shown is the REAL persisted request status; the detail page is
 * where the tracker, proposal and payment live. No workspace terminology and
 * no admin controls appear here.
 */
export default function AccountRequestsPage() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getMyCustomRequests();
        if (!cancelled) setRequests(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Unable to load your requests.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-7 w-48 bg-[var(--color-surface-container)] rounded" />
        <div className="h-24 bg-[var(--color-surface-container)] rounded-2xl" />
        <div className="h-24 bg-[var(--color-surface-container)] rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-[24px] text-[var(--color-botanical-primary)]">My Custom Requests</h2>
          <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-0.5">
            Track your bespoke requests, review proposals and complete payment.
          </p>
        </div>
        <Link
          to="/custom-request"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New Request
        </Link>
      </div>

      {error && (
        <div className="p-4 rounded-2xl bg-red-50 border border-red-200 text-[13px] text-red-700" role="alert">
          {error}
        </div>
      )}

      {!error && requests.length === 0 && (
        <div className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-10 text-center space-y-4">
          <span className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center">
            <Sparkles className="w-6 h-6 text-[var(--color-accent)]" aria-hidden="true" />
          </span>
          <h3 className="font-serif text-[20px] text-[var(--color-botanical-primary)]">No custom requests yet</h3>
          <p className="text-[13px] text-[var(--color-botanical-subtle)] max-w-sm mx-auto">
            Tell our studio what you have in mind — a bespoke gift, a custom version of a piece you love, or
            something entirely new.
          </p>
          <Link
            to="/custom-request"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
          >
            Start a Custom Request <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </Link>
        </div>
      )}

      {requests.length > 0 && (
        <ul className="space-y-3">
          {requests.map((req) => {
            const id = req._id || req.id;
            return (
              <li key={id}>
                <Link
                  to={`/account/requests/${id}`}
                  className="block bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)] px-5 py-4 hover:border-[var(--color-accent)] hover:shadow-sm transition-all"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-semibold text-[var(--color-botanical-primary)] line-clamp-1">
                        {req.description}
                      </p>
                      <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-1">
                        {req.productName ? `From ${req.productName} · ` : ''}
                        {formatDate(req.createdAt)}
                      </p>
                      <p className="text-[12px] text-[var(--color-botanical-muted)] mt-1.5">{requestStatusNote(req.status)}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <RequestStatusPill status={req.status} />
                      <ArrowRight className="w-4 h-4 text-[var(--color-botanical-subtle)]" aria-hidden="true" />
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
