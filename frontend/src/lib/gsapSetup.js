import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// Register once at app startup — idempotent but avoids chunk-level repetition
gsap.registerPlugin(ScrollTrigger);

/**
 * Check if the user prefers reduced motion.
 */
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Check if the viewport is desktop-width.
 */
export function isDesktop() {
  return window.matchMedia('(min-width: 1024px)').matches;
}

/**
 * PHASE 1 — canonical ProductCard depth (storefront spatial design, Level 2).
 *
 * One implementation for every catalogue surface, so no page reinvents pointer
 * tilt. Deliberately restrained:
 *   · fine-pointer devices only — touch never tilts
 *   · at most `${maxTilt}deg` of rotation (the Phase 1 ceiling is 1.5deg)
 *   · a 4px lift plus the card's own shadow refinement
 *   · disabled entirely under `prefers-reduced-motion`
 *
 * Returns a dispose function so callers can honour the cleanup contract
 * (no orphaned listeners, no retained rect between sessions).
 *
 * @param {HTMLElement|null} el   the card element
 * @param {{maxTilt?: number, lift?: number}} [options]
 * @returns {() => void} dispose
 */
export function setupCardDepth(el, { maxTilt = 1.5, lift = 4 } = {}) {
  if (!el || prefersReducedMotion()) return () => {};

  const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
  let pointerFine = mq.matches;
  let rect = null;

  const reset = () => {
    rect = null;
    el.style.transform = '';
  };

  const onPointerMove = (event) => {
    if (!pointerFine) return;
    if (!rect) rect = el.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    el.style.transform =
      `perspective(900px) rotateY(${x * 2 * maxTilt}deg) rotateX(${-y * 2 * maxTilt}deg) translateY(-${lift}px)`;
  };

  const onPointerLeave = () => reset();
  const onCapabilityChange = (event) => {
    pointerFine = event.matches;
    if (!pointerFine) reset();
  };

  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerleave', onPointerLeave);
  mq.addEventListener('change', onCapabilityChange);

  return () => {
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerleave', onPointerLeave);
    mq.removeEventListener('change', onCapabilityChange);
    reset();
  };
}

export { gsap, ScrollTrigger };
