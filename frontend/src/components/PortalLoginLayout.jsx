import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAdminSession } from '../context/AdminSessionContext.jsx';
import { homePathForPortal, portalForSession, PORTAL_META } from '../services/authService.js';
import LoginLoading from './admin/LoginLoading.jsx';

/**
 * Phase 21.1 — the shared login surface behind every staff portal
 * (/owner/login, /admin/login, /staff/login).
 *
 * The three portals are DISTINCT routes with distinct copy and identity, not
 * one generic page with a role selector: the portal is fixed by the URL the
 * visitor chose, never by a dropdown, and the server refuses an identity that
 * does not belong to that portal. This component only carries the presentation
 * (design ref: Owner / Administrator / Staff Sign In) — behaviour is identical
 * everywhere: one POST /api/auth/login, server-resolved role, duplicate-submit
 * guard, in-flight loading, code-aware error copy, DEV-only credential helper.
 *
 * PORTAL CONTEXT (the login URL must match the account's portal): the server
 * resolves which portal an identity BELONGS to (role + isOwner) and returns it
 * on the session; this page may only enter the portal the visitor is standing
 * on when that is where the identity belongs. Signing in through another
 * portal's URL never enters that portal's shell — the identity is told which
 * portal its account belongs to and handed over to it. The mismatch is a
 * ROUTING outcome, never an authorization change: the session is untouched and
 * every capability is still authorized per request by the backend.
 */

/** How long the portal-mismatch explanation stays up before the hand-over. */
const MISMATCH_REDIRECT_MS = 2200;

/** Turn a server refusal code into honest, portal-aware copy. */
function errorMessage(result, portal) {
  const meta = PORTAL_META[portal] || PORTAL_META.admin;
  switch (result?.code) {
    case 'PORTAL_FORBIDDEN':
      return portal === 'owner'
        ? 'These credentials are valid, but this account is not the business owner. Use the Administrator or Staff portal.'
        : portal === 'staff'
          ? 'This account is not a handler account. Use your Administrator or Owner portal.'
          : 'This account does not have administrator access. Use the portal that matches your role.';
    case 'ACCOUNT_SUSPENDED':
      return 'This account has been suspended. Contact an administrator to restore access.';
    case 'INVALID_CREDENTIALS':
      return 'The email or password entered is incorrect.';
    case 'RATE_LIMITED':
      return 'Too many sign-in attempts. Please wait a few minutes and try again.';
    case 'NETWORK_ERROR':
      return 'Unable to reach the Flora Alchemy server. Please check your connection and try again.';
    case 'VALIDATION_ERROR':
      return 'Please enter both your email address and password.';
    default:
      return result?.error || `Unable to sign in to the ${meta.label}.`;
  }
}

