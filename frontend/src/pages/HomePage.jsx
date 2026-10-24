import React, { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Gift, Heart, Sparkles, Star, Leaf } from 'lucide-react';
import ProductCard from '../components/ProductCard.jsx';
import { getProducts } from '../services/productService.js';
import { useStoreVersion } from '../hooks/useStoreVersion.js';
import { OCCASION_OPTIONS, RECIPIENT_OPTIONS } from '../services/giftFinderService.js';
import {
  useCinematic,
  pullBack,
  pushIn,
  trackX,
  crane,
  parallax,
  maskReveal,
  focusPull,
  sceneEnter,
  magneticButtons,
} from '../lib/cinematicMotion.js';
import { SplitText, Magnetic } from '../components/cinematic/MotionBits.jsx';

/**
 * THE HOMEPAGE — a camera travelling through the atelier.
 *
 * Creative direction: the site feels three-dimensional because a camera moves
 * through REAL PHOTOGRAPHY, not because anything is rendered in 3D. Eight
 * scenes, one continuous scroll:
 *
 *   01 OPENING      the brand, revealed by a pull-back from posy to maker
 *   02 REVEAL       the workshop, tracked laterally with a foreground plane
 *   03 CRAFT        four macro frames — paper, petals, the note, the wrap
 *   04 COLLECTIONS  large photographic panels into the real catalogue routes
 *   05 PIECES       the live catalogue, presented cleanly
 *   06 STUDIO       a push-in on a wrapped gift, handed to the Custom Gift Studio
 *   07 STORY        the collective, in editorial split
 *   08 CLOSING      a crane pull-back on the finished posy, into the footer
 *
 * LOAD-BEARING RULES (see lib/cinematicMotion.js):
 *  — Nothing is hidden in markup. Every initial state is applied by GSAP
 *    inside a context, so reduced motion and a failed script both show the
 *    finished page. (The previous homepage hid its hero behind `opacity-0`
 *    classes that reduced motion never cleared — that class of bug is why.)
 *  — All real product data wiring (catalogue, filters, occasions, recipients,
 *    craft groups, featured products) is preserved exactly.
 *  — Only verified-existing image paths are referenced: the suite fails a
 *    walk of the storefront on any failed request.
 */

/* Verified brand photography. All portrait (279–286 × 512) except the square
   hero posy — compositions below are framed accordingly: portrait frames and
   heavy-crop billboards, never a stretched landscape. */
const IMG = Object.freeze({
  makerPosy: '/assets/images/flora-asset-26.jpg', // maker holding the posy — the atelier
  posySquare: '/assets/images/flora-asset-01.jpg', // posy in hands, 512×512 — the close
  wrappedTag: '/assets/images/flora-asset-03.jpg', // wrapped posy + handwritten tag
  giftSeal: '/assets/images/flora-asset-04.jpg', // kraft box, velvet ribbon, wax seal
  lavenderMacro: '/assets/images/flora-asset-05.jpg', // chenille lavender on linen
  cardsWax: '/assets/images/flora-asset-06.jpg', // pressed cards + wax seals
  paperSeal: '/assets/images/flora-asset-07.jpg', // deckled card, pansies, brass stamp
  letterSeal: '/assets/images/flora-asset-08.jpg', // calligraphy letter + pressed flowers
  potBloom: '/assets/images/flora-asset-09.jpg', // chamomile in ceramic pot
  hamper: '/assets/images/flora-asset-11.jpg', // open hamper, velvet interior
  atelierWide: '/assets/images/flora-asset-13.jpg', // the workshop table
  charm: '/assets/images/flora-asset-16.jpg', // sunflower charm
  twineBundle: '/assets/images/flora-asset-21.jpg', // botanicals + orange thread
  atelierTable: '/assets/images/flora-asset-25.jpg', // gifts on the workshop table
});

/* ═══════════════════════════════════════════════════════════════════════
   Scene components. Each owns its camera work through `useCinematic`,
   which scopes and cleans up every tween and trigger with the section.
   ═══════════════════════════════════════════════════════════════════════ */

/** 01 — OPENING FRAME. The camera starts close on the posy in the maker's
 *  hands and pulls back as the heading settles: detail first, atelier second. */
