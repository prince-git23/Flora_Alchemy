# Flora Alchemy — Storefront UI System

**Audience:** anyone (human or AI) building a customer-facing Flora Alchemy screen.
**Purpose:** one coherent storefront design language, so Home, Shop, Product,
Collections, Search, Wishlist and Public Shop stop looking like different sites.

Read this before touching a storefront page. It is short on purpose.

> **Status legend**
> **Implemented** — in the repository today; follow it.
> **Planned** — agreed direction, not built yet; do not describe it as done.
> **Future** — recorded so it is not invented ad hoc.

---

## 0. The one rule that outranks the rest

**Never invent business data.** Prices, stock, ratings, shop identity, order
state and shipping come from the backend. If the data does not exist, render
nothing — do not fabricate a maker name, a rating, a review count, a customer
photo, a testimonial or a statistic. Trending, "loved by", "1.2k sold" and
similar social proof do **not** exist in this system.

**Premium means better hierarchy, photography, whitespace, typography and
consistency — not more UI.** When in doubt, remove a badge, a card, a divider or
an animation rather than adding one.

---

## 1. Colour — one token vocabulary

**Source of truth:** `frontend/src/index.css` (`@theme` block, plus `.dark`).
**Implemented.**

Never hardcode a colour in a component. Every colour is a `var(--color-*)` token.
There is exactly **one** vocabulary — do not add a second, and do not re-point a
token to a new literal to get a one-off shade.

| Role | Token |
|---|---|
| Page background (L0) | `--color-surface-bg` |
| Cards / content (L1) | `--color-surface-lowest` |
| Inset surfaces (L1.5) | `--color-surface-low` |
| Elevated: modals, dropdowns (L2) | `--color-surface-container` |
| Inputs / controls (L3) | `--color-surface-high` |
| Hover / selected (L4) | `--color-surface-highest` |
| Headings | `--color-botanical-primary` |
| Body text | `--color-botanical-text` |
| Muted text | `--color-botanical-muted` |
| Subtle / meta text | `--color-botanical-subtle` |
| Borders | `--color-botanical-border`, `--color-botanical-border-light`, `--color-border-strong` |
| Focus ring | `--color-focus` |
| Primary button fill | `--color-btn` / `--color-btn-hover` |
| Accent (eyebrow, link) | `--color-accent` |
| Sage (availability signal) | `--color-botanical-sage` |
| Badges | `--color-badge-bg` / `--color-badge-fg` |
| Danger / success surfaces | `--color-danger-soft-bg|fg|border`, `--color-success-soft-bg|fg|border` |

**Adding a token** requires a genuinely missing *semantic role* — and proof,
in the same PR, that no existing role fits. New arbitrary palettes are rejected.

---

## 2. Typography — two families, one scale

**Implemented.** `--font-serif` = Newsreader, `--font-sans` = Plus Jakarta Sans.
**No third family. Ever.** (`--font-display` is an alias of Newsreader.)

- **Newsreader (serif)** — editorial heroes, product names, section headings,
  collection names, major prices on product detail.
- **Plus Jakarta Sans (sans)** — navigation, buttons, labels, filters, metadata,
  forms, status, helper copy, **all prices on cards**.

The scale is named, not improvised:

`--text-display-hero` · `--text-headline-lg` · `--text-headline-md` ·
`--text-headline-sm` · `--text-title-editorial` · `--text-body-lg` ·
`--text-body-md` · `--text-body-sm` · `--text-label-caps` · `--text-label-refined`

**Implemented today:** the scale is applied consistently across the staff/portal
screens. Storefront pages still express many sizes as Tailwind literals
(`text-[15px]`); they cluster on the same values but are not yet tokenised.

**Planned:** migrate storefront headings/body to the named scale so the same
semantic heading is identical on Home, Shop, Product and Collection. Until then:
**match the nearest existing value on the page you are editing — do not invent a
new size.** One paragraph per screen must not introduce a new scale.

---

## 3. Containers

