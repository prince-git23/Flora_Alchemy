import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShoppingBag, Trash2, ArrowRight, Gift, Truck, Sparkles } from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';
import { PACKAGING_ADD_ON } from '../services/api.js';
import { getSettings, getShippingCost } from '../services/settingsService.js';

/* ── GSAP (static import — stable across HMR) ── */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function CartPage() {
  const navigate = useNavigate();
  const { cart, cartSubtotal, updateItemQuantity, removeItemFromCart, addItemToCart } = useStore();
  const pageRef = useRef(null);
  const headerRef = useRef(null);
  const itemsRef = useRef(null);
  const summaryRef = useRef(null);
  const [qtyAnim, setQtyAnim] = useState(null);

  const settings = getSettings();

  // Add-ons live in the cart alongside products, so the visible subtotal must
  // separate them (the previous cart total added the upgrade twice).
  const productItems = cart.filter((item) => !item.isAddOn);
  const addOnItems = cart.filter((item) => item.isAddOn);
  const addOnTotal = addOnItems.reduce((sum, item) => sum + item.price * (item.quantity || 1), 0);
  const productSubtotal = cartSubtotal - addOnTotal;
  const itemCount = cart.reduce((sum, item) => sum + (item.quantity || 1), 0);

  // Shipping is authoritative: the same helper + settings the checkout uses.
  const shippingCost = cart.length === 0 ? 0 : getShippingCost(cartSubtotal);
  const grandTotal = cartSubtotal + shippingCost;

  const freeShippingThreshold = settings && settings.freeShippingAbove
    ? Number(settings.freeShippingAbove)
    : null;
  const amountToFreeShipping = freeShippingThreshold
    ? Math.max(0, freeShippingThreshold - cartSubtotal)
    : 0;

  const standardDays = settings?.shippingConfiguration?.standardDays;

  // Quantity bump animation
  const triggerQtyBump = useCallback((idx) => {
    setQtyAnim(idx);
    setTimeout(() => setQtyAnim(null), 300);
  }, []);

  /* ── GSAP entrance animations ── */
  useEffect(() => {
    if (prefersReduced || !pageRef.current) return;
    const ctx = gsap.context(() => {
      // Header reveal
      if (headerRef.current) {
        gsap.from(headerRef.current.children, {
          y: 24,
          opacity: 0,
          duration: 0.6,
          ease: 'power3.out',
          stagger: 0.08,
        });
      }
      // Cart items stagger
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
      // Summary panel reveal
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

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen py-8 lg:py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header Title */}
        <div ref={headerRef} className="space-y-1 mb-6 lg:mb-8">
          <span className="text-[11px] uppercase font-bold tracking-widest text-[#964735]">
            Artisanal Bag
          </span>
          <h1 className="font-serif text-[30px] sm:text-[36px] lg:text-[44px] text-[var(--color-botanical-primary)] font-normal tracking-tight leading-tight">
            Your Keepsake Bag
          </h1>
        </div>

        {cart.length === 0 ? (
          <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-8 sm:p-12 lg:p-16 text-center border border-[var(--color-botanical-border)] max-w-xl mx-auto space-y-4 overflow-hidden">
            {/* Ambient glow orbs */}
            <div className="absolute -top-20 -right-20 w-60 h-60 rounded-full bg-[#ffdad3]/30 blur-3xl pointer-events-none" />
            <div className="absolute -bottom-16 -left-16 w-48 h-48 rounded-full bg-[#d8e7cd]/25 blur-3xl pointer-events-none" />
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
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] transition-colors text-[13px] font-semibold shadow-md hover:shadow-lg active:translate-y-0.5 touch-target"
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
              {/* Complimentary shipping progress */}
              {freeShippingThreshold && (
                <div data-cart-item className="p-4 rounded-2xl bg-[var(--color-botanical-terracotta-light)]/40 border border-[#964735]/20 flex items-center gap-3">
                  <Gift className="w-5 h-5 text-[#964735] shrink-0" aria-hidden="true" />
                  <p className="text-[13px] text-[var(--color-botanical-primary)]">
                    {amountToFreeShipping === 0 ? (
                      <span><strong>Complimentary delivery unlocked</strong> — this order ships on us.</span>
                    ) : (
                      <span>Add <strong>₹{amountToFreeShipping.toLocaleString('en-IN')}</strong> more for complimentary delivery.</span>
                    )}
                  </p>
                </div>
              )}

              {/* Product lines */}
              <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-4 sm:p-6 border border-[var(--color-botanical-border)] divide-y divide-[#e5e2dd] space-y-0">
                {productItems.map((item) => {
                  const idx = cart.indexOf(item);
                  return (
                    <div key={`${item.id}-${item.palette || ''}-${item.ribbon || ''}-${idx}`} data-cart-item className="py-4 first:pt-0 last:pb-0 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-18 h-18 sm:w-20 sm:h-20 rounded-2xl overflow-hidden bg-[var(--color-surface-low)] shrink-0 border border-[var(--color-botanical-border)]">
                          {item.image ? (
                            <img
                              loading="lazy"
                              decoding="async" src={item.image} alt={item.name} className="w-full h-full object-cover" />
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
                            <p className="text-[11px] text-[#964735] italic break-words line-clamp-2">
                              Card: &ldquo;{item.giftMessage}&rdquo;
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
                            className="w-9 h-9 flex items-center justify-center text-[16px] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a] rounded-full disabled:opacity-30 disabled:cursor-not-allowed touch-target"
                          >
                            −
                          </button>
                          <span className={`text-[13px] font-semibold text-[var(--color-botanical-primary)] ${qtyAnim === idx ? 'fa-qty-bump' : ''}`} aria-live="polite">{item.quantity || 1}</span>
                          <button
                            type="button"
                            onClick={() => { updateItemQuantity(idx, (item.quantity || 1) + 1); triggerQtyBump(idx); }}
                            aria-label={`Increase quantity of ${item.name}`}
                            className="w-9 h-9 flex items-center justify-center text-[16px] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a] rounded-full touch-target"
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
                          onClick={() => removeItemFromCart(idx)}
                          aria-label={`Remove ${item.name} from bag`}
                          className="text-[var(--color-botanical-subtle)] hover:text-[#964735] p-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#964735] rounded-full transition-colors touch-target"
                        >
                          <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Selected add-ons */}
              {addOnItems.length > 0 && (
                <div data-cart-item className="bg-[var(--color-surface-lowest)] rounded-3xl p-4 sm:p-6 border border-[var(--color-botanical-border)] space-y-3">
                  <p className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Gift add-ons</p>
                  {addOnItems.map((item) => {
                    const idx = cart.indexOf(item);
                    return (
                      <div key={`${item.id}-${idx}`} className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="w-9 h-9 rounded-full bg-[#ffdad3]/60 flex items-center justify-center text-[#964735] shrink-0" aria-hidden="true">
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
                            onClick={() => removeItemFromCart(idx)}
                            aria-label={`Remove ${item.name} from bag`}
                            className="text-[var(--color-botanical-subtle)] hover:text-[#964735] p-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#964735] rounded-full transition-colors touch-target"
                          >
                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Studio Packaging Add-on */}
              <div data-cart-item className="p-4 rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <input
                    type="checkbox"
                    id="studio-pine-casket"
                    checked={addOnItems.some((item) => item.id === PACKAGING_ADD_ON.id)}
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
                    className="w-4 h-4 rounded text-[#964735] focus:ring-0 cursor-pointer"
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
                  Order Summary
                </h3>

                {/* Delivery information */}
                <div className="space-y-2">
                  <span className="block text-[11px] uppercase font-bold text-[var(--color-botanical-subtle)]">
                    Delivery
                  </span>
                  <p className="text-[12px] text-[#5b6d54] flex items-center gap-1.5 font-medium">
                    <Truck className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      Pan-India dispatch
                      {standardDays ? ` · ${standardDays}` : ''}
                    </span>
                  </p>
                </div>

                {/* Cost Breakdown */}
                <div className="space-y-3 text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)] border-t border-[var(--color-botanical-border)] pt-4">
                  <div className="flex justify-between">
                    <span>Subtotal ({itemCount} item{itemCount === 1 ? '' : 's'})</span>
                    <span className="font-semibold text-[var(--color-botanical-primary)]">₹{productSubtotal.toLocaleString('en-IN')}</span>
                  </div>
                  {addOnItems.map((item) => (
                    <div key={item.id} className="flex justify-between">
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-[#964735]" aria-hidden="true" />
                        {item.name}
                      </span>
                      <span className="font-semibold text-[var(--color-botanical-primary)]">₹{item.price.toLocaleString('en-IN')}</span>
                    </div>
                  ))}
                  <div className="flex justify-between">
                    <span>Pan-India Delivery</span>
                    <span className="font-semibold text-[var(--color-botanical-primary)]">
                      {shippingCost === 0 ? <span className="text-[#5b6d54]">Complimentary</span> : `₹${shippingCost.toLocaleString('en-IN')}`}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-[var(--color-botanical-border)] pt-3 text-[16px] sm:text-[18px] font-bold text-[var(--color-botanical-primary)]">
                    <span>Total Amount</span>
                    <span>₹{grandTotal.toLocaleString('en-IN')}</span>
                  </div>
                  <p className="text-[11px] text-[var(--color-botanical-subtle)]">Inclusive of all taxes.</p>
                </div>

                {/* Checkout Trigger */}
                <button
                  type="button"
                  onClick={() => navigate('/checkout')}
                  className="w-full py-4 rounded-full bg-[#180f0a] hover:bg-[#964735] text-white text-[13px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-md transition-all duration-200 hover:shadow-lg active:translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#964735] focus-visible:ring-offset-2 touch-target"
                >
                  <ShoppingBag className="w-4 h-4" aria-hidden="true" />
                  <span>Proceed to Checkout · ₹{grandTotal.toLocaleString('en-IN')}</span>
                </button>

                <div className="text-center pt-1">
                  <Link to="/shop" className="text-[12px] font-semibold text-[#964735] hover:underline">
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
