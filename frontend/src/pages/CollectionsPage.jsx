import React, { useMemo, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sprout } from 'lucide-react';
import { getCollections, getCollectionProducts } from '../services/collectionService.js';
import { useStoreVersion } from '../hooks/useStoreVersion.js';
import ProductCard from '../components/ProductCard.jsx';
import CollectionImage from '../components/CollectionImage.jsx';
import { gsap, prefersReducedMotion } from '../lib/gsapSetup.js';

/**
 * PHASE 2 — COLLECTIONS (/collections): editorial commerce.
 *
 * Hierarchy: editorial header → collection index → ONE featured collection →
 * its real product rail → the remaining collections → a small closing CTA.
 *
 * The featured collection is chosen by a real rule, not by decoration: the
 * collection that actually holds the most pieces (name breaks the tie). If the
 * catalogue holds a single collection there is no "remaining" group and the
 * page still reads correctly.
 *
 * Every figure and every image comes from the backend. There is no invented
 * collection, no fabricated "curated by" credit and no fake piece count.
 *
 * Aspect ratios are deliberate: the one featured surface is 4:3 → 16:9, and
 * every other collection tile is 4:3. Nothing mixes 21:9 / 16:10 / 3:2 at
 * random. Motion is Level 2 through the shared GSAP module.
 */

