# The Photographic Spatial Stage

**Status:** shipped on the homepage (Phase H2 → photo-plane rebuild).
**Owner surface:** `frontend/src/components/cinematic/`.
**Enforced by:** `frontend/e2e/specs/15-cinematic-stage.spec.js` (FLOW 43–51), the
FLOW 40–42 / 40b / 40c invariants in `14-cinematic-home.spec.js`, and the
FLOW 41 bundle invariant.

The homepage carries **one** dedicated WebGL stage: a single, lazy-loaded
React-Three-Fiber canvas in which a real `PerspectiveCamera` travels through
**six of the repository's own photographs**, hung as depth-separated textured
planes in a small corridor. It exists to satisfy the one requirement image
zooms cannot: a **genuine three-dimensional viewpoint change driven by
scrolling** — the camera's position, look-target and FOV are all functions of
scroll progress, so perspective, parallax and occlusion between planes all
change the way a real camera would.

The stage is deliberately **subordinate to the catalogue**: it sits between the
botanical-reveal scene and the craftsmanship scene, hands the visitor back to
the photographic storefront at shot five, and never replaces a product
photograph.

---

## 1. What this replaced, and why

The first version of this stage (Phase H2) loaded a decorative CC0 model —
`/models/gazania-cc0.glb`, a clump of gazania ground-cover from Poly Haven.
The owner disliked the model and the look it produced, and the approved
direction explicitly **forbids replacing it with another unrelated 3D flower,
generic primitive or synthetic set**.

So the model stage was removed outright:

| Removed | Evidence |
| --- | --- |
| `frontend/src/components/cinematic/CinematicStage.jsx` | deleted (the R3F model stage) |
| `frontend/public/models/gazania-cc0.glb` | deleted (1.1 MB; repo-wide reference search confirmed nothing else used it) |
| Gazania camera path, studio floor/backdrop meshes, per-shot model copy | deleted with the component |
| `window.__floraStage` model raycast probes | **reused**, re-pointed at the photo planes |

A repo-wide search for `gazania`, `flower_gazania` and `.glb` in the homepage
path now returns nothing; FLOW 48 asserts no homepage request ever references
a GLB.

## 2. Honesty rules — what the stage is and is not

This is a **spatial photographic scene**, and the code is written so that claim
cannot drift:

- **Real:** an actual `PerspectiveCamera` whose position, look-target and FOV
  change with scroll; true perspective projection; parallax between planes at
  different depths; occlusion as one plane crosses in front of another.
- **Not claimed:** that a photograph has volumetric geometry, or that the
  hidden reverse side of a photographed object was reconstructed. The planes
  are flat images — that hybrid is the approved direction, not a limitation to
  hide.

Two rules keep it honest:

1. **Unlit, colour-exact materials.** Planes use `meshBasicMaterial` with
   `toneMapped: false`, so the photographs' own colours reach the screen
   untouched — no lighting rig tints product colour, and no white material can
   ever override it.
2. **A warm gradient backdrop, never product geometry.** The owner rejected
   the first cut's flat `<color>` clear colour as reading like an empty studio
   void, so the environment is now ONE clearly named plane (`stage-backdrop`)
   carrying a vertical warm gradient plus a lamp-falloff glow baked into a
   small canvas texture — the same warm light the photographs were shot
   under, in both themes. It is not in `PLANES`, is never reported by the QA
   probes as a photo plane, and is never mistakable for the product. Still
   no ground plane, no cyclorama around the corridor, no particles, no
   post-processing — and deliberately **no fog**, because fog would fade the
   photographs' own colours at distance and colour fidelity is a rule of
   this file. The base clear colour matches the section band behind the
   canvas and only catches extreme edges beyond the backdrop plane.

## 3. The planes — measured aspect, not assumed

`PhotoPlaneStage.jsx:PLANES` defines six planes, each pointing at a file that
already exists in the repository:

