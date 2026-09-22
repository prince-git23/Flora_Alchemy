import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getAllCustomRequests } from '../../services/customRequestService.js';
import { getCustomers } from '../../services/customerService.js';
import { formatDate } from '../../services/orderService.js';
import { AdminRequestStatusPill } from '../../components/admin/AdminStatusPill.jsx';

// Backend enum (backend/models/CustomRequest.js). Do not invent statuses.
const STATUS_FILTERS = ['All', 'pending', 'reviewing', 'quoted', 'accepted', 'declined'];

export default function AdminCustomRequestsPage() {
  const [requests, setRequests] = useState([]);
  const [statusFilter, setStatusFilter] = useState('All');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await getAllCustomRequests(statusFilter);
      setRequests(Array.isArray(list) ? list : []);
      setLoaded(true);
    } catch (err) {
      setLoadError(err.message || 'Unable to load custom requests.');
      setLoaded(true);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Customer names via the existing staff customer list (read-only lookup).
  const customerNames = useMemo(() => {
    const map = {};
    try {
      getCustomers().forEach((c) => {
        const key = String(c.id || c._id || '');
        if (key) map[key] = c.name || c.email || 'Customer';
      });
    } catch {
      /* store not hydrated yet — fall back to a generic label */
    }
    return map;
  }, [requests]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return requests;
    const q = searchQuery.toLowerCase();
    return requests.filter(
      (r) =>
        (customerNames[String(r.customerId)] || '').toLowerCase().includes(q) ||
        (r.occasion || '').toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q)
    );
  }, [requests, searchQuery, customerNames]);

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Custom Requests</h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">Bespoke creation ideas submitted from the storefront{loaded && !loadError ? ` · ${requests.length} request${requests.length !== 1 ? 's' : ''}` : ''}</p>
          </div>
        </div>

        {/* Status filters + search */}
        <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-3.5 shadow-xs flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                aria-pressed={statusFilter === s}
                className={`px-3 py-1.5 rounded-full text-[12px] font-semibold capitalize transition-colors ${
                  statusFilter === s
                    ? 'bg-[var(--color-btn)] text-white'
                    : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-high)]'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="relative lg:ml-auto lg:w-72">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-[var(--color-botanical-subtle)]">search</span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search customer, occasion, idea..."
              aria-label="Search custom requests"
              className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg pl-9 pr-3 py-1.5 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition"
            />
          </div>
        </div>

        {loadError && (
          <div className="p-4 rounded-xl bg-[#fdecea] border border-[#f5c6bd] text-[13px] text-[#8a2a18] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <span>{loadError}</span>
            <button type="button" onClick={load} className="px-4 py-1.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover-alt)] transition-colors self-start sm:self-auto">
              Retry
            </button>
          </div>
        )}

        {/* Empty state */}
        {loaded && !loadError && filtered.length === 0 && (
          <div className="p-12 sm:p-16 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-4 shadow-xs border border-[var(--color-botanical-border)]">
            <div className="w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-[var(--color-botanical-subtle)]">
              <span className="material-symbols-outlined text-[32px]">draw</span>
            </div>
            <div className="max-w-md mx-auto">
              <h3 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium">No custom requests yet</h3>
              <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1.5">
                {searchQuery || statusFilter !== 'All'
                  ? 'No requests match the current filters.'
                  : 'When customers submit bespoke ideas from Custom Request, they will appear here.'}
              </p>
            </div>
            {(searchQuery || statusFilter !== 'All') && (
              <button
                type="button"
                onClick={() => { setSearchQuery(''); setStatusFilter('All'); }}
                className="px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-xs hover:bg-[var(--color-btn-hover-alt)] transition-colors"
              >
                Clear Filters
              </button>
            )}
          </div>
        )}

        {/* Requests table (desktop) */}
        {filtered.length > 0 && (
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-[var(--color-surface-low)] text-[10px] uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                    <th className="px-4 py-3 font-bold">Request</th>
                    <th className="px-4 py-3 font-bold">Customer</th>
                    <th className="px-4 py-3 font-bold">Occasion</th>
                    <th className="px-4 py-3 font-bold">Budget</th>
                    <th className="px-4 py-3 font-bold">Desired Date</th>
                    <th className="px-4 py-3 font-bold">Created</th>
                    <th className="px-4 py-3 font-bold">Status</th>
                    <th className="px-4 py-3 font-bold text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r._id || r.id} className="border-t border-[var(--color-botanical-border-light)] hover:bg-[var(--color-surface-low)] transition-colors">
                      <td className="px-4 py-3 text-[13px] font-semibold text-[var(--color-botanical-primary)] max-w-[240px]">
                        <span className="line-clamp-1">{r.description}</span>
                      </td>
                      <td className="px-4 py-3 text-[13px] text-[var(--color-botanical-muted)]">{customerNames[String(r.customerId)] || 'Customer'}</td>
                      <td className="px-4 py-3 text-[13px] text-[var(--color-botanical-muted)] capitalize">{r.occasion || '—'}</td>
                      <td className="px-4 py-3 text-[13px] text-[var(--color-botanical-muted)]">{r.budget || '—'}</td>
                      <td className="px-4 py-3 text-[13px] text-[var(--color-botanical-muted)]">{r.desiredDate ? formatDate(r.desiredDate) : '—'}</td>
                      <td className="px-4 py-3 text-[13px] text-[var(--color-botanical-subtle)]">{formatDate(r.createdAt)}</td>
                      <td className="px-4 py-3">
                        <AdminRequestStatusPill status={r.status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          to={`/admin/custom-requests/${r._id || r.id}`}
                          className="inline-block px-3.5 py-1.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
                        >
                          View Request
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Card list (mobile) */}
            <div className="md:hidden divide-y divide-[var(--color-divider)]">
              {filtered.map((r) => (
                <Link key={r._id || r.id} to={`/admin/custom-requests/${r._id || r.id}`} className="block p-4 hover:bg-[var(--color-surface-low)] transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)] line-clamp-2">{r.description}</p>
                    <AdminRequestStatusPill status={r.status} className="shrink-0" />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[12px] text-[var(--color-botanical-subtle)]">
                    <span className="font-medium text-[var(--color-botanical-muted)]">{customerNames[String(r.customerId)] || 'Customer'}</span>
                    {r.occasion && <span className="capitalize">{r.occasion}</span>}
                    {r.budget && <span>{r.budget}</span>}
                    <span>{formatDate(r.createdAt)}</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
