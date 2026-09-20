import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Search, Package, MapPin, Sparkles, Clock, UserRound, ArrowRight, MessageSquare, History } from 'lucide-react';
import { getOrderById, fetchOrderFromApi, formatINR, formatDate, getCustomerFacingStatus } from '../services/orderService.js';
import { getActiveCustomerId } from '../services/customerService.js';
import OrderStatusTracker from '../components/OrderStatusTracker.jsx';
import { OrderStatusPill } from '../components/StatusPill.jsx';

/* ── GSAP ── */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function OrderTrackingPage() {
  const { orderId } = useParams();
  const [searchCode, setSearchCode] = useState(orderId || '');
  const pageRef = useRef(null);

  // Tracking requires an authenticated customer — orders are private records.
  // The sign-in destination preserves any order reference in the URL.
  const isAuthed = !!getActiveCustomerId();
  const trackingRedirect = orderId ? `/order-tracking/${orderId}` : '/order-tracking';

  const [currentOrder, setCurrentOrder] = useState(null);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    async function load() {
      const code = searchCode.trim();
      if (!code) return;
      // Fetch from the API to get the current database-backed status,
      // not the potentially stale in-memory store.
      const found = await fetchOrderFromApi(code);
      if (found) {
        setCurrentOrder(found);
        setError(null);
      } else {
        setCurrentOrder(null);
        setError('Order not found. Please check your order reference (e.g. FA-1024).');
      }
      setSearched(true);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = async (e) => {
    e.preventDefault();
    const code = searchCode.trim();
    if (!code) {
      setError('Please enter an order reference or tracking code.');
      return;
    }
    const found = await fetchOrderFromApi(code);
    if (found) {
      setCurrentOrder(found);
      setError(null);
    } else {
      setCurrentOrder(null);
      setError('Order not found. Please check your order reference (e.g. FA-1024).');
    }
    setSearched(true);
  };

  const delivery = currentOrder?.shippingAddress || {};
  const orderLabel = currentOrder
    ? getCustomerFacingStatus(currentOrder.orderStatus || 'new')
    : '';

  /* ── GSAP: status card entrance + timeline stagger ── */
  useEffect(() => {
    if (prefersReduced || !currentOrder || !pageRef.current) return;
    const ctx = gsap.context(() => {
      gsap.from('[data-track-card]', {
        y: 28, opacity: 0, duration: 0.7, ease: 'power3.out', stagger: 0.1,
      });
      const entries = pageRef.current.querySelectorAll('[data-history-entry]');
      if (entries.length) {
        gsap.from(entries, {
          x: -14, opacity: 0, duration: 0.45, ease: 'power2.out', stagger: 0.08, delay: 0.3,
        });
      }
    }, pageRef);
    return () => ctx.revert();
  }, [currentOrder]);

  return (
    <div ref={pageRef} className="w-full bg-[#fcf9f4] min-h-screen py-8 lg:py-16 relative overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[560px] h-[280px] rounded-full bg-[#ffdad3]/10 blur-3xl pointer-events-none" />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        {/* Title Header */}
        <div className="text-center max-w-2xl mx-auto mb-10 space-y-2">
          <span className="text-[11px] uppercase font-bold tracking-widest text-[#964735]">
            Order Tracking
          </span>
          <h1 className="font-serif text-[28px] sm:text-[36px] lg:text-[44px] text-[#180f0a] font-normal tracking-tight leading-tight">
            Track Your Botanical Keepsake
          </h1>
          <p className="text-[13px] sm:text-[15px] text-[#4e4540]">
            Follow the handcrafting, wax packaging, and dispatch journey of your order.
          </p>
        </div>

        {!isAuthed ? (
          /* Tracking requires an authenticated customer — no public order lookup */
          <div className="bg-white rounded-3xl p-10 sm:p-14 border border-[#e5e2dd] text-center space-y-5 shadow-sm max-w-xl mx-auto">
            <div className="w-14 h-14 rounded-full bg-[#f6f3ee] flex items-center justify-center mx-auto">
              <UserRound className="w-6 h-6 text-[#964735]" />
            </div>
            <div className="space-y-1">
              <h2 className="font-serif text-[28px] text-[#180f0a]">Sign in to track your order.</h2>
              <p className="text-[14px] text-[#4e4540] max-w-sm mx-auto">
                Order details are private. Sign in to see the dispatch status of your own orders —
                we&rsquo;ll bring you right back here.
              </p>
            </div>
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link
                to={`/login?redirect=${encodeURIComponent(trackingRedirect)}`}
                className="w-full sm:w-auto px-8 py-3.5 rounded-full bg-[#180f0a] hover:bg-[#964735] text-white text-[13px] font-semibold flex items-center justify-center gap-2 shadow-md transition-colors touch-target"
              >
                Sign In
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                to="/shop"
                className="w-full sm:w-auto px-8 py-3.5 rounded-full border border-[#e5e2dd] text-[#180f0a] hover:bg-[#f6f3ee] text-[13px] font-semibold transition-colors touch-target"
              >
                Back to Store
              </Link>
            </div>
          </div>
        ) : (
        <>
        {/* Quick Search Bar — authenticated customers only (their own orders) */}
        <div className="max-w-md mx-auto -mt-4 sm:-mt-6 mb-8 lg:mb-10">
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              type="text"
              value={searchCode}
              onChange={(e) => setSearchCode(e.target.value)}
              placeholder="Enter Order # or Tracking Code"
              className="w-full px-4 py-2.5 rounded-full bg-white text-[13px] border border-[#e5e2dd] focus:outline-none focus:ring-1 focus:ring-[#180f0a] touch-target"
            />
            <button
              type="submit"
              className="px-6 py-2.5 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] text-[13px] font-semibold transition-colors shrink-0 flex items-center gap-1.5 touch-target"
            >
              <Search className="w-4 h-4" />
              <span>Track</span>
            </button>
          </form>
          {error && <p className="text-[12px] text-[#964735] font-medium pt-2">{error}</p>}
          {searched && !error && currentOrder && (
            <p className="text-[12px] text-[#5b6d54] font-semibold pt-1">
              Showing {orderLabel} for #{currentOrder.id}
            </p>
          )}
        </div>

        {currentOrder && (
          <div className="space-y-8">
            {/* Status Card */}
            <div data-track-card className="bg-white rounded-3xl p-5 sm:p-6 lg:p-8 border border-[#e5e2dd] shadow-sm space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <OrderStatusPill status={currentOrder.orderStatus || 'new'} size="lg" />
                {currentOrder.trackingNumber && (
                  <span className="text-[12px] text-[#80756f]">
                    Tracking: <span className="font-mono font-bold text-[#180f0a]">{currentOrder.trackingNumber}</span>
                  </span>
                )}
              </div>

              <OrderStatusTracker order={currentOrder} />

              {/* Studio Notes Feed */}
              <div className="p-3 sm:p-4 rounded-2xl bg-[#f6f3ee] border border-[#e5e2dd] space-y-2">
                <div className="flex items-center gap-2 text-[#964735] text-[12px] font-bold uppercase tracking-wider">
                  <Sparkles className="w-4 h-4" />
                  <span>Order Progress Note</span>
                </div>
                <p className="text-[13px] text-[#4e4540] leading-relaxed">
                  {currentOrder.orderStatus === 'delivered'
                    ? 'Your handcrafted botanicals have arrived safely at the destination address.'
                    : currentOrder.orderStatus === 'shipped'
                    ? 'Your order has been handed to our courier partner and is on its way to you.'
                    : currentOrder.orderStatus === 'ready_to_dispatch'
                    ? 'Your order is wax-sealed, boxed, and ready for dispatch.'
                    : currentOrder.orderStatus === 'quality_check'
                    ? 'Your order is undergoing its final petal and packaging inspection.'
                    : currentOrder.orderStatus === 'in_production'
                    ? 'Each stem is being shaped and assembled by hand in our studio atelier.'
                    : currentOrder.orderStatus === 'confirmed'
                    ? 'Your order details have been confirmed and queued for crafting in our studio.'
                    : 'Your order has been received and is waiting to be confirmed.'}
                </p>
              </div>

              {/* Status History — real backend timeline (order.statusHistory) */}
              {Array.isArray(currentOrder.statusHistory) && currentOrder.statusHistory.length > 0 && (
                <div className="pt-2">
                  <div className="flex items-center gap-2 pb-3">
                    <History className="w-4 h-4 text-[#964735]" aria-hidden="true" />
                    <h3 className="text-[12px] font-bold uppercase tracking-wider text-[#180f0a]">Journey Log</h3>
                  </div>
                  <ol className="relative border-l border-[#e5e2dd] ml-2 space-y-4">
                    {[...currentOrder.statusHistory].reverse().map((entry, idx) => {
                      const at = entry.at || entry.changedAt || entry.createdAt;
                      const when = at ? new Date(at) : null;
                      const valid = when && !Number.isNaN(when.getTime());
                      return (
                        <li key={idx} data-history-entry className="ml-4 pl-1">
                          <span
                            className={`absolute -left-[5px] w-2.5 h-2.5 rounded-full ${idx === 0 ? 'bg-[#964735] ring-4 ring-[#ffdad3]/50' : 'bg-[#d9d3cc]'}`}
                            aria-hidden="true"
                          />
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className={`text-[13px] font-semibold ${idx === 0 ? 'text-[#964735]' : 'text-[#180f0a]'}`}>
                              {getCustomerFacingStatus(entry.status) || entry.status}
                            </span>
                            {valid && (
                              <time dateTime={when.toISOString()} className="text-[11px] text-[#b0a89f]">
                                {when.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                              </time>
                            )}
                          </div>
                          {entry.note && <p className="text-[12px] text-[#80756f] mt-0.5">{entry.note}</p>}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
            </div>

            {/* Delivery & Package Details Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 sm:gap-6">
              {/* Delivery Address Details */}
              <div data-track-card className="bg-white rounded-3xl p-6 border border-[#e5e2dd] shadow-xs space-y-4">
                <div className="flex items-center gap-2 border-b border-[#e5e2dd] pb-3">
                  <MapPin className="w-4 h-4 text-[#964735]" />
                  <h3 className="font-serif text-[18px] text-[#180f0a]">Delivery Destination</h3>
                </div>
                <div className="text-[14px] text-[#4e4540] space-y-1">
                  <p className="font-bold text-[#180f0a]">{delivery.name || '—'}</p>
                  <p>{delivery.address || '—'}</p>
                  <p>{delivery.city || '—'}, {delivery.state || ''} – {delivery.pincode || ''}</p>
                  <p className="pt-2 text-[12px] text-[#80756f]">Contact: {delivery.phone || '—'}</p>
                </div>
              </div>

              {/* Items in Package */}
              <div data-track-card className="bg-white rounded-3xl p-6 border border-[#e5e2dd] shadow-xs space-y-4">
                <div className="flex items-center gap-2 border-b border-[#e5e2dd] pb-3">
                  <Package className="w-4 h-4 text-[#964735]" />
                  <h3 className="font-serif text-[18px] text-[#180f0a]">Package Contents</h3>
                </div>
                <div className="space-y-3">
                  {(currentOrder.items || []).map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between text-[13px]">
                      <span className="font-medium text-[#180f0a] line-clamp-1 break-words min-w-0 flex-1 mr-3">{item.name}</span>
                      <span className="font-bold text-[#180f0a]">{formatINR(item.price * (item.quantity || 1))}</span>
                    </div>
                  ))}
                  {!currentOrder.items || currentOrder.items.length === 0 ? (
                    <p className="text-[13px] text-[#80756f]">No items recorded for this order.</p>
                  ) : null}
                  <div className="border-t border-[#e5e2dd] pt-2 flex justify-between font-bold text-[14px] text-[#180f0a]">
                    <span>Total Amount</span>
                    <span>{formatINR(currentOrder.total)}</span>
                  </div>
                  <div className="flex justify-between text-[12px] text-[#80756f]">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" /> Ordered on {formatDate(currentOrder.createdAt)}
                    </span>
                    <span>Payment: {currentOrder.paymentStatus || 'Paid'}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Assistance Banner */}
            <div className="p-5 sm:p-6 rounded-3xl bg-[#ebe8e3] flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="space-y-1 text-center sm:text-left">
                <p className="font-serif text-[18px] text-[#180f0a]">Need assistance with this order?</p>
                <p className="text-[13px] text-[#4e4540]">
                  Message our studio about this order, or visit your account for details.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3 shrink-0">
                <Link
                  to={`/order/${currentOrder.id || currentOrder.orderId}/conversation`}
                  className="px-5 py-2.5 rounded-full bg-[#180f0a] text-white text-[12px] font-semibold hover:bg-[#964735] transition-colors flex items-center gap-1.5 touch-target"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  <span>Message About This Order</span>
                </Link>
                <Link
                  to="/account"
                  className="px-5 py-2.5 rounded-full bg-white border border-[#e5e2dd] text-[#180f0a] text-[12px] font-semibold hover:bg-[#f6f3ee] transition-colors touch-target"
                >
                  Go to My Account
                </Link>
              </div>
            </div>
          </div>
        )}

        {!currentOrder && !error && (
          <div className="bg-white rounded-3xl p-10 sm:p-14 border border-[#e5e2dd] text-center space-y-4 shadow-sm max-w-xl mx-auto">
            <p className="font-serif text-[24px] text-[#180f0a]">Track your order</p>
            <p className="text-[14px] text-[#4e4540]">
              Enter the order reference from your confirmation (for example FA-1024) or your tracking code above to see its journey.
            </p>
            <div className="pt-2">
              <Link to="/account" className="inline-flex px-7 py-3.5 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold hover:bg-[#964735] transition-colors shadow-sm">
                View Orders in My Account
              </Link>
            </div>
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}
