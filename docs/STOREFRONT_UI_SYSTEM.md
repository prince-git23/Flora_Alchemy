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

**The header wordmark is measured, not guessed.** "Flora Alchemy" needs **100 px**; at
320 / 360 / 375 px the header has **34 / 74 / 89 px** left once search, theme, saved, bag,
account and the menu button are placed, so it was rendering `Flo…`. Below **400 px** the brand
link keeps the 24 px logo mark and its `aria-label` and does not render the string at all —
a truncated brand is worse than a mark-only header, and the utilities (which are shopping
paths) keep their room. Do not "fix" this by shrinking the type: the shortfall at 320 px is
66 px, which no font size recovers. Verified 320 → 1920 with no clipped text and no
horizontal overflow.

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
- **The catalogue query lives in the URL** — `category`, `occasion`, `recipient`,
  `availability`, `sort` and `q` (the catalogue search text). The address bar is
  the single source of truth: state is seeded from it at mount (so a filtered
  deep link never flashes an unfiltered grid) and re-read whenever it changes,
  so Back/Forward, a reload, a shared link and the navbar/footer "All Gifts"
  link to a bare `/shop` all land on the view the URL describes. Continuous
  controls write with `replace` (typing), discrete ones push. **`maxPrice` is the
  documented exception**: the price slider stays local, because a history write
  per pointer frame of a drag is not worth Safari's `replaceState` throttling;
  its parameter is honoured at mount for gift-finder deep links and cleared with
  everything else by Reset.
- **Browsing context survives a product visit (Phase 6).** Open a piece from the
  catalogue and press Back: the query, the chosen order and the reading position
  come back with it. The shell restores scroll per history entry; never
  "simplify" that back to a blanket `scrollTo(0, 0)` on every location change,
  which is what used to discard the customer's place on the page.
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
`name-asc`) → `aria-live` count → `Clear all`. `q`, `scope` and `sort` are
URL-backed under the same rule as `/shop` — including the case a mount-only read
would miss: the nav search overlay pushes a new `?q=` onto `/search` while the
page is already open, so the page follows the URL rather than its first render.
The empty state must offer real recovery: clear the query, browse the shop, and
the actual categories with their actual counts. Motion is **Level 1**.

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

### Phase 3 — the six conversion surfaces

Measured the same way: a **local production bundle** (`vite preview` on `:4173`,
built with `VITE_API_URL=http://localhost:4000/api`) against the real dev API.

- **Responsive matrix, 6 routes × 14 viewports + a dark pass.** The repo's own
  CDP harness (`frontend/scripts/responsive-audit/run.mjs`) was extended with the
  Phase 3 routes (`p3-product`, `p3-gift-finder`, `p3-custom-request`, `p3-cart`,
  `p3-checkout`, `p3-tracking`, run with `--only=p3-`) and with the contract's
  `360×800` viewport. Result: **108 runs, 0 fails, 0 horizontal overflow at every
  viewport, 0 sub-24px touch targets**. The harness found three real defects,
  all fixed and re-verified to green: the Custom Request step rail pushed past
  the right edge on phones (`3Review & send` reaching `right=395` in a 314px
  viewport), Checkout's `← Back to Cart` was a 15px-tall link, and Custom
  Request's `Back to Shop` was 18px tall.
- **CLS on `/product/:id`: 0.6663 → 0.0.** The old loading skeleton was
  `max-w-6xl lg:px-10 lg:grid-cols-2` while the loaded page is
  `max-w-7xl lg:px-8 lg:grid-cols-12`, so the hero was re-laid-out when data
  arrived (the shift source was the grid going `0x0@0 → 753x678@216`). The
  skeleton now mirrors the loaded geometry exactly and the page records **0
  shifts**.
- **Performance (production bundle):**

  | Route | TTFB | FCP | LCP | CLS | Nodes |
  |---|---|---|---|---|---|
  | `/product/dusty-rose-lavender-posy` | 7ms | 233ms | 233–656ms | **0.0** | 605 |
  | `/gift-finder` | 9ms | 638ms | 1268ms | **0.0** | 281 |
  | `/cart` (populated) | 9ms | 226ms | 226ms | **0.0** | 281 |
  | `/checkout` (step 1) | 8ms | 87ms | 540ms | **0.0004** | 147 |

  Product-detail LCP is the **eager, `fetchpriority="high"` primary gallery
  image**, i.e. the right element. CLS is at or below Phase 2's `/shop` (0.0926)
  on every Phase 3 surface.
