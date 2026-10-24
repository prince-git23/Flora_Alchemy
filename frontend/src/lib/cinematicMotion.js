/**
 * CINEMATIC MOTION — the storefront's shared camera language.
 *
 * The creative direction is camera-led, not model-led: the site feels
 * three-dimensional because a camera appears to move through real photography,
 * not because objects are rendered in 3D. This module is that language — small,
 * composable GSAP primitives named after what a camera operator does
 * (push in, pull back, track, crane, focus pull) plus the two supporting
 * moves (mask reveal, line reveal).
 *
 * RULES THIS MODULE ENFORCES (measured, not stylistic):
 *
 *   1. CONTENT FIRST, ANIMATION SECOND. Nothing is hidden in markup. Initial
 *      states are applied from JS inside `useCinematic`, so a reduced-motion
 *      visitor — or a failed script — sees the finished composition immediately.
 *      This is what "the website must remain fully usable when every optional
 *      cinematic effect is disabled" means in practice.
 *
 *   2. ONE LIFECYCLE. Every helper must be called inside `useCinematic`'s
 *      `gsap.context`, so a route change reverts every tween, trigger, inline
 *      style and listener in one call. No orphaned ScrollTriggers, no competing
 *      writers on the same property (a scrubbed camera and a one-shot entrance
 *      must never target the same transform channel of the same node).
 *
 *   3. SCRUB IS RESERVED FOR CAMERA MOVES. A scrubbed tween means "this motion
 *      IS the scroll" — it applies to image scale/position only, with
 *      `invalidateOnRefresh: true` so a resize re-measures instead of
 *      jumping. Everything else is a short entrance (≤ 0.9 s) that plays once
 *      and never reverses on scroll-back (`once: true`), because an interface
 *      that re-animates while you read it is noise.
 *
 *   4. HONESTY. These are camera-INSPIRED movements of photographs. Nothing
 *      here claims a 2D image has 3D geometry, and nothing here imports
 *      three.js — this file must stay renderer-free forever (it runs on first
 *      paint of every storefront route).
 *
 * Usage:
 *   const ref = useRef(null);
 *   useCinematic(ref, () => {
 *     pullBack(ref.current.querySelector('img'), { from: 1.18 });
 *     maskReveal(ref.current.querySelector('[data-frame]'));
 *   });
 *   return <section ref={ref}>…</section>;
 */

import { useEffect } from 'react';
import { gsap, ScrollTrigger, prefersReducedMotion, isDesktop } from './gsapSetup.js';

/** Camera moves are linear (the scroll IS the timeline); settles are eased. */
export const EASE = Object.freeze({
  camera: 'none',
  settle: 'power3.out',
  cut: 'power2.inOut',
});

/**
 * The lifecycle hook. Runs `setup` inside a GSAP context scoped to `ref`,
 * and reverts everything on unmount or strict-mode remount.
 *
 * Under `prefers-reduced-motion` the setup never runs: content stays at its
 * natural, fully visible state. The `load` refresh covers late-loading hero
 * images changing section geometry after first paint.
 */
export function useCinematic(scopeRef, setup) {
  const reduced = prefersReducedMotion();

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return undefined;
    if (reduced) return undefined;

    const ctx = gsap.context(() => {
      setup();
    }, scope);

    const onLoad = () => {
      /* Images changing intrinsic size shifts every trigger point below them. */
      ScrollTrigger.refresh();
    };
    window.addEventListener('load', onLoad, { once: true });

    return () => {
      window.removeEventListener('load', onLoad);
      ctx.revert();
    };
    /* `setup` is intentionally read once: it should close over stable values
       (refs and constants), the same contract as a GSAP context in React. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * PULL BACK — the reveal. The frame starts CLOSE (scale > 1, a macro crop)
 * and eases out to its full composition as the section passes, which is how a
 * product campaign opens: detail first, arrangement second.
 */
export function pullBack(el, { from = 1.16, to = 1, y = 0, start = 'top bottom', end = 'bottom top', scrub = 1.2 } = {}) {
  if (!el) return null;
  return gsap.fromTo(
    el,
    { scale: from },
    {
      scale: to,
      y,
      ease: EASE.camera,
      scrollTrigger: { trigger: el, start, end, scrub, invalidateOnRefresh: true },
    }
  );
}

/** PUSH IN — the inverse: the camera leans toward the subject as it enters. */
export function pushIn(el, { from = 1, to = 1.06, start = 'top 85%', end = 'top 25%', scrub = 1 } = {}) {
  if (!el) return null;
  return gsap.fromTo(
    el,
    { scale: from },
    {
      scale: to,
      ease: EASE.camera,
      scrollTrigger: { trigger: el, start, end, scrub, invalidateOnRefresh: true },
    }
  );
}

/**
 * TRACK — a lateral dolly past a wide frame. Positive `distance` moves the
 * image left (the camera travels right). Keep ≤ 8 % of the frame: past that
 * the crop detaches from its composition.
 */
export function trackX(el, { distance = 40, start = 'top bottom', end = 'bottom top', scrub = 1.4 } = {}) {
  if (!el) return null;
  return gsap.fromTo(
    el,
    { x: distance },
    {
      x: -distance,
      ease: EASE.camera,
      scrollTrigger: { trigger: el, start, end, scrub, invalidateOnRefresh: true },
    }
  );
}

/** CRANE — a vertical rise with a whisper of scale, for closing frames. */
export function crane(el, { distance = 36, scaleFrom = 1.04, scaleTo = 1, start = 'top bottom', end = 'bottom top', scrub = 1.3 } = {}) {
  if (!el) return null;
  return gsap.fromTo(
    el,
    { y: distance, scale: scaleFrom },
    {
      y: -distance,
      scale: scaleTo,
      ease: EASE.camera,
      scrollTrigger: { trigger: el, start, end, scrub, invalidateOnRefresh: true },
    }
  );
}

/**
 * PARALLAX DEPTH — layered planes drifting at different rates so a flat
 * photograph gains a foreground and a background. `depth` is a small ratio
 * (0.05 = far wall, 0.25 = near prop). Desktop only: on touch the layers
 * would fight the scroll gesture for the same pixels.
 */
export function parallax(el, depth = 0.1) {
  if (!el || !isDesktop()) return null;
  const drift = depth * 180;
  return gsap.fromTo(
    el,
    { y: drift * 0.5 },
    {
      y: -drift * 0.5,
      ease: EASE.camera,
      scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: 1.5, invalidateOnRefresh: true },
    }
  );
}

