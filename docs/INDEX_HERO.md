# INDEX HERO (v4) — catalogue-driven 3D motion

The index is the repository's original light storefront. It keeps the existing
header, promo bar, navigation, footer, typography, colours, radii, buttons,
chips, cards, sections, copy and routes. Motion is layered on top; it is not a
redesign and it does not introduce generated art.

The v3 dark index, its `IndexPage`, its generated bouquet placeholders and its
full-page photo-plane stage were removed. `/` is the ordinary `HomePage` with the
global storefront chrome.

## What is on screen

| Piece | File | Contract |
|---|---|---|
| Hero | `frontend/src/components/cinematic/HeroStage.jsx` | Static hero below two hero items, under reduced motion or without WebGL. With 2–5 items it pins for 520vh desktop / 340vh mobile and runs the catalogue chapter timeline. |
| Fragment canvas | `frontend/src/components/cinematic/HeroFragments.jsx` | The only three.js surface. A lazy chunk. Crops the ACTIVE product photograph into a runtime atlas; no illustration, no generated bouquet, no model. |
| Catalogue transport | `frontend/src/services/catalogueService.js` | `GET /api/catalogue?featured=true&hero=true`, conditional GET, ETag, 304. |
| Catalogue hook | `frontend/src/hooks/useCatalogue.js` | SWR-style cache, 30s TTL, bounded revalidation, `fa:refresh` invalidation, loading/error state. |
| Beloved Pieces | `frontend/src/pages/HomePage.jsx` | Existing `ProductCard` in a scrubbed reveal grid; the server's ordered featured set, with the catalogue's visible products as fallback. |

The hero and Beloved Pieces use the SAME server-owned set: products with
`hero: true`, ordered by `heroOrder`. There is no hard-coded product name,
price, image or slug list on the client.

## Catalogue fields

`backend/models/Product.js` adds optional, additive fields:

- `hero` (boolean, default false)
- `heroOrder` (number)
- `tagline` (string)
- `heroCutout` (URL)
- `model` (URL)
- `turntable` (URL array)
- `accent` (hex colour)

`GET /api/catalogue` returns the narrow public projection, with ETag and
`Cache-Control: public, max-age=30, stale-while-revalidate=180`. The portal's
create/detail product forms expose the same fields through
`ProductHeroFields.jsx`. A product write invalidates the `products:` cache
prefix, including the catalogue projection.

Tier 1 is the shipped path: the real main product photograph on the existing
rounded card. Tier 2 (`heroCutout`) and Tier 3 (`model`/`turntable`) are
optional owner-supplied media; nothing in this repository invents them.

## Motion contract

- HERO: load-in clip-path reveal, copy stagger, pointer tilt (9° horizontal /
  5° vertical, 1200px perspective), circular card dissolve, ridge/ring fragments
  lifting into a swirl, incoming product re-form, NEXT glass panel, warm wash,
  light streak, flash and dark-mode variant. Arrows change chapters while the
  hero is focused. `data-hero-mode`, `data-active-chapter` and the `01 / 03`
  progress label are the stable browser hooks.
- REVEAL: pinned depth turn plus circular iris onto the repository's lavender
  photograph. Both images are real; no depth map is claimed.
- CRAFT: four frames unwind with a scrubbed flip/stagger.
- PIECES: existing cards rise with `rotateY/rotateX` and a 0.18s stagger; hover
  tilt is 8° at 1200px; add-to-bag flies a tiny photo clone to the header bag.
- STUDIO: wax-seal stamp with ripples.
- CLOSING: split curtain, box tilt and the existing magnetic CTAs.

Every GSAP initial state is applied inside a `useCinematic` context, so reduced
motion and a failed script leave the finished static page visible.

## Accessibility and fallbacks

- No JavaScript: `frontend/index.html` carries a `noscript` editorial hero with
  the real `/shop`, `/collections`, `/gift-finder` and `/custom-gifts` routes.
- Reduced motion: `StaticHero` only; no pin, no canvas, no pointer tilt.
- No WebGL: `useStageCapability` returns the static hero.
- Fewer than two hero items or a failed catalogue request: static hero.
- Canvas is `aria-hidden`, pointer-events none, capped at DPR 1.5, paused when
  off-screen or the tab is hidden. Active hero image uses catalogue alt text and
  `fetchpriority="high"`.
- Mobile: 340vh pin, 40 fragments, one ring, no pointer tilt.

## Tests

`frontend/e2e/specs/14-cinematic-home.spec.js` (FLOW 40–45) runs against the
isolated E2E stack. `e2e/stack.mjs` flags three seeded products as hero items so
the animated path is exercised, not just the fallback. Coverage:

- FLOW 40: all scenes, catalogue-driven hero, real image sources, no console or
  network errors.
- FLOW 41: three.js/HeroFragments are lazy chunks, absent from entry and
  HomePage bundles.
- FLOW 42: reduced motion shows the finished static hero; CTA navigates.
- FLOW 43: keyboard chapters, NEXT panel, decorative canvas.
- FLOW 44: zero and one hero item fall back to the static hero.
- FLOW 45: JavaScript-disabled fallback renders.

Screenshots of the live hero at the sheet percentages are produced by driving
the E2E preview (12%, 30%, 46%, 62%, 75%); they are review artifacts, not
committed build output.

## Known limits

- The hero is catalogue-driven, but the owner must supply `heroCutout`,
  `model` or `turntable` assets before Tiers 2/3 can be shown. Tier 1 is the
  real photograph.
- The page is a client-rendered SPA. No-JavaScript visitors receive the
  `noscript` editorial fallback, not a server-rendered React page.
- No real-device GPU/Lighthouse run is claimed by the E2E suite; it checks the
  bundle boundary, rendered states, keyboard path and error hygiene.