function SceneOpening() {
  const ref = useRef(null);

  useCinematic(ref, () => {
    const q = (sel) => ref.current.querySelector(sel);

    // The camera: a slow pull-back on the portrait frame, scrubbed.
    pullBack(q('[data-scene-img]'), { from: 1.22, to: 1, start: 'top top', end: 'bottom top', scrub: 1.4 });
    // A whisper of lateral drift so the frame never feels like a zoom alone.
    trackX(q('[data-scene-img]'), { distance: 14, scrub: 1.6 });

    // The reveal: a matte lift on the frame, once.
    maskReveal(q('[data-scene-frame]'), { start: 'top 92%', duration: 1.1 });

    // Typography settles after the frame begins to open.
    sceneEnter(ref.current, '[data-enter]', { y: 26, stagger: 0.09, start: 'top 95%' });

    magneticButtons(ref.current);
  });

  return (
    <section
      ref={ref}
      data-scene="opening"
      aria-labelledby="home-heading"
      className="fa-paper-grain relative w-full overflow-hidden bg-[var(--color-surface-bg)]"
    >
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-5 pt-14 pb-16 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16 lg:px-10 lg:pt-20 lg:pb-24">
        {/* ── Typography column ── */}
        <div className="flex flex-col items-start">
          <p
            data-enter
            className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-4 py-1.5 text-[10px] font-bold tracking-[0.22em] text-[var(--color-botanical-muted)] uppercase"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
            Handcrafted botanical keepsakes · Small batches
          </p>

          <h1
            id="home-heading"
            data-enter
            className="font-serif text-[clamp(2.6rem,7vw,4.75rem)] leading-[1.02] tracking-[-0.02em] text-[var(--color-botanical-primary)]"
          >
            <SplitText text="Flora Alchemy" />
          </h1>

          <p data-enter className="mt-4 font-serif text-[clamp(1.15rem,2.6vw,1.7rem)] leading-snug text-[var(--color-accent)] italic">
            Sculpted Nature. Hand-Bound Memories.
          </p>

          <p data-enter className="mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--color-botanical-muted)] sm:text-base">
            One-of-a-kind floral art, deckled stationery and memory keepsakes — sculpted petal by petal,
            wrapped by hand, and written to order in our botanical atelier.
          </p>

          <div data-enter className="mt-8 flex flex-wrap items-center gap-3">
            <Magnetic>
              <Link
                to="/shop"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] px-7 py-3.5 text-[13px] font-semibold tracking-wide text-white shadow-md transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--color-btn-hover)] hover:shadow-lg"
              >
                <span>Shop All Gifts</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Magnetic>
            <Magnetic>
              <Link
                to="/custom-gifts"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-7 py-3.5 text-[13px] font-semibold tracking-wide text-[var(--color-botanical-text)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--color-badge-bg)]/50"
              >
                <Sparkles className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
                <span>Custom Gifts</span>
              </Link>
            </Magnetic>
          </div>

          {/* The four shopping doors the storefront owes a first-time visitor:
              shop, collections, gift finder — all real routes, all above the
              fold on every viewport. */}
          <div data-enter className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link to="/collections" className="inline-flex items-center gap-2 py-1 text-[13px] font-semibold text-[var(--color-botanical-primary)] transition-colors hover:text-[var(--color-accent)]">
              <Leaf className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
              <span>Explore Collections</span>
            </Link>
            <Link to="/gift-finder" className="inline-flex items-center gap-2 py-1 text-[13px] font-semibold text-[var(--color-botanical-primary)] transition-colors hover:text-[var(--color-accent)]">
              <Gift className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
              <span>Find a Gift</span>
            </Link>
            <a href="#collections" className="inline-flex items-center gap-2 py-1 text-[13px] font-semibold text-[var(--color-botanical-primary)] transition-colors hover:text-[var(--color-accent)]">
              <Heart className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
              <span>Shop by Craft</span>
            </a>
          </div>

          <ul data-enter className="mt-10 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { label: 'Independent Indian makers', Icon: Heart },
              { label: 'Small-batch handcraft', Icon: Leaf },
              { label: 'Complimentary handwritten card', Icon: Gift },
            ].map(({ label, Icon }) => (
              <li
                key={label}
                className="flex items-center gap-3 rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-3"
              >
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-badge-bg)]"
                >
                  <Icon className="h-4 w-4 text-[var(--color-badge-fg-strong)]" />
                </span>
                <span className="text-[12.5px] font-medium leading-snug text-[var(--color-botanical-text)]">{label}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* ── The frame: portrait, revealed like a matte lifting ── */}
        <div data-scene-frame className="relative mx-auto w-full max-w-[26rem] lg:max-w-none">
          <div className="relative aspect-[3/4] overflow-hidden rounded-[1.75rem] border border-[var(--color-botanical-border)] shadow-[0_32px_80px_-32px_rgba(24,15,10,0.45)]">
            <img
              data-scene-img
              src={IMG.makerPosy}
              alt="A maker in the Flora Alchemy atelier holding a finished Dusty Rose & Lavender posy"
              loading="eager"
              decoding="async"
              className="h-full w-full object-cover object-center will-change-transform"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-black/35 to-transparent" aria-hidden="true" />
          </div>
          <p className="mt-3 text-center text-[11px] tracking-[0.18em] text-[var(--color-botanical-subtle)] uppercase">
            Shot in the atelier · Every stem placed by hand
          </p>
        </div>
      </div>
    </section>
  );
}

