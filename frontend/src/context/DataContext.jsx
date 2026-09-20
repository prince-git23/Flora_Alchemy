import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  hydratePublic,
  hydrateAdmin,
  hydrateCustomer,
  clearSessionData,
  hasAdminSessionScope,
  hasCustomerSessionScope,
} from '../services/dataStore.js';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const syncing = useRef(false);
  const hasHydrated = useRef(false);

  const isAuthPage = location.pathname === '/login' || location.pathname === '/admin/login';

  const sync = async ({ force = false, silent = false } = {}) => {
    if (syncing.current) return;
    // Phase 17 — request-efficiency guard: a route change does NOT re-hydrate.
    // The store already holds the server-confirmed collections and every
    // mutation refreshes exactly what it changed. Only a forced refresh, the
    // initial mount, or a session change performs a full hydration.
    if (!force && hasHydrated.current) return;
    // Phase 18.5.2 — action-level loading: once the app is hydrated, a
    // fa:refresh is a BACKGROUND synchronization. Refresh the store silently
    // and leave the current page fully visible and interactive; the global
    // loader is reserved for the initial bootstrap and auth-scope changes.
    const background = silent || hasHydrated.current;
    syncing.current = true;
    hasHydrated.current = true;
    if (!background) setStatus('loading');
    let admin = false;
    try {
      await hydratePublic();
      admin = hasAdminSessionScope();
      const customer = hasCustomerSessionScope();
      if (admin) await hydrateAdmin();
      if (customer && !admin) await hydrateCustomer();
      if (!customer && !admin) clearSessionData();
      if (!background) setStatus('ready');
    } catch (err) {
      // Session hardening: a 401 during hydration means the stored session
      // is invalid/expired. apiClient already cleared the markers — send the
      // user to the correct login screen instead of a dead-end error page.
      if (err && err.status === 401) {
        const target = admin ? '/admin/login' : '/login';
        if (location.pathname !== target) navigate(target, { replace: true });
        setStatus('ready');
        return;
      }
      if (background) {
        // A background refresh failure must never nuke the page the user is
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
    }
  };

  // Hydrate on mount and whenever an explicit refresh signal fires.
  // Auth-scope changes (login/logout) re-show the bootstrap loader;
  // mutation-induced refreshes sync silently in the background (Phase 18.5.2).
  useEffect(() => {
    const timer = setTimeout(() => sync({ force: true }), 0);
    const onRefresh = (e) => {
      clearTimeout(timer);
      const scope = e && e.detail && e.detail.scope;
      sync({ force: true, silent: scope !== 'auth' });
    };
    window.addEventListener('fa:refresh', onRefresh);
    return () => {
      clearTimeout(timer);
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
        <div className="min-h-screen bg-[var(--color-surface-bg)] flex items-center justify-center">
          <div className="text-center space-y-4 px-6">
            <div className="mx-auto w-12 h-12 rounded-full border-2 border-[var(--color-surface-highest)] border-t-[#964735] animate-spin" />
            <div className="space-y-2">
              <p className="font-serif text-[20px] text-[var(--color-botanical-text)] tracking-tight">Flora Alchemy</p>
              <div className="flex items-center justify-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-[#964735] animate-pulse" />
                <p className="text-[13px] text-[var(--color-botanical-subtle)]">Preparing your experience</p>
              </div>
            </div>
          </div>
        </div>
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
            <p className="text-[13px] text-[var(--color-botanical-subtle)]">
              Start the API server (see <code className="text-[#964735]">.freebuff/run.md</code>) then retry.
            </p>
            <button
              type="button"
              onClick={() => setTick((t) => t + 1)}
              className="px-6 py-2.5 rounded-full bg-[#180f0a] text-white text-[14px] font-semibold hover:bg-[#964735] transition-colors"
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
