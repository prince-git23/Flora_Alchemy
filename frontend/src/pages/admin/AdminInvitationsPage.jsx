import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import {
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from '../../services/staffService.js';
import {
  StaffStatusPill,
  StaffRoleBadge,
  StaffAvatar,
  StaffEmptyState,
  StaffTableSkeleton,
  AdminToast,
  AdminModal,
  StaffButton,
} from '../../components/admin/StaffPrimitives.jsx';

/**
 * Phase 20.6.4 — Invitation management (/admin/invitations).
 *
 * The ledger of every staff invitation the atelier has issued, with the tabs
 * the reference specifies (Pending / Accepted / Expired / Revoked) driven by
 * REAL counts from the server.
 *
 * The single most important thing about this screen is what it does NOT show:
 * the raw activation token. Tokens exist in exactly one response, at the
 * moment they are minted, so this page can never display a stored link — and
 * instead of pretending otherwise it hands you the fresh link inline when you
 * resend, and explains the rule in plain words. "Copy link" therefore appears
 * only for a link that was minted in this session.
 */

const TABS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'ACCEPTED', label: 'Accepted' },
  { key: 'EXPIRED', label: 'Expired' },
  { key: 'REVOKED', label: 'Revoked' },
  { key: 'ALL', label: 'All' },
];

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function countdown(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return 'Lapsed';
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  if (hours <= 0) return `${mins}m left`;
  if (hours < 48) return `${hours}h ${mins % 60}m left`;
  return `${Math.floor(hours / 24)}d left`;
}