export default function PortalLoginLayout({
  portal,
  eyebrow,
  title,
  subtitle,
  badge,
  leftHeadline,
  leftBody,
  doctrine,
  icon = 'spa',
}) {
  const navigate = useNavigate();
  const { login } = useAdminSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mismatch, setMismatch] = useState(null);
  const authInFlightRef = useRef(false);
  const redirectTimerRef = useRef(null);

  // A pending hand-over must not navigate after the visitor has left.
  useEffect(() => () => {
    if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (authInFlightRef.current) return;
    authInFlightRef.current = true;
    setError('');
    setErrorCode(null);
    setLoading(true);

    let result;
    try {
      result = await login(email, password, portal);
    } finally {
      setLoading(false);
      authInFlightRef.current = false;
    }

    if (result.success) {
      // The server supplies both: which portal this identity belongs to, and
      // where that portal lives. Never second-guess it from the login URL.
      const landed = portalForSession(result.session);
      const target = result.redirectTo || homePathForPortal(landed || portal);
      if (landed && landed !== portal) {
        setMismatch({ landed, target });
        redirectTimerRef.current = setTimeout(() => {
          navigate(target, { replace: true });
        }, MISMATCH_REDIRECT_MS);
        return;
      }
      navigate(target);
    } else {
      setErrorCode(result.code || null);
      setError(errorMessage(result, portal));
    }
  };

  if (loading) {
    return <LoginLoading />;
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 sm:p-6 lg:p-8 bg-[var(--color-surface-bg)]">
      <div className="w-full max-w-[80rem] mx-auto py-4 md:py-8">
        <div className="w-full grid grid-cols-1 lg:grid-cols-2 rounded-3xl overflow-hidden shadow-xl bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
          {/* ── Left: atelier scenography ─────────────────────────────── */}
          <div className="relative min-h-[320px] lg:min-h-full flex flex-col justify-between p-8 md:p-12 overflow-hidden bg-[#2e241e] text-[#f6f3ee]">
            <div className="absolute inset-0 z-0">
              <img
                alt="Flora Alchemy atelier worktable with handcrafted botanical arrangements"
                className="w-full h-full object-cover object-center filter saturate-[0.85] contrast-[1.05] brightness-[0.7]"
                src="/assets/images/flora-asset-13.jpg"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#2e241e] via-[#2e241e]/70 to-[#2e241e]/40"></div>
              <div className="absolute inset-0 bg-gradient-to-r from-[#2e241e]/70 via-transparent to-[#2e241e]/40"></div>
            </div>

            <div className="relative z-10 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <Link to="/access" className="flex items-center gap-3 group">
                <div className="w-10 h-10 shrink-0 bg-white/10 shadow-sm">
                  <img
                    src="/branding/flora-alchemy-logo.jpg"
                    alt=""
                    className="h-full w-full object-contain"
                    loading="eager"
                    decoding="async"
                  />
                </div>
                <div className="flex flex-col">
                  <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[#d4c3ba]">Flora Alchemy</span>
                  <span className="text-[13px] leading-5 text-[#e5e2dd]/90">Atelier Operations</span>
                </div>
              </Link>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md text-[#f1dfd5] text-[11px] font-bold uppercase tracking-[0.08em]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#fd9882] animate-pulse"></span>
                {badge}
              </span>
            </div>

            <div className="relative z-10 flex flex-col gap-6 mt-auto pt-12">
              <div className="space-y-3 max-w-lg">
                <div className="inline-flex items-center gap-2 text-[#d4c3ba] text-[11px] font-bold uppercase tracking-[0.08em]">
                  <span className="material-symbols-outlined text-[14px]">verified_user</span>
                  <span>{eyebrow}</span>
                </div>
                <h2 className="font-serif text-[34px] lg:text-[44px] leading-[1.1] tracking-[-0.02em] text-white">
                  {leftHeadline}
                </h2>
                <p className="text-[15px] leading-6 text-[#e5e2dd]/85 max-w-md">{leftBody}</p>
              </div>

              <div className="p-5 rounded-2xl bg-white/10 backdrop-blur-md shadow-sm">
                <div className="flex items-start gap-3.5">
                  <span className="material-symbols-outlined text-[#fd9882] mt-0.5 text-xl">shield_lock</span>
                  <p className="text-[13px] leading-5 text-[#e5e2dd]/90 tracking-tight">{doctrine}</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-3 text-[#e5e2dd]/80 text-[13px]">
                <span>Flora Alchemy Studio Operations</span>
                <span>Secured over HTTPS</span>
              </div>
            </div>
          </div>

          {/* ── Right: authentication core ────────────────────────────── */}
          <div className="lg:col-span-1 flex flex-col justify-between p-8 sm:p-12 lg:p-16 bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18]">
            <div className="flex flex-wrap items-center justify-between w-full gap-x-4 gap-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[var(--color-accent)]"></span>
                <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]">
                  Internal Core Operations
                </span>
              </div>
              <Link
                to="/access"
                className="group inline-flex items-center py-1 gap-1.5 text-[13px] leading-[18px] font-semibold text-[var(--color-accent)] hover:text-[var(--color-btn-hover)] transition-colors"
              >
                <span>All Portals</span>
                <span className="material-symbols-outlined text-[14px] transition-transform group-hover:translate-x-0.5">arrow_forward</span>
              </Link>
            </div>

            <div className="my-auto py-8 max-w-md w-full mx-auto">
              <div className="space-y-2 mb-8">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[var(--color-surface-low)] dark:bg-[#26221e] text-[var(--color-botanical-primary)] dark:text-[#ffdad3] mb-2 shadow-sm">
                  <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>{icon}</span>
                </div>
                <h1 className="font-serif text-[40px] leading-[48px] tracking-[-0.015em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                  {title}
                </h1>
                <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">{subtitle}</p>
              </div>

              {/* Portal context mismatch — the credentials were accepted, but
                  this identity works in another portal. Say exactly which one
                  and hand over; never render this portal's shell for it. */}
              {mismatch && (
                <div
                  id="portal-login-mismatch"
                  data-login-state="mismatch"
                  className="mb-5 flex flex-col gap-3 p-4 rounded-xl bg-[var(--color-surface-low)] dark:bg-[#26221e] border border-[var(--color-botanical-border)] dark:border-[#3a3530] text-[var(--color-botanical-text)] dark:text-[#f2efe9]"
                  role="status"
                >
                  <div className="flex items-start gap-2 text-[13px] leading-5">
                    <span className="material-symbols-outlined text-[18px] shrink-0 mt-px text-[var(--color-accent)]">swap_horiz</span>
                    <span>
                      <strong className="font-semibold">
                        This account belongs to the {(PORTAL_META[mismatch.landed] || PORTAL_META.admin).label}.
                      </strong>{' '}
                      You are signed in — taking you to your portal now.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate(mismatch.target, { replace: true })}
                    className="self-start inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] text-white text-[13px] font-semibold transition-colors"
                  >
                    <span>Go to the {(PORTAL_META[mismatch.landed] || PORTAL_META.admin).label}</span>
                    <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                  </button>
                </div>
              )}

              {error && (
                <div
                  id="portal-login-error"
                  data-login-state="error"
                  className="mb-5 flex flex-col gap-2 p-3.5 rounded-xl bg-[var(--color-danger-soft-bg)] border border-[var(--color-danger-soft-border)] text-[var(--color-danger-soft-fg)] text-[13px] leading-5"
                  role="alert"
                >
                  <div className="flex items-start gap-2">
                    <span className="material-symbols-outlined text-[18px] shrink-0 mt-px">error</span>
                    <span>{error}</span>
                  </div>
                  {errorCode === 'PORTAL_FORBIDDEN' && (
                    <Link
                      to="/access"
                      className="self-start inline-flex items-center py-0.5 gap-1.5 font-semibold underline underline-offset-2"
                    >
                      <span>Choose your portal</span>
                      <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                    </Link>
                  )}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-1.5">
                  <label className="block text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]" htmlFor="portal-email">
                    Work Email Address
                  </label>
                  <div className="relative flex items-center">
                    <span className="material-symbols-outlined absolute left-4 text-[var(--color-botanical-subtle)] text-[18px] pointer-events-none">mail</span>
                    <input
                      id="portal-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@flora-alchemy.example"
                      required
                      aria-invalid={!!error}
                      aria-describedby={error ? 'portal-login-error' : undefined}
                      className="w-full pl-11 pr-4 py-3 bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[var(--color-botanical-text)] dark:text-[#f0ede9] text-[15px] rounded-full shadow-sm placeholder:text-[var(--color-botanical-subtle)] border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] dark:focus:bg-[#1e1b18] transition-all"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]" htmlFor="portal-password">
                    Password
                  </label>
                  <div className="relative flex items-center">
                    <span className="material-symbols-outlined absolute left-4 text-[var(--color-botanical-subtle)] text-[18px] pointer-events-none">lock</span>
                    <input
                      id="portal-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      required
                      aria-invalid={!!error}
                      aria-describedby={error ? 'portal-login-error' : undefined}
                      className="w-full pl-11 pr-12 py-3 bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[var(--color-botanical-text)] dark:text-[#f0ede9] text-[15px] rounded-full shadow-sm placeholder:text-[var(--color-botanical-subtle)] border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] dark:focus:bg-[#1e1b18] transition-all"
                    />
                    <button
                      type="button"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-4 min-h-[44px] min-w-[44px] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-text)] dark:hover:text-[#f0ede9] transition-colors flex items-center justify-center"
                    >
                      <span className="material-symbols-outlined text-[18px]">{showPassword ? 'visibility_off' : 'visibility'}</span>
                    </button>
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={!!mismatch}
                    className="group w-full py-3.5 px-6 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] text-white text-[15px] font-semibold flex items-center justify-center gap-2 shadow-md transition-all duration-200 active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <span>Sign in to {PORTAL_META[portal]?.label || 'Portal'}</span>
                    <span className="material-symbols-outlined text-[18px] transition-transform group-hover:translate-x-1">arrow_forward</span>
                  </button>
                </div>
              </form>

              {/* Phase 20.4 — DEV-only credential helper; Vite dead-code
                  eliminates the credential strings from production builds. */}
              {import.meta.env.DEV && (
                <div className="pt-4 mt-5 border-t border-[var(--color-botanical-border)] dark:border-[#3a3530] text-center space-y-1.5">
                  <button
                    type="button"
                    onClick={() => { setEmail('handler.admin@flora-alchemy.demo'); setPassword('handler1234'); setError(''); }}
                    className="text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
                  >
                    ⚡ Quick Fill Demo Credentials (DEV ONLY)
                  </button>
                  <p className="text-[11px] text-[var(--color-botanical-subtle)]">
                    Developer helper — handler.admin@flora-alchemy.demo / handler1234
                  </p>
                </div>
              )}
            </div>

            <div className="pt-6 space-y-4">
              <div className="p-3.5 rounded-xl bg-[var(--color-surface-container)] dark:bg-[#2e2a25] flex items-center gap-3">
                <span className="material-symbols-outlined text-[var(--color-botanical-subtle)] text-[18px] shrink-0">token</span>
                <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                  Your role and portal authority are resolved by the server on every request — signing in here cannot grant access you do not hold.
                </p>
              </div>

              {/* Phase 22.4 — the Administrator Portal is the only portal with
                  a public application door: a new business applies, the owner
                  reviews, and approval issues the one-time invitation. The
                  owner and staff portals never advertise it (governance is
                  owner-only; handlers are invited, never self-applied). */}
              {portal === 'admin' && (
                <div className="text-center">
                  <Link
                    to="/apply/admin"
                    className="inline-flex items-center py-1 gap-1.5 text-[13px] font-semibold text-[var(--color-accent)] hover:text-[var(--color-btn-hover)] transition-colors"
                  >
                    <span className="material-symbols-outlined text-[16px]">storefront</span>
                    <span>New business? Apply to open a workspace</span>
                    <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                  </Link>
                </div>
              )}

              <div className="text-center">
                <Link
                  to="/"
                  className="inline-flex items-center py-1 gap-1 text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] hover:text-[var(--color-accent)] transition-colors"
                >
                  <span>Not a staff member? Return to the storefront</span>
                  <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
