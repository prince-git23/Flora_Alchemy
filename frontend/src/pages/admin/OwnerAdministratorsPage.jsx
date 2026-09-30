import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import {
  StaffStatusPill,
  StaffRoleBadge,
  StaffAvatar,
  StaffEmptyState,
  StaffTableSkeleton,
  StaffCardSkeleton,
  AdminToast,
  AdminModal,
  MetaField,
  StaffButton,
} from '../../components/admin/StaffPrimitives.jsx';
import { getOwnerAdministrators } from '../../services/ownerService.js';
import {
  getStaffMember,
  getStaffActivity,
  suspendStaff,
  reactivateStaff,
  resendInvitation,
  revokeInvitation,
} from '../../services/staffService.js';
import { inspectActivationLink } from '../../services/activationLink.js';

/**
 * Phase 21.4 / 21.5 — ADMINISTRATORS DIRECTORY (`/owner/administrators`).
 *
 * The owner's registry of everyone who can administer Flora Alchemy. Owner-only
 * on the server (`protect + requireOwner` on /api/owner/administrators), so a
 * plain administrator can neither read this list nor act on an administrator.
 *
 * There is deliberately NO "Add Administrator" action: administrators enter the
 * business one way only — a public application, owner review, then a one-time
 * invitation. The header offers "Review Applications" / "Invite approved
 * administrator" instead, which routes to the approval ledger where that
 * invitation is actually minted.
 *
 * Every value is real API data; lifecycle controls are rendered from the
 * server-derived `actions` on the dossier, so the UI never offers a control the
 * backend would refuse.
 */

const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'INVITED', label: 'Invited' },
  { key: 'SUSPENDED', label: 'Suspended' },
  { key: 'EXPIRED', label: 'Expired' },
];

const SUSPEND_REASONS = [
  'Extended leave',
  'Role reassignment',
  'Policy violation',
  'Account security concern',
  'Owner decision',
];

function KpiCard({ label, icon, tone, value, caption, footer }) {
  const chip =
    tone === 'danger'
      ? 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)]'
      : tone === 'success'
        ? 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae]'
        : tone === 'accent'
          ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] dark:bg-[#3a241c] dark:text-[#ffb9ab]'
          : 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] dark:text-[#f2efe9]';
  return (
    <div className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-2xl p-5 shadow-sm flex flex-col gap-3 border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
          {label}
        </span>
        <span className={`w-8 h-8 rounded-full ${chip} flex items-center justify-center shrink-0`}>
          <span className="material-symbols-outlined text-[18px]">{icon}</span>
        </span>
      </div>
      <div>
        <span className="font-serif text-[36px] leading-[44px] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
          {value}
        </span>
        <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-0.5">{caption}</p>
      </div>
      {footer && (
        <div className="text-[11px] leading-4 font-bold uppercase tracking-[0.06em] text-[var(--color-botanical-subtle)]">
          {footer}
        </div>
      )}
    </div>
  );
}

