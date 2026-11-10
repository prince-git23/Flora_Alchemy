import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Gift, Heart, Leaf, Sparkles, Star } from 'lucide-react';
import { gsap, ScrollTrigger, prefersReducedMotion } from '../../lib/gsapSetup.js';
import { useCinematic, pullBack, trackX, maskReveal, sceneEnter, magneticButtons } from '../../lib/cinematicMotion.js';
import { SplitText, Magnetic } from './MotionBits.jsx';
import { useStore } from '../../context/StoreContext.jsx';
import { useStageCapability } from './useStageCapability.js';
import Crosshair from './Crosshair.jsx';

/**
 * The hero crosshair, tuned DOWN from the library defaults: one hairline, no
 * coordinate readout, a longer easing tail and a low-opacity ink so it reads as
 * a quiet instrument over the photograph rather than a HUD. Mounted only on a
 * wide fine-pointer viewport without reduced motion — never on touch, never on
 * a phone, never for a visitor who asked for stillness.
 */
function useHeroCrosshair() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setEnabled(fine.matches && !reduce.matches);
    update();
    fine.addEventListener('change', update);
    reduce.addEventListener('change', update);
    return () => {
      fine.removeEventListener('change', update);
      reduce.removeEventListener('change', update);
    };
  }, []);
  return enabled;
}

function HeroCrosshair({ containerRef, color }) {
  return (
    <Crosshair
      containerRef={containerRef}
      color={color || '#964735'}
      thickness={1}
      opacity={0.4}
      gap={6}
      fade={0.5}
      smoothing={0.55}
      showCoordinates={false}
      targetEffect="lock"
      clickPulse
    />
  );
}

const HeroFragments = lazy(() => import('./HeroFragments.jsx'));

/**
 * HERO STAGE — the index hero, unchanged at rest.
 *
 * With fewer than two catalogue hero items, no WebGL, Save-Data or
 * prefers-reduced-motion, it renders the original editorial hero. With two to
 * five ordered hero products it pins for 520vh desktop / 340vh mobile and runs
 * one scrubbed story: the real product photograph lifts into fragments, rings
 * orbit it, and the next real product re-forms from those pixels. The card,
 * type, buttons, radii, palette and spacing are the existing site's.
 *
 * The canvas is lazy and never in the page chunk. Product copy, links, alt text
 * and prices all come from the catalogue; nothing is hard-coded.
 */

const INTRO = 0.08;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function readAccentToken() {
  if (typeof window === 'undefined') return '#964735';
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#964735'
  );
}

function samplePhotoAccent(url) {
  return new Promise((resolve) => {
    if (!url) return resolve('');
    const img = new Image();
    if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous';
    img.onload = () => {
      const size = 20;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return resolve('');
      ctx.drawImage(img, 0, 0, size, size);
      let r = 0;
      let g = 0;
      let b = 0;
      let weight = 0;
      try {
        const data = ctx.getImageData(0, 0, size, size).data;
        for (let i = 0; i < data.length; i += 4) {
          const rr = data[i];
          const gg = data[i + 1];
          const bb = data[i + 2];
          const max = Math.max(rr, gg, bb);
          const min = Math.min(rr, gg, bb);
          const sat = max === 0 ? 0 : (max - min) / max;
          const w = 0.15 + sat;
          r += rr * w;
          g += gg * w;
          b += bb * w;
          weight += w;
        }
      } catch {
        return resolve('');
      }
      if (!weight) return resolve('');
      const hex = (n) => Math.max(0, Math.min(255, Math.round(n / weight))).toString(16).padStart(2, '0');
      return resolve(`#${hex(r)}${hex(g)}${hex(b)}`);
    };
    img.onerror = () => resolve('');
    img.src = url;
  });
}

