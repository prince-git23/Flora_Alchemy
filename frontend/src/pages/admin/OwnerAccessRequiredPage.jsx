import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import { requestElevation } from '../../services/invitationService.js';

/**
 * Phase 20.6.2 — Owner Access Required (design ref: "Owner Access Required").
 *
 * The access-denied dossier shown when a staff session without the owner
 * designation reaches an owner-only route. Every value on this screen is
 * REAL: the attempted route, the authenticated identity from the session,
 * a live timestamp, and the owner flag itself. The "Request Elevated
 * Clearance" button performs a real action — it notifies every active owner
 * account server-side (POST /api/notifications/elevation-request) and
 * reports how many owners were actually reached.
 *
 * Frontend visibility is UX only — requireOwner on the backend is the
 * authority for owner-only capabilities.
 */
export default function OwnerAccessRequiredPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { session } = useAdminSession();

  const attemptedRoute = location.pathname + (location.search || '');
  const roleLabel = session?.role === 'admin' ? 'Administrator' : session?.role === 'handler' ? 'Handler' : 'Staff';

  // Live timestamp — the dossier logs when the denial happened (ticks with
  // the clock so the entry reflects the moment on screen).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const timestamp = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(now);

  // Elevation request state — real server round-trip, honest outcomes.
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const [notice, setNotice] = useState(null); // {tone: 'ok'|'warn'|'error', text}

  const handleRequestElevation = async () => {
    if (requesting || requested) return;
    setRequesting(true);
    setNotice(null);
    try {
      const res = await requestElevation(attemptedRoute, 'admin');
      if (res.ok) {
        setRequested(true);
        setNotice(
          res.requested > 0
            ? {
                tone: 'ok',
                text: `Elevation request delivered to ${res.requested} owner account${res.requested === 1 ? '' : 's'}. They will see it in their notifications.`,
              }
            : {
                tone: 'warn',
                text: 'No owner account is configured yet, so there was nobody to notify. Ask an administrator to run the owner provisioning step.',
              }
        );
      } else {
        setNotice({ tone: 'error', text: res.message || 'Could not record the elevation request.' });
      }
    } catch {
      setNotice({ tone: 'error', text: 'Could not record the elevation request. Please try again.' });
    } finally {
      setRequesting(false);
    }
  };

  const dossierRow = (icon, label, value, tone = 'default') => (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 py-1">
      <span className="text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] flex items-center gap-1.5 text-[13px] leading-5">
        <span className="material-symbols-outlined text-[15px] text-[var(--color-botanical-subtle)]">{icon}</span>
        {label}
      </span>
      <span className={`text-right ${tone === 'mono' ? 'font-mono text-[12px] bg-[var(--color-surface-high)] dark:bg-[#37332c] px-2 py-1 rounded text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] tracking-tight break-all' : 'font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] text-[13px]'}`}>
        {value}
      </span>
    </div>
  );

  return (
    <AdminLayout>
      <div className="relative w-full overflow-hidden">
        {/* Ambient depth */}
        <div className="absolute -top-24 right-8 w-96 h-96 rounded-full bg-[var(--color-badge-bg)]/30 blur-3xl pointer-events-none"></div>
        <div className="absolute top-1/2 -left-16 w-80 h-80 rounded-full bg-[var(--color-botanical-sage-light)]/40 blur-3xl pointer-events-none"></div>

        <div className="max-w-7xl mx-auto w-full relative z-10 pb-8">
          {/* Breadcrumb + protocol state */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] text-[13px] leading-5">
              <button type="button" onClick={() => navigate('/admin/dashboard')} className="hover:text-[var(--color-botanical-primary)] dark:hover:text-[#f7f4ef] transition-colors cursor-pointer">Operations</button>
              <span className="material-symbols-outlined text-[15px] text-[var(--color-botanical-subtle)]">chevron_right</span>
              <span className="hover:text-[var(--color-botanical-primary)] transition-colors cursor-pointer">Security Boundary</span>
              <span className="material-symbols-outlined text-[15px] text-[var(--color-botanical-subtle)]">chevron_right</span>
              <span className="text-[var(--color-accent)] font-medium tracking-wide">Access Restricted</span>
            </nav>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--color-surface-high)] dark:bg-[#37332c] shadow-sm">
              <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse"></span>
              <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">Owner Gate: Enforced</span>
            </div>
          </div>

          {/* Dossier card */}
          <div className="max-w-2xl mx-auto my-4 sm:my-6">
            <div className="relative bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-3xl p-6 sm:p-10 shadow-[0_12px_36px_-6px_rgba(46,36,30,0.06),0_2px_8px_-1px_rgba(46,36,30,0.03)] border border-[var(--color-botanical-border)] dark:border-[#3a3530] text-center transition-all duration-300">
              {/* Shield */}
              <div className="relative mx-auto mb-6 w-20 h-20 rounded-2xl bg-[var(--color-badge-bg)] dark:bg-[#3a241c] flex items-center justify-center shadow-inner">
                <span className="material-symbols-outlined text-[var(--color-accent)] text-[38px]" style={{ fontVariationSettings: "'FILL' 1" }}>shield_lock</span>
                <div className="absolute -bottom-1 -right-1 bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-full p-1 shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                  <span className="material-symbols-outlined text-[var(--color-accent)] text-[16px] block">lock</span>
                </div>
              </div>

              <div className="inline-flex items-center gap-1.5 px-4 py-1 rounded-full bg-[var(--color-badge-bg)] dark:bg-[#3a241c] text-[var(--color-badge-fg-strong)] dark:text-[#ffb9ab] mb-6">
                <span className="material-symbols-outlined text-[14px]">verified_user</span>
                <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.12em]">Owner Gate · Server-Enforced</span>
              </div>

              <h1 className="font-serif text-[28px] leading-9 tracking-[-0.01em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] mb-3">
                Owner Access Required
              </h1>
              <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] leading-relaxed max-w-lg mx-auto mb-8">
                This area is reserved for the account carrying the owner designation. You are signed in as{' '}
                <span className="text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] font-medium">{roleLabel}</span>
                {session?.email ? <> ({session.email})</> : null} — your session stays active, it just does not carry owner clearance.
              </p>

              {/* Dossier diagnostics — every row is real session data */}
              <div className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-2xl p-4 sm:p-6 text-left mb-8 relative overflow-hidden border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                <div className="flex items-center justify-between pb-2 mb-2">
                  <span className="text-[11px] leading-4 font-bold uppercase text-[var(--color-botanical-subtle)] tracking-[0.08em] flex items-center gap-1">
                    <span className="material-symbols-outlined text-[13px]">terminal</span> Dossier Diagnostics
                  </span>
                  <span className="text-[11px] leading-4 font-bold uppercase text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae] bg-[var(--color-success-soft-bg)] px-2 py-0.5 rounded-full font-medium">Session Valid</span>
                </div>
                <div className="space-y-2.5 text-[13px] text-[var(--color-botanical-text)] dark:text-[#f2efe9]">
                  {dossierRow('link', 'Attempted Route', attemptedRoute, 'mono')}
                  {dossierRow('badge', 'Authenticated Identity', session?.name ? `${session.name} (${roleLabel})` : (session?.email || '—'))}
                  {dossierRow('schedule', 'Timestamp', timestamp)}
                  {dossierRow('fingerprint', 'Owner Designation', session?.isOwner ? 'Granted' : 'Not granted')}
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-6">
                <button
                  type="button"
                  onClick={() => navigate('/admin/dashboard')}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] text-white px-8 py-3 text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] transition-all duration-200 shadow-md active:translate-y-[1px]"
                >
                  <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                  <span>Return to Admin Dashboard</span>
                </button>
                <button
                  type="button"
                  onClick={handleRequestElevation}
                  disabled={requesting || requested}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-surface-high)] dark:bg-[#37332c] text-[var(--color-botanical-text)] dark:text-[#f2efe9] px-6 py-3 text-[13px] font-semibold hover:bg-[var(--color-surface-highest)] dark:hover:bg-[#454038] transition-all duration-200 active:translate-y-[1px] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <span className="material-symbols-outlined text-[18px] text-[var(--color-accent)]">vpn_key</span>
                  <span>{requested ? 'Clearance Requested' : requesting ? 'Sending Request…' : 'Request Elevated Clearance'}</span>
                </button>
              </div>

              {/* Real outcome of the elevation request */}
              {notice && (
                <div
                  className={`mb-6 p-3 rounded-xl text-[13px] leading-5 flex items-start gap-2 transition-all duration-300 ${
                    notice.tone === 'error'
                      ? 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] border border-[var(--color-danger-soft-border)]'
                      : notice.tone === 'warn'
                      ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] dark:bg-[#3a241c] dark:text-[#ffb9ab]'
                      : 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae]'
                  }`}
                  role="status"
                >
                  <span className="material-symbols-outlined text-[18px] shrink-0">{notice.tone === 'error' ? 'error' : notice.tone === 'warn' ? 'info' : 'check_circle'}</span>
                  <span>{notice.text}</span>
                </div>
              )}

              <div className="inline-flex items-center gap-2 p-3 rounded-2xl bg-[var(--color-surface-low)] dark:bg-[#26221e] max-w-lg mx-auto">
                <span className="material-symbols-outlined text-[var(--color-success-soft-fg)] dark:text-[#93ab87] text-[18px] shrink-0">check_circle</span>
                <p className="text-[13px] leading-snug text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] text-left">
                  Your staff session remains active and in good standing. No penalties have been applied — this route simply requires owner clearance.
                </p>
              </div>
            </div>
          </div>

          {/* Explain-the-gate cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl mx-auto mt-6">
            <div className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] p-4 rounded-2xl shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] flex items-start gap-2.5">
              <span className="material-symbols-outlined text-[var(--color-accent)] text-[22px] mt-0.5">workspace_premium</span>
              <div>
                <h4 className="text-[14px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">Owner Authority</h4>
                <p className="text-[13px] leading-tight text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-0.5">The owner is an administrator with a server-checked designation — not a separate role.</p>
              </div>
            </div>
            <div className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] p-4 rounded-2xl shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] flex items-start gap-2.5">
              <span className="material-symbols-outlined text-[var(--color-botanical-subtle)] text-[22px] mt-0.5">history_toggle_off</span>
              <div>
                <h4 className="text-[14px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">Permission Persistence</h4>
                <p className="text-[13px] leading-tight text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-0.5">Owner-only actions are re-checked on every request — a session can never grant them by itself.</p>
              </div>
            </div>
            <div className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] p-4 rounded-2xl shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] flex items-start gap-2.5">
              <span className="material-symbols-outlined text-[var(--color-success-soft-fg)] dark:text-[#93ab87] text-[22px] mt-0.5">support_agent</span>
              <div>
                <h4 className="text-[14px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">Need Clearance?</h4>
                <p className="text-[13px] leading-tight text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mt-0.5">Send the request above — the owner is notified directly with the route you tried to open.</p>
              </div>
            </div>
          </div>

          <div className="mt-8 text-center pb-4">
            <p className="text-[11px] leading-4 font-bold text-[var(--color-botanical-subtle)] uppercase tracking-[0.12em]">
              Flora Alchemy Artisan Systems · Staff Operations Console
            </p>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
