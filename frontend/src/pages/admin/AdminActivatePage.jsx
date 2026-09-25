import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import { getInvitation, activateInvitation } from '../../services/invitationService.js';

/**
 * Phase 20.6.2 — Administrator Access Ready / Credential Activation.
 * (design refs: "Administrator Access Ready", "Credential Activation",
 *  "Administrator Initialized")
 *
 * PUBLIC screen — the invitation token IS the credential (256-bit, single-use,
 * 72-hour TTL), so no staff session is required. States are real server
 * states, not toggles:
 *   404 invalid · 410 expired · 403 revoked · 409 already activated · 200 ready
 *
 * On success the invitation is consumed server-side, the account is created
 * with the role carried by the invitation (never a client-supplied role), the
 * page signs the new account in through the SAME POST /api/auth/login path
 * and then shows the "Initialized" modal — Enter Console lands on the Admin
 * Dashboard with a live session.
 */

const MIN_PASSWORD = 6; // repo policy (public register / createOperator)

function initialsOf(name, email) {
  const source = String(name || email || '').trim();
  if (!source) return 'FA';
  const parts = source.includes('@') ? [source.split('@')[0]] : source.split(/\s+/);
  const letters = parts.filter(Boolean).slice(0, 2).map((p) => p[0]);
  return (letters.join('') || 'FA').toUpperCase();
}

function roleLabelOf(role) {
  return role === 'handler' ? 'Handler' : 'Administrator';
}

