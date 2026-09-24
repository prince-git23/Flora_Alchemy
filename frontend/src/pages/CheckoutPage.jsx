import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ShieldCheck, CreditCard, QrCode, Lock, UserRound, ArrowRight, ArrowLeft, Wallet, AlertCircle } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);
const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
import { useStore } from '../context/StoreContext.jsx';
import { createOrder } from '../services/orderService.js';
import { isCatalogueProduct } from '../services/productService.js';
import { validateStock } from '../services/inventoryService.js';
import { refreshProducts } from '../services/dataStore.js';
import { useStoreVersion } from '../hooks/useStoreVersion.js';
import {
  getActiveCustomer,
  getActiveCustomerId,
  saveAddressToAccount,
} from '../services/customerService.js';
import {
  saveCheckoutSnapshot,
  loadCheckoutSnapshot,
  clearCheckoutSnapshot,
} from '../services/apiClient.js';
import { getSettings, getShippingCost } from '../services/settingsService.js';
import {
  getEnabledPaymentMethods,
  getPaymentMethodById,
  preparePayment,
  createPaymentOrder,
  verifyPayment,
  openRazorpayCheckout,
  isRazorpayConfigured,
  isCod,
} from '../services/paymentService.js';

// Phase 20.4 — the stepper used to read Account → Delivery → Payment → Review,
// but the "Payment" step never took a payment: it only chose a method, and the
// customer was actually charged AFTER Review. That made the order look
// backwards (review, then pay?) and a failed payment threw the customer
// backwards from Review to Payment. Method selection and review are one
// decision, so they are now one stage, and the last label states the outcome.
const STEPS = ['Account', 'Delivery', 'Review & Pay', 'Confirmed'];
// The last label is the outcome marker, not a stage on this page: reaching it
// means the order exists and we have navigated to /order-success/:orderId.
const LAST_STEP = STEPS.length - 2; // 2 → Review & Pay

const STATES = ['Maharashtra', 'Delhi', 'Karnataka', 'Tamil Nadu', 'West Bengal', 'Gujarat', 'Rajasthan', 'Uttar Pradesh', 'Kerala', 'Telangana', 'Punjab', 'Haryana', 'Other'];

