# The Photographic Spatial Stage

**Status:** shipped on the homepage (Phase H2 → photo-plane rebuild).
**Owner surface:** `frontend/src/components/cinematic/`.
**Enforced by:** `frontend/e2e/specs/15-cinematic-stage.spec.js` (FLOW 43–49) and the
FLOW 41 invariant in `14-cinematic-home.spec.js`.

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
2. **No backdrop geometry.** The calm background is a `<color>` clear colour
   drawn from the same surface token the page band uses, in both themes. There
   is no ground plane, no cyclorama mesh, no particles, no post-processing —
   nothing that could be mistaken for product geometry.

## 3. The planes — measured aspect, not assumed

`PhotoPlaneStage.jsx:PLANES` defines six planes, each pointing at a file that
already exists in the repository:

| id | file | plane size (m) | yaw |
| --- | --- | --- | --- |
| `lavender` | `flora-asset-05.jpg` | 4.4 × 2.40 | 0.10 |
| `pressed-paper` | `flora-asset-07.jpg` | 4.0 × 2.18 | 0.40 |
| `wrapped-posy` | `flora-asset-03.jpg` | 4.0 × 2.23 | −0.36 |
| `gift-seal` | `flora-asset-04.jpg` | 4.2 × 2.29 | 0.26 |
| `twine` | `flora-asset-21.jpg` | 3.8 × 2.07 | −0.22 |
| `posy-hands` | `flora-asset-01.jpg` | 3.2 × 3.20 (square) | 0.08 |

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
| 0.00–0.14 | `establish` | close macro, 34° FOV | the lavender photograph dominates; kicker + title resolve |
| 0.14–0.36 | `pull-back` | retreat + rise, 40° | adjacent planes arrive in frame |
| 0.36–0.60 | `lateral` | track from the left, 38° | a near plane passes in front of a farther one |
| 0.60–0.82 | `three-quarter` | diagonal drift, 36° | a second composition becomes the anchor |
| 0.82–1.00 | `pull-away` | lift + widen, 46° | the corridor opens into negative space for the hand-off caption |

Measured on the real site at 1440×900 (FLOW 43's logged poses):

```
start  fov 34.47  position [0.42, 0.27, 4.96]  target [-0.05,  0.02, -0.24]
end    fov 45.19  position [0.73, 2.36, 8.03]  target [-0.03, -0.16, -7.02]
forward dot 0.9925   (direction rotates — not a pure dolly)
```

Parallax between the near plane (z = 0) and the far plane (z = −9.6) moves
from a screen separation of **0.125 → 0.334**; the occlusion map under four
fixed rays changes from all-lavender to a different hit set.

## 5. Ownership and lifecycle — one writer of the camera

```
SceneSection.jsx  (the section seam)
  ├─ useStageCapability()      decide 'stage' vs 'still' before first paint
  ├─ IntersectionObserver      mount the lazy chunk only near the viewport
  ├─ one ScrollTrigger         pin + runway; publishes progress 0..1 to a ref
  ├─ caption crossfade         driven from the SAME trigger's onUpdate
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

`hitAt` intersects `scene.children` as an **array** — passing the `Scene` object
itself makes three.js read `.length`, get `undefined`, iterate nothing and
return zero hits silently. That bug was caught by FLOW 44 on its first run.

## 8. Test coverage — FLOW 43–49

| Flow | Asserts |
| --- | --- |
| **43** | camera position, look-target, forward direction **and** FOV all change across the scroll; attaches screenshots at progress 0.02 / 0.5 / 0.98 |
| **44** | a plane's projected screen position changes; perspective parallax between two depths changes; a ray hits a real plane; the occlusion map differs between viewpoints |
| **45** | scrolling back restores the earlier position and target |
| **46** | resize → exactly one canvas; route change away → 0 canvases and `__floraStage` gone; return → exactly one fresh canvas, no console errors |
| **47** | reduced motion and non-WebGL both get the **finished** still composition (3 photos, nothing at opacity 0) and a working storefront |
| **48** | **no** request for any GLB/gazania; no failed requests; no horizontal overflow; the canvas does not overlap the footer; shopping CTAs work with the stage on screen |
| **49** | five captions, exactly one visible and exactly one `aria-hidden="false"` at any progress; the last caption is active at the end; all nine scenes mount; ≥4 line reveals and ≥2 emphasis settles present |

`14-cinematic-home.spec.js` FLOW 40 also asserts the kinetic-type hooks
(`[data-type-reveal]`) exist on the page and that no homepage request
references the deleted model.

## 9. Bundle discipline

The stage is **always** a lazy chunk: `SceneStage` reaches it only through
`React.lazy(() => import('./PhotoPlaneStage.jsx'))`. FLOW 41 fails the build's
test if a WebGL renderer, `GLTFLoader` or `PerspectiveCamera` appears in the
entry bundle or the HomePage chunk.

Measured from `npm run build:e2e`:

| chunk | size | contains |
| --- | --- | --- |
| `HomePage-*.js` | 44 kB | page scenes, **no renderer** |
| `PhotoPlaneStage-*.js` | 189 kB | the R3F canvas + planes |
| `three.module-*.js` | 704 kB | three.js itself, loaded only by the stage chunk |

## 10. Files

| File | Role |
| --- | --- |
| `frontend/src/components/cinematic/PhotoPlaneStage.jsx` | **lazy chunk** — the R3F canvas, the six planes, the two CatmullRom curves, the single camera director, the QA handle |
| `frontend/src/components/cinematic/SceneStage.jsx` | the homepage section — capability seam, near-gate mount, ScrollTrigger pin + runway, per-shot captions, still composition |
| `frontend/src/components/cinematic/useStageCapability.js` | the reduced-motion / no-WebGL / Save-Data decision |
| `frontend/src/components/cinematic/MotionBits.jsx` | the kinetic-type vocabulary: `SplitText`, `MaskedLines`, `WordReveal`, `EmphasisSettle`, `Magnetic`, `SpotlightCard` |
| `frontend/src/pages/HomePage.jsx` | renders `<SceneStage />` between the reveal and craft scenes; carries the masked-line headings |
| `frontend/e2e/specs/15-cinematic-stage.spec.js` | FLOW 43–49 |
| `frontend/e2e/specs/14-cinematic-home.spec.js` | FLOW 40–42 (page-wide, bundle, reduced motion) |

## 11. Known limitations

- **The source photographs are 512 px wide.** A full-screen macro at shot one
  is genuinely soft; the camera does not invent resolution that is not in the
  file. This is a property of the repository's existing imagery, and the brief
  forbids substituting generated or stock art to fix it.
- **Flat planes, by design.** Occlusion and parallax are real; the objects in
  the photographs are not modelled. No back faces exist.
- **Single WebGL canvas.** The stage is the only renderer the storefront may
  reach, and only on the homepage; shop, checkout and admin carry none.