/** 02 — THE BOTANICAL REVEAL. A wide billboard of the workshop the camera
 *  tracks across, with a near-plane (the wrapped posy) drifting slower to
 *  build depth — the collection invitation rides the far wall. */
function SceneReveal({ onShopHref }) {
  const ref = useRef(null);

  useCinematic(ref, () => {
    const q = (sel) => ref.current.querySelector(sel);
    trackX(q('[data-billboard]'), { distance: 26, scrub: 1.5 });
    pullBack(q('[data-billboard]'), { from: 1.12, to: 1, start: 'top bottom', end: 'bottom top', scrub: 1.2 });
    parallax(q('[data-foreground]'), 0.22);
    parallax(q('[data-caption-plane]'), 0.08);
    sceneEnter(ref.current, '[data-enter]', { y: 30, stagger: 0.1, start: 'top 80%' });
  });

  return (
    <section ref={ref} data-scene="reveal" className="relative w-full overflow-hidden bg-[var(--color-surface-bg)] py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
        <div data-enter className="mb-8 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="max-w-xl">
            <p className="text-[11px] font-bold tracking-[0.24em] text-[var(--color-accent)] uppercase">Inside the atelier</p>
            <h2 className="mt-2 font-serif text-[clamp(1.75rem,4vw,2.6rem)] leading-tight tracking-tight text-[var(--color-botanical-primary)]">
              A workshop table, mid-composition.
            </h2>
          </div>
          <Link
            to={onShopHref}
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-botanical-primary)] transition-colors hover:text-[var(--color-accent)]"
          >
            <span>Browse what it makes</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>

        {/* The billboard: the wide workshop frame, camera tracking across it. */}
        <div className="relative aspect-[4/3] overflow-hidden rounded-[1.75rem] border border-[var(--color-botanical-border)] bg-[var(--color-surface-container)] shadow-[0_40px_90px_-40px_rgba(24,15,10,0.4)] sm:aspect-[16/9]">
          <img
            data-billboard
            src={IMG.atelierWide}
            alt="The Flora Alchemy workshop table dressed with bouquets, wrapped gifts, spools of ribbon and dried botanicals beside a garden window"
            loading="lazy"
            decoding="async"
            className="h-full w-full scale-[1.14] object-cover object-center will-change-transform"
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent" aria-hidden="true" />

          {/* Near plane: the wrapped posy, drifting against the billboard. */}
          <div
            data-foreground
            className="absolute right-4 bottom-4 w-28 overflow-hidden rounded-2xl border border-white/40 shadow-xl sm:right-8 sm:bottom-8 sm:w-44"
          >
            <img
              src={IMG.wrappedTag}
              alt="A wrapped posy tied with silk and finished with a handwritten tag"
              loading="lazy"
              decoding="async"
              className="aspect-[3/4] w-full object-cover"
            />
          </div>

          {/* Far plane: the caption, barely moving. */}
          <div data-caption-plane className="absolute bottom-5 left-5 max-w-xs sm:bottom-8 sm:left-8">
            <p className="rounded-2xl bg-[var(--color-surface-lowest)]/92 px-4 py-3 text-[12.5px] leading-relaxed text-[var(--color-botanical-text)] shadow-lg backdrop-blur-sm">
              <span className="font-bold tracking-[0.14em] text-[var(--color-accent)] uppercase text-[10px]">Today&apos;s table</span><br />
              Posies drying, ribbons cut to length, seals warming — everything you receive begins here.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* Scene 03 — CRAFT: four macro frames. Each enters through a mask and a
   focus pull — the sequence reads as cuts in a film, not a card grid. */