| id | file | plane size (m) | position (m) | yaw |
| --- | --- | --- | --- | --- |
| `lavender` | `flora-asset-05.jpg` | 8.0 × 4.36 | [0, 0, 0] | 0.10 |
| `pressed-paper` | `flora-asset-07.jpg` | 7.6 × 4.14 | [−4.6, 0.5, −15] | 0.58 |
| `wrapped-posy` | `flora-asset-03.jpg` | 6.6 × 3.69 | [4.6, −0.5, −21] | −0.52 |
| `gift-seal` | `flora-asset-04.jpg` | 7.4 × 4.03 | [−5, 0.7, −31] | 0.55 |
| `twine` | `flora-asset-21.jpg` | 6.6 × 3.59 | [2, −1.8, −40] | −0.22 |
| `posy-hands` | `flora-asset-01.jpg` | 7.0 × 7.00 (square) | [0, 0.4, −52] | 0.04 |

The planes are **large and deep** — the owner's correction of the first cut
was that photographs read as a small cluster of thumbnails in an empty
field, so each plane is sized to dominate a beat and the corridor runs 52 m
deeper, one protagonist plane per shot (yaw keeps each facing the camera
that frames it).

**Aspect is measured, not assumed.** Every one of these files is genuinely
landscape — `flora-asset-05/07/04/21` are 512×279, `flora-asset-03` is 512×286,
`flora-asset-01` is 512×512 — with **no EXIF orientation tag**, so no browser
will rotate them either. The homepage's older comment describing the set as
"portrait 279–286 × 512" was simply wrong, and the first cut of this stage
sized the planes from that comment: the photographs came out stretched ~3×
vertically. Each plane's height is now derived from its photograph's true
aspect. If you add a plane, read the file's dimensions first.

## 4. The five shots

`PhotoPlaneStage.jsx:SHOTS` is the authored path — a CatmullRom through five
poses, sampled by the single camera director:

| Progress | Shot | Camera intent | Visual event |
| ---: | --- | --- | --- |
| 0.00–0.14 | `establish` | close macro, 34° FOV | the lavender photograph dominates (~69% of frame width); kicker + title resolve |
| 0.14–0.36 | `pull-back` | retreat + rise, 42° | the composition opens; adjacent planes arrive in frame (~60%) |
| 0.36–0.60 | `lateral` | track from the left, 40° | a near plane passes in front of a farther one while the lavender plane holds frame (~71%) |
| 0.60–0.82 | `three-quarter` | diagonal push-through, 36° | the gift box becomes the anchor (~56%) — re-aimed from the first cut, whose target left it at the frame edge |
| 0.82–1.00 | `pull-away` | lift + widen, 44° | composed WIDE on the posy in two hands (~49%), the hand-off caption + CTA |

**Aspect compensation.** The shot table is composed at 16:9; on any other
viewport shape the director slides the camera along its own view ray by
(16:9 ÷ viewport aspect), clamped to [0.75, 1.75], so every beat keeps its
subject fraction on portrait phones and ultrawide monitors alike without
changing the look-target, view direction or FOV story. Measured coverage at
1280×800 is asserted by FLOW 50 (0.691 / 0.604 / 0.710 / 0.557 / 0.488);
evidence across all six acceptance viewports lives in
`screenshots/cinematic-evidence-2026-10-27/`.

