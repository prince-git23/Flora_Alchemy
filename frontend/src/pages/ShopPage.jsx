import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { SlidersHorizontal, ArrowUpDown, X, Search, RotateCcw, Sprout } from 'lucide-react';
import ProductCard from '../components/ProductCard.jsx';
import { getProducts as getCatalogProducts } from '../services/productService.js';
import { useStoreVersion } from '../hooks/useStoreVersion.js';
import {
  productMatchesOccasion,
  productMatchesRecipient,
  optionLabel,
  OCCASION_OPTIONS,
  RECIPIENT_OPTIONS,
} from '../services/giftFinderService.js';
// Phase 2 — the shared module owns plugin registration and the reduced-motion
// guard, so this page does not register GSAP plugins or re-derive the media
// query on its own.
import { gsap, prefersReducedMotion } from '../lib/gsapSetup.js';

// Availability is derived from the real `stockTracked` product field — the
// storefront cannot read /api/inventory, so it never claims stock numbers.
const availabilityOf = (product) => (product.stockTracked === false ? 'made_to_order' : 'ready');
const AVAILABILITY_LABELS = { ready: 'Ready to gift', made_to_order: 'Made to order' };

const SORT_OPTIONS = [
  // 'featured' is the catalogue's own order (the API returns it
  // createdAt-ascending); it is not a curation signal, so the label says so.
  { value: 'featured', label: 'Catalogue Order' },
  { value: 'price-asc', label: 'Price: Low to High' },
  { value: 'price-desc', label: 'Price: High to Low' },
  { value: 'name-asc', label: 'Name: A–Z' },
];

