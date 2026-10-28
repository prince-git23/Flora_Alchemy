import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Cuboid, ImageOff, Loader2, RotateCcw, RefreshCw } from 'lucide-react';

/**
 * ThreeGlbPreview — a real, interactive 3D preview of a generated GLB.
 *
 * WHAT IT IS. A lazy-loaded three.js viewport with orbit (drag to rotate), zoom
 * (scroll / pinch), a programmatic reset, and four honest states: loading,
 * ready, error, empty. It renders whatever bytes it is given, and NOTHING ELSE —
 * there is no fallback mesh, no placeholder cube pretending to be a model, and
 * no procedural stand-in. If no model exists, it says so.
 *
 * WHY IT TAKES A LOADER AND NOT A URL. Generated models are PRIVATE: they are
 * served only through an authenticated route, and neither this component nor
 * three.js' GLTFLoader can attach a bearer token to a loader-initiated request.
 * So the bytes are fetched by `threeGlbService` (which owns the token lookup) and
 * this component is handed an async `loadModel()`. That keeps transport out of
 * the render path, makes the component testable without a server, and is why
 * the object URL is revoked here — the loader owns the lifetime of what it
 * creates.
 *
 * LAZY BY CONSTRUCTION. `three` and the GLTF loader are pulled in with dynamic
 * `import()` inside the mount effect, so the library lives in its own chunk and
 * the portal's initial bundle does not carry ~600 KB of renderer for a screen
 * most visits never open.
 *
 * PROPS
 *   loadModel    — async () => { url, revoke }. MUST be referentially stable
 *                  (wrap in useCallback); changing it re-initialises the view.
 *   hasModel     — false renders the empty state without calling loadModel.
 *   fallbackUrl  — optional image (e.g. the reference thumbnail) for the empty
 *                  and error states.
 *   reloadKey    — change this number to force a re-load (the "Try again" path
 *                  uses it, so a failed fetch can be retried without a remount).
 *   onModelError — notified with the Error so a parent can log/report it.
 *   previewHeight — a pixel height (380 by default). Pass `null` to let the
 *                  CONTAINER decide instead, which is how the storefront mounts
 *                  it inside the product gallery's aspect-ratio box: a fixed
 *                  pixel height would break the page's responsive layout.
 *   orientationYaw — PHASE 9: a whole number of 90-degree Y turns the staff
 *                  recorded for this asset (the canonical-YAW correction). It
 *                  is applied ONCE, to the container group that wraps the
 *                  loaded scene — never accumulated, never written to bytes.
 *                  The camera framing reads the resulting world box, so a yaw
 *                  change re-frames the model instead of cropping it.
 *   background    — optional CSS background for the viewport, separate from
 *                  the GLB (the model never carries a backdrop). Defaults to
 *                  the brand-neutral surface token.
 *   diagnostics   — staff-only extras: a wireframe toggle and scene-fact data
 *                  attributes (mesh/material counts, vertex-colour presence).
 *                  Rendering aids only — the same bytes, never a proxy mesh.
 */

/** The whole preview, kept off the critical path until the effect runs. */
let threeModule = null;
let gltfLoaderClass = null;
let orbitControlsClass = null;
let roomEnvironmentClass = null;

/**
 * Older generated models were exported WITHOUT a material (the engine wrote
 * vertex colour only). glTF's fallback for a missing material is a fully
 * METALLIC rough surface, and a metal with no environment has no diffuse term,
 * so those assets rendered dark no matter how good their colour data was.
 *
 * This repairs the LOOK for legacy bytes at render time: it makes such a
 * material dielectric so the stored colour becomes albedo again. It never
 * touches an asset that declares its own material, and it never invents colour
 * — it only stops the viewer from suppressing colour that is already there.
 */