**Implemented** — the primary content container:

```
max-w-7xl mx-auto px-4 sm:px-6 lg:px-8
```

Choose the layout deliberately:

| Layout | When |
|---|---|
| **Contained (default)** | catalogue, product detail, account, cart, forms |
| **Editorial narrow** | long-form story pages, single-column reading |
| **Full bleed** | hero photography, marquee bands, rails that intentionally overflow |
| **Grid** | catalogue / discovery surfaces |

Do not alternate between `max-w-6xl`, `max-w-7xl`, `max-w-[1500px]` and bare
full-width by habit. Deviate only when the content genuinely requires it, and
say why in the PR.

---

## 4. Spacing & rhythm

Sections follow a deliberate ladder, not random gaps: roughly
`24 → 40 → 56 → 72 → 96px`, with larger values reserved for major page divisions
and smaller ones inside a section. A section that needs a unique gap is a signal
the hierarchy is wrong, not that the scale needs a new step.

**Premium is deliberate rhythm, not maximal empty space.** Do not stack 120px
gaps to feel expensive.

---

## 5. ProductCard — one component, three variants

**Source of truth:** `frontend/src/components/ProductCard.jsx` **Implemented.**

Surfaces using it today: **Home** (bestsellers grid), **Shop** (`/shop`,
`compact`), **Search** (`/search`, `compact`), **Wishlist** (`compact`),
**Collections** (featured rail, `compact`), **Public Shop** (`/shops/:slug`,
`shop-context`), **Product detail** (related rail).

**Wishlist now renders the canonical card (Phase 2 — implemented).** The three
things the old bespoke card existed for are preserved explicitly, and must stay
preserved:

- the `[data-wishlist-card]` GSAP stagger hook now lives on the `<li>` **wrapper**
  around each card (the hook is a layout concern, not a card concern);
- the `wishlistUnavailable` retired-product state keeps its own small `<ul>` —
  those rows are not cards and never had a price to show;
- **remove** is the card's filled heart (`toggleWishlist`) and **Move to Bag** is
  the card's Add (`addItemToCart`) — the same two real actions, no third control.

```
<ProductCard product={product} />                        // standard
<ProductCard variant="compact" product={product} />      // dense catalogue grid
<ProductCard variant="shop-context" product={product} /> // a shop's own catalogue
```

**Do not create** `MobileProductCard`, `ShopProductCard`, `WishlistProductCard`
or `ProductCard2`. A genuinely necessary variant is added **to this component**,
as a small controlled flag — never as a parallel copy.

### Canonical information order

1. Product image (the hero — largest element)
2. Product name
3. Price
4. **Real** availability signal
5. Optional Shop attribution — only where it adds context
6. Action (standard variant only)

Removed deliberately, do not reintroduce: palette line, duplicate availability
badges, a "Price" caption, a divider above the price, personalisation pills, a
hover "View details" overlay, long descriptions, invented ratings.

### Variants

- **`standard`** — image, category, name, availability, shop attribution, price,
  wishlist toggle, Add to bag.
- **`compact`** — the same card, **one density step tighter**, for browsing
  surfaces where the shopper scans many pieces: `/shop`, `/search`, `/wishlist`
  and the Collections rail. It drops the category eyebrow, hides the availability
  line unless it carries real state (`made-to-order` / sold out), and tightens
  padding (`p-2 sm:p-2.5`, `pt-2`, `mt-0.5`). It never drops information the
  shopper needs to decide — name, price, real availability and both actions stay
  at full size. **A new variant is a flag on this component, never a new file.**
- **`shop-context`** — the same card **without** the wishlist and bag actions.
  The bag action is withheld because adding to cart from that surface would not
  carry `fulfillmentShopSlug`, which the multi-shop fulfilment flow depends on.
  Do not "restore" it without also solving that.

### Card skeleton (why it is shaped this way)

The price row is `<div className="mt-auto pt-2 …">`. `mt-auto` is deliberate: it
bottom-aligns every price in a grid row so a two-line name cannot push one card's
price below another's. Removing `mt-auto` re-introduces the ragged grid.

