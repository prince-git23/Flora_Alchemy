import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShoppingBag, Trash2, ArrowRight, Gift, Truck, Sparkles, AlertCircle } from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';
import { PACKAGING_ADD_ON } from '../services/api.js';
import { getSettings } from '../services/settingsService.js';
import { getProducts } from '../services/productService.js';
import { refreshProducts } from '../services/dataStore.js';
import { listShops } from '../services/shopService.js';
import { groupCartByShop, checkoutUrlFor } from '../services/cartGroups.js';
import { useStoreVersion } from '../hooks/useStoreVersion.js';

/* ── Motion (shared storefront module — registers ScrollTrigger once) ── */
import { gsap, prefersReducedMotion } from '../lib/gsapSetup.js';

export default function CartPage() {
  const navigate = useNavigate();
  const { cart, cartSubtotal, updateItemQuantity, removeItemFromCart, addItemToCart } = useStore();
  const pageRef = useRef(null);
  const headerRef = useRef(null);
  const itemsRef = useRef(null);
  const summaryRef = useRef(null);
  const [qtyAnim, setQtyAnim] = useState(null);

  // Phase 20.2 — subscribe to catalogue changes so live stock updates
  // (admin adjust, order deduction) re-render the bag in place.
  const storeVersion = useStoreVersion();

  // PHASE 3 — the live shop directory. A bag line's shop must still be an
  // ACTIVE shop to be checkable out; a line whose shop left discovery is
  // surfaced as unavailable instead of being silently charged.
  const [shops, setShops] = useState(null);
  useEffect(() => {
    let mounted = true;
    listShops()
      .then((res) => {
        if (mounted) setShops(res.ok ? res.shops : []);
      })
      .catch(() => {
        // Directory unavailable: keep the bag renderable; the server remains
        // the authority at checkout (an unknown shop is refused there).
        if (mounted) setShops([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Phase 20.2 — stale-stock revalidation: opening a non-empty bag silently
  // refetches the catalogue (stale-while-revalidate — no loader, the page
  // stays mounted), so a stock change made in another session is discovered
  // HERE, before the customer reaches Review. Failures keep current data.
  useEffect(() => {
    if (cart.length === 0) return;
    refreshProducts().catch(() => { /* keep confirmed data */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 20.2 — cart vs. live-stock reconciliation. Every catalogue line is
  // checked against the embedded stock signal; made-to-order, add-ons and
  // custom gifts are deliberately exempt. `catalog.length > 0` guards the
  // first-load frame (never flag lines as missing before hydration).
  const catalog = useMemo(() => getProducts(), [storeVersion]);
  const lineIssues = useMemo(() => {
    const issues = [];
    cart.forEach((item, idx) => {
      if (item.isAddOn || item.customGiftConfig) return;
      const key = item.productSlug || item.id;
      const p = catalog.find((x) => x.slug === key || x.id === key);
      if (!p) {
        if (catalog.length > 0 && item.productSlug) {
          issues.push({ idx, item, type: 'missing' });
        }
        return;
      }
      if (p.stockTracked === false || typeof p.stock !== 'number') return;
      const qty = item.quantity || 1;
      if (p.stock <= 0) issues.push({ idx, item, type: 'oos' });
      else if (qty > p.stock) issues.push({ idx, item, type: 'short', stock: p.stock });
    });
    return issues;
  }, [cart, catalog]);
  const blockedIdx = useMemo(() => new Set(lineIssues.map((i) => i.idx)), [lineIssues]);
  const stockBlocked = lineIssues.length > 0;
  const issueAt = (idx) => lineIssues.find((i) => i.idx === idx);

  const settings = getSettings();

  // PHASE 3 — group the global bag by real Shop. Add-ons are checkout-level
  // extras: they ride with whichever shop is checked out.
  const { groups, addOns } = useMemo(
    () => groupCartByShop(cart, { catalog, shops: shops || [] }),
    [cart, catalog, shops]
  );
  const addOnTotal = addOns.reduce((sum, item) => sum + item.price * (item.quantity || 1), 0);
  const productSubtotal = cartSubtotal - addOnTotal;
  const itemCount = cart.reduce((sum, item) => sum + (item.quantity || 1), 0);
  const groupBlocked = (group) =>
    !group.available || group.items.some((it) => blockedIdx.has(cart.indexOf(it)));
  const anyGroupCheckable = groups.some((g) => !groupBlocked(g));

  const standardDays = settings?.shippingConfiguration?.standardDays;

  // Quantity bump animation
  const triggerQtyBump = useCallback((idx) => {
    setQtyAnim(idx);
    setTimeout(() => setQtyAnim(null), 300);
  }, []);

  /*
   * PHASE 3 §29 — removal collapses the row instead of snapping the layout.
   * The store mutation happens in `onComplete`, so the bag is only changed
   * once the animation has finished; under `prefers-reduced-motion` the row is
   * removed immediately and no tween is created at all.
   */
  const handleRemove = useCallback((idx, el) => {
    if (!el || prefersReducedMotion()) {
      removeItemFromCart(idx);
      return;
    }
    gsap.to(el, {
      opacity: 0,
      height: 0,
      paddingTop: 0,
      paddingBottom: 0,
      marginTop: 0,
      marginBottom: 0,
      duration: 0.28,
      ease: 'power2.inOut',
      onComplete: () => removeItemFromCart(idx),
    });
  }, [removeItemFromCart]);

  /* ── GSAP entrance animations ── */
  useEffect(() => {
    if (prefersReducedMotion() || !pageRef.current) return;
    const ctx = gsap.context(() => {
      if (headerRef.current) {
        gsap.from(headerRef.current.children, {
          y: 24,
          opacity: 0,
          duration: 0.6,
          ease: 'power3.out',
          stagger: 0.08,
        });
      }
      if (itemsRef.current) {
        const rows = itemsRef.current.querySelectorAll('[data-cart-item]');
        if (rows.length) {
          gsap.from(rows, {
            y: 20,
            opacity: 0,
            duration: 0.5,
            ease: 'power3.out',
            stagger: 0.06,
            scrollTrigger: {
              trigger: itemsRef.current,
              start: 'top 85%',
              once: true,
            },
          });
        }
      }
      if (summaryRef.current) {
        gsap.from(summaryRef.current, {
          y: 24,
          opacity: 0,
          duration: 0.6,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: summaryRef.current,
            start: 'top 85%',
            once: true,
          },
        });
      }
    }, pageRef);
    return () => ctx.revert();
  }, [cart.length]);

  /** One bag line — shared by every shop group (no duplicated markup). */
  const renderLine = (item) => {
    const idx = cart.indexOf(item);
    const issue = issueAt(idx);
    return (
      <div key={`${item.id}-${item.palette || ''}-${item.ribbon || ''}-${idx}`} data-cart-item className="py-4 first:pt-0 last:pb-0 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-18 h-18 sm:w-20 sm:h-20 rounded-2xl overflow-hidden bg-[var(--color-surface-low)] shrink-0 border border-[var(--color-botanical-border)]">
            {item.image ? (
              <img loading="lazy" decoding="async" src={item.image} alt={item.name} className="w-full h-full object-cover" />
            ) : (
              <span className="w-full h-full flex items-center justify-center text-2xl" aria-hidden="true">🌸</span>
            )}
          </div>
          <div className="space-y-1 min-w-0">
            <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">
              {item.category}
            </span>
            <h3 className="font-serif text-[15px] sm:text-[17px] text-[var(--color-botanical-primary)] font-medium leading-snug line-clamp-2 break-words">
              {item.name}
            </h3>
            {item.palette && (
              <p className="text-[11px] sm:text-[12px] text-[var(--color-botanical-muted)] line-clamp-1 break-words">Palette: {item.palette}</p>
            )}
            {item.ribbon && (
              <p className="text-[11px] sm:text-[12px] text-[var(--color-botanical-muted)] line-clamp-1 break-words">Ribbon: {item.ribbon}</p>
            )}
            {item.giftMessage && (
              <p className="text-[11px] text-[var(--color-accent)] italic break-words line-clamp-2">
                Card: &ldquo;{item.giftMessage}&rdquo;
              </p>
            )}
            {issue && (
              <p role="status" className="text-[11px] font-bold text-[var(--color-danger)]">
                {issue.type === 'short'
                  ? `Only ${issue.stock} left — reduce quantity to continue`
                  : issue.type === 'oos'
                    ? 'Out of stock — remove to continue'
                    : 'No longer available — remove to continue'}
              </p>
            )}
            <p className="text-[14px] font-bold text-[var(--color-botanical-primary)] sm:hidden">
              ₹{(item.price * (item.quantity || 1)).toLocaleString('en-IN')}
            </p>
          </div>
        </div>

        {/* Quantity and Actions */}
        <div className="flex items-center justify-between sm:justify-end gap-4 sm:gap-6 w-full sm:w-auto">
          <div className="flex items-center justify-between px-2 py-1 rounded-full bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] w-28">
            <button
              type="button"
              onClick={() => { updateItemQuantity(idx, (item.quantity || 1) - 1); triggerQtyBump(idx); }}
              disabled={(item.quantity || 1) <= 1}
              aria-label={`Decrease quantity of ${item.name}`}
              className="w-9 h-9 flex items-center justify-center text-[16px] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded-full disabled:opacity-30 disabled:cursor-not-allowed touch-target"
            >
              −
            </button>
            <span className={`text-[13px] font-semibold text-[var(--color-botanical-primary)] ${qtyAnim === idx ? 'fa-qty-bump' : ''}`} aria-live="polite">{item.quantity || 1}</span>
            <button
              type="button"
              onClick={() => { updateItemQuantity(idx, (item.quantity || 1) + 1); triggerQtyBump(idx); }}
              disabled={!!issue}
              aria-label={`Increase quantity of ${item.name}`}
              className="w-9 h-9 flex items-center justify-center text-[16px] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded-full touch-target disabled:opacity-30 disabled:cursor-not-allowed"
            >
              +
            </button>
          </div>

          <div className="hidden sm:block text-right">
            <span className="text-[15px] font-bold text-[var(--color-botanical-primary)]">
              ₹{(item.price * (item.quantity || 1)).toLocaleString('en-IN')}
            </span>
          </div>

          <button
            type="button"
            onClick={(e) => handleRemove(idx, e.currentTarget.closest('[data-cart-item]'))}
            aria-label={`Remove ${item.name} from bag`}
            className="text-[var(--color-botanical-subtle)] hover:text-[var(--color-accent)] p-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded-full transition-colors touch-target"
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen py-8 lg:py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header Title */}
        <div ref={headerRef} className="space-y-1 mb-6 lg:mb-8">
          <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
            Artisanal Bag
          </span>
          <h1 className="font-serif text-[30px] sm:text-[36px] lg:text-[44px] text-[var(--color-botanical-primary)] font-normal tracking-tight leading-tight">
            Your Keepsake Bag
          </h1>
          {groups.length > 1 && (
            <p className="text-[12px] sm:text-[13px] text-[var(--color-botanical-muted)] pt-1">
              Your bag holds creations from {groups.length} shops. Each shop is checked out on its own — your other
              pieces stay in the bag.
            </p>
          )}
        </div>

        {cart.length === 0 ? (
          <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-8 sm:p-12 lg:p-16 text-center border border-[var(--color-botanical-border)] max-w-xl mx-auto space-y-4 overflow-hidden">
            <div className="absolute -top-20 -right-20 w-60 h-60 rounded-full bg-[var(--color-badge-bg)]/30 blur-3xl pointer-events-none" />
            <div className="absolute -bottom-16 -left-16 w-48 h-48 rounded-full bg-[var(--color-botanical-sage-light)]/25 blur-3xl pointer-events-none" />
            <div className="relative w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-3xl" aria-hidden="true">
              🛍️
            </div>
            <h2 className="relative font-serif text-[22px] sm:text-[26px] text-[var(--color-botanical-primary)]">Your bag is waiting for something special</h2>
            <p className="relative text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)]">
              Discover our everlasting blooms, deckled botanical cards, and bespoke gift boxes.
            </p>
            <div className="relative pt-2 flex flex-col sm:flex-row flex-wrap items-center justify-center gap-3">
              <Link
                to="/shop"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-[var(--color-btn)] text-white hover:bg-[var(--color-btn-hover)] transition-colors text-[13px] font-semibold shadow-md hover:shadow-lg active:translate-y-0.5 touch-target"
              >
                <span>Browse Gifts</span>
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </Link>
              <Link
                to="/gift-finder"
                className="w-full sm:w-auto px-6 py-3 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] hover:shadow-md active:translate-y-0 transition-all text-[13px] font-semibold touch-target text-center"
              >
                Find a Gift
              </Link>
              <Link
                to="/custom-gifts"
                className="w-full sm:w-auto px-6 py-3 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] hover:shadow-md active:translate-y-0 transition-all text-[13px] font-semibold touch-target text-center"
              >
                Create a Custom Gift
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-start">
            {/* Cart Items List (7 cols) */}
            <div ref={itemsRef} className="lg:col-span-7 space-y-4">
              {/* Phase 20.2 — stock discrepancies block checkout with a clear,
                  actionable path instead of a raw error at the final Review. */}
              {stockBlocked && (
                <div role="alert" data-cart-item className="p-4 rounded-2xl bg-[var(--color-warning-soft-bg)] border border-[var(--color-warning-soft-border)] space-y-2">
                  <p className="flex items-center gap-2 text-[13px] font-bold text-[var(--color-warning-soft-fg)]">
                    <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    Stock information changed — please review your bag
                  </p>
                  <ul className="space-y-1.5">
                    {lineIssues.map((iss) => (
                      <li key={iss.idx} className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-[var(--color-warning-soft-fg)]">
                        <span>
                          {iss.type === 'short' && <>Only {iss.stock} left of “{iss.item.name}” — reduce the quantity to continue.</>}
                          {iss.type === 'oos' && <>“{iss.item.name}” is out of stock — remove it to continue.</>}
                          {iss.type === 'missing' && <>“{iss.item.name}” is no longer available — remove it to continue.</>}
                        </span>
                        {iss.type === 'short' ? (
                          <button
                            type="button"
                            onClick={() => { updateItemQuantity(iss.idx, iss.stock); triggerQtyBump(iss.idx); }}
                            className="px-3 py-1 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-warning-soft-border)] text-[11px] font-bold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors touch-target"
                          >
                            Reduce to {iss.stock}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => removeItemFromCart(iss.idx)}
                            className="px-3 py-1 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-warning-soft-border)] text-[11px] font-bold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors touch-target"
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* PHASE 3 — products grouped by their real Shop, each group with
                  its own checkout action. Groups are never merged. */}
              {groups.map((group) => {
                const blocked = groupBlocked(group);
                const groupCount = group.items.reduce((sum, it) => sum + (it.quantity || 1), 0);
                return (
                  <div
                    key={group.key}
                    data-cart-item
                    data-shop={group.slug || ''}
                    className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] overflow-hidden"
                  >
                    <div className="px-4 sm:px-6 py-3 border-b border-[var(--color-divider-strong)] bg-[var(--color-surface-low)]/60 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">Shop</span>
                        <span className="font-serif text-[16px] sm:text-[18px] text-[var(--color-botanical-primary)] truncate">
                          {group.displayName}
                        </span>
                      </div>
                      {/* PHASE 3 §28 — the three money figures are named
                          distinctly so a bag subtotal, a SHOP subtotal and the
                          order total can never be mistaken for one another. */}
                      <span className="text-[11px] font-semibold text-[var(--color-botanical-muted)]">
                        Shop subtotal · {groupCount} item{groupCount === 1 ? '' : 's'} ·
                        <span className="text-[var(--color-botanical-primary)]"> ₹{group.subtotal.toLocaleString('en-IN')}</span>
                      </span>
                    </div>
                    {!group.available && (
                      <p role="status" className="px-4 sm:px-6 pt-3 text-[12px] font-semibold text-[var(--color-danger)]">
                        This shop is not accepting orders right now — remove these items to continue with your other shops.
                      </p>
                    )}
                    <div className="px-4 sm:px-6 divide-y divide-[var(--color-divider-strong)]">
                      {group.items.map((item) => renderLine(item))}
                    </div>
                    <div className="px-4 sm:px-6 py-4 border-t border-[var(--color-divider-strong)] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                      <p className="text-[12px] text-[var(--color-botanical-muted)]">
                        Shipping and totals for this shop are calculated at checkout.
                      </p>
                      <button
                        type="button"
                        onClick={() => navigate(checkoutUrlFor(group))}
                        disabled={blocked}
                        data-checkout-shop={group.slug || ''}
                        className="px-6 py-3 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold flex items-center justify-center gap-2 shadow-md transition-all duration-200 active:translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] touch-target disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ShoppingBag className="w-4 h-4" aria-hidden="true" />
                        <span>Checkout {group.displayName}</span>
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Selected add-ons */}
              {addOns.length > 0 && (
                <div data-cart-item className="bg-[var(--color-surface-lowest)] rounded-3xl p-4 sm:p-6 border border-[var(--color-botanical-border)] space-y-3">
                  <p className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Gift add-ons</p>
                  {addOns.map((item) => {
                    const idx = cart.indexOf(item);
                    return (
                      <div key={`${item.id}-${idx}`} className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="w-9 h-9 rounded-full bg-[var(--color-badge-bg)]/60 flex items-center justify-center text-[var(--color-accent)] shrink-0" aria-hidden="true">
                            <Gift className="w-4 h-4" />
                          </span>
                          <div className="min-w-0">
                            <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)] line-clamp-1 break-words">{item.name}</p>
                            {item.description && (
                              <p className="text-[11px] text-[var(--color-botanical-subtle)] line-clamp-1 break-words">{item.description}</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-4 shrink-0">
                          <span className="text-[14px] font-bold text-[var(--color-botanical-primary)]">₹{item.price.toLocaleString('en-IN')}</span>
                          <button
                            type="button"
                            onClick={(e) => handleRemove(idx, e.currentTarget.closest('[data-cart-item]'))}
                            aria-label={`Remove ${item.name} from bag`}
                            className="text-[var(--color-botanical-subtle)] hover:text-[var(--color-accent)] p-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded-full transition-colors touch-target"
                          >
                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  <p className="text-[11px] text-[var(--color-botanical-subtle)]">
                    Add-ons are added to the shop you check out with.
                  </p>
                </div>
              )}

              {/* Studio Packaging Add-on */}
              <div data-cart-item className="p-4 rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <input
                    type="checkbox"
                    id="studio-pine-casket"
                    checked={addOns.some((item) => item.id === PACKAGING_ADD_ON.id)}
                    onChange={(e) => {
                      const idx = cart.findIndex((item) => item.isAddOn && item.id === PACKAGING_ADD_ON.id);
                      if (e.target.checked) {
                        if (idx === -1) {
                          addItemToCart(PACKAGING_ADD_ON, { isAddOn: true, addOnId: PACKAGING_ADD_ON.id });
                        }
                      } else if (idx > -1) {
                        removeItemFromCart(idx);
                      }
                    }}
                    className="w-4 h-4 rounded text-[var(--color-accent)] focus:ring-0 cursor-pointer"
                  />
                  <label htmlFor="studio-pine-casket" className="cursor-pointer text-[12px] sm:text-[13px] min-w-0">
                    <span className="font-semibold text-[var(--color-botanical-primary)] block">Upgrade to Studio Pine Keepsake Casket (+₹{PACKAGING_ADD_ON.price})</span>
                    <span className="text-[var(--color-botanical-subtle)] line-clamp-1">{PACKAGING_ADD_ON.description}</span>
                  </label>
                </div>
                <span className="text-[14px] font-bold text-[var(--color-botanical-primary)] shrink-0">₹{PACKAGING_ADD_ON.price}</span>
              </div>
            </div>

            {/* Order Summary Col (5 cols) */}
            <div className="lg:col-span-5 space-y-6">
              <div ref={summaryRef} className="bg-[var(--color-surface-lowest)] rounded-3xl p-5 sm:p-6 border border-[var(--color-botanical-border)] shadow-sm space-y-5">
                <h3 className="font-serif text-[20px] sm:text-[22px] text-[var(--color-botanical-primary)] border-b border-[var(--color-botanical-border)] pb-4">
                  Bag Summary
                </h3>

                {/* Delivery information */}
                <div className="space-y-2">
                  <span className="block text-[11px] uppercase font-bold text-[var(--color-botanical-subtle)]">
                    Delivery
                  </span>
                  <p className="text-[12px] text-[var(--color-botanical-sage)] flex items-center gap-1.5 font-medium">
                    <Truck className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      Pan-India dispatch
                      {standardDays ? ` · ${standardDays}` : ''}
                    </span>
                  </p>
                </div>

                {/* Cost Breakdown — shipping/total are PER SHOP at checkout. */}
                <div className="space-y-3 text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)] border-t border-[var(--color-botanical-border)] pt-4">
                  <div className="flex justify-between">
                    <span>Bag subtotal ({itemCount} item{itemCount === 1 ? '' : 's'})</span>
                    <span className="font-semibold text-[var(--color-botanical-primary)]">₹{productSubtotal.toLocaleString('en-IN')}</span>
                  </div>
                  {addOns.map((item) => (
                    <div key={item.id} className="flex justify-between">
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)]" aria-hidden="true" />
                        {item.name}
                      </span>
                      <span className="font-semibold text-[var(--color-botanical-primary)]">₹{item.price.toLocaleString('en-IN')}</span>
                    </div>
                  ))}
                  <p className="flex items-start gap-2 text-[11px] text-[var(--color-botanical-subtle)] border-t border-[var(--color-botanical-border)] pt-3">
                    <Truck className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      Delivery and the final total are calculated by each shop at checkout — this bag may contain
                      creations from more than one shop.
                    </span>
                  </p>
                </div>

                {!anyGroupCheckable && (
                  <p role="status" className="text-[12px] font-semibold text-[var(--color-danger)] text-center">
                    Resolve the issues above to continue to checkout.
                  </p>
                )}
                <div className="text-center pt-1">
                  <Link to="/shop" className="text-[12px] font-semibold text-[var(--color-accent)] hover:underline">
                    ← Continue exploring the collection
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
