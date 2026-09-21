import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Filter } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const CATEGORIES = ['All', 'Bouquets', 'Cards', 'Keepsakes', 'Custom Creations', 'Behind the Scenes'];

const CREATIONS = [
  {
    id: 1,
    title: 'The Pressed Botanical Wildflower Card',
    category: 'Cards',
    image: '/assets/images/flora-asset-06.jpg',
    excerpt: 'Hand-pressed wildflower petals set into deckled mulberry bark — a card that becomes a keepsake.',
    relatedProduct: 'pressed-botanical-wildflower-card',
  },
  {
    id: 2,
    title: 'Lavender & Dusty Rose Posy',
    category: 'Bouquets',
    image: '/assets/images/flora-asset-03.jpg',
    excerpt: 'Our signature everlasting posy in a harmonizing lavender and dusty rose palette.',
    relatedProduct: null,
  },
  {
    id: 3,
    title: 'Solid Pine Sliding Hamper',
    category: 'Keepsakes',
    image: '/assets/images/flora-asset-11.jpg',
    excerpt: 'A hand-finished pine casket containing brass shears, a botanical card, and a forever posy.',
    relatedProduct: 'solid-pine-sliding-hamper',
  },
  {
    id: 4,
    title: 'Custom Anniversary Gift — The Refined Collection',
    category: 'Custom Creations',
    image: '/assets/images/flora-asset-21.jpg',
    excerpt: "A bespoke arrangement built around the couple's favourite colours and shared memories.",
    relatedProduct: null,
  },
  {
    id: 5,
    title: 'The Chenille Sunflower Mascot',
    category: 'Keepsakes',
    image: '/assets/images/flora-asset-16.jpg',
    excerpt: 'A cheerful handmade sunflower mascot — equal parts decoration and companion.',
    relatedProduct: 'chenille-sunflower-mascot',
  },
  {
    id: 6,
    title: 'Behind the Scenes — Petal Shaping',
    category: 'Behind the Scenes',
    image: '/assets/images/flora-asset-26.jpg',
    excerpt: "Every petal is individually twisted and shaped by hand. Here's a glimpse at the process.",
    relatedProduct: null,
  },
  {
    id: 7,
    title: 'Artisan Speckled Ceramic Vessel',
    category: 'Keepsakes',
    image: '/assets/images/flora-asset-09.jpg',
    excerpt: 'Hand-thrown stoneware pottery with natural moss bedding — functional art for your home.',
    relatedProduct: 'artisan-speckled-ceramic-vessel',
  },
  {
    id: 8,
    title: 'Heirloom Brass Shears',
    category: 'Keepsakes',
    image: '/assets/images/flora-asset-06.jpg',
    excerpt: 'Vintage-inspired brass garden shears — a functional keepsake for the plant lover.',
    relatedProduct: 'heirloom-brass-shears',
  },
];

