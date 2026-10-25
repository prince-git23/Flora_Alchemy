# The Cinematic Stage

**Status:** shipped on the homepage (Phase H2).
**Owner surface:** `frontend/src/components/cinematic/`.
**Enforced by:** `frontend/e2e/specs/15-cinematic-stage.spec.js` (FLOW 43–48) and the
FLOW 41 invariant in `14-cinematic-home.spec.js`.

The homepage carries **one** dedicated WebGL stage: a single, lazy-loaded
React-Three-Fiber canvas whose camera follows a CatmullRom path of five shots
through a real, licensed CC0 botanical model on a lit studio floor. It exists to
satisfy the one requirement image zooms cannot: a **genuine three-dimensional
viewpoint change driven by scrolling** — the camera's position, look-target and
FOV are all functions of scroll progress, so perspective, occlusion and the
model's projected screen position all change the way a real camera would.

The stage is deliberately **subordinate to the catalogue**: it sits between the
botanical-reveal scene and the craftsmanship scene, hands the visitor back to the
photographic storefront at shot five, and never replaces a product photograph.

---

## 1. The asset — provenance and licence

| Field | Value |
| --- | --- |
| **Asset** | **Flower Gazania** (a clump of gazania ground-cover: orange daisy blooms + green foliage) |
| **Source** | [Poly Haven](https://polyhaven.com/a/flower_gazania) — human-authored, CC0 asset library |
| **Authors (credited)** | **James Ray Cock** — modelling · **Jenelle van Heerden** — photography |
| **Licence** | **CC0 1.0** (Poly Haven's universal default; public domain, no attribution required — attribution recorded here as a courtesy to the named human authors) |
| **Category / collection** | nature, plants, flowers, ground cover · `collection: namaqualand` (South-African wildflower field) |
| **File in repo** | `frontend/public/models/gazania-cc0.glb` |
| **Role** | **decorative** — a botanical reference for the studio narrative, never presented as a listed product |

### Why Poly Haven and not the Sketchfab scan

The brief named a photogrammetry bouquet on Sketchfab as the preferred option.
That download requires an OAuth token (the API returns `401` without one) and no
such session exists in this environment, so it could not be obtained legitimately.
Smithsonian Open Access — the other photogrammetry candidate — returns `403` to
automated access. Poly Haven's models are downloadable directly, carry **named
human authorship** and a **CC0** licence, and its gazania is a genuinely
three-dimensional, textured botanical model. It is the best asset that could be
verified and obtained; it is **human-modelled, not AI-generated**, and **not a
photogrammetry scan** (a limitation recorded in §6).

No replacement flowers, low-poly petals, primitive furniture or artificial
bouquets were generated to fill the scene — the scene is the single licensed
model plus a floor and a backdrop.

---

## 2. Optimisation and measured budget

The Poly Haven source ships as glTF with **1k** utility textures (~2.8 MB
download). For web delivery it was re-packed into a **single self-contained
GLB**: the base-colour (diffuse) map kept at **1024²** (the establish shot is a
macro close-up, so a 512 diffuse would read soft), and the normal +
metallic-roughness utility maps reduced to **512²**, all re-encoded as JPEG.

| Metric | Source | Shipped GLB |
| --- | --- | --- |
| Payload | ~2.8 MB (loose glTF + bin + PNGs) | **1,108,576 bytes (1.08 MB)** |
| Textures | 1k PNG set | 1024² diffuse + 512² normal + 512² metallic-roughness (JPEG) |
| Meshes / material | 8 / 1 (opaque, `metallicFactor 0`, `doubleSided`) | unchanged |
| Geometry | 15,877 verts · 14,340 tris | unchanged |
| Extensions | none | none → **no draco/meshopt decoder is fetched** |

**Asset budget: ≤ 1.2 MB.** Measured: **1.08 MB**, within budget. The GLB is
served from `public/models/` and fetched **only when the stage approaches the
viewport** (a 300 px IntersectionObserver gate + a lazy `import()` chunk), so the
opening hero never waits on it. The renderer chunk itself is `three.js` +
`@react-three/fiber` + a slice of `drei`, code-split to its own lazy file
(measured **704 kB / 182 kB gzip** in the E2E bundle; **260 kB / 81 kB gzip** in the
production bundle where three is shared with the existing product 3D viewer).

---

## 3. The camera path

The five poses are keyframes on two centripetal `CatmullRomCurve3` splines — one
for the camera **position**, one for the **look-target** — plus a piecewise-linear
FOV ramp. `SceneStage` publishes the homepage scroll progress into `progressRef`
via one GSAP ScrollTrigger; `CinematicStage`'s single `useFrame` director is the
**only writer of the camera** (GSAP never touches the camera, React state never
touches it, so there is no competing controller).

| Shot | id | Position (m) | Look-target | FOV | Camera move |
| --- | --- | --- | --- | --- | --- |
| 1 | `establish` | `[0.34, 0.66, 0.62]` | `[0.02, 0.55, 0.06]` | 30° | macro close-up on the bloom |
| 2 | `dolly-out` | `[0.62, 1.25, 2.10]` | `[0, 0.45, 0]` | 36° | retreat + rise, reveal the arrangement |
| 3 | `lateral` | `[-1.60, 0.80, 1.45]` | `[0.05, 0.45, 0]` | 36° | track left, blooms pass in front of one another |
| 4 | `three-quarter` | `[-1.05, 1.05, -1.50]` | `[0, 0.42, 0.05]` | 33° | swing round the far side, key light rakes the petals |
| 5 | `pull-away` | `[0.50, 1.85, 3.00]` | `[0, 0.30, 0.20]` | 42° | lift away, hand off to the catalogue |

**Runtime normalisation:** the model is cloned (the drei URL cache is never
mutated), scaled to a **0.85 m** standing height, re-centred on the origin and
rested on the floor (`y = 0`), so every shot's framing is expressed against a
known subject size. The camera damps toward the sampled pose with
`k = 1 − exp(8·dt)` — frame-rate independent, settles in ~0.4 s, and because
progress is a pure function of scroll, an earlier pose returns **exactly** on
scroll-back.

**Environment:** a seamless cyclorama — a circular studio floor plus an inverted
backdrop cylinder — with a fog colour equal to the page's surface token, so the
horizon dissolves into the photographic storefront in both light and dark themes.
One warm key light with a single shadow map, one cool fill, ambient + hemisphere;
**no post-processing** (the brief forbids effects the scene does not need).

---

## 4. QA instrumentation (developer-only)

When mounted, `CinematicStage` publishes `window.__floraStage` — a plain object
with **no customer-facing surface** — exposing the live `position`, `target`,
`progress`, `fov`, `frames`, `modelReady`, plus two probes:

- `project(x, y, z)` — world point → NDC through the **live** camera (viewpoint proof).
- `hitAt(ndcX, ndcY)` — first mesh hit by a ray through an NDC point (occlusion proof;
  returns the mesh name, e.g. `flower_gazania_f_LOD0` vs `studio-floor`).

It is deleted on unmount, so an operational page (`/shop`, checkout, admin) never
carries a renderer or a stuck handle.

---

## 5. What the browser checks prove (`15-cinematic-stage.spec.js`)

The checks measure **differences that only a moving camera can produce** — an
image-scale/translate fake cannot move the camera position or change which mesh a
ray hits first.

| Flow | Claim | Measured evidence |
| --- | --- | --- |
| **43** | Camera position, look-target, forward direction and FOV all change with scroll | start pose `[0.37, 0.71, 0.74]` / FOV 30° → end pose `[0.37, 1.78, 2.61]` / FOV 41°; forward-dot 0.904 (≈25° rotation) |
| **44** | The model's projected viewpoint, perspective parallax and raycast occlusion change | crown NDC `[0.02, 1.48, 0.87]` → `[0.02, 0.54, 0.97]`; depth-parallax separation 2.65 → 0.49; centre ray hits `flower_gazania_f_LOD0` (model) at shot 1, `studio-floor` at shot 5 |
| **45** | Scrolling backwards restores the earlier pose | position restore delta **0.0035 m** |
| **46** | Resize, route change and unmount leave no duplicate renderers or stuck timelines | exactly 1 canvas through resize; 0 canvases + `__floraStage` undefined on `/shop`; 1 fresh canvas on return |
| **47** | Reduced-motion and non-WebGL visitors get the still band + working storefront | `data-stage-mode="still"`, 0 canvases, 0 runway; four shopping doors visible and the Shop CTA navigates |
| **48** | No console errors, no failed requests (GLB `200`, 1.10 MB), no horizontal overflow | clean audit; GLB served |

Spec 15 is additive: **`14-cinematic-home` (FLOW 40–42) and `07-routes-a11y`
still pass unchanged**, so the eight photographic scenes, the FLOW 41 no-renderer
invariant, reduced-motion, dark mode and the a11y heading/landmark contract are
unregressed.

Run it (builds the E2E bundle, boots the real stack):

```bash
cd frontend
npm run build:e2e
npx playwright test e2e/specs/15-cinematic-stage.spec.js
```

---

## 6. Fallbacks, accessibility and limitations

**Mode resolution** (`useStageCapability.js`) is decided on the client's first
render, so there is no post-hydration layout swap:

- `prefers-reduced-motion` → **still** band (no pin, no runway, no canvas).
- No WebGL (`getContext('webgl2'/'webgl')` fails) → **still** band.
- Save-Data → **still** band.
- Otherwise → **stage**.

The still band is a photograph (`flora-asset-09.jpg`, chamomile in a glazed pot),
a heading, one line of copy and a **Browse all gifts** CTA in normal flow — the
storefront is fully usable with the 3D disabled. On mobile the stage keeps a
lower DPR (≤1.5) and a 512 shadow map; the canvas uses `touch-action: pan-y` so
vertical touch scrolling passes through the pinned stage.

**Limitations (honest):**

- The asset is **human-modelled**, not a photogrammetry scan; it reads as a
  stylised-realistic gazania clump, not a scanned bouquet. A true scan was not
  obtainable without an OAuth/interactive session (see §1).
- The scene is a **single botanical model** plus a floor and backdrop — by design
  (the brief forbade a second artificial workshop). It is decorative and never
  represents a listed product.
- The gazania patch is ground-cover scale; the "arrangement" the camera reveals is
  the model's own clump spread across the studio floor, not a vase of cut flowers.
- Colour is judged from measured bytes, not hue-matched to any photograph.

---

## 7. Files

| File | Role |
| --- | --- |
| `frontend/src/components/cinematic/CinematicStage.jsx` | **lazy chunk** — the R3F canvas, the two CatmullRom curves, the single camera director, the studio environment, the QA handle |
| `frontend/src/components/cinematic/SceneStage.jsx` | the homepage section — capability seam, near-gate mount, ScrollTrigger pin + runway, per-shot captions, still-band fallback |
| `frontend/src/components/cinematic/useStageCapability.js` | WebGL / reduced-motion / Save-Data probe and mode resolution |
| `frontend/src/pages/HomePage.jsx` | renders `<SceneStage />` between the reveal and craft scenes |
| `frontend/src/components/CinematicRouteTransition.jsx` | the editorial cut (adds a restrained push-in settle) |
| `frontend/public/models/gazania-cc0.glb` | the licensed, optimised model |
| `frontend/e2e/specs/15-cinematic-stage.spec.js` | FLOW 43–48 — the camera-proof checks |
