import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Heart, ShoppingBag, Trash2, ArrowRight, UserRound, Sprout } from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';
import { getActiveCustomerId } from '../services/customerService.js';
import { isOutOfStock } from '../services/productService.js';
import ProductCard from '../components/ProductCard.jsx';
import { gsap, prefersReducedMotion } from '../lib/gsapSetup.js';

/**
 * PHASE 2 — SAVED GIFTS (/wishlist).
 *
 * The Phase 1 deferral is now resolved: this page renders the CANONICAL
 * ProductCard (`variant="compact"`) rather than its own bespoke card. Every
 * behaviour the local card owned is preserved:
 *
 *   · Remove            — the card's filled heart calls the same
 *                         `toggleWishlist(product)`, so it removes.
 *   · Move to Bag       — the card's Add action calls the same
 *                         `addItemToCart(product)`. "Move All to Bag" is kept
 *                         in the header exactly as before.
 *   · Sold out          — the card's `outOfStock` reads the same authoritative
 *                         fields (`inStock === false || isOutOfStock`), shows
 *                         the Sold-out overlay and disables Add.
 *   · Retired products  — `wishlistUnavailable` still renders, in its own
 *                         block, so a deleted/hidden piece is never silently
 *                         dropped and the customer can still remove it.
 *   · GSAP              — the `[data-wishlist-card]` hook now lives on wrapper
 *                         elements, so the stagger is unchanged.
 *   · Keyboard a11y     — product name link, wishlist toggle and Add all carry
 *                         labels and visible focus rings (from the card).
 *
 * No wishlist business logic is changed here: the page still talks only to
 * StoreContext, which talks only to the existing wishlist API. Motion is
 * Level 1 through the shared GSAP module.
 */

