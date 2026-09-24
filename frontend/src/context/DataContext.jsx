import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  hydratePublic,
  hydrateAdmin,
  hydrateCustomer,
  clearSessionData,
  hasAdminSessionScope,
  hasCustomerSessionScope,
  refreshProducts,
  refreshCollections,
  refreshSettings,
  refreshOrders,
  refreshInventory,
  refreshAnalytics,
  refreshCustomers,
} from '../services/dataStore.js';
import BootstrapSkeleton from '../components/BootstrapSkeleton.jsx';

const DataContext = createContext(null);

/**
 * Phase 20.1 — loading architecture.
 *
 * LEVEL 1  app bootstrap        → BootstrapSkeleton (initial page load only)
 * LEVEL 2  initial page data    → content skeletons (owned by each page)
 * LEVEL 3  local mutation       → action-level spinners (owned by each action)
 * LEVEL 4  background refresh   → silent; the current UI stays mounted (here)
 * LEVEL 5  upload/payment/long  → localized progress (owned by each control)
 *
 * Mutations dispatch `fa:refresh` with a slice hint (e.g. ['products']).
 * DataProvider refreshes ONLY the affected endpoints in the background —
 * a normal state change never re-shows the global loader and never
 * re-hydrates the whole dataset.
 */
const REFRESH_DEBOUNCE_MS = 350; // coalesce bursts of signals into one fetch set
const MIN_SYNC_GAP_MS = 2500; // min gap between background data syncs

