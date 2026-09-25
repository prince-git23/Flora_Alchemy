import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import {
  listApplications,
  getApplication,
  approveApplication,
  rejectApplication,
  applicationActivationUrl,
} from '../../services/adminApplicationService.js';
import {
  StaffStatusPill,
  StaffAvatar,
  StaffEmptyState,
  StaffTableSkeleton,
  AdminToast,
  AdminModal,
  StaffButton,
  MetaField,
} from '../../components/admin/StaffPrimitives.jsx';

/**
 * Phase 20.6.6 — Admin Applications review ledger (`/admin/applications`).
 *
 * The owner-facing half of the lifecycle: PUBLIC /apply/admin intake lands
 * here as dossiers, and the only two decisions are Approve and Reject.
 *
 * What makes this screen honest:
 *   · tabs and their counts are the SERVER's whole-ledger counts (they never
 *     change meaning when a filter is applied)
 *   · approve mints a real one-time invitation in a backend transaction; the
 *     raw activation link exists in exactly ONE response, so it is displayed
 *     once, here, and never re-fetchable (only the SHA-256 hash is stored)
 *   · reject requires a written reason (the server enforces ≥10 chars) and
 *     the review decision is one-way: approve-after-reject and
 *     reject-after-approve both answer 409 from the server, surfaced as-is
 *   · actions are offered only when the server said canApprove/canReject —
 *     the UI never invents an action the backend would refuse
 *   · every number, list and status comes from /api/admin-applications
 *
 * Client states: loading · refreshing · ready · error (per load), plus
 * approve dialog (confirm → issued-once), reject dialog (reason required),
 * toasts for the real server verdicts.
 */

const TABS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'INVITED', label: 'Invited' },
  { key: 'ACTIVATED', label: 'Activated' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'EXPIRED', label: 'Expired' },
  { key: 'ALL', label: 'All' },
];

const PAGE_SIZE = 20;

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function initialsOf(name, email) {
  const source = String(name || email || '').trim();
  if (!source) return 'FA';
  const parts = source.includes('@') ? [source.split('@')[0]] : source.split(/\s+/);
  return (parts.filter(Boolean).slice(0, 2).map((p) => p[0]).join('') || 'FA').toUpperCase();
}

