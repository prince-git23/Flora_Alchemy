import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Play, ShieldCheck, EyeOff, Eye, Trash2, Flag } from 'lucide-react';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import {
  listReviewsForModeration,
  setReviewStatus,
  deleteReview,
} from '../../services/adminReviewService.js';
import {
  StaffEmptyState,
  StaffTableSkeleton,
  AdminToast,
  StaffButton,
} from '../../components/admin/StaffPrimitives.jsx';
import HeartRating from '../../components/reviews/HeartRating.jsx';
import ReviewMediaViewer from '../../components/reviews/ReviewMediaViewer.jsx';

/**
 * PHASE 3 — review moderation (/admin/reviews).
 *
 * The operational half of the review feature: customer media and text are
 * published the moment they are written, so the studio needs a real queue to
 * hide abuse, restore a mistake, and see what customers reported.
 *
 * What this screen is careful about:
 *   · tabs and their counts are the SERVER's whole-ledger counts, so applying
 *     a tab never changes what a number means
 *   · hide / restore / delete are the server's decision, not the page's — a
 *     staff session is offered what it may actually do (delete is admin-only)
 *   · no customer identifier, email or internal id is projected; the review
 *     carries only the public snapshot name the customer published under
 *   · media opens in the shared viewer, which never autoplays a clip
 */