The image is always the largest element in the card. If a change makes the name,
the price or the actions visually louder than the photograph, the change is wrong
regardless of how "premium" the new element looks.

### Availability is authoritative

`outOfStock` reads real backend data: the main catalogue publishes `stock`
(via `isOutOfStock`), the shop-scoped projection publishes `inStock`. A
`soldOut` overlay uses `--color-botanical-primary`; in-stock shows the sage
`Made to order` / `Handcrafted` signal. Never a "Sale"/"Bestseller" badge unless
the backend actually has it.

---

## 6. Product images & the gallery contract

**Implemented.** Backend contract: `product.image` mirrors the primary image,
`product.images[]` is the gallery source.

**Collection imagery:** `frontend/src/components/CollectionImage.jsx`
**Implemented (Phase 2).** A collection image is optional and can go stale, so
this shared component renders the image and falls back to a restrained
`Sprout` placeholder on a missing URL **or** an `onError`. **Never** let a broken
collection image render the browser's broken-image glyph. Use it on every
collection tile / featured header instead of a bare `<img>`.

- **Card:** `images[0] || image`, square (`aspect-square`), `object-cover`,
  `loading="lazy"`, graceful missing-image state. Never `src=""`.
- **Product detail:** the full `images[]` gallery.
- **No fake gallery items**, no stock photos, no AI replacements, no screenshots.
  The uploaded catalogue image is authoritative.

⚠️ **Verified quirk:** the shop-scoped list endpoint (`/api/shops/:slug/products`)
returns `images: []` with the URL in `image`, and publishes no `id` (only `slug`).
The canonical card therefore resolves `product.id || product.slug` and
`images[0] || image`. Do not "simplify" those fallbacks away.

⚠️ Note: `img.complete` can read `false` in Chrome even when the bitmap has
decoded and renders correctly (`naturalWidth > 0`). Verify visually before
calling an image broken.

---

## 7. Buttons

**Implemented** — one primary commerce treatment:

| Role | Treatment |
|---|---|
| **Primary** | `bg-[var(--color-btn)] text-white`, `rounded-full`, `hover:bg-[var(--color-btn-hover)]` |
| **Secondary** | transparent + `border-[var(--color-botanical-border)]`, `rounded-full` |
| **Text/link** | `text-[var(--color-accent)]`, underline on hover |
| **Icon-only** | circular, `aria-label` **required** |
| **Danger** | `--color-danger` text on `--color-danger-soft-bg` |
| **Loading** | disabled + spinner, never a layout shift |

The established Flora Alchemy language is the **pill**. Do not mix pill, 8px,
12px and square buttons in the same view. Minimum touch target **44px**
(`.touch-target` exists for this).

---

## 8. Cards vs open sections

**Implemented rules.** Cards are for: products, transactional groups
(cart/order/checkout summaries), forms, and operational information.

Open editorial sections (no card) are for: storytelling, headings, simple
content, and product discovery rails.

**Previous generated designs became too card-heavy.** Not every section is a
card. If a section has one heading and one sentence, it is not a card.

---

## 9. Pills / chips

Pills are for **filters, categories, statuses and compact tags** — nothing else.
They are **not** for headings, paragraphs, CTAs or whole sections. Avoid pill
overload; at most one pill per card, and only when it carries real state.

---

## 10. Elevation, radius, borders

**Implemented.** Depth ladder: **flat → soft → elevated.**

- Flat: editorial sections, rails (no shadow).
- Soft: product cards — `shadow-[0_2px_12px_-4px_...]`, border
  `--color-botanical-border-light`, graduating to a deeper shadow on hover.
- Elevated: modals, dropdowns, drawers.

No glassmorphism, no heavy drop shadows, and never a different shadow language
per page.

**Radius:** pills `rounded-full` (buttons, chips), cards `rounded-2xl`,
large editorial surfaces `rounded-3xl`. Do not introduce arbitrary values
(`7px`, `11px`, `13px`…).