- **INP:** Performance Event Timing is supported in this environment, and across
  real pointer interactions (Gift Finder radio selection + Continue) **no entry
  reached the 16ms reporting threshold**, so every measured interaction was
  <16ms — an order of magnitude under the 200ms "good" bound.
- **Dark mode, product detail + review layer:** with `data-theme="dark"`, body
  `rgb(20,18,16)`, `h1` `rgb(247,244,239)`, review card
  `rgb(31,28,25)` / border `rgb(58,53,48)` / text `rgb(242,239,233)`, and across
  319 elements **0** pure-white surfaces and **0** near-black
  (`rgb(24,15,10)`) text — the two leaks a light token would leave.
- **Reduced motion, behavioural (not just code inspection):** patching
  `window.matchMedia` to report `prefers-reduced-motion: reduce === true`, then
  driving a real Gift Finder step transition, changed the step (1 → 2) while
  **0 elements received GSAP inline `transform`/`opacity`**. The preference
  suppresses the tween rather than merely being read.
- **Review moderation, end to end against the live API:** `HIDE` → the public
  product read dropped `count 1 → 0`, `average 4 → 0`, distribution zeroed and
  the card disappeared; the `hidden` tab count went `0 → 1` and `published` went
  `2 → 1`; `RESTORE` returned everything exactly; an invalid status is `422`, an
  unknown id is `404`. Moderation rows expose no customer id.
- **Review media, end to end through the real `postForm` XHR transport:** a PNG
  and an MP4 both uploaded to **ImageKit** (`…/products/reviews/…` for video),
  with `upload.onprogress` reaching 100. Browser pre-checks reject a `text/plain`
  photo, a `video/x-msvideo` clip and a 30MB file, and the **server** independently
  rejects the wrong media type on each endpoint (`422 Unsupported video type` /
  `Unsupported image type`) — the separate multer instances are doing their job.
- **Backend regression:** `node scripts/run-all.mjs` → **20 suites, 1699 pass /
  0 fail, EXIT=0** after the Phase 3 model/controller/route changes.
- **Frontend build:** `npm run build` green after the final change.

### Not measured — do not claim it

- `prefers-reduced-motion: reduce` is now verified **behaviourally** on the
  Gift Finder (see Phase 3 above: the preference suppressed the tween and 0
  elements took inline animation styles), but it is still verified by
  **inspection** on the remaining Phase 1/2 surfaces — `/shop`, `/search`,
  `/wishlist` and the four editorial pages. Touch tilt likewise cannot be
  emulated in this environment.
- Four pages still register ScrollTrigger themselves instead of importing the
  shared module: `FloraJournalPage`, `HowItsMadePage`, `NotificationsPage`,
  `OurStoryPage`. All Phase 1/2/3 conversion surfaces use `lib/gsapSetup.js`;
  those four are editorial pages outside the Phase 3 boundary and are left alone
  deliberately, not overlooked.
- **Staging/preview deployment has not happened** — Phase 2 has not been pushed,
so **no hosted preview build of these pages exists**. Local production-bundle
checks (`vite preview`) are the closest evidence available.
- Any `/search` result for "Gift Finder" is a 20px text link — pre-existing,
outside the card system.

## 21. Product detail hierarchy (Phase 3) — Implemented

The purchase panel is one column and the order is fixed, because a customer
reads it as a sentence:

```
name → price → availability → shop attribution → purchase facts
      → personalization → gift message → delivery → quantity → Add to Bag
```

- **Delivery sits above quantity and the CTA**, never below the fold of the
  decision: the customer must know *can it reach me* before committing.
- **The primary CTA dominates.** Wishlist and every secondary action are
  visually subordinate; `Add to Bag` is never pushed under editorial content.
- **On mobile the CTA is not detached from the product** — the sticky bar only
  exists because it keeps the action reachable while the gallery scrolls past.
