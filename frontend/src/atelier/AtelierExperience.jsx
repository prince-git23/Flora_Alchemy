import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useNavigate } from 'react-router-dom';
import { Aperture, ArrowRight, Check, CircleDot, Flower2, PenLine, Ribbon as RibbonIcon, Sparkles } from 'lucide-react';
import * as THREE from 'three';
import { ScrollTrigger, prefersReducedMotion } from '../lib/gsapSetup.js';
import { BASES, PALETTES, RIBBONS, SEALS, pick, studioHref } from './palette.js';
import { studioEnvironmentTexture } from './textures.js';
import AtelierScene, { SHOT_POSES } from './AtelierScene.jsx';
import AtelierStatic from './AtelierStatic.jsx';
import useAtelierCapability from './useAtelierCapability.js';
import { SplitText, Magnetic, SpotlightCard } from './motion/index.jsx';

/**
 * THE ATELIER — the storefront's cinematic workshop.
 *
 * Three chapters, one composition:
 *
 *   01 THE SEAL     monogram + wax colour
 *   02 THE NOTE     the recipient's name + the flower palette
 *   03 THE RIBBON   the ribbon, and the base the gift arrives in
 *
 * The customer is not filling in a form beside a video: every choice is applied
 * to the object being filmed, and the finished composition is handed to the
 * Custom Gift Studio through `studioHref()` — the studio remains the only place
 * a price or an order is decided (server-authoritative pricing is untouched).
 *
 * DEGRADATION IS DESIGN, NOT A FAILURE. No WebGL → `AtelierStatic`, the same
 * chapters as a composed still. Reduced motion → the scene renders on one
 * flattering pose with no scroll choreography at all.
 */

const CHAPTERS = [
  {
    id: 'seal',
    index: '01',
    icon: CircleDot,
    kicker: 'The Seal',
    title: 'Pressed by hand',
    body: 'Your initials are cut into brass and pressed into warm wax. No two seals come out identical — that is the point.',
  },
  {
    id: 'note',
    index: '02',
    icon: PenLine,
    kicker: 'The Note',
    title: 'Written, not printed',
    body: 'A cotton-rag card, lettered by hand in the studio. The flowers are chosen to answer the message, not the other way round.',
  },
  {
    id: 'ribbon',
    index: '03',
    icon: RibbonIcon,
    kicker: 'The Ribbon',
    title: 'Tied to the keepsake',
    body: 'Plant-dyed silk, velvet cord or jute twine — tied around the wrap and finished with the seal you just made.',
  },
];

function ChapterRail({ chapter, onSelect }) {
  return (
    <div className="flex items-center gap-1.5" role="tablist" aria-label="Atelier chapters">
      {CHAPTERS.map((entry, index) => {
        const active = index === chapter;
        return (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(index)}
            className={`group flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium tracking-[0.14em] uppercase transition-colors ${
              active
                ? 'border-[var(--color-botanical-terracotta)] bg-[var(--color-botanical-terracotta)]/12 text-[var(--color-surface-bg)]'
                : 'border-white/25 text-white/60 hover:border-white/50 hover:text-white'
            }`}
            data-atelier-chapter={entry.id}
          >
            <entry.icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">{entry.kicker}</span>
            <span className="sm:hidden">{entry.index}</span>
          </button>
        );
      })}
    </div>
  );
}

function OptionButton({ selected, onClick, children, className = '', ...rest }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors ${
        selected
          ? 'border-[var(--color-botanical-terracotta)] bg-[var(--color-botanical-terracotta)] text-white'
          : 'border-white/25 text-white/70 hover:border-white/60 hover:text-white'
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

function Swatch({ hex, label, selected, onClick, secondary }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`relative h-9 w-9 rounded-full border-2 transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
        selected ? 'border-white' : 'border-white/25'
      }`}
      style={{
        background: secondary
          ? `linear-gradient(135deg, ${hex} 0 55%, ${secondary} 55% 100%)`
          : hex,
      }}
    >
      {selected ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <Check className="h-4 w-4 text-white drop-shadow" aria-hidden="true" />
        </span>
      ) : null}
    </button>
  );
}

