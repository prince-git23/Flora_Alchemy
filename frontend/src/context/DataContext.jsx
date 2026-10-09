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
  refreshProfile,
} from '../services/dataStore.js';
import { dataRequirementsFor } from '../services/routeDataRequirements.js';
import { getAdminSession, portalForSession, loginPathForPortal } from '../services/authService.js';

const DataContext = createContext(null);

/**
 * Is the stored ADMIN session the platform Owner (role=admin, isOwner=true,
 * workspaceId=null)?
 *
 * The Owner must never be planned or hydrated as a workspace administrator:
 * every workspace-scoped console endpoint refuses it with 403
 * WORKSPACE_REQUIRED by design. Read from the same stored session the guards
 * use (server-derived at login), so route plans, hydration and the portal
 * guards all agree on ONE identity — the backend remains the authority for
 * every request regardless.
 */
function sessionIsOwner() {
  return getAdminSession()?.isOwner === true;
}

/**
 * GRANULAR STAFF ACCESS — the signed-in staff session's EFFECTIVE permissions,
 * as the route plan needs them to decide which console slices this person may
 * actually read.
 *
 * Returns null when there is no staff session, or when the stored session
 * carries no access list (an older session, or a legacy full-workspace
 * handler). Null means "do not filter": the plan then asks for everything and
 * the server stays the only authority — the same rule the backend applies to
 * an absent permissions array.
 */
function staffPermissionsForPlan() {
  const list = getAdminSession()?.access?.effective;
  return Array.isArray(list) ? list : null;
}

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
 *
 * Phase 20.5 — LEVEL 1 is now ROUTE-SCOPED and no longer owns the shell.
 * The first hydration fetches only the slices the CURRENT route needs
 * (routeDataRequirements.js); every other slice is then hydrated silently
 * straight afterwards. The provider itself never withholds its children any
 * more — `status` is exposed through context and the route content (only)
 * gates on it via RouteBootstrapGate, so the navbar, footer, background and
 * theme render immediately instead of waiting for a full-screen skeleton.
 *
 * Phase 22.4 §20 — WHERE WORKSPACE CONTEXT ENTERS THE FRONTEND: it does NOT
 * enter here yet. The /shops/:slug resolver (ShopWorkspaceGate) publishes the
 * verified { slug, displayName } through router context only; DataProvider
 * still hydrates the single-tenant catalogue for the shared storefront.
 * Per-shop hydration (branching product/collection/settings fetches on the
 * resolved slug, so one workspace's goods never render under another's URL)
 * is Phase 22.5 — it belongs HERE (routeDataRequirements + hydratePublic
 * keyed by workspace slug), not in the gate or the page. The admin session's
 * display-only workspace badge lives in AdminSessionContext, never in this
 * provider (authorization is server-side on every request).
 */
const REFRESH_DEBOUNCE_MS = 350; // coalesce bursts of signals into one fetch set
const MIN_SYNC_GAP_MS = 2500; // min gap between background data syncs

/**
 * Phase 4 — BOUNDED CRITICAL HYDRATION (a route must never hang).
 *
 * `fetch` has no default timeout. An API response that STALLS — a slow shared
 * cluster, a congested mobile connection, a half-open socket — therefore left
 * the route pinned to its skeleton with no error and no way forward: the page
 * the customer asked for simply never arrived. Phase 4 measured the public
 * catalogue endpoint spiking to 11–30s under modest concurrency, which is
 * exactly the shape that produced an eternal skeleton in the browser.
 *
 * The bound applies to the CRITICAL slices only (the ones the route gate
 * waits on). It does not touch payments, uploads or admin mutations, and it
 * changes no server authority: the rejection is classified as NETWORK_ERROR,
 * so the gate renders its existing "connection" state — with Retry — instead
 * of a skeleton that never resolves. A slow-but-successful response still
 * wins the race and renders normally.
 */
