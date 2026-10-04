import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import {
  StaffStatusPill,
  StaffEmptyState,
  StaffTableSkeleton,
  AdminToast,
  StaffButton,
} from '../../components/admin/StaffPrimitives.jsx';
import { getOwnerShops, suspendShop, reactivateShop } from '../../services/ownerService.js';

/**
 * PHASE 1 — SHOP GOVERNANCE (`/owner/shops`).
 *
 * The owner's platform-level register of every Shop (the customer-facing
 * representation of a Workspace). It shows REAL identity and lifecycle only:
 * display name, address, ACTIVE/SUSPENDED status, primary administrator.
 *
 * The ONLY actions are Suspend and Reactivate. The owner is a governance
 * identity: this page deliberately has no inventory, no orders and no
 * catalogue editing — those are workspace-scoped surfaces the backend refuses
 * for the owner (403 WORKSPACE_REQUIRED). Every status change is
 * server-authorized and takes effect on the public surfaces immediately.
 *
 * Nothing here is invented: no follower counts, no ratings, no revenue, no
 * statistics the backend does not have.
 */

const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'SUSPENDED', label: 'Suspended' },
];

function KpiCard({ label, value, caption }) {
  return (
    <div className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-2xl p-5 shadow-sm flex flex-col gap-2 border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
      <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
        {label}
      </span>
      <span className="font-serif text-[32px] leading-[40px] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
        {value}
      </span>
      <p className="text-[12px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">{caption}</p>
    </div>
  );
}

