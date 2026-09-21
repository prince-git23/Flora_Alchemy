import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search, X, Sparkles, ArrowRight } from 'lucide-react';
import gsap from 'gsap';
import ProductCard from '../components/ProductCard.jsx';
import { getProducts } from '../services/productService.js';

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') || '';

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  const headerRef = useRef(null);
  const resultsRef = useRef(null);

  const suggestedTags = [
    'Dusty Rose',
    'Pressed Flowers',
    'Ceramic Pot',
    'Heirloom Hamper',
    'Wax Seal',
    'Sunflower Charm',
    'Gold Foil',
    'Rakhi'
  ];

  useEffect(() => {
    function executeSearch() {
      setLoading(true);
      const q = query.trim().toLowerCase();
      const all = getProducts();
      const matched = q
        ? all.filter(p => p.visibility !== 'Hidden' && [p.name, p.shortDescription, p.description, p.categoryLabel, ...(p.tags || [])]
            .filter(Boolean).join(' ').toLowerCase().includes(q))
        : all.filter(p => p.visibility !== 'Hidden');
      setResults(matched);
      setLoading(false);
    }
    executeSearch();
  }, [query]);

  // GSAP entrance — varied reveal
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = gsap.context(() => {
      if (headerRef.current) {
        const tl = gsap.timeline({ delay: 0.1 });
        const badge = headerRef.current.querySelector('[data-search-badge]');
        const headline = headerRef.current.querySelector('[data-search-headline]');
        const input = headerRef.current.querySelector('[data-search-input]');
        const tags = headerRef.current.querySelector('[data-search-tags]');

        if (badge) tl.fromTo(badge, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power3.out' }, 0);
        if (headline) tl.fromTo(headline, { opacity: 0, y: 16, clipPath: 'inset(0 0 100% 0)' }, { opacity: 1, y: 0, clipPath: 'inset(0 0 0% 0)', duration: 0.6, ease: 'power3.out' }, 0.1);
        if (input) tl.fromTo(input, { opacity: 0, y: 12, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'power3.out' }, 0.3);
        if (tags) tl.fromTo(tags.children, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.03, ease: 'power3.out' }, 0.5);
      }
    });

    return () => ctx.revert();
  }, []);

  // Stagger results when they change
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!resultsRef.current || results.length === 0) return;

    const ctx = gsap.context(() => {
      const cards = resultsRef.current.querySelectorAll('article');
      gsap.fromTo(cards, { opacity: 0, y: 24, scale: 0.97 }, {
        opacity: 1, y: 0, scale: 1, duration: 0.45, stagger: 0.05, ease: 'power2.out'
      });
    });

    return () => ctx.revert();
  }, [results]);

  const handleTagClick = (tag) => {
    setQuery(tag);
    searchParams.set('q', tag);
    setSearchParams(searchParams);
  };

  const handleClear = () => {
    setQuery('');
    searchParams.delete('q');
    setSearchParams(searchParams);
  };

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen py-8 lg:py-16 relative overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="absolute top-20 left-1/3 w-64 h-64 bg-[#964735]/6 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-20 right-1/3 w-48 h-48 bg-[#c17c74]/6 rounded-full blur-[100px] pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        {/* Search Bar Input */}
        <div ref={headerRef} className="max-w-3xl mx-auto text-center space-y-5 sm:space-y-6 mb-10 lg:mb-12">
          <span data-search-badge className="text-[11px] uppercase font-bold tracking-widest text-[#964735]">
            Atelier Search Directory
          </span>
          <h1 data-search-headline className="font-serif text-[28px] sm:text-[36px] md:text-[44px] text-[var(--color-botanical-primary)] font-normal tracking-tight leading-tight">
            Find an Everlasting Keepsake
          </h1>

          <div data-search-input className="relative w-full">
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (e.target.value) {
                  searchParams.set('q', e.target.value);
                } else {
                  searchParams.delete('q');
                }
                setSearchParams(searchParams);
              }}
              placeholder="Search by flower name, material, occasion, or gift style..."
              autoFocus
              className="w-full pl-12 pr-12 py-4 rounded-full bg-[var(--color-surface-lowest)] text-[14px] sm:text-[15px] border border-[var(--color-botanical-border)] shadow-sm focus:outline-none focus:ring-2 focus:ring-[#180f0a] transition-all"
            />
            <Search className="w-5 h-5 text-[var(--color-botanical-subtle)] absolute left-5 top-1/2 -translate-y-1/2" aria-hidden="true" />
            {query && (
              <button
                type="button"
                onClick={handleClear}
                className="absolute right-5 top-1/2 -translate-y-1/2 text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] transition-colors touch-target"
                aria-label="Clear search"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Popular Tag Pills */}
          <div data-search-tags className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <span className="text-[12px] text-[var(--color-botanical-subtle)] font-semibold hidden sm:inline">Popular Searches:</span>
            {suggestedTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => handleTagClick(tag)}
                className="px-3 sm:px-3.5 py-1 rounded-full bg-[var(--color-surface-lowest)] text-[11px] sm:text-[12px] text-[var(--color-botanical-muted)] border border-[var(--color-botanical-border)] hover:border-[#180f0a] hover:text-[var(--color-botanical-primary)] transition-colors touch-target"
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {/* Search Results */}
        <div>
          <div className="flex items-center justify-between border-b border-[var(--color-botanical-border)] pb-4 mb-6 lg:mb-8">
            <span className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)]">
              {query ? (
                <span>Showing {results.length} results for "<strong className="text-[var(--color-botanical-primary)]">{query}</strong>"</span>
              ) : (
                <span>Browse our complete collection of {results.length} handcrafted pieces</span>
              )}
            </span>
            <span className="text-[11px] uppercase font-bold text-[var(--color-botanical-subtle)] hidden sm:inline">
              All Prices in ₹ INR
            </span>
          </div>

          {results.length > 0 ? (
            <div ref={resultsRef} className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
              {results.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          ) : (
            <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-8 sm:p-12 text-center border border-[var(--color-botanical-border)] max-w-lg mx-auto space-y-4">
              <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-2xl">
                🔍
              </div>
              <h3 className="font-serif text-[20px] sm:text-[22px] text-[var(--color-botanical-primary)]">No keepsakes found for "{query}"</h3>
              <p className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)]">
                Try searching for broader keywords such as "rose", "card", "hamper", or "pot".
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
                <button
                  onClick={handleClear}
                  className="px-6 py-2.5 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold hover:bg-[#964735] transition-colors touch-target"
                >
                  Clear Search
                </button>
                <Link
                  to="/gift-finder"
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors touch-target"
                >
                  <Sparkles className="w-4 h-4 text-[#964735]" />
                  Try Gift Finder
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
