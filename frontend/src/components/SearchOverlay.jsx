import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, ArrowRight } from 'lucide-react';
import { gsap } from 'gsap';

/**
 * Phase 3G-A — customer search entry experience.
 *
 * This is an ENTRY point, not a second search engine: it never fabricates
 * results. Popular searches and suggested categories are real destinations
 * (live shop filters, the Custom Gift Studio) and free-text submits hand off to
 * the existing /search route, which searches the live catalogue.
 */

const POPULAR_SEARCHES = [
  { label: 'Birthday Gifts', to: '/shop?occasion=birthday' },
  { label: 'Handmade Flowers', to: '/shop?category=bouquets' },
  { label: 'Custom Gifts', to: '/custom-gifts' },
  { label: 'Gifts Under ₹500', to: '/shop?maxPrice=500' },
  { label: 'Personalized Cards', to: '/shop?category=cards' },
  { label: 'Hampers', to: '/shop?category=hampers' },
];

const SUGGESTED_CATEGORIES = [
  { label: 'Flowers', icon: '🌸', to: '/shop?category=bouquets' },
  { label: 'Cards', icon: '💌', to: '/shop?category=cards' },
  { label: 'Keepsakes', icon: '🧸', to: '/shop?category=charms' },
  { label: 'Custom Gifts', icon: '🎁', to: '/custom-gifts' },
];

export default function SearchOverlay({ open, onClose }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 30);
      return () => clearTimeout(t);
    }
    setQuery('');
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  // Staggered entrance animation
  useEffect(() => {
    if (!open || !panelRef.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const panel = panelRef.current;
    const popularBtns = panel.querySelectorAll('[data-popular-btn]');
    const catBtns = panel.querySelectorAll('[data-cat-btn]');
    const giftBtn = panel.querySelector('[data-gift-btn]');

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ delay: 0.1 });
      tl.fromTo(panel, { opacity: 0, y: 16, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: 'power3.out' });
      if (popularBtns.length > 0) {
        tl.fromTo(popularBtns, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.25, stagger: 0.03, ease: 'power2.out' }, 0.15);
      }
      if (catBtns.length > 0) {
        tl.fromTo(catBtns, { opacity: 0, y: 8, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.25, stagger: 0.04, ease: 'power2.out' }, 0.25);
      }
      if (giftBtn) {
        tl.fromTo(giftBtn, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out' }, 0.4);
      }
    }, panel);

    return () => ctx.revert();
  }, [open]);

  if (!open) return null;

  const go = (to) => {
    onClose();
    navigate(to);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const q = query.trim();
    go(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-[#180f0a]/40 backdrop-blur-sm flex items-start justify-center px-3 sm:px-4 pt-12 sm:pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="Search Flora Alchemy"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="w-full max-w-2xl bg-[var(--color-surface-bg)] rounded-3xl shadow-2xl border border-[var(--color-botanical-border)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} className="flex items-center gap-3 px-4 sm:px-5 py-3.5 sm:py-4 border-b border-[var(--color-botanical-border)]">
          <Search className="w-5 h-5 text-[#964735] shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Flora Alchemy"
            aria-label="Search Flora Alchemy"
            className="flex-1 bg-transparent text-[15px] sm:text-[16px] text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:outline-none min-w-0"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="p-2.5 rounded-full text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-container)] transition-colors touch-target flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </form>

        <div className="p-4 sm:p-6 space-y-5 sm:space-y-6 max-h-[75vh] overflow-y-auto">
          <div className="space-y-2.5 sm:space-y-3">
            <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">Popular Searches</p>
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {POPULAR_SEARCHES.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  data-popular-btn
                  onClick={() => go(item.to)}
                  className="px-3.5 py-1.5 rounded-full bg-[var(--color-surface-lowest)] text-[12px] font-medium text-[var(--color-botanical-muted)] border border-[var(--color-botanical-border)] hover:border-[#180f0a] hover:text-[var(--color-botanical-primary)] transition-colors min-h-[36px] touch-target"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5 sm:space-y-3">
            <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">Suggested Categories</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
              {SUGGESTED_CATEGORIES.map((cat) => (
                <button
                  key={cat.label}
                  type="button"
                  data-cat-btn
                  onClick={() => go(cat.to)}
                  className="group flex items-center gap-2 sm:gap-2.5 p-2.5 sm:p-3 rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] hover:border-[#964735] hover:shadow-sm transition-all text-left min-h-[44px]"
                >
                  <span className="text-[18px]" aria-hidden="true">{cat.icon}</span>
                  <span className="text-[12px] sm:text-[13px] font-semibold text-[var(--color-botanical-primary)] group-hover:text-[#964735] transition-colors truncate">
                    {cat.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            data-gift-btn
            onClick={() => go('/gift-finder')}
            className="w-full flex items-center justify-between gap-3 p-3.5 sm:p-4 rounded-2xl bg-[#180f0a] text-white hover:bg-[#964735] transition-colors text-left min-h-[48px]"
          >
            <span>
              <span className="block text-[13px] font-semibold">Not sure what to gift?</span>
              <span className="block text-[12px] text-white/70">Let the Gift Finder choose with you.</span>
            </span>
            <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