Measured on the real site (FLOW 43's logged poses at 1280×800):

```
start  fov 34.56  position [-1.39,  0.46, 10.27]  target [ 0.33, 0.01,  -0.57]
end    fov 43.28  position [ 1.02,  1.83, -41.22]  target [-0.59, 0.45, -50.16]
forward dot 0.9385   (direction rotates — not a pure dolly)
```

Parallax between the near plane (z = 0) and the far posy plane (z = −52)
moves from a screen separation of **0.246 → 0.491**; the occlusion map under
four fixed rays changes from all-lavender to a different hit set (two
posy-hands, two backdrop at the far shot).

## 5. Ownership and lifecycle — one writer of the camera

```
SceneSection.jsx  (the section seam)
  ├─ useStageCapability()      decide 'stage' vs 'still' before first paint
  ├─ IntersectionObserver      mount the lazy chunk only near the viewport
  ├─ one ScrollTrigger         pin + runway; publishes progress 0..1 to a ref
  ├─ caption choreography      same trigger's onUpdate: staggered type entry
  │                            + exit resolution (last caption out, surface
  │                            veil over the canvas) on the final 2%
  └─ lazy import('PhotoPlaneStage.jsx')
        └─ CameraDirector (useFrame)   ← the ONLY writer of camera transforms
```

GSAP publishes a **number**; React state never touches the camera; `useFrame`
is the sole writer. Camera pose is a pure function of progress, so scrolling
back returns the identical pose (FLOW 45 measures a 0.003 m residual after
damping settles).

On unmount or theme change, `useCinematic`'s `gsap.context().revert()` kills
the trigger, the lazy chunk deletes `window.__floraStage`, and the R3F canvas
unmounts — no canvas survives onto `/shop` (FLOW 46).

## 6. Fallbacks — finished, not apologetic

`useStageCapability()` resolves `stage` vs `still` synchronously before paint,
from three inputs: `prefers-reduced-motion`, WebGL availability, and
Save-Data.

The **still** path renders a finished composition — three real photographs
(`flora-asset-05`, `flora-asset-03`, `flora-asset-04`) in a grid, the real
heading "Where the details live.", body copy and a working CTA — in normal
document flow, with no pin, no runway, no canvas and no hidden text. It does
not render a "the camera stays put on this device" apology.

## 7. QA instrumentation

When mounted, the stage publishes `window.__floraStage` — a plain object with
no UI and no customer-facing surface:

| member | meaning |
| --- | --- |
| `progress`, `shot`, `frames` | scroll progress, nearest shot index, rendered frames |
| `fov`, `position`, `target` | live camera state |
| `ready`, `planeCount` | six photograph textures decoded; six planes present |
| `project(x, y, z)` | world → NDC through the live camera (parallax probe) |
| `hitAt(ndcX, ndcY)` | first plane hit by a ray (occlusion probe) |
| `planeScreen()` | every photo plane's **frustum-clipped** coverage of the viewport (0–1), centre and behind flag — the dominance probe FLOW 50 asserts on |

`planeScreen` clips each quad as a polygon in clip space (Sutherland–
Hodgman against all six frustum planes) before projection: corner-only
projection reports mirrored garbage when a plane straddles the near plane,
which is exactly what happened beside the camera on shot four (a plane
behind the camera measured “13× the viewport” wide until the clipper
landed). The Vector4 note in the file matters too: `Vector3.applyMatrix4`
perspective-divides and discards `w`, which would make every homogeneous
clip distance `NaN`.

`hitAt` intersects `scene.children` as an **array** — passing the `Scene` object
itself makes three.js read `.length`, get `undefined`, iterate nothing and
return zero hits silently. That bug was caught by FLOW 44 on its first run.

## 8. Test coverage — FLOW 43–51

| Flow | Asserts |
| --- | --- |
| **43** | camera position, look-target, forward direction **and** FOV all change across the scroll; attaches screenshots at progress 0.02 / 0.5 / 0.98 |
| **44** | a plane's projected screen position changes; perspective parallax between two depths changes; a ray hits a real plane; the occlusion map differs between viewpoints |
| **45** | scrolling back restores the earlier position and target |
| **46** | resize → exactly one **stage** canvas (page-level counts tolerate the decorative nav/hero canvases); route change away → 0 stage canvases and `__floraStage` gone; return → exactly one fresh stage canvas, no console errors |
| **47** | reduced motion and non-WebGL both get the **finished** still composition (3 photos, nothing at opacity 0, no stage renderer, no hero cursor) and a working storefront |
| **48** | **no** request for any GLB/gazania; no failed requests; no horizontal overflow; the canvas does not overlap the footer; shopping CTAs work with the stage on screen |
| **49** | five captions, exactly one visible and exposed at any progress; the last caption is active at the end; all nine scenes mount; ≥4 line reveals and ≥2 emphasis settles present |
| **50** | every beat is dominated by one large photograph — frustum-clipped coverage floors of 0.6/0.5/0.6/0.45/0.45 with the intended protagonist at start, diagonal and hand-off beats |
| **51** | the final caption is fully on at 0.98, then resolves with the exit veil sealing the stage by the runway's end — and the craft heading only arrives with every caption already off |

`14-cinematic-home.spec.js` FLOW 40 also asserts the kinetic-type hooks
(`[data-type-reveal]`) exist on the page and that no homepage request
references the deleted model; FLOW 40b covers the desktop GooeyNav (real
routes, SPA navigation, route-driven `aria-current`, back/forward, direct
load) and FLOW 40c the hero crosshair (desktop fine-pointer only, `pointer-
events: none`, unmounts under reduced motion and on touch widths).

## 9. Bundle discipline

The stage is **always** a lazy chunk: `SceneStage` reaches it only through
`React.lazy(() => import('./PhotoPlaneStage.jsx'))`. FLOW 41 fails the build's
test if a WebGL renderer, `GLTFLoader` or `PerspectiveCamera` appears in the
entry bundle or the HomePage chunk.

Measured from `npm run build:e2e`:

| chunk | size | contains |
| --- | --- | --- |
| `HomePage-*.js` | 54 kB | page scenes, **no renderer** |
| `PhotoPlaneStage-*.js` | 190 kB | the R3F canvas + planes + backdrop |
| `three.module-*.js` | 704 kB | three.js itself, loaded only by the stage chunk |

## 10. Files

| File | Role |
| --- | --- |
| `frontend/src/components/cinematic/PhotoPlaneStage.jsx` | **lazy chunk** — the R3F canvas, the six planes, the two CatmullRom curves, the single camera director, the QA handle |
| `frontend/src/components/cinematic/SceneStage.jsx` | the homepage section — capability seam, near-gate mount, ScrollTrigger pin + runway, per-shot captions, still composition |
| `frontend/src/components/cinematic/useStageCapability.js` | the reduced-motion / no-WebGL / Save-Data decision |
| `frontend/src/components/cinematic/MotionBits.jsx` | the kinetic-type vocabulary: `SplitText`, `MaskedLines`, `WordReveal`, `EmphasisSettle`, `Magnetic`, `SpotlightCard` |
| `frontend/src/pages/HomePage.jsx` | renders `<SceneStage />` between the reveal and craft scenes; carries the masked-line headings |
| `frontend/e2e/specs/15-cinematic-stage.spec.js` | FLOW 43–51 |
| `frontend/e2e/specs/14-cinematic-home.spec.js` | FLOW 40–42 + 40b/40c (page-wide, bundle, reduced motion, nav, crosshair) |

## 11. Known limitations

- **The source photographs are 512 px wide.** A dominant macro at shot one
  upscales a 512 px file roughly 2× (more on high-DPR screens); the camera
  does not invent resolution that is not in the file. This is a property of
  the repository's existing imagery, and the brief forbids substituting
  generated or stock art to fix it.
- **The wide beats sit below the ~60–75% rule by design.** Shots four and
  five measure 0.557 / 0.488 coverage — the diagonal judgment shot and the
  composed wide hand-off the shot spec asks for; shots one to three carry
  the 60–75% rule at 0.69–0.71.
- **Flat planes, by design.** Occlusion and parallax are real; the objects in
  the photographs are not modelled. No back faces exist.
- **Single WebGL canvas.** The stage is the only renderer the storefront may
  reach, and only on the homepage; shop, checkout and admin carry none.
  (The header's gooey-nav canvas and the hero crosshair are 2D canvases, not
  renderers — specs scope every renderer count to `[data-stage-canvas]`.)
