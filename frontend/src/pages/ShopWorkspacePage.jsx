import React, { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import ProductCard from '../components/ProductCard.jsx';
import {
  getShopProducts,
  getShopCollections,
  getShopSettings,
} from '../services/shopService.js';

/**
 * PHASE 1 — PUBLIC SHOP PAGE (/shops/:slug).
 *
 * The resolver (ShopWorkspaceGate) has already verified the slug, so this page
 * hydrates the RESOLVED shop's own catalogue through the shop-scoped public
 * endpoints: products, collections and the public settings slice. It never
 * reads the global storefront store and never trusts a client-supplied
 * workspaceId — the slug is the only tenant input, and the backend resolves it.
 *
 * CUSTOMER-FACING LANGUAGE: the one term is **Shop** (the internal word
 * "workspace" never appears to a customer). Every value rendered here is REAL
 * backend data — the shop's display name, its address, its products and its
 * collections. Nothing is invented: no biography, no artisan story, no rating,
 * no badge, no follower count, no statistic the backend does not have.
 *
 * Only public data is rendered: no inventory quantities, no staff, no
 * customers, no analytics, no internal configuration.
 */


export default function ShopWorkspacePage() {
  // The route parameter keeps its Phase 22 name; customer-facing text never
  // calls it a workspace.
  const { workspaceSlug } = useParams();
  const { shop } = useOutletContext() || {};
  const [state, setState] = useState('loading'); // loading | ready | missing | error
  const [data, setData] = useState({ products: [], collections: [], settings: null });

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const [p, c, s] = await Promise.all([
          getShopProducts(workspaceSlug),
          getShopCollections(workspaceSlug),
          getShopSettings(workspaceSlug),
        ]);
        if (cancelled) return;
        if (!p.ok && p.status === 404) {
          setState('missing');
          return;
        }
        if (!p.ok) {
          setState('error');
          return;
        }
        setData({
          products: p.products || [],
          collections: c.collections || [],
          settings: s.settings || null,
        });
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceSlug]);

  const name = shop?.displayName || data.settings?.storeName || workspaceSlug || 'Shop';
  const slug = shop?.slug || workspaceSlug;

  if (state === 'loading') {
    return (
      <div className="w-full min-h-[60vh] flex flex-col items-center justify-center gap-4 bg-[var(--color-surface-bg)]" role="status" aria-live="polite">
        <span className="w-7 h-7 border-2 border-[var(--color-botanical-subtle)]/30 border-t-[var(--color-botanical-subtle)] rounded-full animate-spin" aria-hidden="true" />
        <p className="text-[14px] text-[var(--color-botanical-muted)]">
          Loading <span className="font-mono">/shops/{slug}</span>…
        </p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="w-full min-h-[60vh] flex items-center justify-center p-6 bg-[var(--color-surface-bg)]">
        <div role="alert" className="max-w-md w-full bg-[var(--color-surface-lowest)] rounded-3xl p-8 border border-[var(--color-botanical-border)] shadow-lg text-center space-y-4">
          <span className="material-symbols-outlined text-[34px] text-[var(--color-danger)]">cloud_off</span>
          <h1 className="font-serif text-[26px] leading-8 text-[var(--color-botanical-primary)]">Could not reach this shop</h1>
          <p className="text-[14px] leading-6 text-[var(--color-botanical-muted)]">
            We could not load this shop&rsquo;s catalogue. Please check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--color-btn)] text-white px-6 py-3 text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-all"
          >
            <span className="material-symbols-outlined text-[17px]">refresh</span>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-[70vh] py-12 sm:py-16 relative overflow-hidden">
      <div className="absolute -top-20 -right-20 w-96 h-96 rounded-full bg-[var(--color-badge-bg)]/10 blur-3xl pointer-events-none" />
      <div className="absolute top-1/3 -left-24 w-80 h-80 rounded-full bg-[var(--color-botanical-sage-light)]/10 blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-6xl mx-auto px-4 sm:px-6 space-y-10">
        <header className="text-center space-y-3">
          <span className="inline-flex items-center gap-2 bg-[var(--color-surface-high)] px-3.5 py-1 rounded-full">
            <span className="material-symbols-outlined text-[15px] text-[var(--color-accent)]" style={{ fontVariationSettings: "'FILL' 1" }}>storefront</span>
            <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--color-accent)]">Shop</span>
          </span>
          <h1 className="font-serif text-[36px] leading-[44px] tracking-[-0.015em] text-[var(--color-botanical-primary)]">{name}</h1>
          <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] max-w-xl mx-auto">
            {data.settings?.storeTagline ? `${data.settings.storeTagline} · ` : ''}
            <span className="font-mono text-[14px] font-semibold text-[var(--color-botanical-text)]">/shops/{slug}</span>
          </p>
        </header>

        {data.collections.length > 0 && (
          <section aria-label="Collections" className="space-y-4">
            <h2 className="font-serif text-[22px] text-[var(--color-botanical-primary)] text-center">Collections</h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {data.collections.map((c) => (
                <li key={c.slug} className="bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)] p-5 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px] text-[var(--color-accent)]">local_florist</span>
                    <h3 className="font-serif text-[17px] text-[var(--color-botanical-primary)]">{c.name}</h3>
                  </div>
                  {c.description && (
                    <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] line-clamp-2">{c.description}</p>
                  )}
                  <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">
                    {(c.productSlugs || []).length} piece{(c.productSlugs || []).length === 1 ? '' : 's'}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="Products">
          {data.products.length === 0 ? (
            <div className="text-center py-14 rounded-2xl border border-dashed border-[var(--color-botanical-border)]">
              <span className="material-symbols-outlined text-[34px] text-[var(--color-botanical-muted)]">inventory_2</span>
              <p className="mt-2 text-[14px] text-[var(--color-botanical-muted)]">This shop has no published products yet.</p>
            </div>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6 list-none p-0 m-0">
              {data.products.map((p) => (
                <li key={p.slug} className="list-none">
                  <ProductCard variant="shop-context" product={p} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