function rgba(hex, alpha) {
  const value = String(hex || '').replace('#', '');
  if (value.length !== 6) return `rgba(150,71,53,${alpha})`;
  const n = parseInt(value, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function StaticHero({ item, fallbackImage, fallbackAlt }) {
  const ref = useRef(null);
  const image = item?.heroCutout || item?.images?.[0] || fallbackImage;
  const alt = item?.name ? `${item.name}, photographed for Flora Alchemy` : fallbackAlt;

  useCinematic(ref, () => {
    const q = (sel) => ref.current.querySelector(sel);
    pullBack(q('[data-scene-img]'), { from: 1.22, to: 1, start: 'top top', end: 'bottom top', scrub: 1.4 });
    trackX(q('[data-scene-img]'), { distance: 14, scrub: 1.6 });
    maskReveal(q('[data-scene-frame]'), { start: 'top 92%', duration: 1.1 });
    sceneEnter(ref.current, '[data-enter]', { y: 26, stagger: 0.09, start: 'top 95%' });
    magneticButtons(ref.current);
  });

  return (
    <section
      ref={ref}
      data-scene="opening"
      data-hero-mode="static"
      aria-labelledby="home-heading"
      className="fa-paper-grain relative w-full overflow-hidden bg-[var(--color-surface-bg)]"
    >
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-5 pt-14 pb-16 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16 lg:px-10 lg:pt-20 lg:pb-24">
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

        <div data-scene-frame className="relative mx-auto w-full max-w-[26rem] lg:max-w-none">
          <div className="relative aspect-[3/4] overflow-hidden rounded-[1.75rem] border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] shadow-[0_32px_80px_-32px_rgba(24,15,10,0.45)]">
            <img
              data-scene-img
              src={image}
              alt={alt}
              loading="eager"
              decoding="async"
              fetchPriority="high"
              className={`h-full w-full will-change-transform ${item?.heroCutout ? 'object-contain p-8' : 'object-cover object-center'}`}
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

function MotionHero({ items, fallbackImage, fallbackAlt }) {
  const ref = useRef(null);
  const cardRef = useRef(null);
  const cardFrameRef = useRef(null);
  const glareRef = useRef(null);
  const flashRef = useRef(null);
  const pinRef = useRef(null);
  const motionRef = useRef({ p: 0, swirl: 0 });
  const activeRef = useRef(-1);
  const [active, setActive] = useState(-1);
  const [near, setNear] = useState(false);
  const [accent, setAccent] = useState(readAccentToken);
  const crosshair = useHeroCrosshair();
  const { toggleWishlist, isWishlisted } = useStore();

  const display = active < 0 ? 0 : active;
  const current = items[display] || null;
  const next = items.length > 1 ? items[(display + 1) % items.length] : null;
  const imageFor = useCallback(
    (item) => item?.heroCutout || item?.images?.[0] || fallbackImage,
    [fallbackImage]
  );

  /* Accent: an explicit catalogue hex wins; otherwise sample the photograph. */
  useEffect(() => {
    if (!current) return undefined;
    if (current.accent) {
      setAccent(current.accent);
      return undefined;
    }
    let alive = true;
    samplePhotoAccent(imageFor(current)).then((hex) => {
      if (alive && hex) setAccent(hex);
    });
    return () => {
      alive = false;
    };
  }, [current, imageFor]);

  /* Mount the WebGL chunk only when the hero approaches the viewport. */
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: '250px' }
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  const goToChapter = useCallback(
    (index) => {
      const st = pinRef.current;
      if (!st) return;
      const target = Math.max(0, Math.min(items.length - 1, index));
      const p = INTRO + ((target + 0.12) / items.length) * (1 - INTRO);
      /* ScrollTrigger.scroll is the coordinate system the pin itself uses; a
         native window.scrollTo can be swallowed while the pin is active. */
      st.scroll(st.start + p * (st.end - st.start));
    },
    [items.length]
  );

  useEffect(() => {
    const section = ref.current;
    if (!section || items.length < 2 || prefersReducedMotion()) return undefined;

    let mm = null;
    const frame = cardFrameRef.current;
    const copy = section.querySelector('[data-hero-copy]');
    const ctx = gsap.context(() => {
      const onUpdate = (self) => {
        const p = clamp01(self.progress);
        motionRef.current.p = p;
        const raw = p < INTRO ? -1 : Math.min(items.length - 1, Math.floor(((p - INTRO) / (1 - INTRO)) * items.length));
        const local = raw < 0 ? 0 : ((p - INTRO) / (1 - INTRO)) * items.length - raw;
        /* One continuous hand-off: the outgoing fragments lift over the last
           third of a chapter and the incoming ones settle over the first fifth
           of the next. */
        const swirl = raw < 0 ? 0 : local < 0.16 ? 1 - smooth(0, 0.16, local) : smooth(0.58, 0.9, local);
        motionRef.current.swirl = clamp01(swirl);
        if (raw !== activeRef.current) {
          activeRef.current = raw;
          setActive(raw);
        }
        if (flashRef.current) {
          flashRef.current.style.opacity = String(clamp01((swirl - 0.72) / 0.28) * 0.18);
        }
      };

      /* The pin only makes sense when the viewport can hold the whole stage.
         Pinning a section taller than the screen keeps its own copy and
         buttons below the fold for the entire runway — which is exactly what
         a 375×812 phone and a 1280×640 laptop window used to get. In that
         case the stage stays in normal flow: same photograph, same copy, no
         clipped controls. The runway is measured in viewport heights so it
         stays proportional when the window is resized or the mobile URL bar
         collapses. */
      const stageFits = () => {
        const grid = section.querySelector('[data-hero-grid]');
        if (!grid) return true;
        return grid.getBoundingClientRect().height <= window.innerHeight - 8;
      };

      mm = gsap.matchMedia();
      mm.add('(min-width: 1024px)', () => {
        const st = ScrollTrigger.create({
          trigger: section,
          start: 'top top',
          end: () => `+=${Math.round(window.innerHeight * 5.2)}`,
          pin: true,
          pinSpacing: true,
          anticipatePin: 1,
          scrub: 1,
          refreshPriority: 1,
          invalidateOnRefresh: true,
          onUpdate,
        });
        pinRef.current = st;
        return () => {
          pinRef.current = null;
          st.kill();
        };
      });
      mm.add('(max-width: 1023px) and (min-height: 600px)', () => {
        if (!stageFits()) return undefined;
        const st = ScrollTrigger.create({
          trigger: section,
          start: 'top top',
          end: () => `+=${Math.round(window.innerHeight * 3.4)}`,
          pin: true,
          pinSpacing: true,
          anticipatePin: 1,
          scrub: 1,
          refreshPriority: 1,
          invalidateOnRefresh: true,
          onUpdate,
        });
        pinRef.current = st;
        return () => {
          pinRef.current = null;
          st.kill();
        };
      });

      gsap.fromTo(
        frame,
        { clipPath: 'inset(100% 0% 0% 0%)', scale: 1.14 },
        { clipPath: 'inset(0% 0% 0% 0%)', scale: 1, duration: 1.1, ease: 'power3.out' }
      );
      gsap.fromTo(
        copy,
        { opacity: 0, y: 24 },
        { opacity: 1, y: 0, duration: 0.75, ease: 'power3.out' }
      );
      const refresh = window.setTimeout(() => ScrollTrigger.refresh(), 500);
      return () => window.clearTimeout(refresh);
    }, section);

    return () => {
      mm?.revert();
      ctx.revert();
    };
  }, [items]);

  /* Pointer tilt: 9deg horizontal / 5deg vertical maximum, fine pointers only. */
  useEffect(() => {
    const section = ref.current;
    const card = cardRef.current;
    if (!section || !card || prefersReducedMotion()) return undefined;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (!fine.matches) return undefined;
    const rx = gsap.quickTo(card, 'rotationX', { duration: 0.55, ease: 'power3.out' });
    const ry = gsap.quickTo(card, 'rotationY', { duration: 0.55, ease: 'power3.out' });
    const onMove = (event) => {
      const rect = section.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      ry(x * 18);
      rx(-y * 10);
      if (glareRef.current) {
        glareRef.current.style.background = `radial-gradient(circle at ${50 + x * 45}% ${50 + y * 45}%, rgba(255,255,255,0.5), transparent 46%)`;
        glareRef.current.style.opacity = '1';
      }
    };
    const onLeave = () => {
      ry(0);
      rx(0);
      if (glareRef.current) glareRef.current.style.opacity = '0';
    };
    section.addEventListener('pointermove', onMove);
    section.addEventListener('pointerleave', onLeave);
    return () => {
      section.removeEventListener('pointermove', onMove);
      section.removeEventListener('pointerleave', onLeave);
      gsap.killTweensOf(card);
      card.style.transform = '';
    };
  }, []);

  const onKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const nextIndex = activeRef.current < 0 ? 0 : activeRef.current + (event.key === 'ArrowRight' ? 1 : -1);
    goToChapter(nextIndex);
  };

  return (
    <div className="relative">
      <section
        ref={ref}
        data-scene="opening"
        data-hero-mode="motion"
      data-active-chapter={active}
      aria-labelledby="home-heading"
      aria-roledescription="Catalogue hero"
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{ '--hero-accent': accent }}
      className="fa-paper-grain relative w-full overflow-hidden bg-[var(--color-surface-bg)]"
    >
      <link rel="preload" as="image" href={imageFor(items[0])} fetchPriority="high" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 transition-opacity duration-700 dark:opacity-70"
        style={{
          background: `radial-gradient(ellipse at 66% 48%, ${rgba(accent, 0.22)}, transparent 58%)`,
        }}
      />
      <div
        ref={flashRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-30 bg-white opacity-0 mix-blend-soft-light"
      />

      <div
        data-hero-grid
        className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-5 pt-14 pb-16 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16 lg:px-10 lg:pt-20 lg:pb-24"
      >
        <div data-hero-copy className="relative z-20 flex flex-col items-start">
          {active < 0 ? (
            <>
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-4 py-1.5 text-[10px] font-bold tracking-[0.22em] text-[var(--color-botanical-muted)] uppercase">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
                Handcrafted botanical keepsakes · Small batches
              </p>
              <h1
                id="home-heading"
                className="font-serif text-[clamp(2.6rem,7vw,4.75rem)] leading-[1.02] tracking-[-0.02em] text-[var(--color-botanical-primary)]"
              >
                <SplitText text="Flora Alchemy" />
              </h1>
              <p className="mt-4 font-serif text-[clamp(1.15rem,2.6vw,1.7rem)] leading-snug text-[var(--color-accent)] italic">
                Sculpted Nature. Hand-Bound Memories.
              </p>
              <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--color-botanical-muted)] sm:text-base">
                One-of-a-kind floral art, deckled stationery and memory keepsakes — sculpted petal by petal,
                wrapped by hand, and written to order in our botanical atelier.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
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
              <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2">
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
            </>
          ) : (
            <>
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-4 py-1.5 text-[10px] font-bold tracking-[0.22em] text-[var(--color-botanical-muted)] uppercase">
                <Star className="h-3 w-3 fill-[var(--color-accent)] text-[var(--color-accent)]" aria-hidden="true" />
                Beloved piece · {current?.categoryLabel || current?.category || 'Catalogue'}
              </p>
              <h1
                id="home-heading"
                className="font-serif text-[clamp(2.6rem,7vw,4.75rem)] leading-[1.02] tracking-[-0.02em] text-[var(--color-botanical-primary)]"
              >
                {current?.name}
              </h1>
              <p className="mt-3 font-serif text-[clamp(1.15rem,2.6vw,1.7rem)] leading-snug text-[var(--color-accent)] italic">
                {current?.tagline || `From the catalogue · ₹${Number(current?.price || 0).toLocaleString('en-IN')}`}
              </p>
              <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--color-botanical-muted)] sm:text-base">
                {current?.description
                  ? `${current.description.slice(0, 170)}${current.description.length > 170 ? '…' : ''}`
                  : 'Wrapped by hand in the botanical atelier, one piece at a time.'}
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Magnetic>
                  <Link
                    to={`/product/${current?.slug || current?.id}`}
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] px-7 py-3.5 text-[13px] font-semibold tracking-wide text-white shadow-md transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--color-btn-hover)] hover:shadow-lg"
                  >
                    <span>View this piece</span>
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                </Magnetic>
                <button
                  type="button"
                  onClick={() => current && toggleWishlist(current)}
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-6 py-3.5 text-[13px] font-semibold tracking-wide text-[var(--color-botanical-text)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--color-badge-bg)]/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                >
                  <Heart
                    className={`h-4 w-4 ${current && isWishlisted(current.id || current.slug) ? 'fill-[var(--color-accent)] text-[var(--color-accent)]' : 'text-[var(--color-accent)]'}`}
                    aria-hidden="true"
                  />
                  <span>{current && isWishlisted(current.id || current.slug) ? 'Saved' : 'Add to wishlist'}</span>
                </button>
              </div>
              <div className="mt-7 flex flex-wrap items-center gap-4">
                <span className="text-[11px] font-semibold tracking-[0.2em] text-[var(--color-botanical-subtle)]">
                  {String(active + 1).padStart(2, '0')} / {String(items.length).padStart(2, '0')}
                </span>
                <span className="h-px w-16 bg-[var(--color-botanical-border)]" aria-hidden="true" />
                <Link to="/shop" className="text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:text-[var(--color-accent)]">
                  Explore all
                </Link>
                <Link to="/gift-finder" className="text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:text-[var(--color-accent)]">
                  Find a gift
                </Link>
              </div>
            </>
          )}
        </div>

        <div className="relative z-10 mx-auto w-full max-w-[26rem] lg:max-w-none">
          <div
            ref={cardRef}
            className="relative will-change-transform"
            style={{ transformStyle: 'preserve-3d', perspective: '1200px' }}
          >
            {/* The stage is pinned, so on a short laptop window the card is
                capped to the space under the header rather than pushing the
                hero's buttons below the fold for the whole runway. */}
            <div
              ref={cardFrameRef}
              className="relative aspect-[3/4] max-h-[calc(100svh-12rem)] overflow-hidden rounded-[1.75rem] border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] shadow-[0_32px_80px_-32px_rgba(24,15,10,0.45)] lg:max-h-[calc(100svh-14rem)]"
            >
              {items.map((item, index) => {
                const cutout = Boolean(item.heroCutout);
                return (
                  <img
                    key={item.id || item.slug}
                    src={imageFor(item)}
                    alt={index === display ? `${item.name}, photographed for Flora Alchemy` : ''}
                    aria-hidden={index === display ? undefined : 'true'}
                    loading={index === 0 ? 'eager' : 'lazy'}
                    decoding="async"
                    fetchPriority={index === 0 ? 'high' : 'auto'}
                    className={`absolute inset-0 h-full w-full transition-opacity duration-500 ${cutout ? 'object-contain p-8' : 'object-cover object-center'} ${index === display ? 'opacity-100' : 'opacity-0'}`}
                  />
                );
              })}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-black/30 to-transparent" aria-hidden="true" />
              <div
                ref={glareRef}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-0 mix-blend-soft-light transition-opacity duration-300"
              />
            </div>

            {near ? (
              <div className="pointer-events-none absolute -inset-10 z-20" aria-hidden="true">
                <Suspense fallback={null}>
                  <HeroFragments
                    imageUrl={imageFor(current || items[0])}
                    accent={current?.accent || accent}
                    motionRef={motionRef}
                    className="h-full w-full"
                  />
                </Suspense>
              </div>
            ) : null}

            {active >= 0 && next && active < items.length - 1 ? (
              <button
                type="button"
                onClick={() => goToChapter(active + 1)}
                className="absolute -right-2 bottom-8 z-30 hidden w-32 overflow-hidden rounded-2xl border border-white/50 bg-[var(--color-surface-lowest)]/90 text-left shadow-xl backdrop-blur-md transition-transform hover:-translate-y-1 lg:block"
                aria-label={`Next hero piece: ${next.name}`}
              >
                <span className="block px-3 pt-2.5 text-[9px] font-bold tracking-[0.18em] text-[var(--color-accent)] uppercase">
                  Next
                </span>
                <img
                  src={imageFor(next)}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  className="mt-1 h-16 w-full object-cover"
                />
                <span className="block px-3 py-2 text-[11px] font-semibold leading-snug text-[var(--color-botanical-primary)]">
                  {next.name}
                </span>
                <span className="block px-3 pb-2.5 text-[11px] text-[var(--color-botanical-subtle)]">
                  ₹{Number(next.price || 0).toLocaleString('en-IN')}
                </span>
              </button>
            ) : null}
          </div>
        </div>
      </div>
      </section>
      {/* The crosshair is a SIBLING of the hero section, not a child: the hero's
          decorative WebGL fragment layer must stay the only canvas inside
          `[data-hero-mode]` (FLOW 41–44), while the pointer scope is still the
          hero section itself. */}
      {crosshair ? <HeroCrosshair containerRef={ref} color={accent} /> : null}
    </div>
  );
}

export default function HeroStage({ items = [], fallbackImage, fallbackAlt }) {
  const { mode } = useStageCapability();
  const heroItems = Array.isArray(items) ? items.slice(0, 5) : [];
  const canMotion = mode === 'stage' && heroItems.length >= 2;
  if (!canMotion) {
    return (
      <StaticHero
        item={heroItems[0] || null}
        fallbackImage={fallbackImage || '/assets/images/flora-asset-26.jpg'}
        fallbackAlt={fallbackAlt || 'A maker in the Flora Alchemy atelier holding a finished posy'}
      />
    );
  }
  return (
    <MotionHero
      items={heroItems}
      fallbackImage={fallbackImage || '/assets/images/flora-asset-26.jpg'}
      fallbackAlt={fallbackAlt || 'A maker in the Flora Alchemy atelier holding a finished posy'}
    />
  );
}