export default function CollectionsPage() {
  const storeVersion = useStoreVersion();

  const collections = useMemo(
    () =>
      getCollections().map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        description: c.description || '',
        image: c.coverImage,
        productCount: c.productCount,
        // The catalogue category of the collection's first real piece — the
        // destination `/shop?category=` the backend can actually answer.
        category: getCollectionProducts(c.id)[0]?.category || '',
      })),
    [storeVersion] // the catalogue can arrive after mount
  );

  // Real rule: the collection holding the most pieces is featured.
  const featured = useMemo(() => {
    if (collections.length === 0) return null;
    return [...collections].sort(
      (a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name)
    )[0];
  }, [collections]);

  const remaining = useMemo(
    () => collections.filter((c) => c.id !== featured?.id),
    [collections, featured]
  );

  const featuredProducts = useMemo(
    () => (featured ? getCollectionProducts(featured.id) : []),
    [featured, storeVersion]
  );

  const headerRef = useRef(null);
  const featuredRef = useRef(null);
  const restRef = useRef(null);
  const ctaRef = useRef(null);

  useEffect(() => {
    if (prefersReducedMotion()) return undefined;

    const ctx = gsap.context(() => {
      if (headerRef.current) {
        const tl = gsap.timeline({ delay: 0.08 });
        const eyebrow = headerRef.current.querySelector('[data-hero-badge]');
        const headline = headerRef.current.querySelector('[data-hero-headline]');
        const desc = headerRef.current.querySelector('[data-hero-desc]');
        if (eyebrow) tl.fromTo(eyebrow, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power3.out' }, 0);
        if (headline) tl.fromTo(headline, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power3.out' }, 0.12);
        if (desc) tl.fromTo(desc, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, 0.3);
      }

      // The one featured surface and the remaining tiles each reveal once.
      const reveal = (root, selector) => {
        if (!root) return;
        const cards = root.querySelectorAll(selector);
        if (!cards.length) return;
        gsap.fromTo(
          cards,
          { opacity: 0, y: 24 },
          {
            opacity: 1,
            y: 0,
            duration: 0.6,
            stagger: 0.08,
            ease: 'power3.out',
            clearProps: 'transform,opacity',
            scrollTrigger: { trigger: root, start: 'top 88%', once: true },
          }
        );
      };
      reveal(featuredRef.current, '[data-col-card]');
      reveal(restRef.current, '[data-col-card]');
      reveal(ctaRef.current, '[data-cta]');
    });

    return () => ctx.revert();
  }, [collections.length]);

  const collectionHref = (col) =>
    col.category ? `/shop?category=${encodeURIComponent(col.category)}` : '/shop';

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16 sm:pb-20">
        {/* ═══ EDITORIAL HEADER ═══ */}
        <header ref={headerRef} className="pt-8 sm:pt-12 pb-7 sm:pb-9 border-b border-[var(--color-botanical-border)]">
          <div data-hero-badge className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
            <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
              Collections
            </span>
          </div>
          <h1
            data-hero-headline
            className="mt-2 font-serif text-[30px] sm:text-[40px] lg:text-[48px] leading-[1.08] tracking-tight font-normal text-[var(--color-botanical-primary)]"
          >
            Gatherings, by occasion
          </h1>
          <p data-hero-desc className="mt-2 max-w-xl text-[14px] sm:text-[15px] leading-relaxed text-[var(--color-botanical-muted)]">
            Handcrafted florals, stationery and keepsake vessels grouped for the rituals they belong to.
          </p>
          {collections.length > 0 && (
            <p className="mt-3 text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] tabular-nums">
              {collections.length} {collections.length === 1 ? 'collection' : 'collections'}
              {' '}
              <span aria-hidden="true" className="text-[var(--color-border-strong)]">·</span>
              {' '}
              {collections.reduce((sum, c) => sum + (c.productCount || 0), 0)} pieces
            </p>
          )}
        </header>

        {collections.length === 0 ? (
          <section className="pt-10">
            <div className="max-w-xl mx-auto text-center bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] px-8 py-10 space-y-4">
              <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center" aria-hidden="true">
                <Sprout className="w-6 h-6 text-[var(--color-botanical-sage)]" />
              </div>
              <h2 className="font-serif text-[22px] sm:text-[24px] text-[var(--color-botanical-primary)]">
                No collections yet
              </h2>
              <p className="text-[14px] text-[var(--color-botanical-muted)]">
                The atelier has not grouped pieces into a collection yet. Every finished piece is in the catalogue.
              </p>
              <Link
                to="/shop"
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors min-h-[44px]"
              >
                Browse the catalogue
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </Link>
            </div>
          </section>
        ) : (
          <>
            {/* ═══ COLLECTION INDEX — compact, restrained, anchors to the tiles ═══ */}
            {collections.length > 1 && (
              <nav aria-label="Collection index" className="py-5 sm:py-6 border-b border-[var(--color-botanical-border-light)]">
                <ol className="flex gap-x-6 gap-y-2 overflow-x-auto scrollbar-none -mx-4 px-4 sm:flex-wrap sm:mx-0 sm:px-0 list-none">
                  {collections.map((col, idx) => (
                    <li key={col.id} className="shrink-0 list-none">
                      <a
                        href={`#collection-${col.slug}`}
                        className="inline-flex items-baseline gap-2 min-h-[24px] text-[13px] font-semibold text-[var(--color-botanical-muted)] hover:text-[var(--color-accent)] transition-colors"
                      >
                        <span className="text-[10px] font-bold tabular-nums text-[var(--color-botanical-subtle)]">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        {col.name}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            )}

            {/* ═══ FEATURED COLLECTION — exactly one stronger visual ═══ */}
            <section id={`collection-${featured.slug}`} aria-label={`Featured collection: ${featured.name}`} ref={featuredRef} className="pt-8 sm:pt-10 scroll-mt-24">
              <div
                data-col-card
                className="group grid gap-5 sm:gap-8 lg:grid-cols-2 lg:items-center"
              >
                <div className="w-full overflow-hidden rounded-3xl bg-[var(--color-surface-low)] aspect-[4/3] sm:aspect-[16/9] lg:aspect-[4/3]">
                  <CollectionImage src={featured.image} alt={featured.name} />
                </div>
                <div className="space-y-3">
                  <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)] tabular-nums">
                    Featured · {featured.productCount} {featured.productCount === 1 ? 'piece' : 'pieces'}
                  </span>
                  <h2 className="font-serif text-[26px] sm:text-[32px] lg:text-[36px] leading-[1.12] font-normal text-[var(--color-botanical-primary)]">
                    {featured.name}
                  </h2>
                  {featured.description && (
                    <p className="text-[14px] sm:text-[15px] leading-relaxed text-[var(--color-botanical-muted)]">
                      {featured.description}
                    </p>
                  )}
                  <Link
                    to={collectionHref(featured)}
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors min-h-[44px]"
                  >
                    Browse collection
                    <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
                  </Link>
                </div>
              </div>

              {/* ═══ PRODUCT PREVIEW RAIL — real pieces, canonical card ═══ */}
              {featuredProducts.length > 0 && (
                <ul className="mt-8 sm:mt-10 flex gap-3 sm:gap-4 lg:gap-5 overflow-x-auto scrollbar-none snap-x snap-mandatory -mx-4 px-4 pb-1 list-none sm:mx-0 sm:px-0 sm:pb-0 sm:grid sm:grid-cols-2 lg:grid-cols-4 sm:overflow-visible">
                  {featuredProducts.slice(0, 4).map((p) => (
                    <li key={p.id} className="w-[64%] shrink-0 snap-start list-none sm:w-auto">
                      <ProductCard variant="compact" product={p} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ═══ REMAINING COLLECTIONS — compact, image-led, one aspect ratio ═══ */}
            {remaining.length > 0 && (
              <section aria-label="More collections" ref={restRef} className="pt-12 sm:pt-16">
                <h2 className="font-serif text-[20px] sm:text-[24px] text-[var(--color-botanical-primary)]">
                  More to explore
                </h2>
                <ul className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6 list-none p-0 m-0">
                  {remaining.map((col) => (
                    <li key={col.id} id={`collection-${col.slug}`} data-col-card className="list-none scroll-mt-24">
                      <Link
                        to={collectionHref(col)}
                        className="group flex h-full flex-col overflow-hidden rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border-light)] hover:border-[var(--color-border-strong)] transition-colors duration-300"
                      >
                        <div className="w-full aspect-[4/3] overflow-hidden bg-[var(--color-surface-low)]">
                          <CollectionImage src={col.image} alt={col.name} />
                        </div>
                        <div className="flex flex-1 flex-col gap-1.5 p-4 sm:p-5">
                          <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)] tabular-nums">
                            {col.productCount} {col.productCount === 1 ? 'piece' : 'pieces'}
                          </span>
                          <h3 className="font-serif text-[18px] leading-snug text-[var(--color-botanical-primary)] group-hover:text-[var(--color-accent)] transition-colors">
                            {col.name}
                          </h3>
                          {col.description && (
                            <p className="text-[13px] leading-5 text-[var(--color-botanical-muted)] line-clamp-2">
                              {col.description}
                            </p>
                          )}
                          <span className="mt-auto pt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-accent)] min-h-[24px]">
                            View pieces
                            <ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ═══ SMALL CLOSING CTA ═══ */}
            <section
              ref={ctaRef}
              data-cta
              className="mt-12 sm:mt-16 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] px-6 py-6 sm:px-8 sm:py-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
            >
              <div>
                <h2 className="font-serif text-[20px] sm:text-[22px] text-[var(--color-botanical-primary)]">
                  Planning a wedding, event, or a private keepsake drop?
                </h2>
                <p className="mt-1 text-[13px] text-[var(--color-botanical-muted)]">
                  Handcrafted favours, everlasting posies and bespoke family suites, made to order.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 shrink-0">
                <Link
                  to="/custom-gifts"
                  className="inline-flex items-center px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors min-h-[44px]"
                >
                  Custom Gift Studio
                </Link>
                <Link
                  to="/shop"
                  className="inline-flex items-center px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors min-h-[44px]"
                >
                  Shop all
                </Link>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
