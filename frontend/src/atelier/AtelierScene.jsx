import React, { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { AdaptiveDpr, AdaptiveEvents } from '@react-three/drei';
import { EffectComposer, Bloom, DepthOfField, Vignette, Noise, ToneMapping } from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';
import * as THREE from 'three';
import { ATELIER } from './palette.js';
import { Workbench, StudioShell, BenchTools, CalligraphyStation, WaxStation, Grounding, DriftingPetal } from './Set.jsx';
import { Composition } from './Flora.jsx';

/**
 * THE CAMERA — a small film crew, not an orbit control.
 *
 * Three shots, one per chapter of the workshop:
 *
 *   0  MACRO      — the bloom and the wax seal, shallow depth of field
 *   1  TRACKING   — a low dolly across the bench toward the calligraphy card
 *   2  CRANE      — rise and pull back to the finished composition
 *
 * The page's scroll progress (0→1 over the pinned section) selects a point on a
 * Catmull-Rom curve through those poses; the camera chases it with a critically
 * damped lerp so a fast scroll reads as a camera move rather than a jump cut.
 *
 * Under reduced motion the camera HOLDS the hero pose and never scrolls: the
 * scene is still shown, it just stops pretending to be a film.
 */
const SHOTS = [
  {
    id: 'macro',
    position: [0.02, 0.42, 1.02],
    target: [0.0, 0.3, 0.02],
    fov: 34,
    focus: 0.42,
    bokeh: 3.2,
    label: 'Macro — wax and bloom',
  },
  {
    id: 'tracking',
    position: [-0.36, 0.34, 0.9],
    target: [0.14, 0.24, 0.3],
    fov: 38,
    focus: 0.55,
    bokeh: 2.4,
    label: 'Tracking — across the bench',
  },
  {
    id: 'crane',
    position: [0.34, 0.86, 1.44],
    target: [0.0, 0.3, 0.0],
    fov: 44,
    focus: 0.72,
    bokeh: 1.4,
    label: 'Crane — the finished keepsake',
  },
];

export const SHOT_POSES = SHOTS;

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Interpolate the shot list at a normalised progress. */
export function poseAt(progress) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const scaled = clamped * (SHOTS.length - 1);
  const index = Math.min(SHOTS.length - 2, Math.floor(scaled));
  const local = easeInOut(scaled - index);
  const a = SHOTS[index];
  const b = SHOTS[index + 1];
  const mix = (from, to) => from + (to - from) * local;
  return {
    position: [mix(a.position[0], b.position[0]), mix(a.position[1], b.position[1]), mix(a.position[2], b.position[2])],
    target: [mix(a.target[0], b.target[0]), mix(a.target[1], b.target[1]), mix(a.target[2], b.target[2])],
    fov: mix(a.fov, b.fov),
    focus: mix(a.focus, b.focus),
    bokeh: mix(a.bokeh, b.bokeh),
    shot: SHOTS[clamped < 0.34 ? 0 : clamped < 0.7 ? 1 : 2],
    index,
  };
}

/** Counts rendered frames so QA can prove the workshop is drawing, not stalled. */
function FrameProbe() {
  useFrame(() => {
    if (typeof window !== 'undefined' && window.__floraAtelier) window.__floraAtelier.frames += 1;
  });
  return null;
}

function CameraDirector({ progressRef, reducedMotion, onShot, pointer }) {
  const { camera } = useThree();
  const target = useMemo(() => new THREE.Vector3(0, 0.3, 0), []);
  const desired = useMemo(() => new THREE.Vector3(), []);
  const desiredTarget = useMemo(() => new THREE.Vector3(), []);
  const lastShot = useRef('');

  useFrame((state, delta) => {
    const progress = reducedMotion ? 0 : progressRef.current;
    const pose = poseAt(progress);

    // A little pointer parallax, but only a couple of centimetres: the camera is
    // choreographed, not user-rotated, and a hero that swings with the mouse is
    // the effect this scene is trying not to be.
    const px = reducedMotion ? 0 : pointer.current.x * 0.05;
    const py = reducedMotion ? 0 : pointer.current.y * 0.025;

    desired.set(pose.position[0] + px, pose.position[1] + py, pose.position[2]);
    desiredTarget.set(pose.target[0] + px * 0.35, pose.target[1] + py * 0.35, pose.target[2]);

    const damping = 1 - Math.exp(-6 * delta);
    camera.position.lerp(desired, damping);
    target.lerp(desiredTarget, damping);
    camera.lookAt(target);

    const perspective = camera;
    if (perspective.isPerspectiveCamera && Math.abs(perspective.fov - pose.fov) > 0.05) {
      perspective.fov += (pose.fov - perspective.fov) * damping;
      perspective.updateProjectionMatrix();
    }

    if (pose.shot.id !== lastShot.current) {
      lastShot.current = pose.shot.id;
      onShot?.(pose.shot, pose);
    }
    // Keep the shadow camera following the action without re-parenting lights.
    state.invalidate?.();
  });

  return null;
}