export default function AdminInvitationsPage() {
  const { session } = useAdminSession();
  const [tab, setTab] = useState('PENDING');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [fresh, setFresh] = useState(null); // { invitation, link } — shown once
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);
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
    const res = await listInvitations({ status: tab === 'ALL' ? undefined : tab, q: debouncedQ });
    if (!res.ok) {
      setState('error');
      setError(res.message || 'Could not load the invitation ledger.');
      return;
    }
    setRows(res.invitations);
    setCounts(res.counts);
    setState('ready');
  }, [tab, debouncedQ]);

  useEffect(() => { load(); }, [load]);

  const handleResend = async (row) => {
    setBusyId(row.id);
    const res = await resendInvitation(row.id);
    setBusyId(null);
    if (!res.ok) {
      notify('Could not resend the invitation', res.message, 'error');
      return;
    }
    setFresh({ invitation: res.invitation, link: res.link });
    notify('Invitation re-sent', 'A new link was minted; the previous one no longer works.', 'success');
    load();
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    const res = await revokeInvitation(revokeTarget.id);
    setRevoking(false);
    if (!res.ok) {
      notify('Could not revoke the invitation', res.message, 'error');
      return;
    }
    notify('Invitation revoked', `The link for ${revokeTarget.recipientEmail} is now unusable.`, 'success');
    if (fresh?.invitation?.id === revokeTarget.id) setFresh(null);
    setRevokeTarget(null);
    load();
  };

  const copyLink = async (link) => {
    try {
      await navigator.clipboard.writeText(link);
      notify('Invitation link copied', 'Send it over a channel you trust.', 'success');
    } catch {
      notify('Copy blocked by the browser', 'Select the link and copy it manually.', 'info');
    }
  };

  const tabCount = (key) => {
    if (!counts) return null;
    if (key === 'PENDING') return counts.pending;
    if (key === 'ACCEPTED') return counts.accepted;
    if (key === 'EXPIRED') return counts.expired;
    if (key === 'REVOKED') return counts.revoked;
    return counts.all;
  };

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5 mb-7">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
              <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-botanical-muted)]">
                Staff Invitations
              </span>
            </div>
            <h1 className="font-serif text-[34px] sm:text-[40px] leading-tight text-[var(--color-botanical-text)] tracking-tight dark:text-[#f0ede9]">
              Invitation Ledger
            </h1>
            <p className="text-[15px] text-[var(--color-botanical-muted)] max-w-2xl mt-1">
              Every invitation {session?.isOwner ? 'the atelier has' : 'you have'} issued, with its real
              state. Activation links are single-use, valid for 72 hours, and shown only at the moment they
              are created.
            </p>
          </div>
          {/* Client-side navigation — a full page load here would drop the
              already-hydrated store and re-download the admin bundle. */}
          <Link
            to="/admin/staff"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-surface-container)] text-[var(--color-botanical-text)] px-4 py-2.5 text-[13px] font-semibold hover:bg-[var(--color-surface-high)] transition-colors dark:bg-[#2e2a25] dark:text-[#f0ede9]"
          >
            <span className="material-symbols-outlined text-[17px]">group</span>
            Open Staff Directory
          </Link>
        </div>

        {/* Freshly minted link — the only time it is visible */}
        {fresh && (
          <div className="mb-6 p-4 rounded-2xl bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] flex flex-col sm:flex-row sm:items-center gap-3">
            <span className="material-symbols-outlined text-[22px] shrink-0">mark_email_read</span>
            <div className="min-w-0 flex-1">
              <span className="block text-[11px] font-bold uppercase tracking-wider">
                New activation link for {fresh.invitation?.recipientEmail} — shown once
              </span>
              <p className="text-[11px] font-mono break-all leading-snug mt-1">{fresh.link}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StaffButton size="sm" icon="content_copy" onClick={() => copyLink(fresh.link)}>Copy</StaffButton>
              <button type="button" onClick={() => setFresh(null)} aria-label="Dismiss" className="min-h-[44px] min-w-[44px] flex items-center justify-center opacity-70 hover:opacity-100">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
          </div>
        )}

        {/* Tabs + search */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-5">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
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
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search recipient, name or department…"
              aria-label="Search invitations"
              className="w-full pl-10 pr-4 py-2.5 min-h-[44px] md:min-h-0 rounded-full bg-[var(--color-surface-lowest)] text-[13px] text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] shadow-sm outline-none focus:ring-2 focus:ring-[var(--color-focus)] dark:bg-[#1f1c19] dark:text-[#f0ede9]"
            />
          </div>
        </div>

        <div className="rounded-2xl bg-[var(--color-surface-lowest)] shadow-[0_4px_20px_-2px_rgba(46,36,30,0.05)] overflow-hidden dark:bg-[#1f1c19]">
          {state === 'loading' && <StaffTableSkeleton rows={5} />}

          {state === 'error' && (
            <StaffEmptyState
              icon="cloud_off"
              title="Could not load the invitation ledger"
              description={error}
              action={<StaffButton icon="refresh" onClick={load}>Try again</StaffButton>}
            />
          )}

          {state !== 'loading' && state !== 'error' && rows.length === 0 && (
            <StaffEmptyState
              icon="mail_off"
              title={debouncedQ ? 'No invitations match your search' : `No ${TABS.find((t) => t.key === tab)?.label.toLowerCase()} invitations`}
              description={
                debouncedQ
                  ? 'Try a different name, email or department.'
                  : 'Invitations you issue from the Staff Directory appear here with their live status.'
              }
              action={<Link to="/admin/staff" className="text-[13px] font-semibold text-[var(--color-accent)] hover:underline">Go to Staff Directory →</Link>}
            />
          )}

          {state !== 'loading' && state !== 'error' && rows.length > 0 && (
            <>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[760px]">
                  <thead>
                    <tr className="bg-[var(--color-surface-container)]/60 text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)]">
                      <th className="py-3 px-5">Recipient</th>
                      <th className="py-3 px-3">Role</th>
                      <th className="py-3 px-3">Invited By</th>
                      <th className="py-3 px-3">Created</th>
                      <th className="py-3 px-3">Expires</th>
                      <th className="py-3 px-3">Status</th>
                      <th className="py-3 px-5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <InvitationRow
                        key={row.id}
                        row={row}
                        busy={busyId === row.id}
                        onResend={() => handleResend(row)}
                        onRevoke={() => setRevokeTarget(row)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="md:hidden divide-y divide-[var(--color-divider)]">
                {rows.map((row) => (
                  <div key={row.id} className="p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <StaffAvatar initials={(row.recipientName || row.recipientEmail || 'FA').slice(0, 2).toUpperCase()} size={38} tone="accent" />
                      <div className="min-w-0 flex-1">
                        <span className="block text-[14px] font-semibold text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
                          {row.recipientName || row.recipientEmail}
                        </span>
                        <span className="block text-[12px] text-[var(--color-botanical-muted)] truncate">{row.recipientEmail}</span>
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <StaffRoleBadge roleBadge={String(row.roleLabel || '').toUpperCase()} />
                          <StaffStatusPill status={row.status} />
                        </div>
                      </div>
                    </div>
                    <div className="text-[12px] text-[var(--color-botanical-muted)] space-y-1">
                      <p>Invited by {row.invitedByName || '—'} · {formatDateTime(row.createdAt)}</p>
                      {row.status === 'INVITED' && <p className="text-[var(--color-accent)] font-semibold">{countdown(row.expiresAt)}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {row.canResend && (
                        <StaffButton size="sm" variant="secondary" icon="forward_to_inbox" loading={busyId === row.id} onClick={() => handleResend(row)}>
                          Resend
                        </StaffButton>
                      )}
                      {row.canRevoke && (
                        <StaffButton size="sm" variant="dangerSoft" icon="undo" onClick={() => setRevokeTarget(row)}>
                          Revoke
                        </StaffButton>
                      )}
                      {!row.canResend && !row.canRevoke && (
                        <span className="text-[11px] text-[var(--color-botanical-subtle)]">No further actions — this invitation is closed.</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="px-5 py-2.5 bg-[var(--color-surface-low)] flex items-center justify-between text-[11px] text-[var(--color-botanical-subtle)] dark:bg-[#26221e]">
            <span className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[14px]">lock</span>
              Activation links are stored only as irreversible hashes — no link can be re-displayed
            </span>
            <span className="hidden sm:inline">{rows.length} shown</span>
          </div>
        </div>
      </div>

      <AdminModal open={!!revokeTarget} onClose={() => setRevokeTarget(null)} labelledBy="revoke-title">
        <div className="p-6">
          <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-full bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[22px]">undo</span>
            </span>
            <div>
              <h3 id="revoke-title" className="font-serif text-[22px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                Revoke this invitation?
              </h3>
              <p className="text-[13px] text-[var(--color-botanical-muted)] mt-1">
                The activation link stops working immediately and cannot be restored — a new invitation would
                be required.
              </p>
            </div>
          </div>
          <div className="mt-4 px-3.5 py-2.5 rounded-xl bg-[var(--color-surface-container)] dark:bg-[#2e2a25]">
            <span className="block text-[13px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
              {revokeTarget?.recipientName || revokeTarget?.recipientEmail}
            </span>
            <span className="block text-[12px] text-[var(--color-botanical-muted)] min-w-0 break-all">{revokeTarget?.recipientEmail}</span>
          </div>
          <div className="mt-5 flex items-center justify-end gap-2">
            <StaffButton variant="ghost" onClick={() => setRevokeTarget(null)}>Cancel</StaffButton>
            <StaffButton variant="danger" icon="undo" loading={revoking} onClick={handleRevoke}>Revoke Invitation</StaffButton>
          </div>
        </div>
      </AdminModal>

      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
    </AdminLayout>
  );
}

function InvitationRow({ row, busy, onResend, onRevoke }) {
  return (
    <tr className="hover:bg-[var(--color-surface-low)]/70 transition-colors">
      <td className="py-3.5 px-5">
        <div className="flex items-center gap-3">
          <StaffAvatar
            initials={(row.recipientName || row.recipientEmail || 'FA').slice(0, 2).toUpperCase()}
            size={36}
            tone={row.status === 'REVOKED' || row.status === 'EXPIRED' ? 'muted' : 'accent'}
          />
          <div className="min-w-0">
            <span className="block text-[13px] font-semibold text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
              {row.recipientName || row.recipientEmail}
            </span>
            <span className="block text-[11px] text-[var(--color-botanical-muted)] truncate">{row.recipientEmail}</span>
          </div>
        </div>
      </td>
      <td className="py-3.5 px-3">
        <StaffRoleBadge roleBadge={String(row.roleLabel || '').toUpperCase()} />
      </td>
      <td className="py-3.5 px-3 text-[12px] text-[var(--color-botanical-muted)] truncate max-w-[150px]">
        {row.invitedByName || '—'}
      </td>
      <td className="py-3.5 px-3 text-[12px] text-[var(--color-botanical-muted)] whitespace-nowrap">
        {formatDateTime(row.createdAt)}
      </td>
      <td className="py-3.5 px-3 text-[12px] whitespace-nowrap">
        <span className="block text-[var(--color-botanical-muted)]">{formatDateTime(row.expiresAt)}</span>
        {row.status === 'INVITED' && (
          <span className="block text-[11px] font-semibold text-[var(--color-accent)]">{countdown(row.expiresAt)}</span>
        )}
      </td>
      <td className="py-3.5 px-3">
        <StaffStatusPill status={row.status} />
        {row.resendCount > 0 && (
          <span className="block text-[10px] text-[var(--color-botanical-subtle)] mt-1">
            resent {row.resendCount}×
          </span>
        )}
      </td>
      <td className="py-3.5 px-5 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {row.canResend && (
            <button
              type="button"
              disabled={busy}
              onClick={onResend}
              className="px-2.5 py-1 rounded-full bg-[var(--color-surface-container)] text-[11px] font-semibold text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-high)] transition-colors disabled:opacity-50 dark:bg-[#2e2a25] dark:text-[#f0ede9]"
            >
              {busy ? 'Resending…' : 'Resend'}
            </button>
          )}
          {row.canRevoke && (
            <button
              type="button"
              onClick={onRevoke}
              className="px-2.5 py-1 rounded-full text-[11px] font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-soft-bg)] transition-colors"
            >
              Revoke
            </button>
          )}
          {!row.canResend && !row.canRevoke && (
            <span className="text-[11px] text-[var(--color-botanical-subtle)]">—</span>
          )}
        </div>
      </td>
    </tr>
  );
}
