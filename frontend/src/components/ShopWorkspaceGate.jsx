import React, { useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { CloudOff, RotateCw } from 'lucide-react';
import { getShop } from '../services/shopService.js';
import { setTenant } from '../services/tenantContext.js';
import NotFoundPage from '../pages/NotFoundPage.jsx';

/**
 * Phase 22.4 — SHOP WORKSPACE RESOLVER (the /shops/:workspaceSlug gate).
 *
 * The public address of a client workspace. This gate does exactly one job:
 * resolve the path segment through GET /api/shops/:slug and either
 *   · render the outlet with the resolved shop identity (via router context),
 *     or
 *   · collapse to the storefront's standard not-found page on 404
 *     (unknown, suspended, malformed or reserved slugs all look identical —
 *      existence is never disclosed), or
 *   · show an honest retry state when the network fails.
 *
 * Phase 22.5 (documented, deferred): per-shop catalogue hydration (products,
 * collections, settings) will branch from this resolved identity inside
 * DataContext — the gate already publishes the slug/name the hydrator needs.
 * Until then the shop page renders the resolved identity and states plainly
 * that the catalogue view follows in the next phase; nothing is silently
 * faked.
 */

export default function ShopWorkspaceGate() {
  const { workspaceSlug } = useParams();
  const [state, setState] = useState('loading'); // loading | ready | missing | error
  const [shop, setShop] = useState(null);

  // Phase 22.5 — the resolved shop slug becomes the browser tenant context so
  // the cart/wishlist/caches are namespaced per workspace. It is reset when the
  // shopper leaves the workspace address. Navigation context only, never
  // authorization (the backend re-resolves the slug on every request).
  useEffect(() => {
    setTenant(workspaceSlug);
    return () => setTenant(null);
  }, [workspaceSlug]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setShop(null);
    (async () => {
      try {
        const res = await getShop(workspaceSlug);
        if (cancelled) return;
        if (res.ok && res.shop) {
          setShop(res.shop);
          setState('ready');
        } else if (res.status === 404) {
          setState('missing');
        } else {
          setState('error');
        }
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceSlug]);

  // PHASE 2 — the resolver state fills the viewport (`min-h-screen`). At 60vh
  // the footer was still visible while the shop resolved, so the whole footer
  // band shifted down when the real page arrived (a measured 0.75 CLS on
  // /shops/:slug). Reserving the viewport keeps everything below the fold until
  // there is content to show.
  if (state === 'loading') {
    return (
      <div className="w-full min-h-screen flex flex-col items-center justify-center gap-4 bg-[var(--color-surface-bg)]" role="status" aria-live="polite">
        <span
          className="w-7 h-7 border-2 border-[var(--color-botanical-subtle)]/30 border-t-[var(--color-botanical-subtle)] rounded-full animate-spin"
          aria-hidden="true"
        />
        <p className="text-[14px] text-[var(--color-botanical-muted)]">
          Opening <span className="font-mono">/shops/{workspaceSlug}</span>…
        </p>
      </div>
    );
  }

  // Unknown · suspended · reserved · malformed → one indistinguishable 404.
  if (state === 'missing') {
    return <NotFoundPage />;
  }

  if (state === 'error') {
    return (
      <div className="w-full min-h-[60vh] flex items-center justify-center p-6 bg-[var(--color-surface-bg)]">
        <div
          role="alert"
          className="max-w-md w-full bg-[var(--color-surface-lowest)] rounded-3xl p-8 border border-[var(--color-botanical-border)] shadow-lg text-center space-y-4"
        >
          <CloudOff className="w-8 h-8 mx-auto text-[var(--color-danger)]" aria-hidden="true" strokeWidth={1.5} />
          <h1 className="font-serif text-[26px] leading-8 text-[var(--color-botanical-primary)]">
            Could not reach this shop
          </h1>
          <p className="text-[14px] leading-6 text-[var(--color-botanical-muted)]">
            We could not verify this shop address. Please check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--color-btn)] text-white px-6 py-3 text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-all"
          >
            <RotateCw className="w-4 h-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Ready → hand the resolved identity to the child route (router context).
  return <Outlet context={{ shop }} />;
}