**Borders:** always a border token. A hardcoded light hex (e.g. `#e0dcd6`) is a
dark-mode bug — it was found and fixed on the wishlist surface.

---

## 11. Motion — GSAP foundation

**Source of truth:** `frontend/src/lib/gsapSetup.js`. **Implemented.**

```js
import { gsap, ScrollTrigger, prefersReducedMotion, isDesktop, setupCardDepth } from '../../lib/gsapSetup.js';
```

Registered once at app startup. Small helpers only — **do not build an animation
framework.** `setupCardDepth(el)` returns a dispose function; always call it from
the effect's cleanup.

### Interaction levels

| Level | Surfaces | Motion |
|---|---|---|
| **0** | Checkout, forms | minimal — feedback only |
| **1** | Search, Wishlist, Account | subtle transitions |
| **2** | Shop, Collections, Public Shop | card depth, image movement, GSAP reveals |
| **3** | Home, Product detail | layered botanical depth, parallax, gallery motion, editorial transitions |

### ProductCard spatial behaviour

**Desktop fine-pointer only, at most 1.5° of tilt**, a small lift and shadow
refinement. Touch devices never tilt. `prefers-reduced-motion` disables it
entirely. No flipping, no dramatic rotation, no permanent animation.

**No Three.js.** CSS + GSAP cover every current requirement.

### Performance contract

Every animation must clean up: `gsap.context()`, `ScrollTrigger.kill()`,
listener removal, RAF cancellation. No orphaned ScrollTriggers, no layout
thrashing, no runaway RAF loops.

⚠️ **Known duplication (partly resolved).** `WishlistPage` was migrated onto the
shared module in Phase 2. Several other pages still import `gsap`/`ScrollTrigger`
directly and re-derive `prefersReducedMotion` locally. Prefer the shared module
when you touch one of them; do not mass-rewrite pages in a single change.

### Filtered grids must reset their own tweens

A grid whose contents change (a category filter, a sort, a search) animates into
place with `gsap.context()` scoped to a ref, calls `ctx.revert()` in the effect
cleanup, and uses `clearProps: 'transform,opacity'` on the tween. Without this a
second filter change stacks a tween on an element still holding the first one's
`opacity: 0`/`transform`, and cards can be left faded or permanently translated.
This was a measured defect on `/shop` before Phase 2; it is fixed and re-measured
(0 faded, 0 inline transforms after rapid filter churn).

---

## 12. Responsive foundation

**Implemented breakpoints to hold:** 360 · 390 · 430 · 768 · 1024 · 1280 · 1440.

- **Mobile is not a compressed desktop.**
- Products: **2 columns** on phones (the full catalogue ladder is in §19).
- Every control ≥ **44px** touch target.
- Horizontal rails swipe naturally (`overflow-x-auto`, `scrollbar-none`).
- Text must never clip; images must preserve composition.
- Forms must never cause horizontal overflow.

---

## 13. Dark mode

**Implemented.** Light, dark and system are all first-class. `.dark` re-points
every semantic token, so a component built from tokens works in both themes
automatically. Hardcoded hexes are the only way to break this — don't.

---

## 14. Accessibility

**Implemented foundation:**

- Visible focus via `focus-visible:ring-2 ring-[var(--color-focus)]` — never
  remove a focus outline without an equivalent replacement.
- `aria-label` on icon-only controls; `aria-expanded` / `aria-pressed` /
  `aria-invalid` / `aria-describedby` where the state applies.
- Dialogs: focus trap, `Escape` to close, focus returned to the trigger
  (see `SearchOverlay`).
- Reduced motion honoured in CSS **and** in JS helpers.
- `.touch-target` for 44px minimums, and a **24px minimum hit area for
  standalone text links** (WCAG 2.5.8). `ShopAttribution`'s link uses
  `inline-flex items-center min-h-[24px]` for exactly this reason — a bare
  12px text link measured 18px tall and failed the repo's own sub-24px phone
  audit. Keep it.