const CRAFT_FRAMES = [
  {
    img: IMG.paperSeal,
    alt: 'A deckled cotton-rag card decorated with pressed pansies beside a brass wax stamp',
    kicker: 'The paper',
    title: 'Pressed the same morning',
    body: 'Cotton-rag stock with a true deckled edge. Wildflowers are pressed into the sheet, so no two cards share a surface.',
  },
  {
    img: IMG.lavenderMacro,
    alt: 'A close view of a chenille lavender stem on natural linen',
    kicker: 'The bloom',
    title: 'Sculpted, stem by stem',
    body: 'Every petal is shaped by hand from chenille and velvet — botanical sculpture that keeps its season permanently.',
  },
  {
    img: IMG.letterSeal,
    alt: 'A handwritten letter surrounded by pressed flowers and sealed with green wax',
    kicker: 'The note',
    title: 'Written, then sealed',
    body: 'Your message is lettered by hand on the card, folded into the wrap, and closed with a real wax seal.',
  },
  {
    img: IMG.twineBundle,
    alt: 'A bundle of dried botanicals tied with orange thread on a wooden board',
    kicker: 'The wrap',
    title: 'Bound and finished',
    body: 'Hand-dyed silk, velvet cord or jute twine — tied around the finished piece and packed to travel safely across India.',
  },
];

