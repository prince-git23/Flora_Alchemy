# The Atelier — the cinematic workshop on the storefront

> **STATUS: ISOLATED EXPERIMENT — NOT ON ANY CUSTOMER ROUTE.** The homepage was
> redesigned as a camera-led photographic journey (eight scenes built on real
> atelier photography, sharing `frontend/src/lib/cinematicMotion.js`). Nothing
> imports `AtelierSection` any more; the folder is kept as a reference
> implementation of the three.js/R3F workshop and its capability tiers. The
> rules below (lazy boundary, canvas-generated textures, studio hand-off ids)
> still govern the folder and any future revival of it.

> Related: [DESIGN.md](./DESIGN.md) (visual system), [ARCHITECTURE.md](./ARCHITECTURE.md)
> (where code lives), [TESTING.md](./TESTING.md) (how the suite works),
> [AGENTS.md](../AGENTS.md) (the short briefing).

The homepage opens with a live 3D workshop: a lit oak bench, a hand-wrapped posy,
a brass wax seal, a lettered card and a ribbon spool. Scrolling moves a camera
through three chapters — **01 The Seal**, **02 The Note**, **03 The Ribbon** — and
every choice made in the HTML overlay is applied to the object being filmed.
The finished composition is then handed to the **Custom Gift Studio**, which owns
pricing, stock and the order.

The rule that shapes the whole implementation: **the shop must work without any
of this.** The atelier is an enhancement layer with three honest states (live,
static, static-while-loading), and it never becomes the only path to a product.

---

## 1. Where the code lives

```
frontend/src/atelier/
  AtelierSection.jsx      the lazy boundary HomePage imports (and a local
                          error boundary: a broken atelier is never a broken shop)
  AtelierExperience.jsx   canvas host, scroll choreography, chapter overlay,
                          station controls, hand-off to the studio
  AtelierScene.jsx        the R3F tree: lights, camera director, post-processing
  Set.jsx                 the room: workbench, curved wall, window, shelf, tools,
                          wax station, calligraphy station, contact shadows
  Flora.jsx               procedural flora: petals, leaves, roses, eucalyptus,
                          chamomile, lavender, the composition and its seal
  textures.js             every pixel: oak, cotton-rag paper, wax seal with the
                          monogram, the lettered card, ribbon weaves, the
                          equirectangular studio environment
  palette.js              the shared vocabulary with the studio (palette / seal /
                          ribbon / base ids) and `studioHref()`
  useAtelierCapability.js capability → tier decision (webgl / reduced / low /
                          standard / full), testable without a DOM
  AtelierStatic.jsx       the designed still: no-WebGL, save-data, loading
  motion/index.jsx        React Bits, adapted (SplitText, Magnetic, SpotlightCard)
```

Supporting pieces outside the folder:

- `frontend/src/components/SmoothScroll.jsx` — Lenis, on GSAP's clock.
- `frontend/src/components/CinematicRouteTransition.jsx` — the 340 ms veil
  between storefront pages (never on portal routes).

### Lazy by construction

`AtelierSection` imports `AtelierExperience` with `lazy()`, and the experience
imports three.js/R3F itself, so the renderer ships in its own chunk. Two browser
tests hold that line: `FLOW 27` (the entry bundle carries no renderer) and
`FLOW 37` (the atelier is its own chunk and HomePage carries no renderer
*implementation*).

The section fetches its chunk only when an `IntersectionObserver` reports it
within ~240 px of the viewport. A visitor who never scrolls past the hero never
downloads the workshop.

---

## 2. The three chapters, and what each one changes

| Chapter | Controls | Effect in the scene |
|---|---|---|
| 01 The Seal | monogram (≤3 letters), wax colour | the seal on the wrap is re-engraved (canvas texture) and the stamp stands in its pool of light |
| 02 The Note | the name on the card, palette | the card is re-lettered; rose petals, cores, foliage and filler recolour (animated, never swapped) |
| 03 The Ribbon | ribbon, keepsake base | ribbon band and tails recolour; the base changes between posy, pine hamper and ceramic vessel |

The **hand-off** is `studioHref()`: it emits only ids that exist in
`CustomGiftsPage`'s own catalogues (`base`, `palette`, `seal`, `ribbon`,
`monogram`, `name`). The studio reads them once on mount, validates each against
its own lists, and keeps server-authoritative pricing untouched — the atelier can
never name a price, add a line, or invent an option. A hand-edited query string
falls back to the studio's defaults (`FLOW 39` asserts both directions).