function makeLegacyMaterialVisible(three, gltf, root) {
  const declared = gltf?.parser?.json?.materials;
  // Only act when we can PROVE the file declares no material. If the parser
  // shape ever changes, we do nothing rather than guess over a real material.
  if (!Array.isArray(declared) || declared.length > 0) return 0;

  let repaired = 0;
  root.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const list = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of list) {
      if (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial) continue;
      if (material.metalness === 1 && material.roughness >= 0.99) {
        material.metalness = 0;
        material.roughness = 0.6;
        material.color.set(0xffffff);
        material.vertexColors = true;
        material.needsUpdate = true;
        repaired += 1;
      }
    }
  });
  return repaired;
}

async function ensureThree() {
  if (threeModule && gltfLoaderClass && orbitControlsClass) {
    return { three: threeModule, GLTFLoader: gltfLoaderClass, OrbitControls: orbitControlsClass };
  }
  const [three, loaderMod, controlsMod, envMod] = await Promise.all([
    import('three'),
    import('three/addons/loaders/GLTFLoader.js'),
    // OrbitControls is an ADDON, not part of the three namespace: `three.OrbitControls`
    // does not exist, and reaching for it is the classic way to make a viewer that
    // always lands in its error state.
    import('three/addons/controls/OrbitControls.js'),
    // A neutral studio environment. Without one, a PBR material that is even
    // slightly metallic has nothing to reflect and renders dark — which is
    // exactly how a colourful bouquet used to show up as a black shape.
    import('three/addons/environments/RoomEnvironment.js'),
  ]);
  threeModule = three;
  gltfLoaderClass = loaderMod.GLTFLoader;
  orbitControlsClass = controlsMod.OrbitControls;
  roomEnvironmentClass = envMod.RoomEnvironment;
  return {
    three: threeModule,
    GLTFLoader: gltfLoaderClass,
    OrbitControls: orbitControlsClass,
    RoomEnvironment: roomEnvironmentClass,
  };
}

/** Release GPU resources for a subtree — three.js does not do this for you. */
function disposeObject(three, root) {
  if (!root || !three) return;
  root.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    const material = node.material;
    if (!material) return;
    const list = Array.isArray(material) ? material : [material];
    list.forEach((mat) => {
      Object.values(mat).forEach((value) => {
        if (value && value.isTexture) value.dispose();
      });
      mat.dispose();
    });
  });
}

/**
 * PHASE 9 — the named review presets, as camera DIRECTIONS from the model's
 * bounding-box centre. The up-vector stays the scene's canonical +Y for every
 * pose (the camera looks along `dir`, so a pure ±X/±Z direction keeps a world
 * up that is not parallel to the view, and `top` carries a 1-degree tilt for
 * the same reason). Each pose distances the camera by the fitted bounding-
 * sphere radius, so EVERY preset frames the COMPLETE model — a sideways view
 * can never be cropped into lying about the silhouette.
 */
const POSES = {
  'three-quarter': [0.62, 0.46, 0.65],
  front: [0, 0.04, 1],
  left: [-1, 0.04, 0],
  right: [1, 0.04, 0],
  back: [0, 0.04, -1],
  top: [0, 1, 0.02],
  bottom: [0, -1, 0.02],
};

/* ── The load, as named stages ────────────────────────────────────────────────
 *
 * A viewer that only knows `loading` cannot say anything useful while it waits,
 * and — worse — has no way to notice that it is waiting for something that will
 * never arrive. The load is therefore a small, explicit machine:
 *
 *   initialising → downloading → validating → parsing → geometry → framing → ready
 *
 * Every one of those stages can end in `error`, and ONE hard deadline covers the
 * whole run: if the sequence has not reached `ready` when the deadline passes,
 * the viewer reports which stage it was stuck in and offers Retry. That is the
 * difference between "still working" and "hung forever" — the bytes being slow
 * is a legitimate wait, a promise that never settles is not.
 *
 * `empty` is decided BEFORE any of this (no model / no usable candidate), and
 * the bytes are fetched ONCE, by the service, with its own AbortController.
 */
const STAGE_ORDER = ['initialising', 'downloading', 'validating', 'parsing', 'geometry', 'framing', 'ready'];