const HYDRATION_SLICE_TIMEOUT_MS = 25_000;

function boundedSlice(promise, label) {
  let timer = null;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `The studio server took too long to send ${label}. Check your connection and try again.`
      );
      err.status = 0;
      err.code = 'NETWORK_ERROR';
      reject(err);
    }, HYDRATION_SLICE_TIMEOUT_MS);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

export function DataProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [error, setError] = useState('');
  // WHY hydration failed, not merely THAT it failed. `code` is the server's own
  // error code (ACCOUNT_SUSPENDED / FORBIDDEN / NOT_FOUND / NETWORK_ERROR …)
  // and `status` the HTTP status carried on the DataError. Keeping them lets the
  // route gate render an honest, specific state instead of showing one
  // connection-error screen for every possible failure — a suspended account
  // used to read "We couldn't reach the studio server" above the real message.
  const [errorInfo, setErrorInfo] = useState(null); // { status, code } | null
  const [tick, setTick] = useState(0);
  const syncing = useRef(false);
  const hasHydrated = useRef(false); // true only after a SUCCESSFUL full hydration
  // Which dataRequirementsFor slices have actually been fetched successfully.
  // Zero-critical first routes (auth screens, /shops/:slug) mark the app
  // "hydrated" with NO store data; without this ledger a later client-side hop
  // to a data-hungry route would assume everything is warm and render an empty
  // catalogue forever (Phase 23 — "No gifts match these filters" bug).
  const hydratedSlicesRef = useRef(new Set());
  const lastSyncAt = useRef(0);
  const refreshTimer = useRef(null);
  const pendingRef = useRef(null); // { scope, slices } arriving while a sync runs

  // Phase 20.5 — slices owed to the background once the current route is
  // usable. Started by `finally` so this hydration can never gate rendering.
  const deferredBackgroundRef = useRef(null);

  /**
   * Phase 20.5 — first hydration, scoped to the route.
   * Runs the CRITICAL slices of the current route only, all in parallel, and
   * all-or-nothing: a critical slice failing is a real "this route has no
   * data" condition and is surfaced through the error state (never faked).
   */
  const hydrateCritical = async (slices) => {
    const tasks = [];
    if (slices.includes('products')) tasks.push(boundedSlice(refreshProducts(), 'the catalogue'));
    if (slices.includes('collections')) tasks.push(boundedSlice(refreshCollections(), 'the collections'));
    if (slices.includes('settings')) tasks.push(boundedSlice(refreshSettings(), 'the studio settings'));
    if (slices.includes('identity')) tasks.push(boundedSlice(refreshProfile(), 'your account'));
    if (slices.includes('orders')) tasks.push(boundedSlice(refreshOrders(), 'your orders'));
    if (slices.includes('customers')) tasks.push(boundedSlice(refreshCustomers(), 'the customer list'));
    if (slices.includes('inventory')) tasks.push(boundedSlice(refreshInventory(), 'the inventory'));
    if (slices.includes('analytics')) tasks.push(boundedSlice(refreshAnalytics(), 'the analytics'));
    await Promise.all(tasks);
    // Success ⇒ every requested slice is now warm (Promise.all is all-or-nothing).
    slices.forEach((s) => hydratedSlicesRef.current.add(s));
  };

  // LEVEL 4 — refresh only the slices a mutation actually touched.
  const runSlices = async (slices) => {
    const admin = hasAdminSessionScope();
    const customer = hasCustomerSessionScope();
    const wants = (s) => slices.includes(s);
    const tasks = [];
    // Labels parallel `tasks` so a SUCCESSFUL slice joins the hydration ledger
    // (a rejected one stays missing and is retried on the next route check).
    const labels = [];
    const push = (label, promise) => { labels.push(label); tasks.push(promise); };
    if (wants('products')) push('products', refreshProducts()); // admin scope keeps Hidden
    if (wants('collections')) push('collections', refreshCollections()); // admin scope keeps Hidden
    if (wants('settings')) push('settings', refreshSettings());
    if (wants('orders')) push('orders', refreshOrders());
    if (wants('inventory')) {
      push('inventory', refreshInventory());
      // Phase 20.2 — availability is embedded on catalogue products, so an
      // inventory change must also refresh the products slice; otherwise the
      // customer storefront keeps showing stale stock after an admin adjust.
      push('products', refreshProducts());
    }
    if (wants('customers') && admin) push('customers', refreshCustomers());
    if (admin && (wants('orders') || wants('inventory') || wants('analytics'))) {
      push('analytics', refreshAnalytics()); // KPIs affected by orders/stock — once
    }
    if (wants('profile') && customer && !admin) push('orders', hydrateCustomer());
    // Phase 20.5 — identity without the order list (shell/saved-address only).
    if (wants('identity') && customer && !admin) push('identity', refreshProfile());
    const results = await Promise.allSettled(tasks);
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') hydratedSlicesRef.current.add(labels[i]);
    });
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
    // An AUTH-scope refresh must survive being coalesced into an in-flight
    // sync — it is the login/logout/account-switch transition, and losing it
    // (downgrading it to a silent background refresh) would leave the previous
    // identity's error classification on screen after a successful login.
    const auth = !!(cur.auth || next.auth || scope === 'auth');
    let slices = null;
    if (cur.slices && next.slices) {
      slices = [...new Set([...cur.slices, ...next.slices])];
    }
    pendingRef.current = { scope, slices, auth };
  };

  const runSync = async ({ force = false, silent = false, slices = null, auth = false } = {}) => {
    if (syncing.current) {
      mergePending({ force: true, silent, slices, auth });
      return;
    }
    if (!force && hasHydrated.current) return;
    // Pre-hydration everything becomes a full hydration — the app needs the
    // complete dataset once before targeted refreshes make sense.
    const effSlices = hasHydrated.current ? slices : null;
    // Captured BEFORE any request: a 401 clears the stored markers, but the
    // redirect target must reflect the session that actually failed — its
    // PORTAL, so a refused Owner returns to /owner/login and a handler to
    // /staff/login instead of one portal's login screen standing in for all.
    const adminSession = hasAdminSessionScope();
    const ownerSession = adminSession && sessionIsOwner();
    const adminPortal = adminSession ? portalForSession(getAdminSession()) : null;
    // LEVEL 1 only when we have never produced usable data; afterwards every
    // sync is a LEVEL 4 background refresh that must keep the UI visible.
    // AUTH transitions (login/logout/account switch) are deliberately NOT
    // background: the previous identity's classification (a suspended or
    // refused account-state screen) must be dropped and re-evaluated under
    // the NEW identity, and the documented bootstrap loader may re-show.
    const background = silent || (hasHydrated.current && !auth);
    syncing.current = true;
    if (!background) {
      setStatus('loading');
      // A fresh first-pass hydration must not carry a stale classification
      // forward (e.g. Retry after an outage, or after an account suspension).
      setError('');
      setErrorInfo(null);
    }
    try {
      if (effSlices && effSlices.length) {
        await runSlices(effSlices);
        lastSyncAt.current = Date.now();
        setStatus('ready'); // no-op when already ready
      } else if (!hasHydrated.current) {
        // ── Phase 20.5 — route-scoped first hydration ────────────────────
        // Only the slices this route actually reads are on the critical path;
        // the rest is queued for the background (see `finally`).
        const plan = dataRequirementsFor(location.pathname, {
          hasAdminSession: adminSession,
          hasCustomerSession: hasCustomerSessionScope(),
          isOwner: ownerSession,
          permissions: adminSession ? staffPermissionsForPlan() : null,
        });
        await hydrateCritical(plan.critical);
        if (!hasCustomerSessionScope() && !adminSession) clearSessionData();
        hasHydrated.current = true;
        lastSyncAt.current = Date.now();
        setStatus('ready');
        if (plan.background.length) deferredBackgroundRef.current = plan.background;
      } else {
        // A later auth-scope change (login/logout) still re-hydrates the whole
        // dataset for the new session — unchanged Phase 18.5.2 behaviour.
        await hydratePublic();
        const admin = adminSession;
        const customer = hasCustomerSessionScope();
        // GRANULAR STAFF ACCESS — a granular handler must not have the full
        // console hydration fire requests their role is denied.
        // OWNER — the platform Owner (workspaceId=null) is never a workspace
        // member: the workspace-scoped console requests are refused with 403
        // WORKSPACE_REQUIRED, so they are not asked for at all. The Owner's
        // portal pages fetch their own owner-API data in-component.
        if (admin && !ownerSession) await hydrateAdmin({ permissions: staffPermissionsForPlan() });
        if (customer && !admin) await hydrateCustomer();
        if (!customer && !admin) clearSessionData();
        // Full hydration warms the standard ledger for the new session.
        ['products', 'collections', 'settings'].forEach((s) => hydratedSlicesRef.current.add(s));
        if (admin && !ownerSession) ['orders', 'customers', 'inventory', 'analytics', 'identity'].forEach((s) => hydratedSlicesRef.current.add(s));
        if (customer && !admin) ['orders', 'identity'].forEach((s) => hydratedSlicesRef.current.add(s));
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
        const target = adminPortal ? loginPathForPortal(adminPortal) : '/login';
        if (location.pathname !== target) navigate(target, { replace: true });
        hasHydrated.current = true;
        setStatus('ready');
        return;
      }
      if (!auth && (silent || hasHydrated.current)) {
        // Background refresh failure must never nuke the page the user is
        // looking at. The store keeps its last confirmed data; the mutation
        // itself already reported success/failure at the action level.
        // An AUTH transition is exempt: its state belongs to the NEW identity,
        // so a failure must be classified for that identity instead of
        // silently leaving the previous identity's screen (or a stale
        // 'ready') on a route the new identity may not reach.
        console.error('[data] background sync failed', err);
        return;
      }
      console.error('[data] hydration failed', err);
      setError(err.message || 'Unable to load data from the server.');
      setErrorInfo({
        status: (err && err.status) || 0,
        code: (err && err.code) || null,
        // WHICH session failed — a suspended customer and a suspended staff
        // member need different login destinations, so the route gate cannot
        // guess this from the error code alone.
        scope: adminSession ? 'staff' : hasCustomerSessionScope() ? 'customer' : 'guest',
      });
      setStatus('error');
    } finally {
      syncing.current = false;
      // Phase 20.5 — the current route is usable NOW; hydrate what is left
      // without a debounce (the boot remainder must not wait behind the
      // mutation-coalescing window) and strictly in the background: runSlices
      // logs failures and can never touch `status`.
      if (deferredBackgroundRef.current) {
        const rest = deferredBackgroundRef.current;
        deferredBackgroundRef.current = null;
        runSlices(rest).catch(() => { /* background only */ });
      }
      const p = pendingRef.current;
      if (p) {
        pendingRef.current = null;
        schedule({ force: true, silent: !p.auth, slices: p.slices, auth: !!p.auth });
      }
    }
  };

  // Schedule a background sync: coalesce bursts (350ms) and keep a minimum
  // gap between full re-hydrations. Auth-scope changes run immediately.
  const schedule = ({ force = true, silent = true, slices = null, auth = false }) => {
    if (!silent) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      runSync({ force, silent, slices, auth });
      return;
    }
    clearTimeout(refreshTimer.current);
    const elapsed = Date.now() - lastSyncAt.current;
    const delay = Math.max(REFRESH_DEBOUNCE_MS, MIN_SYNC_GAP_MS - elapsed);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      runSync({ force, silent, slices, auth });
    }, delay);
  };

  // Phase 23 — ROUTE-CHANGE CRITICAL BACKFILL.
  // Hydration only ever ran for the FIRST route (mount + refresh signals).
  // Landing on a zero-critical route (auth screens, /shops/:slug) therefore
  // left store.products empty while `hasHydrated` stayed true — a client-side
  // hop to /shop then rendered the empty "No gifts match these filters" state
  // forever, because nothing ever fetched again. Re-check the plan on every
  // navigation: any critical slice the ledger has not seen is fetched now,
  // with the route gated on its loading state — and a FAILURE surfaces the
  // honest error state (never a silent empty grid). The backend stays
  // authoritative: this only ensures the route's own declared requirements
  // are met, using the same session-scoped refreshers as first hydration.
  const backfillingRef = useRef(null);
  useEffect(() => {
    if (!hasHydrated.current) return; // the first hydration owns the initial route
    // Captured BEFORE any backfill request: a 401 clears the stored session,
    // so the redirect target must reflect the portal that actually failed.
    const adminNow = hasAdminSessionScope();
    const adminPortalNow = adminNow ? portalForSession(getAdminSession()) : null;
    const plan = dataRequirementsFor(location.pathname, {
      hasAdminSession: adminNow,
      hasCustomerSession: hasCustomerSessionScope(),
      isOwner: adminNow && sessionIsOwner(),
      permissions: adminNow ? staffPermissionsForPlan() : null,
    });
    const missing = plan.critical.filter((s) => !hydratedSlicesRef.current.has(s));
    if (!missing.length) {
      // Auth-class and other zero-critical routes never wait on the store —
      // a leftover error state from the PREVIOUS route must not follow the
      // user there (the new route reports its own errors).
      if (status === 'error') {
        setError('');
        setErrorInfo(null);
        setStatus('ready');
      }
      return;
    }
    const key = location.pathname + missing.join(',');
    if (backfillingRef.current === key) return;
    backfillingRef.current = key;
    setStatus('loading'); // gate the route content until its critical slices land
    (async () => {
      try {
        await hydrateCritical(missing); // all-or-nothing; records the ledger
        if (backfillingRef.current !== key) return; // a newer route took over
        setStatus('ready');
      } catch (err) {
        if (backfillingRef.current !== key) return; // a newer route took over
        if (err && err.status === 401) {
          const target = adminPortalNow ? loginPathForPortal(adminPortalNow) : '/login';
          if (location.pathname !== target) navigate(target, { replace: true });
          setStatus('ready');
          return;
        }
        console.error('[data] route critical backfill failed', err);
        setError(err.message || 'Unable to load data from the server.');
        setErrorInfo({
          status: (err && err.status) || 0,
          code: (err && err.code) || null,
          scope: hasAdminSessionScope() ? 'staff' : hasCustomerSessionScope() ? 'customer' : 'guest',
        });
        setStatus('error');
      } finally {
        if (backfillingRef.current === key) backfillingRef.current = null;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

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
        // Login/logout/account switch — authoritative: re-show the loader,
        // drop the previous identity's classification, hydrate for the NEW
        // identity and classify any failure under it (see runSync).
        schedule({ force: true, silent: false, slices: null, auth: true });
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
      errorStatus: errorInfo ? errorInfo.status : 0,
      errorCode: errorInfo ? errorInfo.code : null,
      errorScope: errorInfo ? errorInfo.scope : null,
      ready: status === 'ready',
      retry: () => setTick((t) => t + 1),
    }),
    [status, error, errorInfo]
  );

  // Phase 20.5 — this provider NEVER withholds the tree. The shell (Navbar,
  // PromoBar, Footer, theme, background) must render even while the current
  // route's data is still in flight; RouteBootstrapGate gates the route
  // content alone on the `status` exposed below.
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within DataProvider');
  return ctx;
}

export { hasAdminSessionScope, hasCustomerSessionScope } from '../services/dataStore.js';
