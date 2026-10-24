import { useEffect } from 'react';
import Lenis from 'lenis';
import { gsap, ScrollTrigger, prefersReducedMotion } from '../lib/gsapSetup.js';

/**
 * SMOOTH SCROLL — Lenis, on GSAP's clock.
 *
 * Why it earns its ~4 kB: the storefront now has scroll-driven scenes, and the
 * difference between a native scrollbar and a damped scroll is the difference
 * between reading a list of sections and moving through a place.
 *
 * The rules that keep it from being a liability:
 *
 *   · `prefers-reduced-motion` → not constructed at all. Native scrolling is
 *     the accessible behaviour, not a downgrade.
 *   · touch devices → not constructed. Native inertia is better than emulated
 *     inertia, and pinching/hurling is not something to reinterpret.
 *   · one clock. Lenis is driven by GSAP's ticker, and ScrollTrigger is updated
 *     from Lenis's scroll event, so the two cannot disagree about the scroll
 *     position for a frame (which is how pinned sections used to jitter).
 *   · it never intercepts the scroll POSITION: Lenis animates the window's real
 *     scrollTop, so `window.scrollY`, anchor links, `scrollIntoView`, keyboard
 *     PageDown and the browser's own find-in-page all keep working — including
 *     under Playwright, which scrolls without synthesising wheels.
 */
export default function SmoothScroll() {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (prefersReducedMotion()) return undefined;
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return undefined;

    /* THE ONE LINE THIS LAYER CANNOT DO WITHOUT.
       `index.css` gives `html` a global `scroll-behavior: smooth` (so anchor
       links glide). With Lenis also animating the scroll, a programmatic
       `window.scrollTo(x, y)` becomes a NATIVE smooth scroll that Lenis then
       rewinds to its own animated position every frame — the page simply
       refuses to move. `ScrollRestoration`, the gift studio's step changes and
       every `scrollIntoView` depend on that call, so while Lenis owns the
       scroll the native behaviour must be instant; a caller that wants a glide
       asks Lenis for one (or passes `behavior: 'smooth'`, which Lenis handles). */
    const root = document.documentElement;
    const previousScrollBehaviour = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';

    const lenis = new Lenis({
      duration: 1.05,
      smoothWheel: true,
      wheelMultiplier: 0.9,
      touchMultiplier: 1.6,
      syncTouch: false,
      autoRaf: false,
    });

    const onScroll = () => ScrollTrigger.update();
    lenis.on('scroll', onScroll);

    const tick = (time) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    // Expose for debugging and for tests that want to assert the layer exists
    // without reaching into React internals.
    window.__floraSmoothScroll = lenis;

    return () => {
      gsap.ticker.remove(tick);
      lenis.off('scroll', onScroll);
      lenis.destroy();
      root.style.scrollBehavior = previousScrollBehaviour;
      delete window.__floraSmoothScroll;
    };
  }, []);

  return null;
}
