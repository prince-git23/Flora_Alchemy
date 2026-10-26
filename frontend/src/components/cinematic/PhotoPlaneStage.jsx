import React, { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { useTheme } from '../../context/ThemeContext.jsx';

/**
 * PHOTO-PLANE STAGE — the storefront's ONE dedicated WebGL surface, rebuilt
 * as a genuine camera travelling through REAL PHOTOGRAPHY.
 *
 * WHY THIS REPLACED THE MODEL STAGE. The previous stage loaded a decorative
 * CC0 gazania GLB that the owner disliked. This one renders no model at all:
 * six verified repository photographs (`flora-asset-*.jpg`, the same files the
 * rest of the storefront already ships) are hung as image-textured planes at
 * clearly separated depths in a small corridor, and a camera travels through
 * them. What is REAL here is the perspective, the parallax between planes at
 * different depths and the occlusion as one plane crosses in front of
 * another — all produced by an actual `PerspectiveCamera` whose position,
 * look-target and FOV are functions of scroll. What is NOT claimed: that a
 * photograph has volumetric geometry, or that the hidden reverse side of a
 * photographed object was reconstructed. This is a spatial photographic scene
 * — that hybrid is the approved direction, not a limitation to hide.
 *
 * HONESTY RULES ENFORCED IN THIS FILE:
 *  — Planes use `meshBasicMaterial` (unlit) with `toneMapped: false`, so the
 *    photographs' own colours reach the screen untouched. No white material
 *    may ever override product colour, and no lighting rig tints the imagery.
 *  — No ground plane, no backdrop mesh, no particles, no post-processing. The
 *    calm background is a clear colour drawn from the same surface token the
 *    page band uses; it is never part of the GLB/scene geometry the visitor
 *    could mistake for product.
 *  — Exactly ONE writer of the camera: this file's `useFrame` director. GSAP
 *    only publishes a progress number (see `SceneStage.jsx`); React state and
 *    `useFrame` never both write camera transforms.
 *
 * LIFECYCLE: `SceneStage` imports this lazily and only near the viewport, so
 * three.js never reaches the HomePage chunk or the entry bundle (FLOW 41 in
 * `e2e/specs/14-cinematic-home.spec.js` enforces that invariant).
 *
 * QA INSTRUMENTATION: when mounted, publishes `window.__floraStage` — live
 * camera position / look-target / FOV / progress, a `project()` NDC projector
 * and a `hitAt()` raycast probe — for `e2e/specs/15-cinematic-stage.spec.js`.
 * A plain object with no UI; nothing customer-facing renders from it.
 */

/**
 * THE PLANES. `src` paths are verified to exist in the repository (the same
 * files `HomePage.jsx` already references). Positions are metres in a compact
 * corridor receding along −z; `yaw` is a few degrees of rotation so planes
 * read as a set hung in space rather than a flat stack.
 *
 * ASPECT IS MEASURED, NOT ASSUMED. Every one of these files is genuinely
 * LANDSCAPE (512×279, 512×286 or the square 512×512 — no EXIF rotation), so
 * each plane's `size` matches its photograph's true aspect. A portrait-sized
 * plane would stretch a landscape photograph ~3× vertically, which is exactly
 * the kind of distortion the "real photography only" rule forbids.
 */
export const PLANES = Object.freeze([
  { id: 'lavender', src: '/assets/images/flora-asset-05.jpg', pos: [0, 0, 0], size: [4.4, 2.4], yaw: 0.1, alt: 'A close view of a chenille lavender stem on natural linen' },
  { id: 'pressed-paper', src: '/assets/images/flora-asset-07.jpg', pos: [-3.2, 0.4, -2.4], size: [4.0, 2.18], yaw: 0.4, alt: 'A deckled card with pressed pansies beside a brass wax stamp' },
  { id: 'wrapped-posy', src: '/assets/images/flora-asset-03.jpg', pos: [3.0, -0.3, -3.6], size: [4.0, 2.23], yaw: -0.36, alt: 'A wrapped posy tied with silk and finished with a handwritten tag' },
  { id: 'gift-seal', src: '/assets/images/flora-asset-04.jpg', pos: [-1.6, 0.8, -6.0], size: [4.2, 2.29], yaw: 0.26, alt: 'A kraft gift box closed with a velvet ribbon and a wax seal' },
  { id: 'twine', src: '/assets/images/flora-asset-21.jpg', pos: [2.0, 0.2, -7.6], size: [3.8, 2.07], yaw: -0.22, alt: 'A bundle of dried botanicals tied with orange thread' },
  { id: 'posy-hands', src: '/assets/images/flora-asset-01.jpg', pos: [0.1, -0.3, -9.6], size: [3.2, 3.2], yaw: 0.08, alt: 'A finished posy held in two hands' },
]);

/** The five shots. Position/target in metres; `fov` in degrees. */
export const SHOTS = Object.freeze([
  { id: 'establish', pos: [0.3, 0.1, 4.6], target: [0, 0, 0], fov: 34 },
  { id: 'pull-back', pos: [1.6, 2.2, 9.0], target: [-0.5, 0.2, -3.0], fov: 40 },
  { id: 'lateral', pos: [-5.0, 0.8, 6.4], target: [1.8, 0.1, -4.6], fov: 38 },
  { id: 'three-quarter', pos: [5.2, 1.9, 4.0], target: [-1.4, 0.3, -7.2], fov: 36 },
  { id: 'pull-away', pos: [0.3, 2.4, 8.4], target: [0.1, -0.2, -7.0], fov: 46 },
]);

const STUDIO_LIGHT = Object.freeze({ bg: '#f6f3ee' });
const STUDIO_DARK = Object.freeze({ bg: '#26221e' });

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

function sampleFov(t) {
  const segments = SHOTS.length - 1;
  const scaled = clamp01(t) * segments;
  const i = Math.min(Math.floor(scaled), segments - 1);
  const f = scaled - i;
  return SHOTS[i].fov + (SHOTS[i + 1].fov - SHOTS[i].fov) * f;
}

/** The six photographic planes. Unlit, colour-exact, individually rotated. */
function PhotoPlanes({ ready }) {
  const maps = useTexture(PLANES.map((p) => p.src));

  // Colour-exactness: every map is tagged sRGB and given anisotropy so the
  // oblique three-quarter shots stay sharp. `useTexture` caches by URL, so we
  // configure but never mutate geometry or dispose the shared textures.
  useMemo(() => {
    maps.forEach((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.needsUpdate = true;
    });
  }, [maps]);

  // Report readiness once the real image bytes are decoded, so the browser
  // checks wait for PHOTOGRAPHY in the scene, not just a camera.
  useEffect(() => {
    ready.current = true;
    return () => {
      ready.current = false;
    };
  }, [ready]);

  return (
    <>
      {PLANES.map((plane, i) => (
        <mesh
          key={plane.id}
          name={`photo-plane-${String(i + 1).padStart(2, '0')}-${plane.id}`}
          position={plane.pos}
          rotation={[0, plane.yaw, 0]}
        >
          <planeGeometry args={plane.size} />
          {/* Unlit + not tone-mapped: the photograph's own colours survive. */}
          <meshBasicMaterial map={maps[i]} toneMapped={false} />
        </mesh>
      ))}
    </>
  );
}

/**
 * THE CAMERA DIRECTOR — the single, exclusive writer of the camera. It reads
 * the scroll progress `SceneStage` published, samples two CatmullRom curves
 * (position + look-target) and the FOV ramp, and damps the camera toward that
 * pose each frame. Because progress is a pure function of scroll and the pose
 * is a pure function of progress, scrolling back re-samples the same curve and
 * returns to the identical pose once the damping settles.
 */
function CameraDirector({ progressRef, bg, ready, qa }) {
  const { camera } = useThree();

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
        return Math.round(clamp01(progressRef.current ?? 0) * (SHOTS.length - 1));
      },
      get fov() {
        return camera.fov;
      },
      get ready() {
        return Boolean(ready.current);
      },
      get planeCount() {
        return PLANES.length;
      },
      get position() {
        return [camera.position.x, camera.position.y, camera.position.z];
      },
      get target() {
        return [scratch.look.x, scratch.look.y, scratch.look.z];
      },
      get bg() {
        return bg;
      },
      // World point → normalised device coordinates, through the LIVE camera.
      project(x, y, z) {
        camera.updateMatrixWorld();
        scratch.ndc.set(x, y, z).project(camera);
        return [scratch.ndc.x, scratch.ndc.y, scratch.ndc.z];
      },
      // First plane hit by a ray through an NDC point. Two different
      // viewpoints producing different hits is real occlusion between real
      // depth-separated planes — a flat image cannot do this.
      hitAt(ndcX, ndcY) {
        camera.updateMatrixWorld();
        scratch.ray.setFromCamera({ x: ndcX, y: ndcY }, camera);
        /* `intersectObjects` takes an ARRAY. Passing the Scene itself silently
           returns zero hits (it reads `.length`, gets undefined, iterates
           nothing) — which is exactly the bug that made the first occlusion
           check read `null` for every ray. */
        const hits = scratch.ray.intersectObjects(sceneRef.current?.children ?? [], true);
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
  }, [camera, progressRef, scratch, ready, bg]);

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

  return null;
}

