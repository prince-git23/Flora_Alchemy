import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useCinematic } from '../../lib/cinematicMotion.js';
import { useStageCapability } from './useStageCapability.js';

/**
 * SCENE STAGE — the homepage section that gives the photo-plane stage its
 * scroll. (This is the seam the previous Gazania model stage occupied; the
 * model is gone and its visual role is now played by real photographs hung at
 * separated depths — see `PhotoPlaneStage.jsx`.)
 *
 * This file is the integration seam: it decides (from `useStageCapability`)
 * whether this device gets the real camera ('stage') or the static
 * photographic composition ('still'), mounts the lazy `PhotoPlaneStage` chunk
 * only when the section is NEAR the viewport, pins the stage while a scroll
 * runway drives `progressRef` 0 → 1, and crossfades one caption per shot. GSAP
 * owns the pin and publishes a single number; the camera inside the lazy chunk
 * is the only writer of the camera itself.
 *
 * Under `prefers-reduced-motion`, without WebGL, or on Save-Data, `useCinematic`
 * never runs and no pin, runway, canvas or hidden caption exists: the visitor
 * gets a finished still composition — real photographs, heading, one CTA — in
 * normal document flow. Nothing is hidden in markup that the JS would fail to
 * reveal, because the still path runs no reveal animation at all.
 */

const PhotoPlaneStage = lazy(() => import('./PhotoPlaneStage.jsx'));

/* The still band's finished composition — real photographs, the same ones the
   camera would have travelled through. Verified existing files only. */
const STILL = Object.freeze([
  { src: '/assets/images/flora-asset-05.jpg', alt: 'A close view of a chenille lavender stem on natural linen', className: 'row-span-2 aspect-[3/4] lg:aspect-auto' },
  { src: '/assets/images/flora-asset-03.jpg', alt: 'A wrapped posy tied with silk and finished with a handwritten tag', className: 'aspect-[4/3]' },
  { src: '/assets/images/flora-asset-04.jpg', alt: 'A kraft gift box closed with a velvet ribbon and a wax seal', className: 'aspect-[4/3]' },
]);

const SHOT_COPY = Object.freeze([
  {
    id: 'establish',
    kicker: 'Shot one — close',
    title: 'The smallest details make the keepsake.',
    body: 'The camera begins where the eye does: petal grain, deckled cotton, a wax seal warming on the bench.',
  },
  {
    id: 'pull-back',
    kicker: 'Shot two — pull back',
    title: '…and the details have a room around them.',
    body: 'The frame retreats and lifts; the wrapped posy and the gift box arrive beside the bloom — real photographs, hung in real depth.',
  },
  {
    id: 'lateral',
    kicker: 'Shot three — track across',
    title: 'The same room, crossed from the left.',
    body: 'A lateral move through the planes: the near photograph passes in front of the far one, and the space between them reads for the first time.',
  },
  {
    id: 'three-quarter',
    kicker: 'Shot four — three-quarters',
    title: 'Where the light would fall.',
    body: 'Round the diagonal, every keepsake is judged from the angle we photograph it from — the one a maker turns a finished piece to.',
  },
  {
    id: 'pull-away',
    kicker: 'Shot five — hand off',
    title: 'Now, back to the bench.',
    body: 'The camera lifts away and hands you to the four real frames from the worktable — and the catalogue waiting beyond them.',
    cta: { label: 'Browse all gifts', to: '/shop' },
  },
]);