function SceneCraft() {
  const ref = useRef(null);

  useCinematic(ref, () => {
    const frames = ref.current.querySelectorAll('[data-craft-frame]');
    frames.forEach((frame) => {
      maskReveal(frame, { start: 'top 84%', duration: 0.9, direction: frame.dataset.craftDir || 'up' });
      focusPull(frame.querySelector('img'), { start: 'top 84%', blur: 8 });
      sceneEnter(frame, '[data-craft-copy]', { y: 22, stagger: 0.08, start: 'top 88%' });
    });
  });

  return (
    <section ref={ref} data-scene="craft" className="fa-paper-grain relative w-full overflow-hidden bg-[var(--color-surface-low)] py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
        <div className="mb-10 max-w-2xl lg:mb-14">
          <p className="text-[11px] font-bold tracking-[0.24em] text-[var(--color-accent)] uppercase">How it is made</p>
          <h2 className="mt-2 font-serif text-[clamp(1.75rem,4vw,2.6rem)] leading-tight tracking-tight text-[var(--color-botanical-primary)]">
            Four frames from the bench.
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-10 sm:gap-12 lg:grid-cols-2 lg:gap-x-14 lg:gap-y-14">
          {CRAFT_FRAMES.map((frame, index) => (
            <article
              key={frame.kicker}
              data-craft-frame
              data-craft-dir={index % 2 === 0 ? 'left' : 'up'}
              className={index % 2 === 1 ? 'lg:mt-10' : undefined}
            >
              <div className="overflow-hidden rounded-[1.5rem] border border-[var(--color-botanical-border)] shadow-[0_28px_64px_-32px_rgba(24,15,10,0.38)]">
                <img
                  src={frame.img}
                  alt={frame.alt}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[3/4] w-full object-cover will-change-[filter]"
                />
              </div>
              <div data-craft-copy className="mt-5 max-w-md">
                <p className="text-[11px] font-bold tracking-[0.2em] text-[var(--color-accent)] uppercase">{frame.kicker}</p>
                <h3 className="mt-1.5 font-serif text-[22px] leading-snug tracking-tight text-[var(--color-botanical-primary)]">{frame.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-[var(--color-botanical-muted)]">{frame.body}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   The data-driven half of the page. Real catalogue wiring, preserved from
   the previous homepage exactly: categories, counts, occasions, recipients,
   featured products and their filter all come from the live store.
   ═══════════════════════════════════════════════════════════════════════ */

/** 04 — COLLECTIONS: large photographic panels into the real shop routes. */
function SceneCollections({ craftGroups }) {
  const ref = useRef(null);

  useCinematic(ref, () => {
    const q = (sel) => ref.current.querySelector(sel);
    sceneEnter(ref.current, '[data-enter]', { y: 26, stagger: 0.09, start: 'top 82%' });
    // Each panel's photograph pushes in gently as it arrives — the subject
    // leans toward the reader, then rests.
    ref.current.querySelectorAll('[data-panel-img]').forEach((img) => pushIn(img, { from: 1.05, to: 1, start: 'top 88%', end: 'top 40%', scrub: 1 }));
    parallax(q('[data-panel-accent]'), 0.12);
  });

  const panels = [
    {
      to: '/shop?category=bouquets',
      img: IMG.posySquare,
      alt: 'A Dusty Rose and Lavender posy held in two hands',
      kicker: 'Sculpted bouquets',
      title: 'Floral art that keeps its season',
      body: 'Chenille and velvet blooms arranged as a posy, in a vessel, or as a single stem.',
    },
    {
      to: '/shop?category=cards',
      img: IMG.cardsWax,
      alt: 'A set of pressed-wildflower cards finished with terracotta wax seals',
      kicker: 'Stationery',
      title: 'Pressed, lettered, sealed',
      body: 'Deckled cards with real pressed botanicals, dip-pen lettering and wax seal impressions.',
    },
    {
      to: '/custom-gifts',
      img: IMG.hamper,
      alt: 'An open keepsake hamper with a dark green velvet interior holding handcrafted blooms and cards',
      kicker: 'Bespoke',
      title: 'Composed for one person',
      body: 'Choose the base, palette, ribbon and seal — a maker assembles it to order.',
    },
  ];

  return (
    <section ref={ref} id="collections" data-scene="collections" className="scroll-mt-24 w-full overflow-hidden bg-[var(--color-surface-bg)] py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
        <div data-enter className="mb-10 max-w-2xl">
          <p className="text-[11px] font-bold tracking-[0.24em] text-[var(--color-accent)] uppercase">The catalogue</p>
          <h2 className="mt-2 font-serif text-[clamp(1.75rem,4vw,2.6rem)] leading-tight tracking-tight text-[var(--color-botanical-primary)]">
            Three ways to give something made by hand.
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:gap-8">
          {panels.map((panel) => (
            <Link
              key={panel.to + panel.kicker}
              to={panel.to}
              data-enter
              className="group relative flex h-full flex-col overflow-hidden rounded-[1.5rem] border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] transition-all duration-300 hover:-translate-y-1 hover:shadow-xl"
            >
              <div className="relative aspect-[3/4] overflow-hidden bg-[var(--color-surface-container)]">
                <img
                  data-panel-img
                  src={panel.img}
                  alt={panel.alt}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.04] will-change-transform"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/40 to-transparent" aria-hidden="true" />
                <span className="absolute bottom-4 left-4 rounded-full bg-[var(--color-surface-lowest)]/94 px-3.5 py-1.5 text-[10px] font-bold tracking-[0.18em] text-[var(--color-accent)] uppercase shadow">
                  {panel.kicker}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-2 p-5 lg:p-6">
                <h3 className="font-serif text-[20px] leading-snug tracking-tight text-[var(--color-botanical-primary)] transition-colors group-hover:text-[var(--color-accent)]">
                  {panel.title}
                </h3>
                <p className="text-[13.5px] leading-relaxed text-[var(--color-botanical-muted)]">{panel.body}</p>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-3 text-[12px] font-bold text-[var(--color-botanical-primary)]">
                  <span>Explore</span>
                  <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-1" aria-hidden="true" />
                </span>
              </div>
            </Link>
          ))}
        </div>

        {/* The craft chips only earn their row when the catalogue actually
            holds two or more groups — one lone chip under a heading reads as
            an unfinished component, which is exactly what it would be. */}
        {craftGroups.length > 1 && (
          <div data-enter className="mt-12 flex flex-wrap items-center gap-2.5">
            <span className="mr-1 text-[11px] font-bold tracking-[0.2em] text-[var(--color-botanical-subtle)] uppercase">In the catalogue now</span>
            {craftGroups.map((group) => (
              <Link
                key={group.key}
                to={`/shop?category=${encodeURIComponent(group.key)}`}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-4 py-2 text-[12.5px] font-semibold text-[var(--color-botanical-text)] transition-all duration-200 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                <span>{group.label}</span>
                <span className="text-[11px] text-[var(--color-botanical-subtle)]">{group.count}</span>
              </Link>
            ))}
          </div>
        )}

        {/* Occasion & recipient discovery — real routes, kept compact. */}
        <div data-enter className="mt-12 grid grid-cols-1 gap-10 border-t border-[var(--color-botanical-border)] pt-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="text-[11px] font-bold tracking-[0.24em] text-[var(--color-accent)] uppercase">Gift with intention</p>
            <h3 className="mt-2 font-serif text-[24px] tracking-tight text-[var(--color-botanical-primary)]">Shop by occasion.</h3>
            <ul className="mt-4 flex flex-wrap gap-2">
              {OCCASION_OPTIONS.filter((o) => ['birthday', 'anniversary', 'thank_you', 'festival', 'just_because', 'congratulations'].includes(o.id)).map((o) => (
                <li key={o.id}>
                  <Link
                    to={`/shop?occasion=${o.id}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--color-botanical-text)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    <span aria-hidden="true">{o.icon}</span>
                    <span>{o.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-[11px] font-bold tracking-[0.24em] text-[var(--color-accent)] uppercase">For someone in particular</p>
            <h3 className="mt-2 font-serif text-[24px] tracking-tight text-[var(--color-botanical-primary)]">Shop by recipient.</h3>
            <ul className="mt-4 flex flex-wrap gap-2">
              {RECIPIENT_OPTIONS.filter((r) => ['partner', 'mom', 'best_friend', 'someone_special', 'colleague', 'myself'].includes(r.id)).map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/shop?recipient=${r.id}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--color-botanical-text)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    <span aria-hidden="true">{r.icon}</span>
                    <span>{r.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p data-enter className="mt-10 text-center">
          <Link to="/gift-finder" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-botanical-primary)] transition-colors hover:text-[var(--color-accent)]">
            <span>Not sure yet? Let the Gift Finder shortlist it for you</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </p>
      </div>
    </section>
  );
}

/** 05 — PIECES: the live catalogue, presented cleanly. Camera steps back
 *  here on purpose — shopping must stay legible. */
function ScenePieces({ products, filter, onFilter }) {
  const ref = useRef(null);

  useCinematic(ref, () => {
    sceneEnter(ref.current, '[data-enter]', { y: 22, stagger: 0.08, start: 'top 85%' });
    magneticButtons(ref.current);
  });

  const FILTERS = [
    { key: 'all', label: 'All Keepsakes' },
    { key: 'bouquets', label: 'Sculpted Bouquets' },
    { key: 'cards', label: 'Botanical Cards' },
    { key: 'hampers', label: 'Gift Boxes' },
  ];

  return (
    <section ref={ref} data-scene="pieces" className="w-full border-t border-[var(--color-botanical-border)] bg-[var(--color-surface-bg)] py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
        <div data-enter className="mb-10 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.22em] text-[var(--color-accent)] uppercase">
              <Star className="h-3.5 w-3.5 fill-[var(--color-accent)]" aria-hidden="true" />
              Beloved pieces
            </p>
            <h2 className="mt-2 font-serif text-[clamp(1.75rem,4vw,2.4rem)] tracking-tight text-[var(--color-botanical-primary)]">
              What the studio makes most.
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter featured pieces">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => onFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`rounded-full px-4 py-1.5 text-[12px] font-semibold transition-all duration-200 ${
                  filter === f.key
                    ? 'bg-[var(--color-btn)] text-white shadow-sm'
                    : 'border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] hover:border-[var(--color-focus)] hover:text-[var(--color-botanical-primary)]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div data-enter className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** 06 — THE STUDIO INVITATION. A push-in on the wrapped gift: the camera
 *  leans toward the finished object, then the door to the real studio opens. */
function SceneStudio() {
  const ref = useRef(null);

  useCinematic(ref, () => {
    const q = (sel) => ref.current.querySelector(sel);
    pushIn(q('[data-studio-img]'), { from: 1, to: 1.12, start: 'top bottom', end: 'center center', scrub: 1.2 });
    sceneEnter(ref.current, '[data-enter]', { y: 26, stagger: 0.1, start: 'top 78%' });
    magneticButtons(ref.current);
  });

  return (
    <section ref={ref} data-scene="studio" className="relative w-full overflow-hidden bg-[var(--color-surface-low)] py-16 lg:py-24">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-5 sm:px-8 lg:grid-cols-2 lg:gap-16 lg:px-10">
        <div data-enter className="relative order-2 lg:order-1">
          <div className="overflow-hidden rounded-[1.75rem] border border-[var(--color-botanical-border)] shadow-[0_36px_80px_-36px_rgba(24,15,10,0.45)]">
            <img
              data-studio-img
              src={IMG.giftSeal}
              alt="A kraft keepsake box bound with dusty-rose velvet ribbon and closed with a wax seal, on a linen-dressed table"
              loading="lazy"
              decoding="async"
              className="aspect-[3/4] w-full object-cover will-change-transform"
            />
          </div>
        </div>
        <div data-enter className="order-1 flex flex-col items-start lg:order-2">
          <p className="text-[11px] font-bold tracking-[0.24em] text-[var(--color-accent)] uppercase">The Custom Gift Studio</p>
          <h2 className="mt-3 font-serif text-[clamp(1.85rem,4.4vw,2.9rem)] leading-tight tracking-tight text-[var(--color-botanical-primary)]">
            Choose every part.<br className="hidden sm:block" /> A maker builds it.
          </h2>
          <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-[var(--color-botanical-muted)]">
            Base, blooms, palette, ribbon, seal, monogram and message — compose the keepsake in the studio,
            then a maker in the collective assembles it by hand. Pricing, stock and delivery are calculated
            by the shop, every time.
          </p>
          <ul className="mt-6 grid w-full max-w-lg grid-cols-2 gap-3 text-[13px] text-[var(--color-botanical-text)]">
            {['Four physical bases', 'Curated mineral palettes', 'Real wax seal & monogram', 'Pan-India delivery'].map((t) => (
              <li key={t} className="flex items-center gap-2.5 rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-3.5 py-2.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
                {t}
              </li>
            ))}
          </ul>
          <div className="mt-8">
            <Magnetic>
              <Link
                to="/custom-gifts"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] px-7 py-3.5 text-[13px] font-semibold tracking-wide text-white shadow-md transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--color-btn-hover)] hover:shadow-lg"
              >
                <span>Start a Custom Gift</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Magnetic>
          </div>
        </div>
      </div>
    </section>
  );
}

/** 07 — STORY. Editorial split; the workshop photograph and the collective's
 *  own words, with the charter kept as real content. */
function SceneStory() {
  const ref = useRef(null);

  useCinematic(ref, () => {
    const q = (sel) => ref.current.querySelector(sel);
    crane(q('[data-story-img]'), { distance: 26, scaleFrom: 1.08, scaleTo: 1, scrub: 1.3 });
    sceneEnter(ref.current, '[data-enter]', { y: 24, stagger: 0.08, start: 'top 82%' });
  });

  return (
    <section ref={ref} data-scene="story" className="w-full overflow-hidden bg-[var(--color-surface-bg)] py-16 lg:py-24">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-5 sm:px-8 lg:grid-cols-12 lg:gap-14 lg:px-10">
        <div data-enter className="lg:col-span-6">
          <div className="overflow-hidden rounded-[1.75rem] border border-[var(--color-botanical-border)] shadow-[0_32px_72px_-36px_rgba(24,15,10,0.4)]">
            <img
              data-story-img
              src={IMG.atelierTable}
              alt="Wrapped gifts, ribbon spools and dried botanicals arranged across the Flora Alchemy workshop table"
              loading="lazy"
              decoding="async"
              className="aspect-[4/3] w-full object-cover will-change-transform"
            />
          </div>
        </div>
        <div data-enter className="lg:col-span-6">
          <p className="text-[11px] font-bold tracking-[0.24em] text-[var(--color-accent)] uppercase">The collective</p>
          <h2 className="mt-2 font-serif text-[clamp(1.75rem,4vw,2.6rem)] leading-tight tracking-tight text-[var(--color-botanical-primary)]">
            Crafted by many hands, made to <span className="font-light text-[var(--color-accent)] italic">endure</span>.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-[var(--color-botanical-muted)]">
            Flora Alchemy began with a quiet desire for gifts that outlive fleeting moments. Every keepsake is
            handcrafted by an independent maker working in their own studio — small batches, patient detail,
            never an assembly line.
          </p>
          <p className="mt-3 text-[15px] leading-relaxed text-[var(--color-botanical-muted)]">
            What the collective adds is everything around the craft: one trusted storefront, quality checking,
            protective presentation packaging, and a handwritten card with every order.
          </p>
          <dl className="mt-7 grid grid-cols-3 gap-3">
            {[
              { t: 'Handmade', d: 'Petal-by-petal' },
              { t: 'Personalised', d: 'With wax seals' },
              { t: 'Made to order', d: 'Tailored gifting' },
            ].map((i) => (
              <div key={i.t} className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-3.5 text-center">
                <dt className="font-serif text-[16px] font-medium text-[var(--color-botanical-primary)]">{i.t}</dt>
                <dd className="mt-0.5 text-[11px] text-[var(--color-botanical-subtle)]">{i.d}</dd>
              </div>
            ))}
          </dl>
          <Link to="/our-story" className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-botanical-primary)] transition-colors hover:text-[var(--color-accent)]">
            <span>Read our story</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

/** 08 — CLOSING. A crane pull-back on the finished posy: the film ends on
 *  the object the customer came for, then hands into the footer. */
function SceneClosing() {
  const ref = useRef(null);

  useCinematic(ref, () => {
    const q = (sel) => ref.current.querySelector(sel);
    crane(q('[data-close-img]'), { distance: 34, scaleFrom: 1.14, scaleTo: 1, scrub: 1.4 });
    maskReveal(q('[data-close-frame]'), { start: 'top 90%', duration: 1.0, direction: 'up' });
    sceneEnter(ref.current, '[data-enter]', { y: 24, stagger: 0.09, start: 'top 85%' });
    magneticButtons(ref.current);
  });

  return (
    <section ref={ref} data-scene="closing" className="fa-paper-grain relative w-full overflow-hidden bg-[var(--color-surface-high)] py-16 lg:py-24">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-5 sm:px-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-16 lg:px-10">
        <div data-close-frame className="relative mx-auto w-full max-w-[22rem]">
          <div className="overflow-hidden rounded-[1.75rem] border border-[var(--color-botanical-border)] shadow-[0_36px_80px_-36px_rgba(24,15,10,0.5)]">
            <img
              data-close-img
              src={IMG.posySquare}
              alt="The finished Dusty Rose and Lavender posy, tied with frayed silk"
              loading="lazy"
              decoding="async"
              className="aspect-square w-full object-cover will-change-transform"
            />
          </div>
        </div>
        <div data-enter className="text-center lg:text-left">
          <p className="text-[11px] font-bold tracking-[0.24em] text-[var(--color-accent)] uppercase">Our gifting creed</p>
          <h2 className="mx-auto mt-3 max-w-2xl font-serif text-[clamp(1.9rem,4.6vw,3rem)] leading-[1.1] tracking-tight text-[var(--color-botanical-primary)] lg:mx-0">
            Because a personalised gift says:{' '}
            <span className="font-light text-[var(--color-accent)] italic">I thought about you.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-[var(--color-botanical-muted)] lg:mx-0">
            A gesture of gratitude, an anniversary milestone, or a little something to make them smile today —
            find a piece made by hand for exactly that.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            <Magnetic>
              <Link
                to="/shop"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] px-7 py-3.5 text-[13px] font-semibold tracking-wide text-white shadow-md transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--color-btn-hover)] hover:shadow-lg"
              >
                <span>Explore All Gifts</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Magnetic>
            <Magnetic>
              <Link
                to="/custom-gifts"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-7 py-3.5 text-[13px] font-semibold tracking-wide text-[var(--color-botanical-text)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--color-surface-container)]"
              >
                Custom Gift Studio
              </Link>
            </Magnetic>
          </div>
          <p className="mt-6 text-[12px] text-[var(--color-botanical-subtle)]">
            Complimentary handwritten botanical card included with orders above ₹1,999.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════ */

export default function HomePage() {
  const [bestsellerFilter, setBestsellerFilter] = useState('all');

  const storeVersion = useStoreVersion();
  const catalog = useMemo(() => getProducts(), [storeVersion]);

  const featuredSlugs = ['dusty-rose-lavender-posy', 'pressed-wildflower-cards', 'heirloom-keepsake-hamper', 'desk-bloom-ceramic-pot'];

  // Shop by Craft shows the REAL craft categories the live catalogue contains
  // — grouped from products, counted from products, linked to the real shop
  // filter. These are `Product.category` groupings, NOT a maker/creator
  // entity: no Maker model or field exists in the backend, so this section
  // never claims to represent independent businesses.
  const craftGroups = useMemo(() => {
    const byCategory = new Map();
    catalog
      .filter((p) => p.visibility !== 'Hidden')
      .forEach((p) => {
        const key = p.category || 'other';
        if (!byCategory.has(key)) {
          byCategory.set(key, {
            key,
            label: p.categoryLabel || 'Handmade',
            count: 0,
            image: (p.images && p.images[0]) || p.image || '',
          });
        }
        byCategory.get(key).count += 1;
      });
    return [...byCategory.values()].sort((a, b) => b.count - a.count).slice(0, 3);
  }, [catalog]);

  const filteredBestsellers = useMemo(() => {
    const picked = featuredSlugs.map((slug) => catalog.find((p) => p.id === slug)).filter(Boolean);
    let list = bestsellerFilter === 'all' ? picked : picked.filter((p) => p.category === bestsellerFilter);
    if (list.length === 0) list = catalog.filter((p) => bestsellerFilter === 'all' || p.category === bestsellerFilter).slice(0, 4);
    return list;
  }, [catalog, bestsellerFilter]);

  return (
    <div className="w-full">
      <SceneOpening />
      <SceneReveal onShopHref="/shop" />
      <SceneCraft />
      <SceneCollections craftGroups={craftGroups} />
      <ScenePieces products={filteredBestsellers} filter={bestsellerFilter} onFilter={setBestsellerFilter} />
      <SceneStudio />
      <SceneStory />
      <SceneClosing />
    </div>
  );
}