- Below the panel: craft/story → care & details → personalization → reviews →
  Complete the Gift → related discovery. Sections that have no real content do
  not render; an empty accordion is worse than none.
- **Gallery:** `product.images[]` with `product.image` as the fallback, one
  large primary plus a thumbnail rail. The primary image is the only
  `loading="eager"` + `fetchpriority="high"` image on the page — it *is* the
  LCP element. Everything else is `lazy` + `decoding="async"`.
- The lightbox contract is the same as Phase 1: `role="dialog"`, labelled close,
  `Escape` closes, arrows page through, focus is trapped and **returns to the
  element that opened it**. Videos never autoplay.

## 22. Review trust layer (Phase 3) — Implemented

Reviews are **trust, not noise**: they must never be visually louder than the
product. Hierarchy is summary → distribution → media/filter → individual cards.

- `ReviewSummary`, `ReviewCard`, `VerifiedPurchaseBadge`, `ReviewMediaGallery`,
  `ReviewMediaViewer`, `ReviewForm`, `HeartRating`, `ReviewsSection` live in
  `frontend/src/components/reviews/` — one implementation, composed by
  `ProductPage`. There is no `ReviewCard2`.
- **Numbers come from the server** (`summary.count`, `summary.average`,
  `summary.distribution`). An empty collection renders an honest "be the first"
  state; nothing is fabricated.
- **Verified purchase is backend-derived** and the badge only renders when the
  API says `verified`. The browser never decides it.
- **Media:** photos are capped at 4 × 5 MB, videos at 1 × 25 MB with
  `video/mp4|webm|quicktime`. Validation runs twice on purpose — the browser
  refuses a wrong file instantly, the server enforces the same whitelist
  regardless of what the client claims.
- **One multipart transport.** `apiClient.postForm()` is the only upload path
  (XHR, because `fetch` has no upload progress); both review media and any
  future upload go through it. Do not add a second HTTP client.
- **Hidden reviews are invisible everywhere.** `PUBLIC_REVIEW = { status:
  { $ne: 'HIDDEN' } }` is the single visibility rule used by the public list,
  count, recommendation and distribution — deliberately `$ne` so documents
  written before `status` existed still render.
- **Moderation** is `/admin/reviews` (Published / Hidden / Reported), served by
  `adminReviewRoutes` behind `protect` + `adminOrHandler` (delete additionally
  requires `admin`). Rows are projected without customer ids. Reporting is
  idempotent per reporter and never edits the review body.

## 23. Gift Finder interaction (Phase 3) — Implemented

One decision per step, five steps, five or fewer choices each:

```
Who is this for? → What's the occasion? → What feeling should it create?
                 → What's your budget?   → How personal should it be?
```

- Each step is a `role="radiogroup"` of **native radios** styled as large
  tiles — arrow-key navigation and a single tab stop come for free, and the
  whole tile (well past 44px) is the target. Selected state is carried by the
  native `checked`, never by class alone.
- Progress is a numbered rail where completed steps are re-openable and future
  steps are not, plus a bar and an `sr-only` status line announcing the step.
- Results use the **canonical `ProductCard`**. The old bespoke
  `GiftResultCard` is gone; there is still only one card in the codebase.
- **Explanations are factual labels, not prose.** Each result shows a "Matches:"
  line built from dimensions the scorer genuinely matched —
  `₹1,000 – ₹2,000 · Anniversary · For a Partner · Soft & Romantic` — emitted by
  `scoreProduct()` only when the derivation actually hit. No AI-sounding
  sentence, no "perfect for your thoughtful soul".
- Motion is Level 2–3: hero stagger, slide+fade between steps (direction
  aware), staggered results reveal. The step transition never blocks input.
- Budget is addressed by name (`BUDGET_STEP`), so "Adjust Budget" can never
  land on the wrong question after a step reorder.

## 24. Custom Request interaction (Phase 3) — Implemented

The backend workflow (Product → Custom Request → Proposal → Order → Payment →
Fulfillment) is untouched. What changed is the asking: **three compact steps
instead of one twelve-field form**, and the submitted payload is identical.

1. **Your idea** — description (live counter, 10-char minimum), occasion, budget
2. **Reference & details** — palette, date, optional reference image
3. **Review & send** — the shop that will make it, a real summary, submit