export default function CheckoutPage() {
  const navigate = useNavigate();
  const { cart, cartSubtotal, clearCart } = useStore();

  // Checkout requires an authenticated customer — there is no guest checkout.
  const activeCustomer = getActiveCustomer();
  const isAuthed = !!activeCustomer;

  const [step, setStep] = useState(0); // 0 Account · 1 Delivery · 2 Payment · 3 Review

  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    pincode: '',
    deliveryInstructions: ''
  });

  // Prefill delivery details from the authenticated customer's saved/default
  // address ONLY into empty fields — restored edits and typed values win.
  useEffect(() => {
    if (!activeCustomer) return;
    const addr = (activeCustomer.addresses || []).find((a) => a.isDefault) || (activeCustomer.addresses || [])[0];
    setFormData((prev) => ({
      ...prev,
      fullName: prev.fullName || activeCustomer.name || '',
      email: prev.email || activeCustomer.email || '',
      phone: prev.phone || activeCustomer.phone || '',
      address: prev.address || addr?.address || '',
      city: prev.city || addr?.city || '',
      state: prev.state || (addr?.state && STATES.includes(addr.state) ? addr.state : ''),
      pincode: prev.pincode || addr?.pincode || '',
    }));
    setIsSavedAddrSelected(!!addr);
  }, [activeCustomer?.id]);

  const [errors, setErrors] = useState({});
  const [shippingMethod, setShippingMethod] = useState('standard');
  const [paymentMethod, setPaymentMethod] = useState('upi');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [inventoryWarning, setInventoryWarning] = useState('');
  const [addressSaveError, setAddressSaveError] = useState('');
  const [isSavingAddress, setIsSavingAddress] = useState(false);
  const [isSavedAddrSelected, setIsSavedAddrSelected] = useState(true);

  // Phase 20.2 — live stock preflight.
  // Opening checkout silently revalidates the catalogue (stale-while-
  // revalidate, no loader), and every catalogue line is re-checked against
  // the embedded stock signal on each store tick. Review then SHOWS the
  // discrepancy with a path to fix it — instead of the old behaviour where
  // the check only ran at submit time (and, for customers, read an
  // admin-only slice that was always empty, so it never fired at all).
  const storeVersion = useStoreVersion();
  useEffect(() => {
    if (cart.length === 0) return;
    refreshProducts().catch(() => { /* keep confirmed data */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const stockIssues = useMemo(() => {
    const issues = [];
    cart.forEach((item) => {
      if (item.isAddOn || item.customGiftConfig) return;
      const key = item.productSlug || item.id;
      if (!isCatalogueProduct(key)) return; // made-to-order / custom — server-priced, not stock-tracked
      const check = validateStock(key, item.quantity || 1);
      if (!check.available) issues.push({ name: item.name, ...check });
    });
    return issues;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, storeVersion]);
  const stockBlocked = stockIssues.length > 0;
  // Payment flow state (Phase 3E). paymentPhase: idle | creating | checkout | verifying.
  const [paymentPhase, setPaymentPhase] = useState('idle');
  // The Flora order reference once placed — retries reuse the SAME order, so a
  // failed/cancelled payment never creates a duplicate order or a second
  // inventory deduction.
  const [pendingPaymentOrder, setPendingPaymentOrder] = useState(null);
  const pageRef = useRef(null);
  const headerRef = useRef(null);
  const stepContentRef = useRef(null);

  const settings = getSettings();
  const shippingCost = getShippingCost(cartSubtotal);
  const totalAmount = cartSubtotal + shippingCost;
  const freeShippingThreshold = settings?.freeShippingAbove ?? null;

  // ── Phase 20.3 — checkout context survives route changes and refreshes ──
  // Step, form and choices used to live only in React state: any /cart
  // round-trip or login round-trip remounted this page and restarted
  // checkout from step 0 with a blank form. The snapshot is debounced to
  // sessionStorage on every change and consumed once on remount. Declared
  // here so every referenced state variable is already initialized (TDZ).
  const restoredRef = useRef(false);
  const snapshotTimerRef = useRef(null);
  useEffect(() => {
    // Empty bag → nothing to preserve (and never resurrect a snapshot after
    // the order cleared the cart).
    if (cart.length === 0) return;
    // Phase 20.4 — never overwrite a snapshot that has not been consumed yet.
    // This effect is declared before the restore effect below, and both need
    // the hydrated bag, so on the first render where the cart is non-empty
    // this save would write the INITIAL state (step 0, default method) over the
    // saved context before the restore could read it — which is why a hard
    // refresh restarted checkout instead of returning to Review & Pay. The
    // restore sets this flag, and the state it restores then re-runs this
    // effect, so saving resumes immediately afterwards.
    if (!restoredRef.current) return;
    clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      saveCheckoutSnapshot({
        step,
        formData,
        shippingMethod,
        paymentMethod,
        cartIds: cart.map((i) => i.id),
      });
    }, 250);
    return () => clearTimeout(snapshotTimerRef.current);
  }, [step, formData, shippingMethod, paymentMethod, cart]);

  // Restore once the bag has actually loaded — StoreContext hydrates the cart
  // asynchronously, so comparing on the very first render would see an empty
  // bag and wrongly discard the snapshot. Declared AFTER the save effect so it
  // observes the stored snapshot before anything can write to it. The prefill
  // effect above only fills EMPTY fields, so restored user edits win.
  useEffect(() => {
    if (restoredRef.current) return;
    if (cart.length === 0) return;
    // Marked consumed before the snapshot is inspected: a stale or absent
    // snapshot must also unblock the save effect, or later edits would never
    // be persisted.
    restoredRef.current = true;
    const snap = loadCheckoutSnapshot();
    if (!snap || !snap.formData) return;
    const sameCart =
      Array.isArray(snap.cartIds) &&
      snap.cartIds.length === cart.length &&
      snap.cartIds.every((v, i) => v === cart[i].id);
    // Stale snapshot for a different bag → discard, start clean.
    if (!sameCart) {
      clearCheckoutSnapshot();
      return;
    }
    setFormData((prev) => ({ ...prev, ...snap.formData }));
    // Clamped to LAST_STEP: a Phase 20.3 snapshot may record the old step 3
    // (Review), which is now the "Confirmed" marker — restore it as the
    // merged Review & Pay stage instead of rendering an empty step.
    setStep(typeof snap.step === 'number' ? Math.min(LAST_STEP, Math.max(0, snap.step)) : 0);
    if (snap.shippingMethod === 'standard' || snap.shippingMethod === 'express') setShippingMethod(snap.shippingMethod);
    if (snap.paymentMethod) setPaymentMethod(snap.paymentMethod);
  }, [cart]);

  const validateDelivery = () => {
    const errs = {};
    if (!formData.fullName || formData.fullName.trim().length < 2) {
      errs.fullName = 'Please provide a valid recipient name.';
    }
    if (!formData.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      errs.email = 'Please provide a valid email address.';
    }
    if (!formData.phone || formData.phone.replace(/\D/g, '').length < 10) {
      errs.phone = 'Please provide a valid 10-digit phone number.';
    }
    if (!formData.address || formData.address.trim().length < 3) {
      errs.address = 'Please provide a delivery address.';
    }
    if (!formData.city || formData.city.trim().length < 2) {
      errs.city = 'Please provide a city.';
    }
    if (!formData.state) {
      errs.state = 'Please select a state.';
    }
    if (!formData.pincode || formData.pincode.replace(/\D/g, '').length < 6) {
      errs.pincode = 'Please provide a valid 6-digit postal code.';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
    if (errors[name]) {
      setErrors({ ...errors, [name]: null });
    }
  };

  const goToDelivery = () => {
    setSubmitError('');
    setInventoryWarning('');
    setStep(1);
  };

  // Phase 20.3 — Continue-to-Payment also persists the delivery details as
  // the customer's default address (first order seeds the book; later orders
  // refresh the matching entry). Address-book failures NEVER block the
  // current checkout — the order ships to the address in the form either
  // way — but the customer is told clearly that saving failed.
  const persistAddressToAccount = useCallback(async () => {
    if (!isAuthed) return;
    setIsSavingAddress(true);
    setAddressSaveError('');
    try {
      await saveAddressToAccount({
        name: formData.fullName,
        phone: formData.phone,
        address: formData.address,
        city: formData.city,
        state: formData.state,
        pincode: formData.pincode,
      });
    } catch (err) {
      // 422 validation problems are user-fixable; everything else is shown
      // verbatim but non-blocking.
      setAddressSaveError(
        err.status === 422
          ? `${err.message} The order can still use this address, but it was not saved for next time.`
          : `${err.message || 'Address could not be saved for next time.'} You can continue with this order.`
      );
    } finally {
      setIsSavingAddress(false);
    }
  }, [isAuthed, formData]);

  const continueToPayment = () => {
    if (!validateDelivery()) return;
    persistAddressToAccount();
    setStep(2);
  };

  const handlePlaceOrder = async (e) => {
    e.preventDefault();
    if (cart.length === 0) {
      setSubmitError('Your shopping bag is empty. Please select keepsakes before completing checkout.');
      return;
    }
    if (!validateDelivery()) {
      setStep(1);
      return;
    }

    setIsSubmitting(true);
    setSubmitError('');
    setInventoryWarning('');

    // Phase 20.2 — final preflight against the LIVE stock signal (same
    // memoised issues Review already displays). Made-to-order and custom
    // items are not stock-tracked and are skipped by isCatalogueProduct.
    if (stockIssues.length > 0) {
      setIsSubmitting(false);
      const first = stockIssues[0];
      setInventoryWarning(
        first.currentStock <= 0
          ? `"${first.name}" just went out of stock.`
          : `Only ${first.currentStock} of "${first.name}" available — please reduce the quantity in your bag.`
      );
      return;
    }

    // Phase 3E payment flow. The Flora order is created FIRST (existing
    // architecture — inventory reserved transactionally at creation). Then,
    // when the server has Razorpay TEST MODE configured and the customer
    // chose an online method, payment runs through Razorpay Checkout and the
    // server verifies the signature before the order can ever show as paid.
    // When the server is NOT configured, the frozen prototype path (Sample
    // status, no charge) is preserved exactly.
    const payment = preparePayment(paymentMethod, totalAmount);

    try {
      const newOrder = await createOrder({
        customerId: getActiveCustomerId(),
        items: cart,
        subtotal: cartSubtotal,
        shipping: shippingCost,
        total: totalAmount,
        paymentMethod: payment.method,
        shippingAddress: {
          name: formData.fullName,
          address: formData.address,
          city: formData.city,
          state: formData.state,
          pincode: formData.pincode,
          phone: formData.phone,
        },
        giftMessage: 'Thank you for your order.',
        isRush: shippingMethod === 'express',
      });
      const orderRef = newOrder.id || newOrder.orderId;
      setPendingPaymentOrder(orderRef);

      // The order exists now — clear the cart in every path so a reload or
      // re-submit can never create a duplicate order.
      await clearCart();
      // Phase 20.3 — the checkout snapshot must not resurrect this bag's
      // flow after the order completed.
      clearCheckoutSnapshot();

      // Pay on Delivery settles at delivery — no provider checkout.
      if (isCod(paymentMethod)) {
        setIsSubmitting(false);
        navigate(`/order-success/${orderRef}`);
        return;
      }

      let pay;
      try {
        setPaymentPhase('creating');
        pay = await createPaymentOrder(orderRef);
      } catch (payErr) {
        if (payErr.code === 'PAYMENT_NOT_CONFIGURED') {
          // Frozen prototype fallback — order keeps an honest Sample status.
          setPaymentPhase('idle');
          setIsSubmitting(false);
          navigate(`/order-success/${orderRef}`);
          return;
        }
        throw payErr;
      }

      setPaymentPhase('checkout');
      const result = await openRazorpayCheckout({
        keyId: pay.razorpayKeyId,
        orderId: pay.razorpayOrderId,
        amount: pay.amount,
        currency: pay.currency,
        name: formData.fullName,
        email: formData.email,
        phone: formData.phone,
        description: `Flora Alchemy order ${orderRef}`,
      });

      if (result.success) {
        // The frontend never marks the order paid — the server verifies the
        // signature and flips paymentStatus to Paid.
        setPaymentPhase('verifying');
        await verifyPayment(orderRef, {
          razorpay_payment_id: result.razorpay_payment_id,
          razorpay_order_id: result.razorpay_order_id,
          razorpay_signature: result.razorpay_signature,
        });
        setPaymentPhase('idle');
        setIsSubmitting(false);
        navigate(`/order-success/${orderRef}`);
        return;
      }

      // Failed or cancelled — record the honest state; retry keeps the SAME
      // Flora order (no duplicate order, no second inventory deduction).
      await verifyPayment(orderRef, { outcome: 'failed', failureReason: result.reason }).catch(() => {});
      setPaymentPhase('idle');
      setIsSubmitting(false);
      // Phase 20.4 — do NOT move the customer: review and payment are the same
      // stage now, so the recovery panel simply replaces it in place. The old
      // flow jumped BACKWARDS from Review to Payment here, which read as a
      // broken checkout.
      setSubmitError(result.reason || 'Payment was not completed.');
    } catch (err) {
      setPaymentPhase('idle');
      setIsSubmitting(false);
      // Phase 20.2 — stock moved between Review and submit (race with another
      // buyer / admin adjust): surface the server's clean business error as
      // an actionable availability warning, never a raw failure. No order
      // was created and nothing was deducted.
      if (err.code === 'INSUFFICIENT_STOCK' || err.code === 'UNAVAILABLE') {
        setSubmitError('');
        setInventoryWarning(err.message || 'Stock changed. Please review your bag.');
        return;
      }
      setSubmitError(err.message || 'Order placement encountered an issue. Please try again.');
    }
  };

  // Retry payment for an existing pending order — reuses the same Flora order
  // and the same server-created Razorpay order id. Never creates a duplicate
  // order and never deducts inventory a second time.
  const handleRetryPayment = async () => {
    if (!pendingPaymentOrder) return;
    setIsSubmitting(true);
    setSubmitError('');
    clearCheckoutSnapshot(); // Phase 20.3 — order already exists
    try {
      const pay = await createPaymentOrder(pendingPaymentOrder);
      setPaymentPhase('checkout');
      const result = await openRazorpayCheckout({
        keyId: pay.razorpayKeyId,
        orderId: pay.razorpayOrderId,
        amount: pay.amount,
        currency: pay.currency,
        name: formData.fullName,
        email: formData.email,
        phone: formData.phone,
        description: `Flora Alchemy order ${pendingPaymentOrder}`,
      });
      if (result.success) {
        setPaymentPhase('verifying');
        await verifyPayment(pendingPaymentOrder, {
          razorpay_payment_id: result.razorpay_payment_id,
          razorpay_order_id: result.razorpay_order_id,
          razorpay_signature: result.razorpay_signature,
        });
        setPaymentPhase('idle');
        setIsSubmitting(false);
        navigate(`/order-success/${pendingPaymentOrder}`);
        return;
      }
      await verifyPayment(pendingPaymentOrder, { outcome: 'failed', failureReason: result.reason }).catch(() => {});
      setPaymentPhase('idle');
      setIsSubmitting(false);
      setSubmitError(result.reason || 'Payment was not completed.');
    } catch (err) {
      setPaymentPhase('idle');
      setIsSubmitting(false);
      setSubmitError(err.message || 'Payment could not be retried. Please try again.');
    }
  };

  const paymentMethods = getEnabledPaymentMethods(settings);
  const selectedPayment = getPaymentMethodById(paymentMethod);
  const razorpayConfigured = isRazorpayConfigured();
  const defaultAddr = (activeCustomer?.addresses || []).find((a) => a.isDefault);
  const shippingLabel = shippingMethod === 'express'
    ? `Express Atelier Dispatch (₹${settings?.expressShippingRate ?? 250})`
    : (shippingCost === 0
      ? 'Standard Pan-India Dispatch · Complimentary'
      : `Standard Pan-India Dispatch (₹${settings?.standardShippingRate ?? 150})`);

  // Phase 20.4 fix — the recovery panel used to live INSIDE the review branch,
  // behind a `pendingPaymentOrder && submitError ? null :` guard that returned
  // before reaching it. A payment failure therefore rendered a checkout with
  // only the header and progress bar: no explanation, no retry, no way out.
  // It is its own branch now, so a payment failure always has exactly one
  // reachable, actionable state. Retry reuses the SAME Flora order — never a
  // duplicate order and never a second inventory deduction.
  const paymentRecoveryPanel = pendingPaymentOrder && submitError ? (
    <div
      role="alert"
      className="p-5 rounded-3xl bg-[var(--color-danger-soft-bg)] border border-[var(--color-danger-soft-border)] space-y-3 max-w-xl mx-auto my-8"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-[var(--color-danger-soft-fg)] shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <p className="text-[14px] font-semibold text-[var(--color-danger-soft-fg)]">Payment was not completed.</p>
          <p className="text-[12px] text-[var(--color-danger-soft-fg)]/90 mt-0.5">{submitError}</p>
          <p className="text-[12px] text-[var(--color-danger-soft-fg)]/90 mt-1">
            Your order <span className="font-mono font-semibold">{pendingPaymentOrder}</span> is saved
            with payment pending — no money has been charged and no duplicate order will be created.
          </p>
          <p className="text-[12px] text-[var(--color-danger-soft-fg)]/90 mt-1">
            Try again to reopen the secure window — you can pick a different payment method there.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleRetryPayment}
          disabled={isSubmitting}
          className="px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-50 touch-target"
        >
          {isSubmitting ? 'Opening Secure Checkout...' : 'Try Payment Again'}
        </button>
        <Link
          to="/account"
          className="px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-danger-soft-border)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors touch-target"
        >
          View My Orders
        </Link>
        <Link
          to="/shop"
          className="px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors touch-target"
        >
          Continue Shopping
        </Link>
      </div>
    </div>
  ) : null;

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen py-8 lg:py-16">
      {/* Ambient glow orbs for spatial depth */}
      <div className="absolute top-0 right-0 w-96 h-96 rounded-full bg-[var(--color-badge-bg)]/15 blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-80 h-80 rounded-full bg-[var(--color-botanical-sage-light)]/10 blur-3xl pointer-events-none" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        {/* Title */}
        <div ref={headerRef} className="space-y-1 mb-6">
          <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
            Secure Checkout
          </span>
          <h1 className="font-serif text-[28px] sm:text-[36px] lg:text-[42px] text-[var(--color-botanical-primary)] font-normal tracking-tight leading-tight">
            {step === 0 ? 'Your Account' : step === 1 ? 'Delivery Details' : 'Review & Pay'}
          </h1>
        </div>

        {/* Checkout progress.
            Phase 20.4 — every step now says what it is AND what state it is in,
            through an icon/number plus a screen-reader state word, so state is
            never carried by colour alone. The connector used a hardcoded
            #e5e2dd that stayed light in dark mode. */}
        {/* Compact form below sm: the full stepper cannot fit 390px without
            clipping or unreadably small labels. */}
        <div className="sm:hidden mb-6 space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">{STEPS[step]}</span>
            <span className="text-[11px] text-[var(--color-botanical-subtle)]">
              Step {step + 1} of {LAST_STEP + 1}
            </span>
          </div>
          <div
            className="h-1.5 rounded-full bg-[var(--color-surface-high)] overflow-hidden"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={LAST_STEP + 1}
            aria-valuenow={step + 1}
            aria-label={`Checkout step ${step + 1} of ${LAST_STEP + 1}: ${STEPS[step]}`}
          >
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                stockBlocked ? 'bg-amber-500' : 'bg-[var(--color-btn)]'
              }`}
              style={{ width: `${((step + 1) / (LAST_STEP + 1)) * 100}%` }}
            />
          </div>
        </div>

        <ol className="hidden sm:flex items-center gap-3 mb-8 lg:mb-10 max-w-3xl" aria-label="Checkout progress">
          {STEPS.map((label, i) => {
            const done = i < step;
            const current = i === step;
            // A stage that cannot be completed is "blocked". Stock is resolved
            // at the final stage (that is where submission happens), so that is
            // the stage flagged — not whichever step the customer happens to be
            // standing on.
            const blocked = i === LAST_STEP && stockBlocked;
            const state = blocked ? 'blocked' : current ? 'current' : done ? 'done' : 'upcoming';
            return (
              <li
                key={label}
                className="flex items-center gap-3 shrink-0"
                aria-current={current ? 'step' : undefined}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
                      blocked
                        ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/50'
                        : current
                          ? 'bg-[var(--color-btn)] text-white'
                          : done
                            ? 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)]'
                            : 'bg-[var(--color-surface-high)] text-[var(--color-botanical-primary)]'
                    }`}
                  >
                    {done ? '✓' : i + 1}
                  </span>
                  <span
                    className={`text-[12px] font-semibold ${
                      current || done ? 'text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-subtle)]'
                    }`}
                  >
                    {label}
                  </span>
                  <span className="sr-only">
                    {state === 'blocked'
                      ? '(needs attention before you can continue)'
                      : state === 'current'
                        ? '(current step)'
                        : state === 'done'
                          ? '(completed)'
                          : '(upcoming)'}
                  </span>
                </span>
                {i < STEPS.length - 1 && (
                  <span aria-hidden="true" className="w-6 h-px bg-[var(--color-botanical-border)]" />
                )}
              </li>
            );
          })}
        </ol>

        {!isAuthed ? (
          /* AUTHENTICATION GATE — no guest checkout */
          <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-10 sm:p-14 border border-[var(--color-botanical-border)] text-center space-y-5 shadow-sm max-w-xl mx-auto my-8 overflow-hidden">
            <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-[var(--color-badge-bg)]/20 blur-3xl pointer-events-none" />
            <div className="relative w-14 h-14 rounded-full bg-[var(--color-surface-low)] flex items-center justify-center mx-auto">
              <UserRound className="w-6 h-6 text-[var(--color-accent)]" />
            </div>
            <div className="relative space-y-1">
              <h2 className="font-serif text-[28px] text-[var(--color-botanical-primary)]">Sign in to continue</h2>
              <p className="text-[14px] text-[var(--color-botanical-muted)] max-w-sm mx-auto">
                Create an account or sign in to continue with checkout. Your bag is safe — we&rsquo;ll
                bring you right back here.
              </p>
            </div>
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
              {/* Phase 20.3 — snapshot the in-progress checkout BEFORE the auth
                  round-trip so sign-in returns the customer to this exact
                  step with their delivery details intact. The snapshot is
                  keyed to the current bag and discarded on mismatch. */}
              <button
                type="button"
                onClick={() => {
                  saveCheckoutSnapshot({ step, formData, shippingMethod, paymentMethod, cartIds: cart.map((i) => i.id) });
                  navigate('/login?redirect=/checkout');
                }}
                className="w-full sm:w-auto px-8 py-3.5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold flex items-center justify-center gap-2 shadow-md transition-colors touch-target"
              >
                Sign In
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  saveCheckoutSnapshot({ step, formData, shippingMethod, paymentMethod, cartIds: cart.map((i) => i.id) });
                  navigate('/login?mode=register&redirect=/checkout');
                }}
                className="w-full sm:w-auto px-8 py-3.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] text-[13px] font-semibold transition-colors touch-target"
              >
                Create Account
              </button>
            </div>
            <div className="relative">
              <Link to="/cart" className="text-[12px] font-semibold text-[var(--color-accent)] hover:underline">
                ← Back to Cart
              </Link>
            </div>
          </div>
        ) : paymentRecoveryPanel ? (
          paymentRecoveryPanel
        ) : cart.length === 0 ? (
          <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-10 sm:p-14 border border-[var(--color-botanical-border)] text-center space-y-4 shadow-sm max-w-xl mx-auto my-8 overflow-hidden">
            <div className="absolute -bottom-12 -left-12 w-40 h-40 rounded-full bg-[var(--color-botanical-sage-light)]/15 blur-3xl pointer-events-none" />
            <p className="font-serif text-[24px] text-[var(--color-botanical-primary)]">Your shopping bag is currently empty.</p>
            <p className="text-[14px] text-[var(--color-botanical-muted)]">
              Your bag is empty. Browse our handcrafted pieces and add your favorites before checking out.
            </p>
            <div className="pt-2">
              <Link
                to="/shop"
                className="inline-flex px-7 py-3.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors shadow-sm"
              >
                Browse Gifts
              </Link>
            </div>
          </div>
        ) : (
          <>
          <form onSubmit={handlePlaceOrder} noValidate>
            {submitError && (
              <div
                role="alert"
                className="p-4 rounded-2xl bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] text-[13px] font-medium border border-[var(--color-danger-soft-border)] mb-6"
              >
                {submitError}
              </div>
            )}
            {inventoryWarning && (
              <div className="p-4 rounded-2xl bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300 text-[13px] font-medium border border-amber-200 mb-6">
                {inventoryWarning}
                <Link to="/cart" className="ml-2 underline font-semibold">Review your bag</Link>
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
              {/* Left Details (7 cols) */}
              <div className="lg:col-span-7 space-y-8">
                {/* STEP 1 — ACCOUNT */}
                {step === 0 && (
                  <div ref={stepContentRef} className="bg-[var(--color-surface-lowest)] rounded-3xl p-8 sm:p-10 border border-[var(--color-botanical-border)] shadow-xs space-y-6 hover:shadow-sm transition-shadow duration-300">
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-full bg-[var(--color-surface-low)] flex items-center justify-center shrink-0">
                        <UserRound className="w-5 h-5 text-[var(--color-accent)]" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="font-serif text-[22px] text-[var(--color-botanical-primary)]">Signed in as {activeCustomer.name || 'you'}</h2>
                        <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">{activeCustomer.email}</p>
                        <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-2">
                          Your bag ({cart.length} item{cart.length > 1 ? 's' : ''}, ₹{cartSubtotal.toLocaleString('en-IN')}) is attached
                          to this account and will be used to place your order.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between border-t border-[var(--color-botanical-border)] pt-5">
                      <Link to="/cart" className="text-[12px] font-semibold text-[var(--color-accent)] hover:underline">
                        ← Back to Cart
                      </Link>                        <button
                          type="button"
                          onClick={goToDelivery}
                          className="px-8 py-3.5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold flex items-center gap-2 shadow-md transition-colors touch-target"
                        >
                        Continue to Delivery
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}

                {/* STEP 2 — DELIVERY */}
                {step === 1 && (
                  <>
                    {/* Delivery Address Section */}
                    <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-6 sm:p-8 border border-[var(--color-botanical-border)] shadow-xs space-y-6">
                      <h2 className="font-serif text-[22px] text-[var(--color-botanical-primary)] border-b border-[var(--color-botanical-border)] pb-3">
                        Recipient & Shipping Address
                      </h2>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="sm:col-span-2">
                          <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Full Name
                          </label>
                          <input
                            type="text"
                            name="fullName"
                            value={formData.fullName}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.fullName ? 'border-red-500 bg-red-50/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.fullName && (
                            <p className="text-[11px] text-red-600 mt-1 font-medium">{errors.fullName}</p>
                          )}
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Email Address
                          </label>
                          <input
                            type="email"
                            name="email"
                            value={formData.email}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.email ? 'border-red-500 bg-red-50/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.email && (
                            <p className="text-[11px] text-red-600 mt-1 font-medium">{errors.email}</p>
                          )}
                        </div>

                        <div>
                          <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Phone Number (For Delivery Coordination)
                          </label>
                          <input
                            type="tel"
                            name="phone"
                            value={formData.phone}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.phone ? 'border-red-500 bg-red-50/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.phone && (
                            <p className="text-[11px] text-red-600 mt-1 font-medium">{errors.phone}</p>
                          )}
                        </div>

                        <div>
                          <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            State
                          </label>
                          <select
                            name="state"
                            value={formData.state}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.state ? 'border-red-500 bg-red-50/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          >
                            <option value="">Select state</option>
                            {['Maharashtra', 'Delhi', 'Karnataka', 'Tamil Nadu', 'West Bengal', 'Gujarat', 'Rajasthan', 'Uttar Pradesh', 'Kerala', 'Telangana', 'Punjab', 'Haryana', 'Other'].map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                          {errors.state && (
                            <p className="text-[11px] text-red-600 mt-1 font-medium">{errors.state}</p>
                          )}
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Street Address & Apartment
                          </label>
                          <input
                            type="text"
                            name="address"
                            value={formData.address}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.address ? 'border-red-500 bg-red-50/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.address && (
                            <p className="text-[11px] text-red-600 mt-1 font-medium">{errors.address}</p>
                          )}
                        </div>

                        <div>
                          <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            City
                          </label>
                          <input
                            type="text"
                            name="city"
                            value={formData.city}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.city ? 'border-red-500 bg-red-50/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.city && (
                            <p className="text-[11px] text-red-600 mt-1 font-medium">{errors.city}</p>
                          )}
                        </div>

                        <div>
                          <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Pincode
                          </label>
                          <input
                            type="text"
                            name="pincode"
                            value={formData.pincode}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.pincode ? 'border-red-500 bg-red-50/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.pincode && (
                            <p className="text-[11px] text-red-600 mt-1 font-medium">{errors.pincode}</p>
                          )}
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Delivery Instructions <span className="normal-case font-medium text-[var(--color-botanical-subtle)]">(optional)</span>
                          </label>
                          <textarea
                            name="deliveryInstructions"
                            value={formData.deliveryInstructions}
                            onChange={handleInputChange}
                            rows="2"
                            placeholder="Gate code, preferred delivery window, or any note for our delivery partner."
                            className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] resize-none"
                          />
                        </div>
                      </div>

                      {/* Phase 20.3 — transparent persistence state: the customer
                          always knows whether this address will be remembered. */}
                      {addressSaveError ? (
                        <p role="status" className="text-[12px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/40 rounded-xl px-3 py-2">
                          {addressSaveError}
                        </p>
                      ) : isSavingAddress ? (
                        <p role="status" className="text-[12px] text-[var(--color-botanical-subtle)] flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full border-2 border-[var(--color-botanical-border)] border-t-[var(--color-accent)] animate-spin" aria-hidden="true" />
                          Saving this address to your account for next time…
                        </p>
                      ) : (
                        isSavedAddrSelected && (
                          <p role="status" className="text-[12px] text-[var(--color-botanical-sage)] flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                            Using your saved address — it will be reused for future orders.
                          </p>
                        )
                      )}
                    </div>

                    {/* Delivery Tier Options */}
                    <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-6 border border-[var(--color-botanical-border)] shadow-xs space-y-4">
                      <h2 className="font-serif text-[20px] text-[var(--color-botanical-primary)]">Delivery Options</h2>
                      <div className="space-y-3">
                        <label
                          onClick={() => setShippingMethod('standard')}
                          className={`flex items-center justify-between p-4 rounded-2xl border cursor-pointer transition-all ${
                            shippingMethod === 'standard' ? 'bg-[var(--color-surface-low)] border-[var(--color-btn)]' : 'border-[var(--color-botanical-border)]'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="radio"
                              checked={shippingMethod === 'standard'}
                              onChange={() => setShippingMethod('standard')}
                              className="text-[var(--color-botanical-primary)] focus:ring-0"
                            />
                            <div>
                              <p className="font-semibold text-[14px] text-[var(--color-botanical-primary)]">Standard Pan-India Dispatch</p>
                              <p className="text-[12px] text-[var(--color-botanical-subtle)]">Delivery within 3 to 5 business days with tracking.</p>
                            </div>
                          </div>
                          <span className="text-[13px] font-bold text-[var(--color-botanical-primary)]">
                            {(freeShippingThreshold !== null && cartSubtotal >= freeShippingThreshold) ? 'Complimentary' : `₹${settings?.standardShippingRate ?? 150}`}
                          </span>
                        </label>

                        <label
                          onClick={() => setShippingMethod('express')}
                          className={`flex items-center justify-between p-4 rounded-2xl border cursor-pointer transition-all ${
                            shippingMethod === 'express' ? 'bg-[var(--color-surface-low)] border-[var(--color-btn)]' : 'border-[var(--color-botanical-border)]'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="radio"
                              checked={shippingMethod === 'express'}
                              onChange={() => setShippingMethod('express')}
                              className="text-[var(--color-botanical-primary)] focus:ring-0"
                            />
                            <div>
                              <p className="font-semibold text-[14px] text-[var(--color-botanical-primary)]">Express Atelier Dispatch</p>
                              <p className="text-[12px] text-[var(--color-botanical-subtle)]">Priority creation in atelier + expedited dispatch (2 days).</p>
                            </div>
                          </div>
                          <span className="text-[13px] font-bold text-[var(--color-botanical-primary)]">₹{settings?.expressShippingRate ?? 250}</span>
                        </label>
                      </div>
                    </div>

                    {/* Delivery step actions */}
                    <div className="flex items-center justify-between">                        <button
                          type="button"
                          onClick={() => setStep(0)}
                          className="inline-flex items-center gap-2 px-5 py-3 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] text-[13px] font-semibold transition-colors touch-target"
                        >
                        <ArrowLeft className="w-4 h-4" />
                        Back
                      </button>
                      <button
                        type="button"
                        onClick={continueToPayment}
                        className="px-8 py-3.5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold flex items-center gap-2 shadow-md transition-colors touch-target"
                      >
                        Continue to Review &amp; Pay
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>
                  </>
                )}

                {/* STEP 3 — REVIEW & PAY.
                    Phase 20.4 — the separate "Payment" stage that used to sit
                    here chose a method but never took a payment (the charge
                    happened after Review), so the customer saw
                    Payment → Review and was then asked to pay. Method selection
                    now lives inside this stage, next to what it pays for. */}
                {step === 2 && (
                  <div className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
                    <div className="p-6 sm:p-8 border-b border-[var(--color-botanical-border)] flex items-center justify-between">
                      <h2 className="font-serif text-[22px] text-[var(--color-botanical-primary)]">Review &amp; Pay</h2>
                      <span className="text-[11px] font-semibold bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] px-3 py-1 rounded-full">
                        Step {LAST_STEP + 1} of {LAST_STEP + 1}
                      </span>
                    </div>

                    {/* Phase 20.2 — live availability problems are visible ON the
                        Review step with a direct path back to the bag. */}
                    {stockBlocked && (
                      <div role="alert" className="p-4 sm:p-6 border-b border-amber-200 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 space-y-1.5">
                        <p className="flex items-center gap-2 text-[13px] font-bold text-amber-900 dark:text-amber-300">
                          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                          Stock information changed
                        </p>
                        {stockIssues.map((iss) => (
                          <p key={iss.name} className="text-[12px] text-amber-900 dark:text-amber-300">
                            {iss.currentStock <= 0
                              ? `“${iss.name}” is out of stock.`
                              : `Only ${iss.currentStock} of “${iss.name}” available.`}
                          </p>
                        ))}
                        <Link to="/cart" className="inline-block text-[12px] font-bold text-amber-900 dark:text-amber-300 underline">
                          Review your bag
                        </Link>
                      </div>
                    )}

                    {/* 1. ITEMS — includes any persisted add-on so the
                      customer/A29 flow can verify it survived Bag → Checkout →
                      Review & Pay → Order → Admin: preserve across all
                      rewrite/reload/re-login paths. */}
                    <div className="p-6 sm:p-8 border-b border-[var(--color-botanical-border)]">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">Items ({cart.length})</h3>
                        <Link to="/cart" className="text-[11px] font-bold text-[var(--color-accent)] hover:underline">
                          Edit Cart
                        </Link>
                      </div>
                      <div className="space-y-4">
                        {cart.map((item, idx) => {
                          const lbl = item.isAddOn ? item.name : `${item.name} ×${item.quantity || 1}`;
                          const price = item.isAddOn ? item.price : (item.price * (item.quantity || 1));
                          return (
                            <div key={idx} className="flex items-start gap-3">
                              {item.image ? (
                                <img
                                  loading="lazy"
                                  decoding="async" src={item.image} alt={item.name} className="w-14 h-14 rounded-xl object-cover border border-[var(--color-botanical-border)]" />
                              ) : (
                                <span className="w-14 h-14 rounded-xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] flex items-center justify-center text-xl" aria-hidden="true">
                                  {item.isAddOn ? '🎁' : '🌸'}
                                </span>
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] font-medium text-[var(--color-botanical-primary)]">{lbl}</p>
                                <p className="text-[11px] text-[var(--color-botanical-subtle)]">{item.isAddOn ? 'Upgrade selected' : `Qty: ${item.quantity || 1}`}</p>
                                {(item.palette || item.ribbon || item.giftMessage) && !item.isAddOn && (
                                  <p className="text-[11px] text-[var(--color-accent)]">{item.palette ? `Palette: ${item.palette}` : ''}{(item.palette && item.ribbon ? ' · ' : '')}{item.ribbon ? `Ribbon: ${item.ribbon}` : ''}{(item.palette || item.ribbon) && item.giftMessage ? ' · ' : ''}{item.giftMessage ? `Gift note: “${item.giftMessage}”` : ''}</p>
                                )}
                                {item.isAddOn && (
                                  <p className="text-[11px] text-[var(--color-accent)]">{item.description ? item.description : 'Studio upgrade'}</p>
                                )}
                              </div>
                              <span className="text-[13px] font-bold text-[var(--color-botanical-primary)] shrink-0">
                                ₹{price.toLocaleString('en-IN')}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* 2. DELIVERY */}
                    <div className="p-6 sm:p-8 border-b border-[var(--color-botanical-border)]">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">Delivery</h3>
                        <button type="button" onClick={() => setStep(1)} className="text-[11px] font-bold text-[var(--color-accent)] hover:underline">
                          Edit Delivery
                        </button>
                      </div>
                      <p className="text-[14px] font-semibold text-[var(--color-botanical-primary)]">{formData.fullName} · {formData.phone}</p>
                      <p className="text-[13px] text-[var(--color-botanical-muted)] leading-relaxed">
                        {formData.address}, {formData.city}{formData.state ? `, ${formData.state}` : ''} – {formData.pincode}
                      </p>
                      {formData.deliveryInstructions && (
                        <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-1">Note: {formData.deliveryInstructions}</p>
                      )}
                      <p className="text-[12px] font-semibold text-[var(--color-accent)] mt-2">{shippingLabel}</p>
                    </div>

                    {/* 3. ACCOUNT */}
                    <div className="p-6 sm:p-8 border-b border-[var(--color-botanical-border)]">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">Account</h3>
                        <button type="button" onClick={() => setStep(0)} className="text-[11px] font-bold text-[var(--color-accent)] hover:underline">
                          Edit
                        </button>
                      </div>
                      <p className="text-[14px] font-semibold text-[var(--color-botanical-primary)]">{activeCustomer.name}</p>
                      <p className="text-[13px] text-[var(--color-botanical-muted)]">{activeCustomer.email}</p>
                    </div>

                    {/* 4. GIFT ADD-ONS (moved here from the old Payment step) */}
                    {cart.some((i) => i.isAddOn) && (
                      <div className="p-6 sm:p-8 border-b border-[var(--color-botanical-border)] space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                            Gift Add-ons
                          </span>
                          <span className="text-[11px] text-[var(--color-badge-fg-strong)] font-semibold bg-[var(--color-badge-bg)]/60 px-2.5 py-0.5 rounded-full">
                            {cart.filter((i) => i.isAddOn).length} selected
                          </span>
                        </div>
                        {cart.filter((i) => i.isAddOn).map((item) => (
                          <div key={item.id} className="p-3 rounded-xl bg-[var(--color-botanical-terracotta-light)]/40 border border-[#ffdad3]/50 space-y-1">
                            <div className="flex items-center justify-between">
                              <p className="text-[13px] font-semibold text-[var(--color-badge-fg-strong)]">{item.name}</p>
                              <p className="text-[12px] font-semibold text-[var(--color-badge-fg-strong)]">₹{item.price.toLocaleString('en-IN')}</p>
                            </div>
                            {item.description && (
                              <p className="text-[11px] text-[var(--color-badge-fg-strong)]">{item.description}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 5. PAYMENT — the method is chosen HERE, in the same stage
                        as review, because choosing a method is not a payment.
                        `selectedPayment` is still used for the summary line. */}
                    <div className="p-6 sm:p-8 space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                          Payment Method
                        </span>
                        {razorpayConfigured ? (
                          <span className="text-[11px] text-[var(--color-badge-fg-strong)] font-semibold bg-[var(--color-badge-bg)]/60 px-2.5 py-0.5 rounded-full">
                            TEST MODE · No real money will be charged
                          </span>
                        ) : (
                          <span className="text-[11px] text-[var(--color-success-soft-fg)] font-semibold bg-[var(--color-success-soft-bg)] px-2.5 py-0.5 rounded-full">
                            Demo payment · No real charge
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {paymentMethods.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => setPaymentMethod(m.id)}
                            aria-pressed={paymentMethod === m.id}
                            className={`py-3 px-3 rounded-2xl border text-[12px] font-semibold flex flex-col items-center justify-center gap-1.5 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${
                              paymentMethod === m.id ? 'bg-[var(--color-btn)] text-white border-[var(--color-btn)]' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-primary)] border-[var(--color-botanical-border)]'
                            }`}
                          >
                            <span className="flex items-center gap-1.5">
                              {m.icon === 'qr' ? <QrCode className="w-4 h-4" aria-hidden="true" /> : m.icon === 'card' ? <CreditCard className="w-4 h-4" aria-hidden="true" /> : <Wallet className="w-4 h-4" aria-hidden="true" />}
                              {m.label}
                            </span>
                            <span className={`text-[10px] font-normal ${paymentMethod === m.id ? 'text-white/70' : 'text-[var(--color-botanical-subtle)]'}`}>
                              {m.description}
                            </span>
                          </button>
                        ))}
                      </div>
                      <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                        <span className="font-semibold text-[var(--color-botanical-primary)]">Selected:</span> {selectedPayment.label} ·{' '}
                        {razorpayConfigured
                          ? 'online methods open Razorpay Checkout in test mode — the server verifies every payment signature before your order is marked Paid.'
                          : 'no payment gateway is connected, so an honest Sample payment status is recorded.'}
                      </p>
                    </div>

                    <div className="p-6 sm:p-8 bg-[var(--color-surface-low)]/60 border-t border-[var(--color-botanical-border)] space-y-4">
                      {/* Phase 20.4 — the final action must say exactly what
                          happens next, and it differs by method: an online
                          method opens the gateway, Pay on Delivery settles on
                          arrival. */}
                      {!stockBlocked && !isSubmitting && (
                        <p className="text-[12px] text-[var(--color-botanical-muted)] text-center sm:text-right">
                          {isCod(paymentMethod)
                            ? 'No payment now — you pay in full when your order arrives.'
                            : `Opens ${razorpayConfigured ? 'Razorpay secure checkout (Test Mode)' : 'the secure checkout'} to pay ₹${totalAmount.toLocaleString('en-IN')}.`}
                        </p>
                      )}
                      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                        <button
                          type="button"
                          onClick={() => setStep(1)}
                          className="inline-flex items-center gap-2 px-5 py-3 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] text-[13px] font-semibold transition-colors touch-target"
                        >
                          <ArrowLeft className="w-4 h-4" />
                          Back to Delivery
                        </button>
                        <button
                          type="submit"
                          disabled={isSubmitting || cart.length === 0 || stockBlocked}
                          className="w-full sm:w-auto px-10 py-4 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[14px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-md transition-all active:translate-y-0.5 disabled:opacity-50 touch-target"
                        >
                          <Lock className="w-4 h-4" aria-hidden="true" />
                          <span>
                            {isSubmitting
                              ? paymentPhase === 'checkout'
                                ? 'Opening Secure Checkout...'
                                : paymentPhase === 'verifying'
                                  ? 'Verifying Payment...'
                                  : 'Placing Order...'
                              : stockBlocked
                                ? 'Resolve stock issues to place order'
                                : isCod(paymentMethod)
                                  ? `Place Order · ₹${totalAmount.toLocaleString('en-IN')}`
                                  : `Pay ₹${totalAmount.toLocaleString('en-IN')}`}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Right Summary Col (5 cols) */}
              <div className="lg:col-span-5 sticky top-24 space-y-6">
                <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-6 sm:p-8 border border-[var(--color-botanical-border)] shadow-lg space-y-6 hover:shadow-xl transition-shadow duration-300">
                  <div className="border-b border-[var(--color-botanical-border)] pb-4 flex items-center justify-between">
                    <h3 className="font-serif text-[22px] text-[var(--color-botanical-primary)]">Order Summary</h3>
                    <div className="flex items-center gap-3">
                      <span className="text-[13px] text-[var(--color-botanical-subtle)]">{cart.length} item{cart.length > 1 ? 's' : ''}</span>
                      <Link to="/cart" className="text-[11px] font-bold text-[var(--color-accent)] hover:underline">Edit Cart</Link>
                    </div>
                  </div>

                  {/* Compact Item List */}
                  <div className="max-h-60 overflow-y-auto space-y-3 pr-2 scrollbar-thin">
                    {cart.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-3">
                        {item.image ? (
                          <img
                            loading="lazy"
                            decoding="async" src={item.image} alt={item.name} className="w-12 h-12 rounded-xl object-cover border border-[var(--color-botanical-border)]" />
                        ) : (
                          <span className="w-12 h-12 rounded-xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] flex items-center justify-center text-lg" aria-hidden="true">🎁</span>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-[var(--color-botanical-primary)] line-clamp-1 break-words">{item.name}</p>
                          <p className="text-[11px] text-[var(--color-botanical-subtle)]">
                            {item.isAddOn ? 'Gift add-on' : `Qty: ${item.quantity || 1}`}
                          </p>
                        </div>
                        <span className="text-[13px] font-bold text-[var(--color-botanical-primary)] shrink-0">
                          ₹{(item.price * (item.quantity || 1)).toLocaleString('en-IN')}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Subtotals */}
                  <div className="space-y-3 border-t border-[var(--color-botanical-border)] pt-4 text-[14px] text-[var(--color-botanical-muted)]">
                    <div className="flex justify-between">
                      <span>Subtotal</span>
                      <span className="font-semibold text-[var(--color-botanical-primary)]">₹{cartSubtotal.toLocaleString('en-IN')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Shipping</span>
                      <span className="font-semibold text-[var(--color-botanical-primary)]">
                        {shippingCost === 0 ? 'Complimentary' : `₹${shippingCost.toLocaleString('en-IN')}`}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-[var(--color-botanical-border)] pt-3 text-[18px] font-bold text-[var(--color-botanical-primary)]">
                      <span>Total Due</span>
                      <span>₹{totalAmount.toLocaleString('en-IN')}</span>
                    </div>
                  </div>

                  {/* Step-aware CTA */}
                  {step < LAST_STEP ? (
                    <button
                      type="button"
                      onClick={() => (step === 0 ? goToDelivery() : continueToPayment())}
                      disabled={cart.length === 0}
                      className="w-full py-4 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[14px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-md transition-all active:translate-y-0.5 disabled:opacity-50 touch-target"
                    >
                      Continue to {STEPS[step + 1]}
                      <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={isSubmitting || cart.length === 0 || stockBlocked}
                      className="w-full py-4 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[14px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-md transition-all active:translate-y-0.5 disabled:opacity-50 touch-target"
                    >
                      <Lock className="w-4 h-4" aria-hidden="true" />
                      <span>
                        {isSubmitting
                          ? 'Placing Order...'
                          : stockBlocked
                            ? 'Resolve stock issues first'
                            : isCod(paymentMethod)
                              ? `Place Order · ₹${totalAmount.toLocaleString('en-IN')}`
                              : `Pay ₹${totalAmount.toLocaleString('en-IN')}`}
                      </span>
                    </button>
                  )}

                  <div className="flex items-center justify-center gap-2 text-[12px] text-[var(--color-botanical-subtle)] text-center">
                    <ShieldCheck className="w-4 h-4 text-[var(--color-botanical-sage)]" />
                    <span>All orders are handcrafted with love and tracked securely.</span>
                  </div>
                </div>
              </div>
            </div>
          </form>
          </>
        )}
      </div>
    </div>
  );
}
