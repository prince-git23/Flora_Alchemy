import React, { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useTheme } from '../../context/ThemeContext.jsx';

/**
 * CINEMATIC STAGE — the storefront's ONE dedicated 3D canvas.
 *
 * A small, scroll-driven camera sequence through a single continuous studio
 * scene: one licensed CC0 botanical model (Poly Haven "flower_gazania", see
 * docs/CINEMATIC_STAGE.md) on a studio floor with a seamless backdrop. The
 * camera follows a CatmullRom path of five shots — establish, dolly-out,
 * lateral track, three-quarter, pull-away — whose POSITION, TARGET and FOV are
 * functions of the homepage scroll progress that `SceneStage` publishes into
 * `progressRef`. There is exactly one writer of the camera (this file's
 * `useFrame` director); GSAP only publishes a number.
 *
 * This module is ALWAYS a lazy chunk (SceneStage lazily imports it), so
 * three.js can never reach the HomePage chunk or the entry bundle — FLOW 41 in
 * `e2e/specs/14-cinematic-home.spec.js` enforces that invariant.
 *
 * QA instrumentation (requirement: "prove the camera genuinely moves"): when
 * mounted, the stage publishes `window.__floraStage` — live camera position /
 * look-target / progress, a `project()` NDC projector and a `hitAt()` raycast
 * probe — for the automated checks in `e2e/specs/15-cinematic-stage.spec.js`.
 * It is a plain object with no UI; nothing customer-facing renders from it.
 */

const MODEL_URL = '/models/gazania-cc0.glb';
const TARGET_HEIGHT = 0.85; // metres — the posy's height above the studio floor

// ── The five shots. Positions in metres around the model (re-centred to the
// origin, floor at y=0, top near y=TARGET_HEIGHT). Centripetal CatmullRom
// through these points keeps the path smooth without overshooting into the
// subject; the three-quarter leg passes ~1.3 m out and ~1.2 m up, clear of the
// 0.85 m cluster.
export const SHOTS = Object.freeze([
  { id: 'establish', pos: [0.34, 0.66, 0.62], target: [0.02, 0.55, 0.06], fov: 30 },
  { id: 'dolly-out', pos: [0.62, 1.25, 2.1], target: [0, 0.45, 0], fov: 36 },
  { id: 'lateral', pos: [-1.6, 0.8, 1.45], target: [0.05, 0.45, 0], fov: 36 },
  { id: 'three-quarter', pos: [-1.05, 1.05, -1.5], target: [0, 0.42, 0.05], fov: 33 },
  { id: 'pull-away', pos: [0.5, 1.85, 3.0], target: [0, 0.3, 0.2], fov: 42 },
]);

const STUDIO_LIGHT = Object.freeze({ bg: '#f6f3ee', floor: '#fbf9f5', key: 2.0, fill: 0.55 });
const STUDIO_DARK = Object.freeze({ bg: '#26221e', floor: '#1b1815', key: 1.7, fill: 0.4 });

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

function sampleFov(t) {
  const segments = SHOTS.length - 1;
  const scaled = clamp01(t) * segments;
  const i = Math.min(Math.floor(scaled), segments - 1);
  const f = scaled - i;
  return SHOTS[i].fov + (SHOTS[i + 1].fov - SHOTS[i].fov) * f;
}

// ── The botanical model. Loaded once (drei caches by URL), cloned so the cache
// is never mutated, then normalised: scaled to TARGET_HEIGHT, re-centred on x/z,
// resting on y=0 so every shot's framing math holds.
function Bouquet({ qa }) {
  const { scene } = useGLTF(MODEL_URL);
  const root = useMemo(() => {
    const clone = scene.clone(true);
    const before = new THREE.Box3().setFromObject(clone);
    const size = before.getSize(new THREE.Vector3());
    const scale = TARGET_HEIGHT / Math.max(size.y, 1e-6);
    clone.scale.setScalar(scale);
    const after = new THREE.Box3().setFromObject(clone);
    const centre = after.getCenter(new THREE.Vector3());
    clone.position.set(-centre.x, -after.min.y, -centre.z);
    clone.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = false;
      }
    });
    return clone;
  }, [scene]);

  // useGLTF suspends until the GLB is parsed, so by the time this commits the
  // model is real geometry in the scene graph. The QA handle reports it as
  // ready so the browser checks can wait for the MODEL, not just the camera.
  useEffect(() => {
    qa.current.modelReady = true;
    return () => {
      qa.current.modelReady = false;
    };
  }, [qa]);

  return <primitive object={root} />;
}

