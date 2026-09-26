import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import {
  StaffStatusPill,
  StaffRoleBadge,
  StaffAvatar,
  StaffEmptyState,
  StaffTableSkeleton,
} from '../../components/admin/StaffPrimitives.jsx';
import { getOwnerAdministrators } from '../../services/ownerService.js';

/**
 * Phase 21.2 — Administrators Directory (`/owner/administrators`).
 *
 * The owner's view of who holds the keys. Every row is a REAL administrator
 * account or a live administrator invitation — no demo names. Lifecycle
 * actions (suspend / reactivate / resend / revoke) run through the shared staff
 * endpoints, so this page links into the staff directory rather than
 * duplicating the confirmation flows.
 */

const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'INVITED', label: 'Invited' },
  { key: 'SUSPENDED', label: 'Suspended' },
  { key: 'EXPIRED', label: 'Expired' },
];

function KpiCard({ label, value, icon, tone, caption }) {
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
    </div>
  );
}

export default function OwnerAdministratorsPage() {
  const { session } = useAdminSession();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('ALL');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const res = await getOwnerAdministrators({ q: q || undefined, status: filter === 'ALL' ? undefined : filter });
    if (res.ok) {
      setRows(res.administrators);
      setCounts(res.counts);
    } else {
      setError(res.message || 'Could not load the administrators directory.');
    }
    setLoading(false);
  }, [q, filter]);

  // Debounce the search so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const ownerCount = useMemo(() => rows.filter((r) => r.isOwner).length, [rows]);

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 sm:space-y-8 pb-8 sm:pb-12">
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
              Every account that can administer Flora Alchemy — the owner, approved administrators and live administrator invitations.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/owner/staff"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-[13px] leading-[18px] font-semibold shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] hover:bg-[var(--color-surface-high)] dark:hover:bg-[#33302a] transition-all"
            >
              <span className="material-symbols-outlined text-[18px] text-[var(--color-botanical-subtle)]">badge</span>
              Full staff directory
            </Link>
          </div>
        </header>

        {error && (
          <div role="alert" className="p-4 rounded-xl bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] border border-[var(--color-danger-soft-border)] text-[13px] flex items-center justify-between gap-3">
            <span>{error}</span>
            <button type="button" onClick={load} className="font-semibold underline">Retry</button>
          </div>
        )}

        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard label="Administrators" value={counts ? counts.all : '—'} icon="admin_panel_settings" tone="accent" caption={counts ? `${counts.owners} owner · ${counts.all - counts.owners} admin` : 'Loading…'} />
          <KpiCard label="Active" value={counts ? counts.active : '—'} icon="check_circle" tone="success" caption="Can sign in now" />
          <KpiCard label="Invited" value={counts ? counts.invited : '—'} icon="mail" tone="neutral" caption="Awaiting activation" />
          <KpiCard label="Suspended" value={counts ? counts.suspended : '—'} icon="block" tone="danger" caption={counts ? `${counts.expired} expired invites` : '…'} />
        </section>

        <section className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] overflow-hidden">
          <div className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
            <div className="relative flex items-center w-full lg:max-w-sm">
              <span className="material-symbols-outlined absolute left-3.5 text-[18px] text-[var(--color-botanical-subtle)] pointer-events-none">search</span>
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name, email or staff ID…"
                className="w-full pl-11 pr-4 py-2.5 bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[var(--color-botanical-text)] dark:text-[#f0ede9] text-[13px] rounded-full placeholder:text-[var(--color-botanical-subtle)] border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-all"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`px-3.5 py-1.5 rounded-full text-[12px] font-semibold transition-colors ${
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
            <div className="p-5"><StaffTableSkeleton rows={4} /></div>
          ) : rows.length === 0 ? (
            <div className="p-8">
              <StaffEmptyState
                icon="admin_panel_settings"
                title={q || filter !== 'ALL' ? 'No administrators match this view' : 'No administrators yet'}
                description={
                  q || filter !== 'ALL'
                    ? 'Try a different search term or filter.'
                    : 'You are the only administrator. Approve an application to invite another.'
                }
                action={null}
              />
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-subtle)] border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                      <th className="px-5 py-3">Administrator</th>
                      <th className="px-5 py-3">Role</th>
                      <th className="px-5 py-3">Staff ID</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3">Last Active</th>
                      <th className="px-5 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-botanical-border)] dark:divide-[#3a3530]">
                    {rows.map((r) => (
                      <tr key={r.id} className="hover:bg-[var(--color-surface-low)] dark:hover:bg-[#26221e] transition-colors">
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3 min-w-0">
                            <StaffAvatar initials={r.initials} size={38} tone={r.isOwner ? 'accent' : 'primary'} />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[14px] leading-5 font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate">{r.name}</span>
                                {r.isOwner && (
                                  <span className="px-2 py-0.5 rounded-full bg-[var(--color-btn)] text-white text-[9px] font-bold uppercase tracking-wider">Owner</span>
                                )}
                              </div>
                              <p className="text-[12px] leading-4 text-[var(--color-botanical-subtle)] truncate">{r.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4"><StaffRoleBadge roleBadge={r.roleBadge} /></td>
                        <td className="px-5 py-4"><span className="font-mono text-[12px] text-[var(--color-botanical-muted)]">{r.staffId}</span></td>
                        <td className="px-5 py-4"><StaffStatusPill status={r.status} /></td>
                        <td className="px-5 py-4 text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">{r.lastActiveLabel}</td>
                        <td className="px-5 py-4 text-right">
                          <button
                            type="button"
                            onClick={() => navigate('/owner/staff')}
                            className="inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--color-accent)] hover:underline"
                          >
                            Manage
                            <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden divide-y divide-[var(--color-botanical-border)] dark:divide-[#3a3530]">
                {rows.map((r) => (
                  <div key={r.id} className="p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <StaffAvatar initials={r.initials} size={40} tone={r.isOwner ? 'accent' : 'primary'} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate">{r.name}</span>
                          {r.isOwner && (
                            <span className="px-2 py-0.5 rounded-full bg-[var(--color-btn)] text-white text-[9px] font-bold uppercase tracking-wider">Owner</span>
                          )}
                        </div>
                        <p className="text-[12px] text-[var(--color-botanical-subtle)] truncate">{r.email}</p>
                      </div>
                      <StaffStatusPill status={r.status} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[12px] text-[var(--color-botanical-muted)]">{r.staffId}</span>
                      <button type="button" onClick={() => navigate('/owner/staff')} className="text-[13px] font-semibold text-[var(--color-accent)]">
                        Manage →
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <p className="text-[13px] leading-5 text-[var(--color-botanical-subtle)]">
          Signed in as {session?.roleLabel || 'Owner'}. Administrator lifecycle actions run through the staff directory, where the server enforces owner-only rules.
        </p>
      </div>
    </AdminLayout>
  );
}
