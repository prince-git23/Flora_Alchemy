import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, ArrowRight, Package, MapPin, Phone, Truck, Feather, MessageSquare, Home } from 'lucide-react';
import { getOrderById, formatINR, formatDate, getStatusStage, getCustomerFacingStatus } from '../services/orderService.js';

/* ── GSAP ── */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Description line for an ordered keepsake
function itemDescription(item) {
  const parts = [];
  if (item.palette) parts.push(item.palette);
  if (item.ribbon) parts.push(item.ribbon);
  if (item.customDetails) {
    const detail = item.customDetails;
    if (typeof detail === 'string' && detail.trim()) parts.push(detail.trim());
    else if (detail && detail.summary) parts.push(String(detail.summary));
  }
  return parts.length > 0 ? parts.join(' · ') : 'Handcrafted atelier piece';
}

export default function OrderSuccessPage() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const pageRef = useRef(null);
  const heroRef = useRef(null);
  const detailsRef = useRef(null);

  useEffect(() => {
    async function fetchOrder() {
      setLoading(true);
      if (!orderId) {
        navigate('/account', { replace: true });
        return;
      }
      const data = await getOrderById(orderId);
      setOrder(data);
      setLoading(false);
    }
    fetchOrder();
  }, [orderId]);

  /* ── GSAP entrance animation ── */
  useEffect(() => {
    if (prefersReduced || loading || !order || !pageRef.current) return;
    const ctx = gsap.context(() => {
      // Hero card entrance — restrained celebration
      if (heroRef.current) {
        gsap.from(heroRef.current, {
          y: 32,
          opacity: 0,
          scale: 0.97,
          duration: 0.7,
          ease: 'power3.out',
        });
      }
      // Details sections stagger
      if (detailsRef.current) {
        const sections = detailsRef.current.querySelectorAll('[data-order-section]');
        if (sections.length) {
          gsap.from(sections, {
            y: 24,
            opacity: 0,
            duration: 0.5,
            ease: 'power3.out',
            stagger: 0.08,
            scrollTrigger: {
              trigger: detailsRef.current,
              start: 'top 85%',
              once: true,
            },
          });
        }
      }
    }, pageRef);
    return () => ctx.revert();
  }, [loading, order]);

  if (loading) {
    return (
      <div className="w-full min-h-[60vh] flex items-center justify-center bg-[var(--color-surface-bg)]">
        <div className="text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-[var(--color-botanical-terracotta-light)]/40 mx-auto flex items-center justify-center animate-pulse">
            <CheckCircle2 className="w-6 h-6 text-[var(--color-accent)]" />
          </div>
          <p className="font-serif text-[18px] sm:text-[20px] text-[var(--color-botanical-primary)]">Loading your order...</p>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="w-full min-h-[60vh] flex flex-col items-center justify-center bg-[var(--color-surface-bg)] px-4 text-center space-y-4">
        <div className="relative">
          <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-[var(--color-badge-bg)]/15 blur-3xl pointer-events-none" />
          <p className="relative font-serif text-[20px] sm:text-[22px] text-[var(--color-botanical-primary)]">Order reference not found.</p>
        </div>
        <p className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)] max-w-md">
          We couldn't locate this order keepsake. You can check your recent orders in your account or explore the shop.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <Link to="/account" className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-all active:translate-y-0.5 touch-target text-center">
            View Account
          </Link>
          <Link to="/shop" className="px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-all active:translate-y-0 touch-target text-center">
            Browse Shop
          </Link>
        </div>
      </div>
    );
  }

  const items = order.items || [];
  const paymentStatus = order.paymentStatus || 'Pending';
  const delivery = order.shippingAddress || {};
  const firstName = (order.customerName || 'friend').trim().split(' ')[0];
  const statusStage = getStatusStage(order.orderStatus);
  const statusLabel = getCustomerFacingStatus(order.orderStatus);

  const cardMessage = order.giftMessage?.trim()
    || items.map((it) => it.giftMessage?.trim()).find(Boolean)
    || '';

  const paidPill = paymentStatus === 'Paid'
    ? <span className="px-2 py-0.5 rounded-full bg-[var(--color-botanical-sage-light)] text-[#2e5a2a] text-[10px] font-bold uppercase tracking-wide">Paid</span>
    : <span className="px-2 py-0.5 rounded-full bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)] text-[10px] font-bold uppercase tracking-wide">{paymentStatus}</span>;

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen py-8 lg:py-14 relative overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="absolute top-20 left-10 w-72 h-72 rounded-full bg-[var(--color-badge-bg)]/15 blur-3xl pointer-events-none" />
      <div className="absolute bottom-20 right-10 w-60 h-60 rounded-full bg-[var(--color-botanical-sage-light)]/10 blur-3xl pointer-events-none" />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        {/* ── Order Success Hero Card ── */}
        <div ref={heroRef} className="rounded-3xl border border-[var(--color-botanical-border)] shadow-[0_16px_40px_-12px_rgba(46,36,30,0.12)] bg-gradient-to-b from-[var(--color-surface-lowest)] via-[var(--color-surface-bg)] to-[var(--color-surface-low)] p-6 sm:p-8 lg:p-12 text-center space-y-4 sm:space-y-5 mb-8 overflow-hidden relative">
          {/* Inner glow */}
          <div className="absolute -top-20 -right-20 w-60 h-60 rounded-full bg-[var(--color-badge-bg)]/20 blur-3xl pointer-events-none" />

          {/* Confirmation Badge */}
          <div className={`relative w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-[var(--color-badge-bg)] border border-[#e8b3a6] shadow-inner mx-auto flex items-center justify-center ${!prefersReduced ? 'fa-success-celebrate' : ''}`}>
            <CheckCircle2 className="w-7 h-7 sm:w-8 sm:h-8 text-[var(--color-accent)]" />
          </div>

          <div className="relative space-y-2">
            <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
              Order Confirmed
            </span>
            <h1 className="font-serif text-[28px] sm:text-[34px] lg:text-[44px] text-[var(--color-botanical-primary)] font-normal leading-tight tracking-tight">
              Thank you, {firstName}!
            </h1>
            <p className="text-[13px] sm:text-[15px] text-[var(--color-botanical-muted)] max-w-xl mx-auto leading-relaxed">
              Your handcrafted gift has been received and is being prepared.
              {paymentStatus === 'Paid'
                ? ' A receipt for this order has been recorded in your account.'
                : ` Payment is recorded as ${paymentStatus.toLowerCase()} — no amount has been captured yet.`}
            </p>
          </div>

          {/* Details Bar */}
          <div className="relative grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 p-4 sm:p-6 rounded-2xl bg-[#f0eae1] border border-[#e5ddd2] text-left mt-2">
            <div className="space-y-1">
              <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Order</p>
              <p className="text-[13px] sm:text-[15px] font-bold text-[var(--color-botanical-primary)] font-mono">{order.id}</p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Date</p>
              <p className="text-[13px] sm:text-[15px] font-bold text-[var(--color-botanical-primary)]">{formatDate(order.createdAt)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Total</p>
              <p className="text-[13px] sm:text-[15px] font-bold text-[var(--color-botanical-primary)] flex items-center gap-2 flex-wrap">
                {formatINR(order.total)} {paidPill}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Status</p>
              <p className="inline-flex items-center gap-2 px-2 sm:px-3 py-1 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[11px] sm:text-[12px] font-semibold text-[var(--color-botanical-primary)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#5b6d54]" />
                {statusStage}. {statusLabel}
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="relative flex flex-col sm:flex-row flex-wrap items-center justify-center gap-3 pt-1">
            <Link
              to={`/order-tracking/${order.id}`}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 sm:px-7 py-3 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] border-2 border-[var(--color-btn)] hover:bg-[var(--color-surface-low)] transition-all duration-200 text-[13px] font-semibold shadow-sm active:translate-y-0.5 touch-target"
            >
              <Truck className="w-4 h-4" />
              <span>Track Order {order.id}</span>
            </Link>
            <Link
              to="/account"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 sm:px-7 py-3 rounded-full bg-[#964735] text-white hover:bg-[#7d3a2b] transition-all duration-200 text-[13px] font-semibold shadow-md active:translate-y-0.5 touch-target"
            >
              <Home className="w-4 h-4" />
              <span>View Account &amp; Order History</span>
            </Link>
            {order?.id && (
              <Link
                to={`/order/${order.id}/conversation`}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 sm:px-7 py-3 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] border-2 border-[#c17c74] hover:bg-[#fdf6f4] transition-all duration-200 text-[13px] font-semibold shadow-sm active:translate-y-0.5 touch-target"
              >
                <MessageSquare className="w-4 h-4" />
                <span>Message Flora Alchemy</span>
              </Link>
            )}
          </div>

          <p className="relative text-[11px] sm:text-[12px] text-[var(--color-botanical-subtle)] max-w-lg mx-auto leading-relaxed">
            Need to adjust your handwritten card wording or delivery window? Use the message button above to reach the Flora Alchemy team directly about this order.
          </p>
        </div>

        {/* ── Lower Two-Column Section ── */}
        <div ref={detailsRef} className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column — Keepsakes + Transcript */}
          <div className="lg:col-span-7 space-y-6">
            {/* Ordered Keepsakes */}
            <div data-order-section className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] shadow-sm p-5 sm:p-6 lg:p-7">
              <div className="flex items-center justify-between mb-5">
                <h2 className="font-serif text-[20px] sm:text-[22px] text-[var(--color-botanical-primary)]">Ordered Keepsakes</h2>
                <span className="text-[12px] sm:text-[13px] text-[var(--color-botanical-subtle)]">
                  {items.length} {items.length === 1 ? 'Item' : 'Items'}
                </span>
              </div>

              <div className="divide-y divide-[var(--color-divider)]">
                {items.map((item, idx) => (
                  <div key={idx} className="py-4 first:pt-0 last:pb-0 flex items-center gap-3 sm:gap-4">
                    <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl overflow-hidden bg-[var(--color-surface-low)] border border-[var(--color-botanical-border-light)] shrink-0 flex items-center justify-center">
                      {item.image ? (
                        <img
                          loading="lazy"
                          decoding="async" src={item.image} alt={item.name} className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-2xl">🌸</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-serif text-[14px] sm:text-[16px] text-[var(--color-botanical-primary)] font-medium leading-snug line-clamp-2 break-words">{item.name}</h3>
                      <p className="text-[11px] sm:text-[12px] text-[var(--color-botanical-muted)] leading-relaxed line-clamp-2 break-words">{itemDescription(item)}</p>
                      <p className="text-[10px] sm:text-[11px] text-[var(--color-botanical-subtle)] mt-0.5">Qty: {item.quantity || 1}</p>
                    </div>
                    <span className="text-[13px] sm:text-[15px] font-bold text-[var(--color-botanical-primary)] whitespace-nowrap">
                      {formatINR((item.price || 0) * (item.quantity || 1))}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Personalized Deckled Card Transcript */}
            {cardMessage && (
              <div data-order-section className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] shadow-sm p-5 sm:p-6 lg:p-7">
                <div className="flex items-center gap-2 mb-4">
                  <Feather className="w-4 h-4 text-[var(--color-accent)]" />
                  <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
                    Personalized Deckled Card Transcript
                  </span>
                </div>
                <div className="p-4 sm:p-5 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)]">
                  <p className="font-serif text-[15px] sm:text-[17px] text-[var(--color-botanical-text)] italic leading-relaxed">
                    &ldquo;{cardMessage}&rdquo;
                  </p>
                </div>
                <p className="text-[11px] sm:text-[12px] text-[var(--color-botanical-subtle)] mt-4 leading-relaxed">
                  Hand-inscribed on deckled cotton paper and finished with an organic wax seal.
                </p>
              </div>
            )}
          </div>

          {/* Right Column — Delivery + Conversation */}
          <div className="lg:col-span-5 space-y-6">
            {/* Delivery Destination */}
            <div data-order-section className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] shadow-sm p-5 sm:p-6 lg:p-7">
              <h2 className="font-serif text-[20px] sm:text-[22px] text-[var(--color-botanical-primary)] mb-4">Delivery Destination</h2>
              {delivery.name ? (
                <>
                  <div className="space-y-0.5 text-[13px] sm:text-[14px] text-[var(--color-botanical-text)]">
                    <p className="font-semibold text-[var(--color-botanical-primary)]">{delivery.name}</p>
                    <p>{delivery.address}</p>
                    <p>{[delivery.city, delivery.state].filter(Boolean).join(', ')} — {delivery.pincode}</p>
                  </div>
                  {delivery.phone && (
                    <p className="mt-2 flex items-center gap-1.5 text-[12px] sm:text-[13px] text-[var(--color-botanical-muted)]">
                      <Phone className="w-3.5 h-3.5 text-[var(--color-accent)]" />
                      Contact: {delivery.phone}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 pt-4">
                    <span className="px-3 py-1 rounded-full bg-[#f0eae1] text-[var(--color-botanical-muted)] text-[11px] font-semibold">
                      Standard Courier
                    </span>
                    <span className="px-3 py-1 rounded-full bg-[#f0eae1] text-[var(--color-botanical-muted)] text-[11px] font-semibold">
                      Handcrafted Delivery
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-[13px] text-[var(--color-botanical-muted)]">
                  Delivery details were not recorded for this order.
                </p>
              )}
            </div>

            {/* Order Conversation */}
            <div data-order-section className="rounded-3xl bg-[#2c2622] text-white p-5 sm:p-6 lg:p-7 shadow-md relative overflow-hidden">
              <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-[#964735]/10 blur-3xl pointer-events-none" />
              <div className="relative">
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full bg-[#7e947b] animate-pulse" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-[#e8b3a6]">
                    Order Support — Live
                  </span>
                </div>
                <h2 className="font-serif text-[20px] sm:text-[22px] text-white mb-2">Order Conversation</h2>
                <p className="text-[12px] sm:text-[13px] text-[#d4c3ba] leading-relaxed">
                  A direct messaging channel for inquiring about craft status, card wording, or parcel dispatch.
                </p>
                <Link
                  to={`/order/${order.id}/conversation`}
                  className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] text-[12px] font-semibold transition-all duration-200 active:translate-y-0.5 touch-target"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  Open Conversation
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
