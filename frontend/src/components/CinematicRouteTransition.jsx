import React, { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { gsap, prefersReducedMotion } from '../lib/gsapSetup.js';

/**
 * THE CUT — a 420 ms editorial wipe between pages.
 *
 * A cinematic storefront should not hard-cut between compositions, but a route
 * transition must never become a thing the customer waits for, must never trap
 * focus, and must never be the only signal that navigation happened. So this is
 * one fixed layer with `pointer-events: none`, `aria-hidden`, no routing logic of
 * its own: the route has already changed by the time it animates, and under
 * reduced motion it does not run at all.
 *
 * The cut is now PHOTOGRAPHIC: a band of real atelier imagery (the same
 * botanical frames the homepage uses) sweeps across the viewport, so the
 * transition reads as a new camera angle being laid over the old one — an
 * editorial cut, not a page-load spinner. The imagery is decorative and
 * aria-hidden; the brand mark rides on top for continuity.
 */
export default function CinematicRouteTransition() {
  const { pathname } = useLocation();
  const ref = useRef(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const node = ref.current;
    if (!node || prefersReducedMotion()) return undefined;

    const band = node.querySelector('[data-cut-band]');
    const mark = node.querySelector('[data-cut-mark]');

    const timeline = gsap.timeline();
    timeline
      .set(node, { display: 'block' })
      // Depth: the band settles from a slight push-in while the wipe travels —
      // the same vocabulary the homepage scenes use, kept to one transform so
      // the cut stays 450 ms and never makes the customer wait.
      .fromTo(node, { yPercent: 100 }, { yPercent: 0, duration: 0.18, ease: 'power3.out' }, 0)
      .fromTo(band, { scale: 1.06 }, { scale: 1, duration: 0.42, ease: 'power2.out' }, 0)
      .fromTo(mark, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.16, ease: 'power2.out' }, 0.08)
      .to(node, { yPercent: -100, duration: 0.24, ease: 'power3.in' }, '+=0.03')
      .set(node, { display: 'none' });

    return () => timeline.kill();
  }, [pathname]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-route-transition
      style={{ display: 'none' }}
      className="pointer-events-none fixed inset-0 z-[80] overflow-hidden bg-[var(--color-surface-bg)]"
    >
      {/* The photographic band — three atelier frames, settling from a slight
          push-in to sell the "new camera angle" feel, purely decorative. */}
      <div data-cut-band className="absolute inset-0 grid grid-cols-3 opacity-[0.14]">
        {[
          '/assets/images/flora-asset-13.jpg',
          '/assets/images/flora-asset-07.jpg',
          '/assets/images/flora-asset-21.jpg',
        ].map((src) => (
          <div key={src} className="relative h-full overflow-hidden">
            <img src={src} alt="" className="h-full w-full object-cover" />
          </div>
        ))}
      </div>
      {/* The terracotta horizon line — a single frame of brand colour. */}
      <div className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 bg-[var(--color-accent)]/60" />
      <div className="absolute inset-0 grid place-items-center">
        <span data-cut-mark className="font-serif text-sm tracking-[0.4em] text-[var(--color-botanical-primary)] uppercase">
          Flora Alchemy
        </span>
      </div>
    </div>
  );
}
