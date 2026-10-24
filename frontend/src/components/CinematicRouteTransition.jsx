import React, { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { gsap, prefersReducedMotion } from '../lib/gsapSetup.js';

/**
 * THE CUT — a 340 ms veil between pages.
 *
 * A cinematic storefront should not hard-cut between compositions, but a route
 * transition must never become a thing the customer waits for, must never trap
 * focus, and must never be the only signal that navigation happened. So this is
 * one fixed layer with `pointer-events: none`, `aria-hidden`, no routing logic of
 * its own: the route has already changed by the time it animates, and under
 * reduced motion it does not run at all.
 *
 * It is deliberately NOT a full-page wipe: a two-tone band that rises and falls
 * reads as a film cut at 340 ms and as a flicker at 800 ms.
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

    const timeline = gsap.timeline();
    timeline
      .set(node, { display: 'block' })
      .fromTo(node, { yPercent: 100, opacity: 0.9 }, { yPercent: 0, opacity: 1, duration: 0.16, ease: 'power2.out' })
      .to(node, { yPercent: -100, duration: 0.22, ease: 'power2.in', delay: 0.05 })
      .set(node, { display: 'none' });

    return () => timeline.kill();
  }, [pathname]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-route-transition
      style={{ display: 'none' }}
      className="pointer-events-none fixed inset-0 z-[80] bg-[var(--color-surface-bg)]"
    >
      <div className="absolute inset-x-0 top-0 h-[2px] bg-[var(--color-botanical-terracotta)]/70" />
      <div className="absolute inset-0 grid place-items-center">
        <span className="font-serif text-sm tracking-[0.4em] text-[var(--color-botanical-muted)] uppercase">Flora Alchemy</span>
      </div>
    </div>
  );
}