/**
 * Lighting: one window key with a long soft shadow, a cool fill from the room,
 * a warm practical behind the shelf, and a rim that separates the blooms from
 * the wall. Intensity is tuned for NeutralToneMapping (three ≥ r162), which
 * keeps the paper cream instead of clipping it white.
 */
function Lights({ shadows = true }) {
  return (
    <>
      <ambientLight intensity={0.42} color="#f3e7d4" />
      <hemisphereLight intensity={0.5} color="#fff1da" groundColor="#4a3a2b" />

      <directionalLight
        position={[-2.4, 3.1, 1.9]}
        intensity={2.1}
        color="#ffe7c4"
        castShadow={shadows}
        shadow-mapSize-width={shadows ? 1024 : 512}
        shadow-mapSize-height={shadows ? 1024 : 512}
        shadow-bias={-0.0006}
        shadow-normalBias={0.02}
      >
        <orthographicCamera attach="shadow-camera" args={[-3, 3, 3, -3, 0.1, 12]} />
      </directionalLight>

      <directionalLight position={[2.2, 1.4, 2.6]} intensity={0.55} color="#e8eef5" />
      <directionalLight position={[0.2, 1.8, -2.2]} intensity={0.5} color="#ffdfae" />

      <pointLight position={[1.1, 0.55, -1.1]} intensity={2.4} distance={3.2} decay={2} color={ATELIER.lamp} />
      <pointLight position={[-0.9, 0.75, 0.9]} intensity={0.7} distance={3} decay={2} color="#ffd9a0" />
    </>
  );
}

/** Post-processing, tiered: DOF+bloom on capable desktops, nothing below.
 *
 * `ToneMapping` is not decoration: mounting `EffectComposer` sets the renderer's
 * tone mapping to NONE (measured: `gl.toneMapping === 0` with the composer on),
 * so the neutral curve `onCreated` configured no longer reaches the screen on
 * exactly the tier that shows it most. Re-applying Khronos PBR-neutral inside
 * the chain is what keeps the paper cream instead of clipping it white. */
function Effects({ tier, shot }) {
  if (tier !== 'full') return null;
  return (
    <EffectComposer multisampling={0} disableNormalPass>
      <DepthOfField focusDistance={shot.focus} focalLength={0.06} bokehScale={shot.bokeh} height={480} />
      <Bloom intensity={0.28} luminanceThreshold={0.82} luminanceSmoothing={0.3} mipmapBlur />
      <Vignette eskil={false} offset={0.28} darkness={0.72} />
      <Noise opacity={0.028} blendFunction={BlendFunction.OVERLAY} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
    </EffectComposer>
  );
}

/**
 * The scene itself. Split from the canvas host (`AtelierExperience`) so the
 * DOM overlay, the scroll choreography and the WebGL tree stay testable and
 * independently replaceable: the static fallback renders the same overlay with
 * no scene at all.
 */
export default function AtelierScene({
  tier = 'full',
  config = {},
  chapter = 0,
  progressRef,
  pointerRef,
  onShot,
}) {
  const reducedMotion = tier === 'reduced';
  const shadows = tier === 'full' || tier === 'standard';
  const dense = tier === 'full' || tier === 'standard';
  const pose = useRef(poseAt(0));
  const shotRef = useRef(SHOTS[0]);
  /* Hooks run unconditionally (the prop is an optional OVERRIDE, never an
     optional hook): the scene owns a pointer fallback and prefers the caller's
     ref when one is passed. */
  const ownPointer = useRef({ x: 0, y: 0 });
  const pointer = pointerRef || ownPointer;

  return (
    <>
      <color attach="background" args={['#2a1f17']} />
      <fog attach="fog" args={['#3a2c1f', 3.2, 7.5]} />

      <Lights shadows={shadows} />
      <CameraDirector
        progressRef={progressRef}
        reducedMotion={reducedMotion}
        pointer={pointer}
        onShot={(shot) => {
          shotRef.current = shot;
          pose.current = shot;
          onShot?.(shot);
        }}
      />

      <StudioShell />
      <Workbench />

      <group position={[0, 0.32, 0.18]}>
        <Composition
          baseId={config.baseId}
          paletteId={config.paletteId}
          ribbonId={config.ribbonId}
          sealId={config.sealId}
          monogram={config.monogram}
          proportionate={dense}
        />
      </group>

      <BenchTools paletteColour={config.ribbonColour || ATELIER.blush} />
      <WaxStation sealColour={config.sealColour || ATELIER.terracotta} pressed={chapter === 0} />
      <CalligraphyStation name={config.name || ''} />

      {shadows ? <Grounding /> : null}

      {dense ? (
        <>
          <DriftingPetal seed={0.4} colour={config.petalColour || ATELIER.blush} />
          <DriftingPetal seed={2.1} colour={config.petalColour || ATELIER.lavender} />
        </>
      ) : null}

      <Effects tier={tier} shot={pose.current} />
      <FrameProbe />
      <AdaptiveDpr pixelated />
      <AdaptiveEvents />
    </>
  );
}
