import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search, X, Sparkles, ArrowRight } from 'lucide-react';
import gsap from 'gsap';
import ProductCard from '../components/ProductCard.jsx';
import { getProducts, isOutOfStock } from '../services/productService.js';
import { useStoreVersion } from '../hooks/useStoreVersion.js';
import { OCCASION_OPTIONS, productMatchesOccasion } from '../services/giftFinderService.js';

/**
 * Search — the collective discovery surface (Stitch V2 "Search Collective
 * Discovery" visual concept, REAL architecture underneath).
 *
 * There is no search endpoint: the catalogue is hydrated once from
 * `GET /api/products` and filtered in the browser, exactly as the rest of the
 * storefront does. So this page adds no API, no index and no facet the
 * catalogue cannot answer:
 *
 *   · the result count is the real number of matches;
 *   · "Popular searches" are suggestions the LIVE catalogue actually answers
 *     (a suggestion that matches nothing is dropped, never shown dead);
 *   · the scope pills are real filters over real product fields
 *     (availability comes from the embedded `stock`/`stockTracked`);
 *   · the occasion rail is derived from real products and links to the real
 *     shop filter.
 *
 * PHASE 1 — every result card carries the REAL shop attribution
 * (`product.shop = { slug, displayName }` from the backend) through the shared
 * ProductCard/ShopAttribution contract. Nothing is invented: a product whose
 * shop could not be resolved renders no attribution at all.
 *
 * Deliberately NOT built (the Stitch reference has them, the backend does
 * not): any "Independent Maker Studios" column, maker search, maker facets,
 * ratings and "trending" pills. No maker identity is exposed by any
 * storefront API, so none is invented here.
 */

const CANDIDATE_TAGS = [
  'Dusty Rose',
  'Pressed',
  'Ceramic Pot',
  'Heirloom',
  'Wax Seal',
  'Sunflower',
  'Gold Foil',
  'Rakhi',
  'Peony',
  'Posy',
];

const SCOPES = [
  { id: 'all', label: 'Everything' },
  { id: 'in_stock', label: 'In stock' },
  { id: 'made_to_order', label: 'Made to order' },
];

