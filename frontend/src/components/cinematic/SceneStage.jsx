import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { gsap } from '../../lib/gsapSetup.js';
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
 * EXIT CHOREOGRAPHY (owner's correction of the first cut): the last caption
 * and the scene itself must RESOLVE before the craft section arrives — no
 * "Four frames from the bench" appearing underneath a still-active caption.
 * So the same progress value that drives the camera also (a) staggers each
 * caption's kicker → title → body → CTA in as GSAP masked-reveal type, and
 * (b) over the final 2% of the runway fades the last caption out while a
 * veil the colour of the section surface rises over the canvas. Because the
 * band behind the canvas and the veil are the SAME surface token, the pin's
 * release at progress 1.0 is then colour-continuous: the visitor sees an
 * authored cut onto one calm surface, and the craft section rises onto it
 * only after the stage has finished.
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
  const veilRef = useRef(null);
  const captionTweenRef = useRef(null);
  const activeRef = useRef(-1);
  const [near, setNear] = useState(false);
  const { mode } = useStageCapability();
  const isStage = mode === 'stage';

  /**
   * CAPTION ENTRY — kinetic type on the camera's own timeline. When a shot
   * becomes active its parts stagger in: the title rides up through its
   * mask, the kicker/body/CTA settle beneath it. Re-entering a caption
   * replays its reveal (a fromTo at activation), so scrolling back and forth
   * re-stages each shot instead of showing a frozen crossfade. Writes only
   * caption DOM — never the camera.
   */
  const playCaption = (index) => {
    if (activeRef.current === index) return;
    activeRef.current = index;
    const el = captionRefs.current[index];
    captionTweenRef.current?.kill();
    captionTweenRef.current = null;
    if (!el) return;
    const parts = el.querySelectorAll('[data-cap-part]');
    if (parts.length === 0) return;
    captionTweenRef.current = gsap.fromTo(
      parts,
      {
        opacity: 0,
        y: (_i, node) => (node.hasAttribute('data-cap-mask') ? 0 : 14),
        yPercent: (_i, node) => (node.hasAttribute('data-cap-mask') ? 108 : 0),
      },
      {
        opacity: 1,
        y: 0,
        yPercent: 0,
        duration: 0.6,
        ease: 'power3.out',
        stagger: 0.09,
        overwrite: true,
      }
    );
  };

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
        /* EXIT RESOLUTION: over the last 2% of the runway the final caption
           fades out and the surface veil rises over the canvas, so the stage
           has FINISHED — visually one calm band — before the craft section
           scrolls onto it. (Spec FLOW 49 samples at p=0.98: the caption is
           still fully on there; the fade owns only (0.98, 1.0].) */
        const exit = Math.min(1, Math.max(0, (p - 0.98) / 0.02));
        if (veilRef.current) veilRef.current.style.opacity = String(exit);
        captionRefs.current.forEach((el, i) => {
          if (!el) return;
          const on = i === active;
          const opacity = on ? (i === SHOT_COPY.length - 1 ? String(1 - exit) : '1') : '0';
          el.style.opacity = opacity;
          /* Exposure follows VISIBILITY, not selection: a caption that has
             faded out (the exit resolves it before craft arrives) must also
             leave the accessibility tree — an invisible caption that is
             still aria-hidden=false would be announced while showing
             nothing. Exactly one visible caption is exposed, as before. */
          el.setAttribute('aria-hidden', Number(opacity) > 0.5 ? 'false' : 'true');
        });
        if (active !== activeRef.current) playCaption(active);
      },
    });

    // Stage the first caption immediately (deterministic, not scroll-dependent).
    playCaption(Math.min(SHOT_COPY.length - 1, Math.round((trigger.progress || 0) * (SHOT_COPY.length - 1))));

    const refresh = window.setTimeout(() => ScrollTrigger.refresh(), 600);
    return () => {
      window.clearTimeout(refresh);
      captionTweenRef.current?.kill();
      captionTweenRef.current = null;
      activeRef.current = -1;
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

        {/* The exit veil: the same surface token the section band uses, so
            when the pin releases at progress 1.0 the canvas dissolves into
            an identical calm surface instead of cutting away — and the craft
            section then rises onto that surface only after the stage (and
            its final caption) has finished. */}
        <div
          ref={veilRef}
          data-stage-veil
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[6] bg-[var(--color-surface-low)]"
          style={{ opacity: 0 }}
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
                <p
                  data-cap-part
                  className="text-[11px] font-semibold tracking-[0.34em] text-[var(--color-botanical-primary)] uppercase"
                >
                  {shot.kicker}
                </p>
                <h3 className="mt-2 font-serif text-[clamp(1.7rem,3.4vw,2.6rem)] leading-[1.05] tracking-[-0.015em] text-[var(--color-botanical-primary)]">
                  <span className="block overflow-hidden pb-[0.14em]">
                    <span
                      data-cap-part
                      data-cap-mask
                      data-type-reveal="line"
                      className="block will-change-transform"
                    >
                      {shot.title}
                    </span>
                  </span>
                </h3>
                <p data-cap-part className="mt-3 max-w-md text-sm leading-relaxed text-[var(--color-botanical-muted)]">
                  {shot.body}
                </p>
                {shot.cta ? (
                  <span data-cap-part className="mt-5 inline-block">
                    <Link
                      to={shot.cta.to}
                      className="pointer-events-auto inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] px-7 py-3.5 text-[13px] font-semibold tracking-wide text-white shadow-md transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--color-btn-hover)] hover:shadow-lg"
                    >
                      {shot.cta.label}
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </span>
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