const TABS = [
  { key: 'published', label: 'Published', icon: Eye },
  { key: 'hidden', label: 'Hidden', icon: EyeOff },
  { key: 'reported', label: 'Reported', icon: Flag },
];

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function AdminReviewsPage() {
  const { session } = useAdminSession();
  const isAdmin = session?.role === 'admin' || session?.isOwner;

  const [tab, setTab] = useState('published');
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ published: 0, hidden: 0, reported: 0 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [mediaViewer, setMediaViewer] = useState(null);

  const load = useCallback(async (nextTab = tab) => {
    setLoading(true);
    setError('');
    try {
      const result = await listReviewsForModeration({ tab: nextTab, limit: 30 });
      setRows(result.reviews);
      setCounts(result.counts);
    } catch (err) {
      setError(err.message || 'The moderation queue could not be loaded.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { load(tab); }, [tab, load]);

  const flash = (message) => setToast({ id: Date.now(), message, tone: 'success' });

  const toggleStatus = async (row) => {
    const next = row.status === 'HIDDEN' ? 'PUBLISHED' : 'HIDDEN';
    setBusyId(row.id);
    try {
      await setReviewStatus(row.id, next);
      flash(next === 'HIDDEN' ? 'Review hidden from the storefront.' : 'Review restored to the storefront.');
      await load(tab);
    } catch (err) {
      setToast({ id: Date.now(), message: err.message || 'That review could not be updated.', tone: 'danger' });
    } finally {
      setBusyId('');
    }
  };

  const remove = async (row) => {
    setBusyId(row.id);
    try {
      await deleteReview(row.id);
      flash('Review deleted permanently.');
      await load(tab);
    } catch (err) {
      setToast({ id: Date.now(), message: err.message || 'That review could not be deleted.', tone: 'danger' });
    } finally {
      setBusyId('');
    }
  };

  const mediaFor = useMemo(() => (row) => [
    ...(row.photos || []).map((url) => ({
      url, type: 'image', author: row.customerName, rating: row.rating, caption: row.title || row.comment || '',
    })),
    ...(row.video
      ? [{ url: row.video, type: 'video', author: row.customerName, rating: row.rating, caption: row.title || row.comment || '' }]
      : []),
  ], []);

  return (
    <AdminLayout>
      <div className="space-y-6">
        <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Customers</span>
            <h1 className="font-serif text-[26px] sm:text-[32px] text-[var(--color-botanical-primary)] mt-1">Review moderation</h1>
            <p className="text-[13px] text-[var(--color-botanical-muted)] mt-1 max-w-2xl">
              Customer reviews publish immediately. Hiding one removes it from the product page, its rating
              average, the distribution and the customer-media rail at the same time.
            </p>
          </div>
          <button
            type="button"
            onClick={() => load(tab)}
            className="self-start inline-flex items-center gap-2 min-h-[44px] px-4 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
          </button>
        </header>

        <div role="tablist" aria-label="Moderation queue" className="flex flex-wrap items-center gap-2">
          {TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            const count = counts[key] ?? 0;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(key)}
                className={`inline-flex items-center gap-2 min-h-[44px] px-4 rounded-full border text-[13px] font-semibold transition-colors ${
                  active
                    ? 'bg-[var(--color-btn)] text-white border-[var(--color-btn)]'
                    : 'bg-[var(--color-surface-lowest)] border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)]'
                }`}
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                {label}
                <span className={`tabular-nums text-[12px] ${active ? 'text-white/80' : 'text-[var(--color-botanical-subtle)]'}`}>{count}</span>
              </button>
            );
          })}
        </div>

        {error && (
          <p role="alert" className="text-[13px] text-[var(--color-danger)] bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 rounded-2xl px-4 py-3">
            {error}
          </p>
        )}

        {loading ? (
          <StaffTableSkeleton rows={5} />
        ) : rows.length === 0 ? (
          <StaffEmptyState
            icon="reviews"
            title={tab === 'hidden' ? 'Nothing hidden' : tab === 'reported' ? 'No reports' : 'No reviews yet'}
            description={
              tab === 'hidden'
                ? 'Every published review is currently visible on the storefront.'
                : tab === 'reported'
                  ? 'No customer has reported a review. Reports appear here for a human decision.'
                  : 'Reviews appear here the moment a customer shares one.'
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)]">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[var(--color-botanical-border)] text-[11px] uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                  <th className="px-4 py-3 font-bold">Review</th>
                  <th className="px-4 py-3 font-bold">Product</th>
                  <th className="px-4 py-3 font-bold">Media</th>
                  <th className="px-4 py-3 font-bold">Status</th>
                  <th className="px-4 py-3 font-bold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const media = mediaFor(row);
                  const busy = busyId === row.id;
                  return (
                    <tr key={row.id} className="border-b last:border-b-0 border-[var(--color-botanical-border)] align-top">
                      <td className="px-4 py-4 max-w-[420px]">
                        <div className="flex items-center gap-2 flex-wrap">
                          <HeartRating value={row.rating} size={13} className="text-[var(--color-accent)]" label={`${row.rating} of 5 hearts`} />
                          {row.verified ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--color-botanical-sage)]">
                              <ShieldCheck className="w-3 h-3" aria-hidden="true" /> Verified
                            </span>
                          ) : null}
                          {row.reportedCount > 0 ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--color-warning-soft-fg)]">
                              <Flag className="w-3 h-3" aria-hidden="true" /> {row.reportedCount} report{row.reportedCount === 1 ? '' : 's'}
                            </span>
                          ) : null}
                        </div>
                        <p className="text-[12px] text-[var(--color-botanical-muted)] mt-1.5">
                          <span className="font-semibold text-[var(--color-botanical-primary)]">{row.customerName}</span>
                          {' · '}{formatDateTime(row.createdAt)}
                        </p>
                        {row.title ? (
                          <p className="font-serif text-[14px] text-[var(--color-botanical-primary)] mt-1.5">{row.title}</p>
                        ) : null}
                        {row.comment ? (
                          <p className="text-[12px] text-[var(--color-botanical-muted)] mt-1 leading-relaxed line-clamp-4">{row.comment}</p>
                        ) : null}
                        {row.reportReasons.length > 0 ? (
                          <ul className="mt-2 space-y-0.5 list-none p-0 m-0">
                            {row.reportReasons.map((reason, i) => (
                              <li key={`${row.id}-reason-${i}`} className="text-[11px] text-[var(--color-warning-soft-fg)]">“{reason}”</li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                      <td className="px-4 py-4">
                        <Link to={`/product/${row.productSlug}`} className="text-[12px] font-semibold text-[var(--color-accent)] hover:underline">
                          {row.productName}
                        </Link>
                        <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-0.5 font-mono">{row.productSlug}</p>
                      </td>
                      <td className="px-4 py-4">
                        {media.length === 0 ? (
                          <span className="text-[12px] text-[var(--color-botanical-subtle)]">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {media.map((item, idx) => (
                              <button
                                key={`${row.id}-media-${idx}`}
                                type="button"
                                onClick={() => setMediaViewer({ items: media, index: idx })}
                                aria-label={item.type === 'video' ? 'Play customer video' : 'Open customer photo'}
                                className={`relative w-12 h-12 rounded-lg overflow-hidden bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${row.status === 'HIDDEN' ? 'opacity-60' : ''}`}
                              >
                                {item.type === 'video' ? (
                                  <>
                                    <video src={item.url} preload="metadata" muted playsInline className="w-full h-full object-cover" />
                                    <span className="absolute inset-0 flex items-center justify-center bg-black/35">
                                      <Play className="w-3 h-3 text-white" aria-hidden="true" />
                                    </span>
                                  </>
                                ) : (
                                  <img src={item.url} alt="" loading="lazy" className="w-full h-full object-cover" />
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold ${row.status === 'HIDDEN' ? 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]' : 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)]'}`}>
                          {row.status}
                        </span>
                        {row.moderatedAt ? (
                          <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1.5">Changed {formatDateTime(row.moderatedAt)}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2">
                          <StaffButton
                            type="button"
                            variant="secondary"
                            onClick={() => toggleStatus(row)}
                            disabled={busy}
                            icon={row.status === 'HIDDEN' ? 'visibility' : 'visibility_off'}
                          >
                            {row.status === 'HIDDEN' ? 'Restore' : 'Hide'}
                          </StaffButton>
                          {isAdmin ? (
                            <button
                              type="button"
                              onClick={() => remove(row)}
                              disabled={busy}
                              className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3.5 rounded-full bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/40 text-[var(--color-danger)] text-[12px] font-semibold hover:bg-[var(--color-danger)]/15 transition-colors disabled:opacity-50"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Delete
                            </button>
                          ) : (
                            <span className="text-[11px] text-[var(--color-botanical-subtle)] self-center">Admin only</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[12px] text-[var(--color-botanical-subtle)]">
          Counts are whole-ledger totals from the server. Staff may hide or restore a review; only an
          administrator may delete one.
        </p>
      </div>

      {mediaViewer && (
        <ReviewMediaViewer
          items={mediaViewer.items}
          startIndex={mediaViewer.index}
          onClose={() => setMediaViewer(null)}
        />
      )}

      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
    </AdminLayout>
  );
}
