import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search, X, ArrowUpDown, Sprout, ArrowRight } from 'lucide-react';
import ProductCard from '../components/ProductCard.jsx';
import { getProducts, isOutOfStock } from '../services/productService.js';
import { useStoreVersion } from '../hooks/useStoreVersion.js';
import { gsap, prefersReducedMotion } from '../lib/gsapSetup.js';

/**
 * PHASE 2 — SEARCH (/search): a UTILITY, not a landing page.
 *
 * Structure: heading → input → filters / sort → result count → compact
 * canonical grid. When nothing matches, the page offers real recovery
 * (clear the filters, browse the shop, and the catalogue's own categories) —
 * never a fabricated product or an invented "popular" item.
 *
 * There is no search endpoint: the catalogue is hydrated once from
 * `GET /api/products` and filtered in the browser, exactly as the rest of the
 * storefront does. So this page adds no API, no index and no facet the
 * catalogue cannot answer:
 *
 *   · the result count is the real number of matches;
 *   · the suggestions are keywords the LIVE catalogue actually answers
 *     (a suggestion that matches nothing is dropped, never shown dead);
 *   · the scope pills are real filters over real product fields, and the sort
 *     is a real client-side ordering of the real result set;
 *   · the recovery categories are counted from live products.
 *
 * PHASE 1/2 — every result card carries the REAL shop attribution
 * (`product.shop = { slug, displayName }` from the backend) through the shared
 * ProductCard/ShopAttribution contract. Nothing is invented: a product whose
 * shop could not be resolved renders no attribution at all.
 *
 * Deliberately NOT built (the Stitch reference has them, the backend does
 * not): any "Independent Maker Studios" column, maker search, maker facets,
 * ratings and "trending" pills. No maker identity is exposed by any storefront
 * API, so none is invented here.
 *
 * Motion is Level 1: a small reveal and small transitions only.
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

const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'price-asc', label: 'Price: Low to High' },
  { value: 'price-desc', label: 'Price: High to Low' },
  { value: 'name-asc', label: 'Name: A–Z' },
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
  const [sortBy, setSortBy] = useState('relevance');

  const headerRef = useRef(null);
  const resultsRef = useRef(null);

  // Suggestions are derived from live data: keep a suggestion only when the
  // catalogue can actually answer it.
  const suggestedTags = useMemo(
    () => CANDIDATE_TAGS.filter((tag) => catalog.some((p) => matchesQuery(p, tag.toLowerCase()))),
    [catalog]
  );

  // Recovery categories — real categories, with real counts, most-stocked first.
  const categories = useMemo(() => {
    const map = new Map();
    catalog.forEach((p) => {
      if (!p.category) return;
      const existing = map.get(p.category) || { id: p.category, label: p.categoryLabel || p.category, count: 0 };
      existing.count += 1;
      map.set(p.category, existing);
    });
    return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 6);
  }, [catalog]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = catalog.filter((p) => {
      if (q && !matchesQuery(p, q)) return false;
      if (scope === 'in_stock') return !isOutOfStock(p);
      if (scope === 'made_to_order') return p.stockTracked === false;
      return true;
    });
    // A real ordering of the real result set — the catalogue's own order is
    // "Relevance" because there is no ranking signal to invent one from.
    if (sortBy === 'price-asc') return [...matched].sort((a, b) => (a.price || 0) - (b.price || 0));
    if (sortBy === 'price-desc') return [...matched].sort((a, b) => (b.price || 0) - (a.price || 0));
    if (sortBy === 'name-asc') return [...matched].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return matched;
  }, [catalog, query, scope, sortBy]);

  // GSAP entrance — Level 1, reduced-motion aware.
  useEffect(() => {
    if (typeof window === 'undefined' || prefersReducedMotion()) return undefined;

    const ctx = gsap.context(() => {
      if (headerRef.current) {
        gsap.fromTo(
          headerRef.current.children,
          { opacity: 0, y: 8 },
          { opacity: 1, y: 0, duration: 0.35, stagger: 0.06, ease: 'power2.out' }
        );
      }
    });

    return () => ctx.revert();
  }, []);

  // Stagger results when they change — small, never blocking.
  useEffect(() => {
    if (typeof window === 'undefined' || prefersReducedMotion()) return undefined;
    if (!resultsRef.current || results.length === 0) return undefined;

    const ctx = gsap.context(() => {
      const cards = resultsRef.current.querySelectorAll('article');
      gsap.fromTo(cards, { opacity: 0, y: 10 }, {
        opacity: 1, y: 0, duration: 0.35, stagger: 0.03, ease: 'power2.out',
        clearProps: 'transform,opacity',
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

  const handleClear = () => {
    setScope('all');
    setSearchParams({}, { replace: true });
    setQuery('');
  };

  const trimmed = query.trim();
  const hasFilters = !!trimmed || scope !== 'all';

  // The catalogue rhythm — plus one honest override when a two-piece result set
  // would otherwise leave a visibly broken row.
  const resultsGridClass =
    results.length === 1
      ? 'grid-cols-1 max-w-[420px] mx-auto'
      : results.length === 2
        ? 'grid-cols-2 md:grid-cols-3'
        : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4';

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen pt-8 pb-16 sm:pt-10 sm:pb-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* ═══ HEADING + INPUT ═══ */}
        <div ref={headerRef} className="max-w-2xl space-y-4">
          <h1 className="font-serif text-[26px] sm:text-[32px] leading-[1.1] tracking-tight font-normal text-[var(--color-botanical-primary)]">
            Search the catalogue
          </h1>

          <div className="relative w-full">
            <input
              type="text"
              value={query}
              onChange={(e) => syncQuery(e.target.value)}
              placeholder="Search by flower, material, occasion, or gift style…"
              aria-label="Search the catalogue"
              autoFocus
              className="w-full pl-12 pr-12 py-3.5 rounded-full bg-[var(--color-surface-lowest)] text-[14px] sm:text-[15px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)] transition-shadow min-h-[44px]"
            />
            <Search className="w-5 h-5 text-[var(--color-botanical-subtle)] absolute left-5 top-1/2 -translate-y-1/2" aria-hidden="true" />
            {query && (
              <button
                type="button"
                onClick={() => syncQuery('')}
                className="absolute right-4 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-full text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] transition-colors"
                aria-label="Clear search"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Suggestions — only keywords the live catalogue can answer */}
          {suggestedTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-[12px] text-[var(--color-botanical-subtle)] font-semibold">Try:</span>
              {suggestedTags.slice(0, 6).map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => syncQuery(tag)}
                  className="inline-flex items-center min-h-[24px] text-[12px] text-[var(--color-botanical-muted)] hover:text-[var(--color-accent)] underline decoration-transparent hover:decoration-current transition-colors"
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ═══ FILTERS + SORT + COUNT ═══ */}
        <div className="mt-6 flex flex-wrap items-center gap-2 sm:gap-3 pb-5 border-b border-[var(--color-botanical-border)]">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter results by availability">
            {SCOPES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setScope(s.id)}
                aria-pressed={scope === s.id}
                className={`inline-flex items-center px-3.5 py-2 rounded-full text-[12px] font-semibold whitespace-nowrap min-h-[44px] border transition-colors ${
                  scope === s.id
                    ? 'bg-[var(--color-surface-highest)] text-[var(--color-botanical-primary)] border-[var(--color-border-strong)]'
                    : 'bg-transparent text-[var(--color-botanical-subtle)] border-transparent hover:text-[var(--color-botanical-primary)] hover:border-[var(--color-botanical-border)]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {results.length > 1 && (
            <div className="relative shrink-0 ml-auto">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                aria-label="Sort results"
                className="pl-3 pr-8 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[13px] font-medium text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] appearance-none cursor-pointer min-h-[44px]"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <ArrowUpDown className="w-3.5 h-3.5 text-[var(--color-botanical-subtle)] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            </div>
          )}

          <p
            aria-live="polite"
            className={`text-[12px] text-[var(--color-botanical-muted)] tabular-nums ${results.length > 1 ? '' : 'ml-auto'}`}
          >
            {hasFilters ? (
              <>
                {results.length} {results.length === 1 ? 'piece' : 'pieces'}
                {trimmed && <> for &ldquo;<strong className="font-semibold text-[var(--color-botanical-primary)]">{trimmed}</strong>&rdquo;</>}
              </>
            ) : (
              <>{results.length} {results.length === 1 ? 'piece' : 'pieces'} in the catalogue</>
            )}
          </p>

          {hasFilters && (
            <button
              type="button"
              onClick={handleClear}
              className="shrink-0 inline-flex items-center min-h-[24px] text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
            >
              Clear all
            </button>
          )}
        </div>

        {/* ═══ RESULTS ═══ */}
        {results.length > 0 ? (
          <div ref={resultsRef} className={`mt-6 grid gap-3 sm:gap-4 lg:gap-5 ${resultsGridClass}`}>
            {results.map((product) => (
              <ProductCard key={product.id || product.slug} variant="compact" product={product} />
            ))}
          </div>
        ) : (
          <div className="mt-8 max-w-xl mx-auto rounded-3xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] px-8 py-10 text-center space-y-3">
            <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center" aria-hidden="true">
              <Sprout className="w-6 h-6 text-[var(--color-botanical-sage)]" />
            </div>
            <h2 className="font-serif text-[22px] sm:text-[24px] text-[var(--color-botanical-primary)]">
              Nothing matches{trimmed ? <> &ldquo;{trimmed}&rdquo;</> : ' these filters'}
            </h2>
            <p className="text-[14px] leading-relaxed text-[var(--color-botanical-muted)]">
              Try a broader keyword such as &ldquo;rose&rdquo;, &ldquo;card&rdquo; or &ldquo;pot&rdquo;, or widen the availability filter.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleClear}
                className="inline-flex items-center px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors min-h-[44px]"
              >
                Clear search
              </button>
              <Link
                to="/shop"
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors min-h-[44px]"
              >
                Browse the shop
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </Link>
            </div>

            {categories.length > 0 && (
              <div className="pt-4 border-t border-[var(--color-botanical-border-light)]">
                <p className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] mb-2">
                  Browse a category
                </p>
                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
                  {categories.map((c) => (
                    <Link
                      key={c.id}
                      to={`/shop?category=${encodeURIComponent(c.id)}`}
                      className="inline-flex items-baseline gap-1.5 min-h-[24px] text-[13px] font-semibold text-[var(--color-botanical-text)] hover:text-[var(--color-accent)] transition-colors"
                    >
                      {c.label}
                      <span className="text-[11px] tabular-nums text-[var(--color-botanical-subtle)]">{c.count}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
