import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import {
  listApplications,
  getApplication,
  approveApplication,
  rejectApplication,
} from '../../services/adminApplicationService.js';
import { inspectActivationLink } from '../../services/activationLink.js';
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

/**
 * Classify a failed approve/reject so the dialog tells the truth about WHY.
 *
 * Every one of these is a state the operator must be able to tell apart, and
 * none of them may borrow another's copy:
 *
 *   network (status 0)   → an outage. Retrying is the right recovery.
 *   401                  → the session is over. Retrying is pointless.
 *   403                  → an access decision, not an outage.
 *   404                  → the dossier is gone; re-read the ledger.
 *   409 ALREADY_APPROVED → the decision already happened. NOT an error state
 *                          to retry — and emphatically not "we couldn't reach
 *                          the server", which is what a single generic screen
 *                          used to say for every one of these.
 *   409 EMAIL_TAKEN      → a real business rule (the email already has an
 *                          account), rolled back by the server.
 *   409 CONFLICT         → a lost race, safely retryable.
 *   422 / 429 / 5xx      → validation / throttling / server-side failure.
 *
 * The server's own message is always preferred when it has one — it is more
 * specific than anything this layer can invent.
 */
function describeWriteFailure(res) {
  const status = (res && res.status) || 0;
  const code = (res && res.code) || null;
  const server = (res && res.message) || '';

  if (status === 0 || code === 'NETWORK_ERROR') {
    return {
      tone: 'connection',
      icon: 'cloud_off',
      title: 'We couldn’t reach the studio server',
      message: server || 'The request never reached the server, so nothing was changed.',
      retryable: true,
    };
  }
  if (status === 401) {
    return {
      tone: 'auth',
      icon: 'lock_person',
      title: 'Your session has expired',
      message: server || 'Sign in again to continue reviewing applications.',
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      tone: 'auth',
      icon: 'shield_lock',
      title: 'You don’t have access to this action',
      message: server || 'Approving applications is owner-only, and the server re-checks that on every request.',
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      tone: 'missing',
      icon: 'search_off',
      title: 'This application is no longer available',
      message: server || 'It may have been removed since this dossier was opened.',
      retryable: true,
    };
  }
  if (status === 409) {
    if (code === 'ALREADY_APPROVED') {
      return {
        tone: 'business',
        icon: 'info',
        title: 'This application has already been approved',
        message: server || 'No second invitation was created — the existing one still stands.',
        retryable: false,
      };
    }
    if (code === 'EMAIL_TAKEN') {
      return {
        tone: 'business',
        icon: 'rule',
        title: 'That email already has an account',
        message: server || 'The approval was rolled back, so this dossier is still reviewable.',
        retryable: false,
      };
    }
    if (code === 'CONFLICT') {
      return {
        tone: 'business',
        icon: 'sync_problem',
        title: 'This dossier was being reviewed at the same moment',
        message: server || 'Refresh the ledger and try again.',
        retryable: true,
      };
    }
    return {
      tone: 'business',
      icon: 'block',
      title: 'This decision was refused',
      message: server || 'The server would not accept this decision for the current state of the dossier.',
      retryable: false,
    };
  }
  if (status === 422) {
    return {
      tone: 'business',
      icon: 'rule',
      title: 'The server rejected the request',
      message: server || 'Check the details you entered and try again.',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      tone: 'business',
      icon: 'hourglass_top',
      title: 'Too many attempts',
      message: server || 'Wait a moment, then try this action again.',
      retryable: true,
    };
  }
  return {
    tone: 'server',
    icon: 'error',
    title: 'The server could not complete this action',
    message: server || 'Nothing was approved — try again in a moment.',
    retryable: true,
  };
}

/**
 * The in-dialog rendering of a classified write failure. A business verdict
 * (already approved, email taken, rule refused) is information and reads in the
 * brand's attention tone; a genuine outage/access/server failure reads as a
 * problem. Neither ever says "something went wrong on this page".
 */