export default function FloraJournalPage() {
  const [activeCategory, setActiveCategory] = useState('All');
  const pageRef = useRef(null);
  const headerRef = useRef(null);
  const gridRef = useRef(null);

  const filtered = activeCategory === 'All'
    ? CREATIONS
    : CREATIONS.filter((c) => c.category === activeCategory);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = gsap.context(() => {
      // Header entrance — staggered
      const headerTl = gsap.timeline({ delay: 0.1 });
      if (headerRef.current) {
        const badge = headerRef.current.querySelector('[data-j-badge]');
        const title = headerRef.current.querySelector('[data-j-title]');
        const sub = headerRef.current.querySelector('[data-j-sub]');
        const filters = headerRef.current.querySelector('[data-j-filters]');
        if (badge) headerTl.fromTo(badge, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, 0);
        if (title) headerTl.fromTo(title, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' }, 0.1);
        if (sub) headerTl.fromTo(sub, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, 0.25);
        if (filters) headerTl.fromTo(filters, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, 0.35);
      }

      // Grid stagger — first card larger on desktop
      if (gridRef.current) {
        const articles = gridRef.current.querySelectorAll('article');
        if (articles.length) {
          gsap.fromTo(articles, { opacity: 0, y: 32, scale: 0.97 }, {
            opacity: 1, y: 0, scale: 1, duration: 0.55, stagger: 0.07, ease: 'power2.out',
            scrollTrigger: { trigger: gridRef.current, start: 'top 85%', once: true }
          });
        }
      }
    }, pageRef);

    return () => ctx.revert();
  }, [activeCategory]);

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen py-8 lg:py-12 relative overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="absolute top-20 left-1/4 w-48 lg:w-64 h-48 lg:h-64 bg-[#964735]/6 rounded-full blur-[120px]" />
      <div className="absolute bottom-20 right-1/4 w-40 lg:w-48 h-40 lg:h-48 bg-[#c17c74]/6 rounded-full blur-[100px]" />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        {/* ═══ HEADER ═══ */}
        <div ref={headerRef} className="text-center max-w-2xl mx-auto mb-8 lg:mb-10 space-y-3">
          <div data-j-badge className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#d8e7cd]/50 text-[#5b6d54] text-[11px] font-bold uppercase tracking-wider">
            <Filter className="w-3.5 h-3.5" />
            <span>Our Creations</span>
          </div>
          <h1 data-j-title className="font-serif text-[30px] sm:text-[38px] lg:text-[44px] text-[var(--color-botanical-primary)] tracking-tight">The Flora Journal</h1>
          <p data-j-sub className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed">
            Stories behind the arrangements — the materials, the makers, and the moments they&apos;re made for.
          </p>
        </div>

        {/* ═══ CATEGORY FILTER ═══ */}
        <div data-j-filters className="flex items-center gap-2 overflow-x-auto pb-2 mb-8 lg:mb-10 justify-start lg:justify-center scrollbar-none">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategory(cat)}
              className={`shrink-0 px-4 py-2 rounded-full border text-[12px] font-semibold transition-all duration-200 ${
                activeCategory === cat
                  ? 'bg-[#180f0a] text-white border-[#180f0a] shadow-sm'
                  : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)] hover:border-[#80756f]'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* ═══ CREATIONS GRID — Editorial Layout ═══ */}
        <div ref={gridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 lg:gap-6">
          {filtered.map((creation, i) => (
            <article
              key={creation.id}
              className={`group bg-[var(--color-surface-lowest)] rounded-2xl lg:rounded-3xl border border-[var(--color-botanical-border)] overflow-hidden hover:shadow-lg transition-all duration-300 hover:-translate-y-1 ${
                i === 0 && filtered.length > 2 ? 'sm:col-span-2 lg:col-span-2 lg:row-span-2' : ''
              }`}
            >
              <div className={`${i === 0 && filtered.length > 2 ? 'aspect-[16/9] lg:aspect-[16/10]' : 'aspect-[4/3]'} overflow-hidden bg-[var(--color-surface-low)] relative`}>
                <img
                  loading="lazy"
                  decoding="async"
                  src={creation.image}
                  alt={creation.title}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                />
                {/* Hover overlay */}
                <div className="absolute inset-0 bg-[#180f0a]/0 group-hover:bg-[#180f0a]/10 transition-colors duration-300" />
              </div>
              <div className={`p-4 lg:p-5 space-y-2.5 ${i === 0 && filtered.length > 2 ? 'lg:p-8' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase font-bold tracking-wider text-[#964735] bg-[#ffdad3]/40 px-2 py-0.5 rounded-full">
                    {creation.category}
                  </span>
                </div>
                <h3 className={`font-serif text-[17px] lg:text-[18px] text-[var(--color-botanical-primary)] leading-tight ${i === 0 && filtered.length > 2 ? 'lg:text-[22px]' : ''}`}>
                  {creation.title}
                </h3>
                <p className={`text-[13px] text-[var(--color-botanical-muted)] leading-relaxed ${i === 0 && filtered.length > 2 ? 'lg:text-[14px] lg:max-w-xl' : ''}`}>
                  {creation.excerpt}
                </p>
                {creation.relatedProduct ? (
                  <Link
                    to={`/product/${creation.relatedProduct}`}
                    className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#964735] hover:underline mt-2"
                  >
                    View Product <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ) : (
                  <Link
                    to="/custom-gifts"
                    className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#964735] hover:underline mt-2"
                  >
                    Create Something Similar <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                )}
              </div>
            </article>
          ))}
        </div>

        {/* ═══ EMPTY STATE ═══ */}
        {filtered.length === 0 && (
          <div className="text-center py-16 space-y-4">
            <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-subtle)]">No creations in this category yet.</p>
            <button
              type="button"
              onClick={() => setActiveCategory('All')}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors"
            >
              View All Creations
            </button>
          </div>
        )}

        {/* ═══ CTA ═══ */}
        <div className="text-center mt-14 lg:mt-16 space-y-4">
          <h2 className="font-serif text-[24px] sm:text-[28px] text-[var(--color-botanical-primary)]">Inspired?</h2>
          <p className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)]">Build your own creation or explore the full collection.</p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              to="/custom-gifts"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold hover:bg-[#964735] transition-colors shadow-md w-full sm:w-auto justify-center"
            >
              Build a Custom Gift
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              to="/shop"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors w-full sm:w-auto justify-center"
            >
              Browse All Gifts
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