// ── The camera director. The single, exclusive writer of the camera: it reads
// the scroll progress `SceneStage` published, samples the two CatmullRom curves
// (position + look-target) and the FOV ramp, and damps the camera toward that
// pose each frame. Scrolling back re-samples the same curve, so earlier poses
// return exactly once the damping settles.
function CameraDirector({ progressRef, palette, small, qa }) {
  const { camera, scene, gl } = useThree();

  const curves = useMemo(
    () => ({
      pos: new THREE.CatmullRomCurve3(
        SHOTS.map((s) => new THREE.Vector3(...s.pos)),
        false,
        'centripetal'
      ),
      target: new THREE.CatmullRomCurve3(
        SHOTS.map((s) => new THREE.Vector3(...s.target)),
        false,
        'centripetal'
      ),
    }),
    []
  );

  const scratch = useMemo(
    () => ({
      pos: new THREE.Vector3(),
      target: new THREE.Vector3(),
      look: new THREE.Vector3(...SHOTS[0].target),
      ndc: new THREE.Vector3(),
      ray: new THREE.Raycaster(),
    }),
    []
  );

  const frames = useRef(0);

  // ── QA handle (developer instrumentation; no customer-facing surface) ──
  useEffect(() => {
    const handle = {
      get frames() {
        return frames.current;
      },
      get progress() {
        return clamp01(progressRef.current ?? 0);
      },
      get shot() {
        const t = clamp01(progressRef.current ?? 0);
        return Math.round(t * (SHOTS.length - 1));
      },
      get fov() {
        return camera.fov;
      },
      get modelReady() {
        return Boolean(qa.current.modelReady);
      },
      get position() {
        return [camera.position.x, camera.position.y, camera.position.z];
      },
      get target() {
        return [scratch.look.x, scratch.look.y, scratch.look.z];
      },
      // World point → normalised device coordinates, through the LIVE camera.
      project(x, y, z) {
        camera.updateMatrixWorld();
        scratch.ndc.set(x, y, z).project(camera);
        return [scratch.ndc.x, scratch.ndc.y, scratch.ndc.z];
      },
      // First mesh hit by a ray through an NDC point — proves occlusion order
      // changes with the viewpoint. 'Plane.*' are the model's leaf meshes,
      // 'studio-floor' / 'studio-backdrop' are the environment.
      hitAt(ndcX, ndcY) {
        camera.updateMatrixWorld();
        scratch.ray.setFromCamera({ x: ndcX, y: ndcY }, camera);
        const hits = scratch.ray.intersectObjects(scene.children, true);
        for (const hit of hits) {
          let obj = hit.object;
          while (obj && !obj.name) obj = obj.parent;
          if (obj?.name) return obj.name;
        }
        return null;
      },
    };
    window.__floraStage = handle;
    return () => {
      if (window.__floraStage === handle) delete window.__floraStage;
    };
  }, [camera, scene, gl, progressRef, scratch, qa]);

  useFrame((_state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05); // clamp tab-hidden spikes
    const t = clamp01(progressRef.current ?? 0);

    curves.pos.getPoint(t, scratch.pos);
    curves.target.getPoint(t, scratch.target);

    // Exponential damping: frame-rate independent, settles in ~0.4 s, and —
    // because progress itself is a pure function of scroll — returns to the
    // identical pose when the user scrolls back.
    const k = 1 - Math.exp(-8 * delta);
    camera.position.lerp(scratch.pos, k);
    scratch.look.lerp(scratch.target, k);
    camera.up.set(0, 1, 0);
    camera.lookAt(scratch.look);

    const fov = sampleFov(t);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    frames.current += 1;
  });

  // Lights: one warm key with a single shadow map, one cool fill. No
  // post-processing — the brief forbids effects the scene does not need.
  return (
    <>
      <ambientLight intensity={0.55} />
      <hemisphereLight args={[palette.bg, palette.floor, 0.35]} />
      <directionalLight
        position={[2.8, 3.6, 2.0]}
        intensity={palette.key}
        castShadow
        shadow-mapSize-width={small ? 512 : 1024}
        shadow-mapSize-height={small ? 512 : 1024}
        shadow-camera-left={-3.5}
        shadow-camera-right={3.5}
        shadow-camera-top={3.5}
        shadow-camera-bottom={-3.5}
        shadow-camera-near={0.5}
        shadow-camera-far={12}
        shadow-bias={-0.0008}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[-2.6, 1.8, -1.6]} intensity={palette.fill} />
    </>
  );
}

export default function CinematicStage({ progressRef }) {
  const { isDark } = useTheme();
  const qa = useRef({ modelReady: false });

  const { palette, dpr, small } = useMemo(() => {
    const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
    const smallScreen = width < 768;
    return {
      palette: isDark ? STUDIO_DARK : STUDIO_LIGHT,
      dpr: Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, smallScreen ? 1.5 : 1.75),
      small: smallScreen,
    };
  }, [isDark]);

  return (
    <Canvas
      shadows
      dpr={dpr}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      camera={{ position: SHOTS[0].pos, fov: SHOTS[0].fov, near: 0.05, far: 60 }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.NeutralToneMapping;
        gl.toneMappingExposure = 1.0;
      }}
    >
      {/* Seamless cyclorama: the fog colour equals the backdrop colour and the
          page band behind the canvas, so the scene horizon dissolves into the
          photographic storefront at every camera angle. */}
      <color attach="background" args={[palette.bg]} />
      <fog attach="fog" args={[palette.bg, 5, 11]} />

      <CameraDirector progressRef={progressRef} palette={palette} small={small} qa={qa} />

      <Bouquet qa={qa} />

      <mesh name="studio-floor" rotation-x={-Math.PI / 2} position-y={0} receiveShadow>
        <circleGeometry args={[8, 64]} />
        <meshStandardMaterial color={palette.floor} roughness={0.95} metalness={0} />
      </mesh>
      <mesh name="studio-backdrop" position={[0, 2.5, 0]}>
        <cylinderGeometry args={[8, 8, 7, 48, 1, true]} />
        <meshStandardMaterial color={palette.bg} side={THREE.BackSide} roughness={1} metalness={0} />
      </mesh>
    </Canvas>
  );
}

// Warm the drei URL cache as soon as the chunk evaluates, so the model is
// already in flight while the canvas mounts.
useGLTF.preload(MODEL_URL);
