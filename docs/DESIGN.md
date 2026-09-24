# Flora Alchemy — Design System

> Documents the design system **as implemented** in `frontend/src`. Every token
> named here exists in `frontend/src/index.css`. Nothing in this file is invented.
> Related: [ARCHITECTURE.md](./ARCHITECTURE.md), [AGENTS.md](../AGENTS.md).

The visual language is a warm, editorial "botanical boutique": cream surfaces,
espresso ink, terracotta and sage accents, serif display type over a clean
sans-serif body.

## Typography

Declared as Tailwind v4 theme fonts in `index.css` (`@theme`):

| Token | Value | Usage |
|---|---|---|
| `--font-serif` / `--font-display` | `'Newsreader', Georgia, serif` | Headings, product names, prices, editorial copy |
| `--font-sans` | `'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` | Body, UI labels, buttons, admin tables |

Conventions observed across pages:

- Headings use `font-serif` with explicit pixel sizes (`text-[24px]`, `text-[26px]`,
  `text-[40px]`) rather than Tailwind's default scale.
- Labels/eyebrows are uppercase, small (`text-[10px]`–`text-[12px]`), and
  letter-spaced.
- Body copy is `text-[13px]`–`text-[15px]`.
- Both families load from Google Fonts (referenced in `frontend/index.html`).

## Colour system

Two layers: a **brand palette** (fixed) and **semantic roles** (re-pointed per
theme). All are CSS custom properties consumed via arbitrary-value Tailwind
classes, e.g. `bg-[var(--color-surface-lowest)]`.

### Surfaces (5-level hierarchy)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-surface-bg` | `#fcf9f4` | `#141210` | L0 — application background |
| `--color-surface-lowest` | `#ffffff` | `#1f1c19` | L1 — cards / content sections |
| `--color-surface-low` | `#f6f3ee` | `#26221e` | L1.5 — inset surfaces (chips, code rows) |
| `--color-surface-container` | `#f0ede9` | `#2e2a25` | L2 — elevated: dropdowns, modals, table heads |
| `--color-surface-high` | `#ebe8e3` | `#37332c` | L3 — inputs / interactive controls |
| `--color-surface-highest` | `#e5e2dd` | `#454038` | L4 — hover / selected emphasis |

### Brand palette

| Token | Light | Role |
|---|---|---|
| `--color-botanical-primary` | `#180f0a` (dark: `#f7f4ef`) | Deep espresso — headings |
| `--color-botanical-primary-dark` | `#120b07` | Darker heading variant |
| `--color-botanical-espresso` | `#2e241e` | Secondary ink |
| `--color-botanical-secondary` / `--color-botanical-terracotta` | `#964735` | Terracotta accent |
| `--color-botanical-terracotta-light` | `#ffdad3` | Soft terracotta wash |
| `--color-botanical-sage` | `#5b6d54` (dark: `#93ab87`) | Sage green accent |
| `--color-botanical-sage-light` | `#d8e7cd` (dark: `#24382a`) | Soft sage wash |
| `--color-botanical-text` | `#1c1c19` (dark: `#f2efe9`) | Body text |
| `--color-botanical-muted` | `#4e4540` (dark: `#b9b1a8`) | Muted text |
| `--color-botanical-subtle` | `#80756f` (dark: `#8f857b`) | Subtle text / hints |
| `--color-botanical-border` | `#e5e2dd` (dark: `#3a3530`) | Default border |
| `--color-botanical-border-light` | `#f0ede9` (dark: `#2e2a25`) | Hairline border |

### Semantic roles (Phase 20.1)

These exist so one variable drives both themes:

| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-focus` | `#180f0a` | `#f0b9a8` | Focus rings / focus borders |
| `--color-btn` | `#180f0a` | `#964735` | Primary button / chip fill |
| `--color-btn-hover` | `#964735` | `#b26047` | Primary hover |
| `--color-btn-hover-alt` | `#2e241e` | `#b26047` | Alternate hover |
| `--color-accent` | `#964735` | `#d18b76` | Accent text (eyebrows, links) |
| `--color-divider` | `#f0ede9` | `#2e2a25` | Table row dividers |
| `--color-divider-strong` | `#e5e2dd` | `#37332c` | Stronger divider |
| `--color-border-strong` | `#d1c4bd` | `#4a443c` | Emphasised border |
| `--color-badge-bg` | `#ffdad3` | `#3a241c` | Warm accent badge fill |
| `--color-badge-fg` | `#964735` | `#f0b9a8` | Badge text |
| `--color-badge-fg-strong` | `#783020` | `#ffb9ab` | Stronger badge text |
| `--color-success-soft-bg` | `#d8e7cd` | `#24382a` | Success surface |
| `--color-success-soft-fg` | `#081405` | `#b9d8ae` | Success text |
| `--color-danger` | `#ba1a1a` | `#ff8f85` | Error text |