/** One chapter's controls. Semantic radio semantics, no custom widget soup. */
function StationPanel({ chapter, config, update }) {
  if (chapter === 0) {
    return (
      <fieldset className="space-y-4">
        <legend className="sr-only">Monogram and wax</legend>
        <label className="block">
          <span className="text-[10px] font-semibold tracking-[0.2em] text-white/50 uppercase">Monogram (up to 3 letters)</span>
          <input
            value={config.monogram}
            onChange={(event) => {
              const letters = event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
              update({ monogram: letters });
            }}
            inputMode="text"
            autoComplete="off"
            maxLength={3}
            placeholder="FA"
            aria-label="Monogram, up to three letters"
            data-atelier-input="monogram"
            className="mt-1.5 w-full rounded-lg border border-white/25 bg-black/25 px-3 py-2 font-serif text-lg tracking-[0.3em] text-white placeholder:text-white/30 focus:border-white/70 focus:outline-none"
          />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {['FA', 'AD', 'MR', 'SJ'].map((preset) => (
            <OptionButton key={preset} selected={config.monogram === preset} onClick={() => update({ monogram: preset })}>
              {preset.split('').join('·')}
            </OptionButton>
          ))}
        </div>
        <div>
          <span className="text-[10px] font-semibold tracking-[0.2em] text-white/50 uppercase">Wax</span>
          <div className="mt-2 flex items-center gap-2.5">
            {SEALS.map((seal) => (
              <Swatch
                key={seal.id}
                hex={seal.hex}
                label={seal.name}
                selected={config.sealId === seal.id}
                onClick={() => update({ sealId: seal.id })}
              />
            ))}
          </div>
        </div>
      </fieldset>
    );
  }

  if (chapter === 1) {
    return (
      <fieldset className="space-y-4">
        <legend className="sr-only">Card and palette</legend>
        <label className="block">
          <span className="text-[10px] font-semibold tracking-[0.2em] text-white/50 uppercase">The name on the card</span>
          <input
            value={config.name}
            onChange={(event) => update({ name: event.target.value.toUpperCase().replace(/[^A-Z ]/g, '').slice(0, 18) })}
            maxLength={18}
            autoComplete="off"
            placeholder="SOMEONE SPECIAL"
            aria-label="Name on the card"
            data-atelier-input="name"
            className="mt-1.5 w-full rounded-lg border border-white/25 bg-black/25 px-3 py-2 font-serif text-lg text-white placeholder:text-white/30 focus:border-white/70 focus:outline-none"
          />
        </label>
        <div>
          <span className="text-[10px] font-semibold tracking-[0.2em] text-white/50 uppercase">Palette</span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {PALETTES.map((palette) => (
              <button
                key={palette.id}
                type="button"
                aria-pressed={config.paletteId === palette.id}
                onClick={() => update({ paletteId: palette.id })}
                className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-[11px] transition-colors ${
                  config.paletteId === palette.id
                    ? 'border-white/80 bg-white/10 text-white'
                    : 'border-white/20 text-white/65 hover:border-white/45 hover:text-white'
                }`}
              >
                <span
                  className="h-5 w-5 shrink-0 rounded-full"
                  style={{ background: `linear-gradient(135deg, ${palette.primary} 0 55%, ${palette.secondary} 55% 100%)` }}
                  aria-hidden="true"
                />
                <span className="leading-tight">{palette.name}</span>
              </button>
            ))}
          </div>
        </div>
      </fieldset>
    );
  }

  return (
    <fieldset className="space-y-4">
      <legend className="sr-only">Ribbon and base</legend>
      <div>
        <span className="text-[10px] font-semibold tracking-[0.2em] text-white/50 uppercase">Ribbon</span>
        <div className="mt-2 space-y-1.5">
          {RIBBONS.map((ribbon) => (
            <button
              key={ribbon.id}
              type="button"
              aria-pressed={config.ribbonId === ribbon.id}
              onClick={() => update({ ribbonId: ribbon.id })}
              className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                config.ribbonId === ribbon.id
                  ? 'border-white/80 bg-white/10 text-white'
                  : 'border-white/20 text-white/65 hover:border-white/45 hover:text-white'
              }`}
            >
              <span className="h-4 w-4 shrink-0 rounded-full border border-white/30" style={{ background: ribbon.hex }} aria-hidden="true" />
              <span className="text-[11px] leading-tight">{ribbon.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="text-[10px] font-semibold tracking-[0.2em] text-white/50 uppercase">Arrives in</span>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {BASES.map((base) => (
            <OptionButton key={base.id} selected={config.baseId === base.id} onClick={() => update({ baseId: base.id })} title={base.hint}>
              {base.name.split(' ').slice(-2).join(' ')}
            </OptionButton>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

export default function AtelierExperience({ initialConfig }) {
  const navigate = useNavigate();
  const capability = useAtelierCapability();
  const sectionRef = useRef(null);
  const stageRef = useRef(null);
  const progressRef = useRef(0);
  const pointerRef = useRef({ x: 0, y: 0 });
  const [near, setNear] = useState(false);
  const [chapter, setChapter] = useState(0);
  const [ready, setReady] = useState(false);
  const reduced = typeof window !== 'undefined' && prefersReducedMotion();

  /* Drop the QA handle when the section unmounts: a handle left behind would
     let a later "is it drawing?" query answer from a dead renderer. */
  useEffect(
    () => () => {
      if (typeof window !== 'undefined' && window.__floraAtelier) delete window.__floraAtelier;
    },
    []
  );
  const [config, setConfig] = useState(() => ({
    baseId: 'keepsake-posy',
    paletteId: 'mauve',
    sealId: 'terracotta',
    ribbonId: 'frayed-silk',
    monogram: 'FA',
    name: '',
    ...initialConfig,
  }));

  const palette = pick(PALETTES, config.paletteId);
  const seal = pick(SEALS, config.sealId);
  const ribbon = pick(RIBBONS, config.ribbonId);
  const base = pick(BASES, config.baseId);

  const update = useCallback((patch) => setConfig((prev) => ({ ...prev, ...patch })), []);

  /* The cinematic chunk is only requested when the section is nearly on screen:
     the homepage must not pay for a workshop nobody scrolled to. */
  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /* Scroll choreography: hold the stage while the runway passes, and read the
     selected shot from the same progress.

     PINNED, NOT STICKY. `position: sticky` cannot work here: the storefront's
     `body { overflow-x: hidden }` makes body a scroll container, so a sticky
     stage simply scrolls away with the page (measured in the browser before
     this change). ScrollTrigger's pin owns the hold with `pinSpacing: false`,
     because the runway below already provides the scroll distance. */
  useEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    if (!section || !stage || prefersReducedMotion()) return undefined;

    const trigger = ScrollTrigger.create({
      trigger: section,
      start: 'top top',
      end: 'bottom bottom',
      pin: stage,
      pinSpacing: false,
      anticipatePin: 1,
      invalidateOnRefresh: true,
      onUpdate: (self) => {
        progressRef.current = self.progress;
        const next = self.progress < 0.34 ? 0 : self.progress < 0.7 ? 1 : 2;
        setChapter((current) => (current === next ? current : next));
      },
    });

    // The stage's own content (the static still, then the canvas) changes size
    // as it mounts; refresh once it settles so the pin's start/end stay true.
    const refresh = () => ScrollTrigger.refresh();
    const timer = window.setTimeout(refresh, 600);

    return () => {
      window.clearTimeout(timer);
      trigger.kill();
    };
  }, []);

  const onPointerMove = useCallback((event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    pointerRef.current = {
      x: ((event.clientX - rect.left) / rect.width - 0.5) * 2,
      y: ((event.clientY - rect.top) / rect.height - 0.5) * 2,
    };
  }, []);

  const goToStudio = useCallback(() => {
    navigate(
      studioHref({
        baseId: config.baseId,
        paletteId: config.paletteId,
        sealId: config.sealId,
        ribbonId: config.ribbonId,
        monogram: config.monogram,
      })
    );
  }, [config, navigate]);

  const summary = useMemo(
    () => [seal.name, `${palette.name} palette`, ribbon.name, base.name].join(' · '),
    [seal.name, palette.name, ribbon.name, base.name]
  );

  const current = CHAPTERS[chapter];

  return (
    <section
      id="atelier"
      ref={sectionRef}
      className="atelier-section relative bg-[#241a12] text-white"
      aria-labelledby="atelier-heading"
      data-atelier-section
      data-atelier-chapter-active={current.id}
    >
      <div ref={stageRef} className="atelier-stage relative h-[100svh] w-full overflow-hidden" onPointerMove={onPointerMove}>
        {/* ── the stage ─────────────────────────────────────────────────── */}
        {near && capability.render ? (
          <Suspense fallback={<AtelierStatic config={config} palette={palette} base={base} ribbon={ribbon} seal={seal} loading />}>
            <div className="absolute inset-0" aria-hidden="true">
              <Canvas
                dpr={[1, 1.8]}
                shadows
                gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
                camera={{ position: [0.02, 0.42, 1.02], fov: 34, near: 0.05, far: 14 }}
                onCreated={({ gl, scene, camera }) => {
                  // Neutral tone mapping keeps the paper cream and the wax a real
                  // terracotta instead of clipping both toward white.
                  gl.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
                  gl.toneMappingExposure = 1.0;
                  gl.outputColorSpace = THREE.SRGBColorSpace;
                  gl.setClearColor('#241a12');

                  // A warm studio environment generated from a canvas, so brass,
                  // wax and silk have something to reflect without downloading an
                  // HDRI (and without a CDN dependency in the storefront).
                  const texture = new THREE.CanvasTexture(studioEnvironmentTexture({ size: 256 }));
                  texture.mapping = THREE.EquirectangularReflectionMapping;
                  texture.colorSpace = THREE.SRGBColorSpace;
                  const pmrem = new THREE.PMREMGenerator(gl);
                  const env = pmrem.fromEquirectangular(texture);
                  scene.environment = env.texture;
                  pmrem.dispose();
                  texture.dispose();

                  /* A read-only handle for QA and support: the scene, its camera
                     and the renderer, so "is the workshop actually drawing?" can
                     be answered without a screenshot. Nothing here is secret and
                     nothing writes to it. */
                  window.__floraAtelier = { scene, camera, gl, frames: 0 };
                  setReady(true);
                }}
              >
                <AtelierScene
                  tier={capability.tier}
                  config={{
                    ...config,
                    sealColour: seal.hex,
                    petalColour: palette.primary,
                    ribbonColour: ribbon.hex,
                  }}
                  chapter={chapter}
                  progressRef={progressRef}
                  pointerRef={pointerRef}
                />
              </Canvas>
            </div>
          </Suspense>
        ) : (
          /* No WebGL context (or save-data, or the chunk has not been requested
             yet): a designed still of the same composition — never an empty
             rectangle, and never a "your browser is old" message. */
          <AtelierStatic config={config} palette={palette} base={base} ribbon={ribbon} seal={seal} loading={!near} />
        )}

        {/* ── film grain + viewfinder ───────────────────────────────────── */}
        <div className="atelier-grain pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/80 via-black/25 to-transparent" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/40" aria-hidden="true" />

        {/* The viewfinder frame: four corner brackets, a shot label and a
            chapter counter. It is chrome, not content — aria-hidden, and never
            the only place a fact appears. */}
        <div className="pointer-events-none absolute inset-4 hidden sm:block" aria-hidden="true">
          {['top-0 left-0 border-t border-l', 'top-0 right-0 border-t border-r', 'bottom-0 left-0 border-b border-l', 'bottom-0 right-0 border-b border-r'].map((cls) => (
            <span key={cls} className={`absolute h-7 w-7 border-white/35 ${cls}`} />
          ))}
          <span className="absolute top-1 left-8 text-[10px] tracking-[0.28em] text-white/45 uppercase">atelier · shot {chapter + 1}/3</span>
          <span className="absolute top-1 right-8 flex items-center gap-2 text-[10px] tracking-[0.28em] text-white/45 uppercase">
            <Aperture className="h-3 w-3" /> {ready ? 'live' : 'loading'}
          </span>
          <span className="absolute bottom-1 left-8 text-[10px] tracking-[0.22em] text-white/40 uppercase">
            {SHOT_POSES[Math.min(chapter, SHOT_POSES.length - 1)].label}
          </span>
          <span className="absolute right-8 bottom-1 text-[10px] tracking-[0.22em] text-white/40 uppercase">35mm · f/1.8</span>
        </div>

        {/* ── content ──────────────────────────────────────────────────── */}
        <div className="relative z-10 flex h-full flex-col justify-between px-5 py-6 sm:px-8 lg:px-12">
          <div className="flex items-start justify-between gap-4">
            <p className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.32em] text-white/55 uppercase">
              <Sparkles className="h-3.5 w-3.5 text-[var(--color-botanical-sage-light)]" aria-hidden="true" />
              The Atelier
            </p>
            <ChapterRail chapter={chapter} onSelect={(index) => setChapter(index)} />
          </div>

          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,23rem)] lg:items-end">
            <div className="max-w-xl">
              <p className="mb-2 text-[11px] font-semibold tracking-[0.34em] text-[var(--color-botanical-terracotta-light)] uppercase">
                {current.index} — {current.kicker}
              </p>
              <h2 id="atelier-heading" className="font-serif text-[clamp(2rem,4.6vw,3.6rem)] leading-[1.02] tracking-[-0.02em]">
                <SplitText text={current.title} />
              </h2>
              <p className="mt-3 max-w-md text-[13px] leading-relaxed text-white/70 sm:text-sm">{current.body}</p>
              <p className="mt-4 text-[11px] tracking-[0.16em] text-white/40 uppercase" data-atelier-shot={current.id}>
                {SHOT_POSES[Math.min(chapter, SHOT_POSES.length - 1)].label}
              </p>
            </div>

            <SpotlightCard className="rounded-2xl border border-white/15 bg-black/35 p-4 backdrop-blur-md sm:p-5" data-atelier-panel="">
              <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold tracking-[0.22em] text-white/55 uppercase">
                <Flower2 className="h-3.5 w-3.5" aria-hidden="true" />
                Compose it
              </div>
              <StationPanel chapter={chapter} config={config} update={update} />
              <p className="mt-4 text-[11px] leading-relaxed text-white/45" aria-live="polite" data-atelier-summary>
                {summary}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Magnetic>
                  <button
                    type="button"
                    onClick={goToStudio}
                    className="inline-flex items-center gap-2 rounded-full bg-[var(--color-surface-bg)] px-4 py-2.5 text-[12px] font-semibold text-[var(--color-botanical-primary)] transition-colors hover:bg-white"
                    data-atelier-cta
                  >
                    Finish it in the studio
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </Magnetic>
                <button
                  type="button"
                  onClick={() => setChapter((chapter + 1) % CHAPTERS.length)}
                  className="rounded-full border border-white/30 px-3.5 py-2.5 text-[11px] tracking-[0.12em] text-white/75 uppercase transition-colors hover:border-white/60 hover:text-white"
                >
                  Next chapter
                </button>
              </div>
            </SpotlightCard>
          </div>

          <p className="mt-4 text-[10px] tracking-[0.18em] text-white/35 uppercase">
            Handmade in the studio · every seal pressed to order
          </p>
        </div>
      </div>

      {/* The scroll runway. The stage is sticky above; this spacer gives the
          camera somewhere to travel without pinning or reflowing the page. */}
      <div aria-hidden="true" className={reduced ? 'h-[40svh]' : 'h-[160svh]'} />
    </section>
  );
}