const matchesQuery = (product, q) =>
  [product.name, product.shortDescription, product.description, product.categoryLabel, product.palette, ...(product.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(q);

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') || '';

  const storeVersion = useStoreVersion();
  const catalog = useMemo(() => getProducts().filter((p) => p.visibility !== 'Hidden'), [storeVersion]);

  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState('all');

  const headerRef = useRef(null);
  const resultsRef = useRef(null);

  // Suggestions are derived from live data: keep a suggestion only when the
  // catalogue can actually answer it.
  const suggestedTags = useMemo(
    () => CANDIDATE_TAGS.filter((tag) => catalog.some((p) => matchesQuery(p, tag.toLowerCase()))),
    [catalog]
  );

  // Occasion rail — real matches only, with real counts.
  const occasions = useMemo(
    () => OCCASION_OPTIONS
      .map((o) => ({ ...o, count: catalog.filter((p) => productMatchesOccasion(p, o.id)).length }))
      .filter((o) => o.count > 0)
      .slice(0, 8),
    [catalog]
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((p) => {
      if (q && !matchesQuery(p, q)) return false;
      if (scope === 'in_stock') return !isOutOfStock(p);
      if (scope === 'made_to_order') return p.stockTracked === false;
      return true;
    });
  }, [catalog, query, scope]);

  // GSAP entrance — reduced-motion aware.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const ctx = gsap.context(() => {
      if (headerRef.current) {
        const tl = gsap.timeline({ delay: 0.1 });
        const badge = headerRef.current.querySelector('[data-search-badge]');
        const headline = headerRef.current.querySelector('[data-search-headline]');
        const input = headerRef.current.querySelector('[data-search-input]');
        const tags = headerRef.current.querySelector('[data-search-tags]');
        if (badge) tl.fromTo(badge, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power3.out' }, 0.1);
        if (headline) tl.fromTo(headline, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, 0.2);
        if (input) tl.fromTo(input, { opacity: 0, y: 12, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'power3.out' }, 0.3);
        if (tags) tl.fromTo(tags.children, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.03, ease: 'power3.out' }, 0.5);
      }
    });

    return () => ctx.revert();
  }, []);

  // Stagger results when they change.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    if (!resultsRef.current || results.length === 0) return undefined;

    const ctx = gsap.context(() => {
      const cards = resultsRef.current.querySelectorAll('article');
      gsap.fromTo(cards, { opacity: 0, y: 24, scale: 0.97 }, {
        opacity: 1, y: 0, scale: 1, duration: 0.45, stagger: 0.05, ease: 'power2.out',
      });
    });

    return () => ctx.revert();
  }, [results]);

  const syncQuery = (value) => {
    setQuery(value);
    const next = new URLSearchParams(searchParams);
    if (value) next.set('q', value);
    else next.delete('q');
    setSearchParams(next, { replace: true });
  };

  const handleTagClick = (tag) => syncQuery(tag);
  const handleClear = () => syncQuery('');

  const trimmed = query.trim();
  const hasFilters = !!trimmed || scope !== 'all';

  // One grid definition, adapted to how many matches actually exist so a
  // narrow result set never renders a half-empty row (same rule the shop grid
  // uses).
  const resultsGridClass =
    results.length === 1
      ? 'grid-cols-1 max-w-[420px] mx-auto'
      : results.length === 2
        ? 'grid-cols-2'
        : results.length === 3
          ? 'grid-cols-2 sm:grid-cols-3'
          : 'grid-cols-2 lg:grid-cols-4';

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen py-8 lg:py-14 relative overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="absolute top-20 left-1/3 w-64 h-64 bg-[#964735]/6 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-20 right-1/3 w-48 h-48 bg-[#c17c74]/6 rounded-full blur-[100px] pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        {/* ═══ Search header ═══ */}
        <div ref={headerRef} className="max-w-3xl mx-auto text-center space-y-5 sm:space-y-6 mb-10 lg:mb-12">
          <span data-search-badge className="inline-flex items-center gap-2 text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
            <span className="w-2 h-2 rounded-full bg-[#964735]" aria-hidden="true" />
            Collective Discovery
          </span>
          <h1 data-search-headline className="font-serif text-[28px] sm:text-[36px] md:text-[44px] text-[var(--color-botanical-primary)] font-normal tracking-tight leading-tight">
            Find a keepsake from the collective
          </h1>

          <div data-search-input className="relative w-full">
            <input
              type="text"
              value={query}
              onChange={(e) => syncQuery(e.target.value)}
              placeholder="Search by flower, material, occasion, or gift style…"
              aria-label="Search the catalogue"
              autoFocus
              className="w-full pl-12 pr-12 py-4 rounded-full bg-[var(--color-surface-lowest)] text-[14px] sm:text-[15px] border border-[var(--color-botanical-border)] shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)] transition-all"
            />
            <Search className="w-5 h-5 text-[var(--color-botanical-subtle)] absolute left-5 top-1/2 -translate-y-1/2" aria-hidden="true" />
            {query && (
              <button
                type="button"
                onClick={handleClear}
                className="absolute right-5 top-1/2 -translate-y-1/2 text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] transition-colors touch-target"
                aria-label="Clear search"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Scope — real filters over real product fields */}
          <div className="flex flex-wrap items-center justify-center gap-2" role="group" aria-label="Filter results by availability">
            {SCOPES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setScope(s.id)}
                aria-pressed={scope === s.id}
                className={`px-3.5 py-2 rounded-full text-[12px] font-semibold min-h-[44px] transition-colors ${
                  scope === s.id
                    ? 'bg-[var(--color-btn)] text-white'
                    : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] border border-[var(--color-botanical-border)] hover:text-[var(--color-botanical-primary)]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* Popular searches — only suggestions the catalogue can answer */}
          {suggestedTags.length > 0 && (
            <div data-search-tags className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <span className="text-[12px] text-[var(--color-botanical-subtle)] font-semibold hidden sm:inline">Popular Searches:</span>
              {suggestedTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleTagClick(tag)}
                  className="px-3 sm:px-3.5 py-1 rounded-full bg-[var(--color-surface-lowest)] text-[11px] sm:text-[12px] text-[var(--color-botanical-muted)] border border-[var(--color-botanical-border)] hover:border-[var(--color-focus)] hover:text-[var(--color-botanical-primary)] transition-colors touch-target"
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ═══ Live result summary ═══ */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-botanical-border)] pb-4 mb-6 lg:mb-8">
          <span className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)]" aria-live="polite">
            {hasFilters ? (
              <span>
                {results.length} {results.length === 1 ? 'creation' : 'creations'}
                {trimmed && <> for &ldquo;<strong className="text-[var(--color-botanical-primary)]">{trimmed}</strong>&rdquo;</>}
              </span>
            ) : (
              <span>
                {results.length} {results.length === 1 ? 'creation' : 'creations'} in the collective catalogue
              </span>
            )}
          </span>
          <span className="text-[11px] uppercase font-bold text-[var(--color-botanical-subtle)] hidden sm:inline">
            All Prices in ₹ INR
          </span>
        </div>

        {/* ═══ Results ═══ */}
        {results.length > 0 ? (
          <div ref={resultsRef} className={`grid gap-4 sm:gap-6 ${resultsGridClass}`}>
            {results.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        ) : (
          <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-8 sm:p-12 text-center border border-[var(--color-botanical-border)] max-w-lg mx-auto space-y-4">
            <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-2xl" aria-hidden="true">
              🔍
            </div>
            <h3 className="font-serif text-[20px] sm:text-[22px] text-[var(--color-botanical-primary)]">
              Nothing matches{trimmed ? <> &ldquo;{trimmed}&rdquo;</> : ' these filters'}
            </h3>
            <p className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)]">
              Try a broader keyword such as &ldquo;rose&rdquo;, &ldquo;card&rdquo; or &ldquo;pot&rdquo;, or widen the availability filter.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <button
                onClick={() => { handleClear(); setScope('all'); }}
                className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors touch-target"
              >
                Clear search
              </button>
              <Link
                to="/gift-finder"
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors touch-target"
              >
                <Sparkles className="w-4 h-4 text-[var(--color-accent)]" aria-hidden="true" />
                Try Gift Finder
              </Link>
            </div>
          </div>
        )}

        {/* ═══ Shop by occasion — real matches, real destinations ═══ */}
        {occasions.length > 0 && (
          <section className="pt-14 sm:pt-16">
            <div className="flex items-end justify-between gap-4 mb-4">
              <div>
                <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Gift with intention</span>
                <h2 className="font-serif text-[20px] sm:text-[24px] text-[var(--color-botanical-primary)]">Shop by occasion</h2>
              </div>
              <Link to="/gift-finder" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:text-[var(--color-accent)] transition-colors shrink-0">
                <span>Gift Finder</span>
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </Link>
            </div>
            <div className="flex flex-wrap gap-2">
              {occasions.map((o) => (
                <Link
                  key={o.id}
                  to={`/shop?occasion=${o.id}`}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] hover:border-[var(--color-border-strong)] transition-colors min-h-[44px]"
                >
                  <span aria-hidden="true">{o.icon}</span>
                  {o.label}
                  <span className="opacity-70">{o.count}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
