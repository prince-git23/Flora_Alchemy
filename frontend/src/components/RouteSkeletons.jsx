import React from 'react';
import { Skeleton, SkeletonCard, SkeletonCircle, SkeletonRow, SkeletonTable, SkeletonText } from './Skeleton.jsx';

/**
 * PHASE 5 — destination-shaped route-chunk fallbacks.
 *
 * WHAT THIS REPLACES AND WHY
 * --------------------------
 * Every page is lazy-loaded on purpose (Phase 17 code splitting), so navigating
 * to a route that has not been visited yet shows a Suspense fallback while the
 * chunk downloads. That fallback used to be ONE generic shape — a heading plus
 * an eight-card grid — for every route in the application. On /cart it drew a
 * product grid; on /checkout it drew a product grid; on /product/:id it drew a
 * product grid while the page it was standing in for is a two-column
 * gallery + purchase panel. The placeholder therefore did not resemble the page
 * and then jumped when the real layout arrived.
 *
 * Each variant below reserves the geometry of the page it stands in for, drawn
 * ONLY from the existing primitives in `Skeleton.jsx` and the existing design
 * tokens (`--color-*`). There is no second skeleton library, no animation
 * framework and no new dependency, and nothing here fetches or invents data.
 *
 * ORDERING RULE — the first viewport is what matters. Each variant lays out its
 * elements in the same DOM order as the real page, so on a phone the primary
 * content (the product gallery, the bag rows, the checkout form) occupies the
 * first viewport and the summary/secondary panels follow, exactly as they will
 * once the chunk lands. No image is preloaded here and image lazy-loading in the
 * real pages is untouched.
 *
 * The fallback is presentation-only: the primitives are `aria-hidden`, and the
 * wrapper is a polite live region announcing that the page is loading.
 */

/** Product detail — reserved gallery column + purchase panel (12-col split). */
function ProductSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 items-start">
      {/* Gallery first in DOM order, as on the real page. */}
      <div className="lg:col-span-7 space-y-4">
        <Skeleton className="w-full aspect-square rounded-3xl" />
        <div className="flex gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="w-20 h-20 rounded-xl" />
          ))}
        </div>
      </div>
      {/* Purchase panel */}
      <div className="lg:col-span-5 space-y-5">
        <Skeleton className="h-3.5 w-28 rounded-md" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-4/5 rounded-md" />
          <Skeleton className="h-8 w-3/5 rounded-md" />
        </div>
        <Skeleton className="h-7 w-32 rounded-md" />
        <SkeletonText lines={2} />
        <div className="space-y-2.5">
          <Skeleton className="h-5 w-24 rounded-md" />
          <div className="flex gap-2.5">
            <Skeleton className="h-11 w-28 rounded-full" />
            <Skeleton className="h-11 flex-1 rounded-full" />
          </div>
        </div>
        <Skeleton className="h-12 min-h-[48px] w-full rounded-full" />
        <Skeleton className="h-12 w-full rounded-full" />
        {/* Accordion rows */}
        <div className="space-y-2.5 pt-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Catalogue surfaces (/shop, /search, /collections) — toolbar + product grid. */
function CatalogueSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2 max-w-lg">
        <Skeleton className="h-7 w-56 rounded-md" />
        <Skeleton className="h-3.5 w-72 rounded-md" />
      </div>
      {/* Toolbar: search field + filter pills + sort control. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <Skeleton className="h-10 w-full sm:w-64 rounded-full" />
        <Skeleton className="h-9 w-24 rounded-full" />
        <Skeleton className="h-9 w-28 rounded-full" />
        <Skeleton className="h-9 w-20 rounded-full" />
        <Skeleton className="h-9 w-28 rounded-full ml-auto" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

/** Shopping bag — item rows beside the order summary. */
function CartSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-start">
      <div className="lg:col-span-8 space-y-4">
        <Skeleton className="h-7 w-40 rounded-md" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="flex gap-4 rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-3.5"
          >
            <Skeleton className="w-20 h-20 sm:w-24 sm:h-24 rounded-xl shrink-0" />
            <div className="flex-1 space-y-2.5 py-1">
              <Skeleton className="h-4 w-3/5 rounded-md" />
              <Skeleton className="h-3.5 w-2/5 rounded-md" />
              <Skeleton className="h-8 w-28 rounded-full" />
            </div>
          </div>
        ))}
      </div>
      {/* Order summary */}
      <aside className="lg:col-span-4 rounded-3xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-6 space-y-4">
        <Skeleton className="h-5 w-32 rounded-md" />
        <SkeletonText lines={3} />
        <div className="border-t border-[var(--color-botanical-border)] pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-20 rounded-md" />
            <Skeleton className="h-4 w-16 rounded-md" />
          </div>
          <Skeleton className="h-12 w-full rounded-full" />
        </div>
      </aside>
    </div>
  );
}

/** Checkout — stepper, address/delivery/payment form, review summary. */
function CheckoutSkeleton() {
  return (
    <div className="space-y-8">
      {/* Checkout progress */}
      <div className="hidden sm:flex items-center gap-3 max-w-3xl">
        {Array.from({ length: 3 }).map((_, i) => (
          <React.Fragment key={i}>
            <Skeleton className="h-8 w-8 rounded-full shrink-0" />
            <Skeleton className="h-3.5 w-24 rounded-md" />
            {i < 2 && <Skeleton className="h-px flex-1 rounded-none" />}
          </React.Fragment>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        {/* Form stage */}
        <div className="lg:col-span-8 rounded-3xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-6 sm:p-8 space-y-6">
          <Skeleton className="h-6 w-56 rounded-md" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className={`space-y-1.5 ${i === 0 ? 'sm:col-span-2' : ''}`}>
                <Skeleton className="h-3 w-24 rounded-md" />
                <Skeleton className="h-11 w-full rounded-xl" />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-[var(--color-botanical-border)] pt-5">
            <Skeleton className="h-9 w-28 rounded-full" />
            <Skeleton className="h-12 w-48 rounded-full" />
          </div>
        </div>
        {/* Review summary */}
        <aside className="lg:col-span-4 rounded-3xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-6 space-y-4">
          <Skeleton className="h-5 w-32 rounded-md" />
          <SkeletonRow />
          <SkeletonRow />
          <div className="border-t border-[var(--color-botanical-border)] pt-4 space-y-3">
            <Skeleton className="h-4 w-full rounded-md" />
            <Skeleton className="h-4 w-4/5 rounded-md" />
            <Skeleton className="h-6 w-32 rounded-md" />
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Account / order surfaces — sidebar navigation beside a content panel. */
function AccountSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[210px_minmax(0,1fr)] gap-8 lg:gap-12 items-start">
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-24 rounded-md" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-xl" />
        ))}
      </div>
      <div className="space-y-5">
        <div className="space-y-2 max-w-sm">
          <Skeleton className="h-6 w-48 rounded-md" />
          <Skeleton className="h-3.5 w-64 rounded-md" />
        </div>
        <div className="rounded-3xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5 space-y-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Portal forms and tables (admin / owner / staff). */
function PortalSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2 max-w-sm">
          <Skeleton className="h-6 w-44 rounded-md" />
          <Skeleton className="h-3.5 w-60 rounded-md" />
        </div>
        <Skeleton className="h-10 w-36 rounded-full" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-4 space-y-2.5"
          >
            <Skeleton className="h-3 w-20 rounded-md" />
            <Skeleton className="h-7 w-24 rounded-md" />
          </div>
        ))}
      </div>
      <SkeletonTable rows={6} cols={5} />
    </div>
  );
}