export function DataProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const syncing = useRef(false);
  const hasHydrated = useRef(false); // true only after a SUCCESSFUL full hydration
  const lastSyncAt = useRef(0);
  const refreshTimer = useRef(null);
  const pendingRef = useRef(null); // { scope, slices } arriving while a sync runs

  const isAuthPage = location.pathname === '/login' || location.pathname === '/admin/login';

  // LEVEL 4 — refresh only the slices a mutation actually touched.
  const runSlices = async (slices) => {
    const admin = hasAdminSessionScope();
    const customer = hasCustomerSessionScope();
    const wants = (s) => slices.includes(s);
    const tasks = [];
    if (wants('products')) tasks.push(refreshProducts()); // admin scope keeps Hidden
    if (wants('collections')) tasks.push(refreshCollections()); // admin scope keeps Hidden
    if (wants('settings')) tasks.push(refreshSettings());
    if (wants('orders')) tasks.push(refreshOrders());
    if (wants('inventory')) {
      tasks.push(refreshInventory());
      // Phase 20.2 — availability is embedded on catalogue products, so an
      // inventory change must also refresh the products slice; otherwise the
      // customer storefront keeps showing stale stock after an admin adjust.
      tasks.push(refreshProducts());
    }
    if (wants('customers') && admin) tasks.push(refreshCustomers());
    if (admin && (wants('orders') || wants('inventory') || wants('analytics'))) {
      tasks.push(refreshAnalytics()); // KPIs affected by orders/stock — once
    }
    if (wants('profile') && customer && !admin) tasks.push(hydrateCustomer());
    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      // Background failure: keep the current UI and its last confirmed data.
      // Never rethrow — a slice refresh can only run after hydration, so it
      // must not flip the app into the error screen.
      console.error('[data] background slice refresh failed', failed.map((f) => f.reason));
    }
  };

  const mergePending = (next) => {
    const cur = pendingRef.current;
    if (!cur) {
      pendingRef.current = next;
      return;
    }
    const scope = cur.scope === 'auth' || next.scope === 'auth' ? 'auth' : 'data';
    let slices = null;
    if (cur.slices && next.slices) {
      slices = [...new Set([...cur.slices, ...next.slices])];
    }
    pendingRef.current = { scope, slices };
  };

  const runSync = async ({ force = false, silent = false, slices = null } = {}) => {
    if (syncing.current) {
      mergePending({ force: true, silent, slices });
      return;
    }
    if (!force && hasHydrated.current) return;
    // Pre-hydration everything becomes a full hydration — the app needs the
    // complete dataset once before targeted refreshes make sense.
    const effSlices = hasHydrated.current ? slices : null;
    // Captured BEFORE any request: a 401 clears the stored markers, but the
    // redirect target must reflect the session that actually failed.
    const adminSession = hasAdminSessionScope();
    // LEVEL 1 only when we have never produced usable data; afterwards every
    // sync is a LEVEL 4 background refresh that must keep the UI visible.
    const background = silent || hasHydrated.current;
    syncing.current = true;
    if (!background) setStatus('loading');
    try {
      if (effSlices && effSlices.length) {
        await runSlices(effSlices);
        lastSyncAt.current = Date.now();
        setStatus('ready'); // no-op when already ready
      } else {
        await hydratePublic();
        const admin = adminSession;
        const customer = hasCustomerSessionScope();
        if (admin) await hydrateAdmin();
        if (customer && !admin) await hydrateCustomer();
        if (!customer && !admin) clearSessionData();
        // Only a successful FULL hydration marks the app as hydrated —
        // this is what lets Retry from the error screen work again
        // (Phase 20.1 bugfix: it used to be set before the first fetch).
        hasHydrated.current = true;
        lastSyncAt.current = Date.now();
        setStatus('ready');
      }
    } catch (err) {
      // Session hardening: a 401 during hydration means the stored session
      // is invalid/expired. apiClient already cleared the markers — send the
      // user to the correct login screen instead of a dead-end error page.
      if (err && err.status === 401) {
        const target = adminSession ? '/admin/login' : '/login';
        if (location.pathname !== target) navigate(target, { replace: true });
        hasHydrated.current = true;
        setStatus('ready');
        return;
      }
      if (silent || hasHydrated.current) {
        // Background refresh failure must never nuke the page the user is
        // looking at. The store keeps its last confirmed data; the mutation
        // itself already reported success/failure at the action level.
        console.error('[data] background sync failed', err);
        return;
      }
      console.error('[data] hydration failed', err);
      setError(err.message || 'Unable to load data from the server.');
      setStatus('error');
    } finally {
      syncing.current = false;
      const p = pendingRef.current;
      if (p) {
        pendingRef.current = null;
        schedule({ force: true, silent: p.scope !== 'auth', slices: p.slices });
      }
    }
  };

  // Schedule a background sync: coalesce bursts (350ms) and keep a minimum
  // gap between full re-hydrations. Auth-scope changes run immediately.
  const schedule = ({ force = true, silent = true, slices = null }) => {
    if (!silent) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      runSync({ force, silent, slices });
      return;
    }
    clearTimeout(refreshTimer.current);
    const elapsed = Date.now() - lastSyncAt.current;
    const delay = Math.max(REFRESH_DEBOUNCE_MS, MIN_SYNC_GAP_MS - elapsed);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      runSync({ force, silent, slices });
    }, delay);
  };

  // Hydrate on mount and whenever an explicit refresh signal fires.
  // Auth-scope changes (login/logout) re-show the bootstrap loader;
  // mutation-induced refreshes sync silently in the background (Phase 18.5.2),
  // touching only the slices they named (Phase 20.1).
  useEffect(() => {
    const timer = setTimeout(() => runSync({ force: true }), 0);
    const onRefresh = (e) => {
      clearTimeout(timer);
      const scope = e && e.detail && e.detail.scope;
      const slices = (e && e.detail && e.detail.slices) || null;
      if (scope === 'auth') {
        schedule({ force: true, silent: false, slices: null });
      } else {
        schedule({ force: true, silent: true, slices });
      }
    };
    window.addEventListener('fa:refresh', onRefresh);
    return () => {
      clearTimeout(timer);
      clearTimeout(refreshTimer.current);
      window.removeEventListener('fa:refresh', onRefresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const value = useMemo(
    () => ({
      status,
      error,
      ready: status === 'ready',
      retry: () => setTick((t) => t + 1),
    }),
    [status, error]
  );

  if (isAuthPage) {
    // Auth screens need nothing from the store until submit — never block them.
    return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
  }

  if (status === 'loading') {
    return (
      <DataContext.Provider value={value}>
        <BootstrapSkeleton />
      </DataContext.Provider>
    );
  }

  if (status === 'error') {
    return (
      <DataContext.Provider value={value}>
        <div className="min-h-screen bg-[var(--color-surface-bg)] flex items-center justify-center px-6">
          <div className="max-w-md text-center space-y-4">
            <p className="text-[40px]">🌿</p>
            <h1 className="font-serif text-[24px] text-[var(--color-botanical-text)]">We couldn’t reach the studio server</h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)]">{error}</p>
            {import.meta.env.DEV ? (
              <p className="text-[13px] text-[var(--color-botanical-subtle)]">
                Start the API server (see <code className="text-[var(--color-accent)]">.freebuff/run.md</code>) then retry.
              </p>
            ) : (
              <p className="text-[13px] text-[var(--color-botanical-subtle)]">
                This is usually a temporary connection problem — please try again in a moment.
              </p>
            )}
            <button
              type="button"
              onClick={() => setTick((t) => t + 1)}
              className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[14px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      </DataContext.Provider>
    );
  }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within DataProvider');
  return ctx;
}

export { hasAdminSessionScope, hasCustomerSessionScope } from '../services/dataStore.js';