export default function OwnerAdministratorsPage() {
  const { session } = useAdminSession();

  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('ALL');

  // Selected dossier
  const [dossier, setDossier] = useState(null);
  const [dossierId, setDossierId] = useState(null);
  const [events, setEvents] = useState([]);
  const [dossierLoading, setDossierLoading] = useState(false);

  // Lifecycle dialogs
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState(SUSPEND_REASONS[0]);
  const [suspendNote, setSuspendNote] = useState('');
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const res = await getOwnerAdministrators({
      q: q || undefined,
      status: filter === 'ALL' ? undefined : filter,
    });
    if (res.ok) {
      setRows(res.administrators);
      setCounts(res.counts);
    } else {
      setError(res.message || 'Could not load the administrators directory.');
    }
    setLoading(false);
  }, [q, filter]);

  // Debounced search so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const openDossier = useCallback(async (row) => {
    setDossierId(row.id);
    setEvents([]);
    // An invitation row is not a user account: `/admin/staff/:id` does not
    // resolve for it. Use the row (which already carries server-derived
    // `actions`) and skip the staff lookups so we never fire a 404 fetch.
    if (row.kind === 'invitation') {
      setDossier(row);
      setDossierLoading(false);
      return;
    }
    setDossier(null);
    setDossierLoading(true);
    const [memberRes, activityRes] = await Promise.all([
      getStaffMember(row.id),
      getStaffActivity(row.id),
    ]);
    setDossier(memberRes.ok ? memberRes.member : row);
    setEvents(activityRes.ok ? activityRes.events : []);
    setDossierLoading(false);
  }, []);

  // Keep the open dossier in sync when the registry reloads (e.g. after a
  // suspension the row's status must not go stale).
  useEffect(() => {
    if (!dossierId || loading) return;
    const row = rows.find((r) => r.id === dossierId);
    if (!row) setDossierId(null);
  }, [rows, dossierId, loading]);

  const closeDossier = () => {
    setDossierId(null);
    setDossier(null);
    setEvents([]);
  };

  /** Re-open a dossier by id, preferring the freshly-loaded registry row. */
  const reopenDossier = async (id) => {
    const row = rows.find((r) => r.id === id);
    if (row) return openDossier(row);
    // Fall back to a minimal user row if the registry has not caught up yet.
    return openDossier({ id, kind: 'user' });
  };

  const afterMutation = async (message, tone = 'success') => {
    setToast({ tone, title: message });
    await Promise.all([load(), dossierId ? reopenDossier(dossierId) : Promise.resolve()]);
  };

  const doSuspend = async () => {
    if (!dossier) return;
    setBusy(true);
    const res = await suspendStaff(dossier.id, { reason: suspendReason, note: suspendNote });
    setBusy(false);
    setSuspendOpen(false);
    setSuspendNote('');
    if (res.ok) {
      await afterMutation(`${dossier.name} has been suspended; access is revoked immediately.`);
    } else {
      setToast({ tone: 'error', title: res.message || 'Could not suspend this administrator.' });
    }
  };

  const doReactivate = async () => {
    if (!dossier) return;
    setBusy(true);
    const res = await reactivateStaff(dossier.id);
    setBusy(false);
    if (res.ok) await afterMutation(`${dossier.name} can sign in again.`);
    else setToast({ tone: 'error', title: res.message || 'Could not reactivate this administrator.' });
  };

  const doResend = async () => {
    if (!dossier) return;
    setBusy(true);
    const res = await resendInvitation(dossier.id);
    setBusy(false);
    if (res.ok && res.link) {
      // The server's link is used EXACTLY as returned. It is never repinned to
      // the origin this owner happens to be browsing from, and it is never
      // synthesized locally: the public frontend origin is configured once, on
      // the backend (services/activationLink.js).
      const inspected = inspectActivationLink(res.link);
      setToast({
        tone: inspected.ok ? 'success' : 'error',
        title: inspected.ok ? 'Invitation re-sent' : 'Invitation link is misconfigured',
        message: inspected.ok
          ? 'The previous link was invalidated. Copy the new link and send it to the recipient.'
          : inspected.problem,
        persist: true,
        action: inspected.ok ? (
          <button
            type="button"
            onClick={() => { navigator.clipboard?.writeText(inspected.url); }}
            className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold underline"
          >
            <span className="material-symbols-outlined text-[14px]">content_copy</span>
            Copy new invitation link
          </button>
        ) : null,
      });
      await Promise.all([load(), reopenDossier(dossier.id)]);
    } else {
      setToast({ tone: 'error', title: res.message || 'Could not resend this invitation.' });
    }
  };

  const doRevoke = async () => {
    if (!dossier) return;
    setBusy(true);
    const res = await revokeInvitation(dossier.id, revokeReason);
    setBusy(false);
    setRevokeOpen(false);
    setRevokeReason('');
    if (res.ok) await afterMutation('Invitation withdrawn. The link no longer works.');
    else setToast({ tone: 'error', title: res.message || 'Could not revoke this invitation.' });
  };

  const actions = dossier?.actions || {};
  const isInvitation = dossier?.kind === 'invitation';

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 sm:space-y-8 pb-8 sm:pb-12">
        {/* ── Header ── */}
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-5">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--color-surface-high)] dark:bg-[#37332c] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
              <span className="material-symbols-outlined text-[15px] text-[var(--color-accent)]">admin_panel_settings</span>
              <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em]">Owner · Administrators Directory</span>
            </div>
            <h1 className="font-serif text-[40px] leading-[48px] tracking-[-0.015em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
              Administrators
            </h1>
            <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
              Administrators join through your approval of an application — never by direct creation. Manage access, invitations and activity here.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/owner/applications"
              className="inline-flex items-center gap-2 px-4 py-2.5 max-md:min-h-[44px] rounded-full bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-[13px] leading-[18px] font-semibold shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] hover:bg-[var(--color-surface-high)] dark:hover:bg-[#33302a] transition-all"
            >
              <span className="material-symbols-outlined text-[18px] text-[var(--color-botanical-subtle)]">assignment</span>
              Review Applications
              {counts && counts.pendingApplications > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] text-[11px] font-bold">
                  {counts.pendingApplications}
                </span>
              )}
            </Link>
            <Link
              to="/owner/applications"
              className="inline-flex items-center gap-2 px-5 py-2.5 max-md:min-h-[44px] rounded-full bg-[var(--color-btn)] text-white text-[13px] leading-[18px] font-semibold shadow-md hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] transition-all active:translate-y-px"
            >
              <span className="material-symbols-outlined text-[18px]">person_add</span>
              Invite approved administrator
            </Link>
          </div>
        </header>

        {error && (
          <div role="alert" className="p-4 rounded-xl bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] border border-[var(--color-danger-soft-border)] text-[13px] flex items-center justify-between gap-3">
            <span>{error}</span>
            <button type="button" onClick={load} className="font-semibold underline">Retry</button>
          </div>
        )}

        {/* ── KPI row ── */}
        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard
            label="Active Administrators"
            value={counts ? counts.active : '—'}
            icon="admin_panel_settings"
            tone="accent"
            caption={counts ? `${counts.all} on the registry · ${counts.owners} owner` : 'Loading…'}
            footer={<span>Can sign in now</span>}
          />
          <KpiCard
            label="Pending Applications"
            value={counts ? counts.pendingApplications : '—'}
            icon="draft"
            tone="neutral"
            caption={counts ? `${counts.pendingApplications === 1 ? 'Dossier' : 'Dossiers'} awaiting your review` : 'Loading…'}
            footer={
              // min-h keeps this usable as a touch target on phones, where a
              // bare inline link is only ~13px tall.
              <Link
                to="/owner/applications"
                className="inline-flex items-center min-h-[44px] hover:underline"
              >
                Open the ledger →
              </Link>
            }
          />
          <KpiCard
            label="Pending Invitations"
            value={counts ? counts.pendingInvitations : '—'}
            icon="outgoing_mail"
            tone="neutral"
            caption={counts ? `${counts.invited} awaiting activation` : 'Loading…'}
            footer={<span>{counts ? `${counts.expired} expired` : '…'}</span>}
          />
          <KpiCard
            label="Suspended"
            value={counts ? counts.suspended : '—'}
            icon="block"
            tone="danger"
            caption="Access revoked, account retained"
            footer={<span>Reactivate to restore</span>}
          />
        </section>

        {/* ── Registry ── */}
        <section className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] overflow-hidden">
          <div className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
            <div className="relative flex items-center w-full lg:max-w-sm">
              <span className="material-symbols-outlined absolute left-3.5 text-[18px] text-[var(--color-botanical-subtle)] pointer-events-none">search</span>
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name, email or staff ID…"
                aria-label="Search administrators"
                className="w-full pl-11 pr-4 py-2.5 max-md:min-h-[44px] bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[var(--color-botanical-text)] dark:text-[#f0ede9] text-[13px] rounded-full placeholder:text-[var(--color-botanical-subtle)] border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-all"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`px-3.5 py-1.5 max-md:min-h-[44px] rounded-full text-[12px] font-semibold transition-colors ${
                    filter === f.key
                      ? 'bg-[var(--color-btn)] text-white dark:bg-[#964735]'
                      : 'bg-[var(--color-surface-low)] dark:bg-[#26221e] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] hover:bg-[var(--color-surface-high)] dark:hover:bg-[#33302a]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="p-5 space-y-3">
              <StaffTableSkeleton rows={4} />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8">
              <StaffEmptyState
                icon="admin_panel_settings"
                title={q || filter !== 'ALL' ? 'No administrators match this view' : 'No administrators yet'}
                description={
                  q || filter !== 'ALL'
                    ? 'Try a different search term or status filter.'
                    : 'You are the only administrator. Approve an application to invite another — administrators are never created directly.'
                }
                action={
                  q || filter !== 'ALL' ? null : (
                    <Link
                      to="/owner/applications"
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] transition-all"
                    >
                      <span className="material-symbols-outlined text-[17px]">review</span>
                      Review applications
                    </Link>
                  )
                }
              />
            </div>
          ) : (
            <>
              {/* Desktop registry */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-subtle)] border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                      <th className="px-5 py-3">Administrator</th>
                      <th className="px-5 py-3">Business / Workspace</th>
                      <th className="px-5 py-3">Role</th>
                      <th className="px-5 py-3">Staff ID</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3">Last Active</th>
                      <th className="px-5 py-3 text-right">Dossier</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-botanical-border)] dark:divide-[#3a3530]">
                    {rows.map((r) => (
                      <tr
                        key={r.id}
                        className={`transition-colors hover:bg-[var(--color-surface-low)] dark:hover:bg-[#26221e] ${
                          dossierId === r.id ? 'bg-[var(--color-surface-low)] dark:bg-[#26221e]' : ''
                        }`}
                      >
                        <td className="px-5 py-4">
                          <button
                            type="button"
                            onClick={() => openDossier(r)}
                            className="flex items-center gap-3 min-w-0 text-left"
                          >
                            <StaffAvatar initials={r.initials} size={38} tone={r.isOwner ? 'accent' : 'primary'} />
                            <span className="min-w-0">
                              <span className="flex items-center gap-2">
                                <span className="text-[14px] leading-5 font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate">{r.name}</span>
                                {r.isOwner && (
                                  <span className="px-2 py-0.5 rounded-full bg-[var(--color-btn)] text-white text-[9px] font-bold uppercase tracking-wider">Owner</span>
                                )}
                                {r.kind === 'invitation' && (
                                  <span className="px-2 py-0.5 rounded-full bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)] dark:bg-[#37332c] dark:text-[#b9b1a8] text-[9px] font-bold uppercase tracking-wider">Invitation</span>
                                )}
                              </span>
                              <span className="block text-[12px] leading-4 text-[var(--color-botanical-subtle)] truncate">{r.email}</span>
                            </span>
                          </button>
                        </td>
                        <td className="px-5 py-4">
                          {/* Phase 22.4 — the workspace this administrator runs
                              (or the business a pending invitation will open). */}
                          {r.isOwner ? (
                            <span className="text-[12px] text-[var(--color-botanical-subtle)]">Platform owner</span>
                          ) : r.workspace?.slug ? (
                            <span className="min-w-0 block">
                              <span className="block text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9] truncate">
                                {r.workspace.name || r.workspace.slug}
                              </span>
                              <span className="block font-mono text-[11px] text-[var(--color-botanical-muted)] truncate">
                                /shops/{r.workspace.slug}
                              </span>
                            </span>
                          ) : r.businessName ? (
                            <span className="min-w-0 block">
                              <span className="block text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9] truncate">
                                {r.businessName}
                              </span>
                              <span className="block text-[11px] text-[var(--color-botanical-subtle)]">
                                {r.kind === 'invitation' ? 'Workspace pending activation' : 'No workspace yet'}
                              </span>
                            </span>
                          ) : (
                            <span className="text-[12px] text-[var(--color-botanical-subtle)]">—</span>
                          )}
                        </td>
                        <td className="px-5 py-4"><StaffRoleBadge roleBadge={r.roleBadge} /></td>
                        <td className="px-5 py-4"><span className="font-mono text-[12px] text-[var(--color-botanical-muted)]">{r.staffId}</span></td>
                        <td className="px-5 py-4"><StaffStatusPill status={r.status} /></td>
                        <td className="px-5 py-4 text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">{r.lastActiveLabel}</td>
                        <td className="px-5 py-4 text-right">
                          <button
                            type="button"
                            onClick={() => openDossier(r)}
                            className="inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--color-accent)] hover:underline"
                          >
                            Open
                            <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile registry */}
              <div className="md:hidden divide-y divide-[var(--color-botanical-border)] dark:divide-[#3a3530]">
                {rows.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => openDossier(r)}
                    className="w-full text-left p-4 space-y-3"
                  >
                    <div className="flex items-center gap-3">
                      <StaffAvatar initials={r.initials} size={40} tone={r.isOwner ? 'accent' : 'primary'} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-[14px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate">{r.name}</span>
                          {r.isOwner && (
                            <span className="px-2 py-0.5 rounded-full bg-[var(--color-btn)] text-white text-[9px] font-bold uppercase tracking-wider">Owner</span>
                          )}
                        </span>
                        <span className="block text-[12px] text-[var(--color-botanical-subtle)] truncate">{r.email}</span>
                      </span>
                      <StaffStatusPill status={r.status} />
                    </div>
                    {/* Phase 22.4 — workspace/business line on the compact card. */}
                    {!r.isOwner && (r.workspace?.slug || r.businessName) && (
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="material-symbols-outlined text-[14px] text-[var(--color-accent)] shrink-0" aria-hidden="true">storefront</span>
                        <span className="text-[12px] font-semibold text-[var(--color-botanical-muted)] truncate">
                          {r.workspace?.name || r.businessName}
                        </span>
                        {r.workspace?.slug && (
                          <span className="text-[11px] font-mono text-[var(--color-botanical-subtle)] truncate">
                            /{r.workspace.slug}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[12px] text-[var(--color-botanical-muted)]">{r.staffId}</span>
                      <span className="text-[13px] font-semibold text-[var(--color-accent)]">Open dossier →</span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        <p className="text-[13px] leading-5 text-[var(--color-botanical-subtle)]">
          Signed in as {session?.roleLabel || 'Owner'}. Administrator lifecycle actions are owner-only and are enforced by the server, not this screen.
        </p>
      </div>

      {/* ── Dossier ── */}
      <AdminModal open={!!dossierId} onClose={closeDossier} labelledBy="admin-dossier-title" className="sm:max-w-2xl">
        {dossierLoading && !dossier ? (
          <div className="p-6"><StaffCardSkeleton lines={6} /></div>
        ) : dossier ? (
          <div className="p-6 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <StaffAvatar initials={dossier.initials} size={56} tone={dossier.isOwner ? 'accent' : 'primary'} />
                <div className="min-w-0">
                  <h2 id="admin-dossier-title" className="font-serif text-[24px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate">
                    {dossier.name}
                  </h2>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <StaffRoleBadge roleBadge={dossier.roleBadge} />
                    <StaffStatusPill status={dossier.status} />
                    {dossier.kind === 'invitation' && (
                      <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-botanical-subtle)]">Invitation pending</span>
                    )}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={closeDossier}
                aria-label="Close dossier"
                className="shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-container)]"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            {/* Profile */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 p-4 rounded-2xl bg-[var(--color-surface-low)] dark:bg-[#26221e]">
              <MetaField label="Staff ID" value={dossier.staffId} icon="badge" mono />
              <MetaField label="Email" value={dossier.email} icon="mail" />
              <MetaField label="Phone" value={dossier.phone} icon="call" />
              <MetaField label="Department" value={dossier.department} icon="apartment" />
              <MetaField label="Joined" value={dossier.joinedLabel} icon="event" />
              <MetaField label="Last Active" value={dossier.lastActiveLabel} icon="schedule" />
              <MetaField label="Invited By" value={dossier.invitedByName} icon="person" />
              {isInvitation && dossier.expiresLabel && (
                <MetaField label="Expires" value={dossier.expiresLabel} icon="timer" />
              )}
              <MetaField label="Access State" value={dossier.status} icon="shield" />
              <MetaField label="Designation" value={dossier.isOwner ? 'Owner' : 'Administrator'} icon="workspace_premium" />
              {/* Phase 22.4 — business/workspace provenance of this identity. */}
              {!dossier.isOwner && (dossier.businessName || dossier.workspace?.name) && (
                <MetaField
                  label="Business"
                  value={dossier.workspace?.name || dossier.businessName}
                  icon="storefront"
                />
              )}
              {!dossier.isOwner && dossier.workspace?.slug && (
                <MetaField label="Workspace" value={`/shops/${dossier.workspace.slug}`} icon="language" mono />
              )}
              {!dossier.isOwner && !dossier.workspace?.slug && dossier.businessName && (
                <MetaField label="Workspace" value="Pending activation" icon="language" />
              )}
              {!dossier.isOwner && dossier.applicationRef && (
                <MetaField label="Application" value={dossier.applicationRef} icon="assignment" mono />
              )}
            </div>

            {/* Phase 22.4 — provenance link back to the source application. */}
            {!dossier.isOwner && dossier.applicationId && (
              <Link
                to={`/owner/applications?id=${encodeURIComponent(dossier.applicationId)}`}
                onClick={closeDossier}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-surface-container)] text-[var(--color-botanical-text)] text-[13px] font-semibold hover:bg-[var(--color-surface-high)] dark:bg-[#2e2a25] dark:text-[#f0ede9] transition-all"
              >
                <span className="material-symbols-outlined text-[17px]">assignment</span>
                View source application
                {dossier.applicationRef ? (
                  <span className="font-mono text-[11px] text-[var(--color-botanical-subtle)]">{dossier.applicationRef}</span>
                ) : null}
              </Link>
            )}

            {dossier.suspension?.reason && (
              <div className="p-3.5 rounded-xl bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] border border-[var(--color-danger-soft-border)] text-[13px]">
                <strong className="font-semibold">Suspended:</strong> {dossier.suspension.reason}
                {dossier.suspension.note ? ` — ${dossier.suspension.note}` : ''}
              </div>
            )}

            {/* Lifecycle controls — only what the server will accept */}
            <div>
              <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-subtle)] mb-2">
                Lifecycle
              </h3>
              {actions.note && !actions.canSuspend && !actions.canReactivate && !actions.canResend && !actions.canRevoke ? (
                <p className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] p-3 rounded-xl bg-[var(--color-surface-low)] dark:bg-[#26221e]">
                  {actions.note}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {isInvitation && actions.canResend && (
                    <StaffButton icon="forward_to_inbox" variant="secondary" loading={busy} onClick={doResend}>
                      Resend invitation
                    </StaffButton>
                  )}
                  {isInvitation && actions.canRevoke && (
                    <StaffButton icon="block" variant="dangerSoft" onClick={() => setRevokeOpen(true)}>
                      Revoke invitation
                    </StaffButton>
                  )}
                  {!isInvitation && actions.canSuspend && (
                    <StaffButton icon="person_off" variant="dangerSoft" onClick={() => setSuspendOpen(true)}>
                      Suspend
                    </StaffButton>
                  )}
                  {!isInvitation && actions.canReactivate && (
                    <StaffButton icon="how_to_reg" variant="primary" loading={busy} onClick={doReactivate}>
                      Reactivate
                    </StaffButton>
                  )}
                  <Link
                    to="/owner/staff"
                    className="inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-semibold bg-[var(--color-surface-container)] text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-high)] dark:bg-[#2e2a25] dark:text-[#f0ede9]"
                  >
                    <span className="material-symbols-outlined text-[17px]">badge</span>
                    Full staff directory
                  </Link>
                </div>
              )}
              {actions.note && (actions.canSuspend || actions.canReactivate) && (
                <p className="mt-2 text-[12px] text-[var(--color-botanical-subtle)]">{actions.note}</p>
              )}
            </div>

            {/* Activity timeline */}
            <div>
              <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-subtle)] mb-3">
                Activity Timeline
              </h3>
              {events.length === 0 ? (
                <p className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                  No activity has been recorded for this account yet.
                </p>
              ) : (
                <ol className="relative pl-5 space-y-4 before:content-[''] before:absolute before:left-1.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-[var(--color-surface-high)] dark:before:bg-[#37332c]">
                  {events.map((e) => (
                    <li key={e.id} className="relative">
                      <span className="absolute -left-5 top-1.5 w-2.5 h-2.5 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] leading-4 font-bold uppercase tracking-[0.04em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                          {String(e.type || '').replace(/_/g, ' ')}
                        </span>
                        <span className="text-[11px] leading-4 text-[var(--color-botanical-subtle)] shrink-0">{e.atLabel}</span>
                      </div>
                      <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">{e.message}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        ) : null}
      </AdminModal>

      {/* ── Suspend confirmation ── */}
      <AdminModal open={suspendOpen} onClose={() => setSuspendOpen(false)} labelledBy="suspend-admin-title">
        <div className="p-6 space-y-5">
          <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-full bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">person_off</span>
            </span>
            <div>
              <h2 id="suspend-admin-title" className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                Suspend staff member
              </h2>
              <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-0.5">
                {dossier?.name} · {dossier?.staffId} · {dossier?.email}
              </p>
            </div>
          </div>

          <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
            Suspension revokes access immediately — every existing session and token is refused on the very next request.
          </p>

          <div className="space-y-1.5">
            <label htmlFor="suspend-reason" className="block text-[13px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">
              Reason (required)
            </label>
            <select
              id="suspend-reason"
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              className="w-full px-4 py-3 rounded-full bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[13px] text-[var(--color-botanical-text)] dark:text-[#f0ede9] border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
            >
              {SUSPEND_REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="suspend-note" className="block text-[13px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">
              Note (optional)
            </label>
            <textarea
              id="suspend-note"
              rows={3}
              value={suspendNote}
              onChange={(e) => setSuspendNote(e.target.value)}
              placeholder="Context for the audit trail…"
              className="w-full px-4 py-3 rounded-2xl bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[13px] text-[var(--color-botanical-text)] dark:text-[#f0ede9] border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
            />
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
            <StaffButton variant="ghost" onClick={() => setSuspendOpen(false)}>Cancel</StaffButton>
            <StaffButton variant="danger" icon="person_off" loading={busy} onClick={doSuspend}>
              Suspend Staff Member
            </StaffButton>
          </div>
        </div>
      </AdminModal>

      {/* ── Revoke invitation confirmation ── */}
      <AdminModal open={revokeOpen} onClose={() => setRevokeOpen(false)} labelledBy="revoke-invite-title">
        <div className="p-6 space-y-5">
          <h2 id="revoke-invite-title" className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
            Revoke invitation
          </h2>
          <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
            The activation link for {dossier?.email} will stop working immediately. A new administrator can only be invited through a fresh application approval.
          </p>
          <div className="space-y-1.5">
            <label htmlFor="revoke-reason" className="block text-[13px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">
              Reason (optional)
            </label>
            <input
              id="revoke-reason"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              placeholder="Withdrawn by owner"
              className="w-full px-4 py-3 rounded-full bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[13px] text-[var(--color-botanical-text)] dark:text-[#f0ede9] border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
            />
          </div>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
            <StaffButton variant="ghost" onClick={() => setRevokeOpen(false)}>Cancel</StaffButton>
            <StaffButton variant="danger" icon="block" loading={busy} onClick={doRevoke}>
              Revoke Invitation
            </StaffButton>
          </div>
        </div>
      </AdminModal>

      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
    </AdminLayout>
  );
}