function formatCountdown(ms) {
  if (ms <= 0) return 'Expired';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m remaining`;
  return `${hours}h ${minutes}m remaining`;
}

export default function AdminActivatePage() {
  const { token: routeToken } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useAdminSession();
  const token = routeToken || searchParams.get('token') || '';

  const [phase, setPhase] = useState('loading'); // loading|ready|invalid|expired|revoked|used|error
  const [invitation, setInvitation] = useState(null);
  const [phaseMessage, setPhaseMessage] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // Form state
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Success state
  const [account, setAccount] = useState(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  // ── Load the invitation (its real state drives the screen) ──
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setPhase('invalid');
      setPhaseMessage('This activation link is missing its invitation token.');
      return undefined;
    }
    (async () => {
      try {
        const res = await getInvitation(token);
        if (cancelled) return;
        if (res.ok) {
          setInvitation(res.invitation);
          setPhase('ready');
        } else {
          setInvitation(res.invitation || null);
          setPhaseMessage(res.message || '');
          setPhase(
            res.status === 404 ? 'invalid'
              : res.status === 410 ? 'expired'
              : res.status === 403 ? 'revoked'
              : res.status === 409 ? 'used'
              : 'error'
          );
        }
      } catch {
        if (!cancelled) {
          setPhase('error');
          setPhaseMessage('We could not reach the studio server. Please try again.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Tick for the expiry countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  const expiresAt = invitation?.expiresAt ? new Date(invitation.expiresAt).getTime() : null;
  const remainingMs = expiresAt ? expiresAt - now : 0;

  // The invitation may expire while the page is open — flip to the real state.
  useEffect(() => {
    if (phase === 'ready' && expiresAt && remainingMs <= 0) {
      setPhase('expired');
      setPhaseMessage('This invitation expired while the page was open. Ask the owner to issue a new one.');
    }
  }, [phase, expiresAt, remainingMs]);

  // ── Password architecture (advisory strength + repo minimum gate) ──
  const checks = useMemo(() => ([
    { label: 'At least 12 characters (recommended)', ok: password.length >= 12 },
    { label: 'Upper & lowercase letters', ok: /[a-z]/.test(password) && /[A-Z]/.test(password) },
    { label: 'At least one number', ok: /\d/.test(password) },
    { label: 'At least one symbol (#, $, @, %)', ok: /[^A-Za-z0-9]/.test(password) },
  ]), [password]);
  const score = checks.filter((c) => c.ok).length;
  const strength = [
    { label: 'Very weak (0/4)', tone: 'danger' },
    { label: 'Weak (1/4)', tone: 'danger' },
    { label: 'Fair (2/4)', tone: 'accent' },
    { label: 'Good (3/4)', tone: 'success' },
    { label: 'Strong (4/4)', tone: 'success' },
  ][score];
  const strengthColor = strength.tone === 'success'
    ? 'text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae]'
    : strength.tone === 'accent'
    ? 'text-[var(--color-accent)]'
    : 'text-[var(--color-danger)]';
  const barColor = strength.tone === 'success'
    ? 'bg-[var(--color-botanical-sage)]'
    : strength.tone === 'accent'
    ? 'bg-[var(--color-accent)]'
    : 'bg-[var(--color-danger)]';

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = phase === 'ready' && !submitting
    && password.length >= MIN_PASSWORD
    && password === confirm
    && acceptedTerms;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setFormError('');
    try {
      const res = await activateInvitation(token, password);
      if (res.ok) {
        setAccount(res.account);
        // Establish the session through the SAME login path (activation →
        // login → dashboard), so Enter Console lands on a live session.
        let signedIn = false;
        try {
          const loginResult = await login(res.account.email, password);
          signedIn = !!loginResult?.success;
        } catch { /* fall through — Enter Console routes to sign-in */ }
        setSessionReady(signedIn);
        // The password has served its purpose; drop it from component state.
        setPassword('');
        setConfirm('');
        setShowSuccess(true);
      } else if (res.status === 410) {
        setPhase('expired');
        setPhaseMessage(res.message || '');
      } else if (res.status === 409) {
        setPhase('used');
        setPhaseMessage(res.message || '');
      } else if (res.status === 404) {
        setPhase('invalid');
        setPhaseMessage(res.message || '');
      } else if (res.status === 403) {
        setPhase('revoked');
        setPhaseMessage(res.message || '');
      } else {
        setFormError(res.message || 'Activation failed. Please try again.');
      }
    } catch {
      setFormError('We could not reach the studio server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const navigateToConsole = () => {
    navigate(sessionReady ? '/admin/dashboard' : '/admin/login');
  };

  const recipientName = invitation?.applicantName
    || (invitation?.recipientEmail ? invitation.recipientEmail.split('@')[0] : '');
  const roleLabel = roleLabelOf(invitation?.role);
  const avatarInitials = initialsOf(invitation?.applicantName, invitation?.recipientEmail);

  // ── Non-ready phases share one honest presentation ──
  const phaseCard = (icon, tone, title, message, extra = null) => (
    <div className="max-w-2xl mx-auto my-8">
      <div className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-3xl p-8 sm:p-12 border border-[var(--color-botanical-border)] dark:border-[#3a3530] shadow-lg text-center space-y-5">
        <div className={`w-16 h-16 rounded-2xl mx-auto flex items-center justify-center ${
          tone === 'danger'
            ? 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)]'
            : 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] dark:bg-[#3a241c] dark:text-[#ffb9ab]'
        }`}>
          <span className="material-symbols-outlined text-[34px]" style={{ fontVariationSettings: "'FILL' 1" }}>{icon}</span>
        </div>
        <h1 className="font-serif text-[28px] leading-9 tracking-[-0.01em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">{title}</h1>
        <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] max-w-md mx-auto">{message}</p>
        {extra}
        <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            to="/admin/login"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] text-white px-7 py-3 text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] transition-all shadow-md"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            <span>Return to Staff Sign In</span>
          </Link>
          <Link
            to="/"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-surface-high)] dark:bg-[#37332c] text-[var(--color-botanical-text)] dark:text-[#f2efe9] px-6 py-3 text-[13px] font-semibold hover:bg-[var(--color-surface-highest)] transition-all"
          >
            <span>Visit the storefront</span>
          </Link>
        </div>
      </div>
    </div>
  );

  return (
    <main className="min-h-screen w-full bg-[var(--color-surface-bg)] text-[var(--color-botanical-text)] flex items-start justify-center p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col w-full max-w-[80rem] mx-auto py-4 md:py-8">

        {/* Ambient botanical depth */}
        <div className="relative w-full">
          <div className="absolute -top-12 -left-12 w-96 h-96 rounded-full bg-[var(--color-badge-bg)]/10 blur-3xl pointer-events-none -z-10"></div>
          <div className="absolute top-1/3 -right-16 w-80 h-80 rounded-full bg-[var(--color-botanical-sage-light)]/30 blur-3xl pointer-events-none -z-10"></div>

          {/* Top bar */}
          <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-12 pb-4 border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-[#2e241e] text-[#f1dfd5] flex items-center justify-center font-serif text-[22px] italic leading-none">fa</div>
              <Link to="/" className="text-[18px] leading-[26px] font-semibold tracking-tight text-[var(--color-botanical-text)] dark:text-[#f2efe9]">Flora Alchemy</Link>
              <span className="text-[var(--color-botanical-subtle)] text-[13px]">/</span>
              <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">Staff Provisioning</span>
            </div>
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
              <span className="w-2 h-2 rounded-full bg-[var(--color-botanical-sage)] animate-pulse"></span>
              <span className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">Invitation Token Active</span>
              <span className="text-[var(--color-botanical-subtle)]">•</span>
              <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em]">SHA-256 · Single-use</span>
            </div>
          </header>

          {phase === 'loading' && (
            <div className="max-w-2xl mx-auto my-16 text-center space-y-4" role="status" aria-live="polite">
              <span className="inline-block w-6 h-6 border-2 border-[var(--color-botanical-subtle)]/30 border-t-[var(--color-botanical-subtle)] rounded-full animate-spin" aria-hidden="true"></span>
              <p className="text-[15px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">Verifying your invitation…</p>
            </div>
          )}

          {phase === 'invalid' && phaseCard('link_off', 'danger', 'Invitation Not Found',
            phaseMessage || 'This invitation link is not valid. Ask the owner to issue a new invitation.')}

          {phase === 'expired' && phaseCard('history_toggle_off', 'danger', 'Invitation Expired',
            phaseMessage || 'This invitation has passed its 72-hour validity window. Ask the owner to issue a new one.',
            invitation?.recipientEmail ? (
              <p className="text-[13px] text-[var(--color-botanical-subtle)]">Issued for {invitation.recipientEmail}</p>
            ) : null)}

          {phase === 'revoked' && phaseCard('block', 'danger', 'Invitation Revoked',
            phaseMessage || 'This invitation has been revoked. Contact the owner for guidance.')}

          {phase === 'used' && phaseCard('task_alt', 'success', 'Invitation Already Activated',
            phaseMessage || 'This invitation has already been used to create an account.',
            <p className="text-[13px] text-[var(--color-botanical-subtle)]">Sign in with the password you created during activation.</p>)}

          {phase === 'error' && phaseCard('cloud_off', 'danger', 'Something Went Wrong',
            phaseMessage || 'We could not load this invitation. Please try again in a moment.')}

          {phase === 'ready' && (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

                {/* ── Left: dossier + activation form ── */}
                <section className="lg:col-span-7 flex flex-col space-y-8 min-w-0">
                  <div className="space-y-3">
                    <div className="inline-flex items-center gap-2 bg-[var(--color-surface-high)] dark:bg-[#37332c] px-3.5 py-1 rounded-full shadow-sm">
                      <span className="material-symbols-outlined text-[var(--color-accent)] text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>lock_open_right</span>
                      <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.1em] text-[var(--color-accent)]">
                        Security Protocol · 72-Hour Single-Use Token{invitation?.applicationId ? ` · ${invitation.applicationId}` : ''}
                      </span>
                    </div>
                    <h1 className="font-serif text-[40px] leading-[48px] tracking-[-0.015em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                      Your {roleLabel} Access Is Ready
                    </h1>
                    <p className="text-[18px] leading-7 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] max-w-xl">
                      You have been credentialed through the owner review process to steward the Flora Alchemy management console. Set a password to finish activation.
                    </p>
                  </div>

                  {/* Dossier card */}
                  <div className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-2xl p-6 md:p-8 shadow-sm relative overflow-hidden border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                    <div className="absolute top-0 right-0 translate-x-4 -translate-y-4 opacity-5 pointer-events-none select-none">
                      <span className="material-symbols-outlined text-[140px] text-[var(--color-botanical-primary)]">local_florist</span>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                      <div className="flex items-center gap-4">
                        <div className="relative">
                          <div className="w-14 h-14 rounded-full bg-[#2e241e] text-[#f1dfd5] flex items-center justify-center font-serif text-[22px] shadow-inner">{avatarInitials}</div>
                          <span className="absolute bottom-0 right-0 w-4 h-4 rounded-full bg-[var(--color-success-soft-bg)] border-2 border-[var(--color-surface-low)] dark:border-[#26221e] flex items-center justify-center" title="Identity confirmed">
                            <span className="material-symbols-outlined text-[10px] text-[var(--color-success-soft-fg)]">verified</span>
                          </span>
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">{recipientName || 'Applicant'}</span>
                            <span className="inline-flex items-center gap-0.5 text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae] bg-[var(--color-success-soft-bg)] px-2 py-0.5 rounded-full text-[11px] leading-4 font-bold uppercase tracking-[0.06em]">
                              <span className="material-symbols-outlined text-[12px]">verified_user</span> Owner Approved
                            </span>
                          </div>
                          <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] truncate">{invitation.recipientEmail}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-start sm:self-auto bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] px-3 py-1.5 rounded-full shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                        <span className="material-symbols-outlined text-[var(--color-accent)] text-[16px]">hourglass_top</span>
                        <div className="flex flex-col leading-none">
                          <span className="text-[10px] text-[var(--color-botanical-subtle)] uppercase tracking-wider">Link Expiry</span>
                          <span className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">{formatCountdown(remainingMs)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4">
                      <div>
                        <span className="text-[11px] leading-4 font-bold uppercase text-[var(--color-botanical-subtle)] block mb-1">Designated Role</span>
                        <span className="inline-flex items-center bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae] px-2.5 py-1 rounded-full text-[13px] leading-[18px] font-semibold">{roleLabel}</span>
                      </div>
                      <div>
                        <span className="text-[11px] leading-4 font-bold uppercase text-[var(--color-botanical-subtle)] block mb-1">Reference</span>
                        <span className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] block">{invitation.applicationId || '—'}</span>
                      </div>
                      <div>
                        <span className="text-[11px] leading-4 font-bold uppercase text-[var(--color-botanical-subtle)] block mb-1">Status</span>
                        <span className="inline-flex items-center gap-1 bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] dark:bg-[#3a241c] dark:text-[#ffb9ab] px-2.5 py-1 rounded-full text-[13px] leading-[18px] font-semibold">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]"></span> Ready
                        </span>
                      </div>
                      <div>
                        <span className="text-[11px] leading-4 font-bold uppercase text-[var(--color-botanical-subtle)] block mb-1">Valid Until</span>
                        <span className="text-[13px] leading-[18px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] block">
                          {expiresAt ? new Date(expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Activation form */}
                  <div className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl p-6 md:p-8 shadow-md border border-[var(--color-botanical-border)] dark:border-[#3a3530] space-y-6">
                    <div className="space-y-1">
                      <h2 className="font-serif text-[28px] leading-9 tracking-[-0.01em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">Create your management credentials</h2>
                      <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                        This password is the only credential for the console — it is hashed and never stored or shown again.
                      </p>
                    </div>

                    {formError && (
                      <div className="flex items-start gap-2 p-3.5 rounded-xl bg-[var(--color-danger-soft-bg)] border border-[var(--color-danger-soft-border)] text-[var(--color-danger-soft-fg)] text-[13px] leading-5" role="alert">
                        <span className="material-symbols-outlined text-[18px] shrink-0 mt-px">error</span>
                        <span>{formError}</span>
                      </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-5">
                      {/* Locked identity */}
                      <div className="space-y-1.5">
                        <label className="block text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">Designated Account</label>
                        <div className="relative flex items-center">
                          <span className="material-symbols-outlined absolute left-4 text-[var(--color-botanical-subtle)] text-[18px]">alternate_email</span>
                          <input
                            type="email"
                            value={invitation.recipientEmail}
                            readOnly
                            tabIndex={-1}
                            className="w-full bg-[var(--color-surface-low)] dark:bg-[#26221e] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] text-[15px] pl-11 pr-11 py-3 rounded-full outline-none cursor-not-allowed select-none border border-[var(--color-botanical-border)] dark:border-[#3a3530]"
                          />
                          <span className="material-symbols-outlined absolute right-4 text-[var(--color-botanical-subtle)] text-[16px]" title="Locked to the invitation">lock</span>
                        </div>
                      </div>

                      {/* Password */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <label htmlFor="activation-password" className="block text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">Master Passphrase</label>
                          <span className={`text-[11px] leading-4 font-bold uppercase tracking-[0.08em] ${password ? strengthColor : 'text-[var(--color-botanical-subtle)]'}`}>
                            {password ? strength.label : `Minimum ${MIN_PASSWORD} characters`}
                          </span>
                        </div>
                        <div className="relative flex items-center">
                          <span className="material-symbols-outlined absolute left-4 text-[var(--color-botanical-subtle)] text-[18px]">key</span>
                          <input
                            id="activation-password"
                            type={showPassword ? 'text' : 'password'}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="new-password"
                            className="w-full bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[var(--color-botanical-text)] dark:text-[#f0ede9] text-[15px] pl-11 pr-11 py-3 rounded-full shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-all"
                          />
                          <button
                            type="button"
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                            onClick={() => setShowPassword((v) => !v)}
                            className="absolute right-4 text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] dark:hover:text-[#f7f4ef] transition-colors"
                          >
                            <span className="material-symbols-outlined text-[18px]">{showPassword ? 'visibility_off' : 'visibility'}</span>
                          </button>
                        </div>
                        <div className="grid grid-cols-4 gap-1.5 pt-1.5" aria-hidden="true">
                          {[0, 1, 2, 3].map((i) => (
                            <div key={i} className={`h-1.5 rounded-full transition-all ${password && i < score ? barColor : 'bg-[var(--color-surface-high)] dark:bg-[#37332c]'}`}></div>
                          ))}
                        </div>
                        {tooShort && (
                          <p className="text-[12px] text-[var(--color-danger)] pt-0.5">Use at least {MIN_PASSWORD} characters.</p>
                        )}
                      </div>

                      {/* Confirm */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <label htmlFor="activation-confirm" className="block text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">Confirm Master Passphrase</label>
                          {confirm.length > 0 && !mismatch && (
                            <span className="flex items-center gap-1 text-[11px] leading-4 font-bold uppercase tracking-[0.06em] text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae]">
                              <span className="material-symbols-outlined text-[13px]">check_circle</span> Passphrases match
                            </span>
                          )}
                          {mismatch && (
                            <span className="flex items-center gap-1 text-[11px] leading-4 font-bold uppercase tracking-[0.06em] text-[var(--color-danger)]">
                              <span className="material-symbols-outlined text-[13px]">cancel</span> Do not match
                            </span>
                          )}
                        </div>
                        <div className="relative flex items-center">
                          <span className="material-symbols-outlined absolute left-4 text-[var(--color-botanical-subtle)] text-[18px]">lock_reset</span>
                          <input
                            id="activation-confirm"
                            type={showConfirm ? 'text' : 'password'}
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                            autoComplete="new-password"
                            className="w-full bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[var(--color-botanical-text)] dark:text-[#f0ede9] text-[15px] pl-11 pr-11 py-3 rounded-full shadow-sm border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-all"
                          />
                          <button
                            type="button"
                            aria-label={showConfirm ? 'Hide confirm password' : 'Show confirm password'}
                            onClick={() => setShowConfirm((v) => !v)}
                            className="absolute right-4 text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] dark:hover:text-[#f7f4ef] transition-colors"
                          >
                            <span className="material-symbols-outlined text-[18px]">{showConfirm ? 'visibility_off' : 'visibility'}</span>
                          </button>
                        </div>
                      </div>

                      {/* Passphrase architecture checklist */}
                      <div className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-xl p-4 space-y-2 border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                        <span className="text-[11px] leading-4 font-bold text-[var(--color-botanical-subtle)] uppercase tracking-[0.08em] block">Passphrase Architecture</span>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {checks.map((c) => (
                            <div key={c.label} className="flex items-center gap-2">
                              <span className={`material-symbols-outlined text-[16px] ${c.ok ? 'text-[var(--color-success-soft-fg)] dark:text-[#93ab87]' : 'text-[var(--color-botanical-subtle)]'}`}>
                                {c.ok ? 'check_circle' : 'radio_button_unchecked'}
                              </span>
                              <span className="text-[13px] leading-5 text-[var(--color-botanical-text)] dark:text-[#f2efe9]">{c.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Terms */}
                      <div className="flex items-start gap-3 pt-1">
                        <input
                          id="governance-terms"
                          type="checkbox"
                          checked={acceptedTerms}
                          onChange={(e) => setAcceptedTerms(e.target.checked)}
                          className="mt-0.5 w-5 h-5 rounded-md accent-[var(--color-btn)] cursor-pointer"
                        />
                        <label htmlFor="governance-terms" className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] cursor-pointer select-none">
                          I accept the Flora Alchemy staff governance terms and understand that my account is created with the role shown above.
                        </label>
                      </div>

                      <div className="pt-2">
                        <button
                          type="submit"
                          disabled={!canSubmit}
                          className="w-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] disabled:opacity-50 disabled:cursor-not-allowed text-white py-3.5 px-8 rounded-full text-[13px] leading-[18px] font-semibold transition-all shadow-md flex items-center justify-center gap-2 group"
                        >
                          <span>{submitting ? 'Activating Account…' : `Activate ${roleLabel} Account`}</span>
                          {!submitting && <span className="material-symbols-outlined text-[18px] group-hover:translate-x-1 transition-transform">arrow_forward</span>}
                        </button>
                        <div className="flex items-center justify-between text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] pt-3">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-[16px]">support_agent</span>
                            <span className="text-[13px] leading-5">Need help? Contact the owner who issued this invitation.</span>
                          </span>
                          <span className="text-[11px] leading-4 font-bold text-[var(--color-botanical-subtle)] uppercase tracking-[0.08em]">Single-use</span>
                        </div>
                      </div>
                    </form>
                  </div>
                </section>

                {/* ── Right: assurance aside ── */}
                <aside className="lg:col-span-5 flex flex-col space-y-6 min-w-0">
                  <div className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl p-4 shadow-sm space-y-3 border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                    <div className="relative w-full h-48 rounded-xl overflow-hidden bg-[var(--color-surface-container)] dark:bg-[#2e2a25]">
                      <img
                        className="w-full h-full object-cover"
                        alt="Flora Alchemy handcrafted floral arrangement from the atelier archive"
                        src="/assets/images/flora-asset-25.jpg"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[#180f0a]/70 via-[#180f0a]/10 to-transparent"></div>
                      <div className="absolute bottom-3 left-4 right-4 flex items-center justify-between text-white">
                        <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em]">Atelier Archive</span>
                        <span className="text-[13px] leading-[18px] font-semibold opacity-90">Handcrafted to order</span>
                      </div>
                    </div>
                    <div className="px-1 py-1">
                      <p className="font-serif text-[22px] leading-8 text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] mb-1">What activation does</p>
                      <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                        Activating consumes this invitation once, creates your {roleLabel.toLowerCase()} account with the role shown on the dossier, and signs you into the operations console.
                      </p>
                    </div>
                  </div>

                  <div className="bg-[var(--color-surface-container)] dark:bg-[#2e2a25] rounded-2xl p-6 shadow-sm space-y-4 border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                    <div className="flex items-center gap-2 text-[var(--color-accent)]">
                      <span className="material-symbols-outlined text-[22px]">shield</span>
                      <span className="text-[18px] leading-[26px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">Token integrity</span>
                    </div>
                    <ul className="space-y-2.5 text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                      <li className="flex items-start gap-2">
                        <span className="material-symbols-outlined text-[16px] text-[var(--color-success-soft-fg)] dark:text-[#93ab87] mt-0.5">check_circle</span>
                        <span>Only a SHA-256 hash of the link’s token is stored — a copy of the database cannot replay it.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="material-symbols-outlined text-[16px] text-[var(--color-success-soft-fg)] dark:text-[#93ab87] mt-0.5">check_circle</span>
                        <span>Single-use: the first successful activation flips the invitation atomically, so simultaneous attempts cannot both succeed.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="material-symbols-outlined text-[16px] text-[var(--color-success-soft-fg)] dark:text-[#93ab87] mt-0.5">check_circle</span>
                        <span>72-hour validity, re-checked on every attempt — including the one that creates the account.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="material-symbols-outlined text-[16px] text-[var(--color-success-soft-fg)] dark:text-[#93ab87] mt-0.5">check_circle</span>
                        <span>Your password is hashed with bcrypt and never stored, logged, or shown again.</span>
                      </li>
                    </ul>
                  </div>

                  <div className="flex items-center gap-3 px-2 text-[var(--color-botanical-subtle)]">
                    <span className="material-symbols-outlined text-[22px]">encrypted</span>
                    <span className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                      One-time token · 72-hour validity · server-side enforcement
                    </span>
                  </div>
                </aside>
              </div>
            </>
          )}

          <div className="mt-12 text-center pb-4">
            <p className="text-[11px] leading-4 font-bold text-[var(--color-botanical-subtle)] uppercase tracking-[0.12em]">
              Flora Alchemy Artisan Systems · Staff Provisioning
            </p>
          </div>
        </div>
      </div>

      {/* ── Success modal: Administrator Initialized ── */}
      {showSuccess && account && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#180f0a]/50 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="activation-success-title">
          <div className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] max-w-lg w-full rounded-2xl p-8 shadow-2xl space-y-6 border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
            <div className="w-16 h-16 rounded-full bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae] flex items-center justify-center mx-auto shadow-sm">
              <span className="material-symbols-outlined text-[32px]" style={{ fontVariationSettings: "'FILL' 1" }}>verified</span>
            </div>
            <div className="text-center space-y-2">
              <span className="text-[11px] leading-4 font-bold text-[var(--color-accent)] uppercase tracking-[0.12em] block">Activation Complete</span>
              <h2 id="activation-success-title" className="font-serif text-[40px] leading-[48px] tracking-[-0.015em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                {roleLabelOf(account.role)} Initialized
              </h2>
              <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] max-w-sm mx-auto">
                Welcome, {(account.name || '').split(/\s+/)[0] || 'there'}. Your management credentials are now bound to Flora Alchemy.
              </p>
            </div>
            <div className="bg-[var(--color-surface-low)] dark:bg-[#26221e] rounded-xl p-4 space-y-2 text-[13px] text-left border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
              <div className="flex justify-between gap-4">
                <span className="text-[var(--color-botanical-subtle)]">Staff Identity:</span>
                <span className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9] text-right">{account.name} ({account.email})</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[var(--color-botanical-subtle)]">Console Access:</span>
                <span className="text-[13px] leading-[18px] font-semibold text-[var(--color-success-soft-fg)] dark:text-[#b9d8ae]">{roleLabelOf(account.role)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[var(--color-botanical-subtle)]">Invitation:</span>
                <span className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]">Consumed · single-use</span>
              </div>
            </div>
            <div className="space-y-2">
              <button
                type="button"
                onClick={navigateToConsole}
                className="w-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] text-white py-3.5 px-6 rounded-full text-[13px] leading-[18px] font-semibold transition-all shadow-md"
              >
                Enter Flora Alchemy Atelier Console
              </button>
              <button
                type="button"
                onClick={() => navigate('/admin/login')}
                className="w-full text-center py-2 text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] hover:text-[var(--color-botanical-primary)] dark:hover:text-[#f7f4ef] transition-colors"
              >
                Return to Staff Sign In
              </button>
              {!sessionReady && (
                <p className="text-[12px] text-[var(--color-botanical-subtle)] text-center">
                  Your session could not be started automatically — sign in with your new password.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
