import React, { useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import LoginLoading from '../../components/admin/LoginLoading.jsx';

/**
 * Phase 20.6.2 — Staff Sign In.
 *
 * Split atelier layout (design ref: "Staff Sign In"): left scenography
 * panel, right authentication core. Behaviour is unchanged from the previous
 * card layout — one server-resolved session via POST /api/auth/login, no
 * role selector (the role comes back from the server), duplicate-submit
 * guard, in-flight loading state, DEV-only credential helper.
 */
export default function AdminLoginPage() {
  const navigate = useNavigate();
  const { login } = useAdminSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Duplicate-submission guard: a submit handler re-run while the auth
  // request is in flight (e.g. rapid double Enter) must not fire a second
  // request. The submit button is also disabled, but form submit can still
  // be triggered via keyboard.
  const authInFlightRef = useRef(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (authInFlightRef.current) return;
    authInFlightRef.current = true;
    setError('');
    setLoading(true);

    // try/finally guarantees the form is always restorable on failure,
    // even if an unexpected error escapes the auth service.
    let result;
    try {
      result = await login(email, password);
    } finally {
      setLoading(false);
      authInFlightRef.current = false;
    }

    if (result.success) {
      navigate('/admin/dashboard');
    } else {
      setError(result.error || 'Login failed');
    }
  };

  // Authentication-in-progress: transition the whole portal surface into a
  // clean loading state. Entered credentials stay in component state (never
  // persisted); on failure we simply re-render the form below with the
  // existing error.
  if (loading) {
    return <LoginLoading />;
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 sm:p-6 lg:p-8 bg-[var(--color-surface-bg)]">
      <div className="w-full max-w-[80rem] mx-auto py-4 md:py-8">
        <div className="w-full grid grid-cols-1 lg:grid-cols-2 rounded-3xl overflow-hidden shadow-xl bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] border border-[var(--color-botanical-border)] dark:border-[#3a3530]">

          {/* ── Left: atelier scenography ─────────────────────────────── */}
          <div className="relative min-h-[320px] lg:min-h-full flex flex-col justify-between p-8 md:p-12 overflow-hidden bg-[#2e241e] text-[#f6f3ee]">
            {/* Real atelier photography + layered scrims for legibility */}
            <div className="absolute inset-0 z-0">
              <img
                alt="Flora Alchemy atelier worktable with handcrafted botanical arrangements"
                className="w-full h-full object-cover object-center filter saturate-[0.85] contrast-[1.05] brightness-[0.7]"
                src="/assets/images/flora-asset-13.jpg"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#2e241e] via-[#2e241e]/70 to-[#2e241e]/40"></div>
              <div className="absolute inset-0 bg-gradient-to-r from-[#2e241e]/70 via-transparent to-[#2e241e]/40"></div>
            </div>

            {/* Header: brand + classification */}
            <div className="relative z-10 flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center shadow-sm">
                  <span className="material-symbols-outlined text-[18px] text-[#ffdad3]">local_florist</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[#d4c3ba]">Flora Alchemy</span>
                  <span className="text-[13px] leading-5 text-[#e5e2dd]/90">Atelier Operations Console</span>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md text-[#f1dfd5] text-[11px] font-bold uppercase tracking-[0.08em]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#fd9882] animate-pulse"></span>
                Staff Access
              </span>
            </div>

            {/* Doctrine */}
            <div className="relative z-10 flex flex-col gap-6 mt-auto pt-12">
              <div className="space-y-3 max-w-lg">
                <div className="inline-flex items-center gap-2 text-[#d4c3ba] text-[11px] font-bold uppercase tracking-[0.08em]">
                  <span className="material-symbols-outlined text-[14px]">verified_user</span>
                  <span>Disciplined Custody</span>
                </div>
                <h2 className="font-serif text-[34px] lg:text-[44px] leading-[1.1] tracking-[-0.02em] text-white">
                  Handcrafted botanical keepsakes, run with disciplined operational stewardship.
                </h2>
              </div>

              <div className="p-5 rounded-2xl bg-white/10 backdrop-blur-md shadow-sm">
                <div className="flex items-start gap-3.5">
                  <span className="material-symbols-outlined text-[#fd9882] mt-0.5 text-xl">shield_lock</span>
                  <div className="space-y-1">
                    <p className="text-[13px] leading-5 font-medium text-white tracking-tight">
                      Integrity in every bloom, care in every credential. Handlers execute; Admins oversee; the Owner safeguards.
                    </p>
                    <p className="text-[11px] leading-4 text-[#d4c3ba]">
                      TLS-secured sessions · role-scoped API access · server-authoritative permissions
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-3 text-[#e5e2dd]/80 text-[13px]">
                <span>Flora Alchemy Studio Operations</span>
                <span>Secured over HTTPS</span>
              </div>
            </div>
          </div>

          {/* ── Right: authentication core ────────────────────────────── */}
          <div className="lg:col-span-1 flex flex-col justify-between p-8 sm:p-12 lg:p-16 bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18]">
            {/* Gateway header + storefront backlink */}
            <div className="flex items-center justify-between w-full gap-4">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[var(--color-accent)]"></span>
                <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]">Internal Core Operations</span>
              </div>
              <Link
                to="/"
                className="group inline-flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-[var(--color-accent)] hover:text-[var(--color-btn-hover)] transition-colors"
              >
                <span>Customer Portal</span>
                <span className="material-symbols-outlined text-[14px] transition-transform group-hover:translate-x-0.5">arrow_forward</span>
              </Link>
            </div>

            {/* Form */}
            <div className="my-auto py-8 max-w-md w-full mx-auto">
              <div className="space-y-2 mb-8">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[var(--color-surface-low)] dark:bg-[#26221e] text-[var(--color-botanical-primary)] dark:text-[#ffdad3] mb-2 shadow-sm">
                  <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>spa</span>
                </div>
                <h1 className="font-serif text-[40px] leading-[48px] tracking-[-0.015em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">Staff Sign In</h1>
                <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">Administrator &amp; Staff Portal — Flora Alchemy Operations</p>
              </div>

              {/* Role-resolution advisory — the server decides the role */}
              <div className="mb-7 p-4 rounded-xl bg-[var(--color-surface-low)] dark:bg-[#26221e] flex items-start gap-3 border border-[var(--color-botanical-border)] dark:border-[#3a3530]">
                <span className="material-symbols-outlined text-[var(--color-accent)] text-[18px] mt-0.5">hub</span>
                <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                  Single unified gateway for Administrators and Handlers. Your session role is resolved automatically by the server on authentication.
                </p>
              </div>

              {error && (
                <div
                  className="mb-5 flex items-start gap-2 p-3.5 rounded-xl bg-[var(--color-danger-soft-bg)] border border-[var(--color-danger-soft-border)] text-[var(--color-danger-soft-fg)] text-[13px] leading-5"
                  role="alert"
                >
                  <span className="material-symbols-outlined text-[18px] shrink-0 mt-px">error</span>
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-1.5">
                  <label className="block text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]" htmlFor="work-email">
                    Work Email Address
                  </label>
                  <div className="relative flex items-center">
                    <span className="material-symbols-outlined absolute left-4 text-[var(--color-botanical-subtle)] text-[18px] pointer-events-none">mail</span>
                    <input
                      id="work-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@flora-alchemy.example"
                      required
                      className="w-full pl-11 pr-4 py-3 bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[var(--color-botanical-text)] dark:text-[#f0ede9] text-[15px] rounded-full shadow-sm placeholder:text-[var(--color-botanical-subtle)] border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] dark:focus:bg-[#1e1b18] transition-all"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f2efe9]" htmlFor="work-password">
                    Workstation Password
                  </label>
                  <div className="relative flex items-center">
                    <span className="material-symbols-outlined absolute left-4 text-[var(--color-botanical-subtle)] text-[18px] pointer-events-none">lock</span>
                    <input
                      id="work-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      required
                      className="w-full pl-11 pr-12 py-3 bg-[var(--color-surface-bg)] dark:bg-[#222019] text-[var(--color-botanical-text)] dark:text-[#f0ede9] text-[15px] rounded-full shadow-sm placeholder:text-[var(--color-botanical-subtle)] border border-[var(--color-botanical-border)] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] dark:focus:bg-[#1e1b18] transition-all"
                    />
                    <button
                      type="button"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-4 text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-text)] dark:hover:text-[#f0ede9] transition-colors flex items-center justify-center"
                    >
                      <span className="material-symbols-outlined text-[18px]">{showPassword ? 'visibility_off' : 'visibility'}</span>
                    </button>
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    className="group w-full py-3.5 px-6 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] text-white text-[15px] font-semibold flex items-center justify-center gap-2 shadow-md transition-all duration-200 active:scale-[0.99]"
                  >
                    <span>Sign In to Operations Portal</span>
                    <span className="material-symbols-outlined text-[18px] transition-transform group-hover:translate-x-1">arrow_forward</span>
                  </button>
                </div>
              </form>

              {/* Phase 20.4 — prints and auto-fills the seeded demo credentials;
                  gated on import.meta.env.DEV so Vite dead-code-eliminates the
                  credential strings from the production build. */}
              {import.meta.env.DEV && (
                <div className="pt-4 mt-5 border-t border-[var(--color-botanical-border)] dark:border-[#3a3530] text-center space-y-1.5">
                  <button
                    type="button"
                    onClick={() => { setEmail('handler.admin@flora-alchemy.demo'); setPassword('handler1234'); setError(''); }}
                    className="text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
                  >
                    ⚡ Quick Fill Demo Credentials (DEV ONLY)
                  </button>
                  <p className="text-[11px] text-[var(--color-botanical-subtle)]">Developer helper — handler.admin@flora-alchemy.demo / handler1234</p>
                </div>
              )}
            </div>

            {/* Footnotes */}
            <div className="pt-6 space-y-4">
              <div className="p-3.5 rounded-xl bg-[var(--color-surface-container)] dark:bg-[#2e2a25] flex items-center gap-3">
                <span className="material-symbols-outlined text-[var(--color-botanical-subtle)] text-[18px] shrink-0">token</span>
                <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                  Sessions are validated server-side on every request. Portal access is limited to invited staff accounts.
                </p>
              </div>
              <div className="text-center">
                <Link
                  to="/"
                  className="inline-flex items-center gap-1 text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] hover:text-[var(--color-accent)] transition-colors"
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