export default function ShopPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialCategory = searchParams.get('category') || 'all';
  const initialOccasion = searchParams.get('occasion') || '';
  const initialRecipient = searchParams.get('recipient') || '';
  const initialAvailability = searchParams.get('availability') || 'all';

  const storeVersion = useStoreVersion();
  const catalog = useMemo(() => getCatalogProducts(), [storeVersion]);
  const maxPriceCap = Math.max(
    4000,
    Math.ceil(Math.max(0, ...catalog.map((p) => Number(p.price) || 0)) / 500) * 500
  );
  const maxPriceParam = Number(searchParams.get('maxPrice'));
  const initialMaxPrice =
    Number.isFinite(maxPriceParam) && maxPriceParam > 0
      ? Math.min(maxPriceCap, Math.max(400, maxPriceParam))
      : maxPriceCap;

  // Real, visible catalogue only — the editorial header states a live count
  // and never a fabricated one (the Stitch reference claims "16 creations ·
  // 4 maker ateliers"; neither exists here, so neither is rendered).
  //
  // The second figure is the number of distinct `Product.category` values in
  // the catalogue — a product-category count, not a maker/atelier count.
  // There is no Maker/Creator model or field in the backend.
  const visibleCatalog = useMemo(
    () => catalog.filter((p) => p.visibility !== 'Hidden'),
    [catalog]
  );

  // Counts come from the VISIBLE catalogue only — the rail never advertises a
  // number the filter cannot deliver.
  const categoryMap = visibleCatalog.reduce((acc, p) => {
    if (p.category && !acc[p.category]) {
      acc[p.category] = { id: p.category, label: p.categoryLabel || p.category, count: 0 };
    }
    if (p.category && acc[p.category]) acc[p.category].count += 1;
    return acc;
  }, {});
  const categoryOptions = [{ id: 'all', label: 'All Keepsakes', count: visibleCatalog.length }, ...Object.values(categoryMap)];

  const availabilityOptions = useMemo(() => {
    const present = new Set(catalog.filter((p) => p.visibility !== 'Hidden').map(availabilityOf));
    const options = [{ id: 'all', label: 'Any availability' }];
    if (present.has('ready')) options.push({ id: 'ready', label: AVAILABILITY_LABELS.ready });
    if (present.has('made_to_order')) options.push({ id: 'made_to_order', label: AVAILABILITY_LABELS.made_to_order });
    return options;
  }, [catalog]);

  // "Shop by Moment" only offers occasions a real product actually matches, so
  // every entry leads somewhere rather than to an empty result set.
  // Real counts too — an occasion card only appears when a live product
  // actually matches it, and it states how many do.
  const availableOccasions = useMemo(
    () => OCCASION_OPTIONS
      .map((o) => ({
        ...o,
        count: catalog.filter((p) => p.visibility !== 'Hidden' && productMatchesOccasion(p, o.id)).length,
      }))
      .filter((o) => o.count > 0),
    [catalog]
  );

  const [products, setProducts] = useState(() => getCatalogProducts());
  const [selectedCategory, setSelectedCategory] = useState(initialCategory);
  const [selectedOccasion, setSelectedOccasion] = useState(initialOccasion);
  const [selectedRecipient, setSelectedRecipient] = useState(initialRecipient);
  const [selectedAvailability, setSelectedAvailability] = useState(initialAvailability);
  const [maxPrice, setMaxPrice] = useState(initialMaxPrice);
  const [sortBy, setSortBy] = useState('featured');
  const [searchQuery, setSearchQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  // GSAP refs
  const heroRef = useRef(null);
  const gridRef = useRef(null);
  const toolbarRef = useRef(null);
  const panelRef = useRef(null);

  // Which filter surface is shown is decided by the SAME Tailwind breakpoint
  // the two surfaces are styled with (`lg:`), never by JS state — a resize
  // listener can lag a breakpoint change and mismatch the CSS. Closing the
  // panel when the breakpoint flips also releases the sheet's scroll lock.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setFiltersOpen(false);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const base = getCatalogProducts();
    const q = searchQuery.trim().toLowerCase();
    let filtered = base.filter((p) =>
      p.visibility !== 'Hidden' &&
      (selectedCategory === 'all' || p.category === selectedCategory) &&
      productMatchesOccasion(p, selectedOccasion) &&
      productMatchesRecipient(p, selectedRecipient) &&
      (selectedAvailability === 'all' || availabilityOf(p) === selectedAvailability) &&
      Number(p.price || 0) <= Number(maxPrice) &&
      (!q || [p.name, p.shortDescription, p.description, p.categoryLabel, p.palette, ...(p.tags || [])]
        .filter(Boolean).join(' ').toLowerCase().includes(q))
    );
    if (sortBy === 'price-asc') filtered = [...filtered].sort((a, b) => (a.price || 0) - (b.price || 0));
    if (sortBy === 'price-desc') filtered = [...filtered].sort((a, b) => (b.price || 0) - (a.price || 0));
    if (sortBy === 'name-asc') filtered = [...filtered].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    setProducts(filtered);
    // storeVersion is REQUIRED: the catalogue can arrive after mount.
  }, [selectedCategory, selectedOccasion, selectedRecipient, selectedAvailability, maxPrice, sortBy, searchQuery, storeVersion]);

  // Hero + toolbar entrance — GSAP, reduced-motion aware.
  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    const ctx = gsap.context(() => {
      if (heroRef.current) {
        const tl = gsap.timeline({ delay: 0.08 });
        const els = [
          [heroRef.current.querySelector('[data-hero-badge]'), 0.1],
          [heroRef.current.querySelector('[data-hero-headline]'), 0.2],
          [heroRef.current.querySelector('[data-hero-desc]'), 0.35],
        ];
        els.forEach(([el, at]) => {
          if (el) tl.fromTo(el, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, at);
        });
      }
      if (toolbarRef.current) {
        gsap.fromTo(toolbarRef.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power3.out', delay: 0.45 });
      }
    });
    return () => ctx.revert();
  }, []);

  // Animate the grid whenever the visible product set changes. The tween is
  // scoped in a gsap.context and reverted on cleanup, so a fast filter change
  // cannot stack two entrance tweens on the same cards — or leave one mid-fade.
  useEffect(() => {
    if (prefersReducedMotion() || !gridRef.current) return undefined;
    const cards = gridRef.current.querySelectorAll('article');
    if (cards.length === 0) return undefined;
    const ctx = gsap.context(() => {
      gsap.fromTo(cards, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.38, stagger: 0.03, ease: 'power2.out', clearProps: 'transform,opacity' });
    });
    return () => ctx.revert();
  }, [products]);

  // Mobile sheet only: body scroll lock + focus trap + Escape. Read the media
  // query live here so the lock can never outlive the sheet that owns it.
  useEffect(() => {
    if (!filtersOpen) return undefined;
    if (typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => {
      const sheet = panelRef.current;
      if (sheet) {
        const focusable = sheet.querySelector('input, select, button');
        if (focusable) focusable.focus();
      }
    }, 50);
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') { setFiltersOpen(false); return; }
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll('input, select, button, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = prev;
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [filtersOpen]);

  const syncParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  const handleCategoryChange = (catId) => {
    setSelectedCategory(catId);
    syncParam('category', catId === 'all' ? '' : catId);
  };

  const handleOccasionMoment = (occasionId) => {
    setSelectedOccasion(occasionId);
    syncParam('occasion', occasionId);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const clearDiscoveryFilter = (key) => {
    const next = new URLSearchParams(searchParams);
    next.delete(key);
    setSearchParams(next);
    if (key === 'occasion') setSelectedOccasion('');
    if (key === 'recipient') setSelectedRecipient('');
    if (key === 'availability') setSelectedAvailability('all');
    if (key === 'maxPrice') setMaxPrice(maxPriceCap);
  };

  const hasActiveFilters =
    selectedCategory !== 'all' ||
    !!selectedOccasion ||
    !!selectedRecipient ||
    selectedAvailability !== 'all' ||
    Number(maxPrice) < maxPriceCap ||
    !!searchQuery;

  const discoveryFilterCount =
    (selectedOccasion ? 1 : 0) +
    (selectedRecipient ? 1 : 0) +
    (selectedAvailability !== 'all' ? 1 : 0) +
    (Number(maxPrice) < maxPriceCap ? 1 : 0);

  const handleResetFilters = () => {
    setSelectedCategory('all');
    setSelectedOccasion('');
    setSelectedRecipient('');
    setSelectedAvailability('all');
    setMaxPrice(maxPriceCap);
    setSortBy('featured');
    setSearchQuery('');
    setSearchParams({});
  };

  const availabilityChipLabel =
    selectedAvailability === 'all' ? '' : AVAILABILITY_LABELS[selectedAvailability] || selectedAvailability;

  // One grid definition, adapted to how much catalogue actually exists so a
  // one- or two-product shop never renders a half-empty 4-column row.
  // PHASE 2 catalogue rhythm: mobile 2 · tablet 3 · desktop 4. The only
  // deviation is a set too small to fill the rhythm honestly — one piece, or a
  // two/three-piece set, would otherwise leave an obviously broken row.
  const gridClass =
    products.length === 1
      ? 'grid-cols-1 max-w-[420px] mx-auto'
      : products.length <= 3
        ? 'grid-cols-2 md:grid-cols-3'
        : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4';

  const filterControls = (
    <>
      {/* Price range */}
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[12px] font-semibold text-[var(--color-botanical-primary)]">
          <span>Maximum Price</span>
          <span className="text-[var(--color-accent)] font-bold">₹{Number(maxPrice).toLocaleString('en-IN')}</span>
        </div>
        <input
          type="range"
          min="400"
          max={maxPriceCap}
          step="50"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          aria-label="Maximum price"
          className="w-full accent-[var(--color-accent)] cursor-pointer"
        />
        <div className="flex items-center justify-between text-[10px] text-[var(--color-botanical-subtle)] font-bold uppercase">
          <span>₹400</span>
          <span>₹{maxPriceCap.toLocaleString('en-IN')}+</span>
        </div>
      </div>

      {/* Occasion */}
      <div className="space-y-2 pt-2 border-t border-[var(--color-botanical-border)]">
        <label htmlFor="filter-occasion" className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] block">
          Shop by Occasion
        </label>
        <select
          id="filter-occasion"
          value={selectedOccasion}
          onChange={(e) => { setSelectedOccasion(e.target.value); syncParam('occasion', e.target.value); }}
          className="w-full px-4 py-2.5 rounded-full bg-[var(--color-surface-bg)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] cursor-pointer min-h-[44px]"
        >
          <option value="">Any occasion</option>
          {OCCASION_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Recipient */}
      <div className="space-y-2">
        <label htmlFor="filter-recipient" className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] block">
          Shop for Someone
        </label>
        <select
          id="filter-recipient"
          value={selectedRecipient}
          onChange={(e) => { setSelectedRecipient(e.target.value); syncParam('recipient', e.target.value); }}
          className="w-full px-4 py-2.5 rounded-full bg-[var(--color-surface-bg)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] cursor-pointer min-h-[44px]"
        >
          <option value="">Anyone</option>
          {RECIPIENT_OPTIONS.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      </div>

      {/* Availability */}
      {availabilityOptions.length > 1 && (
        <div className="space-y-2">
          <label htmlFor="filter-availability" className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] block">
            Availability
          </label>
          <select
            id="filter-availability"
            value={selectedAvailability}
            onChange={(e) => { setSelectedAvailability(e.target.value); syncParam('availability', e.target.value === 'all' ? '' : e.target.value); }}
            className="w-full px-4 py-2.5 rounded-full bg-[var(--color-surface-bg)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] cursor-pointer min-h-[44px]"
          >
            {availabilityOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
      )}

    </>
  );

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      {/* ═══ COMPACT EDITORIAL INTRO ═══ */}
      <div ref={heroRef} className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 sm:pt-10 pb-6 sm:pb-7">
        <div data-hero-badge className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
          <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
            The Collective Catalogue
          </span>
        </div>
        <h1 data-hero-headline className="font-serif text-[30px] sm:text-[40px] lg:text-[48px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.08]">
          Shop All Gifts
        </h1>
        <div data-hero-desc className="mt-2 space-y-3">
          <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] max-w-xl leading-relaxed">
            Handcrafted floral, stationery and keepsake pieces — grouped into the craft categories the catalogue actually holds.
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">
            <span>{visibleCatalog.length} {visibleCatalog.length === 1 ? 'piece' : 'pieces'}</span>
            <span aria-hidden="true" className="text-[var(--color-border-strong)]">·</span>
            <span>{categoryOptions.length - 1} {categoryOptions.length - 1 === 1 ? 'category' : 'categories'} in the catalogue</span>
            <span aria-hidden="true" className="text-[var(--color-border-strong)]">·</span>
            <span>INR (₹)</span>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12 sm:pb-16">
        {/* ═══ CATEGORY RAIL + CATALOGUE TOOLBAR ═══
            Real categories only, with real counts. The active state is filled
            and bordered rather than a solid accent pill, so a rail of five
            categories does not shout. */}
        <div ref={toolbarRef} className="space-y-3 pb-5 border-b border-[var(--color-botanical-border)]">
          <div className="flex items-center gap-1.5 overflow-x-auto w-full pb-1 scrollbar-none -mx-1 px-1" role="group" aria-label="Filter by category">
            {categoryOptions.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => handleCategoryChange(cat.id)}
                aria-pressed={selectedCategory === cat.id}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[12px] font-semibold whitespace-nowrap min-h-[44px] border transition-colors ${
                  selectedCategory === cat.id
                    ? 'bg-[var(--color-surface-highest)] text-[var(--color-botanical-primary)] border-[var(--color-border-strong)]'
                    : 'bg-transparent text-[var(--color-botanical-subtle)] border-transparent hover:text-[var(--color-botanical-primary)] hover:border-[var(--color-botanical-border)]'
                }`}
              >
                {cat.label}
                {cat.count > 0 && <span className="opacity-70 tabular-nums">{cat.count}</span>}
              </button>
            ))}
          </div>

          {/* Search · result count · Sort · Filters.
              Phones: search on its own line, then count · Filters · Sort.
              Desktop: count · search · Sort · Filters in one row. */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full">
            <p
              aria-live="polite"
              className="order-2 sm:order-1 shrink-0 text-[12px] font-medium text-[var(--color-botanical-muted)] whitespace-nowrap tabular-nums"
            >
              {products.length} {products.length === 1 ? 'piece' : 'pieces'}
            </p>

            <div className="relative w-full sm:w-auto sm:flex-1 sm:min-w-[180px] order-1 sm:order-2">
              <input
                type="search"
                placeholder="Search…"
                aria-label="Search gifts"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] min-h-[44px]"
              />
              <Search className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            </div>

            <div className="relative shrink-0 order-4 sm:order-3">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                aria-label="Sort products"
                className="pl-3 pr-8 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[13px] font-medium text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] appearance-none cursor-pointer min-h-[44px]"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <ArrowUpDown className="w-3.5 h-3.5 text-[var(--color-botanical-subtle)] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            </div>

            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              aria-expanded={filtersOpen}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold min-h-[44px] relative shrink-0 order-3 sm:order-4"
              aria-label="Open filters"
            >
              <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">Filters</span>
              {discoveryFilterCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--color-accent)] text-white text-[10px] font-bold">
                  {discoveryFilterCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* ═══ DESKTOP FILTER PANEL (collapsible, full width) ═══ */}
        {filtersOpen && (
          <div ref={panelRef} className="hidden lg:block mt-5 rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] p-5">
            <div className="flex items-center justify-between border-b border-[var(--color-botanical-border)] pb-3 mb-4">
              <span className="font-serif text-[17px] text-[var(--color-botanical-primary)]">Refine Catalogue</span>
              <div className="flex items-center gap-4">
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={handleResetFilters}
                    className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-accent)] hover:underline flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" aria-hidden="true" /> Reset
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFiltersOpen(false)}
                  aria-label="Close filters"
                  className="w-11 h-11 rounded-full hover:bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] flex items-center justify-center"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-8 gap-y-5">
              {filterControls}
            </div>
          </div>
        )}

        {/* ═══ ACTIVE FILTERS — one reversible summary. It appears for ANY active
            filter (category and search included), so a filtered catalogue is
            never a dead end. ═══ */}
        {hasActiveFilters && (
          <div className="flex flex-wrap items-center gap-2 pt-5">
            {discoveryFilterCount > 0 && (
              <span className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Filtering:</span>
            )}
            {selectedCategory !== 'all' && (
              <button
                type="button"
                onClick={() => handleCategoryChange('all')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-surface-high)] text-[var(--color-botanical-primary)] text-[11px] font-semibold hover:bg-[var(--color-botanical-sage-light)] min-h-[24px]"
              >
                {categoryOptions.find((c) => c.id === selectedCategory)?.label || selectedCategory} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-surface-high)] text-[var(--color-botanical-primary)] text-[11px] font-semibold hover:bg-[var(--color-botanical-sage-light)] min-h-[24px]"
              >
                Search: {searchQuery} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {selectedOccasion && (
              <button type="button" onClick={() => clearDiscoveryFilter('occasion')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-btn)] text-white text-[11px] font-semibold hover:bg-[var(--color-btn-hover)] min-h-[24px]">
                Occasion: {optionLabel('occasion', selectedOccasion)} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {selectedRecipient && (
              <button type="button" onClick={() => clearDiscoveryFilter('recipient')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-btn)] text-white text-[11px] font-semibold hover:bg-[var(--color-btn-hover)] min-h-[24px]">
                For: {optionLabel('recipient', selectedRecipient)} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {selectedAvailability !== 'all' && (
              <button type="button" onClick={() => clearDiscoveryFilter('availability')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-btn)] text-white text-[11px] font-semibold hover:bg-[var(--color-btn-hover)] min-h-[24px]">
                {availabilityChipLabel} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {Number(maxPrice) < maxPriceCap && (
              <button type="button" onClick={() => clearDiscoveryFilter('maxPrice')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-surface-high)] text-[var(--color-botanical-primary)] text-[11px] font-semibold hover:bg-[var(--color-botanical-sage-light)] min-h-[24px]">
                Under ₹{Number(maxPrice).toLocaleString('en-IN')} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={handleResetFilters}
              className="inline-flex items-center min-h-[24px] text-[11px] font-bold uppercase tracking-wider text-[var(--color-accent)] hover:underline ml-1"
            >
              Clear all
            </button>
          </div>
        )}

        {/* ═══ CATALOGUE ═══ */}
        <div className="pt-6">
          {products.length > 0 ? (
            <>
              <div ref={gridRef} className={`grid gap-3 sm:gap-4 lg:gap-5 ${gridClass}`}>
                {products.map((product) => (
                  <ProductCard key={product.id} variant="compact" product={product} />
                ))}
              </div>

              {products.length === 1 && (
                <p className="text-center text-[13px] text-[var(--color-botanical-muted)] mt-8">
                  More keepsakes join the catalogue as the atelier completes them.
                </p>
              )}
            </>
          ) : (
            <div className="rounded-2xl bg-[var(--color-surface-lowest)] p-12 text-center border border-[var(--color-botanical-border)] space-y-4">
              <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center" aria-hidden="true">
                <Sprout className="w-6 h-6 text-[var(--color-botanical-sage)]" />
              </div>
              <h3 className="font-serif text-[22px] sm:text-[24px] text-[var(--color-botanical-primary)]">No gifts match these filters</h3>
              <p className="text-[14px] text-[var(--color-botanical-muted)] max-w-md mx-auto">
                Try widening your price range, clearing the search, or choosing another occasion.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                {hasActiveFilters && (
                  <button type="button" onClick={handleResetFilters} className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] min-h-[44px]">
                    Clear Filters
                  </button>
                )}
                <Link to="/shop" className="px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] min-h-[44px] inline-flex items-center">
                  Browse All Gifts
                </Link>
                <Link to="/gift-finder" className="px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] min-h-[44px] inline-flex items-center">
                  Find a Gift
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* ═══ DISCOVERY RAIL — only occasions a live piece actually matches ═══ */}
        {availableOccasions.length > 0 && (
          <section className="pt-12 sm:pt-14">
            <div className="flex items-end justify-between gap-4 mb-4">
              <div>
                <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Gift with intention</span>
                <h2 className="font-serif text-[20px] sm:text-[24px] text-[var(--color-botanical-primary)] mt-1">Shop by moment</h2>
              </div>
              <Link
                to="/gift-finder"
                className="inline-flex items-center min-h-[24px] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:text-[var(--color-accent)] transition-colors shrink-0"
              >
                Gift Finder
              </Link>
            </div>
            <div className="flex gap-2 overflow-x-auto scrollbar-none -mx-4 px-4 sm:-mx-6 sm:px-6 pb-1">
              {availableOccasions.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => handleOccasionMoment(o.id)}
                  aria-pressed={selectedOccasion === o.id}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-semibold min-h-[44px] shrink-0 transition-colors ${
                    selectedOccasion === o.id
                      ? 'bg-[var(--color-surface-highest)] text-[var(--color-botanical-primary)] border border-[var(--color-border-strong)]'
                      : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] border border-[var(--color-botanical-border)] hover:text-[var(--color-botanical-primary)] hover:border-[var(--color-border-strong)]'
                  }`}
                >
                  <span aria-hidden="true">{o.icon}</span>
                  {o.label}
                  <span className="opacity-70">{o.count}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ═══ BESPOKE CTA ═══ */}
        <section className="mt-12 sm:mt-14 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] px-6 py-6 sm:px-8 sm:py-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="font-serif text-[20px] sm:text-[22px] text-[var(--color-botanical-primary)]">Can't find quite the right piece?</h2>
            <p className="text-[13px] text-[var(--color-botanical-muted)] mt-1">Tell us the person and the moment — we'll help you choose, or craft it.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <Link to="/gift-finder" className="inline-flex items-center px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] min-h-[44px]">
              Find a Gift
            </Link>
            <Link to="/custom-gifts" className="inline-flex items-center px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] min-h-[44px]">
              Custom Gift Studio
            </Link>
          </div>
        </section>
      </div>

      {/* Mobile filter sheet — bottom drawer with focus trap */}
      {filtersOpen && (
        <div
          className="lg:hidden fixed inset-0 z-[70] bg-black/40 backdrop-blur-sm flex items-end fa-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Filter gifts"
          onClick={() => setFiltersOpen(false)}
        >
          <div
            ref={panelRef}
            className="w-full bg-[var(--color-surface-bg)] rounded-t-3xl max-h-[85vh] overflow-y-auto fa-drawer-slide"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-[var(--color-surface-bg)] px-5 pt-5 pb-3 border-b border-[var(--color-botanical-border)] flex items-center justify-between z-10">
              <span className="font-serif text-[20px] text-[var(--color-botanical-primary)]">Refine Your Gifts</span>
              <button
                type="button"
                onClick={() => setFiltersOpen(false)}
                aria-label="Close filters"
                className="w-11 h-11 rounded-full hover:bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)] flex items-center justify-center"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <div className="px-5 py-5 space-y-6">{filterControls}</div>
            <div className="sticky bottom-0 bg-[var(--color-surface-bg)] px-5 pt-3 pb-5 border-t border-[var(--color-botanical-border)] flex items-center gap-3">
              <button
                type="button"
                onClick={handleResetFilters}
                className="px-5 py-3 rounded-full border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] bg-[var(--color-surface-lowest)] min-h-[44px]"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => setFiltersOpen(false)}
                className="flex-1 px-5 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold min-h-[44px]"
              >
                Show {products.length} result{products.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
