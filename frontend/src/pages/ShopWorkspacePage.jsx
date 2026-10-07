import React, { useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { ArrowDown, ArrowRight, RefreshCw, Sprout, CloudOff } from 'lucide-react';
import ProductCard from '../components/ProductCard.jsx';
import CollectionImage from '../components/CollectionImage.jsx';
import {
  getShopProducts,
  getShopCollections,
  getShopSettings,
} from '../services/shopService.js';

/**
 * PHASE 1/2 — PUBLIC SHOP PAGE (/shops/:slug).
 *
 * The resolver (ShopWorkspaceGate) has already verified the slug, so this page
 * hydrates the RESOLVED shop's own catalogue through the shop-scoped public
 * endpoints: products, collections and the public settings slice. It never
 * reads the global storefront store and never trusts a client-supplied
 * workspaceId — the slug is the only tenant input, and the backend resolves it.
 *
 * CUSTOMER-FACING LANGUAGE: the one term is **Shop** (the internal word
 * "workspace" never appears to a customer). Every value rendered here is REAL
 * backend data — the shop's display name, its products and its collections.
 *
 * PHASE 2 — the hierarchy is identity → collections → catalogue → bespoke CTA,
 * and it is deliberately restrained. There is no follower count, rating,
 * biography, location or statistic, because the public shop identity contract
 * is exactly `{ slug, displayName }`.
 *
 * `storeTagline` is deliberately NOT rendered as this shop's description: the
 * backend falls back to the platform singleton's tagline when a shop has no
 * settings of its own, so showing it could attribute platform copy to a
 * specific shop. The supporting line instead states two facts this shop's own
 * data proves — how many pieces and how many collections it publishes.
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
  const [activeCollection, setActiveCollection] = useState(null); // collection slug | null

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setActiveCollection(null);
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

  // The collection currently being browsed — real slug, real productSlugs.
  const selected = useMemo(
    () => (activeCollection ? data.collections.find((c) => c.slug === activeCollection) || null : null),
    [activeCollection, data.collections]
  );

  const visibleProducts = useMemo(() => {
    if (!selected) return data.products;
    const slugs = new Set(selected.productSlugs || []);
    return data.products.filter((p) => slugs.has(p.slug));
  }, [data.products, selected]);

  const chooseCollection = (collectionSlug) => {
    setActiveCollection((current) => (current === collectionSlug ? null : collectionSlug));
    if (typeof window !== 'undefined') {
      const target = document.getElementById('shop-catalogue');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  if (state === 'loading') {
    // A layout-reserving skeleton, not a centred spinner: the page keeps its
    // final shape, so hydrating the shop does not move the content below it.
    return (
      <div className="w-full min-h-screen bg-[var(--color-surface-bg)]" role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">Loading the shop /shops/{slug}…</span>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-14 sm:pb-20" aria-hidden="true">
          <div className="pt-8 sm:pt-12 pb-7 sm:pb-9 border-b border-[var(--color-botanical-border)] space-y-3">
            <div className="h-3 w-14 rounded bg-[var(--color-surface-high)] animate-pulse" />
            <div className="h-9 w-2/3 max-w-sm rounded bg-[var(--color-surface-highest)] animate-pulse" />
            <div className="h-3.5 w-40 rounded bg-[var(--color-surface-container)] animate-pulse" />
          </div>
          <div className="pt-8 sm:pt-10">
            <div className="h-5 w-40 rounded bg-[var(--color-surface-high)] animate-pulse mb-4" />
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 sm:gap-5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-2xl overflow-hidden bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border-light)]">
                  <div className="aspect-[4/3] bg-[var(--color-surface-highest)] animate-pulse" />
                  <div className="p-4 space-y-2">
                    <div className="h-3 w-16 rounded bg-[var(--color-surface-container)] animate-pulse" />
                    <div className="h-4 w-32 rounded bg-[var(--color-surface-high)] animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="pt-8 sm:pt-10 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4 lg:gap-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded-2xl p-2 sm:p-2.5 bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border-light)]">
                <div className="aspect-square rounded-xl bg-[var(--color-surface-highest)] animate-pulse" />
                <div className="pt-2 space-y-2">
                  <div className="h-4 w-3/4 rounded bg-[var(--color-surface-high)] animate-pulse" />
                  <div className="h-3.5 w-16 rounded bg-[var(--color-surface-container)] animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="w-full min-h-[60vh] flex items-center justify-center p-6 bg-[var(--color-surface-bg)]">
        <div role="alert" className="max-w-md w-full bg-[var(--color-surface-lowest)] rounded-3xl p-8 border border-[var(--color-botanical-border)] shadow-lg text-center space-y-4">
          <CloudOff className="w-8 h-8 mx-auto text-[var(--color-danger)]" aria-hidden="true" />
          <h1 className="font-serif text-[26px] leading-8 text-[var(--color-botanical-primary)]">Could not reach this shop</h1>
          <p className="text-[14px] leading-6 text-[var(--color-botanical-muted)]">
            We could not load this shop&rsquo;s catalogue. Please check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--color-btn)] text-white px-6 py-3 text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors min-h-[44px]"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      </div>
    );
  }

  const pieces = data.products.length;
  const collections = data.collections.length;

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-[70vh]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-14 sm:pb-20">
        {/* ═══ SHOP IDENTITY — restrained editorial introduction ═══ */}
        <header className="pt-8 sm:pt-12 pb-7 sm:pb-9 border-b border-[var(--color-botanical-border)]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
            <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">Shop</span>
          </div>
          <h1 className="mt-2 font-serif text-[32px] sm:text-[42px] lg:text-[48px] leading-[1.08] tracking-tight font-normal text-[var(--color-botanical-primary)]">
            {name}
          </h1>
          <p className="mt-2 text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)]">
            <span className="tabular-nums">{pieces}</span> {pieces === 1 ? 'piece' : 'pieces'}
            {collections > 0 && (
              <>
                {' '}
                <span aria-hidden="true" className="text-[var(--color-border-strong)]">·</span>
                {' '}
                <span className="tabular-nums">{collections}</span> {collections === 1 ? 'collection' : 'collections'}
              </>
            )}
          </p>
          {pieces > 0 && (
            <a
              href="#shop-catalogue"
              className="mt-4 inline-flex items-center gap-1.5 min-h-[24px] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:text-[var(--color-accent)] transition-colors"
            >
              Browse this shop
              <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          )}
        </header>

        {/* ═══ SHOP COLLECTIONS — mobile rail, editorial grid from sm up ═══ */}
        {collections > 0 && (
          <section aria-label="Collections" className="pt-8 sm:pt-10">
            <h2 className="font-serif text-[20px] sm:text-[24px] text-[var(--color-botanical-primary)]">Collections</h2>
            <ul className="mt-4 flex gap-4 overflow-x-auto scrollbar-none snap-x snap-mandatory -mx-4 px-4 pb-1 list-none sm:mx-0 sm:px-0 sm:pb-0 sm:grid sm:grid-cols-2 lg:grid-cols-3 sm:gap-5 sm:overflow-visible">
              {data.collections.map((c) => {
                const count = (c.productSlugs || []).length;
                const isActive = activeCollection === c.slug;
                return (
                  <li key={c.slug} className="w-[76%] shrink-0 snap-start list-none sm:w-auto">
                    <button
                      type="button"
                      onClick={() => chooseCollection(c.slug)}
                      aria-pressed={isActive}
                      className={`group w-full h-full text-left flex flex-col rounded-2xl overflow-hidden bg-[var(--color-surface-lowest)] border transition-colors duration-300 ${
                        isActive
                          ? 'border-[var(--color-border-strong)]'
                          : 'border-[var(--color-botanical-border-light)] hover:border-[var(--color-border-strong)]'
                      }`}
                    >
                      {c.image ? (
                        <div className="w-full aspect-[4/3] overflow-hidden bg-[var(--color-surface-low)]">
                          <CollectionImage src={c.image} alt={c.name} />
                        </div>
                      ) : null}
                      <div className="flex flex-1 flex-col gap-1.5 p-4">
                        <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)] tabular-nums">
                          {count} {count === 1 ? 'piece' : 'pieces'}
                        </span>
                        <h3 className="font-serif text-[17px] leading-snug text-[var(--color-botanical-primary)]">
                          {c.name}
                        </h3>
                        {c.description && (
                          <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] line-clamp-3">
                            {c.description}
                          </p>
                        )}
                        <span className="mt-auto pt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-accent)] min-h-[24px]">
                          {isActive ? 'Showing these pieces' : 'View pieces'}
                          <ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* ═══ SHOP CATALOGUE — one shop's own pieces, canonical shop-context card ═══ */}
        <section id="shop-catalogue" aria-label="Products" className="pt-8 sm:pt-10 scroll-mt-24">
          {pieces === 0 ? (
            <div className="text-center py-14 rounded-2xl border border-dashed border-[var(--color-botanical-border)]">
              <Sprout className="w-7 h-7 mx-auto text-[var(--color-botanical-sage)]" aria-hidden="true" />
              <p className="mt-2 text-[14px] text-[var(--color-botanical-muted)]">This shop has no published products yet.</p>
            </div>
          ) : (
            <>
              <div className="flex items-end justify-between gap-4 mb-4">
                <h2 className="font-serif text-[20px] sm:text-[24px] text-[var(--color-botanical-primary)]">
                  {selected ? selected.name : 'Pieces from this shop'}
                </h2>
                <span aria-live="polite" className="shrink-0 text-[12px] text-[var(--color-botanical-muted)] tabular-nums">
                  {visibleProducts.length} {visibleProducts.length === 1 ? 'piece' : 'pieces'}
                </span>
              </div>

              {selected && (
                <button
                  type="button"
                  onClick={() => setActiveCollection(null)}
                  className="mb-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[var(--color-surface-highest)] border border-[var(--color-border-strong)] text-[12px] font-semibold text-[var(--color-botanical-primary)] min-h-[44px]"
                >
                  All pieces in {name}
                </button>
              )}

              {visibleProducts.length === 0 ? (
                <div className="text-center py-12 rounded-2xl border border-dashed border-[var(--color-botanical-border)]">
                  <p className="text-[14px] text-[var(--color-botanical-muted)]">This collection has no published pieces yet.</p>
                </div>
              ) : (
                <ul className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4 lg:gap-5 list-none p-0 m-0">
                  {visibleProducts.map((p) => (
                    <li key={p.slug} className="list-none">
                      <ProductCard variant="shop-context" product={p} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        {/* ═══ BESPOKE CTA + related discovery (the collective catalogue) ═══ */}
        <section className="mt-12 sm:mt-16 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] px-6 py-6 sm:px-8 sm:py-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="font-serif text-[20px] sm:text-[22px] text-[var(--color-botanical-primary)]">
              Looking for something bespoke?
            </h2>
            <p className="mt-1 text-[13px] text-[var(--color-botanical-muted)]">
              Tell us the person and the moment — the studio can craft it, or you can browse the whole collective.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <Link
              to="/custom-request"
              className="inline-flex items-center px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors min-h-[44px]"
            >
              Request a custom piece
            </Link>
            <Link
              to="/shop"
              className="inline-flex items-center px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors min-h-[44px]"
            >
              Browse the collective
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
