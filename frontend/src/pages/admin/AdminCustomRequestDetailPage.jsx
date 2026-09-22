import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getAllCustomRequests, updateCustomRequestStatus } from '../../services/customRequestService.js';
import { getCustomers } from '../../services/customerService.js';
import { formatDate } from '../../services/orderService.js';
import { useStore } from '../../context/StoreContext.jsx';

const STATUSES = ['pending', 'reviewing', 'quoted', 'accepted', 'declined'];

const STATUS_BADGE = {
  pending: 'bg-[#fdf6e3] text-[#8a6d1a] border-[#e9d8a6]',
  reviewing: 'bg-[#eef3fb] text-[#3a5a8c] border-[#c9d9ef]',
  quoted: 'bg-[#f3eefb] text-[#6b4fa1] border-[#ddd0f0]',
  accepted: 'bg-[#e8f0e6] text-[#3f5a3a] border-[#c4d6bf]',
  declined: 'bg-[#fdecea] text-[#8a2a18] border-[#f5c6bd]',
};

export default function AdminCustomRequestDetailPage() {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const { showToast } = useStore();

  const [request, setRequest] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setNotFound(false);
    try {
      // The staff API returns the (≤200) newest requests; find ours.
      // Backend has no GET /:id — kept unchanged by design.
      const list = await getAllCustomRequests('All');
      const found = (Array.isArray(list) ? list : []).find(
        (r) => String(r._id || r.id) === String(requestId)
      );
      if (!found) {
        setNotFound(true);
      } else {
        setRequest(found);
        setStatus(found.status);
        setNotes(found.adminNotes || '');
      }
      setLoaded(true);
    } catch (err) {
      setLoadError(err.message || 'Unable to load this custom request.');
      setLoaded(true);
    }
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  const customerName = (() => {
    try {
      const key = String(request?.customerId || '');
      const c = getCustomers().find((x) => String(x.id || x._id) === key);
      return c ? c.name || c.email : 'Customer';
    } catch {
      return 'Customer';
    }
  })();

  const handleSave = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaveError(null);
    setSaving(true);
    try {
      const updated = await updateCustomRequestStatus(requestId, status, notes);
      setRequest((prev) => ({ ...prev, ...updated }));
      setStatus(updated.status);
      setNotes(updated.adminNotes || '');
      setSavedAt(new Date());
      showToast(`Request marked ${updated.status}`);
    } catch (err) {
      setSaveError(err.message || 'Unable to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <AdminLayout>
        <div className="max-w-7xl mx-auto space-y-6 pb-12">
          <div className="h-8 w-48 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-xl border border-[var(--color-botanical-border)] dark:border-[#3a3530] p-6 space-y-4 animate-pulse">
              <div className="h-5 w-1/3 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
              <div className="h-4 w-full bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
              <div className="h-4 w-3/4 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
              <div className="h-4 w-1/2 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
            </div>
            <div className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-xl border border-[var(--color-botanical-border)] dark:border-[#3a3530] p-6 space-y-4 animate-pulse">
              <div className="h-5 w-1/2 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
              <div className="h-4 w-full bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
              <div className="h-4 w-2/3 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
            </div>
          </div>
        </div>
      </AdminLayout>
    );
  }

  if (notFound || !request) {
    return (
      <AdminLayout>
        <div className="max-w-7xl mx-auto pb-12">
          <div className="p-12 sm:p-16 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-4 shadow-xs border border-[var(--color-botanical-border)]">
            <div className="w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-[var(--color-botanical-subtle)]">
              <span className="material-symbols-outlined text-[32px]">search_off</span>
            </div>
            <div className="max-w-md mx-auto">
              <h3 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium">Request Not Found</h3>
              <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1.5">
                This custom request may have been removed, or the reference is invalid.
              </p>
            </div>
            <Link to="/admin/custom-requests" className="inline-block px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-xs hover:bg-[var(--color-btn-hover-alt)] transition-colors">
              Return to Custom Requests
            </Link>
          </div>
        </div>
      </AdminLayout>
    );
  }

  if (loadError) {
    return (
      <AdminLayout>
        <div className="max-w-7xl mx-auto pb-12">
          <div className="p-8 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-4 border border-[#f5c6bd] bg-[#fdecea]">
            <p className="text-[14px] text-[#8a2a18]">{loadError}</p>
            <button type="button" onClick={load} className="px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold">
              Retry
            </button>
          </div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="max-w-5xl mx-auto space-y-6 pb-12">
        <div className="flex items-center gap-3">
          <Link to="/admin/custom-requests" className="p-2 rounded-xl hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)] transition-colors" aria-label="Back to custom requests">
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          </Link>
          <div className="min-w-0">
            <h1 className="font-serif text-2xl sm:text-3xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Custom Request</h1>
            <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-0.5">Submitted {formatDate(request.createdAt)} · by {customerName}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Request details */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">The Idea</h2>
                <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold capitalize border ${STATUS_BADGE[request.status] || 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)]'}`}>
                  {request.status}
                </span>
              </div>
              <p className="text-[14px] text-[var(--color-botanical-muted)] leading-relaxed whitespace-pre-wrap">{request.description}</p>
            </div>

            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Customer</p>
                <p className="text-[14px] text-[var(--color-botanical-primary)] font-semibold mt-1">{customerName}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Occasion</p>
                <p className="text-[14px] text-[var(--color-botanical-primary)] font-semibold mt-1 capitalize">{request.occasion || '—'}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Budget</p>
                <p className="text-[14px] text-[var(--color-botanical-primary)] font-semibold mt-1">{request.budget || '—'}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Desired Date</p>
                <p className="text-[14px] text-[var(--color-botanical-primary)] font-semibold mt-1">{request.desiredDate ? formatDate(request.desiredDate) : '—'}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Preferred Colors</p>
                <p className="text-[14px] text-[var(--color-botanical-primary)] font-semibold mt-1">{request.colors || '—'}</p>
              </div>
            </div>

            {/* Reference image — only if the customer provided one */}
            {request.imageUrl ? (
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
                <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] mb-3">Reference Image</p>
                <img
                  loading="lazy"
                  decoding="async" src={request.imageUrl} alt={`Reference for custom request by ${customerName}`} className="rounded-xl max-h-96 w-full object-contain bg-[var(--color-surface-low)]" />
              </div>
            ) : null}
          </div>

          {/* Status update panel */}
          <div className="space-y-6">
            <form onSubmit={handleSave} className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Update Status</h2>
              <div>
                <label htmlFor="cr-status" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                  Status
                </label>
                <select
                  id="cr-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="w-full rounded-xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] px-3 py-2.5 text-[14px] text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] focus:border-[var(--color-focus)] transition"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="cr-notes" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                  Admin Notes
                </label>
                <textarea
                  id="cr-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={5}
                  maxLength={2000}
                  placeholder="Internal notes about this request…"
                  className="w-full rounded-xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] px-3 py-2.5 text-[14px] text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] focus:border-[var(--color-focus)] transition resize-y"
                />
              </div>
              {saveError && (
                <p className="p-2.5 rounded-lg bg-[#fdecea] border border-[#f5c6bd] text-[12px] text-[#8a2a18]" role="alert">
                  {saveError}
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <span aria-live="polite" className="text-[12px] font-semibold text-[var(--color-botanical-sage)]">
                  {saving ? 'Saving…' : savedAt ? `Saved ✓` : ''}
                </span>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-xs hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