---

## 15. Shop attribution

**Source of truth:** `frontend/src/components/ShopAttribution.jsx` **Implemented.**
Used by `ProductCard`, Product detail, Search, Gift Finder and the shop surfaces.

Contract: `shop: { slug, displayName }`. Renders **nothing** when the backend
could not resolve an ACTIVE shop. Never expose `workspaceId`. Never invent
"Independent Maker", "Local Artisan", "Flora Studio" or any fallback identity.

---

## 16. Data / UI separation

A visual component is never the authority for business data:

| Data | Authority |
|---|---|
| Price, catalogue | backend Product |
| Stock / availability | backend Inventory (`stock`, `inStock`) |
| Rating | backend review aggregate |
| Shop identity | backend Shop (`{slug, displayName}`) |
| Order state | backend Order |
| Shipping & totals | workspace Settings / server order calculation |

Hardcoding any of these into a component is a defect.

---

## 17. Icons

Lucide is the storefront icon system. **Do not mix a second icon set, Unicode
glyphs and emoji inside one component.**

⚠️ **Known inconsistency (documented, not yet resolved).** Material Symbols is
still loaded and used in the admin/portal area and on a few storefront pages
(`ShopWorkspaceGate`'s error state, `CustomRequestPage`, `LoginPage`,
`PortalGatewayPage`), while storefront components use Lucide. Phase 2 moved
`ShopWorkspacePage` (empty/error states included) onto Lucide; its resolved
states now use no Material Symbols at all (measured: **0** on the surface, 21
Lucide icons).
Fix this **only where you are already establishing the shared system** — do not
mass-rewrite unrelated pages. Full storefront icon unification is **Planned**.

---

## 18. What not to do

Do not make the site feel "more premium" by adding: more cards, more gradients,
more animations, more badges, more statistics, more sections, more 3D, fake
testimonials, fake ratings or fake customer content.

Do not add a bottom navigation bar. The existing Navbar is the global navigation.

---

## 19. Catalogue & discovery surfaces (Phase 2) — Implemented

**Scope of this section:** `/shop`, `/shops/:slug`, `/collections`, `/wishlist`,
`/search`. These five surfaces are one system; a change to one is a change to the
hierarchy below.

### The catalogue grid ladder

`grid-cols-2 md:grid-cols-3 xl:grid-cols-4` — and nothing else. Measured: **2**
columns at 360/390/430, **3** at 768 and 1024, **4** at 1280/1440.

Only two overrides are legitimate, and both exist to stop a thin result set from
stretching across a full four-column row:

- exactly **1** result → one column, `max-w-[420px] mx-auto`;
- **2–3** results → `grid-cols-2 md:grid-cols-3`.

Do not invent `grid-cols-5`, do not switch density per page, and do not let the
grid column count become a prop. `compact` cards for dense browsing surfaces,
`standard` for a home-style showcase — that is the only density decision.

### `/shop` — the catalogue

- Compact hero (copy unchanged). The catalogue below it is the point.
- **Category rail** carries real counts from the *visible* catalogue. Its active
  state is `--color-surface-highest` + `--color-border-strong`, **not** a solid
  accent pill: colour should be the last thing carrying state on this page.
- **Toolbar order** is deliberate (flex `order-*`): mobile is search → count ·
  Filters · Sort; desktop is count · search · Sort · Filters.
- **Active-filter chips** appear when *any* filter is active and always include a
  `Clear all`. A category-only or search-only state with no way out was a real
  defect found in Phase 2 testing — never reintroduce it.
- The mobile filter panel is a **sheet**: `role="dialog" aria-modal="true"`,
  `Escape` closes it, `body` scroll is locked while open, and its CTA states the
  real result count ("Show 16 results").
- Removed on purpose, do not restore: the "Atelier Highlights" filler list in the
  filter panel, and the "All prices in ₹ INR" line.

### `/shops/:slug` — a shop's public address