export default function AdminApplicationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState('PENDING');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');

  // Selected dossier (deep-linkable via ?id=).
  const [selectedId, setSelectedId] = useState(() => searchParams.get('id') || null);
  const [dossier, setDossier] = useState(null);
  const [dossierInvitation, setDossierInvitation] = useState(null);
  const [dossierState, setDossierState] = useState('idle'); // idle | loading | ready | error

  // Approve dialog: confirm → issued (one-time link shown once).
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveNote, setApproveNote] = useState('');
  const [approving, setApproving] = useState(false);
  const [issued, setIssued] = useState(null); // { link, application, invitation }

  // Reject dialog: written reason required.
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const [toast, setToast] = useState(null);
  const notify = useCallback((title, message, tone = 'success') => {
    setToast({ title, message, tone, id: Date.now() });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setState((prev) => (prev === 'ready' ? 'refreshing' : 'loading'));
    const res = await listApplications({
      status: tab === 'ALL' ? undefined : tab,
      q: debouncedQ,
      page,
      limit: PAGE_SIZE,
    });
    if (!res.ok) {
      setState('error');
      setError(res.message || 'Could not load the application ledger.');
      return;
    }
    setRows(res.applications);
    setCounts(res.counts);
    setHasMore(!!res.hasMore);
    setState('ready');
  }, [tab, debouncedQ, page]);

  useEffect(() => {
    load();
  }, [load]);

  const loadDossier = useCallback(async (id) => {
    if (!id) return;
    setDossierState('loading');
    const res = await getApplication(id);
    if (!res.ok) {
      setDossierState('error');
      notify('Could not open the dossier', res.message, 'error');
      return;
    }
    setDossier(res.application);
    setDossierInvitation(res.invitation);
    setDossierState('ready');
  }, [notify]);

  // Deep link (?id=) selects the dossier once on mount.
  useEffect(() => {
    const initial = searchParams.get('id');
    if (initial) loadDossier(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectRow = (row) => {
    setSelectedId(row.id);
    setIssued(null);
    loadDossier(row.id);
    // Keep the URL shareable without a navigation.
    const next = new URLSearchParams(searchParams);
    next.set('id', row.id);
    setSearchParams(next, { replace: true });
  };

  const clearSelection = () => {
    setSelectedId(null);
    setDossier(null);
    setDossierInvitation(null);
    setDossierState('idle');
    const next = new URLSearchParams(searchParams);
    next.delete('id');
    setSearchParams(next, { replace: true });
  };

  // ── Approve ──────────────────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!dossier || approving) return;
    setApproving(true);
    const res = await approveApplication(dossier.id, { note: approveNote.trim() });
    setApproving(false);
    if (!res.ok) {
      notify('Could not approve this application', res.message, 'error');
      return;
    }
    setIssued({ link: res.link, application: res.application, invitation: res.invitation });
    notify(
      'Application approved',
      `A one-time administrator invitation was issued for ${dossier.email}.`,
      'success'
    );
    load();
    loadDossier(dossier.id);
  };

  const closeApprove = () => {
    setApproveOpen(false);
    setApproveNote('');
    // `issued` is intentionally KEPT: the one-time link moves from the dialog
    // to the page banner so a stray backdrop/Escape click can never destroy
    // the only copy of the activation link. It dies on explicit dismiss.
  };

  const copyLink = async (link) => {
    try {
      await navigator.clipboard.writeText(link);
      notify('Activation link copied', 'Send it over a channel you trust — it is shown only once.', 'success');
    } catch {
      notify('Copy blocked by the browser', 'Select the link and copy it manually.', 'info');
    }
  };

  // ── Reject ───────────────────────────────────────────────────────────────
  const handleReject = async () => {
    if (!dossier || rejecting) return;
    if (rejectReason.trim().length < 10) {
      notify('A written reason is required', 'Rejection needs at least 10 characters of explanation.', 'info');
      return;
    }
    setRejecting(true);
    const res = await rejectApplication(dossier.id, { reason: rejectReason.trim() });
    setRejecting(false);
    if (!res.ok) {
      notify('Could not reject this application', res.message, 'error');
      return;
    }
    notify('Application rejected', `${dossier.email} was informed through the review record.`, 'success');
    setRejectOpen(false);
    setRejectReason('');
    load();
    loadDossier(dossier.id);
  };

  const tabCount = (key) => {
    if (!counts) return null;
    if (key === 'PENDING') return counts.pending;
    if (key === 'APPROVED') return counts.approved;
    if (key === 'INVITED') return counts.invited;
    if (key === 'ACTIVATED') return counts.activated;
    if (key === 'REJECTED') return counts.rejected;
    if (key === 'EXPIRED') return counts.expired;
    return counts.all;
  };

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto">
        {/* ── Header ── */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5 mb-7">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
              <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-botanical-muted)]">
                Owner Review — Public Intake
              </span>
            </div>
            <h1 className="font-serif text-[34px] sm:text-[40px] leading-tight text-[var(--color-botanical-text)] tracking-tight dark:text-[#f0ede9]">
              Admin Applications
            </h1>
            <p className="text-[15px] text-[var(--color-botanical-muted)] max-w-2xl mt-1">
              Dossiers filed at the public intake page <span className="font-mono text-[13px]">/apply/admin</span>.
              Approval issues a single-use administrator invitation (valid 72 hours, link shown once);
              rejection needs a written reason. Decisions are final — one-way, like the order lifecycle.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/admin/owner"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-surface-container)] text-[var(--color-botanical-text)] px-4 py-2.5 text-[13px] font-semibold hover:bg-[var(--color-surface-high)] transition-colors dark:bg-[#2e2a25] dark:text-[#f0ede9]"
            >
              <span className="material-symbols-outlined text-[17px]">workspace_premium</span>
              Owner Console
            </Link>
            <button
              type="button"
              onClick={load}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-text)] px-4 py-2.5 text-[13px] font-semibold shadow-sm border border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-high)] transition-colors dark:bg-[#1e1b18] dark:text-[#f0ede9]"
            >
              <span className={`material-symbols-outlined text-[17px] ${state === 'refreshing' ? 'animate-spin' : ''}`}>
                refresh
              </span>
              Refresh
            </button>
          </div>
        </div>

        {/* Freshly minted one-time link — visible exactly once (banner takes
            over only after the dialog closes, so it never duplicates). */}
        {issued?.link && !approveOpen && (
          <div className="mb-6 p-4 rounded-2xl bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] flex flex-col sm:flex-row sm:items-center gap-3">
            <span className="material-symbols-outlined text-[22px] shrink-0">mark_email_read</span>
            <div className="min-w-0 flex-1">
              <span className="block text-[11px] font-bold uppercase tracking-wider">
                Administrator invitation for {issued.application?.email} — shown once
              </span>
              <p className="text-[11px] font-mono break-all leading-snug mt-1">
                {applicationActivationUrl(issued.link)}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StaffButton size="sm" icon="content_copy" onClick={() => copyLink(applicationActivationUrl(issued.link))}>
                Copy
              </StaffButton>
              <button
                type="button"
                onClick={() => setIssued(null)}
                aria-label="Dismiss"
                className="min-h-[44px] min-w-[44px] flex items-center justify-center opacity-70 hover:opacity-100"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
          </div>
        )}

        {/* ── Tabs + search ── */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-5">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => {
                    setTab(t.key);
                    setPage(1);
                  }}
                  className={`px-3.5 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-[var(--color-btn)] text-white shadow-sm dark:bg-[#964735]'
                      : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)] shadow-sm dark:bg-[#26221e] dark:text-[#b8b0a8]'
                  }`}
                >
                  {t.label}
                  {tabCount(t.key) !== null && (
                    <span className="ml-1.5 opacity-70 font-normal">{tabCount(t.key)}</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="relative flex-1 xl:w-80">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[18px] text-[var(--color-botanical-subtle)]">
              search
            </span>
            <input
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search name, email or APP- id…"
              aria-label="Search applications"
              className="w-full pl-10 pr-4 py-2.5 min-h-[44px] md:min-h-0 rounded-full bg-[var(--color-surface-lowest)] text-[13px] text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] shadow-sm outline-none focus:ring-2 focus:ring-[var(--color-focus)] dark:bg-[#1f1c19] dark:text-[#f0ede9]"
            />
          </div>
        </div>

        {/* ── Ledger + dossier ── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Ledger */}
          <div className="lg:col-span-7 xl:col-span-8 min-w-0">
            <div className="rounded-2xl bg-[var(--color-surface-lowest)] shadow-[0_4px_20px_-2px_rgba(46,36,30,0.05)] overflow-hidden dark:bg-[#1f1c19]">
              {state === 'loading' && <StaffTableSkeleton rows={5} />}

              {state === 'error' && (
                <StaffEmptyState
                  icon="cloud_off"
                  title="Could not load the application ledger"
                  description={error}
                  action={<StaffButton icon="refresh" onClick={load}>Try again</StaffButton>}
                />
              )}

              {state !== 'loading' && state !== 'error' && rows.length === 0 && (
                <StaffEmptyState
                  icon="inbox"
                  title={debouncedQ ? 'No applications match your search' : `No ${TABS.find((t) => t.key === tab)?.label.toLowerCase()} applications`}
                  description={
                    debouncedQ
                      ? 'Try a different name, email or application id.'
                      : 'Prospective administrators file dossiers at the public /apply/admin intake page — every one lands here for your review.'
                  }
                  action={
                    <Link to="/admin/owner" className="text-[13px] font-semibold text-[var(--color-accent)] hover:underline">
                      Back to the Owner Console →
                    </Link>
                  }
                />
              )}

              {state !== 'loading' && state !== 'error' && rows.length > 0 && (
                <>
                  {/* Desktop table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[720px]">
                      <thead>
                        <tr className="bg-[var(--color-surface-container)]/60 text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)]">
                          <th className="py-3 px-5">Applicant</th>
                          <th className="py-3 px-3">Application</th>
                          <th className="py-3 px-3">Filed</th>
                          <th className="py-3 px-3">Status</th>
                          <th className="py-3 px-5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr
                            key={row.id}
                            onClick={() => selectRow(row)}
                            className={`hover:bg-[var(--color-surface-low)]/70 transition-colors cursor-pointer ${
                              selectedId === row.id ? 'bg-[var(--color-surface-low)]/80' : ''
                            }`}
                          >
                            <td className="py-3.5 px-5">
                              <div className="flex items-center gap-3">
                                <StaffAvatar initials={initialsOf(row.name, row.email)} size={36} tone="accent" />
                                <div className="min-w-0">
                                  <span className="block text-[13px] font-semibold text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
                                    {row.name}
                                  </span>
                                  <span className="block text-[11px] text-[var(--color-botanical-muted)] truncate">
                                    {row.email}
                                  </span>
                                </div>
                              </div>
                            </td>
                            <td className="py-3.5 px-3 text-[12px] font-mono text-[var(--color-botanical-muted)] whitespace-nowrap">
                              {row.applicationId}
                            </td>
                            <td className="py-3.5 px-3 text-[12px] text-[var(--color-botanical-muted)] whitespace-nowrap">
                              {formatDateTime(row.createdAt)}
                            </td>
                            <td className="py-3.5 px-3">
                              <StaffStatusPill status={row.status} />
                            </td>
                            <td className="py-3.5 px-5 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    selectRow(row);
                                  }}
                                  className="px-2.5 py-1 rounded-full bg-[var(--color-surface-container)] text-[11px] font-semibold text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-high)] transition-colors dark:bg-[#2e2a25] dark:text-[#f0ede9]"
                                >
                                  Review
                                </button>
                                {row.canApprove && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      selectRow(row);
                                      setApproveOpen(true);
                                    }}
                                    className="px-2.5 py-1 rounded-full bg-[var(--color-btn)] text-white text-[11px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors dark:bg-[#964735]"
                                  >
                                    Approve
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile cards */}
                  <div className="md:hidden divide-y divide-[var(--color-divider)]">
                    {rows.map((row) => (
                      <div key={row.id} className="p-4 space-y-3">
                        <div className="flex items-start gap-3">
                          <StaffAvatar initials={initialsOf(row.name, row.email)} size={38} tone="accent" />
                          <div className="min-w-0 flex-1">
                            <span className="block text-[14px] font-semibold text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
                              {row.name}
                            </span>
                            <span className="block text-[12px] text-[var(--color-botanical-muted)] truncate">{row.email}</span>
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <StaffStatusPill status={row.status} />
                              <span className="text-[11px] font-mono text-[var(--color-botanical-subtle)]">{row.applicationId}</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-[12px] text-[var(--color-botanical-muted)]">
                          Filed {formatDateTime(row.createdAt)}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <StaffButton size="sm" variant="secondary" icon="description" onClick={() => selectRow(row)}>
                            Review
                          </StaffButton>
                          {row.canApprove && (
                            <StaffButton
                              size="sm"
                              icon="check_circle"
                              onClick={() => {
                                selectRow(row);
                                setApproveOpen(true);
                              }}
                            >
                              Approve
                            </StaffButton>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Pager + honesty footer */}
              <div className="px-5 py-2.5 bg-[var(--color-surface-low)] flex items-center justify-between text-[11px] text-[var(--color-botanical-subtle)] dark:bg-[#26221e]">
                <span className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[14px]">lock</span>
                  Invitations are stored only as irreversible hashes — a minted link is shown once
                </span>
                <span className="flex items-center gap-3">
                  {page > 1 && (
                    <button type="button" className="font-semibold text-[var(--color-accent)]" onClick={() => setPage((p) => Math.max(1, p - 1))}>
                      ← Prev
                    </button>
                  )}
                  <span>
                    Page {page} · {rows.length} shown{counts ? ` of ${counts.all}` : ''}
                  </span>
                  {hasMore && (
                    <button type="button" className="font-semibold text-[var(--color-accent)]" onClick={() => setPage((p) => p + 1)}>
                      Next →
                    </button>
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Dossier panel */}
          <div className="lg:col-span-5 xl:col-span-4 min-w-0 lg:sticky lg:top-24">
            <div
              data-dossier-panel
              className="rounded-2xl bg-[var(--color-surface-lowest)] shadow-[0_4px_20px_-2px_rgba(46,36,30,0.05)] dark:bg-[#1f1c19] overflow-hidden"
            >
              {dossierState === 'loading' && <StaffTableSkeleton rows={4} />}

              {dossierState === 'error' && (
                <StaffEmptyState
                  icon="cloud_off"
                  title="Could not open this dossier"
                  description="The server refused the read — refresh and try again."
                  action={<StaffButton icon="refresh" onClick={() => loadDossier(selectedId)}>Try again</StaffButton>}
                />
              )}

              {dossierState === 'idle' && (
                <div className="p-8 text-center space-y-2">
                  <span className="material-symbols-outlined text-[36px] text-[var(--color-botanical-subtle)]">
                    assignment
                  </span>
                  <p className="text-[15px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                    No dossier selected
                  </p>
                  <p className="text-[13px] text-[var(--color-botanical-muted)]">
                    Pick an application from the ledger to read the full submission and make the
                    one decision only the owner can make.
                  </p>
                </div>
              )}

              {dossierState === 'ready' && dossier && (
                <div className="p-5 space-y-5">
                  {/* Dossier head */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <StaffAvatar initials={initialsOf(dossier.name, dossier.email)} size={44} tone="accent" />
                      <div className="min-w-0">
                        <span className="block text-[16px] font-semibold text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
                          {dossier.name}
                        </span>
                        <span className="block text-[12px] text-[var(--color-botanical-muted)] truncate">
                          {dossier.email}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={clearSelection}
                      aria-label="Close dossier"
                      className="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center rounded-full hover:bg-[var(--color-surface-container)] text-[var(--color-botanical-subtle)]"
                    >
                      <span className="material-symbols-outlined text-[19px]">close</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <StaffStatusPill status={dossier.status} />
                    <span className="text-[11px] font-mono text-[var(--color-botanical-subtle)]">
                      {dossier.applicationId}
                    </span>
                  </div>

                  {/* Metadata */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 rounded-xl bg-[var(--color-surface-container)]/60 dark:bg-[#26221e]">
                    <MetaField label="Phone" value={dossier.phone} icon="call" />
                    <MetaField label="Filed" value={formatDateTime(dossier.createdAt)} icon="schedule" />
                    <MetaField label="Reviewed by" value={dossier.reviewedByName || '—'} icon="person" />
                    <MetaField label="Reviewed at" value={dossier.reviewedAt ? formatDateTime(dossier.reviewedAt) : '—'} icon="event" />
                  </div>

                  {/* The submission */}
                  <div className="space-y-3">
                    <div>
                      <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] mb-1">
                        Why they want to join
                      </span>
                      <p className="text-[13px] leading-relaxed text-[var(--color-botanical-text)] whitespace-pre-wrap dark:text-[#f0ede9]">
                        {dossier.reason}
                      </p>
                    </div>
                    <div>
                      <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] mb-1">
                        Professional background
                      </span>
                      <p className="text-[13px] leading-relaxed text-[var(--color-botanical-text)] whitespace-pre-wrap dark:text-[#f0ede9]">
                        {dossier.background}
                      </p>
                    </div>
                    {dossier.reviewNote && (
                      <div className="p-3 rounded-xl bg-[var(--color-surface-low)] dark:bg-[#26221e]">
                        <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] mb-1">
                          Review note
                        </span>
                        <p className="text-[13px] leading-relaxed text-[var(--color-botanical-muted)] whitespace-pre-wrap">
                          {dossier.reviewNote}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Linked invitation (approve mints one) */}
                  {dossierInvitation && (
                    <div className="p-4 rounded-xl border border-[var(--color-botanical-border)] space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)]">
                          <span className="material-symbols-outlined text-[15px] text-[var(--color-accent)]">outgoing_mail</span>
                          Linked invitation
                        </span>
                        <StaffStatusPill status={dossierInvitation.status} />
                      </div>
                      <span className="block text-[12px] font-mono text-[var(--color-botanical-subtle)]">
                        {dossierInvitation.invitationId}
                      </span>
                      <p className="text-[12px] text-[var(--color-botanical-muted)]">
                        {dossierInvitation.consumedAt
                          ? `Activated ${formatDateTime(dossierInvitation.consumedAt)}`
                          : `Expires ${formatDateTime(dossierInvitation.expiresAt)}`}
                        {dossierInvitation.resendCount > 0 ? ` · resent ${dossierInvitation.resendCount}×` : ''}
                      </p>
                      <p className="text-[11px] text-[var(--color-botanical-subtle)]">
                        The activation link itself can never be re-displayed — only its hash is stored.
                      </p>
                    </div>
                  )}

                  {/* Decisions */}
                  {dossier.canApprove || dossier.canReject ? (
                    <div className="flex flex-col sm:flex-row gap-2 pt-1">
                      <StaffButton
                        icon="check_circle"
                        className="flex-1"
                        onClick={() => setApproveOpen(true)}
                        data-approve-open
                      >
                        Approve Application
                      </StaffButton>
                      <StaffButton
                        variant="dangerSoft"
                        icon="cancel"
                        className="flex-1"
                        onClick={() => setRejectOpen(true)}
                      >
                        Reject
                      </StaffButton>
                    </div>
                  ) : (
                    <p className="text-[12px] leading-relaxed text-[var(--color-botanical-subtle)] p-3 rounded-xl bg-[var(--color-surface-container)]/60 dark:bg-[#26221e]">
                      This review decision is final
                      {dossier.status === 'REJECTED'
                        ? ' — a rejected applicant may file a fresh application, but this dossier cannot be reopened.'
                        : dossier.status === 'EXPIRED'
                          ? ' — the invitation lapsed without activation; ask the applicant to reapply.'
                          : ' — no further actions are available on this dossier.'}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Approve dialog ── */}
      <AdminModal open={approveOpen} onClose={closeApprove} labelledBy="approve-title">
        {issued?.link ? (
          <div className="p-6 space-y-4">
            <div className="flex items-start gap-3">
              <span className="w-10 h-10 rounded-full bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-[22px]">check_circle</span>
              </span>
              <div className="min-w-0">
                <h3 id="approve-title" className="font-serif text-[22px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                  Invitation issued — copy it now
                </h3>
                <p className="text-[13px] text-[var(--color-botanical-muted)] mt-1">
                  This one-time activation link for {issued.application?.email} will not be shown
                  again. It is valid for 72 hours and can be used exactly once.
                </p>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-[var(--color-surface-container)] dark:bg-[#2e2a25]">
              <p className="text-[12px] font-mono break-all leading-relaxed text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                {applicationActivationUrl(issued.link)}
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <StaffButton icon="content_copy" onClick={() => copyLink(applicationActivationUrl(issued.link))}>
                Copy link
              </StaffButton>
              <StaffButton variant="secondary" onClick={closeApprove}>
                Done
              </StaffButton>
            </div>
          </div>
        ) : (
          <div className="p-6">
            <div className="flex items-start gap-3">
              <span className="w-10 h-10 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-[22px]">verified_user</span>
              </span>
              <div className="min-w-0">
                <h3 id="approve-title" className="font-serif text-[22px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                  Approve this application?
                </h3>
                <p className="text-[13px] text-[var(--color-botanical-muted)] mt-1">
                  This mints a single-use administrator invitation for {dossier?.email}, valid for
                  72 hours. The activation link is displayed exactly once, right after approval.
                </p>
              </div>
            </div>
            <div className="mt-4 px-3.5 py-2.5 rounded-xl bg-[var(--color-surface-container)] dark:bg-[#2e2a25]">
              <span className="block text-[13px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                {dossier?.name} · {dossier?.applicationId}
              </span>
              <span className="block text-[12px] text-[var(--color-botanical-muted)] min-w-0 break-all">
                {dossier?.email}
              </span>
            </div>
            <label htmlFor="approve-note" className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)] mt-4 mb-1.5">
              Internal note (optional)
            </label>
            <textarea
              id="approve-note"
              rows={2}
              maxLength={500}
              value={approveNote}
              onChange={(e) => setApproveNote(e.target.value)}
              placeholder="Why you are granting access…"
              className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] outline-none focus:ring-2 focus:ring-[var(--color-focus)] resize-y dark:bg-[#26221e]"
            />
            <div className="mt-5 flex items-center justify-end gap-2">
              <StaffButton variant="ghost" onClick={closeApprove}>
                Cancel
              </StaffButton>
              <StaffButton icon="check_circle" loading={approving} onClick={handleApprove}>
                Approve &amp; Issue Invitation
              </StaffButton>
            </div>
          </div>
        )}
      </AdminModal>

      {/* ── Reject dialog ── */}
      <AdminModal open={rejectOpen} onClose={() => setRejectOpen(false)} labelledBy="reject-title">
        <div className="p-6">
          <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-full bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[22px]">cancel</span>
            </span>
            <div className="min-w-0">
              <h3 id="reject-title" className="font-serif text-[22px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                Reject this application?
              </h3>
              <p className="text-[13px] text-[var(--color-botanical-muted)] mt-1">
                The decision is final for {dossier?.email} ({dossier?.applicationId}). A written
                reason of at least 10 characters is required — it is recorded in the review ledger.
              </p>
            </div>
          </div>
          <label htmlFor="reject-reason" className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)] mt-4 mb-1.5">
            Reason for rejection *
          </label>
          <textarea
            id="reject-reason"
            rows={3}
            maxLength={1000}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Be specific — the applicant may reapply with a stronger dossier."
            className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] outline-none focus:ring-2 focus:ring-[var(--color-focus)] resize-y dark:bg-[#26221e]"
          />
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[11px] text-[var(--color-botanical-subtle)]">
              {rejectReason.trim().length < 10
                ? `${10 - rejectReason.trim().length} more character${10 - rejectReason.trim().length === 1 ? '' : 's'} required`
                : 'Ready to record'}
            </span>
          </div>
          <div className="mt-5 flex items-center justify-end gap-2">
            <StaffButton variant="ghost" onClick={() => setRejectOpen(false)}>
              Cancel
            </StaffButton>
            <StaffButton variant="danger" icon="cancel" loading={rejecting} onClick={handleReject}>
              Reject Application
            </StaffButton>
          </div>
        </div>
      </AdminModal>

      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
    </AdminLayout>
  );
}
