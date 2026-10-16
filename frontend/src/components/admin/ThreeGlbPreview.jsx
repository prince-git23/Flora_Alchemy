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
 */

/** The whole preview, kept off the critical path until the effect runs. */
let threeModule = null;
let gltfLoaderClass = null;
let orbitControlsClass = null;

async function ensureThree() {
  if (threeModule && gltfLoaderClass && orbitControlsClass) {
    return { three: threeModule, GLTFLoader: gltfLoaderClass, OrbitControls: orbitControlsClass };
  }
  const [three, loaderMod, controlsMod] = await Promise.all([
    import('three'),
    import('three/addons/loaders/GLTFLoader.js'),
    // OrbitControls is an ADDON, not part of the three namespace: `three.OrbitControls`
    // does not exist, and reaching for it is the classic way to make a viewer that
    // always lands in its error state.
    import('three/addons/controls/OrbitControls.js'),
  ]);
  threeModule = three;
  gltfLoaderClass = loaderMod.GLTFLoader;
  orbitControlsClass = controlsMod.OrbitControls;
  return { three: threeModule, GLTFLoader: gltfLoaderClass, OrbitControls: orbitControlsClass };
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

export default function ThreeGlbPreview({
  loadModel,
  hasModel = true,
  fallbackUrl = '',
  reloadKey = 0,
  onModelError,
  className = '',
  previewHeight = 380,
  label = '3D model preview',
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

  // Keep the newest callback without making it an effect dependency: a parent
  // that forgets useCallback would otherwise rebuild the whole scene each render.
  const loadModelRef = useRef(loadModel);
  const onErrorRef = useRef(onModelError);
  useEffect(() => {
    loadModelRef.current = loadModel;
    onErrorRef.current = onModelError;
  }, [loadModel, onModelError]);

  const frame = useCallback((three, object, camera, controls) => {
    const box = new three.Box3().setFromObject(object);
    const size = box.getSize(new three.Vector3());
    const center = box.getCenter(new three.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(maxDim) || maxDim <= 0.0001) return;
    const distance = maxDim * 2.2 + 0.5;
    camera.position.set(center.x, center.y, center.z + distance);
    camera.near = Math.max(maxDim / 100, 0.01);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
  }, []);

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
      return undefined;
    }

    const container = containerRef.current;
    if (!container) return undefined;

    let cancelled = false;
    let animationFrame = null;
    let objectUrl = '';
    let revokeUrl = null;
    let renderer = null;
    let controls = null;
    let loadedModel = null;
    let resizeHandler = null;

    setState('loading');
    setErrorMessage('');

    const failWith = (err) => {
      if (cancelled) return;
      setState('error');
      setErrorMessage(err?.message || 'The 3D model could not be loaded.');
      if (onErrorRef.current) onErrorRef.current(err);
    };

    const teardown = () => {
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

    (async () => {
      try {
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
        renderer.toneMapping = three.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.touchAction = 'none';
        container.appendChild(renderer.domElement);

        // ── Lighting: soft key + fill + rim. No environment map, so the GLB's
        //    own materials decide the look rather than a baked studio HDRI. ──
        scene.add(new three.AmbientLight(0xffffff, 0.7));
        const key = new three.DirectionalLight(0xffffff, 1.6);
        key.position.set(3, 6, 4);
        scene.add(key);
        const fill = new three.DirectionalLight(0xdfe6ef, 0.7);
        fill.position.set(-4, 2, 3);
        scene.add(fill);
        const rim = new three.DirectionalLight(0xffffff, 0.45);
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

        const loaded = await loadModelRef.current();
        if (cancelled) {
          if (loaded?.revoke) loaded.revoke();
          return;
        }
        if (!loaded?.url) {
          failWith(new Error('The model file could not be located.'));
          return;
        }
        objectUrl = loaded.url;
        revokeUrl = loaded.revoke || null;

        const loader = new GLTFLoader();
        loader.load(
          objectUrl,
          (gltf) => {
            if (cancelled) return;
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

            let meshCount = 0;
            loadedModel.traverse((node) => {
              if (node.isMesh || node.isPoints || node.isLine) meshCount += 1;
            });

            // A GLB that parses but draws nothing is not a previewable model; the
            // server's validator already refuses these, so seeing one here means
            // the bytes are not what the asset row recorded.
            if (meshCount === 0) {
              failWith(new Error('This model contains no drawable geometry.'));
              return;
            }

            extras.add(loadedModel);
            frame(three, loadedModel, camera, controls);
            setState('ready');
          },
          undefined,
          (err) => {
            failWith(
              err instanceof Error
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
    // `previewHeight` participates only through the initial size; the resize
    // handler keeps the canvas matched to the container afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasModel, reloadKey, localReload, frame, previewHeight]);

  const retry = useCallback(() => setLocalReload((n) => n + 1), []);

  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] ${className}`}
      /* `null` = the container owns the height (the storefront gallery box). */
      style={previewHeight ? { height: previewHeight } : undefined}
      data-testid="glb-preview"
      data-state={state}
    >
      {/* The WebGL canvas is appended here by the effect. */}
      <div ref={containerRef} className="absolute inset-0" role="img" aria-label={label} />

      {state === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-surface-low)]">
          <Loader2 className="w-7 h-7 animate-spin text-[var(--color-botanical-muted)]" aria-hidden="true" />
          <p className="text-xs text-[var(--color-botanical-subtle)]">Loading the 3D model…</p>
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