- A completed step is re-openable; the submit path is unchanged, and validation
  failures send the customer **back to the step that needs the fix**.
- **The reference image has two real paths and one stored value** — a validated
  upload, or the customer's own link (re-validated server-side). Removing clears
  it, so a removed image is never sent.
- **No invisible upload.** The drop zone shows, for every state: idle
  (`Drop an image here, or browse` + type/size limits), uploading (file name,
  live percentage, a real progress bar), success (preview + `name · size`),
  failure (`role="alert"` with the server's message) and removal.
- The file input lives **inside** the zone so `focus-within` paints the focus
  ring on the whole drop target — a keyboard user tabbing to *browse your files*
  sees where they are.
- Client pre-checks on type and size exist only for a fast message; the server
  re-validates both.

## 25. Cart & checkout hierarchy (Phase 3) — Implemented

**The three money figures are named distinctly so they can never be confused:**

| Figure | Where | Meaning |
|---|---|---|
| Bag subtotal | summary column | every line in the bag |
| Shop subtotal | each shop group header | what this one shop will charge |
| Order total | checkout, computed by the server | per shop, after delivery |

- Cart keeps Phase 2/20 architecture intact: global bag → shop groups →
  per-shop checkout → stale-stock reconciliation → partial clearing after a
  settled checkout. **Do not merge the groups.**
- A shop whose line is out of stock, short, or no longer available blocks
  *that* group's checkout with an inline, actionable fix (`Reduce to 3`,
  `Remove`), never a raw error at the final Review step.
- **Motion is Level 1:** quantity changes bump the number; removing a row
  collapses it (`height/padding → 0`, then the store mutation in
  `onComplete`, so the bag is only changed once the animation finishes);
  groups fade in. Under reduced motion the row is removed immediately and no
  tween is created.
- **Checkout is Level 0** — deliberately no entrance animation on a payment
  surface. GSAP and ScrollTrigger were imported there without ever animating
  anything, and were removed.
- Stock/warning states use the semantic `--color-warning-soft-*` trio and field
  errors use `--color-danger*`; raw `amber-*`/`red-*` utility colours are not
  used on Phase 3 surfaces because they do not respond to the theme.
- Payment authority stays on the server: amounts are recomputed from the stored
  order total, signatures verified server-side, endpoints idempotent. The
  frontend never retries an order into existence.

## 26. Media performance rules (Phase 3) — Implemented

- **Every media box reserves space before it loads.** Fixed aspect ratios on
  product images, gallery and thumbnails; review cards do not change height
  when their media arrives. The Phase 2 CLS lesson was not re-learned — but the
  `/product` skeleton *was* a repeat of it (a differently-shaped loading state),
  which is why §20 records 0.6663 → 0.0.
- **A loading skeleton must mirror the loaded layout's geometry** — same
  container, same column split, same breadcrumb line. Reserving a box costs
  nothing; re-creating it costs CLS.
- **One eager image per page, and it should be the LCP element.** Everything
  below the fold is `loading="lazy" decoding="async"`.
- **Never autoplay video**, with or without sound. Review videos use native
  controls and play only on explicit user action.
- No 3D scene, no parallax gallery, no scroll-hijacking on a purchase surface.

Do not change pricing, payments, inventory, order ownership, workspace
authorization, customer identity, shop resolution, checkout rules or
custom-request ownership for visual reasons.

## 27. Route-chunk loading placeholders (Phase 5) — Implemented

Every page is `lazy()`-loaded, so a client-side navigation shows the `<Suspense>`
fallback while the destination's chunk downloads. That fallback now lives in
`components/RouteSkeletons.jsx` and is **chosen from the destination**, so what the
visitor sees while waiting resembles the page they asked for instead of one generic
grid:

| Route | Placeholder |
|---|---|
| `/product/:id` | gallery + thumbnail rail beside the purchase panel |
| `/shop`, `/search`, `/collections`, `/shops/:slug` | toolbar + product grid |
| `/cart` | item rows beside the order summary |
| `/checkout` | progress stepper + address/delivery form + review summary |
| `/account*`, `/order-success*`, `/order-tracking*`, `/notifications`, `/wishlist`, `/order/:id/conversation` | sidebar navigation beside a content/list panel |
| `/admin*`, `/owner*`, `/staff*` | stat cards + data table |
| `/login`, `/access`, `/portal`, portal logins, `/apply/admin`, `/admin/activate*` | one centred form card |
| everything else (home, editorial, gift finder, studios, request intake) | hero composition over content sections |

Rules that keep this from regressing §26:

- **Only the existing primitives.** `Skeleton`, `SkeletonText`, `SkeletonCircle`,
  `SkeletonCard`, `SkeletonRow`, `SkeletonTable` and the existing `--color-*`
  tokens. No second skeleton library, no animation framework, no new dependency.
- **Same frame as the page.** One `max-w-7xl` container with the shell's padding, so
  the placeholder and the real page share a left edge.
- **Same DOM order as the page**, so on a phone the first viewport holds the
  primary content (gallery, bag rows, checkout form) and secondary panels follow.
- **No data, no preloading.** The placeholders are `aria-hidden` inside one polite
  `role="status"` region; nothing is fetched or inferred for them, and the real
  pages' image lazy-loading is untouched.
- This is the CHUNK placeholder only. The data-hydration skeleton
  (`BootstrapSkeleton variant="route"`, rendered by `RouteBootstrapGate`) is a
  separate state with its own accessible name, and the two are never merged.

## 28. Price transparency, the reprice stop & bag price facts (Phase 7) — Implemented

Phased commitment: e43f7ab (feat(phase7): show the shop's confirmed figures before any payment is taken) on branch phase-7-checkout-confidence, built on Phase 6 checkpoint b7973b8, built on Phase 4 checkpoint 15180c5 (origin/main as fetched 2026-10-10).

Acceptance criteria (as committed and as recorded here):

1. **Two vocabularies, never mixed.** Before an order exists the review summary labels its figure `Estimated Total`; once the shop created the order the same row is labeled `Confirmed Total` and shows the server's own subtotal/shipping/tax/total. The old label `Total Due` is gone.
2. **Tax rendered only when the server carries one.** No public shop setting exposes tax, so the page never estimates a tax row; it renders only when the order was created with one.
3. **Reprice stop.** When `POST /orders` creates an order whose total differs from the estimate shown, the page does not open the payment provider. It shows the shop's own figures — items, delivery, (tax if any), confirmed total, the reserved order reference, and what the customer was shown — and continuing is an explicit action (`Continue to Pay ₹…`, or `Confirm Order · ₹…` for Pay on Delivery). Nothing is charged before that click.
4. **One order per checkout, always.** Retrying a failed payment, continuing past the reprice stop, and resuming a reloaded checkout are one code path against the same order reference. No duplicate order, no second stock deduction. When the checkout already owns an order, both review-step primary actions stop being submit buttons; they read `Continue payment · ₹…` from a single shared label and pay that order. Enter in any field implicitly submits the first button, so a stale submit would otherwise create a second order and hold stock twice. `handlePlaceOrder` refuses to run order creation at all while this checkout owns an order.
5. **Order reference is the precious bit.** A newly reserved order is written to the checkout snapshot immediately (not behind the 250ms debounce), because losing it is what makes a reload create a second order.
6. **Failed settings read is not permission.** If `/shops/:slug/settings` cannot be loaded, the checkout says the shop's availability could not be confirmed, says the totals are an estimate, and offers a retry; it never implies ordering is open. The server still refuses a closed shop at creation.
7. **Delivery windows from settings, not copy.** The hardcoded "3 to 5 business days" and "tracked securely" promises are gone; the standard window renders from `shippingConfiguration.standardDays`, the express window from `expressDays`, and the trust line promises only what the app provides.
8. **Bag price facts.** A line shows its unit price and the multiplication (`2 × ₹1,850 each`) beside the line total, one rendered branch per breakpoint, never both.
9. **Payment-state separation preserved.** Creation succeeds without a confirmed payment; when no provider is configured the order keeps its documented `Sample` settlement and the confirmation reads that honestly. Only a server-verified capture renders as paid; nothing does so from navigation or a client event.

The customer must never be sent into a secure window asking for an amount they
have not been shown, and a bag total must never be presented as a final order
total. The shop remains the only authority on what an order costs.

**Two vocabularies, never mixed.** Before an order exists the review summary
labels its figure **`Estimated Total`** — the shop's stored settings read
client-side, which is an estimate and is named as one. Once the shop has created
the order, the summary labels the same row **`Confirmed Total`** and shows the
server's own `subtotal` / `shipping` / `tax` / `total`. `Total Due` (the old
label) is gone: a bag subtotal is not a final total. A **Tax** row renders only
when the server's order carries one — no public shop setting exposes tax, so the
page never estimates it.