export default function WishlistPage() {
  const { wishlist, wishlistUnavailable, removeUnavailableFromWishlist, addItemToCart } = useStore();
  const isAuthed = !!getActiveCustomerId();
  const pageRef = useRef(null);
  const headerRef = useRef(null);
  const gridRef = useRef(null);

  // "Move All to Bag" — sold-out pieces stay out of the bag, exactly as before.
  const handleMoveAllToBag = () => {
    wishlist.forEach((item) => {
      if (!isOutOfStock(item)) addItemToCart(item);
    });
  };

  /* ── GSAP entrance — Level 1: a small reveal, no depth ── */
  useEffect(() => {
    if (prefersReducedMotion() || !pageRef.current) return undefined;
    const ctx = gsap.context(() => {
      if (headerRef.current) {
        gsap.from(headerRef.current.children, {
          y: 16, opacity: 0, duration: 0.5, ease: 'power3.out', stagger: 0.08,
        });
      }
      if (gridRef.current) {
        const cards = gridRef.current.querySelectorAll('[data-wishlist-card]');
        if (cards.length) {
          gsap.from(cards, {
            y: 16, opacity: 0, duration: 0.5, ease: 'power3.out', stagger: 0.06,
            clearProps: 'transform,opacity',
            scrollTrigger: { trigger: gridRef.current, start: 'top 90%', once: true },
          });
        }
      }
    }, pageRef);
    return () => ctx.revert();
  }, [wishlist.length]);

  const empty = wishlist.length === 0 && wishlistUnavailable.length === 0;

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen pt-8 pb-16 sm:pt-12 sm:pb-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* ═══ HEADER ═══ */}
        <div
          ref={headerRef}
          className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 pb-6 border-b border-[var(--color-botanical-border)]"
        >
          <div className="space-y-1">
            <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
              Saved gifts
            </span>
            <h1 className="font-serif text-[28px] sm:text-[34px] lg:text-[40px] leading-[1.1] tracking-tight font-normal text-[var(--color-botanical-primary)]">
              Your saved pieces
            </h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)]">
              Pieces kept for upcoming birthdays, quiet anniversaries, or gentle everyday surprises.
            </p>
          </div>

          {wishlist.length > 0 && (
            <button
              type="button"
              onClick={handleMoveAllToBag}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors shrink-0 min-h-[44px]"
            >
              <ShoppingBag className="w-4 h-4" aria-hidden="true" />
              <span>Move all to bag</span>
            </button>
          )}
        </div>

        {empty ? (
          !isAuthed ? (
            /* Guest — the wishlist is account-owned, so offer sign-in. */
            <div className="max-w-lg mx-auto mt-8 sm:mt-10 rounded-3xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] px-8 py-10 text-center space-y-3">
              <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center" aria-hidden="true">
                <Heart className="w-6 h-6 text-[var(--color-accent)]" />
              </div>
              <h2 className="font-serif text-[22px] sm:text-[24px] text-[var(--color-botanical-primary)]">
                Sign in to save your pieces
              </h2>
              <p className="text-[14px] leading-relaxed text-[var(--color-botanical-muted)]">
                Saved gifts live with your account, so they follow you across devices.
                Browsing and adding to your bag never require an account.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
                <Link
                  to="/login?redirect=/wishlist"
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors min-h-[44px]"
                >
                  <UserRound className="w-4 h-4" aria-hidden="true" />
                  Sign in
                </Link>
                <Link
                  to="/shop"
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors min-h-[44px]"
                >
                  Continue shopping
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
          ) : (
            <div className="max-w-lg mx-auto mt-8 sm:mt-10 rounded-3xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] px-8 py-10 text-center space-y-3">
              <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center" aria-hidden="true">
                <Sprout className="w-6 h-6 text-[var(--color-botanical-sage)]" />
              </div>
              <h2 className="font-serif text-[22px] sm:text-[24px] text-[var(--color-botanical-primary)]">
                Nothing saved yet
              </h2>
              <p className="text-[14px] leading-relaxed text-[var(--color-botanical-muted)]">
                Tap the heart on any piece in the catalogue and it will wait for you here.
              </p>
              <div className="pt-2">
                <Link
                  to="/shop"
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors min-h-[44px]"
                >
                  Browse products
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
          )
        ) : (
          <div className="pt-6">
            {wishlist.length > 0 && (
              <ul
                ref={gridRef}
                className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4 lg:gap-5 list-none p-0 m-0"
              >
                {wishlist.map((item) => (
                  <li key={item.id} data-wishlist-card className="list-none">
                    <ProductCard variant="compact" product={item} />
                  </li>
                ))}

                {/* Products that were deleted or hidden still render so the
                    customer can remove them — they are never silently dropped. */}
                {wishlistUnavailable.length > 0 && (
                  <li className="col-span-full pt-8 list-none">
                    <h2 className="font-serif text-[18px] text-[var(--color-botanical-subtle)] mb-4">
                      No longer available
                    </h2>
                    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 list-none p-0 m-0">
                      {wishlistUnavailable.map((id) => (
                        <li
                          key={id}
                          data-wishlist-card
                          className="list-none rounded-2xl p-5 border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-low)] flex flex-col items-center gap-4 text-center"
                        >
                          <div className="space-y-1.5">
                            <Sprout className="w-5 h-5 mx-auto text-[var(--color-botanical-subtle)]" aria-hidden="true" />
                            <p className="font-serif text-[16px] text-[var(--color-botanical-muted)]">
                              No longer available
                            </p>
                            <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                              This creation was retired from the collection.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeUnavailableFromWishlist(id)}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] text-[12px] font-semibold transition-colors min-h-[44px]"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Remove</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
              </ul>
            )}

            {/* Retired-only state: nothing saved is still live, but the
                customer must be able to clear the retired entries. */}
            {wishlist.length === 0 && wishlistUnavailable.length > 0 && (
              <div>
                <h2 className="font-serif text-[18px] text-[var(--color-botanical-subtle)] mb-4">
                  No longer available
                </h2>
                <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 list-none p-0 m-0">
                  {wishlistUnavailable.map((id) => (
                    <li
                      key={id}
                      data-wishlist-card
                      className="list-none rounded-2xl p-5 border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-low)] flex flex-col items-center gap-4 text-center"
                    >
                      <div className="space-y-1.5">
                        <Sprout className="w-5 h-5 mx-auto text-[var(--color-botanical-subtle)]" aria-hidden="true" />
                        <p className="font-serif text-[16px] text-[var(--color-botanical-muted)]">
                          No longer available
                        </p>
                        <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                          This creation was retired from the collection.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeUnavailableFromWishlist(id)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] text-[12px] font-semibold transition-colors min-h-[44px]"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Remove</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="pt-8">
                  <Link
                    to="/shop"
                    className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors min-h-[44px]"
                  >
                    Browse products
                    <ArrowRight className="w-4 h-4" aria-hidden="true" />
                  </Link>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