export default function SceneStage() {
  const sectionRef = useRef(null);
  const stageRef = useRef(null);
  const progressRef = useRef(0);
  const captionRefs = useRef([]);
  const [near, setNear] = useState(false);
  const { mode } = useStageCapability();
  const isStage = mode === 'stage';

  // Mount gate: the heavy chunk (three.js + six photograph textures) is
  // fetched only when the section approaches the viewport — the opening hero
  // never waits on it.
  useEffect(() => {
    const node = sectionRef.current;
    if (!node || !isStage) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: '300px' }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [isStage]);

  // The pin + runway. useCinematic runs this inside a gsap.context (so revert
  // kills the trigger on unmount or theme/mode change) and skips setup entirely
  // under reduced motion.
  useCinematic(sectionRef, () => {
    if (!isStage) return undefined;

    const trigger = ScrollTrigger.create({
      trigger: sectionRef.current,
      start: 'top top',
      end: 'bottom bottom',
      pin: stageRef.current,
      pinSpacing: false,
      anticipatePin: 1,
      invalidateOnRefresh: true,
      onUpdate: (self) => {
        const p = Math.min(1, Math.max(0, self.progress));
        progressRef.current = p;
        const active = Math.min(SHOT_COPY.length - 1, Math.round(p * (SHOT_COPY.length - 1)));
        captionRefs.current.forEach((el, i) => {
          if (!el) return;
          const on = i === active;
          el.style.opacity = on ? '1' : '0';
          el.setAttribute('aria-hidden', on ? 'false' : 'true');
        });
      },
    });

    const refresh = window.setTimeout(() => ScrollTrigger.refresh(), 600);
    return () => {
      window.clearTimeout(refresh);
      trigger.kill();
    };
  });

  if (!isStage) {
    // ── The still composition — reduced motion, no WebGL, or Save-Data ────
    // A finished arrangement of the same photographs the camera would have
    // travelled through. No pin, no runway, no canvas, no apology copy.
    return (
      <section
        ref={sectionRef}
        data-scene="stage"
        data-stage-mode="still"
        aria-label="Where the details live"
        className="relative bg-[var(--color-surface-low)]"
      >
        <div className="mx-auto grid max-w-6xl items-center gap-8 px-5 py-16 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:gap-14 lg:py-24">
          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            {STILL.map((frame) => (
              <div
                key={frame.src}
                className={`overflow-hidden rounded-2xl border border-[var(--color-botanical-border)] ${frame.className}`}
              >
                <img
                  src={frame.src}
                  alt={frame.alt}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </div>
            ))}
          </div>
          <div>
            <p className="text-[11px] font-semibold tracking-[0.34em] text-[var(--color-botanical-primary)] uppercase">
              Inside the atelier
            </p>
            <h2 className="mt-2 font-serif text-[clamp(1.8rem,3.6vw,2.8rem)] leading-[1.05] tracking-[-0.015em] text-[var(--color-botanical-primary)]">
              Where the details live.
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-[var(--color-botanical-muted)] sm:text-base">
              Petal, ribbon, wax and twine — the same photographs the camera
              travels through, held still here. Everything to shop, the
              catalogue, the collections and the gift studio, is exactly where
              it lives everywhere else.
            </p>
            <Link
              to="/shop"
              className="mt-6 inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] px-7 py-3.5 text-[13px] font-semibold tracking-wide text-white shadow-md transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--color-btn-hover)] hover:shadow-lg"
            >
              Browse all gifts
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>
    );
  }

  // ── The stage — pinned canvas + scroll runway + per-shot captions ────────
  return (
    <section
      ref={sectionRef}
      data-scene="stage"
      data-stage-mode="stage"
      aria-label="A camera travels through the atelier's photographs"
      className="relative bg-[var(--color-surface-low)]"
    >
      <div ref={stageRef} data-stage-canvas className="cinematic-stage relative h-[100svh] w-full overflow-hidden">
        <div className="absolute inset-0">
          {near ? (
            <Suspense fallback={null}>
              <PhotoPlaneStage progressRef={progressRef} />
            </Suspense>
          ) : null}
        </div>

        {/* Scrim: keeps the caption legible over the ivory/charcoal scene in
            both themes, since it is drawn from the same surface token the
            canvas background uses. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-1/2 bg-gradient-to-t from-[var(--color-surface-low)]/90 via-[var(--color-surface-low)]/35 to-transparent"
        />

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 p-6 sm:p-10 lg:p-14">
          <div className="relative max-w-xl">
            {SHOT_COPY.map((shot, index) => (
              <div
                key={shot.id}
                ref={(el) => {
                  captionRefs.current[index] = el;
                }}
                data-stage-caption={index}
                aria-hidden={index !== 0}
                style={{ opacity: index === 0 ? 1 : 0 }}
                className={`transition-opacity duration-300 ${
                  index !== 0 ? 'absolute inset-x-0 bottom-0' : ''
                }`}
              >
                <p className="text-[11px] font-semibold tracking-[0.34em] text-[var(--color-botanical-primary)] uppercase">
                  {shot.kicker}
                </p>
                <h3 className="mt-2 font-serif text-[clamp(1.7rem,3.4vw,2.6rem)] leading-[1.05] tracking-[-0.015em] text-[var(--color-botanical-primary)]">
                  {shot.title}
                </h3>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--color-botanical-muted)]">
                  {shot.body}
                </p>
                {shot.cta ? (
                  <Link
                    to={shot.cta.to}
                    className="pointer-events-auto mt-5 inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] px-7 py-3.5 text-[13px] font-semibold tracking-wide text-white shadow-md transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--color-btn-hover)] hover:shadow-lg"
                  >
                    {shot.cta.label}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* The scroll runway the camera travels along. pinSpacing is false, so
          this spacer — not the pin — gives the sequence its length. */}
      <div data-stage-runway aria-hidden="true" className="h-[220svh] sm:h-[260svh]" />
    </section>
  );
}