---

## 3. Capability tiers

`resolveCapability()` decides once, from capabilities rather than user-agent:

| Tier | When | What renders |
|---|---|---|
| `static` | no WebGL context | the designed still only (`AtelierStatic`) |
| `reduced` | `prefers-reduced-motion` | the scene, one held pose, **no pin, no camera travel**, chapters via the rail |
| `low` | save-data, viewport < 768, ≤4 cores or ≤4 GB | fewer petals, no shadows, no post-processing |
| `standard` | modest desktop | shadows + contact shadows, no DOF |
| `full` | capable desktop | depth of field, bloom, vignette, grain |

`useAtelierCapability` re-resolves when the motion preference changes, so a
visitor who turns reduced motion on mid-session loses the film without a reload.

## 4. Motion rules

- **The camera is choreographed, never orbited.** Three poses (macro, tracking,
  crane) interpolated on a Catmull-Rom path; pointer parallax is ≤5 cm of world
  space and is off under reduced motion.
- **One clock.** Lenis is driven by `gsap.ticker`; `ScrollTrigger.update()` runs
  from Lenis's own `scroll` event, so the two cannot disagree by a frame.
- **Rack focus lives in the post-processing**, per shot (focus distance and
  bokeh scale), and is dropped entirely below `full`.
- **Nothing animates for attention.** The grain is 5.5 % opacity, the bloom is
  0.28, the vignette is 0.28/0.72; the point is a filmed object, not a demo reel.
- **No network assets.** All textures are canvas-generated, including the
  environment map (a 2:1 warm-studio canvas run through `PMREMGenerator`).

## 5. Two defects this work found in the existing storefront

Both were found by measuring the page, and both are now covered by tests:

1. **`position: sticky` cannot work under `body { overflow-x: hidden }`.**
   With `index.css`'s global `body { overflow: hidden auto }`, body becomes a
   scroll container and a sticky stage simply scrolls away with the page — the
   film played while every control left the viewport. The stage is pinned with
   `ScrollTrigger` (`pinSpacing: false`, the runway provides the distance), and
   `FLOW 38` asserts the stage stays within 10 px of the viewport top while the
   document scrolls hundreds of pixels.
2. **`html { scroll-behavior: smooth }` breaks programmatic scrolling once
   Lenis owns the wheel.** `window.scrollTo(x, y)` became a native smooth scroll
   that Lenis rewound to its own animated position on the next frame, so the
   page refused to move — which breaks `ScrollRestoration`, the gift studio's
   step changes, and Playwright's own scrolling. `SmoothScroll` sets
   `documentElement.style.scrollBehavior = 'auto'` while it is mounted (and
   restores it on unmount); a caller that wants a glide asks Lenis.

A third, smaller trap was in the suite itself: the bundle-target safety gate
matched every `https://…/api` string, and drei ships
`https://docs.pmnd.rs/react-three-fiber/api`. The gate now has an explicit,
narrow allowlist of third-party documentation hosts, and prints only the origins
it actually evaluated.

## 6. Accessibility

- The overlay is real HTML: buttons with `aria-pressed`, labelled inputs, a
  chapter `tablist`, a live summary region, and visible focus rings.
- The canvas is `aria-hidden`; it is the illustration, never the content.
- The viewfinder chrome (corner brackets, shot label, timecode) is decorative
  and `aria-hidden`, and no fact appears only there.
- Reduced motion: no pin, no camera travel, no SplitText stagger, no magnetic
  lean, no route veil, no Lenis.
- The section is an ordinary `section` with an `h2`; it does not trap focus and
  does not hijack the scroll wheel.

## 7. What this does NOT claim

- **Not a photograph of the real product.** The flora is procedural paper
  sculpture. Real product photography remains the source of truth everywhere a
  customer might buy.
- **Not a texture pipeline.** No UV atlasing, no PBR texture sets; materials are
  tinted, roughened canvas maps.
- **Not a customisation that reaches production automatically.** The monogram
  rides the gift message; the studio's own options are what the order stores.
- **No server-side rendering.** The section is client-only and lazy; with
  JavaScript off the homepage shows the fallback band that links to the studio.
