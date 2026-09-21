import React, { useMemo, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles, BookOpen } from 'lucide-react';
import { getCollections, getCollectionProducts } from '../services/collectionService.js';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export default function CollectionsPage() {
  const collections = useMemo(
    () =>
      getCollections().map((c) => {
        const products = getCollectionProducts(c.id);
        return {
          id: c.id,
          title: c.name,
          subtitle: c.description,
          image: c.coverImage,
          category: products[0]?.category || 'all',
          pieceCount: `${c.productCount} Handcrafted Edition${c.productCount === 1 ? '' : 's'}`,
          badge: c.visibility === 'Hidden' ? 'Hidden' : 'Curated',
        };
      }),
    []
  );

  const heroRef = useRef(null);
  const gridRef = useRef(null);
  const bannerRef = useRef(null);

  // GSAP animations
  useEffect(() => {
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return;

    const ctx = gsap.context(() => {
      // Hero entrance — 3-stage
      if (heroRef.current) {
        const tl = gsap.timeline({ delay: 0.1 });
        const badge = heroRef.current.querySelector('[data-hero-badge]');
        const headline = heroRef.current.querySelector('[data-hero-headline]');
        const desc = heroRef.current.querySelector('[data-hero-desc]');

        if (badge) tl.fromTo(badge, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, 0);
        if (headline) tl.fromTo(headline, { opacity: 0, y: 20, clipPath: 'inset(0 0 100% 0)' }, { opacity: 1, y: 0, clipPath: 'inset(0 0 0% 0)', duration: 0.7, ease: 'power3.out' }, 0.15);
        if (desc) tl.fromTo(desc, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, 0.4);
      }

      // Collection cards — staggered entrance with varied transforms
      if (gridRef.current) {
        const cards = gridRef.current.querySelectorAll('[data-col-card]');
        if (cards.length > 0) {
          gsap.fromTo(cards,
            { opacity: 0, y: 40, scale: 0.97 },
            {
              opacity: 1, y: 0, scale: 1, duration: 0.7, stagger: 0.12, ease: 'power3.out',
              scrollTrigger: { trigger: gridRef.current, start: 'top 85%', once: true },
            }
          );
        }
      }

      // Banner reveal
      if (bannerRef.current) {
        gsap.fromTo(bannerRef.current,
          { opacity: 0, y: 25 },
          {
            opacity: 1, y: 0, duration: 0.7, ease: 'power3.out',
            scrollTrigger: { trigger: bannerRef.current, start: 'top 88%', once: true },
          }
        );
      }
    });

    return () => ctx.revert();
  }, []);

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      {/* ═══ EDITORIAL HEADER ═══ */}
      <div ref={heroRef} className="relative overflow-hidden pt-10 lg:pt-16 pb-8 lg:pb-12" style={{ perspective: '1200px' }}>
        {/* Ambient glows */}
        <div className="absolute -top-20 -left-20 w-80 h-80 rounded-full bg-[#ffdad3]/20 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 -right-16 w-64 h-64 rounded-full bg-[#d8e7cd]/15 blur-3xl pointer-events-none" />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="space-y-2 mb-6">
            <div data-hero-badge className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#964735]" />
              <span className="text-[11px] font-bold uppercase tracking-widest text-[#964735]">
                Curated Thematic Archives
              </span>
            </div>
            <h1 data-hero-headline className="font-serif text-[32px] sm:text-[44px] md:text-[52px] lg:text-[60px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.08]">
              Seasonal & Occasion Collections
            </h1>
            <p data-hero-desc className="text-[14px] sm:text-[15px] md:text-[16px] text-[var(--color-botanical-muted)] max-w-2xl leading-relaxed">
              Carefully curated groupings of handcrafted florals, stationery, and personalized vessels gathered for meaningful life rituals.
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
        {/* Collections Grid — editorial composition */}
        <div ref={gridRef} className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8">
          {collections.map((col, idx) => (
            <div
              key={col.id}
              data-col-card
              className={`group bg-[var(--color-surface-lowest)] rounded-3xl overflow-hidden border border-[var(--color-botanical-border)] shadow-sm hover:shadow-xl transition-all duration-500 flex flex-col justify-between fa-card-depth ${
                idx === 0 ? 'md:col-span-2' : ''
              }`}
            >
              <div className={`relative w-full overflow-hidden bg-[var(--color-surface-low)] ${idx === 0 ? 'aspect-[21/9]' : 'aspect-[16/10]'}`}>
                <img
                  loading="lazy"
                  decoding="async"
                  src={col.image}
                  alt={col.title}
                  className="w-full h-full object-cover fa-img-reveal transition-transform duration-700 ease-out"
                />
                {/* Gradient overlay for depth */}
                <div className="absolute inset-0 bg-gradient-to-t from-[#180f0a]/15 via-transparent to-transparent pointer-events-none" />
                <div className="absolute top-4 left-4">
                  <span className="px-3 py-1 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-md text-[var(--color-botanical-primary)] text-[11px] font-bold uppercase tracking-wider shadow-sm">
                    {col.badge}
                  </span>
                </div>
              </div>

              <div className="p-5 sm:p-8 space-y-4 flex-1 flex flex-col justify-between">
                <div className="space-y-2">
                  <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">
                    {col.pieceCount}
                  </span>
                  <h2 className="font-serif text-[22px] sm:text-[26px] text-[var(--color-botanical-primary)] font-normal leading-snug group-hover:text-[#964735] transition-colors duration-300">
                    {col.title}
                  </h2>
                  <p className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">
                    {col.subtitle}
                  </p>
                </div>

                <div className="pt-4 border-t border-[var(--color-botanical-border)] flex items-center justify-between">
                  <Link
                    to={`/shop?category=${col.category}`}
                    className="inline-flex items-center gap-2 text-[13px] font-bold text-[var(--color-botanical-primary)] group-hover:text-[#964735] transition-colors duration-200"
                  >
                    <span>View Handcrafted Editions</span>
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform duration-200" />
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Bespoke Inquiry Banner */}
        <div ref={bannerRef} className="mt-12 sm:mt-16 rounded-3xl bg-[#180f0a] text-white p-6 sm:p-8 lg:p-12 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          <div className="space-y-2 max-w-xl">
            <span className="text-[11px] uppercase font-bold tracking-widest text-[#ffdad3]">
              Bespoke Bridal & Milestone Suites
            </span>
            <h3 className="font-serif text-[24px] sm:text-[30px] lg:text-[36px] font-normal leading-tight">
              Planning a wedding, event, or private keepsake drop?
            </h3>
            <p className="text-[13px] sm:text-[14px] text-[#d4c3ba] leading-relaxed">
              We handcraft custom wedding favors, everlasting bridal posies, and bespoke family keepsake suites.
            </p>
          </div>
          <Link
            to="/custom-gifts"
            className="px-8 py-3.5 rounded-full bg-[#ffdad3] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-lowest)] text-[13px] font-semibold transition-all duration-200 shrink-0 shadow-md hover:shadow-lg"
          >
            Enter Custom Studio
          </Link>
        </div>
      </div>
    </div>
  );
}
