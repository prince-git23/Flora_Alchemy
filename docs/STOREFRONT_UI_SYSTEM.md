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

## 5. ProductCard — one component, two variants

**Source of truth:** `frontend/src/components/ProductCard.jsx` **Implemented.**

Surfaces using it today: **Home** (bestsellers grid), **Shop** (`/shop`),
**Search** (`/search`), **Product detail** (related rail), **Public Shop**
(`/shops/:slug`, `variant="shop-context"`).

**Wishlist — Planned, deliberately not migrated.** `WishlistPage` still renders
its own card. Migrating it is not a drop-in swap: the page depends on a
`[data-wishlist-card]` hook for its GSAP stagger, on a `wishlistUnavailable`
retired-product state, and on a trash/remove control. Move it onto the canonical
card only as a deliberate change that preserves all three — never as a
half-migration. Its remaining token violation (a light-only border hex) is fixed.

```
<ProductCard product={product} />                        // standard
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
- **`shop-context`** — the same card **without** the wishlist and bag actions.
  The bag action is withheld because adding to cart from that surface would not
  carry `fulfillmentShopSlug`, which the multi-shop fulfilment flow depends on.
  Do not "restore" it without also solving that.

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

⚠️ **Known duplication (Planned: consolidate).** Several pages still import
`gsap`/`ScrollTrigger` directly and re-derive `prefersReducedMotion` locally
(e.g. `WishlistPage`). Prefer the shared module when you touch one of them; do
not mass-rewrite pages in a single change.

---

## 12. Responsive foundation

**Implemented breakpoints to hold:** 360 · 390 · 430 · 768 · 1024 · 1280 · 1440.

- **Mobile is not a compressed desktop.**
- Products: **2 columns** on phones.
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
(`ShopWorkspaceGate`, `ShopWorkspacePage` empty state, `CustomRequestPage`,
`LoginPage`, `PortalGatewayPage`), while storefront components use Lucide.
Fix this **only where you are already establishing the shared system** — do not
mass-rewrite unrelated pages. Full storefront icon unification is **Planned**.

---

## 18. What not to do

Do not make the site feel "more premium" by adding: more cards, more gradients,
more animations, more badges, more statistics, more sections, more 3D, fake
testimonials, fake ratings or fake customer content.

Do not add a bottom navigation bar. The existing Navbar is the global navigation.

---

## 19. Verification status (what has actually been measured)

Recorded so nobody re-litigates this in Phase 2. **Implemented + verified.**

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

**Not measured — do not claim it:** a browser test with
`prefers-reduced-motion: reduce` actually forced on. The guard is present in both
CSS and `setupCardDepth`, and is verified by code inspection only.
**Staging/preview deployment has not happened**, so no visual comparison exists
on a hosted environment. Any `/search` result for "Gift Finder" is a 20px text
link — pre-existing, outside the Phase 1 card system.

Do not change pricing, payments, inventory, order ownership, workspace
authorization, customer identity, shop resolution, checkout rules or
custom-request ownership for visual reasons.