/**
 * MASK REVEAL — an image-plane wipe: the frame is uncovered like a matte
 * being lifted, not faded in. One shot, never reverses.
 */
export function maskReveal(el, { start = 'top 82%', duration = 0.9, direction = 'up' } = {}) {
  if (!el) return null;
  const from = direction === 'up' ? 'inset(100% 0% 0% 0%)' : direction === 'left' ? 'inset(0% 100% 0% 0%)' : 'inset(0% 0% 100% 0%)';
  return gsap.fromTo(
    el,
    { clipPath: from },
    {
      clipPath: 'inset(0% 0% 0% 0%)',
      duration,
      ease: EASE.cut,
      immediateRender: true,
      scrollTrigger: { trigger: el, start, once: true },
    }
  );
}

/**
 * FOCUS PULL — the rack-focus: a frame settles from soft to sharp as it
 * enters, the way a lens finds its subject. Cheap (one filter on one node,
 * played once) and the single most "filmed" gesture available in CSS.
 */
export function focusPull(el, { start = 'top 80%', duration = 1.0, blur = 10 } = {}) {
  if (!el) return null;
  return gsap.fromTo(
    el,
    { filter: `blur(${blur}px)`, opacity: 0.4 },
    {
      filter: 'blur(0px)',
      opacity: 1,
      duration,
      ease: 'power2.out',
      immediateRender: true,
      scrollTrigger: { trigger: el, start, once: true },
    }
  );
}

/**
 * SCENE ENTRANCE — short, staggered settle for text and controls. This is
 * interface motion, not camera motion: it plays once, ≤ 0.9 s, and never
 * scrubs. `selector` is scoped to `el`.
 */
export function sceneEnter(el, selector, { y = 24, duration = 0.7, stagger = 0.08, start = 'top 86%' } = {}) {
  if (!el) return null;
  const targets = typeof selector === 'string' ? el.querySelectorAll(selector) : selector;
  if (!targets || targets.length === 0) return null;
  return gsap.fromTo(
    targets,
    { opacity: 0, y },
    {
      opacity: 1,
      y: 0,
      duration,
      stagger,
      ease: EASE.settle,
      immediateRender: true,
      scrollTrigger: { trigger: el, start, once: true },
    }
  );
}

/**
 * MAGNETIC — a primary CTA that leans a few pixels toward a fine pointer and
 * settles back. Desktop + fine pointer only; strength stays ≤ 10 px so text
 * never swims. (The React Bits technique, adapted to this lifecycle.)
 */
export function magneticButtons(scope) {
  if (!scope || !isDesktop() || prefersReducedMotion()) return null;
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  if (!fine.matches) return null;

  const triggers = [];
  scope.querySelectorAll('[data-magnetic]').forEach((btn) => {
    const strength = Number(btn.dataset.magnetic) || 8;
    const xTo = gsap.quickTo(btn, 'x', { duration: 0.4, ease: 'power3.out' });
    const yTo = gsap.quickTo(btn, 'y', { duration: 0.4, ease: 'power3.out' });
    const onMove = (event) => {
      const rect = btn.getBoundingClientRect();
      xTo(((event.clientX - rect.left) / rect.width - 0.5) * strength);
      yTo(((event.clientY - rect.top) / rect.height - 0.5) * strength * 0.7);
    };
    const onLeave = () => {
      xTo(0);
      yTo(0);
    };
    btn.addEventListener('pointermove', onMove);
    btn.addEventListener('pointerleave', onLeave);
    triggers.push(() => {
      btn.removeEventListener('pointermove', onMove);
      btn.removeEventListener('pointerleave', onLeave);
      gsap.set(btn, { x: 0, y: 0 });
    });
  });
  return () => triggers.forEach((fn) => fn());
}

export default {
  EASE,
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
};
