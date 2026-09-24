import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Lock, Mail, User, Phone, Eye, EyeOff, ArrowRight, Info, AlertCircle, ShoppingBag } from 'lucide-react';
import gsap from 'gsap';
import { useStore } from '../context/StoreContext.jsx';
import { apiLogin, apiRegister, saveAddressToAccount } from '../services/customerService.js';
import { isSafeInternalPath, loadCheckoutSnapshot, clearCheckoutSnapshot } from '../services/apiClient.js';

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showToast } = useStore();
  const pageRef = useRef(null);
  const heroRef = useRef(null);
  const formRef = useRef(null);

  // Optional return destination (e.g. /checkout) so auth never strands the customer.
  // Phase 20.3 — internal paths only: the query param must never become an
  // open redirect (protocol-relative URLs, absolute URLs, '//' are rejected).
  const rawRedirect = searchParams.get('redirect') || '/account';
  const redirect = isSafeInternalPath(rawRedirect) ? rawRedirect : '/account';
  const initialMode = searchParams.get('mode') === 'register' ? 'register' : 'login';

  // Phase 20.3 — when the customer was sent here from checkout, the delivery
  // form was snapshotted. Show them their in-progress details while signing
  // in/up so the return to checkout is visibly seamless.
  const checkoutSnapshot = useMemo(() => {
    const snap = loadCheckoutSnapshot();
    return isSafeInternalPath(rawRedirect) && rawRedirect.startsWith('/checkout') ? snap : null;
  }, [rawRedirect]);

  const [mode, setMode] = useState(initialMode); // 'login' | 'register' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // GSAP entrance
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = gsap.context(() => {
      gsap.fromTo(heroRef.current, { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: 0.8, ease: 'power3.out' });
      gsap.fromTo(formRef.current, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.8, delay: 0.2, ease: 'power3.out' });
    }, pageRef);

    return () => ctx.revert();
  }, []);

  const goAfterAuth = () => navigate(redirect);

  // Phase 20.3 — during a register-from-checkout flow, seed the new account's
  // address book with the delivery details already captured in checkout
  // (best-effort; failure never blocks sign-up). Login flows restore the
  // snapshot as-is instead — the address book already belongs to the account.
  const syncCheckoutAddressAfterAuth = async () => {
    const snap = checkoutSnapshot;
    if (!snap || !snap.formData) return;
    const f = snap.formData;
    if (!f.address || !f.pincode) return;
    try {
      await saveAddressToAccount({
        name: f.fullName,
        phone: f.phone,
        address: f.address,
        city: f.city,
        state: f.state,
        pincode: f.pincode,
      });
    } catch {
      /* best-effort: checkout still restores its snapshot */
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    if (mode === 'register') {
      if (password.length < 6) {
        setError('Password must be at least 6 characters.');
        setIsSubmitting(false);
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        setIsSubmitting(false);
        return;
      }
      if (!name.trim()) {
        setError('Please provide your full name.');
        setIsSubmitting(false);
        return;
      }
      const result = await apiRegister({ name, email, password, phone });
      if (result.error) {
        setError(result.error);
        setIsSubmitting(false);
        return;
      }
      showToast(result.created
        ? `Welcome to Flora Alchemy, ${result.customer.name}!`
        : 'Account already existed — signed you in.');
      setIsSubmitting(false);
      await syncCheckoutAddressAfterAuth();
      clearCheckoutSnapshot();
      goAfterAuth();
      return;
    }

    const result = await apiLogin(email, password);
    if (result.error) {
      setError(result.error);
      setIsSubmitting(false);
      return;
    }
    const customer = result.customer;
    showToast(`Welcome back, ${customer.name}!`);
    setIsSubmitting(false);
    // Phase 20.3 — the snapshot is intentionally NOT cleared on login: it is
    // consumed by CheckoutPage on restore (keyed to the bag), so a failed
    // order attempt or another route change keeps the context available.
    goAfterAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  };

  const handleSendResetLink = (e) => {
    e.preventDefault();
    setResetSent(true);
  };

  const handleFillDemo = () => {
    setEmail('customer@example.com');
    setPassword('demo1234');
    setError('');
    showToast('DEV ONLY — demo credentials filled. No automatic login.');
  };

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-[calc(100vh-64px)]">
      {/* Mobile-first: stacked layout */}
      <div className="flex flex-col lg:flex-row min-h-[calc(100vh-64px)]">
        {/* Left — Editorial Atmosphere */}
        <div ref={heroRef} className="hidden lg:flex lg:w-1/2 relative items-center justify-center overflow-hidden">
          {/* Background image */}
          <div className="absolute inset-0">
            <img
              loading="lazy"
              decoding="async"
              src="/assets/images/flora-asset-03.jpg"
              alt=""
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-[#180f0a]/80 to-[#180f0a]/40" />
          </div>

          {/* Ambient glow orbs */}
          <div className="absolute top-20 left-20 w-64 h-64 bg-[#964735]/10 rounded-full blur-[100px]" />
          <div className="absolute bottom-20 right-20 w-48 h-48 bg-[#c17c74]/10 rounded-full blur-[80px]" />

          {/* Content */}
          <div className="relative z-10 px-16 max-w-lg space-y-8">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--color-surface-lowest)]/10 text-white/80 text-[11px] font-bold uppercase tracking-wider backdrop-blur-sm">
              <span>Welcome to Flora Alchemy</span>
            </div>
            <h2 className="font-serif text-[48px] text-white font-normal leading-[1.1] tracking-tight">
              Where every gift<br />is handcrafted<br />with intention.
            </h2>
            <p className="text-[16px] text-white/70 leading-relaxed">
              Access your orders, wishlist, and saved gift notes. Your personal atelier awaits.
            </p>
            <div className="flex items-center gap-4 pt-4">
              <div className="flex items-center gap-2 text-white/60 text-[13px]">
                <span className="w-2 h-2 rounded-full bg-[#964735]" />
                Handmade in small batches
              </div>
              <div className="flex items-center gap-2 text-white/60 text-[13px]">
                <span className="w-2 h-2 rounded-full bg-[#964735]" />
                Pan-India delivery
              </div>
            </div>
          </div>
        </div>

        {/* Right — Auth Form */}
        <div ref={formRef} className="w-full lg:w-1/2 flex items-center justify-center py-12 lg:py-20 px-4">
          <div className="w-full max-w-md space-y-6">
            {/* Mobile brand header */}
            <div className="lg:hidden text-center space-y-2 mb-6">
              <Link to="/" className="inline-block">
                <img
                  loading="lazy"
                  decoding="async"
                  src="/assets/images/flora-asset-27.jpg"
                  alt="Flora Alchemy"
                  className="h-8 w-auto mx-auto"
                />
              </Link>
            </div>

            {/* Brand Emblem */}
            <div className="text-center space-y-2">
              <h1 className="font-serif text-[32px] text-[var(--color-botanical-primary)] font-medium">
                {mode === 'login' && 'Welcome Back'}
                {mode === 'register' && 'Create an Account'}
                {mode === 'forgot' && 'Reset Your Password'}
              </h1>
              <p className="text-[14px] text-[var(--color-botanical-muted)]">
                {mode === 'forgot'
                  ? 'Enter the email you use to shop with us.'
                  : 'Access your orders, wishlist, and saved gift notes.'}
              </p>
            </div>

            {/* Tab Switcher (hidden in forgot mode) */}
            {mode !== 'forgot' && (
              <div className="grid grid-cols-2 p-1 rounded-2xl bg-[var(--color-surface-low)] text-[13px] font-semibold">
                <button
                  type="button"
                  onClick={() => { setMode('login'); setError(''); }}
                  className={`py-2.5 rounded-xl transition-all duration-200 ${
                    mode === 'login' ? 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] shadow-xs' : 'text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)]'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => { setMode('register'); setError(''); }}
                  className={`py-2.5 rounded-xl transition-all duration-200 ${
                    mode === 'register' ? 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] shadow-xs' : 'text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)]'
                  }`}
                >
                  Create Account
                </button>
              </div>
            )}

            {error && (
              <div className="p-3 rounded-2xl bg-[#ffdad6]/60 border border-[#ffc9c2] text-[12px] text-[#8a2a18] flex items-start gap-2" role="alert">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Phase 20.3 — visible continuity: when the customer came from
                checkout, show what they were doing so returning after sign-in
                feels like resuming, not restarting. Failed sign-ins leave this
                intact (state is never destroyed on auth failure). */}
            {checkoutSnapshot && checkoutSnapshot.formData && (
              <div role="status" className="p-3.5 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] flex items-start gap-2.5">
                <ShoppingBag className="w-4 h-4 text-[var(--color-accent)] shrink-0 mt-0.5" aria-hidden="true" />
                <div className="text-[12px] leading-relaxed min-w-0">
                  <p className="font-semibold text-[var(--color-botanical-primary)]">
                    Your bag is safe — you'll return straight to checkout.
                  </p>
                  {checkoutSnapshot.formData.address && (
                    <p className="text-[var(--color-botanical-muted)] truncate">
                      Delivering to: {checkoutSnapshot.formData.address}, {checkoutSnapshot.formData.city} {checkoutSnapshot.formData.pincode}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Form */}
            {mode === 'forgot' ? (
              <form onSubmit={handleSendResetLink} className="space-y-4">
                <div>
                  <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                    Email Address
                  </label>
                  <div className="relative">
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full pl-10 pr-4 py-3 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-all"
                    />
                    <Mail className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full py-3.5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold tracking-wide shadow-md transition-all duration-200 active:translate-y-0.5"
                >
                  Send Reset Link
                </button>

                {resetSent && (
                  <div className="p-3 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] text-[12px] text-[var(--color-botanical-muted)] flex items-start gap-2">
                    <Info className="w-4 h-4 text-[var(--color-accent)] shrink-0 mt-0.5" />
                    <span>
                      Demo environment — no email is actually sent.
                      {/* Phase 20.4 — the demo password must not ship in a
                          production bundle; the explanation above stays. */}
                      {import.meta.env.DEV && ' Use the demo account (customer@example.com / demo1234) to sign in.'}
                    </span>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => { setMode('login'); setResetSent(false); setError(''); }}
                  className="w-full text-center text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
                >
                  Back to Sign In
                </button>
              </form>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                {mode === 'register' && (
                  <div>
                    <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                      Full Name
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        className="w-full pl-10 pr-4 py-3 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-all"
                      />
                      <User className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                    Email Address
                  </label>
                  <div className="relative">
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full pl-10 pr-4 py-3 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-all"
                    />
                    <Mail className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  </div>
                </div>

                {mode === 'register' && (
                  <div>
                    <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                      Phone Number
                    </label>
                    <div className="relative">
                      <input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className="w-full pl-10 pr-4 py-3 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-all"
                      />
                      <Phone className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)]">
                      Password
                    </label>
                    {mode === 'login' && (
                      <button
                        type="button"
                        onClick={() => { setMode('forgot'); setError(''); }}
                        className="text-[11px] text-[var(--color-accent)] hover:underline"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="w-full pl-10 pr-11 py-3 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-all"
                    />
                    <Lock className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] transition-colors"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {mode === 'register' && (
                  <div>
                    <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                      Confirm Password
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        required
                        className="w-full pl-10 pr-4 py-3 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-all"
                      />
                      <Lock className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3.5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-md transition-all duration-200 active:translate-y-0.5 disabled:opacity-50"
                >
                  <span>{mode === 'login' ? 'Sign In to Account' : 'Create My Account'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            )}

            {/* DEV ONLY helper — gated so Vite strips it from production builds. */}
            {import.meta.env.DEV && mode !== 'forgot' && (
              <div className="pt-3 border-t border-dashed border-[#d8cfc6] text-center">
                <button
                  type="button"
                  onClick={handleFillDemo}
                  title="Development/testing helper — not available in production"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed border-[#c9a227]/60 bg-[#fdf6e3] text-[10px] font-bold tracking-widest uppercase text-[#8a6d1a] hover:bg-[#f7ecc9] transition-colors"
                >
                  Dev Only · Fill Demo Credentials
                </button>
              </div>
            )}

            {/* Store link */}
            <div className="text-center pt-2">
              <Link to="/shop" className="text-[12px] text-[var(--color-botanical-subtle)] hover:text-[var(--color-accent)] transition-colors">
                Continue browsing without an account →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
