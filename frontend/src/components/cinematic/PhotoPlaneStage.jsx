import React, { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { useTheme } from '../../context/ThemeContext.jsx';

/**
 * PHOTO-PLANE STAGE — the storefront's ONE dedicated WebGL surface, a genuine
 * camera travelling through REAL PHOTOGRAPHY.
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
 * COMPOSITION RULE (owner's correction of the first cut): at every beat the
 * frame is DOMINATED by one large photograph (≈55–70% of viewport width on a
 * 16:9 screen), never a small cluster of thumbnails in an empty field. The
 * shot table below was composed against the formulas in `planeScreen()`:
 * viewport fraction ≈ w·cos(angle to plane normal) / (2·distance·tan(fov/2)·aspect)
 * — and FLOW 50 in `e2e/specs/15-cinematic-stage.spec.js` measures the
 * frustum-clipped coverage of every beat in a real browser, so the numbers
 * here are checked, not claimed.
 *
 * HONESTY RULES ENFORCED IN THIS FILE:
 *  — Planes use `meshBasicMaterial` (unlit) with `toneMapped: false`, so the
 *    photographs' own colours reach the screen untouched. No white material
 *    may ever override product colour, and no lighting rig tints the imagery.
 *  — No ground plane, no model, no particles, no post-processing. The warm
 *    background is a gradient drawn behind the corridor on ONE clearly named
 *    backdrop plane (`stage-backdrop`) — never mistakable for a photo plane,
 *    never part of a GLB, and never a "white backdrop mesh" pretending to be
 *    the product. A flat clear colour was rejected by the owner because it
 *    read as an empty studio void; the gradient carries the same warm lamp
 *    falloff the photographs were actually shot under.
 *  — Exactly ONE writer of the camera: this file's `useFrame` director. GSAP
 *    only publishes a progress number (see `SceneStage.jsx`); React state and
 *    `useFrame` never both write camera transforms.
 *
 * LIFECYCLE: `SceneStage` imports this lazily and only near the viewport, so
 * three.js never reaches the HomePage chunk or the entry bundle (FLOW 41 in
 * `e2e/specs/14-cinematic-home.spec.js` enforces that invariant).
 *
 * QA INSTRUMENTATION: when mounted, publishes `window.__floraStage` — live
 * camera position / look-target / FOV / progress, a `project()` NDC projector,
 * a `hitAt()` raycast probe and a `planeScreen()` dominance probe — for
 * `e2e/specs/15-cinematic-stage.spec.js`. A plain object with no UI; nothing
 * customer-facing renders from it.
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
  { id: 'lavender', src: '/assets/images/flora-asset-05.jpg', pos: [0, 0, 0], size: [8.0, 4.36], yaw: 0.1, alt: 'A close view of a chenille lavender stem on natural linen' },
  { id: 'pressed-paper', src: '/assets/images/flora-asset-07.jpg', pos: [-4.6, 0.5, -15], size: [7.6, 4.14], yaw: 0.58, alt: 'A deckled card with pressed pansies beside a brass wax stamp' },
  { id: 'wrapped-posy', src: '/assets/images/flora-asset-03.jpg', pos: [4.6, -0.5, -21], size: [6.6, 3.69], yaw: -0.52, alt: 'A wrapped posy tied with silk and finished with a handwritten tag' },
  { id: 'gift-seal', src: '/assets/images/flora-asset-04.jpg', pos: [-5, 0.7, -31], size: [7.4, 4.03], yaw: 0.55, alt: 'A kraft gift box closed with a velvet ribbon and a wax seal' },
  { id: 'twine', src: '/assets/images/flora-asset-21.jpg', pos: [2, -1.8, -40], size: [6.6, 3.59], yaw: -0.22, alt: 'A bundle of dried botanicals tied with orange thread' },
  { id: 'posy-hands', src: '/assets/images/flora-asset-01.jpg', pos: [0, 0.4, -52], size: [7.0, 7.0], yaw: 0.04, alt: 'A finished posy held in two hands' },
]);

/**
 * The five shots. Position/target in metres; `fov` in degrees. Composed so
 * each beat is dominated by ONE photograph (see the composition rule above);
 * the measured coverage at the test viewport (1280×800, aspect 1.6) is in
 * FLOW 50's log:
 *   S1 lavender close   — ~69% of frame width
 *   S2 pull-back reveal — ~60%, composition visible
 *   S3 lateral track    — ~71% on the lavender plane, depth layers behind
 *   S4 push through     — ~55% on the gift box, re-aimed from the first cut
 *                         (the original target left it at the frame edge)
 *   S5 pull away        — ~52% on the closing posy, composed wide
 */
export const SHOTS = Object.freeze([
  { id: 'establish', pos: [-1.6, 0.35, 10.3], target: [0.4, 0, -0.5], fov: 34 },
  { id: 'pull-back', pos: [1.2, 1.9, 9.8], target: [-0.5, 0.2, -1.4], fov: 42 },
  { id: 'lateral', pos: [-3.8, 0.9, 7.0], target: [0.2, 0.1, -0.6], fov: 40 },
  { id: 'three-quarter', pos: [3.0, 1.1, -23], target: [-6.2, 0.9, -31.3], fov: 36 },
  { id: 'pull-away', pos: [0.8, 1.9, -43], target: [0, 0.4, -52], fov: 44 },
]);

const STUDIO_LIGHT = Object.freeze({ bg: '#f6f3ee' });
const STUDIO_DARK = Object.freeze({ bg: '#26221e' });

/**
 * ASPECT COMPENSATION. The shot table was composed at 16:9. On wider or
 * taller viewports a fixed distance would shrink the subject (the "small
 * cluster" failure the owner recorded on an ultrawide screen). Scaling the
 * camera's distance along its own view ray by (16:9 ÷ viewport aspect) keeps
 * every beat's subject fraction roughly constant at every shape of screen,
 * while preserving the exact look-target, view direction and FOV story.
 */
const ASPECT_REFERENCE = 16 / 9;
const fitScale = (aspect) => Math.min(1.75, Math.max(0.75, ASPECT_REFERENCE / aspect));

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

function sampleFov(t) {
  const segments = SHOTS.length - 1;
  const scaled = clamp01(t) * segments;
  const i = Math.min(Math.floor(scaled), segments - 1);
  const f = scaled - i;
  return SHOTS[i].fov + (SHOTS[i + 1].fov - SHOTS[i].fov) * f;
}

/**
 * THE WARM BACKDROP — one vertical gradient plus a lamp-falloff glow, baked
 * once into a small canvas texture. This is background ENVIRONMENT, drawn on
 * the single `stage-backdrop` plane far behind the corridor: it never enters
 * `PLANES`, is never reported as a photo plane, and is never mistakable for
 * the product. It carries the warm surface the page band uses (light: warm
 * paper falling to linen shadow; dark: espresso falling to near-black) so the
 * scene horizon dissolves into the storefront at every camera angle.
 */
function makeBackdropTexture(dark) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  if (dark) {
    gradient.addColorStop(0, '#2b241d');
    gradient.addColorStop(0.55, '#211b16');
    gradient.addColorStop(1, '#14100c');
  } else {
    gradient.addColorStop(0, '#f8f3e9');
    gradient.addColorStop(0.55, '#f2e9da');
    gradient.addColorStop(1, '#e5d9c4');
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 256);

  // The same warm lamp the photography was shot under, low and to the left.
  const glow = ctx.createRadialGradient(40, 96, 0, 40, 96, 230);
  glow.addColorStop(0, dark ? 'rgba(126, 90, 54, 0.30)' : 'rgba(255, 219, 172, 0.55)');
  glow.addColorStop(1, dark ? 'rgba(0, 0, 0, 0)' : 'rgba(255, 219, 172, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 128, 256);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
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
 * (position + look-target) and the FOV ramp, applies the aspect-fit distance
 * scale, and damps the camera toward that pose each frame. Because progress
 * is a pure function of scroll and the pose is a pure function of progress,
 * scrolling back re-samples the same curve and returns to the identical pose
 * once the damping settles.
 */
function CameraDirector({ progressRef, bg, backdrop, ready }) {
  const { camera, size } = useThree();

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
      // Screen presence of every photo plane, measured through the live
      // camera: projected width as a FRACTION OF THE VIEWPORT (clipped to
      // the actual frustum, so it is honest coverage — 1.0 means the plane
      // fills the frame), a screen-space centre, and whether the plane
      // projects to nothing at all (behind the camera or outside the frame).
      // The quad is clipped as a POLYGON in clip space (Sutherland–Hodgman
      // against all six frustum planes) before projection — corner-only
      // projection reports mirrored garbage when a plane straddles the near
      // plane, which is exactly what happened beside the camera on shot four.
      // The backdrop plane is excluded by construction — it is not in PLANES.
      planeScreen() {
        camera.updateMatrixWorld();
        const clip = (poly) => {
          // Homogeneous clip distances: x+w, w-x, y+w, w-y, z+w, w-z.
          const tests = [
            (v) => v.x + v.w,
            (v) => v.w - v.x,
            (v) => v.y + v.w,
            (v) => v.w - v.y,
            (v) => v.z + v.w,
            (v) => v.w - v.z,
          ];
          let out = poly;
          for (const dist of tests) {
            const next = [];
            for (let i = 0; i < out.length; i += 1) {
              const a = out[i];
              const b = out[(i + 1) % out.length];
              const da = dist(a);
              const db = dist(b);
              if (da >= 0) next.push(a);
              if (da >= 0 !== db >= 0) {
                const t = da / (da - db);
                next.push({
                  x: a.x + (b.x - a.x) * t,
                  y: a.y + (b.y - a.y) * t,
                  z: a.z + (b.z - a.z) * t,
                  w: a.w + (b.w - a.w) * t,
                });
              }
            }
            out = next;
            if (out.length === 0) return out;
          }
          return out;
        };
        return PLANES.map((plane, index) => {
          const [w, h] = plane.size;
          const cos = Math.cos(plane.yaw);
          const sin = Math.sin(plane.yaw);
          // Perimeter order (not row order!) — Sutherland–Hodgman needs a
          // simple polygon; a Z-ordered quad is a bowtie and clips garbage.
          const world = [
            [-0.5, -0.5],
            [0.5, -0.5],
            [0.5, 0.5],
            [-0.5, 0.5],
          ].map(([sx, sy]) => {
            const lx = sx * w;
            const ly = sy * h;
            return new THREE.Vector3(
              plane.pos[0] + lx * cos,
              plane.pos[1] + ly,
              plane.pos[2] - lx * sin
            );
          });
          const clipPoly = clip(
            world.map((v) => {
              /* Vector4, NOT Vector3: Vector3.applyMatrix4 perspective-divides
                 and DISCARDS w, which would make every homogeneous clip
                 distance undefined. Vector4 transforms without dividing. */
              const c = new THREE.Vector4(v.x, v.y, v.z, 1)
                .applyMatrix4(camera.matrixWorldInverse)
                .applyMatrix4(camera.projectionMatrix);
              return { x: c.x, y: c.y, z: c.z, w: c.w };
            })
          );
          if (clipPoly.length === 0) {
            return {
              id: plane.id,
              name: `photo-plane-${String(index + 1).padStart(2, '0')}-${plane.id}`,
              width: 0,
              center: null,
              behind: true,
            };
          }
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          for (const v of clipPoly) {
            const x = v.x / v.w;
            const y = v.y / v.w;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
          return {
            id: plane.id,
            name: `photo-plane-${String(index + 1).padStart(2, '0')}-${plane.id}`,
            // Clipped against the frustum → NDC spans are inside [-1, 1],
            // so this is viewport coverage: [0, 1].
            width: (maxX - minX) / 2,
            center: [(minX + maxX) / 2, (minY + maxY) / 2],
            behind: false,
          };
        });
      },
    };
    window.__floraStage = handle;
    return () => {
      if (window.__floraStage === handle) delete window.__floraStage;
    };
  }, [camera, progressRef, scratch, ready, bg, backdrop]);

  useFrame((state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05); // clamp tab-hidden spikes
    const t = clamp01(progressRef.current ?? 0);

    curves.pos.getPoint(t, scratch.pos);
    curves.target.getPoint(t, scratch.target);

    // Aspect fit: slide the camera along its own view ray so the subject
    // fraction stays composed at every viewport shape (see ASPECT
    // COMPENSATION above). The look-target is untouched, so the view
    // direction and the whole shot story are preserved exactly.
    const fit = fitScale(state.size.width / Math.max(1, state.size.height));
    if (fit !== 1) scratch.pos.sub(scratch.target).multiplyScalar(fit).add(scratch.target);

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

function SceneGraph({ progressRef, bg, backdrop, ready }) {
  return (
    <>
      <CameraDirector progressRef={progressRef} bg={bg} backdrop={backdrop} ready={ready} />
      <PhotoPlanes ready={ready} />
      {/* THE BACKDROP — one warm gradient plane far behind the corridor,
          clearly named, never a photo plane, never mistakable for the
          product. It is the scene's environment, like the wall of the
          workshop behind the bench. */}
      <mesh name="stage-backdrop" position={[0, 0, -64]}>
        <planeGeometry args={[240, 130]} />
        <meshBasicMaterial map={backdrop} toneMapped={false} />
      </mesh>
    </>
  );
}

export default function PhotoPlaneStage({ progressRef }) {
  const { isDark } = useTheme();
  const ready = useRef(false);
  const qa = useRef({});

  const { bg, dpr } = useMemo(() => {
    const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
    const smallScreen = width < 768;
    return {
      bg: isDark ? STUDIO_DARK.bg : STUDIO_LIGHT.bg,
      dpr: Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, smallScreen ? 1.5 : 1.75),
    };
  }, [isDark]);

  const backdrop = useMemo(() => makeBackdropTexture(isDark), [isDark]);
  useEffect(() => () => backdrop.dispose(), [backdrop]);

  return (
    <Canvas
      dpr={dpr}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      camera={{ position: SHOTS[0].pos, fov: SHOTS[0].fov, near: 0.05, far: 120 }}
      onCreated={({ gl, scene }) => {
        gl.toneMapping = THREE.NeutralToneMapping;
        gl.toneMappingExposure = 1.0;
        sceneRef.current = scene;
      }}
    >
      {/* Base clear colour matches the page band in both themes; the backdrop
          plane covers the frustum in front of it, so the gradient is what the
          visitor sees and the clear colour only catches extreme edges. */}
      <color attach="background" args={[bg]} />
      {/* Deliberately NO fog: fog would fade the photographs' own colours at
          distance, and colour fidelity is one of this file's rules. Depth is
          carried by parallax, occlusion and the warm backdrop. */}

      <SceneGraph progressRef={progressRef} bg={bg} backdrop={backdrop} ready={ready} />
    </Canvas>
  );
}
