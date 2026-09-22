import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { SlidersHorizontal, ArrowUpDown, X, Search, RotateCcw, Leaf, Sparkles } from 'lucide-react';
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
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// Availability is derived from the real `stockTracked` product field — the
// storefront cannot read /api/inventory, so it never claims stock numbers.
const availabilityOf = (product) => (product.stockTracked === false ? 'made_to_order' : 'ready');
const AVAILABILITY_LABELS = { ready: 'Ready to gift', made_to_order: 'Made to order' };

const SORT_OPTIONS = [
  { value: 'featured', label: 'Featured Keepsakes' },
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

  const categoryMap = catalog.reduce((acc, p) => {
    if (p.category && !acc[p.category]) {
      acc[p.category] = { id: p.category, label: p.categoryLabel || p.category };
    }
    return acc;
  }, {});
  const categoryOptions = [{ id: 'all', label: 'All Keepsakes' }, ...Object.values(categoryMap)];

  const availabilityOptions = useMemo(() => {
    const present = new Set(catalog.filter((p) => p.visibility !== 'Hidden').map(availabilityOf));
    const options = [{ id: 'all', label: 'Any availability' }];
    if (present.has('ready')) options.push({ id: 'ready', label: AVAILABILITY_LABELS.ready });
    if (present.has('made_to_order')) options.push({ id: 'made_to_order', label: AVAILABILITY_LABELS.made_to_order });
    return options;
  }, [catalog]);

  const [products, setProducts] = useState(() => getCatalogProducts());
  const [selectedCategory, setSelectedCategory] = useState(initialCategory);
  const [selectedOccasion, setSelectedOccasion] = useState(initialOccasion);
  const [selectedRecipient, setSelectedRecipient] = useState(initialRecipient);
  const [selectedAvailability, setSelectedAvailability] = useState(initialAvailability);
  const [maxPrice, setMaxPrice] = useState(initialMaxPrice);
  const [sortBy, setSortBy] = useState('featured');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // GSAP refs
  const heroRef = useRef(null);
  const gridRef = useRef(null);
  const toolbarRef = useRef(null);
  const emptyStateRef = useRef(null);
  const filterSheetRef = useRef(null);

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
  }, [selectedCategory, selectedOccasion, selectedRecipient, selectedAvailability, maxPrice, sortBy, searchQuery]);

  // GSAP hero entrance + toolbar
  useEffect(() => {
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return;

    const ctx = gsap.context(() => {
      if (heroRef.current) {
        const tl = gsap.timeline({ delay: 0.1 });
        const badge = heroRef.current.querySelector('[data-hero-badge]');
        const headline = heroRef.current.querySelector('[data-hero-headline]');
        const desc = heroRef.current.querySelector('[data-hero-desc]');
        const glow1 = heroRef.current.querySelector('[data-hero-glow-1]');
        const glow2 = heroRef.current.querySelector('[data-hero-glow-2]');

        if (glow1) tl.fromTo(glow1, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.8, ease: 'power2.out' }, 0);
        if (glow2) tl.fromTo(glow2, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.8, ease: 'power2.out' }, 0.1);
        if (badge) tl.fromTo(badge, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, 0.15);
        if (headline) tl.fromTo(headline, { opacity: 0, y: 20, clipPath: 'inset(0 0 100% 0)' }, { opacity: 1, y: 0, clipPath: 'inset(0 0 0% 0)', duration: 0.7, ease: 'power3.out' }, 0.25);
        if (desc) tl.fromTo(desc, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, 0.5);
      }

      if (toolbarRef.current) {
        gsap.fromTo(toolbarRef.current,
          { opacity: 0, y: 12 },
          { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out', delay: 0.6 }
        );
      }
    });

    return () => ctx.revert();
  }, []);

  // Animate product grid when products change
  useEffect(() => {
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED || !gridRef.current) return;

    const cards = gridRef.current.querySelectorAll('article');
    if (cards.length === 0) return;

    gsap.fromTo(cards,
      { opacity: 0, y: 24, scale: 0.97 },
      { opacity: 1, y: 0, scale: 1, duration: 0.45, stagger: 0.05, ease: 'power2.out' }
    );
  }, [products]);

  // Filter sheet body scroll lock + focus trap
  useEffect(() => {
    if (!filterSheetOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus first interactive element in sheet
    const timer = setTimeout(() => {
      const sheet = filterSheetRef.current;
      if (sheet) {
        const focusable = sheet.querySelector('input, select, button');
        if (focusable) focusable.focus();
      }
    }, 50);

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setFilterSheetOpen(false);
        return;
      }
      if (e.key === 'Tab' && filterSheetRef.current) {
        const focusable = filterSheetRef.current.querySelectorAll('input, select, button, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = prev;
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [filterSheetOpen]);

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
          className="w-full accent-[#964735] cursor-pointer"
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
          className="w-full px-4 py-2.5 rounded-full bg-[var(--color-surface-bg)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] cursor-pointer"
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
          className="w-full px-4 py-2.5 rounded-full bg-[var(--color-surface-bg)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] cursor-pointer"
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
            className="w-full px-4 py-2.5 rounded-full bg-[var(--color-surface-bg)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] cursor-pointer"
          >
            {availabilityOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
      )}

      <div className="pt-2 border-t border-[var(--color-botanical-border)] space-y-2">
        <span className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Atelier Highlights</span>
        <ul className="space-y-1.5 text-[13px] text-[var(--color-botanical-muted)]">
          <li className="flex items-center gap-2"><Leaf className="w-3.5 h-3.5 text-[var(--color-botanical-sage)]" aria-hidden="true" /> Handcrafted in small batches</li>
          <li className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)]" aria-hidden="true" /> Personalizable options</li>
          <li className="flex items-center gap-2"><span aria-hidden="true">📦</span> Rigid gift packaging</li>
        </ul>
      </div>

      <div className="p-4 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] space-y-2">
        <p className="font-serif text-[15px] text-[var(--color-botanical-primary)]">Need something custom?</p>
        <p className="text-[12px] text-[var(--color-botanical-muted)] leading-relaxed">
          We create tailored bridal bouquets, anniversary posies, and corporate gift hampers.
        </p>
        <Link to="/custom-gifts" className="inline-block text-[12px] font-bold text-[var(--color-accent)] hover:underline">
          Enter Bespoke Studio →
        </Link>
        <Link to="/gift-finder" className="block text-[12px] font-bold text-[var(--color-accent)] hover:underline">
          Not sure? Use the Gift Finder →
        </Link>
      </div>
    </>
  );

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      {/* ═══ EDITORIAL SHOP HEADER ═══ */}
      <div ref={heroRef} className="relative overflow-hidden pt-6 sm:pt-10 lg:pt-16 pb-5 sm:pb-8 lg:pb-12" style={{ perspective: '1200px' }}>
        {/* Ambient glows */}
        <div data-hero-glow-1 className="absolute -top-20 -right-20 w-80 h-80 rounded-full bg-[var(--color-badge-bg)]/20 blur-3xl pointer-events-none" />
        <div data-hero-glow-2 className="absolute bottom-0 -left-16 w-64 h-64 rounded-full bg-[var(--color-botanical-sage-light)]/15 blur-3xl pointer-events-none" />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="space-y-2 mb-6">
            <div data-hero-badge className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#964735]" />
              <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
                The Atelier Catalogue
              </span>
            </div>
            <h1 data-hero-headline className="font-serif text-[32px] sm:text-[44px] md:text-[52px] lg:text-[60px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.08]">
              Shop All Gifts
            </h1>
            <p data-hero-desc className="text-[14px] sm:text-[15px] md:text-[16px] text-[var(--color-botanical-muted)] max-w-2xl leading-relaxed">
              Every piece is handcrafted to order in our studio — sculpted chenille stems, deckled
              botanical cards, and keepsake boxes you can personalize. Filter by occasion, recipient,
              price, or availability to find the right one.
            </p>
          </div>
        </div>
      </div>        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-10 sm:pb-16">
        {/* Toolbar: Categories Pills, Search & Sort */}
        <div ref={toolbarRef} className="space-y-3 lg:space-y-0 pb-5 sm:pb-6 border-b border-[var(--color-botanical-border)] mb-5 sm:mb-6">
          {/* Categories Horizontal Scroll */}
          <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto w-full pb-1 lg:pb-2 scrollbar-none -mx-1 px-1">
            {categoryOptions.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => handleCategoryChange(cat.id)}
                aria-pressed={selectedCategory === cat.id}
                className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-[11px] sm:text-[12px] font-semibold whitespace-nowrap transition-all duration-200 ${
                  selectedCategory === cat.id
                    ? 'bg-[var(--color-btn)] text-white shadow-sm'
                    : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-container)] border border-[var(--color-botanical-border)]'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Search, Sort & Filter Trigger */}
          <div className="flex items-center gap-2 sm:gap-3 w-full">
            <div className="relative flex-1 min-w-0">
              <input
                type="search"
                placeholder="Search..."
                aria-label="Search gifts"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 sm:pl-9 pr-3 sm:pr-4 py-2 rounded-full bg-[var(--color-surface-lowest)] text-[12px] sm:text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-shadow"
              />
              <Search className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[var(--color-botanical-subtle)] absolute left-2.5 sm:left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            </div>

            <div className="relative shrink-0">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                aria-label="Sort products"
                className="px-2.5 sm:px-4 py-2 rounded-full bg-[var(--color-surface-lowest)] text-[12px] sm:text-[13px] font-medium text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] appearance-none pr-7 sm:pr-8 cursor-pointer"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <ArrowUpDown className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[var(--color-botanical-subtle)] absolute right-2.5 sm:right-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            </div>

            <button
              type="button"
              onClick={() => setFilterSheetOpen(true)}
              className="lg:hidden p-2 sm:p-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] relative touch-target shrink-0"
              title="Open filters"
              aria-label="Open filters"
            >
              <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />
              {hasActiveFilters && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#964735]" />}
            </button>
          </div>
        </div>

        {/* Active discovery filters */}
        {(selectedOccasion || selectedRecipient || selectedAvailability !== 'all' || Number(maxPrice) < maxPriceCap) && (
          <div className="flex flex-wrap items-center gap-2 pb-6">
            <span className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Filtering:</span>
            {selectedOccasion && (
              <button
                type="button"
                onClick={() => clearDiscoveryFilter('occasion')}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--color-btn)] text-white text-[11px] font-semibold transition-all duration-200 hover:bg-[var(--color-btn-hover)]"
              >
                Occasion: {optionLabel('occasion', selectedOccasion)} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {selectedRecipient && (
              <button
                type="button"
                onClick={() => clearDiscoveryFilter('recipient')}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--color-btn)] text-white text-[11px] font-semibold transition-all duration-200 hover:bg-[var(--color-btn-hover)]"
              >
                For: {optionLabel('recipient', selectedRecipient)} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {selectedAvailability !== 'all' && (
              <button
                type="button"
                onClick={() => clearDiscoveryFilter('availability')}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--color-btn)] text-white text-[11px] font-semibold transition-all duration-200 hover:bg-[var(--color-btn-hover)]"
              >
                {availabilityChipLabel} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {Number(maxPrice) < maxPriceCap && (
              <button
                type="button"
                onClick={() => clearDiscoveryFilter('maxPrice')}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--color-surface-high)] text-[var(--color-botanical-primary)] text-[11px] font-semibold transition-all duration-200 hover:bg-[var(--color-botanical-sage-light)]"
              >
                Under ₹{Number(maxPrice).toLocaleString('en-IN')} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {/* Layout Grid with Sidebar Filters */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Desktop Filters Sidebar */}
          <aside className="hidden lg:block lg:col-span-3">
            <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-6 border border-[var(--color-botanical-border)] shadow-xs space-y-6 lg:sticky lg:top-28">
              <div className="flex items-center justify-between border-b border-[var(--color-botanical-border)] pb-3">
                <span className="font-serif text-[18px] text-[var(--color-botanical-primary)] font-medium">Refine Catalogue</span>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={handleResetFilters}
                    className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-accent)] hover:underline flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" aria-hidden="true" />
                    Reset
                  </button>
                )}
              </div>
              {filterControls}
            </div>
          </aside>

          {/* Product Grid */}
          <main className="lg:col-span-9">
            {products.length > 0 ? (
              <>
                <div className="flex items-center justify-between text-[13px] text-[var(--color-botanical-muted)] mb-5">
                  <span className="font-medium">Showing {products.length} handcrafted creation{products.length === 1 ? '' : 's'}</span>
                  <span className="text-[11px] uppercase tracking-wider font-bold text-[var(--color-botanical-subtle)]">
                    All Prices in ₹ INR
                  </span>
                </div>

                <div ref={gridRef} className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5 lg:gap-6">
                  {products.map((product) => (
                    <ProductCard key={product.id} product={product} />
                  ))}
                </div>
              </>
            ) : (
              <div ref={emptyStateRef} className="rounded-3xl bg-[var(--color-surface-lowest)] p-12 text-center border border-[var(--color-botanical-border)] space-y-4">
                <div className="w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-3xl" aria-hidden="true">
                  🥀
                </div>
                <h3 className="font-serif text-[22px] sm:text-[24px] text-[var(--color-botanical-primary)]">No gifts match these filters</h3>
                <p className="text-[14px] text-[var(--color-botanical-muted)] max-w-md mx-auto">
                  Try widening your price range, clearing the search, or choosing another occasion.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                  {hasActiveFilters && (
                    <button
                      type="button"
                      onClick={handleResetFilters}
                      className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
                    >
                      Clear Filters
                    </button>
                  )}
                  <Link
                    to="/shop"
                    className="px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors"
                  >
                    Browse All Gifts
                  </Link>
                  <Link
                    to="/gift-finder"
                    className="px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors"
                  >
                    Find a Gift
                  </Link>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Mobile filter sheet — bottom drawer with focus trap */}
      {filterSheetOpen && (
        <div
          className="lg:hidden fixed inset-0 z-[70] bg-black/40 backdrop-blur-sm flex items-end fa-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Filter gifts"
          onClick={() => setFilterSheetOpen(false)}
        >
          <div
            ref={filterSheetRef}
            className="w-full bg-[var(--color-surface-bg)] rounded-t-3xl max-h-[85vh] overflow-y-auto fa-drawer-slide"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-[var(--color-surface-bg)] px-5 pt-5 pb-3 border-b border-[var(--color-botanical-border)] flex items-center justify-between z-10">
              <span className="font-serif text-[20px] text-[var(--color-botanical-primary)]">Refine Your Gifts</span>
              <button
                type="button"
                onClick={() => setFilterSheetOpen(false)}
                aria-label="Close filters"
                className="p-2.5 rounded-full hover:bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)] touch-target"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <div className="px-5 py-5 space-y-6">{filterControls}</div>
            <div className="sticky bottom-0 bg-[var(--color-surface-bg)] px-5 pt-3 pb-5 border-t border-[var(--color-botanical-border)] flex items-center gap-3">
              <button
                type="button"
                onClick={() => { handleResetFilters(); }}
                className="px-5 py-3 rounded-full border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] bg-[var(--color-surface-lowest)] touch-target"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => setFilterSheetOpen(false)}
                className="flex-1 px-5 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold touch-target"
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