**The reprice stop.** `POST /orders` recomputes everything server-side; when the
created order's total differs from the estimate the page displays (a
shop-configured tax an estimate cannot see, an edited price, a changed delivery
rate), it **does not open the payment provider**. It renders the shop's own
figures — items, delivery, tax, confirmed total, and what the customer was shown
— plus the reserved order reference, and continuing is an explicit action
(`Continue to Pay ₹…`, or `Confirm Order · ₹…` for Pay on Delivery). Nothing is
charged before that click.

**One order per checkout, always.** Retrying a failed payment, continuing past
the reprice stop and resuming a checkout whose order survived a reload are one
code path (`payExistingOrder`) against the SAME order reference: no duplicate
order, no second stock deduction. When the checkout already owns an order, BOTH
primary actions the review step renders (in the payment card and in the summary)
stop being submit buttons — they read `Continue payment · ₹…` from a single
shared label and pay that order. Leaving one behind would not be cosmetic:
Enter in any field implicitly submits the first button, so a stale submit would
create a second order and hold the stock twice. `handlePlaceOrder` additionally
refuses to run order creation at all once this checkout owns an order, which also
closes the window where a restored snapshot holds the reference before its
confirmed figures have loaded.

The order reference is the one piece of checkout state whose loss is not merely
inconvenient — it is what tells a re-entered checkout that the order exists and
holds the stock — so a newly reserved order is written to the snapshot
immediately, rather than behind the 250ms debounce that guards every other
change.

**A failed settings read is not permission.** If `/shops/:slug/settings` cannot
be loaded, the checkout says the shop's availability could not be confirmed, that
the totals are an estimate, and offers a retry — it never implies ordering is
open. The server still refuses a closed shop at creation.

**Delivery windows come from settings, not copy.** The hardcoded "3 to 5 business
days" / "tracked securely" promises were removed: the standard window renders
from `shippingConfiguration.standardDays` (the same value `/cart` reads), the
express window from `expressDays`, and the trust line promises only what the app
provides — order updates and tracking inside the account.

**Bag price facts.** A line shows its unit price and the multiplication
(`2 × ₹1,850 each`) beside the line total, so the bag answers "what does one
cost?" — one rendered branch per breakpoint, never both.

**Payment state is never inferred.** An order and its payment are separate facts. Creation always
succeeds without a confirmed payment — the server records `Pending` when a provider is configured and
the documented `Sample` settlement when none is — and `orderStatus` stays `new` either way. The
checkout's `PAYMENT_NOT_CONFIGURED` fallback (a 503 from `POST /payments/create-order`) lands on that
order's confirmation, which reads its payment state from the server: only `Paid` shows the success pill
and a recorded receipt, and every other state says plainly that no amount has been captured yet.
Nothing marks an order paid from navigation or a client-side event. Verified by inspection of
`OrderSuccessPage.jsx` together with `handlePlaceOrder` / `payExistingOrder`, and by the Phase 7
journey's assertion of the honest settlement text — no code change was needed.

Measured for this phase (Phase 7, disposable `Flora-Alchemy-Test-E2E` only):
`frontend/e2e/specs/05-cart-checkout.spec.js` — 11 Playwright tests green,
including the shop-tax journey that asserts the estimate label, the reprice stop
with `Tax ₹…`, the reload that must not offer a second order, that continuing
lands on the reserved order's confirmation, and that the customer gained
**exactly one** order; plus `02-product`, `06-security` and `07-routes-a11y` — 24
tests green. `npm run build` green. No backend file changed, so no backend suite
was run.
