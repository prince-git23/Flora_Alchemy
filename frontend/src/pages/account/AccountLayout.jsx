import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LayoutGrid, Package, Heart, Settings, LogOut, Lock } from 'lucide-react';
import { Skeleton } from '../../components/Skeleton.jsx';
import {
  getAccount,
  getActiveCustomer,
  refreshCurrentCustomer,
  apiLogout,
} from '../../services/customerService.js';
import { useStore } from '../../context/StoreContext.jsx';

/**
 * CUSTOMER ACCOUNT — the shell for every /account surface.
 *
 * This is the customer's own space: it renders inside the storefront shell
 * (Navbar + Footer), never the Admin/Owner/Staff portals, and it never shows a
 * business/workspace concept. A guest is sent to the ordinary customer sign-in
 * (with a return path) — never to a portal login.
 *
 * The identity is loaded from the SERVER (GET /api/auth/me) so the page never
 * trusts a stale local marker: a token that has expired or an account that was
 * deactivated resolves to the honest state instead of a half-rendered profile.
 */
const NAV = [
  { to: '/account', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/account/orders', label: 'Orders', icon: Package },
  { to: '/account/saved', label: 'Saved Gifts', icon: Heart },
  { to: '/account/settings', label: 'Settings', icon: Settings },
];

export default function AccountLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { showToast } = useStore();

  const [state, setState] = useState({ status: 'loading', profile: null, account: null, code: null });

  const load = useCallback(async () => {
    // No local marker at all → there is nothing to load; send to sign-in.
    const marker = getAccount();
    if (!marker) {
      setState({ status: 'anon', profile: null, account: null, code: null });
      return;
    }
    try {
      const profile = await refreshCurrentCustomer();
      if (!profile) {
        setState({ status: 'anon', profile: null, account: marker, code: null });
        return;
      }
      setState({ status: 'ready', profile, account: marker, code: null });
    } catch (err) {
      // ACCOUNT_INACTIVE / suspended is an access decision, not a network
      // outage — the customer is told plainly rather than shown a broken page.
      if (err.code === 'ACCOUNT_INACTIVE') {
        setState({ status: 'inactive', profile: null, account: marker, code: err.code });
        return;
      }
      // Token failed or expired mid-visit: fall back to the marker so a genuine
      // signed-in customer is not thrown out by a transient error.
      const cached = getActiveCustomer();
      if (cached) {
        setState({ status: 'ready', profile: cached, account: marker, code: null });
      } else {
        setState({ status: 'anon', profile: null, account: marker, code: err.code || null });
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSignOut = async () => {
    await apiLogout();
    showToast('Signed out');
    navigate('/');
  };

  const context = {
    profile: state.profile,
    account: state.account,
    reload: load,
    signOut: handleSignOut,
  };

  if (state.status === 'loading') {
    return (
      <div className="w-full min-h-screen bg-[var(--color-surface-bg)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-16 space-y-8">
          <div className="flex items-center gap-4">
            <Skeleton className="w-16 h-16 rounded-full shrink-0" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-32 rounded-md" />
              <Skeleton className="h-7 w-56 rounded-md" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-3xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (state.status === 'anon') {
    return <Navigate to={`/login?redirect=${encodeURIComponent(pathname)}`} replace />;
  }

  if (state.status === 'inactive') {
    return (
      <div className="w-full min-h-[70vh] bg-[var(--color-surface-bg)] flex items-center justify-center px-6 py-16">
        <div className="max-w-md text-center space-y-4 bg-[var(--color-surface-lowest)] rounded-3xl p-10 border border-[var(--color-botanical-border)]">
          <span className="inline-flex w-14 h-14 rounded-full bg-[var(--color-surface-low)] items-center justify-center mx-auto">
            <Lock className="w-6 h-6 text-[var(--color-accent)]" aria-hidden="true" />
          </span>
          <h1 className="font-serif text-[24px] text-[var(--color-botanical-primary)]">
            This account is not active
          </h1>
          <p className="text-[14px] text-[var(--color-botanical-muted)]">
            Your Flora Alchemy account has been deactivated, so your profile and orders are not
            available right now. Please contact the studio if you believe this is a mistake.
          </p>
          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
          >
            <LogOut className="w-4 h-4" /> Sign Out
          </button>
        </div>
      </div>
    );
  }

  const { profile, account } = state;
  const displayName = (profile && profile.name) || (account && account.name) || '';
  const displayEmail = (profile && profile.email) || (account && account.email) || '';
  const initial = (displayName || displayEmail || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen relative overflow-hidden">
      {/* Ambient botanical depth — the same treatment the storefront uses. */}
      <div className="absolute top-0 right-0 w-96 h-96 rounded-full bg-[var(--color-badge-bg)]/10 blur-3xl pointer-events-none" />
      <div className="absolute bottom-40 left-0 w-80 h-80 rounded-full bg-[var(--color-botanical-sage-light)]/10 blur-3xl pointer-events-none" />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-14 relative">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5 pb-8 mb-8 border-b border-[var(--color-botanical-border)]">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-[60px] h-[60px] sm:w-16 sm:h-16 rounded-full bg-[var(--color-btn)] text-white flex items-center justify-center font-serif text-[24px] shadow-sm shrink-0">
              {initial}
            </div>
            <div className="min-w-0">
              <span className="block text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
                My Account
              </span>
              <h1 className="font-serif text-[26px] sm:text-[32px] text-[var(--color-botanical-primary)] font-normal leading-tight truncate">
                Your Flora Alchemy
              </h1>
              <p className="text-[13px] text-[var(--color-botanical-subtle)] truncate">
                {displayName || displayEmail}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <NavLink
              to="/shop"
              className="px-5 py-2.5 rounded-full bg-[var(--color-surface-low)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-highest)] text-[12px] font-semibold transition-colors"
            >
              Browse Gifts
            </NavLink>
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] text-[12px] font-semibold transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" /> Sign Out
            </button>
          </div>
        </header>

        {/* ── Body: nav rail (desktop) / scroll pills (mobile) ────────── */}
        <div className="lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-12">
          <nav
            aria-label="Account sections"
            className="flex lg:flex-col gap-1.5 mb-6 lg:mb-0 overflow-x-auto scrollbar-none lg:sticky lg:top-24 lg:self-start"
          >
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-4 py-2.5 rounded-full lg:rounded-2xl text-[13px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'bg-[var(--color-btn)] text-white shadow-sm'
                      : 'text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)]'
                  }`
                }
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="min-w-0">
            <Outlet context={context} />
          </div>
        </div>
      </div>
    </div>
  );
}