/** Staff-facing wording per stage. The customer sees the generic line instead. */
const STAGE_LABELS = {
  initialising: 'Starting the viewer…',
  downloading: 'Downloading the model…',
  validating: 'Checking the model file…',
  parsing: 'Parsing the model…',
  geometry: 'Preparing geometry and materials…',
  framing: 'Framing the view…',
  ready: 'Ready',
};

/**
 * Hard stop for the WHOLE load — three.js chunk, bytes, parse, traversal and
 * framing. 180 s is a deliberate ceiling for a real machine (a large GLB over a
 * slow link plus a first-time parser), not a performance target: it exists so a
 * load that will never finish always ends in a stated error. The browser suite
 * shortens the two bounds through the E2E build.
 */
const LOAD_DEADLINE_MS = (() => {
  try {
    const raw = Number(import.meta.env?.VITE_GLB_LOAD_DEADLINE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
  } catch {
    return 180_000;
  }
})();

export default function ThreeGlbPreview({
  loadModel,
  /** Identity of the bytes this viewer should be showing (the asset id). A
   *  CHANGE re-runs the load — without it, switching to another candidate kept
   *  the previous model on screen because only `hasModel`/`reloadKey` were
   *  dependencies and the loader itself lives in a ref. */
  assetKey = '',
  hasModel = true,
  fallbackUrl = '',
  reloadKey = 0,
  onModelError,
  orientationYaw = 0,
  className = '',
  previewHeight = 380,
  label = '3D model preview',
  background = '',
  diagnostics = false,
}) {
  const containerRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const modelRef = useRef(null);
  const extrasRef = useRef(null);
  const [state, setState] = useState(hasModel ? 'loading' : 'empty');
  const [errorMessage, setErrorMessage] = useState('');
  const [localReload, setLocalReload] = useState(0);
  /** Which stage of the load is current — shown to staff while waiting and
   *  recorded on the error, so "it hung" becomes "it hung while downloading". */
  const [stage, setStage] = useState(hasModel ? 'initialising' : 'empty');
  /** Wall-clock milliseconds from the start of the load to `ready`. Measured,
   *  never estimated: a 200 with no bytes is not progress. */
  const [loadMs, setLoadMs] = useState(null);
  /** Facts measured from the LOADED scene (not the API): exposed as data
   *  attributes so tests and staff can verify colour/geometry delivery without
   *  a debug overlay customers would see. */
  const [sceneFacts, setSceneFacts] = useState(null);
  const [wireframe, setWireframe] = useState(false);
  const wireframeRef = useRef(false);
  /** PHASE 9 — which named preset the camera is holding, so a yaw change can
   *  re-apply the SAME view after the model turns under it. */
  const [activePose, setActivePose] = useState('three-quarter');
  const activePoseRef = useRef('three-quarter');
  // Latest-value refs: the load effect must not re-run (and refetch the bytes)
  // when only the yaw prop changes, and a mid-load yaw change must be read from
  // the newest value rather than the closure that started the load.
  const orientationYawRef = useRef(orientationYaw);
  orientationYawRef.current = orientationYaw;

  // Keep the newest callback without making it an effect dependency: a parent
  // that forgets useCallback would otherwise rebuild the whole scene each render.
  const loadModelRef = useRef(loadModel);
  const onErrorRef = useRef(onModelError);
  useEffect(() => {
    loadModelRef.current = loadModel;
    onErrorRef.current = onModelError;
  }, [loadModel, onModelError]);

  /** Move the camera onto a preset DIRECTION of the model's world box and fit
   *  the complete model. Every preset shares the same up vector (the scene's
   *  +Y) and the same fit, so no view can be cropped into lying about the
   *  silhouette, and `front` after a yaw correction IS the reference view. */
  const applyPoseTo = useCallback((three, object, camera, controls, poseName) => {
    const box = new three.Box3().setFromObject(object);
    const size = box.getSize(new three.Vector3());
    const center = box.getCenter(new three.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(maxDim) || maxDim <= 0.0001) return;
    // FIT THE OBJECT, DON'T PARK THE CAMERA IN THE NEXT ROOM. Fit the bounding
    // sphere inside the tighter of the two frustum angles, with a small margin,
    // so the product fills the viewport at every aspect ratio.
    const fovV = (camera.fov * Math.PI) / 180;
    const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1;
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);
    const fitAngle = Math.min(fovV, fovH);
    const distance = (maxDim / 2 / Math.sin(fitAngle / 2)) * 1.15;
    const raw = POSES[poseName] || POSES['three-quarter'];
    const norm = Math.hypot(raw[0], raw[1], raw[2]) || 1;
    camera.position.set(
      center.x + (raw[0] / norm) * distance,
      center.y + (raw[1] / norm) * distance,
      center.z + (raw[2] / norm) * distance
    );
    camera.near = Math.max(maxDim / 100, 0.01);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
  }, []);

  /** Hold a named preset in the viewport (staff preset bar + yaw re-framing). */
  const applyPose = useCallback(
    (poseName) => {
      const three = threeModule;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      const model = modelRef.current;
      if (!three || !camera || !controls || !model) return;
      applyPoseTo(three, model, camera, controls, poseName);
      activePoseRef.current = poseName;
      setActivePose(poseName);
    },
    [applyPoseTo]
  );

  // DEFAULT VIEW IS THREE-QUARTER: slightly above and to the right of the
  // object, never dead-on. A frontal default makes a shallow model read as a
  // paper cutout and hides the depth a reconstruction DID infer; the diagonal
  // shows front + side + top facets at once, and Reset returns here too.
  const frame = useCallback(
    (three, object, camera, controls) => {
      applyPoseTo(three, object, camera, controls, 'three-quarter');
      activePoseRef.current = 'three-quarter';
      setActivePose('three-quarter');
    },
    [applyPoseTo]
  );

  /** Rendering-aid wireframe: materials are switched, the BYTES are not. */
  const applyWireframe = useCallback((enabled) => {
    const model = modelRef.current;
    if (!model) return;
    model.traverse((node) => {
      const list = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of list) {
        if (!material) continue;
        material.wireframe = enabled;
        material.needsUpdate = true;
      }
    });
  }, []);

  const toggleWireframe = useCallback(() => {
    setWireframe((previous) => {
      const next = !previous;
      wireframeRef.current = next;
      applyWireframe(next);
      return next;
    });
  }, [applyWireframe]);

  /** Put the camera back where the model was first framed. */
  const resetView = useCallback(() => {
    const three = threeModule;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!three || !camera || !controls) return;
    const model = modelRef.current;
    if (model) {
      frame(three, model, camera, controls);
      return;
    }
    camera.position.set(0, 0.6, 4);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
  }, [frame]);

  useEffect(() => {
    if (!hasModel) {
      setState('empty');
      setErrorMessage('');
      setStage('empty');
      setLoadMs(null);
      return undefined;
    }

    let cancelled = false;
    let animationFrame = null;
    let objectUrl = '';
    let revokeUrl = null;
    let renderer = null;
    let controls = null;
    let loadedModel = null;
    let resizeHandler = null;
    let deadlineTimer = null;
    /* The stage this load has actually reached, in a plain local so the
       deadline and the error path can name it without reading stale state. */
    let currentStage = 'initialising';
    const startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const elapsed = () =>
      Math.round((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startedAt);

    setState('loading');
    setErrorMessage('');
    setStage('initialising');
    setLoadMs(null);

    const markStage = (name) => {
      if (cancelled) return;
      currentStage = name;
      setStage(name);
    };

    const clearDeadline = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };

    const failWith = (err) => {
      if (cancelled) return;
      clearDeadline();
      const error = err instanceof Error ? err : new Error(String(err));
      // The stage the load died in travels WITH the error: it is the difference
      // between "the model is broken" and "the bytes never arrived".
      if (!error.stage) error.stage = currentStage;
      setState('error');
      setStage(currentStage);
      setErrorMessage(error.message || 'The 3D model could not be loaded.');
      if (onErrorRef.current) onErrorRef.current(error);
    };

    const teardown = () => {
      clearDeadline();
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = null;
      if (controls) {
        controls.dispose();
        controls = null;
      }
      const three = threeModule;
      if (three) {
        if (loadedModel) disposeObject(three, loadedModel);
        if (extrasRef.current) disposeObject(three, extrasRef.current);
      }
      loadedModel = null;
      if (renderer) {
        renderer.dispose();
        const canvas = renderer.domElement;
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        renderer = null;
      }
      if (revokeUrl) revokeUrl();
      else if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = '';
      revokeUrl = null;
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      modelRef.current = null;
      extrasRef.current = null;
    };

    /* THE HARD STOP. Armed before anything awaits, so no single await — the
       three.js chunk, the bytes, the parser, the traversal — can hold this
       viewer in `loading` past the deadline. It is a watchdog, not a progress
       bar: nothing about the UI pretends to know how far along the load is. */
    deadlineTimer = setTimeout(() => {
      const stuckIn = STAGE_LABELS[currentStage] || currentStage;
      const err = new Error(
        `The model did not finish loading within ${Math.round(LOAD_DEADLINE_MS / 1000)} seconds (stuck at: ${stuckIn.replace(/…$/, '')}). Try again.`
      );
      err.code = 'TIME_LIMIT';
      failWith(err);
    }, LOAD_DEADLINE_MS);

    const container = containerRef.current;
    if (!container) {
      // A missing host is a real failure, and it must not be silent: returning
      // here used to leave the viewport in `loading` with nothing to click.
      failWith(new Error('The 3D preview area was not ready. Switch to another tab and back, then try again.'));
      return teardown;
    }

    (async () => {
      try {
        markStage('initialising');
        const { three, GLTFLoader, OrbitControls } = await ensureThree();
        if (cancelled) return;

        // ── Scene, camera, renderer ────────────────────────────────────────
        const width = container.clientWidth || 480;
        const height = container.clientHeight || previewHeight || 380;

        const scene = new three.Scene();
        sceneRef.current = scene;

        const camera = new three.PerspectiveCamera(45, width / height, 0.05, 200);
        camera.position.set(0, 0.6, 4);
        cameraRef.current = camera;

        renderer = new three.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height, false);
        // Colour fidelity: Khronos' PBR Neutral tone mapping keeps hue and
        // saturation intact across the mid-tones, which is what a product
        // viewer needs — ACES desaturates pastel petals and darkens whites.
        // Falls back to ACES on a three build that predates it.
        renderer.toneMapping = three.NeutralToneMapping ?? three.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
        renderer.outputColorSpace = three.SRGBColorSpace;
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.touchAction = 'none';
        container.appendChild(renderer.domElement);

        // ── Lighting: a neutral studio — soft key + fill + rim over a bright,
        //    even environment. The environment is what makes metal and shadow
        //    readable; the directionals shape the form. Nothing here is meant to
        //    brighten a broken material into looking correct: the environment is
        //    neutral by design so two candidates can be compared fairly.
        const pmrem = new three.PMREMGenerator(renderer);
        const environment = pmrem.fromScene(new roomEnvironmentClass(), 0.04);
        scene.environment = environment.texture;
        if ('environmentIntensity' in scene) scene.environmentIntensity = 1.0;
        pmrem.dispose();

        scene.add(new three.AmbientLight(0xffffff, 0.25));
        const key = new three.DirectionalLight(0xffffff, 1.4);
        key.position.set(3, 6, 4);
        scene.add(key);
        const fill = new three.DirectionalLight(0xdfe6ef, 0.6);
        fill.position.set(-4, 2, 3);
        scene.add(fill);
        const rim = new three.DirectionalLight(0xffffff, 0.4);
        rim.position.set(-1, 2, -5);
        scene.add(rim);

        const extras = new three.Group();
        scene.add(extras);
        extrasRef.current = extras;

        // ── Orbit controls: rotate + zoom + optional pan ───────────────────
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.rotateSpeed = 0.85;
        controls.zoomSpeed = 1.1;
        controls.enablePan = true;
        controls.minDistance = 0.2;
        controls.maxDistance = 60;
        controls.target.set(0, 0, 0);
        controls.update();
        controlsRef.current = controls;

        const animate = () => {
          if (cancelled) return;
          controls.update();
          renderer.render(scene, camera);
          animationFrame = requestAnimationFrame(animate);
        };
        animate();

        resizeHandler = () => {
          if (cancelled) return;
          const rect = container.getBoundingClientRect();
          const w = Math.max(rect.width, 1);
          const h = Math.max(rect.height, 1);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h, false);
        };
        window.addEventListener('resize', resizeHandler);

        // ── Bytes, then the model ─────────────────────────────────────────
        if (typeof loadModelRef.current !== 'function') {
          failWith(new Error('This preview was mounted without a model loader.'));
          return;
        }

        markStage('downloading');
        const loaded = await loadModelRef.current();
        if (cancelled) {
          if (loaded?.revoke) loaded.revoke();
          return;
        }
        markStage('validating');
        if (!loaded?.url) {
          failWith(new Error('The model file could not be located.'));
          return;
        }
        if (Number.isFinite(loaded.bytes) && loaded.bytes <= 0) {
          failWith(new Error('The model file came back empty. Regenerate the candidate or try again.'));
          return;
        }
        objectUrl = loaded.url;
        revokeUrl = loaded.revoke || null;

        markStage('parsing');
        const loader = new GLTFLoader();
        loader.load(
          objectUrl,
          (gltf) => {
            // A callback that arrives after this load was cancelled or replaced
            // is STALE: dispose what it built and never touch the live state.
            if (cancelled) {
              try {
                disposeObject(threeModule, gltf.scene);
              } catch {
                /* a scene that cannot be disposed is already gone */
              }
              return;
            }
            /* Everything below can throw (degenerate geometry, a NaN bound, a
               hostile material), and a throw inside a loader callback used to
               be invisible here. It now ends in `error` with the stage named. */
            try {
            markStage('geometry');
            loadedModel = gltf.scene;
            modelRef.current = loadedModel;

            // Normalise scale/position so a model authored in millimetres and one
            // authored in metres both land in a sensible view volume.
            const box = new three.Box3().setFromObject(loadedModel);
            const size = box.getSize(new three.Vector3());
            const center = box.getCenter(new three.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            if (Number.isFinite(maxDim) && maxDim > 0.0001) {
              const scale = 1.6 / maxDim;
              loadedModel.scale.setScalar(scale);
              loadedModel.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
            }

            // Legacy material-less assets need their colour un-suppressed; see
            // `makeLegacyMaterialVisible` for why this is a rendering fix and
            // not a claim that the asset is well-formed.
            makeLegacyMaterialVisible(three, gltf, loadedModel);

            let meshCount = 0;
            let materialCount = 0;
            let hasVertexColors = false;
            loadedModel.traverse((node) => {
              if (node.isMesh || node.isPoints || node.isLine) {
                meshCount += 1;
                // Colour delivery facts, read from THIS loaded scene: the
                // geometry's colour attribute and the material's own vertex
                // colour use. A white-material override would show up as a
                // coloured GLB reporting vertexColors=false here.
                if (node.geometry?.getAttribute?.('color')) hasVertexColors = true;
                const list = Array.isArray(node.material) ? node.material : [node.material];
                for (const material of list) {
                  if (!material) continue;
                  materialCount += 1;
                  if (material.vertexColors) hasVertexColors = true;
                }
              }
            });
            setSceneFacts({ meshCount, materialCount, hasVertexColors });
            if (wireframeRef.current) applyWireframe(true);

            // A GLB that parses but draws nothing is not a previewable model; the
            // server's validator already refuses these, so seeing one here means
            // the bytes are not what the asset row recorded.
            if (meshCount === 0) {
              failWith(new Error('This model contains no drawable geometry.'));
              return;
            }
            markStage('framing');

            // PHASE 9 — the staff-recorded canonical yaw, applied ONCE to the
            // container group that wraps this scene: never to the scene's own
            // nodes, never accumulated (yaw 4 ≡ yaw 0), and never written into
            // the bytes. The framing below reads the resulting WORLD box, so a
            // turned model is re-framed rather than cropped.
            extras.rotation.y =
              ((((Number(orientationYawRef.current) || 0) % 4) + 4) % 4) * (Math.PI / 2);
            extras.updateMatrixWorld(true);

            extras.add(loadedModel);
            frame(three, loadedModel, camera, controls);
            if (cancelled) return;
            clearDeadline();
            markStage('ready');
            setLoadMs(elapsed());
            setState('ready');
            } catch (err) {
              failWith(
                err instanceof Error
                  ? err
                  : new Error('The model was parsed but could not be prepared for display.')
              );
            }
          },
          undefined,
          (err) => {
            failWith(
              err instanceof Error && err.message
                ? err
                : new Error('The model file could not be parsed as a GLB.')
            );
          }
        );
      } catch (err) {
        failWith(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return () => {
      cancelled = true;
      teardown();
    };
    // `assetKey` is in the list because the LOADER lives in a ref: without it a
    // different candidate (same `hasModel`, same `reloadKey`) would keep the
    // previous model on screen while the panel said otherwise.
    // `previewHeight` participates only through the initial size; the resize
    // handler keeps the canvas matched to the container afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetKey, hasModel, reloadKey, localReload, frame, previewHeight]);

  /** PHASE 9 — a live yaw change turns the model under the camera and re-applies
   *  the CURRENT preset, so the reviewer keeps the same named view (framed to
   *  the whole model) instead of losing it to the rotation. */
  useEffect(() => {
    const extras = extrasRef.current;
    if (!extras) return;
    extras.rotation.y = ((((Number(orientationYaw) || 0) % 4) + 4) % 4) * (Math.PI / 2);
    extras.updateMatrixWorld(true);
    if (modelRef.current) applyPose(activePoseRef.current);
  }, [orientationYaw, applyPose]);

  /** The staff preset bar: one button per view, pressed = the held pose. */
  const poseButtons = diagnostics
    ? Object.keys(POSES).map((name) => ({
        name,
        label: name === 'three-quarter' ? '3/4' : name.charAt(0).toUpperCase() + name.slice(1),
      }))
    : [];

  const retry = useCallback(() => setLocalReload((n) => n + 1), []);

  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] ${className}`}
      /* `null` = the container owns the height (the storefront gallery box). */
      style={{
        ...(previewHeight ? { height: previewHeight } : {}),
        ...(background ? { background } : {}),
      }}
      data-testid="glb-preview"
      data-state={state}
      data-stage={stage}
      data-load-ms={loadMs === null ? '' : String(loadMs)}
      data-pose={state === 'ready' ? activePose : ''}
      data-orientation-yaw={String(orientationYaw || 0)}
      data-vertex-colors={sceneFacts ? String(sceneFacts.hasVertexColors) : ''}
      data-material-count={sceneFacts ? String(sceneFacts.materialCount) : ''}
      data-mesh-count={sceneFacts ? String(sceneFacts.meshCount) : ''}
    >
      {/* The WebGL canvas is appended here by the effect. */}
      <div ref={containerRef} className="absolute inset-0" role="img" aria-label={label} />

      {state === 'loading' && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-surface-low)]"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="w-7 h-7 animate-spin text-[var(--color-botanical-muted)]" aria-hidden="true" />
          {/* STAFF see the real stage; a customer gets one honest line. No
              percentage is invented here — the fetch reports stages, not
              bytes, so anything finer would be fiction. */}
          <p className="text-xs text-[var(--color-botanical-subtle)]" data-testid="glb-preview-stage">
            {diagnostics ? STAGE_LABELS[stage] || STAGE_LABELS.initialising : 'Loading the 3D model…'}
          </p>
          {diagnostics && (
            <p className="text-[10px] text-[var(--color-botanical-subtle)]/70" aria-hidden="true">
              Stage {Math.max(STAGE_ORDER.indexOf(stage), 0) + 1} of {STAGE_ORDER.length - 1}
            </p>
          )}
        </div>
      )}

      {state === 'empty' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-surface-low)] px-6 text-center">
          {fallbackUrl ? (
            <img
              src={fallbackUrl}
              alt="Reference for the product"
              className="max-h-[190px] w-auto rounded-lg border border-[var(--color-botanical-border)] object-contain"
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <Cuboid className="w-8 h-8 opacity-50 text-[var(--color-botanical-subtle)]" aria-hidden="true" />
          )}
          <p className="text-sm text-[var(--color-botanical-subtle)]">
            No 3D model has been approved for this product yet.
          </p>
        </div>
      )}

      {state === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-surface-low)] px-6 text-center">
          <AlertCircle className="w-8 h-8 text-red-600 dark:text-red-400" aria-hidden="true" />
          <p className="text-sm text-red-700 dark:text-red-300" data-testid="glb-preview-error">
            {errorMessage || 'The 3D model could not be loaded.'}
          </p>
          {/* The failing stage, for staff only: it turns "it broke" into a
              report someone can act on (bytes never arrived vs bad geometry). */}
          {diagnostics && stage && stage !== 'ready' && (
            <p className="text-[11px] text-red-700/80 dark:text-red-300/80" data-testid="glb-preview-error-stage">
              Failed at: {STAGE_LABELS[stage] || stage}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface)] px-3 py-1 text-[11px] font-medium text-[var(--color-botanical-strong)] hover:bg-[var(--color-surface-container)] focus-visible:outline-2 focus-visible:outline-[var(--color-botanical)]"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              Try again
            </button>
            {fallbackUrl ? (
              <img
                src={fallbackUrl}
                alt="Reference for the product"
                className="max-h-[120px] w-auto rounded-lg border border-[var(--color-botanical-border)] object-contain"
                onError={(event) => {
                  event.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              <ImageOff className="w-5 h-5 opacity-40" aria-hidden="true" />
            )}
          </div>
        </div>
      )}

      {/* Controls live in an overlay so they never cover the model's centre. */}
      {state === 'ready' && (
        <>
          <div className="absolute top-2 right-2 flex items-center gap-2">
            {diagnostics && (
              <button
                type="button"
                onClick={toggleWireframe}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-botanical-strong)] shadow-sm hover:bg-[var(--color-surface-container)] focus-visible:outline-2 focus-visible:outline-[var(--color-botanical)]"
                aria-pressed={wireframe}
                data-testid="glb-wireframe-toggle"
              >
                <span aria-hidden="true">◌</span>
                {wireframe ? 'Solid view' : 'Wireframe'}
              </button>
            )}
            <button
              type="button"
              onClick={resetView}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-botanical-strong)] shadow-sm hover:bg-[var(--color-surface-container)] focus-visible:outline-2 focus-visible:outline-[var(--color-botanical)]"
              aria-label="Reset the 3D view"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              Reset view
            </button>
          </div>
          {/* PHASE 9 — view presets: every named camera position, framed to the
              complete model, with the pressed state visible to staff and tests. */}
          {poseButtons.length > 0 && (
            <div
              className="absolute top-2 left-2 flex flex-wrap gap-1 max-w-[calc(100%-11rem)]"
              role="group"
              aria-label="Camera view presets"
            >
              {poseButtons.map((pose) => (
                <button
                  key={pose.name}
                  type="button"
                  onClick={() => applyPose(pose.name)}
                  aria-pressed={activePose === pose.name}
                  data-testid={`glb-view-${pose.name}`}
                  className={`rounded-full border px-2 py-1 text-[10px] font-medium shadow-sm focus-visible:outline-2 focus-visible:outline-[var(--color-botanical)] ${
                    activePose === pose.name
                      ? 'border-[var(--color-botanical)] bg-[var(--color-botanical)] text-white'
                      : 'border-[var(--color-botanical-border)] bg-[var(--color-surface)] text-[var(--color-botanical-strong)] hover:bg-[var(--color-surface-container)]'
                  }`}
                >
                  {pose.label}
                </button>
              ))}
            </div>
          )}
          <p
            className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] text-[var(--color-botanical-subtle)] shadow-sm"
            aria-hidden="true"
          >
            Drag to rotate · scroll to zoom
          </p>
        </>
      )}
    </div>
  );
}