**Rule:** use the tokens. Do not introduce new hardcoded colours; the dark theme
only works because every surface/role re-points.

## Theme system (light / dark / system)

- `src/context/ThemeContext.jsx` is the single source of truth. Mode is
  `light | dark | system`; it is persisted in `localStorage`
  (`flora_alchemy_theme`) and applied as `.light` / `.dark` on `<html>` **plus** a
  `data-theme` attribute.
- `system` resolves via `matchMedia('(prefers-color-scheme: dark)')` and listens
  for OS changes while in that mode.
- Tailwind dark variant is wired as `@custom-variant dark (&:is(.dark *))`, so the
  `dark:` prefix follows the `<html>` class.
- The OS-level default when nothing is stored is `light`.
- **Toggle surfaces:** `Navbar` and `AdminHeader` expose a **binary** toggle
  ("Switch to dark mode" / "Switch to light mode"). The **three-way** light/dark/
  system selector lives in the admin Store Preferences page.
- Dark mode also restyles scrollbars (`.dark ::-webkit-scrollbar-*`) and sets
  `body` background/color.

## Layout

- App shell: `flex flex-col min-h-screen`, so the footer sticks to the bottom of
  short pages.
- Content container convention: `max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-10`.
- Source order per route type:
  - Storefront: `PromoBar` → `Navbar` → `main` → `Footer`
  - Conversion/auth (`/checkout`, `/login`): `MinimalHeader` only (no promo bar,
    nav or footer) so the purchase flow is not interrupted
  - Admin (`/admin/*`): admin shell (`AdminSidebar` / `AdminHeader` / `AdminLayout`)
- `ScrollToTop` resets scroll on every pathname change.

## Spacing

- 4-space Tailwind scale with an emphasis on **explicit pixel values** for type and
  fine detail (`text-[13px]`, `gap-2.5`, `px-3.5`).
- Common rhythm: page sections `py-8`–`py-16`; card padding `p-4`–`p-6`
  (customer) and `p-6`–`p-8` (admin panels); grid gaps `gap-3`–`gap-8`.
- Radius language: pills for actions (`rounded-full`), `rounded-xl`–`rounded-3xl`
  for cards and modals.
- Shadows are restrained: `shadow-xs` for cards, `shadow-2xl` for modals.

## Buttons

No button component module exists — buttons are styled inline but follow a
consistent recipe:

- **Primary:** `rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold tracking-wide`, `disabled:opacity-50`.
- **Secondary/outline:** `rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] hover:bg-[var(--color-surface-low)]`.
- **Text/link-like:** `text-[var(--color-accent)] hover:underline`.
- Loading state: label swaps to a gerund (e.g. "Saving…", "Opening Secure
  Checkout...") and the button is disabled; admin mutations use this **localized**
  pattern rather than a global loader.
- `.touch-target` (min 44 px) and the mobile sticky purchase CTA
  (`fixed bottom-0 lg:hidden`) implement the touch-target contract.

## Forms

- Inputs use `rounded-*` + `border border-[var(--color-botanical-border)]` +
  `bg-[var(--color-surface-lowest)]`/`high`, with a leading lucide icon where it
  aids scanning; focus is shown via ring/border using `--color-focus`.
- Labels are uppercase and letter-spaced (`HANDLER EMAIL`, `PORTAL PASSWORD`).
- Validation is server-authoritative; client-side checks are minimal and
  `noValidate` is used on checkout so the API error surfaces cleanly.
- Inline errors render in `--color-danger` with an `AlertCircle` icon; toast
  feedback comes from `StoreContext.showToast`.

## Cards

`.fa-card-depth` provides the canonical card: soft shadow that deepens on hover
(`.fa-card-depth:hover`) plus an optional image zoom via `.fa-img-reveal`.
Cards use `--color-surface-lowest` on a `--color-botanical-border` border.

## Navigation

- **Navbar** — logo, primary nav (Shop / Gifting / About / Help groups), search
  trigger, theme toggle, Saved Gifts, Shopping Bag with a count badge, account
  entry, and a mobile menu (`Open menu` / `Close menu`) with animated drawer
  (`.fa-drawer-slide`, `.fa-drawer-backdrop`). All icon-only controls carry
  `aria-label`s.
- **PromoBar** — thin announce strip above the nav.
- **MinimalHeader** — `variant="checkout" | "auth"`; offers a route back to the
  bag or home.
- **Footer** — brand blurb, gift-finder CTA, newsletter capture (preview only —
  nothing is sent), and SHOP / GIFTING / ABOUT / HELP link columns.
- **Admin** — `AdminSidebar` (grouped nav: Commerce, Operations, Insights, System)
  with `AdminHeader` (search, notifications, theme toggle, account).
- **AdminStatusPill / StatusPill** — shared status chips.

## Product presentation

- `ProductCard` is the canonical listing unit: image with reveal-on-hover, category
  eyebrow, serif name, price, and quick actions (wishlist heart, add to bag).
  Available on the home grid, shop, collections, search and related products.
- `ProductPage` composes a gallery (`.fa-gallery-crossfade`, `.fa-thumb-active`),
  personalization controls (palette / ribbon), gift message, quantity, stock
  messaging, related products, and a sticky mobile purchase CTA.
- Stock is communicated with an explicit text line (e.g. "In stock · N available",
  "Out of Stock") rather than colour alone; out-of-stock disables the purchase CTA.
- Product imagery uses `/assets/images/flora-asset-*.jpg` fixtures or hosted CDN
  URLs, always with `loading="lazy"` and `decoding="async"` in listings.

## Admin UI

- Dense, table-first screens (`AdminOrdersPage`, `AdminProductsPage`,
  `AdminInventoryPage`, `AdminCustomersPage`) with internal horizontal scroll for
  wide tables on small screens, filter/search toolbars, and status pills.
- Detail screens (`AdminOrderDetailPage`, `AdminProductDetailPage`,
  `AdminCustomerDetailPage`, …) use bordered `--color-surface-lowest` panels.
- Mutations show **localized** progress only ("Saving…", per-action spinners); the
  page stays mounted and there is no global bootstrap loader for a single write.
- Confirmation modals (e.g. status update, delete) are `role="dialog"` +
  `aria-modal`, close on Escape, move focus in on open and return focus on close.
- `AdminStorePreferencesPage` hosts the three-way theme selector and exposes
  settings that are device-local until explicitly saved.
- `ImageUploader` (`components/admin/`) handles product images: drag/drop, preview
  grid, remove/reorder, and an explicit empty-slot placeholder (never `src=""`).

## Responsive behaviour

- Mobile-first. Breakpoints used: `sm:` 640, `md:` 768, `lg:` 1024, `xl:` 1280.
- Page-level guards: `html`, `body` set `overflow-x: hidden`; layouts are verified
  free of horizontal overflow from 390 px up to 1440 px.
- Grids collapse 4 → 3 → 2 columns; the admin sidebar collapses to a drawer.
- Safe-area helpers: `.pb-safe` / `.pt-safe`
  (`env(safe-area-inset-*)`) for notched devices.
- `.scrollbar-none` hides scrollbars on horizontal chip rails.

## Accessibility patterns

- Every icon-only control has an `aria-label` (search, theme toggle, cart count,
  mobile menu, notification bell, send message, close dialog).
- **Status is never colour-only** — `StatusPill` pairs each state with an icon and
  a text label by design.
- Dialog contract: `role="dialog"`, `aria-modal="true"`, labelled by a heading,
  Escape-to-close, initial focus, and focus return to the trigger.
- Focus rings are **not** reset; UA rings and `focus:ring` utilities remain intact.
- Loading regions expose `role="status"` + `aria-live="polite"` + an `aria-label`
  (`BootstrapSkeleton`, `RouteFallback`).
- `prefers-reduced-motion` is respected through `prefersReducedMotion` in
  `lib/gsapSetup.js`, and reduced-motion guards wrap animation setup.
- `.touch-target` enforces ≥44 px hit areas.

## Loading states

- `BootstrapSkeleton` — full-screen `role="status"` skeleton during initial data
  hydration (`DataContext`).
- `RouteFallback` (in `App.jsx`) — in-page skeleton for lazy route chunks.
- `Skeleton`, `SkeletonText`, `SkeletonCircle`, `SkeletonCard`, `SkeletonRow`,
  `SkeletonTable`, `SkeletonHero` (`components/Skeleton.jsx`) — reusable primitives
  using `animate-pulse` over `--color-surface-*`.
- `components/admin/LoginLoading.jsx` — portal sign-in transition.
- Admin mutations use **localized** progress; a single write must never trigger a
  full-store hydration or global loader.

## Error states

- `DataContext` renders a full-screen error screen when hydration fails, with a
  Retry action; the developer-only "start the API server" hint is **DEV-gated** and
  never ships to production.
- Network failure surfaces a friendly message with a Retry affordance
  (`NETWORK_ERROR` from `apiClient`).
- 401 clears the affected session and redirects to the correct login screen.
- Inline form/action errors use `--color-danger` + `AlertCircle`; `store-closed`
  and inventory-conflict states render honest, actionable copy.
- `NotFoundPage` handles unknown routes.

## Empty states

Centered, bordered `--color-surface-lowest` panels with an oversized emoji or icon,
a serif headline and a supporting line, plus one or two clear actions — e.g. the
empty bag ("Your shopping bag is currently empty."), empty wishlist (with the
sign-in gate), empty search results, and empty admin tables.

## Dialogs / modals

- Backdrop: `fixed inset-0 z-50` with `bg-black/40 backdrop-blur-xs`.
- Panel: `--color-surface-lowest`, `rounded-2xl`/`rounded-3xl`, `shadow-2xl`,
  `max-h-[90vh] overflow-y-auto`.
- Applied by the wishlist sign-in gate, search overlay, notification panel, admin
  status-update dialog and delete confirmations. The admin dialog was aligned to the
  same contract (role/aria-modal/Escape/focus) in Phase 20.4.

## Animation & interaction conventions

- GSAP + `ScrollTrigger` for entrance/scroll choreography; CSS keyframes for
  micro-interactions. Named utilities in `index.css`:
  - Ambient: `.fa-float-slow`, `.fa-float-subtle`, `.fa-drift`
  - Drawer: `.fa-drawer-backdrop`, `.fa-drawer-slide`, `.fa-drawer-link`
  - Nav/focus: `.fa-nav-transition`
  - Gallery: `.fa-gallery-crossfade`, `.fa-thumb-active`, `.fa-tracker-pulse`
  - Feedback: `.fa-atc-success` (add-to-bag), `.fa-wishlist-pop`, `.fa-qty-bump`,
    `.fa-success-celebrate` (order success)
  - Generic: `.animate-slide-in`, `animate-pulse`, `animate-fade-in`
- Motion is deliberately restrained and always subject to reduced-motion handling.
- Toasts are pill-shaped, bottom-anchored (mobile: full-width inset;
  `sm:` right-aligned) and auto-dismiss after ~3.2 s.

## Image treatment

- `.fa-img-reveal` zooms the image on card hover; `aspect-[4/3]` (cards) and
  `aspect-square` (thumbnails/admin previews) are the standard ratios.
- Listing images use `object-cover` + `loading="lazy"` + `decoding="async"`;
  broken images are hidden via `onError` rather than showing a broken icon.
- Empty gallery slots render an explicit placeholder — never an empty `src`.
- Uploaded product images go to ImageKit when configured, otherwise to real local
  disk storage served at `/uploads/<name>`.

## Reusable components (existing)

Do not re-implement these — extend them.

| Component | Purpose |
|---|---|
| `components/ProductCard.jsx` | Product tile for every listing surface |
| `components/StatusPill.jsx` | `OrderStatusPill`, request & conversation status chips (icon + label + tint) |
| `components/Skeleton.jsx` | `Skeleton`, `SkeletonText`, `SkeletonCircle`, `SkeletonCard`, `SkeletonRow`, `SkeletonTable`, `SkeletonHero` |
| `components/BootstrapSkeleton.jsx` | Full-screen hydration skeleton |
| `components/Navbar.jsx` / `Footer.jsx` / `PromoBar.jsx` / `MinimalHeader.jsx` | Storefront chrome |
| `components/SearchOverlay.jsx` | Global search overlay |
| `components/NotificationBell.jsx` / `components/admin/NotificationBell.jsx` | Notification entry points |
| `components/OrderStatusTracker.jsx` | Order tracking timeline |
| `components/AdminRoute.jsx` | Portal route guard |
| `components/admin/AdminLayout.jsx` / `AdminSidebar.jsx` / `AdminHeader.jsx` | Portal shell |
| `components/admin/AdminStatusPill.jsx` | Staff-facing status chips |
| `components/admin/AdminSettingsTabs.jsx` | Settings section tabs |
| `components/admin/ImageUploader.jsx` | Product image upload + preview grid |
| `components/admin/LoginLoading.jsx` | Portal sign-in transition |

## Known limitation

Screenshots could not be captured in the cloud development environment used for
the latest audit (webview compositing), so design verification was performed
programmatically (computed styles / surface audits). Visual regression is therefore
not automated.