/** Auth / intake forms — one centred card of labelled fields. */
function FormSkeleton() {
  return (
    <div className="max-w-md mx-auto rounded-3xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-7 sm:p-9 space-y-6">
      <div className="space-y-3 flex flex-col items-center">
        <SkeletonCircle size={48} />
        <Skeleton className="h-6 w-44 rounded-md" />
        <Skeleton className="h-3.5 w-56 rounded-md" />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-24 rounded-md" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
        ))}
      </div>
      <Skeleton className="h-12 w-full rounded-full" />
    </div>
  );
}

/** Editorial home / story surfaces — hero composition over content sections. */
function EditorialSkeleton() {
  return (
    <div className="space-y-10">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
        <div className="lg:col-span-7 space-y-4">
          <Skeleton className="h-6 w-64 rounded-full" />
          <Skeleton className="h-10 w-full max-w-xl rounded-md" />
          <Skeleton className="h-10 w-4/5 max-w-lg rounded-md" />
          <SkeletonText lines={2} className="max-w-xl" />
          <div className="flex flex-wrap gap-3 pt-1">
            <Skeleton className="h-12 w-44 rounded-full" />
            <Skeleton className="h-12 w-44 rounded-full" />
          </div>
        </div>
        <div className="lg:col-span-5">
          <Skeleton className="w-full h-64 sm:h-80 lg:h-[420px] rounded-3xl" />
        </div>
      </div>
      <div className="space-y-5">
        <div className="space-y-2 max-w-xs">
          <Skeleton className="h-6 w-48 rounded-md" />
          <Skeleton className="h-3.5 w-64 rounded-md" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

const PORTAL_LOGINS = ['/admin/login', '/owner/login', '/staff/login', '/login', '/access', '/portal'];

/**
 * Which reserved layout belongs to a route?
 *
 * Path → page mapping mirrors the route table in App.jsx. Anything unclassified
 * falls back to the editorial layout, which is the closest honest shape for the
 * remaining marketing pages (Our Story, How It's Made, Gift Finder, the Custom
 * Gift Studio, the Custom Request intake).
 */
export function routeSkeletonFor(pathname) {
  const p = String(pathname || '/').split('?')[0].split('#')[0];
  if (p.startsWith('/product/')) return 'product';
  if (p === '/cart') return 'cart';
  if (p.startsWith('/checkout')) return 'checkout';
  if (p === '/shop' || p === '/search' || p === '/collections') return 'catalogue';
  if (p === '/shops' || p.startsWith('/shops/')) return 'catalogue';
  if (
    p.startsWith('/account') ||
    p.startsWith('/order-success') ||
    p.startsWith('/order-tracking') ||
    p.startsWith('/order/') ||
    p === '/notifications' ||
    p === '/wishlist'
  ) {
    return 'account';
  }
  if (p === '/apply/admin' || p === '/admin/activate' || p.startsWith('/admin/activate/')) return 'form';
  if (PORTAL_LOGINS.includes(p)) return 'form';
  if (p.startsWith('/admin') || p.startsWith('/owner') || p.startsWith('/staff')) return 'portal';
  return 'editorial';
}

const VARIANTS = {
  product: ProductSkeleton,
  catalogue: CatalogueSkeleton,
  cart: CartSkeleton,
  checkout: CheckoutSkeleton,
  account: AccountSkeleton,
  portal: PortalSkeleton,
  form: FormSkeleton,
  editorial: EditorialSkeleton,
};

/**
 * Route-chunk fallback. `pathname` comes from App's own router state, so the
 * placeholder is chosen for the destination the visitor actually asked for.
 */
export default function RouteSkeletons({ pathname }) {
  const Variant = VARIANTS[routeSkeletonFor(pathname)] || EditorialSkeleton;
  return (
    // The frame matches the shell width the real pages use (max-w-7xl, same
    // padding), so the placeholder and the page that replaces it share one
    // left edge and no horizontal jump occurs when the chunk lands.
    <div
      className="min-h-[50vh] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12"
      role="status"
      aria-live="polite"
      aria-label="Loading page"
    >
      <Variant />
    </div>
  );
}
