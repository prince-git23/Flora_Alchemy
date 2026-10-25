import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useCinematic } from '../../lib/cinematicMotion.js';
import { useStageCapability } from './useStageCapability.js';

/**
 * SCENE STAGE — the homepage section that gives the 3D stage its scroll.
 *
 * This file is the integration seam: it decides (from `useStageCapability`)
 * whether this device gets the real camera ('stage') or the static
 * photographic band ('still'), mounts the lazy `CinematicStage` chunk only
 * when the section is NEAR the viewport, pins the stage while a scroll runway
 * drives `progressRef` 0 → 1, and crossfades one caption per shot. GSAP owns
 * the pin and publishes a single number; the camera inside the lazy chunk is
 * the only writer of the camera itself.
 *
 * Under `prefers-reduced-motion`, without WebGL, or on Save-Data, `useCinematic`
 * never runs and no pin, runway, canvas or hidden caption exists: the visitor
 * gets the still band — photograph, heading, one CTA — in normal document
 * flow. Nothing is hidden in markup that the JS would fail to reveal, because
 * the still path runs no reveal animation at all.
 */

const CinematicStage = lazy(() => import('./CinematicStage.jsx'));

const FALLBACK_IMG = '/assets/images/flora-asset-09.jpg'; // chamomile in a glazed pot (verified real file)

const SHOT_COPY = Object.freeze([
  {
    id: 'establish',
    kicker: 'Shot one — close',
    title: 'Start where the craft starts.',
    body: 'Up close on the bench: one gazania, its petal edges and the grain of the light. Everything we make is judged at this distance.',
  },
  {
    id: 'dolly-out',
    kicker: 'Shot two — pull back',
    title: 'The whole arrangement arrives.',
    body: 'The camera retreats and lifts; the posy, its shadow and the studio floor come into frame together — one continuous scene, not a slideshow.',
  },
  {
    id: 'lateral',
    kicker: 'Shot three — track left',
    title: 'The same space, from the side.',
    body: 'A lateral move through the room: blooms pass in front of one another and the depth between the stems reads for the first time.',
  },
  {
    id: 'three-quarter',
    kicker: 'Shot four — three-quarters',
    title: 'Where the light lives.',
    body: 'Round the far side, the key light rakes across the cluster — the angle we photograph every keepsake from.',
  },
  {
    id: 'pull-away',
    kicker: 'Shot five — hand off',
    title: 'Now, back to the shop.',
    body: 'The camera lifts away and hands you to the catalogue — real pieces, ready to send.',
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

  // Mount gate: the heavy chunk (three.js + the model) is fetched only when
  // the section approaches the viewport — the opening hero never waits on it.
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
    // ── The still band — reduced motion, no WebGL, or Save-Data ──────────
    return (
      <section
        ref={sectionRef}
        data-scene="stage"
        data-stage-mode="still"
        aria-label="Inside the atelier"
        className="relative bg-[var(--color-surface-low)]"
      >
        <div className="mx-auto grid max-w-6xl items-center gap-8 px-5 py-16 sm:px-8 lg:grid-cols-[1.1fr_1fr] lg:gap-14 lg:py-24">
          <div className="relative aspect-[16/9] overflow-hidden rounded-2xl border border-[var(--color-surface-border)]">
            <img
              src={FALLBACK_IMG}
              alt="Chamomile blooms resting in a glazed ceramic pot on the atelier table"
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          </div>
          <div>
            <p className="text-[11px] font-semibold tracking-[0.34em] text-[var(--color-botanical-primary)] uppercase">
              Inside the atelier
            </p>
            <h2 className="mt-2 font-serif text-[clamp(1.8rem,3.6vw,2.8rem)] leading-[1.05] tracking-[-0.015em] text-[var(--color-text-primary)]">
              The same scene, held still.
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-[var(--color-text-muted)] sm:text-base">
              On this device the camera stays put. Everything to shop — the catalogue,
              the collections, the gift studio — is exactly where it lives everywhere else.
            </p>
            <Link
              to="/shop"
              className="mt-6 inline-flex items-center gap-2 rounded-full bg-[var(--color-botanical-primary)] px-6 py-3 text-sm font-semibold text-[var(--color-text-inverse)] transition-colors hover:bg-[var(--color-botanical-secondary)]"
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
      aria-label="A camera travels through the studio"
      className="relative bg-[var(--color-surface-low)]"
    >
      <div ref={stageRef} data-stage-canvas className="cinematic-stage relative h-[100svh] w-full overflow-hidden">
        <div className="absolute inset-0">
          {near ? (
            <Suspense fallback={null}>
              <CinematicStage progressRef={progressRef} />
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
                <h3 className="mt-2 font-serif text-[clamp(1.7rem,3.4vw,2.6rem)] leading-[1.05] tracking-[-0.015em] text-[var(--color-text-primary)]">
                  {shot.title}
                </h3>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--color-text-muted)]">
                  {shot.body}
                </p>
                {shot.cta ? (
                  <Link
                    to={shot.cta.to}
                    className="pointer-events-auto mt-5 inline-flex items-center gap-2 rounded-full bg-[var(--color-botanical-primary)] px-6 py-3 text-sm font-semibold text-[var(--color-text-inverse)] transition-colors hover:bg-[var(--color-botanical-secondary)]"
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
