import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles, Heart, Star, Eye, ShoppingBag, Brush, Gift, ShieldCheck } from 'lucide-react';
import ProductCard from '../components/ProductCard.jsx';
import { getProducts } from '../services/productService.js';
import { OCCASION_OPTIONS, RECIPIENT_OPTIONS } from '../services/giftFinderService.js';
import { gsap, ScrollTrigger, prefersReducedMotion, isDesktop } from '../lib/gsapSetup.js';

const FEATURED_OCCASIONS = ['birthday', 'anniversary', 'thank_you', 'festival', 'just_because', 'congratulations']
  .map((id) => OCCASION_OPTIONS.find((o) => o.id === id))
  .filter(Boolean);

const FEATURED_RECIPIENTS = ['partner', 'mom', 'best_friend', 'someone_special', 'colleague', 'myself']
  .map((id) => RECIPIENT_OPTIONS.find((r) => r.id === id))
  .filter(Boolean);

/**
 * Initialize GSAP ScrollTrigger animations, cursor parallax, and magnetic buttons.
 * Returns a cleanup function that kills all ScrollTriggers and stops animation frames.
 *
 * FIX: RAF cleanup is tracked OUTSIDE gsap.context so the outer cleanup
 * function can cancel them directly, independent of GSAP's inner-return
 * pattern which is fragile across GSAP/React version combinations.
 */