- **Identity header:** eyebrow + `displayName` + real `N pieces · M collections`
  derived from that shop's own data.
- **`storeTagline` is deliberately not rendered.** `GET /api/shops/:slug/settings`
  falls back to the platform singleton's tagline, so rendering it would attribute
  platform copy to a shop. Do not "restore" it without a shop-owned tagline field.
- **Collection tiles filter the catalogue in place** — a `<button aria-pressed>`,
  not a link — with an "All pieces in {name}" reset. No route change, no reload.
- The catalogue is `shop-context` cards (no bag/wishlist controls, see §5), and an
  `aria-live` count announces what is currently visible.
- **Layout must be reserved.** The resolver gate's loading state is `min-h-screen`
  and the page keeps a skeleton while it hydrates, because at `60vh` the footer
  was still on screen and the whole band shifted when the page arrived (measured
  **0.7582 CLS** → **0** after the fix). Anything that reintroduces a short
  placeholder on this route is a layout regression.

### `/collections` — editorial discovery

- Header states real totals; a **numbered collection index** anchors to
  `#collection-<slug>`.
- **Exactly one featured collection, chosen by a real rule** (most pieces, name as
  the tie-break) — never hand-picked prose.
- The featured collection's own rail shows its **real** pieces (`slice(0, 4)`). No
auto-scroll, no invented ordering, no filler.
- Every remaining tile shares **one aspect ratio** (`aspect-[4/3]`). Mixed ratios
  are what made the page read as template-generated.
- Tiles link to `/shop?category=<a real category>` (or `/shop`) — never to a
  category the catalogue does not have.

### `/search` — a utility, not a showcase

Heading → input (autofocused, 44px clear control) → real `Try:` suggestions →
scope pills → **real** sort select (`relevance` / `price-asc` / `price-desc` /
`name-asc`) → `aria-live` count → `Clear all`. The empty state must offer real
recovery: clear the query, browse the shop, and the actual categories with their
actual counts. Motion is **Level 1**.

### `/wishlist`

Canonical `compact` cards (see §5), the header's **Move all to bag** action, the
`wishlistUnavailable` retired block, and compact editorial empty states —
including the state where only retired items remain. Motion is **Level 1**.

### Mobile catalogue rules

Phones get **2 columns**, never 1 card per row on `/shop`; the compact card must
stay ≥ ~150px wide at 360. The filter panel is a sheet, every control is ≥44px,
and no text may clip. A phone is a browsing surface here, not a shrunken desktop.

---

## 20. Verification status (what has actually been measured)

Recorded so nobody re-litigates this. **Implemented + verified.**

### Phase 1

- **Responsive sweep** on `/shop` at 360 · 390 · 430 · 768 · 1024 · 1280 · 1440:
horizontal overflow **0** at every width; card grid **2 cols** on phones, 3 at
768/1024, 4 at 1280/1440; no element wider than the viewport at any width.
- **Public Shop** (`/shops/:slug`) with a real ACTIVE shop: 3 canonical cards,
correct names/prices, **no** bag or wishlist control (shop-context working),
correct `/product/<slug>` links, all images in square boxes, overflow 0.
- **Tilt:** measured `rotateY(1.5deg) rotateX(1.5deg)` at the card corner — the
ceiling is exactly 1.5° — symmetric on the opposite corner, 0° at centre, 4px
lift, and `pointerleave` clears the transform.
- **Touch targets:** sub-24px interactive elements on a phone viewport went
**3 → 0** after the ShopAttribution hit-area fix.
- **Dark mode:** card surface / border / name / price all resolve from the dark
tokens (`#141210` body, `#1f1c19` card, `#f7f4ef` heading, `#2e2a25` border),
contrast 216/216/211, **zero** hardcoded light-surface leaks inside cards.
- Also measured overflow-free at 390 on `/search`, `/wishlist` and product detail.

### Phase 2 — the five discovery surfaces