// A module-scope ref so `hitAt` can reach the live scene graph without
// threading it through React props on every frame.
const sceneRef = { current: null };

function SceneGraph({ progressRef, bg, ready, qa }) {
  return (
    <>
      <CameraDirector progressRef={progressRef} bg={bg} ready={ready} qa={qa} />
      <PhotoPlanes ready={ready} />
    </>
  );
}

export default function PhotoPlaneStage({ progressRef }) {
  const { isDark } = useTheme();
  const ready = useRef(false);
  const qa = useRef({});

  const { bg, dpr, small } = useMemo(() => {
    const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
    const smallScreen = width < 768;
    return {
      bg: isDark ? STUDIO_DARK.bg : STUDIO_LIGHT.bg,
      dpr: Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, smallScreen ? 1.5 : 1.75),
      small: smallScreen,
    };
  }, [isDark]);

  return (
    <Canvas
      dpr={dpr}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      camera={{ position: SHOTS[0].pos, fov: SHOTS[0].fov, near: 0.05, far: 60 }}
      onCreated={({ gl, scene }) => {
        gl.toneMapping = THREE.NeutralToneMapping;
        gl.toneMappingExposure = 1.0;
        sceneRef.current = scene;
      }}
    >
      {/* The calm background is a CLEAR COLOUR, never geometry: it matches the
          page band behind the canvas in both themes, so the scene horizon
          dissolves into the photographic storefront at every camera angle. */}
      <color attach="background" args={[bg]} />
      {/* Fog only beyond the corridor (the farthest plane sits ~19 units from
          the closest camera), so far planes soften into the background without
          their colours washing out. */}
      <fog attach="fog" args={[bg, 22, 34]} />

      <SceneGraph progressRef={progressRef} bg={bg} ready={ready} qa={qa} />
    </Canvas>
  );
}