function initSpatialEffects() {
  if (prefersReducedMotion()) return () => {};
  const desktop = isDesktop();

  // Track RAF + event listeners OUTSIDE gsap.context for reliable cleanup
  const disposers = [];

  const ctx = gsap.context(() => {
    // ═══ HERO ENTRANCE TIMELINE ═══
    const hero = document.querySelector('[data-hero]');
    if (hero) {
      const heroTl = gsap.timeline({ delay: 0.1 });
      heroTl
        .fromTo(hero.querySelector('[data-hero-bg]'), { opacity: 0, scale: 1.1 }, { opacity: 1, scale: 1, duration: 1.2, ease: 'power3.out' }, 0)
        .fromTo(hero.querySelector('[data-hero-image]'), { opacity: 0, scale: 1.06, clipPath: 'inset(6% 6% 6% 6% round 24px)' }, { opacity: 1, scale: 1, clipPath: 'inset(0% 0% 0% 0% round 24px)', duration: 1, ease: 'power3.out' }, 0.15)
        .fromTo(hero.querySelector('[data-hero-badge]'), { opacity: 0, y: 14, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, ease: 'power3.out' }, 0.3)
        .fromTo(hero.querySelector('[data-hero-headline]'), { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' }, 0.4)
        .fromTo(hero.querySelector('[data-hero-sub]'), { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' }, 0.6)
        .fromTo(hero.querySelector('[data-hero-cta]'), { opacity: 0, y: 14, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, ease: 'power3.out' }, 0.75)
        .fromTo(hero.querySelectorAll('[data-hero-trust]'), { opacity: 0, y: 12, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.08, ease: 'power3.out' }, 0.9)
        .fromTo(hero.querySelector('[data-hero-float]'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' }, 0.8);
    }

    // ═══ SCROLL STORYTELLING — varied reveals ═══

    // Section: Collections — scale + reveal
    document.querySelectorAll('[data-story-collections]').forEach((el) => {
      gsap.fromTo(el, { opacity: 0, scale: 0.95, y: 30 }, {
        opacity: 1, scale: 1, y: 0, duration: 0.9, ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 85%', once: true },
      });
    });

    // Section: Stagger grids — children stagger in
    document.querySelectorAll('[data-stagger-grid]').forEach((grid) => {
      gsap.fromTo(grid.children, { opacity: 0, y: 24, scale: 0.97 }, {
        opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.07, ease: 'power2.out',
        scrollTrigger: { trigger: grid, start: 'top 85%', once: true },
      });
    });

    // Section: Reveal groups — children stagger
    document.querySelectorAll('[data-reveal]').forEach((el) => {
      gsap.fromTo(el.children, { opacity: 0, y: 30 }, {
        opacity: 1, y: 0, duration: 0.7, stagger: 0.08, ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 85%', once: true },
      });
    });

    // Section: Fade-ins — general
    document.querySelectorAll('[data-fade]').forEach((el) => {
      gsap.fromTo(el, { opacity: 0, y: 28 }, {
        opacity: 1, y: 0, duration: 0.8, ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 88%', once: true },
      });
    });

    // Section: Image reveals — mask wipe from left
    document.querySelectorAll('[data-story-img-reveal]').forEach((el) => {
      gsap.fromTo(el, { clipPath: 'polygon(0 0, 0 0, 0 100%, 0 100%)' }, {
        clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%)', duration: 1, ease: 'power3.inOut',
        scrollTrigger: { trigger: el, start: 'top 80%', once: true },
      });
    });

    // Section: Climb reveals — heavier weight
    document.querySelectorAll('[data-story-climb]').forEach((el) => {
      gsap.fromTo(el, { opacity: 0, y: 50, scale: 0.96 }, {
        opacity: 1, y: 0, scale: 1, duration: 0.9, ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 85%', once: true },
      });
    });

    // Section: Dark section — split left/right
    document.querySelectorAll('[data-story-split]').forEach((el) => {
      const left = el.querySelector('[data-split-left]');
      const right = el.querySelector('[data-split-right]');
      if (left) {
        gsap.fromTo(left, { opacity: 0, x: -40 }, {
          opacity: 1, x: 0, duration: 0.8, ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 80%', once: true },
        });
      }
      if (right) {
        gsap.fromTo(right, { opacity: 0, x: 40 }, {
          opacity: 1, x: 0, duration: 0.8, ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 80%', once: true },
        });
      }
    });

    // Parallax — elements with data-parallax="speed" — desktop only
    if (desktop) {
      document.querySelectorAll('[data-parallax]').forEach((el) => {
        const speed = parseFloat(el.dataset.parallax) || 0.1;
        gsap.to(el, {
          y: speed * 80, ease: 'none',
          scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: 1.5 },
        });
      });
    }

    // ═══ CURSOR PARALLAX — hero only, desktop ═══
    if (hero && desktop) {
      const targets = hero.querySelectorAll('[data-cursor-depth]');
      if (targets.length) {
        let mx = 0, my = 0, cx = 0, cy = 0;
        let rafId = null;
        let stopped = false;
        const onMouseMove = (e) => {
          const rect = hero.getBoundingClientRect();
          mx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
          my = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
        };
        hero.addEventListener('mousemove', onMouseMove, { passive: true });
        const animate = () => {
          if (stopped) return;
          cx += (mx - cx) * 0.08;
          cy += (my - cy) * 0.08;
          targets.forEach((el) => {
            const d = parseFloat(el.dataset.cursorDepth) || 1;
            el.style.transform = `translate3d(${cx * d * 12}px, ${cy * d * 8}px, 0)`;
          });
          rafId = requestAnimationFrame(animate);
        };
        rafId = requestAnimationFrame(animate);
        disposers.push(() => {
          stopped = true;
          hero.removeEventListener('mousemove', onMouseMove);
          if (rafId) cancelAnimationFrame(rafId);
        });
      }
    }

    // ═══ MAGNETIC BUTTONS — desktop only ═══
    if (desktop) {
      document.querySelectorAll('[data-magnetic]').forEach((btn) => {
        let bmx = 0, bmy = 0, bcx = 0, bcy = 0;
        let brafId = null;
        let stopped = false;
        const onMouseMove = (e) => {
          const rect = btn.getBoundingClientRect();
          bmx = (e.clientX - rect.left - rect.width / 2) * 0.25;
          bmy = (e.clientY - rect.top - rect.height / 2) * 0.25;
        };
        const animate = () => {
          if (stopped) return;
          bcx += (bmx - bcx) * 0.15;
          bcy += (bmy - bcy) * 0.15;
          btn.style.transform = `translate3d(${bcx}px, ${bcy}px, 0)`;
          bmx *= 0.85; bmy *= 0.85;
          brafId = requestAnimationFrame(animate);
        };
        btn.addEventListener('mousemove', onMouseMove, { passive: true });
        brafId = requestAnimationFrame(animate);
        disposers.push(() => {
          stopped = true;
          btn.removeEventListener('mousemove', onMouseMove);
          if (brafId) cancelAnimationFrame(brafId);
          btn.style.transform = '';
        });
      });
    }
  });

  // Return a single cleanup that handles BOTH GSAP and RAF/event cleanup
  return () => {
    ctx.revert();
    disposers.forEach((fn) => fn());
  };
}

export default function HomePage() {
  const [bestsellerFilter, setBestsellerFilter] = useState('all');
  const [monogramText, setMonogramText] = useState('For Sarah, with love');
  const [messageText, setMessageText] = useState(
    'May these flowers never fade, just like our quiet and lasting friendship. Happy Spring, darling.'
  );
  const [sealColor, setSealColor] = useState('#964735');

  const catalog = useMemo(() => getProducts(), []);
  const featuredSlugs = ['dusty-rose-lavender-posy', 'pressed-wildflower-cards', 'heirloom-keepsake-hamper', 'desk-bloom-ceramic-pot'];
  const filteredBestsellers = useMemo(() => {
    const picked = featuredSlugs.map((slug) => catalog.find((p) => p.id === slug)).filter(Boolean);
    let list = bestsellerFilter === 'all' ? picked : picked.filter((p) => p.category === bestsellerFilter);
    if (list.length === 0) list = catalog.filter((p) => bestsellerFilter === 'all' || p.category === bestsellerFilter).slice(0, 4);
    return list;
  }, [catalog, bestsellerFilter]);

  // Initialize GSAP effects once on mount
  useEffect(() => {
    const cleanup = initSpatialEffects();
    return cleanup;
  }, []);

  return (
    <div className="w-full">
      {/* ═══════════════════════════════════════════════════════════════
          1. HERO — Layered Spatial Composition
          ═══════════════════════════════════════════════════════════════ */}
      <section data-hero className="relative w-full overflow-hidden bg-gradient-to-b from-[#fcf9f4] via-[#f6f3ee]/50 to-[#fcf9f4] pt-8 pb-16 lg:py-20" style={{ perspective: '1200px' }}>
        {/* Layer 0: Background depth — enters first */}
        <div data-hero-bg className="absolute inset-0 pointer-events-none opacity-0">
          <div className="absolute -top-24 -left-20 w-96 h-96 rounded-full bg-[#ffdad3]/30 blur-3xl" />
          <div className="absolute top-1/3 right-10 w-80 h-80 rounded-full bg-[#d8e7cd]/25 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 w-64 h-64 rounded-full bg-[#ebe8e3]/40 blur-2xl" />
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center min-h-[580px]">
            <div className="lg:col-span-7 flex flex-col items-start gap-4">
              {/* Layer 4: Floating badge */}
              <div data-hero-badge data-cursor-depth="0.3" className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#ebe8e3] text-[var(--color-botanical-muted)] shadow-sm opacity-0">
                <span className="w-2 h-2 rounded-full bg-[#964735] animate-pulse" />
                <span className="text-[11px] font-bold uppercase tracking-widest">The Artisanal Gift Atelier · Handcrafted in Small Batches</span>
              </div>

              {/* Layer 5: Headline */}
              <div data-hero-headline data-cursor-depth="0.15" className="opacity-0">
                <h1 className="font-serif text-[36px] sm:text-[48px] md:text-[54px] lg:text-[62px] text-[var(--color-botanical-primary)] font-normal tracking-tight leading-[1.08] max-w-2xl">
                  Handmade with love.{' '}
                  <span className="italic font-light text-[#964735]">Made specially</span> for you.
                </h1>
              </div>

              <div data-hero-sub className="opacity-0">
                <p className="text-[15px] sm:text-[17px] text-[var(--color-botanical-muted)] max-w-xl leading-relaxed">
                  Thoughtfully handcrafted flowers, personalized gifts, and little tactile things made to bring pure delight. Infused with timeless floral alchemy and bespoke devotion.
                </p>
              </div>

              {/* Layer 6: CTAs */}
              <div data-hero-cta className="flex flex-wrap items-center gap-3 pt-2 w-full sm:w-auto opacity-0">
                <span data-magnetic><Link to="/shop" className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-full bg-[#180f0a] text-white shadow-md hover:bg-[#964735] hover:-translate-y-0.5 hover:shadow-lg transition-all duration-300 text-[13px] font-semibold tracking-wide"><span>Shop Collection</span><ArrowRight className="w-4 h-4" /></Link></span>
                <span data-magnetic><Link to="/custom-gifts" className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-full bg-[#ebe8e3] text-[var(--color-botanical-text)] hover:bg-[#ffdad3]/50 hover:-translate-y-0.5 transition-all duration-300 text-[13px] font-semibold tracking-wide"><Sparkles className="w-4 h-4 text-[#964735]" /><span>Create a Custom Gift</span></Link></span>
                <span data-magnetic><Link to="/gift-finder" className="inline-flex items-center justify-center gap-2 px-5 py-3.5 rounded-full text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:text-[#964735] transition-colors"><Gift className="w-4 h-4 text-[#964735]" /><span>Find a Gift</span></Link></span>
              </div>

              {/* Trust badges */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-6 w-full">
                {[{ emoji: '🌿', bg: '#d8e7cd', label: 'Handmade with care' }, { emoji: '🌸', bg: '#ffdad3', label: 'Everlasting blooms' }, { emoji: '💌', bg: '#ebe8e3', label: 'Handwritten wax card' }].map((b, i) => (
                  <div key={b.label} data-hero-trust data-cursor-depth={0.2 + i * 0.05} className="flex items-center gap-2.5 p-3 rounded-2xl bg-[var(--color-surface-lowest)]/80 border border-[var(--color-botanical-border)] shadow-xs hover:-translate-y-0.5 transition-transform duration-300 opacity-0">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: b.bg }}><span className="text-[16px]">{b.emoji}</span></div>
                    <span className="text-[13px] text-[var(--color-botanical-text)] font-medium">{b.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Layer 2+3: Image composition with botanical decor */}
            <div className="lg:col-span-5 relative h-[400px] sm:h-[480px] lg:h-[600px] w-full flex items-center justify-center">
              {/* Ambient light glow */}
              <div className="absolute inset-0 rounded-3xl overflow-hidden pointer-events-none">
                <div className="absolute -top-8 -left-8 w-64 h-64 rounded-full bg-[#ffdad3]/40 blur-3xl" />
                <div className="absolute bottom-12 -right-6 w-48 h-48 rounded-full bg-[#d8e7cd]/30 blur-2xl" />
              </div>
              {/* Botanical texture layer — floating decorative elements */}
              <div data-hero-float data-cursor-depth="0.1" className="absolute inset-0 rounded-3xl overflow-hidden pointer-events-none opacity-0">
                <div className="absolute top-6 right-8 text-[60px] sm:text-[80px] opacity-20 rotate-12 fa-float-slow">🌸</div>
                <div className="absolute bottom-20 left-6 text-[40px] sm:text-[60px] opacity-15 -rotate-6 fa-drift">🌿</div>
                <div className="absolute top-1/3 left-12 text-[30px] sm:text-[50px] opacity-10 rotate-45 fa-float-subtle">✨</div>
              </div>
              {/* Main image with parallax — enters second */}
              <div data-hero-image data-parallax="0.08" className="relative w-full h-[340px] sm:h-[420px] lg:h-[540px] rounded-3xl overflow-hidden shadow-2xl border border-[var(--color-botanical-border)] opacity-0">
                <img loading="eager" decoding="async" src="/assets/images/flora-asset-25.jpg" alt="Flora Alchemy handcrafted floral arrangement" className="w-full h-full object-cover transition-transform duration-700 hover:scale-105" />
                <div className="absolute inset-0 bg-gradient-to-t from-[#180f0a]/20 via-transparent to-transparent pointer-events-none" />
              </div>
              {/* Floating metadata badge */}
              <div data-cursor-depth="0.4" className="absolute bottom-4 sm:bottom-6 left-3 right-3 sm:left-4 sm:right-4 p-3 rounded-2xl bg-[var(--color-surface-lowest)]/90 backdrop-blur-md shadow-md flex items-center justify-between">
                <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[#964735] animate-ping" /><span className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-text)]">Flora Alchemy Atelier</span></div>
                <span className="text-[11px] sm:text-[12px] text-[var(--color-botanical-muted)] italic">Handcrafted in India</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          2. CURATED CRAFT COLLECTIONS — Scale reveal
          ═══════════════════════════════════════════════════════════════ */}
      <section data-story-collections className="w-full py-16 lg:py-24 bg-[var(--color-surface-bg)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-12">
            <div className="max-w-xl space-y-1">
              <p className="text-[11px] uppercase tracking-widest font-bold text-[#964735]">Artisanal Taxonomy</p>
              <h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[40px] text-[var(--color-botanical-primary)] tracking-tight font-normal">Curated Craft Collections</h2>
              <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)]">Explore our signature handmade creations sculpted one stem, fiber, and stitch at a time.</p>
            </div>
            <Link to="/collections" className="inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:text-[#964735] transition-colors"><span>View all archives</span><ArrowRight className="w-4 h-4" /></Link>
          </div>
          <div data-stagger-grid data-reveal className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 lg:gap-6">
            {[
              { to: '/shop?category=bouquets', emoji: '🌸', badge: 'Iconic', badgeBg: '#ffdad3', badgeText: '#964735', title: 'Flowers & Bouquets', desc: 'Everlasting chenille wire & velvet blossoms wrapped in deckled washi paper.', cta: 'Explore Stems', glow: '#ffdad3' },
              { to: '/shop?category=cards', emoji: '💌', badge: 'Pressed', badgeBg: '#d8e7cd', badgeText: '#5b6d54', title: 'Handmade Sentiment Cards', desc: 'Pressed botanical paper, custom dip-pen ink & wax seal impressions.', cta: 'View Stationery', glow: '#d8e7cd' },
              { to: '/custom-gifts', emoji: '🎁', badge: 'Bespoke', badgeBg: '#f1dfd5', badgeText: '#180f0a', title: 'Custom Keepsake Hampers', desc: 'Tailored gift bundles wrapped with French velvet bows and dried flora.', cta: 'Build A Hamper', glow: '#fd9882' },
              { to: '/shop?category=charms', emoji: '🧸', badge: 'Fuzzy Charm', badgeBg: '#ebe8e3', badgeText: '#4e4540', title: 'Handcrafted Keychains', desc: 'Tactile chenille mascots, miniature flower pots, and pocket keepsakes.', cta: 'Browse Charms', glow: null },
              { to: '/shop?category=cards', emoji: '✨', badge: 'Foil Touch', badgeBg: '#ffdad3', badgeText: '#964735', title: 'Foil Stickers & Botanical Art', desc: 'Embossed gold leaf illustrations, archival bookmarks, and vinyl seals.', cta: 'View Art Prints', glow: null },
              { to: '/collections', emoji: '🪔', badge: 'Seasonal Edition', badgeBg: '#964735', badgeText: '#ffdad3', title: 'Festive Keepsakes', desc: "Diwali, Mother's Day, and seasonal celebratory milestone creations.", cta: 'Explore Limited Drops', glow: '#964735', dark: true },
            ].map((card) => (
              <Link key={card.title} to={card.to} className={`group relative rounded-3xl p-5 lg:p-6 transition-all duration-300 flex flex-col justify-between h-68 lg:h-72 overflow-hidden border border-[var(--color-botanical-border)] hover:shadow-xl hover:-translate-y-1 ${card.dark ? 'bg-[#2e241e] text-white border-[#180f0a]' : 'bg-[var(--color-surface-low)] hover:bg-[var(--color-surface-container)]'}`}>
                {card.glow && <div className="absolute top-0 right-0 w-44 h-44 rounded-full -mr-10 -mt-10 blur-2xl group-hover:scale-125 transition-transform duration-500" style={{ backgroundColor: `${card.glow}40` }} />}
                <div className="relative z-10 flex items-start justify-between">
                  <span className={`p-3 rounded-2xl shadow-sm text-2xl ${card.dark ? 'bg-[#180f0a]' : 'bg-[var(--color-surface-lowest)]'}`}>{card.emoji}</span>
                  <span className="text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded-full" style={{ backgroundColor: card.badgeBg, color: card.badgeText }}>{card.badge}</span>
                </div>
                <div className="relative z-10 space-y-1">
                  <h3 className={`font-serif text-[20px] lg:text-[22px] transition-colors ${card.dark ? 'text-white group-hover:text-[#ffdad3]' : 'text-[var(--color-botanical-primary)] group-hover:text-[#964735]'}`}>{card.title}</h3>
                  <p className={`text-[13px] leading-relaxed ${card.dark ? 'text-[#d4c3ba]' : 'text-[var(--color-botanical-muted)]'}`}>{card.desc}</p>
                  <div className={card.dark ? "pt-2 inline-flex items-center gap-1 text-[12px] font-bold text-[#ffdad3]" : "pt-2 inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-botanical-primary)]"}><span>{card.cta}</span><ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-1" /></div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          2b. SHOP BY OCCASION & RECIPIENT — Staggered grid
          ═══════════════════════════════════════════════════════════════ */}
      <section className="w-full py-16 lg:py-20 bg-[var(--color-surface-bg)] border-t border-[var(--color-botanical-border)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-14">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
            <div className="lg:col-span-4 space-y-3 lg:sticky lg:top-28">
              <span className="text-[11px] font-bold uppercase tracking-widest text-[#964735]">Gift with intention</span>
              <h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[38px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-tight">Shop by occasion.</h2>
              <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed">Start from the moment you&apos;re celebrating. Each occasion opens the handcrafted pieces that suit it.</p>
              <Link to="/gift-finder" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:text-[#964735] transition-colors pt-1"><span>Not sure? Use the Gift Finder</span><ArrowRight className="w-4 h-4" /></Link>
            </div>
            <div data-reveal data-stagger-grid className="lg:col-span-8 grid grid-cols-2 sm:grid-cols-3 gap-3">
              {FEATURED_OCCASIONS.map((o) => (
                <Link key={o.id} to={`/shop?occasion=${o.id}`} className="group flex flex-col justify-between gap-3 p-4 lg:p-5 rounded-3xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-container)] hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300 min-h-[100px] lg:min-h-[108px]">
                  <span className="text-xl lg:text-2xl" aria-hidden="true">{o.icon}</span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-serif text-[16px] lg:text-[18px] text-[var(--color-botanical-primary)] group-hover:text-[#964735] transition-colors">{o.label}</span>
                    <ArrowRight className="w-4 h-4 text-[var(--color-botanical-subtle)] group-hover:text-[#964735] transition-all duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
                  </span>
                </Link>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start pt-10 border-t border-[var(--color-botanical-border)]">
            <div className="lg:col-span-4 space-y-3 lg:sticky lg:top-28">
              <span className="text-[11px] font-bold uppercase tracking-widest text-[#964735]">For the people you love</span>
              <h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[38px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-tight">Shop by recipient.</h2>
              <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed">Choose who the gift is for and browse pieces our studio most often crafts for them.</p>
            </div>
            <div data-stagger-grid className="lg:col-span-8 grid grid-cols-2 sm:grid-cols-3 gap-3">
              {FEATURED_RECIPIENTS.map((r) => (
                <Link key={r.id} to={`/shop?recipient=${r.id}`} className="group flex flex-col justify-between gap-3 p-4 lg:p-5 rounded-3xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] hover:border-[#964735] hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300 min-h-[100px] lg:min-h-[108px]">
                  <span className="text-xl lg:text-2xl" aria-hidden="true">{r.icon}</span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-serif text-[16px] lg:text-[18px] text-[var(--color-botanical-primary)] group-hover:text-[#964735] transition-colors">{r.label}</span>
                    <ArrowRight className="w-4 h-4 text-[var(--color-botanical-subtle)] group-hover:text-[#964735] transition-all duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          3. BELOVED CREATIONS — Image mask reveal style
          ═══════════════════════════════════════════════════════════════ */}
      <section className="w-full py-16 lg:py-24 bg-[var(--color-surface-low)] border-t border-[var(--color-botanical-border)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 mb-12">
            <div>
              <div className="inline-flex items-center gap-1 text-[#964735] text-[11px] uppercase font-bold tracking-wider mb-1"><Star className="w-3.5 h-3.5 fill-[#964735]" /><span>Artisan Atelier Favorites</span></div>
              <h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[40px] text-[var(--color-botanical-primary)] tracking-tight font-normal">Beloved Creations</h2>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {[{ key: 'all', label: 'All Keepsakes' }, { key: 'bouquets', label: 'Sculpted Bouquets' }, { key: 'cards', label: 'Botanical Cards' }, { key: 'hampers', label: 'Gift Boxes' }].map((f) => (
                <button key={f.key} onClick={() => setBestsellerFilter(f.key)} className={`px-3.5 lg:px-4 py-1.5 rounded-full text-[12px] font-semibold transition-all duration-200 ${bestsellerFilter === f.key ? 'bg-[#180f0a] text-white shadow-sm' : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] border border-[var(--color-botanical-border)] hover:border-[#180f0a]'}`}>{f.label}</button>
              ))}
            </div>
          </div>
          <div data-story-img-reveal data-stagger-grid data-reveal className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 lg:gap-6">
            {filteredBestsellers.map((p) => <ProductCard key={p.id} product={p} />)}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          4. CUSTOM GIFT STUDIO — Climb reveal
          ═══════════════════════════════════════════════════════════════ */}
      <section className="w-full py-16 lg:py-24 bg-[var(--color-surface-bg)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div data-story-climb className="text-center max-w-2xl mx-auto mb-16 space-y-2">
            <div className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-[#ffdad3]/50 text-[#964735] text-[11px] font-bold uppercase tracking-wider"><Brush className="w-3.5 h-3.5" /><span>Bespoke Digital Atelier</span></div>
            <h2 className="font-serif text-[28px] sm:text-[36px] lg:text-[44px] text-[var(--color-botanical-primary)] tracking-tight font-normal">Create something that is uniquely theirs.</h2>
            <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed">Step into our craft studio. We personalize your heartfelt vision from individual sculpted petals to customized wax-stamped gift tags.</p>
          </div>
          <div data-reveal data-stagger-grid className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 lg:gap-6 mb-16">
            {[
              { num: '1', emoji: '🪴', title: 'Choose Your Base', desc: 'Select from an everlasting bouquet, pine keepsake box, or desktop ceramic pot.', tag: '4 physical canvases', tc: '#964735' },
              { num: '2', emoji: '🎨', title: 'Personalize Palette', desc: 'Pick your botanical hues, select silk or velvet ribbons, and draft your custom message.', tag: 'Curated mineral pigments', tc: '#964735' },
              { num: '3', emoji: '✂️', title: 'We Handcraft', desc: 'Our artisans shape each wire stem and apply pressed dried flora with dedicated care.', tag: 'Takes 2-3 studio days', tc: '#5b6d54' },
              { num: '4', emoji: '📦', title: 'You Gift With Joy', desc: 'Packed in rigid boxes, finished with a wax stamp seal, and delivered safely across India.', tag: 'Pan-India dispatch', tc: '#964735' },
            ].map((s) => (
              <div key={s.num} className="p-5 lg:p-6 rounded-3xl bg-[var(--color-surface-low)] flex flex-col justify-between space-y-4 border border-[var(--color-botanical-border)] hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300">
                <div className="flex items-center justify-between"><span className="w-9 h-9 rounded-full bg-[#180f0a] text-white font-serif text-[18px] flex items-center justify-center">{s.num}</span><span className="text-2xl">{s.emoji}</span></div>
                <div><h3 className="font-serif text-[18px] lg:text-[20px] text-[var(--color-botanical-primary)] mb-1 font-medium">{s.title}</h3><p className="text-[13px] text-[var(--color-botanical-muted)] leading-relaxed">{s.desc}</p></div>
                <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: s.tc }}>{s.tag}</span>
              </div>
            ))}
          </div>
          <div data-fade className="rounded-3xl bg-[var(--color-surface-low)] p-5 lg:p-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center border border-[var(--color-botanical-border)] shadow-sm">
            <div className="lg:col-span-7 space-y-4">
              <span className="text-[11px] uppercase font-bold tracking-widest text-[#964735]">Live Atelier Previewer</span>
              <h3 className="font-serif text-[22px] sm:text-[26px] lg:text-[32px] text-[var(--color-botanical-primary)] tracking-tight font-normal">Try Our Instant Gift Note & Wax Seal Customizer</h3>
              <p className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)]">Type your message below and watch it render live on our simulated deckled cotton card with your choice of wax seal.</p>
              <div className="space-y-3 max-w-lg">
                <div><label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">Envelope Addressee / Recipient</label><input type="text" value={monogramText} onChange={(e) => setMonogramText(e.target.value)} className="w-full px-4 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow" /></div>
                <div><label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">Handwritten Botanical Card Message</label><textarea rows={3} value={messageText} onChange={(e) => setMessageText(e.target.value)} className="w-full p-3.5 rounded-2xl bg-[var(--color-surface-lowest)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] resize-none transition-shadow" /></div>
                <div className="flex items-center gap-3 pt-1">
                  <span className="text-[11px] uppercase font-bold text-[var(--color-botanical-muted)]">Wax Seal Color:</span>
                  {[{ color: '#964735', label: 'Terracotta' }, { color: '#5B6D54', label: 'Sage' }, { color: '#B89746', label: 'Burnished Gold' }].map((s) => (
                    <button key={s.color} type="button" onClick={() => setSealColor(s.color)} style={{ backgroundColor: s.color }} className={`w-6 h-6 rounded-full shadow-sm transition-all duration-200 ${sealColor === s.color ? 'ring-2 ring-[#180f0a] scale-110' : 'hover:scale-105 hover:shadow-md'}`} title={s.label} />
                  ))}
                </div>
              </div>
            </div>
            <div className="lg:col-span-5 flex justify-center">
              <div className="relative w-full max-w-sm p-5 lg:p-6 rounded-2xl bg-[#faf7f2] shadow-xl border border-[var(--color-botanical-border)] rotate-1 hover:rotate-0 transition-all duration-500 hover:shadow-2xl">
                <div style={{ backgroundColor: sealColor }} className="absolute -top-3 -right-3 w-10 h-10 rounded-full shadow-md flex items-center justify-center text-white text-[11px] font-serif font-bold tracking-widest border border-white/30 transition-colors duration-300">FA</div>
                <div className="space-y-3">
                  <div className="border-b border-[var(--color-botanical-border)] pb-2"><span className="text-[10px] uppercase font-bold tracking-widest text-[#964735]">Deckled Cotton Card</span><p className="font-serif text-[16px] lg:text-[18px] text-[var(--color-botanical-primary)] italic">{monogramText || 'For Someone Special'}</p></div>
                  <p className="font-serif text-[14px] lg:text-[16px] text-[var(--color-botanical-text)] leading-relaxed italic pt-1">&ldquo;{messageText || 'Thinking of you with fond botanical thoughts.'}&rdquo;</p>
                  <div className="pt-4 flex items-center justify-between text-[10px] text-[var(--color-botanical-subtle)] font-bold uppercase tracking-widest"><span>Hand-inscribed · Flora Alchemy</span><span>No. FA-2025</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          5. SEASONAL SPOTLIGHT — Split left/right reveal
          ═══════════════════════════════════════════════════════════════ */}
      <section className="w-full py-16 lg:py-20 bg-[#180f0a] text-white relative overflow-hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div data-story-split className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-center">
            <div data-split-left className="lg:col-span-7 space-y-4">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#964735] text-white text-[11px] font-bold uppercase"><Sparkles className="w-3.5 h-3.5" /><span>Limited Seasonal Vault</span></div>
              <h2 className="font-serif text-[30px] sm:text-[36px] lg:text-[48px] text-white tracking-tight leading-tight">The Spring Blossom & Keepsake Archive</h2>
              <p className="text-[14px] sm:text-[16px] text-[#d4c3ba] max-w-xl leading-relaxed">Sculpted from dusty blush chenille velvet and botanical cotton thread. Each limited batch suite is hand-bound with a pressed botanical greeting scroll, wax medallions, and presentation gift boxes.</p>
              <div className="pt-2"><span data-magnetic><Link to="/collections" className="inline-flex items-center gap-2 px-7 py-3 rounded-full bg-[#ffdad3] text-[var(--color-botanical-primary)] font-semibold text-[13px] hover:bg-[var(--color-surface-lowest)] transition-all shadow-md"><span>Explore Seasonal Vault</span><ArrowRight className="w-4 h-4" /></Link></span></div>
            </div>
            <div data-split-right className="lg:col-span-5 flex justify-center">
              <div data-parallax="0.1" className="relative w-full max-w-md aspect-[4/3] rounded-3xl overflow-hidden shadow-2xl border border-white/10">
                <img loading="lazy" decoding="async" src="/assets/images/flora-asset-25.jpg" alt="Spring Blossom Archive" className="w-full h-full object-cover transition-transform duration-700 hover:scale-105" />
                <div className="absolute bottom-3 left-3 right-3 p-3 rounded-2xl bg-[#180f0a]/80 backdrop-blur-md flex items-center justify-between text-white text-[12px] sm:text-[13px]"><span className="font-medium">Limited Hamper: The Spring Vault</span><span className="font-bold text-[#ffdad3]">₹3,450</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          6. ATELIER STORY — Image reveal + text stagger
          ═══════════════════════════════════════════════════════════════ */}
      <section className="w-full py-16 lg:py-24 bg-[var(--color-surface-bg)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div data-reveal className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
            <div className="lg:col-span-6 relative">
              <div data-story-img-reveal data-parallax="0.06" className="relative rounded-3xl overflow-hidden shadow-xl aspect-[4/3] border border-[var(--color-botanical-border)]">
                <img loading="lazy" decoding="async" src="/assets/images/flora-asset-13.jpg" alt="Flora Alchemy Studio Table" className="w-full h-full object-cover transition-transform duration-700 hover:scale-105" />
              </div>
              <div className="absolute -bottom-4 right-2 sm:right-6 p-3 lg:p-4 rounded-2xl bg-[var(--color-surface-lowest)] shadow-lg border border-[var(--color-botanical-border)] flex items-center gap-3 hover:-translate-y-0.5 transition-transform duration-300">
                <span className="text-xl lg:text-2xl">🌱</span>
                <div><p className="text-[11px] font-bold uppercase text-[#964735]">Genuine Craft</p><p className="text-[12px] lg:text-[13px] font-semibold text-[var(--color-botanical-primary)]">Handmade in Small Batches</p></div>
              </div>
            </div>
            <div className="lg:col-span-6 space-y-4">
              <span className="text-[11px] font-bold uppercase tracking-widest text-[#964735]">Our Studio Atelier</span>
              <h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[40px] text-[var(--color-botanical-primary)] tracking-tight leading-tight font-normal">Crafting flowers designed to <span className="italic font-light text-[#964735]">endure</span>.</h2>
              <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed">Flora Alchemy began with a quiet desire for gifts that outlive fleeting moments. Every flower petal is individually shaped from high-density velvet chenille wire, bound with unbleached cotton threads, and accompanied by hand-deckled cards.</p>
              <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed">When you hold our creations, you feel the soft plush texture of velvet wire, the organic deckle of rag paper, and the personal touch of wax seals stamped by hand.</p>
              <div data-stagger-grid className="grid grid-cols-3 gap-3 pt-3">
                {[{ l: 'Handmade', s: 'Petal-by-petal' }, { l: 'Personalized', s: 'With wax seals' }, { l: 'Made to Order', s: 'Tailored gifting' }].map((i) => (
                  <div key={i.l} className="p-3 lg:p-3.5 rounded-2xl bg-[var(--color-surface-low)] text-center border border-[var(--color-botanical-border)] hover:-translate-y-0.5 hover:shadow-md transition-all duration-300"><p className="font-serif text-[16px] lg:text-[18px] text-[var(--color-botanical-primary)] font-medium">{i.l}</p><p className="text-[10px] lg:text-[11px] text-[var(--color-botanical-subtle)]">{i.s}</p></div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          7. FOUR PILLARS — Staggered cards
          ═══════════════════════════════════════════════════════════════ */}
      <section className="w-full py-16 bg-[var(--color-surface-low)] border-t border-[var(--color-botanical-border)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div data-fade className="text-center max-w-xl mx-auto mb-12 space-y-1"><span className="text-[11px] font-bold uppercase tracking-widest text-[#964735]">The Atelier Creed</span><h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[38px] text-[var(--color-botanical-primary)] tracking-tight font-normal">Four Pillars of Every Creation</h2></div>
          <div data-reveal data-stagger-grid className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 lg:gap-6">
            {[
              { n: '01 / Genuine Handcraft', t: 'Human Touches', d: 'Every stem, leaf twist, and card fold is assembled with patient human touch.' },
              { n: '02 / Personalization', t: 'Uniquely Crafted', d: 'Add personalized monogram tags, custom handwritten letters, and tailor color combinations.' },
              { n: '03 / Tactile Quality', t: 'Everlasting Materials', d: 'High-density chenille wire, Japanese washi papers, raw silk ribbons, and deckled cotton cards.' },
              { n: '04 / Thoughtful Joy', t: 'Enduring Keepsakes', d: 'Crafted to sit on desks, nightstands, and bookshelf nooks for years without wilting.' },
            ].map((p) => (
              <div key={p.n} className="p-5 lg:p-6 rounded-3xl bg-[var(--color-surface-lowest)] shadow-sm flex flex-col justify-between border border-[var(--color-botanical-border)] hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300"><span className="text-[11px] font-bold uppercase tracking-wider text-[#964735]">{p.n}</span><h3 className="font-serif text-[18px] lg:text-[20px] text-[var(--color-botanical-primary)] my-2 font-medium">{p.t}</h3><p className="text-[13px] text-[var(--color-botanical-muted)] leading-relaxed">{p.d}</p></div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          8. SENTIMENTS — Climb reveal
          ═══════════════════════════════════════════════════════════════ */}
      <section className="w-full py-16 lg:py-24 bg-[var(--color-surface-bg)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div data-story-climb className="mb-12"><span className="text-[11px] font-bold uppercase tracking-widest text-[#964735]">Gifting Inscriptions</span><h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[40px] text-[var(--color-botanical-primary)] tracking-tight font-normal">Card Messages & Dedicated Sentiments</h2></div>
          <div data-reveal data-stagger-grid className="grid grid-cols-1 md:grid-cols-3 gap-5 lg:gap-6">
            {[
              { l: 'Sisterly Gratitude', q: '"May these dusty rose petals remind you of how deeply you are appreciated, through every season."', p: 'The Dusty Rose Posy' },
              { l: 'Anniversary Milestone', q: '"For ten years of shared laughter, quiet mornings, and blossoms that never lose their warmth."', p: 'Keepsake Wooden Hamper' },
              { l: 'Workplace Desk Cheer', q: '"A joyful desk bloom to keep your workdays calm, bright, and filled with creative energy."', p: 'Desk Bloom Ceramic Pot' },
            ].map((c) => (
              <div key={c.l} className="p-6 lg:p-7 rounded-3xl bg-[var(--color-surface-low)] flex flex-col justify-between space-y-4 border border-[var(--color-botanical-border)] hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300">
                <span className="text-[11px] uppercase font-bold text-[#964735]">{c.l}</span>
                <p className="font-serif text-[16px] lg:text-[18px] text-[var(--color-botanical-primary)] italic leading-relaxed">{c.q}</p>
                <div className="pt-2 border-t border-[var(--color-botanical-border)]"><p className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">Sample Card Dedication</p><p className="text-[12px] text-[var(--color-botanical-subtle)]">Paired with {c.p}</p></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          9. CLOSING CTA — Scale reveal
          ═══════════════════════════════════════════════════════════════ */}
      <section className="w-full py-16 lg:py-20 bg-[#ebe8e3] text-center">
        <div data-story-climb className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 space-y-4">
          <span className="text-[11px] font-bold uppercase tracking-widest text-[#964735]">Made For Memories That Last</span>
          <h2 className="font-serif text-[30px] sm:text-[36px] lg:text-[46px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.1]">Make someone&apos;s ordinary day feel <span className="italic font-light text-[#964735]">extraordinary</span>.</h2>
          <p className="text-[14px] sm:text-[16px] text-[var(--color-botanical-muted)] max-w-xl mx-auto leading-relaxed">Whether it&apos;s a silent gesture of gratitude, an anniversary milestone, or just a little something to make them smile today.</p>
          <div className="pt-4 flex flex-wrap items-center justify-center gap-3">
            <span data-magnetic><Link to="/shop" className="px-7 lg:px-8 py-3.5 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] transition-all text-[13px] font-semibold shadow-md hover:shadow-lg hover:-translate-y-0.5">Shop All Handcrafted Pieces</Link></span>
            <span data-magnetic><Link to="/custom-gifts" className="px-7 lg:px-8 py-3.5 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-container)] transition-all text-[13px] font-semibold shadow-sm border border-[var(--color-botanical-border)] hover:shadow-md hover:-translate-y-0.5">Custom Gift Studio</Link></span>
          </div>
          <p className="text-[12px] text-[var(--color-botanical-subtle)] pt-4">Complimentary handwritten botanical card included with orders above ₹1,999.</p>
        </div>
      </section>
    </div>
  );
}