function WriteFailureNotice({ failure }) {
  if (!failure) return null;
  const informational = failure.tone === 'business';
  return (
    <div
      role="alert"
      data-write-state={failure.tone}
      className={`mt-4 flex items-start gap-2.5 p-3.5 rounded-xl border text-[13px] leading-relaxed ${
        informational
          ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] border-[#edd1cc]'
          : 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] border-[var(--color-danger-soft-border)]'
      }`}
    >
      <span className="material-symbols-outlined text-[18px] shrink-0 mt-px" aria-hidden="true">
        {failure.icon}
      </span>
      <span className="min-w-0">
        <span className="block font-semibold">{failure.title}</span>
        <span className="block break-words">{failure.message}</span>
        {failure.retryable && (
          <span className="block mt-1 text-[12px] opacity-90">
            Nothing was changed on the server — you can try this action again.
          </span>
        )}
      </span>
    </div>
  );
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
  // Hard double-submit guard. `approving` is STATE, so two clicks dispatched in
  // the same tick both read `false`; this ref is written synchronously and is
  // what actually makes the second click a no-op. (The server is idempotent too
  // — it answers 409 ALREADY_APPROVED — but the UI must not even ask twice.)
  const approvingRef = useRef(false);
  // A failed approval rendered IN the dialog, classified by cause, so a known
  // business verdict never reads as an outage and vice versa.
  const [approveError, setApproveError] = useState(null);
  // { link, application, invitation, email, name, businessName, workspaceSlug }
  const [issued, setIssued] = useState(null);
  // The server's link, checked but never rewritten — the public origin is
  // configured once on the backend (services/activationLink.js).
  const issuedLink = useMemo(() => inspectActivationLink(issued?.link), [issued]);

  // Reject dialog: written reason required.
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const rejectingRef = useRef(false);
  const [rejectError, setRejectError] = useState(null);

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
    setApproveError(null);
    setRejectError(null);
    // Drop the previous dossier IMMEDIATELY. The fetch below is async, and a
    // dialog opened in the same tick would otherwise still be holding the
    // PREVIOUS application — so one click on "Approve" could approve the wrong
    // application entirely. `dossierReady` below makes that impossible.
    setDossier(null);
    setDossierInvitation(null);
    loadDossier(row.id);
    // Keep the URL shareable without a navigation.
    const next = new URLSearchParams(searchParams);
    next.set('id', row.id);
    setSearchParams(next, { replace: true });
  };

  /** Open the approve dialog with a clean slate (never a stale verdict). */
  const openApprove = () => {
    setApproveError(null);
    setApproveOpen(true);
  };

  const openReject = () => {
    setRejectError(null);
    setRejectOpen(true);
  };

  // A decision may only act on the dossier the ledger has selected AND that the
  // server has actually returned. Without this, opening a dialog while the
  // panel was still loading could fire the decision at the wrong application.
  const dossierReady = !!dossier && dossier.id === selectedId && dossierState === 'ready';

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
    if (!dossierReady || approvingRef.current) return;
    approvingRef.current = true;
    setApproving(true);
    setApproveError(null);
    let res = null;
    try {
      res = await approveApplication(dossier.id, { note: approveNote.trim() });
    } catch (err) {
      // apiClient normalizes transport failures to { ok:false, status:0 }, so
      // this only guards against an unexpected throw — the dialog must come out
      // of its loading state either way.
      res = { ok: false, status: 0, code: 'NETWORK_ERROR', message: err?.message || '' };
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }

    if (!res || !res.ok) {
      const failure = describeWriteFailure(res);
      setApproveError(failure);
      // A "gone" or "already decided" verdict means this tab's view is stale.
      // Re-read rather than leaving the operator looking at a wrong status.
      if (res && (res.status === 404 || res.status === 409)) {
        load();
        loadDossier(dossier.id);
      }
      return;
    }

    const approved = res.application || null;
    setIssued({
      link: res.link,
      application: approved,
      invitation: res.invitation,
      email: approved?.email || dossier.email,
      name: approved?.name || dossier.name,
      businessName: approved?.businessName || dossier.businessName || '',
      workspaceSlug: approved?.proposedSlug || dossier.proposedSlug || '',
    });
    // Reflect the decision in the panel IMMEDIATELY (the server re-read below is
    // the source of truth, but the operator must never be able to click Approve
    // a second time because the panel still showed the pre-approval status).
    setDossier((d) =>
      d
        ? {
            ...d,
            status: approved?.status || 'APPROVED',
            canApprove: false,
            canReject: false,
            reviewedByName: approved?.reviewedByName || d.reviewedByName,
            reviewedAt: approved?.reviewedAt || new Date().toISOString(),
          }
        : d
    );
    if (res.invitation) setDossierInvitation(res.invitation);
    notify(
      'Application approved',
      `A one-time administrator invitation was issued for ${approved?.email || dossier.email}.`,
      'success'
    );
    load();
    loadDossier(dossier.id);
  };

  const closeApprove = () => {
    setApproveOpen(false);
    setApproveNote('');
    setApproveError(null);
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
    if (!dossierReady || rejectingRef.current) return;
    if (rejectReason.trim().length < 10) {
      setRejectError({
        tone: 'business',
        icon: 'rule',
        title: 'A written reason is required',
        message: 'Rejection needs at least 10 characters of explanation.',
        retryable: false,
      });
      return;
    }
    rejectingRef.current = true;
    setRejecting(true);
    setRejectError(null);
    let res = null;
    try {
      res = await rejectApplication(dossier.id, { reason: rejectReason.trim() });
    } catch (err) {
      res = { ok: false, status: 0, code: 'NETWORK_ERROR', message: err?.message || '' };
    } finally {
      rejectingRef.current = false;
      setRejecting(false);
    }
    if (!res || !res.ok) {
      setRejectError(describeWriteFailure(res));
      if (res && (res.status === 404 || res.status === 409)) {
        load();
        loadDossier(dossier.id);
      }
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
                Administrator invitation for {issued.email || issued.application?.email} — shown once
              </span>
              {(issued.businessName || issued.workspaceSlug) && (
                <span className="block text-[11px] mt-0.5 break-words">
                  {issued.businessName}
                  {issued.workspaceSlug ? ` · /shops/${issued.workspaceSlug}` : ''}
                  {issued.invitation?.expiresAt ? ` · expires ${formatDateTime(issued.invitation.expiresAt)}` : ''}
                </span>
              )}
              <p className="text-[11px] font-mono break-all leading-snug mt-1">
                {issuedLink.ok ? issuedLink.url : issuedLink.problem}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {issuedLink.ok && (
                <StaffButton size="sm" icon="content_copy" onClick={() => copyLink(issuedLink.url)}>
                  Copy
                </StaffButton>
              )}
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
                                  {/* Phase 22.4 — the business identity this
                                      application would open as a workspace. */}
                                  {row.businessName && (
                                    <span className="flex items-center gap-1 mt-0.5 min-w-0">
                                      <span className="material-symbols-outlined text-[12px] text-[var(--color-accent)] shrink-0" aria-hidden="true">storefront</span>
                                      <span className="text-[11px] font-semibold text-[var(--color-botanical-muted)] truncate">
                                        {row.businessName}
                                      </span>
                                      {row.proposedSlug && (
                                        <span className="text-[10px] font-mono text-[var(--color-botanical-subtle)] truncate">
                                          /{row.proposedSlug}
                                        </span>
                                      )}
                                    </span>
                                  )}
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
                                      openApprove();
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
                            {/* Phase 22.4 — business identity on the compact card. */}
                            {row.businessName && (
                              <span className="flex items-center gap-1 mt-1 min-w-0">
                                <span className="material-symbols-outlined text-[13px] text-[var(--color-accent)] shrink-0" aria-hidden="true">storefront</span>
                                <span className="text-[12px] font-semibold text-[var(--color-botanical-muted)] truncate">
                                  {row.businessName}
                                </span>
                                {row.proposedSlug && (
                                  <span className="text-[11px] font-mono text-[var(--color-botanical-subtle)] truncate">
                                    /{row.proposedSlug}
                                  </span>
                                )}
                              </span>
                            )}
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
                                openApprove();
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

          {/* Dossier panel. Sticky on desktop, capped to the viewport and
              independently scrollable so a long application (real dossiers run
              to several paragraphs) can be read to the end without the whole
              page becoming the scroll container. */}
          <div className="lg:col-span-5 xl:col-span-4 min-w-0 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
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
                    {/* Phase 22.4 — the future workspace identity the owner is
                        approving: business name + proposed shop address.
                        Both WRAP rather than truncate — a half-visible name or
                        address is not something the owner can verify, and this
                        is the field the decision actually turns on. */}
                    {dossier.businessName && (
                      <MetaField label="Business" value={dossier.businessName} icon="storefront" wrap />
                    )}
                    {dossier.proposedSlug ? (
                      <MetaField label="Proposed address" value={`/shops/${dossier.proposedSlug}`} icon="language" mono wrap />
                    ) : dossier.preferredSlug ? (
                      <MetaField label="Preferred address" value={`/shops/${dossier.preferredSlug}`} icon="language" mono wrap />
                    ) : null}
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
                    /* Buttons are equal-width, stacked on phones with a real
                       touch target, and carry a visible keyboard focus ring,
                       since this is the one irreversible action on the page. */
                    <div className="flex flex-col sm:flex-row gap-2.5 pt-1" data-dossier-decisions>
                      <StaffButton
                        icon="check_circle"
                        className="flex-1 min-h-[48px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2"
                        onClick={openApprove}
                        data-approve-open
                      >
                        Approve Application
                      </StaffButton>
                      <StaffButton
                        variant="dangerSoft"
                        icon="cancel"
                        className="flex-1 min-h-[48px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2"
                        onClick={openReject}
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
          <div className="p-6 space-y-5" data-approve-state="success">
            <div className="flex items-start gap-3">
              <span className="w-10 h-10 rounded-full bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-[22px]">check_circle</span>
              </span>
              <div className="min-w-0">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                  Decision recorded
                </span>
                <h3 id="approve-title" className="font-serif text-[22px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                  Application approved
                </h3>
                <p className="text-[13px] text-[var(--color-botanical-muted)] mt-1">
                  A single-use administrator invitation has been issued. Copy the activation link
                  below and send it to the recipient — this is the only time it is shown.
                </p>
              </div>
            </div>

            {/* What the approval actually produced. The raw link is NOT part of
                this list: it is a credential and lives in the once-only panel
                below, exactly as the security model requires. */}
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 p-4 rounded-xl bg-[var(--color-surface-container)]/60 dark:bg-[#26221e]">
              <div className="min-w-0">
                <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">Administrator</dt>
                <dd className="text-[13px] text-[var(--color-botanical-text)] dark:text-[#f0ede9] break-words">
                  {issued.email || '—'}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">Business</dt>
                <dd className="text-[13px] text-[var(--color-botanical-text)] dark:text-[#f0ede9] break-words">
                  {issued.businessName || '—'}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">Workspace</dt>
                <dd className="text-[13px] font-mono text-[var(--color-botanical-text)] dark:text-[#f0ede9] break-all">
                  {issued.workspaceSlug ? `/shops/${issued.workspaceSlug}` : 'Assigned on activation'}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">Invitation</dt>
                <dd className="text-[13px] text-[var(--color-botanical-text)] dark:text-[#f0ede9] break-words">
                  {issued.invitation?.invitationId ? (
                    <>
                      <span className="font-mono">{issued.invitation.invitationId}</span>
                      {' · '}
                      {issued.invitation.status || 'INVITED'}
                      {issued.invitation.expiresAt
                        ? ` · expires ${formatDateTime(issued.invitation.expiresAt)}`
                        : ''}
                    </>
                  ) : (
                    'Recorded'
                  )}
                </dd>
              </div>
            </dl>

            <div className="p-3 rounded-xl bg-[var(--color-surface-container)] dark:bg-[#2e2a25]">
              <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] mb-1">
                One-time activation link — shown once
              </span>
              <p className="text-[12px] font-mono break-all leading-relaxed text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                {issuedLink.ok ? issuedLink.url : issuedLink.problem}
              </p>
            </div>

            <p className="text-[12px] leading-5 text-[var(--color-botanical-muted)]">
              The workspace and the administrator account are created when the recipient activates
              this link — not now. Until then the dossier reads as approved with an invitation
              outstanding.
            </p>

            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2">
              <StaffButton variant="secondary" icon="list_alt" onClick={closeApprove}>
                Back to the ledger
              </StaffButton>
              {issuedLink.ok && (
                <StaffButton icon="content_copy" onClick={() => copyLink(issuedLink.url)}>
                  Copy link
                </StaffButton>
              )}
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
            <WriteFailureNotice failure={approveError} />

            <div className="mt-5 flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2">
              <StaffButton variant="ghost" onClick={closeApprove} disabled={approving}>
                Cancel
              </StaffButton>
              <StaffButton
                icon="check_circle"
                loading={approving}
                disabled={approving || !dossierReady}
                onClick={handleApprove}
                data-approve-submit
              >
                {approving ? 'Approving…' : 'Approve & Issue Invitation'}
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
          <WriteFailureNotice failure={rejectError} />
          <div className="mt-5 flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2">
            <StaffButton variant="ghost" onClick={() => setRejectOpen(false)} disabled={rejecting}>
              Cancel
            </StaffButton>
            <StaffButton
              variant="danger"
              icon="cancel"
              loading={rejecting}
              disabled={rejecting || !dossierReady}
              onClick={handleReject}
            >
              {rejecting ? 'Rejecting…' : 'Reject Application'}
            </StaffButton>
          </div>
        </div>
      </AdminModal>

      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
    </AdminLayout>
  );
}
