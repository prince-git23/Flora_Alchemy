import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Heart, ShoppingBag, Trash2, ArrowRight, UserRound } from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';
import { getActiveCustomerId } from '../services/customerService.js';

/* ── GSAP ── */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function WishlistPage() {
  const { wishlist, wishlistUnavailable, toggleWishlist, removeUnavailableFromWishlist, addItemToCart } = useStore();
  const isAuthed = !!getActiveCustomerId();
  const pageRef = useRef(null);
  const headerRef = useRef(null);
  const gridRef = useRef(null);

  const handleMoveToBag = (product) => {
    addItemToCart(product);
  };

  const handleMoveAllToBag = () => {
    wishlist.forEach(item => {
      addItemToCart(item);
    });
  };

  /* ── GSAP entrance animations ── */
  useEffect(() => {
    if (prefersReduced || !pageRef.current) return;
    const ctx = gsap.context(() => {
      if (headerRef.current) {
        gsap.from(headerRef.current.children, {
          y: 30, opacity: 0, duration: 0.7, ease: 'power3.out', stagger: 0.1,
        });
      }
      if (gridRef.current) {
        const cards = gridRef.current.querySelectorAll('[data-wishlist-card]');
        if (cards.length) {
          gsap.from(cards, {
            y: 30, opacity: 0, duration: 0.6, ease: 'power3.out', stagger: 0.08,
            scrollTrigger: { trigger: gridRef.current, start: 'top 85%', once: true },
          });
        }
      }
    }, pageRef);
    return () => ctx.revert();
  }, [wishlist.length]);

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen py-6 lg:py-16 relative overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="absolute top-10 right-0 w-80 h-80 rounded-full bg-[#ffdad3]/12 blur-3xl pointer-events-none" />
      <div className="absolute bottom-20 left-0 w-64 h-64 rounded-full bg-[#d8e7cd]/10 blur-3xl pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        {/* Header Title */}
        <div ref={headerRef} className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6 sm:mb-8">
          <div className="space-y-1">
            <span className="text-[11px] uppercase font-bold tracking-widest text-[#964735]">
              Saved Treasures
            </span>
            <h1 className="font-serif text-[28px] sm:text-[36px] lg:text-[44px] text-[var(--color-botanical-primary)] font-normal tracking-tight leading-tight">
              Your Saved Gifts
            </h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)]">
              Pieces saved for upcoming birthdays, quiet anniversaries, or gentle everyday surprises.
            </p>
          </div>

          {wishlist.length > 0 && (
            <button
              onClick={handleMoveAllToBag}
              className="px-5 py-2.5 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] transition-all duration-300 text-[12px] font-semibold flex items-center gap-2 shrink-0 hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0"
            >
              <ShoppingBag className="w-4 h-4" />
              <span>Move All to Bag</span>
            </button>
          )}
        </div>

        {wishlist.length === 0 && wishlistUnavailable.length === 0 ? (
          !isAuthed ? (
            /* Guest — the wishlist is account-owned, so offer sign-in */
            <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-12 lg:p-16 text-center border border-[var(--color-botanical-border)] max-w-xl mx-auto space-y-4 overflow-hidden">
              <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-[#ffdad3]/15 blur-3xl pointer-events-none" />
              <div className="relative w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center">
                <Heart className="w-7 h-7 text-[#964735]" />
              </div>
              <h2 className="relative font-serif text-[26px] text-[var(--color-botanical-primary)]">Sign in to save your favorite creations.</h2>
              <p className="relative text-[14px] text-[var(--color-botanical-muted)]">
                Your saved gifts live with your account, so your favorite blooms follow you
                across devices. Browsing and adding to your bag never require an account.
              </p>
              <div className="relative pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
                <Link
                  to="/login?redirect=/wishlist"
                  className="inline-flex items-center gap-2 px-7 py-3 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] transition-all duration-300 text-[13px] font-semibold hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0"
                >
                  <UserRound className="w-4 h-4" />
                  <span>Sign In</span>
                </Link>
                <Link
                  to="/shop"
                  className="inline-flex items-center gap-2 px-7 py-3 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-all duration-300 text-[13px] font-semibold hover:shadow-sm hover:-translate-y-0.5 active:translate-y-0"
                >
                  <span>Continue Shopping</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          ) : (
            <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-12 lg:p-16 text-center border border-[var(--color-botanical-border)] max-w-xl mx-auto space-y-4 overflow-hidden">
              <div className="absolute -bottom-12 -left-12 w-40 h-40 rounded-full bg-[#d8e7cd]/15 blur-3xl pointer-events-none" />
              <div className="relative w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-3xl">
                🤍
              </div>
              <h2 className="relative font-serif text-[26px] text-[var(--color-botanical-primary)]">No keepsakes saved yet</h2>
              <p className="relative text-[14px] text-[var(--color-botanical-muted)]">
                Tap the heart on any bloom, card, or hamper in our catalog to save it to your Saved Gifts.
              </p>
              <div className="relative pt-2">
                <Link
                  to="/shop"
                  className="inline-flex items-center gap-2 px-7 py-3 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] transition-all duration-300 text-[13px] font-semibold hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0"
                >
                  <span>Browse The Collection</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          )
        ) : (
          <div ref={gridRef} className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-6">
            {wishlist.map((item) => (
              <div
                key={item.id}
                data-wishlist-card
                className="bg-[var(--color-surface-lowest)] rounded-3xl p-4 border border-[var(--color-botanical-border)] shadow-xs flex flex-col justify-between space-y-4 group hover:shadow-md transition-shadow duration-300"
              >
                <div className="relative aspect-square w-full rounded-2xl overflow-hidden bg-[var(--color-surface-low)]">
                  <Link to={`/product/${item.id}`}>
                    <img
                      loading="lazy"
                      decoding="async"
                      src={item.images ? item.images[0] : (item.image || '')}
                      alt={item.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    />
                  </Link>
                  <button
                    type="button"
                    onClick={() => toggleWishlist(item)}
                    className="absolute top-3 right-3 w-8 h-8 rounded-full bg-[var(--color-surface-lowest)]/90 shadow-sm flex items-center justify-center text-[#964735] hover:scale-110 transition-transform"
                    title="Remove from Saved Gifts"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-1">
                  <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">
                    {item.categoryLabel || item.category}
                  </span>
                  <Link to={`/product/${item.id}`}>
                    <h3 className="font-serif text-[18px] text-[var(--color-botanical-primary)] font-medium hover:text-[#964735] transition-colors">
                      {item.name}
                    </h3>
                  </Link>
                  <p className="text-[13px] text-[var(--color-botanical-muted)] line-clamp-2">
                    {item.shortDescription || item.description}
                  </p>
                </div>

                <div className="pt-3 border-t border-[var(--color-botanical-border)] flex items-center justify-between">
                  <span className="text-[17px] font-bold text-[var(--color-botanical-primary)]">
                    ₹{item.price.toLocaleString('en-IN')}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleMoveToBag(item)}
                    className="px-4 py-2 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] text-[12px] font-semibold flex items-center gap-1.5 transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
                  >
                    <ShoppingBag className="w-3.5 h-3.5" />
                    <span>Move to Bag</span>
                  </button>
                </div>
              </div>
            ))}

            {/* Products that were deleted or hidden still render so the
                customer can remove them — they are never silently dropped. */}
            {wishlistUnavailable.length > 0 && (
              <div className="col-span-full pt-6">
                <h3 className="font-serif text-[18px] text-[var(--color-botanical-subtle)] mb-4">No longer available</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {wishlistUnavailable.map((id) => (
                    <div
                      key={id}
                      data-wishlist-card
                      className="bg-[var(--color-surface-low)] rounded-3xl p-6 border border-dashed border-[#e0dcd6] flex flex-col items-center justify-between gap-4 text-center"
                    >
                      <div className="space-y-1.5">
                        <p className="text-[28px]">🥀</p>
                        <p className="font-serif text-[16px] text-[var(--color-botanical-muted)]">No longer available</p>
                        <p className="text-[12px] text-[var(--color-botanical-subtle)]">This creation was retired from the collection.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeUnavailableFromWishlist(id)}
                        className="px-4 py-2 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] text-[12px] font-semibold flex items-center gap-1.5 transition-all duration-300 hover:shadow-sm"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Remove</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