export default function OwnerShopsPage() {
  const [shops, setShops] = useState([]);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [q, setQ] = useState('');
  const [busySlug, setBusySlug] = useState('');
  const [toast, setToast] = useState(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await getOwnerShops({ q, status: filter });
      if (!res.ok) {
        setError(res.message || 'Could not load the shop register.');
        setShops([]);
        setCounts(null);
      } else {
        setError('');
        setShops(res.shops);
        setCounts(res.counts);
      }
    } catch {
      setError('Could not load the shop register.');
    } finally {
      setLoading(false);
    }
  }, [q, filter]);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = useCallback(async (shop, next) => {
    setBusySlug(shop.slug);
    try {
      const res = next === 'SUSPENDED' ? await suspendShop(shop.slug) : await reactivateShop(shop.slug);
      if (!res.ok) {
        setToast({ tone: 'error', title: 'Could not update the shop', message: res.message || 'Please try again.' });
        return;
      }
      setToast({
        tone: 'success',
        title: next === 'SUSPENDED' ? 'Shop suspended' : 'Shop reactivated',
        message:
          next === 'SUSPENDED'
            ? `${shop.displayName} is no longer publicly discoverable.`
            : `${shop.displayName} is publicly discoverable again.`,
      });
      await load({ silent: true });
    } catch {
      setToast({ tone: 'error', title: 'Could not update the shop', message: 'Please try again.' });
    } finally {
      setBusySlug('');
    }
  }, [load]);

  const activeCount = counts?.active ?? shops.filter((s) => s.status === 'ACTIVE').length;
  const suspendedCount = counts?.suspended ?? shops.filter((s) => s.status === 'SUSPENDED').length;

  const rows = useMemo(() => shops, [shops]);

  return (
    <AdminLayout>
      <AdminToast toast={toast} onDismiss={() => setToast(null)} />

      <div className="space-y-8">
        <header className="space-y-2">
          <span className="block text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
            Owner Governance
          </span>
          <h1 className="font-serif text-[28px] sm:text-[34px] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] font-normal tracking-tight">
            Shops
          </h1>
          <p className="text-[14px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] max-w-2xl">
            Every shop on the marketplace, with its lifecycle status and primary administrator. Suspending a shop
            removes it from public discovery immediately; reactivating restores it.
          </p>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <KpiCard label="Shops" value={counts?.all ?? rows.length} caption="On the platform" />
          <KpiCard label="Active" value={activeCount} caption="Publicly discoverable" />
          <KpiCard label="Suspended" value={suspendedCount} caption="Hidden from the marketplace" />
        </div>

        <section className="bg-[var(--color-surface-lowest)] dark:bg-[#1f1c18] rounded-3xl border border-[var(--color-botanical-border)] dark:border-[#3a3530] shadow-sm overflow-hidden">
          <div className="p-5 flex flex-col sm:flex-row sm:items-center gap-3 border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
            <div className="flex items-center gap-1.5 flex-wrap">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`px-4 py-1.5 rounded-full text-[12px] font-semibold transition-colors ${
                    filter === f.key
                      ? 'bg-[var(--color-btn)] text-white'
                      : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] dark:bg-[#26221e] dark:text-[#b9b1a8]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <label className="sm:ml-auto flex items-center gap-2 bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-full px-4 py-2 border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
              <span className="material-symbols-outlined text-[17px] text-[var(--color-botanical-subtle)]">search</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name or address"
                aria-label="Search shops"
                className="bg-transparent outline-none text-[13px] w-full sm:w-56 text-[var(--color-botanical-text)] dark:text-[#f0ede9] placeholder:text-[var(--color-botanical-subtle)]"
              />
            </label>
          </div>

          {loading ? (
            <div className="p-5">
              <StaffTableSkeleton rows={4} />
            </div>
          ) : error ? (
            <div className="p-8">
              <StaffEmptyState icon="cloud_off" title="Could not load shops" description={error} />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8">
              <StaffEmptyState
                icon="storefront"
                title={q || filter !== 'ALL' ? 'No shops match this view' : 'No shops yet'}
                description={
                  q || filter !== 'ALL'
                    ? 'Try a different search term or status filter.'
                    : 'A shop appears here when an approved administrator activates their invitation.'
                }
                action={
                  q || filter !== 'ALL' ? null : (
                    <Link
                      to="/owner/applications"
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-all"
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
              {/* Desktop register */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-subtle)] border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                      <th className="px-5 py-3">Shop</th>
                      <th className="px-5 py-3">Primary administrator</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3">Created</th>
                      <th className="px-5 py-3 text-right">Lifecycle</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-botanical-border)] dark:divide-[#3a3530]">
                    {rows.map((s) => (
                      <tr key={s.id} className="transition-colors hover:bg-[var(--color-surface-low)] dark:hover:bg-[#26221e]">
                        <td className="px-5 py-4">
                          <span className="block text-[14px] leading-5 font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                            {s.displayName}
                          </span>
                          <Link
                            to={`/shops/${encodeURIComponent(s.slug)}`}
                            className="block font-mono text-[11px] text-[var(--color-botanical-muted)] hover:text-[var(--color-accent)]"
                          >
                            /shops/{s.slug}
                          </Link>
                        </td>
                        <td className="px-5 py-4">
                          {s.primaryAdmin ? (
                            <span className="min-w-0 block">
                              <span className="block text-[13px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9] truncate">
                                {s.primaryAdmin.name}
                              </span>
                              <span className="block text-[12px] text-[var(--color-botanical-subtle)] truncate">
                                {s.primaryAdmin.email}
                              </span>
                            </span>
                          ) : (
                            <span className="text-[12px] text-[var(--color-botanical-subtle)]">Not yet claimed</span>
                          )}
                        </td>
                        <td className="px-5 py-4"><StaffStatusPill status={s.status} /></td>
                        <td className="px-5 py-4 text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                          {s.createdLabel || '—'}
                        </td>
                        <td className="px-5 py-4 text-right">
                          {s.actions?.canSuspend && (
                            <StaffButton
                              variant="secondary"
                              size="sm"
                              loading={busySlug === s.slug}
                              onClick={() => setStatus(s, 'SUSPENDED')}
                            >
                              Suspend
                            </StaffButton>
                          )}
                          {s.actions?.canReactivate && (
                            <StaffButton
                              size="sm"
                              loading={busySlug === s.slug}
                              onClick={() => setStatus(s, 'ACTIVE')}
                            >
                              Reactivate
                            </StaffButton>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile register */}
              <ul className="md:hidden divide-y divide-[var(--color-botanical-border)] dark:divide-[#3a3530]">
                {rows.map((s) => (
                  <li key={s.id} className="p-5 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className="block text-[15px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate">
                          {s.displayName}
                        </span>
                        <Link
                          to={`/shops/${encodeURIComponent(s.slug)}`}
                          className="block font-mono text-[11px] text-[var(--color-botanical-muted)] hover:text-[var(--color-accent)] truncate"
                        >
                          /shops/{s.slug}
                        </Link>
                      </div>
                      <StaffStatusPill status={s.status} />
                    </div>
                    <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                      {s.primaryAdmin
                        ? `${s.primaryAdmin.name} · ${s.primaryAdmin.email}`
                        : 'No primary administrator yet'}
                    </p>
                    <div className="flex items-center gap-2">
                      {s.actions?.canSuspend && (
                        <StaffButton
                          variant="secondary"
                          size="sm"
                          loading={busySlug === s.slug}
                          onClick={() => setStatus(s, 'SUSPENDED')}
                        >
                          Suspend
                        </StaffButton>
                      )}
                      {s.actions?.canReactivate && (
                        <StaffButton
                          size="sm"
                          loading={busySlug === s.slug}
                          onClick={() => setStatus(s, 'ACTIVE')}
                        >
                          Reactivate
                        </StaffButton>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </AdminLayout>
  );
}