Measured in a real browser against a local stack (backend on `:4000`, Vite dev on
`:3000`, and the **real production bundle** via `vite preview` on `:4173`, built
with `VITE_API_URL=http://localhost:4000/api`).

- **Responsive sweep, 5 routes × 7 viewports** (360 · 390 · 430 · 768 · 1024 ·
  1280 · 1440): horizontal overflow **0** everywhere; **0** elements wider than the
  viewport; **0** sub-24px interactive targets at any width.
- **Grid ladder held:** `/shop` and `/search` 2 cols at 360/390/430, 3 at 768, 3 at
  1024, 4 at 1280/1440; `/shops/:slug` 2 / 3 / 3 / 4; `/wishlist` 4 cols at desktop
  with its `[data-wishlist-card]` stagger settling at `opacity: 1`.
- **`/shop` card box:** 155×261 at 360 (image 138×138) → 289×398 at 1440.
- **Rails are real overflow rails:** category rail `1289/353` (scroll/client) at
  390; the Collections featured rail is 4 columns (`display: grid`) at 1440 and a
  snap rail below `sm`.
- **Tween cleanup:** after 4 rapid category changes + a reset on `/shop` — **0**
  faded cards, **0** inline transforms, **0** zero-width cards.
- **`/shops/:slug` CLS:** **0** at 1280×900 with the production bundle (was
  **0.7582** across 4 shifts before the gate/skeleton fix).
- **Performance (`/shop`, production bundle):** TTFB 5ms, DOMContentLoaded 31ms,
  load 31ms, 578 DOM nodes, LCP ≈ **488ms** (the first product image), CLS
  **0.0926** — that residual comes from the product grid's entrance images, not
  from the hero.
- **Dark mode on the redesigned `/shop`:** `theme=dark`, body `rgb(20,18,16)`,
  card `rgb(31,28,25)`, border `rgb(46,42,37)`, name/price `rgb(247,244,239)`,
  **0** hardcoded `#fff`/`#000` leaks; toggling back to light restored
  `rgb(252,249,244)` / `rgb(255,255,255)` / `rgb(24,15,10)`.
- **Wishlist end-to-end with real saved items** (DEV demo customer): 3 canonical
  cards; the card's Add moved the bag 2 → 3 lines (₹3,700 → ₹5,550); the card's
  filled heart removed 3 → 2 → 0 and the empty state appeared.
- **`/shop` behaviour:** 16 pieces → Flowers & Bouquets 4 pieces + `?category=`;
  `price-desc` → ₹2,200/₹2,150/₹1,850; search "posy" → 3 real matches; a
  category-only state shows a chip **and** `Clear all`, and clearing returned to 16
  pieces with an empty query string.
- **Filter panel:** desktop panel opens with `aria-expanded=true` and all three
  real selects; the mobile sheet is `role="dialog" aria-modal="true"`, locks
  `body` scroll, and `Escape` closed it and restored scrolling.
- **`/search`:** `price-desc` → ₹3,450/₹2,200; "In stock" scope → 15 pieces;
  `Clear all` → "16 pieces in the catalogue".
- **Public shop domain states rendered for real:** a sold-out piece shows the
  "Sold out" overlay + "Currently unavailable", a `stockTracked: false` piece
  shows "Made to order", and shop-context cards expose **0** bag/wishlist
  controls.

### Not measured — do not claim it

- A browser test with `prefers-reduced-motion: reduce` actually **forced on**. The
guard is present in both CSS and `setupCardDepth`, and is verified by code
inspection only. Touch tilt likewise cannot be emulated in this environment.
- **Staging/preview deployment has not happened** — Phase 2 has not been pushed,
so **no hosted preview build of these pages exists**. Local production-bundle
checks (`vite preview`) are the closest evidence available.
- Any `/search` result for "Gift Finder" is a 20px text link — pre-existing,
outside the card system.

Do not change pricing, payments, inventory, order ownership, workspace
authorization, customer identity, shop resolution, checkout rules or
custom-request ownership for visual reasons.
