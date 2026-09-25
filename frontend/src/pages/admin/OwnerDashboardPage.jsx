import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import { listApplications } from '../../services/adminApplicationService.js';
import { getOperators } from '../../services/adminUserService.js';
import { listInvitations } from '../../services/staffService.js';
import { StaffStatusPill } from '../../components/admin/StaffPrimitives.jsx';
import gsap from 'gsap';

/**
 * Phase 20.6.6 — Owner Console (`/admin/owner`, also the owner's portal home).
 *
 * Every number is a real API slice — no hardcoded KPIs:
 *   · Pending Admin Applications → GET /api/admin-applications counts.pending
 *   · Active Administrators      → /api/admin/users (role=admin, ACTIVE)
 *   · Active Handlers            → /api/admin/users (role=handler, ACTIVE)
 *   · Pending Invitations        → /api/admin/invitations counts.pending
 *   · Recent Applications        → the real dossiers, newest first
 *   · Invitation Ledger          → the real invitation rows
 *
 * The console is deliberately REVIEW-FIRST: the primary action is opening
 * the application ledger, because approving a dossier is the only door
 * through which a new administrator can ever enter (public intake → owner
 * review → one-time invitation → activation).
 */

const prefersReduced =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function initialsOf(name, email) {
  const source = String(name || email || '').trim();
  if (!source) return 'FA';
  const parts = source.includes('@') ? [source.split('@')[0]] : source.split(/\s+/);
  return (parts.filter(Boolean).slice(0, 2).map((p) => p[0]).join('') || 'FA').toUpperCase();
}

/** KPI card — one real metric, its real breakdown, and an honest status line. */
function KpiCard({ label, icon, tone, value, suffix, caption, footer }) {
  const chip =
    tone === 'danger'
      ? 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)]'
      : tone === 'success'
        ? 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae]'
        : tone === 'accent'
          ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] dark:bg-[#3a241c] dark:text-[#ffb9ab]'
          : 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] dark:text-[#f2efe9]';
  const halo =
    tone === 'danger'
      ? 'bg-[var(--color-danger-soft-bg)]/25'
      : tone === 'success'
        ? 'bg-[var(--color-botanical-sage-light)]/25'
        : tone === 'accent'
          ? 'bg-[var(--color-badge-bg)]/25'
          : 'bg-[var(--color-surface-highest)]/40';

  return (
    <div
      className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-2xl p-5 shadow-sm flex flex-col justify-between gap-3 relative overflow-hidden border border-[var(--color-botanical-border)] dark:border-[#3a3530]"
      data-dash-kpi
    >
      <div className={`absolute -right-3 -top-3 w-16 h-16 rounded-full ${halo} pointer-events-none`} />
      <div className="flex items-center justify-between gap-3 z-10">
        <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
          {label}
        </span>
        <span className={`w-8 h-8 rounded-full ${chip} flex items-center justify-center shrink-0`}>
          <span className="material-symbols-outlined text-[18px]">{icon}</span>
        </span>
      </div>
      <div className="z-10">
        <div className="flex items-baseline gap-2">
          <span className="font-serif text-[40px] leading-[48px] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
            {value}
          </span>
          {suffix && (
            <span className="text-[18px] leading-[26px] font-semibold text-[var(--color-botanical-subtle)]">
              {suffix}
            </span>
          )}
        </div>
        <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-1">
          {caption}
        </p>
      </div>
      {footer && (
        <div className="z-10 pt-1 text-[11px] leading-4 font-bold uppercase tracking-[0.06em] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] flex items-center gap-1.5">
          {footer}
        </div>
      )}
    </div>
  );
}

export default function OwnerDashboardPage() {
  const { session } = useAdminSession();
  const pageRef = useRef(null);

  // Real application ledger (owner-scoped API).
  const [apps, setApps] = useState([]);
  const [appCounts, setAppCounts] = useState(null);
  const [appsLoaded, setAppsLoaded] = useState(false);
  // Real operator roster.
  const [operators, setOperators] = useState([]);
  const [staffLoaded, setStaffLoaded] = useState(false);
  // Real invitation ledger.
  const [invitations, setInvitations] = useState([]);
  const [invCounts, setInvCounts] = useState(null);
  const [invLoaded, setInvLoaded] = useState(false);

  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    listApplications({ limit: 5 })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setApps(res.applications || []);
          setAppCounts(res.counts || null);
        } else {
          setLoadError(res.message || 'Could not load the application ledger.');
        }
        setAppsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setAppsLoaded(true);
      });
    getOperators({})
      .then((list) => {
        if (!cancelled) {
          setOperators(Array.isArray(list) ? list : []);
          setStaffLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setStaffLoaded(true);
      });
    listInvitations({})
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setInvitations(res.invitations || []);
          setInvCounts(res.counts || null);
        }
        setInvLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setInvLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (prefersReduced || !pageRef.current) return undefined;
    const ctx = gsap.context(() => {
      gsap.from('[data-dash-kpi]', {
        y: 16,
        opacity: 0,
        duration: 0.45,
        ease: 'power2.out',
        stagger: 0.06,
        delay: 0.05,
      });
      gsap.from('[data-dash-panel]', {
        y: 20,
        opacity: 0,
        duration: 0.5,
        ease: 'power2.out',
        stagger: 0.08,
        delay: 0.2,
      });
    }, pageRef);
    return () => ctx.revert();
  }, []);

  // /api/admin/users reports role as 'ADMINISTRATOR' | 'HANDLER'; accept the
  // raw enum too so both the live API and older shapes count correctly.
  const isRole = (o, want) => {
    const r = String(o.role || '').toLowerCase();
    return want === 'admin' ? r === 'admin' || r === 'administrator' : r === 'handler';
  };
  const activeAdmins = operators.filter(
    (o) => isRole(o, 'admin') && String(o.status || 'ACTIVE').toUpperCase() === 'ACTIVE'
  );
  const activeHandlers = operators.filter(
    (o) => isRole(o, 'handler') && String(o.status || 'ACTIVE').toUpperCase() === 'ACTIVE'
  );
  const suspendedCount = operators.filter(
    (o) => String(o.status || '').toUpperCase() === 'SUSPENDED'
  ).length;
  const adminsTotal = operators.filter((o) => isRole(o, 'admin')).length;
  const handlersTotal = operators.filter((o) => isRole(o, 'handler')).length;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (session?.name || '').split(/\s+/)[0] || 'there';
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <AdminLayout>
      <div ref={pageRef} className="max-w-7xl mx-auto space-y-6 sm:space-y-8 pb-8 sm:pb-12">
        {/* ── Header ── */}
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-5">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--color-surface-high)] dark:bg-[#37332c] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
              <span className="material-symbols-outlined text-[15px] text-[var(--color-accent)]">
                workspace_premium
              </span>
              <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em]">
                Owner Console — Atelier Governance
              </span>
            </div>
            <h1 className="font-serif text-[40px] leading-[48px] tracking-[-0.015em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
              {greeting}, {firstName}
            </h1>
            <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
              Who holds the keys to the operations console — applications, invitations and the live
              roster — {today}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/admin/access"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-[13px] leading-[18px] font-semibold shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] hover:bg-[var(--color-surface-high)] dark:hover:bg-[#33302a] transition-all"
            >
              <span className="material-symbols-outlined text-[18px] text-[var(--color-botanical-subtle)]">
                mail
              </span>
              Issue Handler Invite
            </Link>
            <Link
              to="/admin/applications"
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] leading-[18px] font-semibold shadow-md hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] transition-all active:translate-y-px"
            >
              <span className="material-symbols-outlined text-[18px]">review</span>
              Review Applications
              {appCounts && appCounts.pending > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-white/20 text-[11px] font-bold">
                  {appCounts.pending}
                </span>
              )}
            </Link>
          </div>
        </header>

        {loadError && (
          <div
            role="alert"
            className="p-4 rounded-xl bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] border border-[var(--color-danger-soft-border)] text-[13px]"
          >
            {loadError}
          </div>
        )}

        {/* ── KPI grid (every number real) ── */}
        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard
            label="Pending Admin Applications"
            icon="draft"
            tone="accent"
            value={appCounts ? appCounts.pending : appsLoaded ? 0 : '—'}
            suffix={appCounts && appCounts.pending === 1 ? 'Dossier' : 'Dossiers'}
            caption={
              appCounts
                ? `${appCounts.all} on the ledger · ${appCounts.approved} approved · ${appCounts.rejected} rejected`
                : appsLoaded
                  ? 'No ledger summary returned'
                  : 'Loading the application ledger…'
            }
            footer={
              <span>
                {appCounts && appCounts.pending > 0 ? 'Awaiting your review' : 'Queue clear'}
              </span>
            }
          />
          <KpiCard
            label="Active Administrators"
            icon="admin_panel_settings"
            tone="neutral"
            value={staffLoaded ? activeAdmins.length : '—'}
            suffix="Active"
            caption={
              staffLoaded
                ? `${adminsTotal} administrator${adminsTotal === 1 ? '' : 's'} on the roster`
                : 'Loading operator roster…'
            }
            footer={<span>{session?.isOwner ? 'You are the owner' : 'Owner designation required'}</span>}
          />
          <KpiCard
            label="Active Handlers"
            icon="nature_people"
            tone="success"
            value={staffLoaded ? activeHandlers.length : '—'}
            suffix="Active"
            caption={
              staffLoaded
                ? `${handlersTotal} handler${handlersTotal === 1 ? '' : 's'} on the roster`
                : 'Loading operator roster…'
            }
            footer={
              <span>{staffLoaded ? `${suspendedCount} suspended account${suspendedCount === 1 ? '' : 's'}` : '…'}</span>
            }
          />
          <KpiCard
            label="Pending Invitations"
            icon="outgoing_mail"
            tone="neutral"
            value={invCounts ? invCounts.pending : invLoaded ? 0 : '—'}
            suffix={invCounts && invCounts.pending === 1 ? 'Invite' : 'Invites'}
            caption={
              invCounts
                ? `${invCounts.all} issued in total · ${invCounts.accepted} accepted`
                : invLoaded
                  ? 'No invitation summary returned'
                  : 'Loading the invitation ledger…'
            }
            footer={
              <span>
                {invCounts ? `${invCounts.expired} expired · ${invCounts.revoked} revoked` : '…'}
              </span>
            }
          />
        </section>

        {/* ── Two-column governance layout ── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* ── Main column — recent applications ── */}
          <div className="lg:col-span-8 flex flex-col gap-8 min-w-0">
            <section
              className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl p-5 xl:p-8 shadow-sm space-y-6 border border-[var(--color-botanical-border)] dark:border-[#3a3530]"
              data-dash-panel
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[var(--color-accent)] text-[20px]">
                      assignment
                    </span>
                    <h2 className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                      Recent Admin Applications
                    </h2>
                  </div>
                  <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-0.5">
                    Public intake dossiers waiting on — or decided by — your review
                  </p>
                </div>
                <Link
                  to="/admin/applications"
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-[var(--color-surface-high)] dark:bg-[#37332c] text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-[13px] leading-[18px] font-semibold hover:bg-[var(--color-surface-highest)] transition-colors"
                >
                  Open ledger
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </Link>
              </div>

              {!appsLoaded && (
                <p className="py-6 text-center text-[15px] text-[var(--color-botanical-muted)]">
                  Loading applications…
                </p>
              )}

              {appsLoaded && apps.length === 0 && (
                <div className="py-10 text-center space-y-2">
                  <span className="material-symbols-outlined text-[36px] text-[var(--color-botanical-subtle)]">
                    inbox
                  </span>
                  <p className="text-[15px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                    No applications have arrived yet.
                  </p>
                  <p className="text-[13px] text-[var(--color-botanical-subtle)]">
                    Prospective administrators file a dossier at the public intake page
                    <span className="font-mono"> /apply/admin</span> — you review every one personally.
                  </p>
                </div>
              )}

              {appsLoaded && apps.length > 0 && (
                <div className="space-y-1">
                  {apps.map((app) => (
                    <Link
                      key={app.id}
                      to={`/admin/applications?id=${encodeURIComponent(app.id)}`}
                      className="flex items-center justify-between p-4 rounded-xl bg-[var(--color-surface-low)] dark:bg-[#26221e] hover:bg-[var(--color-surface-container)] dark:hover:bg-[#2e2a25] transition-colors gap-3"
                    >
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-10 h-10 rounded-full bg-[#2e241e] text-[#f1dfd5] flex items-center justify-center text-[13px] leading-[18px] font-semibold shrink-0">
                          {initialsOf(app.name, app.email)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[15px] leading-5 font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate">
                              {app.name}
                            </span>
                            <span className="text-[11px] leading-4 font-bold uppercase font-mono text-[var(--color-botanical-subtle)]">
                              {app.applicationId}
                            </span>
                          </div>
                          <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] truncate">
                            {app.email} · filed {timeAgo(app.createdAt)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <StaffStatusPill status={app.status} />
                        <span className="material-symbols-outlined text-[18px] text-[var(--color-botanical-subtle)]">
                          chevron_right
                        </span>
                      </div>
                    </Link>
                  ))}
                  {appCounts && appCounts.all > apps.length && (
                    <Link
                      to="/admin/applications"
                      className="flex items-center justify-center min-h-[44px] md:min-h-0 text-center pt-2 text-[13px] leading-[18px] font-semibold text-[var(--color-accent)] hover:underline"
                    >
                      View all {appCounts.all} applications →
                    </Link>
                  )}
                </div>
              )}
            </section>
          </div>

          {/* ── Aside column ── */}
          <div className="lg:col-span-4 flex flex-col gap-8 min-w-0">
            {/* Pending invitation ledger */}
            <section
              className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl p-5 xl:p-6 shadow-sm space-y-5 border border-[var(--color-botanical-border)] dark:border-[#3a3530]"
              data-dash-panel
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[var(--color-accent)] text-[20px]">
                    outgoing_mail
                  </span>
                  <h2 className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                    Invitation Ledger
                  </h2>
                </div>
                {invCounts && invCounts.pending > 0 && (
                  <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.06em] bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] dark:bg-[#3a241c] dark:text-[#ffb9ab] px-2 py-0.5 rounded-full">
                    {invCounts.pending} pending
                  </span>
                )}
              </div>

              {!invLoaded && (
                <p className="py-4 text-center text-[13px] text-[var(--color-botanical-muted)]">
                  Loading invitations…
                </p>
              )}

              {invLoaded && invitations.length === 0 && (
                <p className="py-4 text-center text-[13px] leading-5 text-[var(--color-botanical-muted)]">
                  No invitations outstanding. Issue one from Access &amp; Roles when you are ready.
                </p>
              )}

              {invLoaded &&
                invitations.slice(0, 3).map((inv) => (
                  <div
                    key={inv.id}
                    className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-xl p-4 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate">
                        {inv.recipientName || inv.recipientEmail}
                      </span>
                      <StaffStatusPill status={inv.status} />
                    </div>
                    <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] truncate">
                      {inv.recipientEmail}
                    </p>
                  </div>
                ))}

              <Link
                to="/admin/invitations"
                className="flex items-center justify-center w-full min-h-[44px] md:min-h-0 py-2.5 rounded-full bg-[var(--color-surface-low)] dark:bg-[#26221e] hover:bg-[var(--color-surface-container)] dark:hover:bg-[#2e2a25] text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-[13px] leading-[18px] font-semibold transition-colors text-center"
              >
                Open the invitation ledger →
              </Link>
            </section>

            {/* Owner shortcuts */}
            <section
              className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl p-5 xl:p-6 shadow-sm space-y-4 border border-[var(--color-botanical-border)] dark:border-[#3a3530]"
              data-dash-panel
            >
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] text-[20px]">
                  key
                </span>
                <h2 className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                  Governance Shortcuts
                </h2>
              </div>
              <div className="space-y-1">
                {[
                  { to: '/admin/applications', icon: 'assignment', label: 'Review admin applications' },
                  { to: '/admin/staff', icon: 'badge', label: 'Staff directory' },
                  { to: '/admin/invitations', icon: 'mail', label: 'Invitations' },
                  { to: '/admin/access', icon: 'shield_person', label: 'Access & roles' },
                ].map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    className="flex items-center justify-between p-3.5 rounded-xl hover:bg-[var(--color-surface-low)] dark:hover:bg-[#26221e] transition-colors group"
                  >
                    <span className="flex items-center gap-3 text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                      <span className="material-symbols-outlined text-[18px] text-[var(--color-accent)]">
                        {item.icon}
                      </span>
                      {item.label}
                    </span>
                    <span className="material-symbols-outlined text-[17px] text-[var(--color-botanical-subtle)] group-hover:text-[var(--color-accent)]">
                      arrow_forward
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
