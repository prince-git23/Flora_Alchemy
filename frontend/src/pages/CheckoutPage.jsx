import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { ShieldCheck, CreditCard, QrCode, Lock, UserRound, ArrowRight, ArrowLeft, Wallet, AlertCircle } from 'lucide-react';
// PHASE 3 §35 — Checkout is motion LEVEL 0. There is deliberately no entrance
// animation here: the customer is mid-payment and every transition has to be
// instant and predictable. The previous phase imported GSAP and registered
// ScrollTrigger on this route without ever animating anything, so the import
// (and its ~44 kB chunk) was dead weight and has been removed.
import { useStore } from '../context/StoreContext.jsx';
import { createOrder, fetchOrderFromApi } from '../services/orderService.js';
import { isCatalogueProduct, getProducts } from '../services/productService.js';
import { validateStock } from '../services/inventoryService.js';
import { listShops, getShopSettings } from '../services/shopService.js';
import { groupCartByShop } from '../services/cartGroups.js';
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
import { getSettings } from '../services/settingsService.js';
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
  const { cart, removeCartLines } = useStore();

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
  // PHASE 3 — SHOP-SELECTED CHECKOUT.
  //
  // The global bag may hold several shops, but a checkout belongs to exactly
  // ONE of them: the cart page links here as `/checkout?shop=<slug>`. The slug
  // is a SELECTION/LOOKUP key only — the server re-derives the real owner from
  // the Product rows and refuses a mixed or mismatched bag. The browser tenant
  // context is deliberately NOT consulted: shop navigation can never pick a
  // shop for the customer again.
  const [searchParams] = useSearchParams();
  const shopParam = String(searchParams.get('shop') || '').trim().toLowerCase();

  // The live shop directory — names the selected shop and detects a shop that
  // left discovery while the bag sat open.
  const [shops, setShops] = useState(null);
  useEffect(() => {
    let mounted = true;
    listShops()
      .then((res) => { if (mounted) setShops(res.ok ? res.shops : []); })
      .catch(() => { if (mounted) setShops([]); });
    return () => { mounted = false; };
  }, []);

  const { groups, addOns } = useMemo(
    () => groupCartByShop(cart, { catalog: getProducts(), shops: shops || [] }),
    [cart, shops, storeVersion]
  );
  // The selection: the explicit ?shop= when it matches a bag group, else the
  // only available group (an unambiguous single-shop bag needs no link).
  const selectedGroup = useMemo(() => {
    if (groups.length === 0) return null;
    if (shopParam) return groups.find((g) => g.slug === shopParam) || null;
    const available = groups.filter((g) => g.available);
    return available.length === 1 ? available[0] : null;
  }, [groups, shopParam]);
  // One shop's lines + the bag's add-ons (add-ons ride the checked-out shop).
  const checkoutItems = useMemo(
    () => (selectedGroup ? [...selectedGroup.items, ...(addOns || [])] : []),
    [selectedGroup, addOns]
  );
  const checkoutSubtotal = useMemo(
    () => checkoutItems.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1), 0),
    [checkoutItems]
  );
  const selectionError = cart.length > 0 && !selectedGroup
    ? groups.length > 1
      ? 'Your bag holds creations from more than one shop — choose the shop you want to check out.'
      : 'The shop for these items is not available right now. Please review your bag.'
    : '';

  // The selected shop's OWN public settings (shipping + availability). The
  // server uses the same stored values for the authoritative total, so this is
  // a matching estimate — never an authority.
  const [shopSettings, setShopSettings] = useState(null);
  // PHASE 7 — a settings fetch that FAILED is not the same fact as a shop that
  // is OPEN. The server still refuses a closed shop at creation (that authority
  // is untouched); this flag exists so the page never quietly implies ordering
  // is open when it simply could not find out.
  const [shopSettingsError, setShopSettingsError] = useState(false);
  const [shopSettingsAttempt, setShopSettingsAttempt] = useState(0);
  useEffect(() => {
    if (!selectedGroup?.slug) {
      setShopSettings(null);
      setShopSettingsError(false);
      return undefined;
    }
    let mounted = true;
    setShopSettingsError(false);
    getShopSettings(selectedGroup.slug)
      .then((res) => {
        if (!mounted) return;
        setShopSettings(res.ok ? res.settings : null);
        setShopSettingsError(!res.ok);
      })
      .catch(() => {
        if (!mounted) return;
        setShopSettings(null);
        setShopSettingsError(true);
      });
    return () => { mounted = false; };
  }, [selectedGroup?.slug, shopSettingsAttempt]);
  const shopClosed = Boolean(
    shopSettings && (shopSettings.acceptNewOrders === false || shopSettings.storeAvailability === 'closed')
  );

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
  // PHASE 3 §20 — the exact lines this checkout bought. They leave the global
  // bag only when the outcome is settled (paid / COD / no provider), so a
  // failed payment never silently discards them.
  const purchasedLinesRef = useRef([]);
  const clearPurchased = async () => {
    const lines = purchasedLinesRef.current;
    purchasedLinesRef.current = [];
    if (lines && lines.length) await removeCartLines(lines);
    clearCheckoutSnapshot();
  };
  const pageRef = useRef(null);
  const headerRef = useRef(null);
  const stepContentRef = useRef(null);

  const settings = getSettings();
  // PHASE 3 §9/§12 — the displayed shipping comes from the SELECTED shop's own
  // settings (the server computes the authoritative total from the same stored
  // values); the global storefront values are only a pre-hydration fallback.
  const shopShipping = shopSettings?.shippingConfiguration || null;
  const shippingCost = useMemo(() => {
    if (shippingMethod === 'express') {
      return Number(shopShipping?.expressRate ?? settings?.expressShippingRate ?? 0);
    }
    const threshold = Number(shopShipping?.freeShippingThreshold ?? settings?.freeShippingAbove ?? 0);
    const rate = Number(shopShipping?.standardRate ?? settings?.standardShippingRate ?? 0);
    return checkoutSubtotal >= threshold ? 0 : rate;
  }, [shippingMethod, shopShipping, settings, checkoutSubtotal]);
  const totalAmount = checkoutSubtotal + shippingCost;
  const freeShippingThreshold = shopShipping?.freeShippingThreshold ?? settings?.freeShippingAbove ?? null;

  // PHASE 7 — what is shown BEFORE the order exists is an ESTIMATE. The client
  // and the server read the same stored settings, but only the server's figures
  // are authoritative: a price edit, a shipping-settings change or a
  // shop-configured tax can move them between review and payment. Once the
  // order exists, `confirmedTotals` holds the shop's own numbers and any
  // difference is SHOWN, never swallowed.
  const [confirmedTotals, setConfirmedTotals] = useState(null);
  // PHASE 7 — the shop recalculated the order it just created, so its own
  // figures are shown and the customer continues deliberately. Never a silent
  // jump into a secure window asking for an amount they have not seen.
  const [repriceReview, setRepriceReview] = useState(false);
  const hasExistingOrder = Boolean(pendingPaymentOrder && confirmedTotals);
  const estimatedTotal = totalAmount;
  const displayTotal = confirmedTotals ? Number(confirmedTotals.total) : estimatedTotal;
  const displayedSubtotal = confirmedTotals ? Number(confirmedTotals.subtotal) : checkoutSubtotal;
  const displayedShipping = confirmedTotals ? Number(confirmedTotals.shipping) : shippingCost;
  const displayedTax = confirmedTotals ? Number(confirmedTotals.tax) || 0 : 0;
  const amountDrift = Boolean(
    confirmedTotals && Number(confirmedTotals.total) !== Number(estimatedTotal)
  );

  // PHASE 7 — delivery windows come from the same settings the shop configures
  // (and the same values the Cart page already reads), never from copy baked
  // into this page: a hardcoded "3 to 5 business days" silently contradicts a
  // window the owner has since edited, and inventing one at all is worse.
  const deliveryWindows = shopShipping || settings?.shippingConfiguration || null;
  const standardWindow = deliveryWindows?.standardDays || null;
  const expressWindow = deliveryWindows?.expressDays || null;

  // A pending order already exists (a retry, or a restored checkout snapshot),
  // so the shop's confirmed figures are available and are what the retry would
  // actually charge — read them instead of trusting the estimate.
  useEffect(() => {
    if (!pendingPaymentOrder) return undefined;
    let alive = true;
    fetchOrderFromApi(pendingPaymentOrder)
      .then((order) => {
        if (!alive || !order) return;
        setConfirmedTotals({
          subtotal: Number(order.subtotal) || 0,
          shipping: Number(order.shipping) || 0,
          tax: Number(order.tax) || 0,
          total: Number(order.total) || 0,
        });
      })
      .catch(() => { /* the estimate stays; nothing is implied about the amount */ });
    return () => { alive = false; };
  }, [pendingPaymentOrder]);

  // ── Phase 20.3 — checkout context survives route changes and refreshes ──
  // Step, form and choices used to live only in React state: any /cart
  // round-trip or login round-trip remounted this page and restarted
  // checkout from step 0 with a blank form. The snapshot is debounced to
  // sessionStorage on every change and consumed once on remount. Declared
  // here so every referenced state variable is already initialized (TDZ).
  const restoredRef = useRef(false);
  const snapshotTimerRef = useRef(null);
  // PHASE 7 — the ORDER REFERENCE is the one piece of checkout state whose loss
  // is not merely inconvenient. It is what tells a refreshed (or re-entered)
  // checkout that an order already exists and holds its stock; without it the
  // next submit creates a SECOND order and deducts the stock twice. The
  // debounce below exists so typing does not write on every keystroke, but
  // reserving an order is one discrete, irreversible-ish event — it is written
  // to storage immediately, before any refresh or navigation can beat the timer.
  const persistedOrderRef = useRef(null);
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
    const snapshot = {
      step,
      formData,
      shippingMethod,
      paymentMethod,
      // PHASE 3 — a pending payment survives a refresh: the snapshot keeps
      // the ORDER reference so retry reuses the same order instead of
      // creating a duplicate for lines that are still in the bag.
      pendingPaymentOrder,
      cartIds: cart.map((i) => i.id),
    };
    // PHASE 7 — a newly reserved order is persisted synchronously (see
    // persistedOrderRef above). Everything else keeps the 250ms debounce.
    if (pendingPaymentOrder && persistedOrderRef.current !== pendingPaymentOrder) {
      persistedOrderRef.current = pendingPaymentOrder;
      saveCheckoutSnapshot(snapshot);
      return undefined;
    }
    snapshotTimerRef.current = setTimeout(() => saveCheckoutSnapshot(snapshot), 250);
    return () => clearTimeout(snapshotTimerRef.current);
  }, [step, formData, shippingMethod, paymentMethod, cart, pendingPaymentOrder]);

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
    // Resume a payment that was left pending by a refresh — the recovery panel
    // then retries the SAME order instead of creating a duplicate. The mark is
    // set here too so the restored reference is not immediately re-written.
    if (snap.pendingPaymentOrder) {
      persistedOrderRef.current = snap.pendingPaymentOrder;
      setPendingPaymentOrder(snap.pendingPaymentOrder);
    }
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
    // PHASE 7 — LAST-RESORT GUARD. A checkout that already owns a reserved order
    // must never run order creation again: a second submit, an implicit
    // Enter-key submit, or a restored snapshot whose confirmed figures have not
    // arrived yet would otherwise create a duplicate order for lines whose stock
    // is already held. Continuing the reserved order is the ONLY action here.
    if (pendingPaymentOrder) {
      await continueExistingOrder();
      return;
    }
    if (cart.length === 0) {
      setSubmitError('Your shopping bag is empty. Please select keepsakes before completing checkout.');
      return;
    }
    // PHASE 3 — a checkout belongs to exactly one shop; never merge the bag.
    if (!selectedGroup) {
      setSubmitError(selectionError || 'Please choose the shop you want to check out.');
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
        // PHASE 3 — ONLY the selected shop's lines (+ add-ons) leave the bag
        // for this order; every other shop's products stay in the global bag.
        items: checkoutItems,
        subtotal: checkoutSubtotal,
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
        // PHASE 3 — the selected shop (a selection/LOOKUP key; the server
        // derives the real owner from the items and refuses a mismatch).
        shopSlug: selectedGroup.slug || undefined,
      });
      const orderRef = newOrder.id || newOrder.orderId;
      setPendingPaymentOrder(orderRef);
      purchasedLinesRef.current = checkoutItems;
      // PHASE 7 — adopt the shop's OWN figures from the order it just created.
      // If they differ from the estimate the customer was reviewing (an edited
      // price, a changed shipping rate, a shop-configured tax), the difference
      // is shown below BEFORE a payment is taken, instead of the gateway quietly
      // asking for a different amount than the page displayed.
      const shopTotals = {
        subtotal: Number(newOrder.subtotal) || 0,
        shipping: Number(newOrder.shipping) || 0,
        tax: Number(newOrder.tax) || 0,
        total: Number(newOrder.total) || 0,
      };
      setConfirmedTotals(shopTotals);

      // PHASE 7 — REPRICE STOP. The shop is the authority on what this order
      // costs and it has just recomputed the figures (a shop-configured tax an
      // estimate cannot see, an edited price, a changed delivery rate). When
      // they differ from the estimate the customer reviewed, the secure window
      // must NOT open on a number they have never seen: the shop's own figures
      // are shown and continuing is an explicit choice. The order already
      // exists with its stock reserved, so continuing pays THIS order.
      if (shopTotals.total !== Number(totalAmount)) {
        setRepriceReview(true);
        setIsSubmitting(false);
        return;
      }

      // Pay on Delivery settles at delivery — no provider checkout.
      if (isCod(paymentMethod)) {
        await clearPurchased();
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
          await clearPurchased();
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
        // Payment settled — now (and only now) the purchased lines leave the bag.
        await clearPurchased();
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
  /**
   * PHASE 7 — ONE way to pay an order that ALREADY exists.
   *
   * Retrying a failed payment, continuing past a shop reprice and resuming a
   * checkout whose order survived a reload are the same act: pay THIS order —
   * same reference, same server-computed amount, same reserved stock — and
   * never create a second one. Funnelling them through one function is what
   * makes that guarantee inspectable instead of hoped for.
   */
  const payExistingOrder = async (orderRef) => {
    if (!orderRef) return;
    setIsSubmitting(true);
    setSubmitError('');
    try {
      const pay = await createPaymentOrder(orderRef);
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
        setPaymentPhase('verifying');
        await verifyPayment(orderRef, {
          razorpay_payment_id: result.razorpay_payment_id,
          razorpay_order_id: result.razorpay_order_id,
          razorpay_signature: result.razorpay_signature,
        });
        // Settled — the purchased lines leave the global bag.
        await clearPurchased();
        setPaymentPhase('idle');
        setIsSubmitting(false);
        navigate(`/order-success/${orderRef}`);
        return;
      }
      await verifyPayment(orderRef, { outcome: 'failed', failureReason: result.reason }).catch(() => {});
      setPaymentPhase('idle');
      setIsSubmitting(false);
      setSubmitError(result.reason || 'Payment was not completed.');
    } catch (err) {
      // No provider configured: the same frozen prototype path order creation
      // takes, so the order keeps its honest Sample status instead of the
      // customer meeting a dead end.
      if (err.code === 'PAYMENT_NOT_CONFIGURED') {
        await clearPurchased();
        setPaymentPhase('idle');
        setIsSubmitting(false);
        navigate(`/order-success/${orderRef}`);
        return;
      }
      setPaymentPhase('idle');
      setIsSubmitting(false);
      setSubmitError(err.message || 'Payment could not be retried. Please try again.');
    }
  };

  const handleRetryPayment = () => payExistingOrder(pendingPaymentOrder);

  /**
   * PHASE 7 — the deliberate "yes, at this price" action for a reserved order.
   * Used by the reprice panel and by the review step, so a customer whose order
   * already exists can never re-run order creation by pressing it.
   */
  const continueExistingOrder = async () => {
    const orderRef = pendingPaymentOrder;
    if (!orderRef) return;
    setRepriceReview(false);
    // Pay on Delivery settles at delivery: there is nothing to open, the
    // reserved order simply proceeds to its confirmation.
    if (isCod(paymentMethod)) {
      setIsSubmitting(true);
      await clearPurchased();
      setIsSubmitting(false);
      navigate(`/order-success/${orderRef}`);
      return;
    }
    await payExistingOrder(orderRef);
  };

  /**
   * PHASE 7 — the review step renders its primary action twice: once in the
   * payment card and once in the order summary. Both are driven from this one
   * label so they can never disagree about what the button does — and, more
   * importantly, so neither one stays a SUBMIT after the shop has reserved an
   * order this checkout owns. A stale submit is not cosmetic: pressing it (or
   * pressing Enter in any field, which implicitly submits the first button)
   * would re-run order creation, creating a second order and holding the stock
   * twice for lines that were already reserved.
   */
  const primaryActionLabel = isSubmitting
    ? paymentPhase === 'verifying'
      ? 'Verifying Payment...'
      : paymentPhase === 'checkout' || hasExistingOrder
        ? 'Opening Secure Checkout...'
        : 'Placing Order...'
    : stockBlocked
      ? 'Resolve stock issues first'
      : hasExistingOrder
        ? isCod(paymentMethod)
          ? `Confirm Order · ₹${displayTotal.toLocaleString('en-IN')}`
          : `Continue payment · ₹${displayTotal.toLocaleString('en-IN')}`
        : isCod(paymentMethod)
          ? `Place Order · ₹${displayTotal.toLocaleString('en-IN')}`
          : `Pay ₹${displayTotal.toLocaleString('en-IN')}`;

  const paymentMethods = getEnabledPaymentMethods(settings);
  const selectedPayment = getPaymentMethodById(paymentMethod);
  const razorpayConfigured = isRazorpayConfigured();
  const defaultAddr = (activeCustomer?.addresses || []).find((a) => a.isDefault);
  const shippingLabel = shippingMethod === 'express'
    ? `Express Atelier Dispatch (₹${shopShipping?.expressRate ?? settings?.expressShippingRate ?? 250})`
    : (shippingCost === 0
      ? 'Standard Pan-India Dispatch · Complimentary'
      : `Standard Pan-India Dispatch (₹${shopShipping?.standardRate ?? settings?.standardShippingRate ?? 150})`);

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
            {confirmedTotals && (
              <> This order&rsquo;s confirmed total of ₹{displayTotal.toLocaleString('en-IN')} is what the shop charges.</>
            )}
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
          {/* PHASE 7 — name the amount the retry will actually charge (the
              server-recomputed order total). The gateway is server-priced, so
              this is the same figure the customer is about to see there. */}
          {isSubmitting
            ? 'Opening Secure Checkout...'
            : confirmedTotals
              ? `Try Payment Again · ₹${displayTotal.toLocaleString('en-IN')}`
              : 'Try Payment Again'}
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

  // PHASE 7 — the shop's confirmed figures disagreed with the estimate the
  // customer reviewed (a price edit, a shipping-settings change or a
  // shop-configured tax between review and creation). It is rendered by BOTH
  // the reprice panel and the payment-recovery panel, which each REPLACE the
  // form — the form itself shows the confirmed figures in its summary instead,
  // because there the comparison may be against a bag the customer has since
  // changed and would therefore be misleading.
  const amountDriftNotice = amountDrift && confirmedTotals ? (
    <div role="alert" className="p-4 rounded-2xl bg-[var(--color-warning-soft-bg)] text-[var(--color-warning-soft-fg)] text-[13px] font-medium border border-[var(--color-warning-soft-border)] mb-6 space-y-1">
      <p className="font-bold">The shop recalculated this order when it was created.</p>
      <p>
        Items ₹{Number(confirmedTotals.subtotal).toLocaleString('en-IN')}
        {' · '}Delivery {Number(confirmedTotals.shipping) === 0 ? 'Complimentary' : `₹${Number(confirmedTotals.shipping).toLocaleString('en-IN')}`}
        {Number(confirmedTotals.tax) > 0 && (
          <>{' · '}Tax ₹{Number(confirmedTotals.tax).toLocaleString('en-IN')}</>
        )}
        {' → '}
        <strong>₹{Number(confirmedTotals.total).toLocaleString('en-IN')}</strong>
        {' '}(you were shown ₹{Number(estimatedTotal).toLocaleString('en-IN')}).
      </p>
      <p>
        Nothing has been charged yet —{' '}
        {isCod(paymentMethod)
          ? 'this confirmed total is what you pay on delivery.'
          : 'the secure window charges this confirmed total.'}
      </p>
    </div>
  ) : null;

  /**
   * PHASE 7 — the shop recalculated the order at creation, so the customer is
   * shown its OWN figures before anything is charged and continues on purpose.
   * The order is already reserved (its stock is held), so this step creates
   * nothing: continuing pays THAT order, and leaving keeps it for later.
   */
  const repricePanel = repriceReview && confirmedTotals ? (
    <div className="max-w-xl mx-auto my-8 space-y-4">
      {amountDriftNotice}
      <div className="p-5 rounded-3xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] space-y-4 shadow-sm">
        <div>
          <p className="text-[14px] font-semibold text-[var(--color-botanical-primary)]">
            Nothing is charged until you continue.
          </p>
          <p className="text-[12px] text-[var(--color-botanical-muted)] mt-1 leading-relaxed">
            Order <span className="font-mono font-semibold">{pendingPaymentOrder}</span> is reserved for
            you at this confirmed total, so no second order will be created. If you leave now it stays
            reserved — you can finish it later from your account.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={continueExistingOrder}
            disabled={isSubmitting}
            className="px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-50 touch-target"
          >
            {isSubmitting
              ? 'Opening Secure Checkout...'
              : isCod(paymentMethod)
                ? `Confirm Order · ₹${displayTotal.toLocaleString('en-IN')}`
                : `Continue to Pay ₹${displayTotal.toLocaleString('en-IN')}`}
          </button>
          <Link
            to="/account"
            className="px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors touch-target"
          >
            View my orders
          </Link>
        </div>
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
                stockBlocked ? 'bg-[var(--color-warning-soft-border)]' : 'bg-[var(--color-btn)]'
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
                        ? 'bg-[var(--color-warning-soft-bg)] text-[var(--color-warning-soft-fg)] border border-[var(--color-warning-soft-border)]'
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
              <Link to="/cart" className="inline-flex items-center py-2 text-[12px] font-semibold text-[var(--color-accent)] hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
                ← Back to Cart
              </Link>
            </div>
          </div>
        ) : repricePanel ? (
          repricePanel
        ) : paymentRecoveryPanel ? (
          <div className="max-w-xl mx-auto">
            {amountDriftNotice}
            {paymentRecoveryPanel}
          </div>
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
        ) : selectionError ? (
          <div role="alert" className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-10 sm:p-14 border border-[var(--color-botanical-border)] text-center space-y-4 shadow-sm max-w-xl mx-auto my-8">
            <p className="font-serif text-[24px] text-[var(--color-botanical-primary)]">Choose a shop to check out</p>
            <p className="text-[14px] text-[var(--color-botanical-muted)]">{selectionError}</p>
            <div className="pt-2">
              <Link
                to="/cart"
                className="inline-flex px-7 py-3.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors shadow-sm"
              >
                Back to Bag
              </Link>
            </div>
          </div>
        ) : (
          <>
          <form onSubmit={handlePlaceOrder} noValidate>
            {/* PHASE 3 — the selected shop is explicit and visible; the server
                independently derives the real owner from the items. */}
            <div className="flex flex-wrap items-center justify-between gap-2 p-4 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] mb-6">
              <p className="text-[13px] text-[var(--color-botanical-primary)]">
                Ordering from <strong className="font-semibold">{selectedGroup?.displayName}</strong>
                {groups.length > 1 && (
                  <span className="text-[var(--color-botanical-subtle)]">
                    {' '}· {groups.length - 1} other shop{groups.length - 1 === 1 ? '' : 's'} stay in your bag
                  </span>
                )}
              </p>
              <Link to="/cart" className="text-[11px] font-bold text-[var(--color-accent)] hover:underline">
                Switch shop
              </Link>
            </div>
            {shopClosed && (
              <div role="alert" className="p-4 rounded-2xl bg-[var(--color-warning-soft-bg)] text-[var(--color-warning-soft-fg)] text-[13px] font-medium border border-[var(--color-warning-soft-border)] mb-6">
                {selectedGroup?.displayName} is not accepting new orders right now. Your bag is safe — please try again later.
              </div>
            )}
            {/* PHASE 7 — a FAILED settings fetch is not evidence that ordering is
                open. The shop's server still has the final say (it refuses a
                closed shop at creation); this notice exists so the page never
                quietly implies approval it could not confirm. */}
            {shopSettingsError && !shopSettings && (
              <div
                role="status"
                className="p-4 rounded-2xl bg-[var(--color-warning-soft-bg)] text-[var(--color-warning-soft-fg)] text-[13px] font-medium border border-[var(--color-warning-soft-border)] mb-6 flex flex-wrap items-center justify-between gap-3"
              >
                <span>
                  {selectedGroup?.displayName}&rsquo;s delivery and availability settings could not be loaded, so
                  this page cannot confirm the shop is accepting orders. The totals below are an estimate and
                  the shop confirms them when the order is placed.
                </span>
                <button
                  type="button"
                  onClick={() => setShopSettingsAttempt((n) => n + 1)}
                  className="shrink-0 px-4 py-2 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-warning-soft-border)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors touch-target"
                >
                  Try again
                </button>
              </div>
            )}
            {/* PHASE 7 — a recoverable submit failure is reported here, beside
                the action that caused it, with the customer's details intact.
                The reprice/recovery panels carry the shop's confirmed figures
                instead: on this step the comparison could be against a bag the
                customer has since changed, which would misstate the reason. */}
            {submitError && (
              <div
                role="alert"
                className="p-4 rounded-2xl bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] text-[13px] font-medium border border-[var(--color-danger-soft-border)] mb-6"
              >
                {submitError}
              </div>
            )}
            {inventoryWarning && (
              <div className="p-4 rounded-2xl bg-[var(--color-warning-soft-bg)] text-[var(--color-warning-soft-fg)] text-[13px] font-medium border border-[var(--color-warning-soft-border)] mb-6">
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
                          Your order ({checkoutItems.length} item{checkoutItems.length === 1 ? '' : 's'}, ₹{checkoutSubtotal.toLocaleString('en-IN')}) from {selectedGroup?.displayName} is attached
                          to this account and will be used to place your order.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between border-t border-[var(--color-botanical-border)] pt-5">
                      <Link to="/cart" className="inline-flex items-center py-2 text-[12px] font-semibold text-[var(--color-accent)] hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
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
                          <label htmlFor="checkout-fullName" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Full Name
                          </label>
                          <input
                            type="text"
                            id="checkout-fullName"
                            name="fullName"
                            value={formData.fullName}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.fullName ? 'border-[var(--color-danger)] bg-[var(--color-danger-soft-bg)]/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.fullName && (
                            <p className="text-[11px] text-[var(--color-danger)] mt-1 font-medium">{errors.fullName}</p>
                          )}
                        </div>

                        <div className="sm:col-span-2">
                          <label htmlFor="checkout-email" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Email Address
                          </label>
                          <input
                            type="email"
                            id="checkout-email"
                            name="email"
                            value={formData.email}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.email ? 'border-[var(--color-danger)] bg-[var(--color-danger-soft-bg)]/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.email && (
                            <p className="text-[11px] text-[var(--color-danger)] mt-1 font-medium">{errors.email}</p>
                          )}
                        </div>

                        <div>
                          <label htmlFor="checkout-phone" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Phone Number (For Delivery Coordination)
                          </label>
                          <input
                            type="tel"
                            id="checkout-phone"
                            name="phone"
                            value={formData.phone}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.phone ? 'border-[var(--color-danger)] bg-[var(--color-danger-soft-bg)]/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.phone && (
                            <p className="text-[11px] text-[var(--color-danger)] mt-1 font-medium">{errors.phone}</p>
                          )}
                        </div>

                        <div>
                          <label htmlFor="checkout-state" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            State
                          </label>
                          <select
                            id="checkout-state"
                            name="state"
                            value={formData.state}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.state ? 'border-[var(--color-danger)] bg-[var(--color-danger-soft-bg)]/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          >
                            <option value="">Select state</option>
                            {['Maharashtra', 'Delhi', 'Karnataka', 'Tamil Nadu', 'West Bengal', 'Gujarat', 'Rajasthan', 'Uttar Pradesh', 'Kerala', 'Telangana', 'Punjab', 'Haryana', 'Other'].map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                          {errors.state && (
                            <p className="text-[11px] text-[var(--color-danger)] mt-1 font-medium">{errors.state}</p>
                          )}
                        </div>

                        <div className="sm:col-span-2">
                          <label htmlFor="checkout-address" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Street Address & Apartment
                          </label>
                          <input
                            type="text"
                            id="checkout-address"
                            name="address"
                            value={formData.address}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.address ? 'border-[var(--color-danger)] bg-[var(--color-danger-soft-bg)]/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.address && (
                            <p className="text-[11px] text-[var(--color-danger)] mt-1 font-medium">{errors.address}</p>
                          )}
                        </div>

                        <div>
                          <label htmlFor="checkout-city" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            City
                          </label>
                          <input
                            type="text"
                            id="checkout-city"
                            name="city"
                            value={formData.city}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.city ? 'border-[var(--color-danger)] bg-[var(--color-danger-soft-bg)]/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.city && (
                            <p className="text-[11px] text-[var(--color-danger)] mt-1 font-medium">{errors.city}</p>
                          )}
                        </div>

                        <div>
                          <label htmlFor="checkout-pincode" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Pincode
                          </label>
                          <input
                            type="text"
                            id="checkout-pincode"
                            name="pincode"
                            value={formData.pincode}
                            onChange={handleInputChange}
                            className={`w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border ${
                              errors.pincode ? 'border-[var(--color-danger)] bg-[var(--color-danger-soft-bg)]/20' : 'border-[var(--color-botanical-border)]'
                            } focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]`}
                          />
                          {errors.pincode && (
                            <p className="text-[11px] text-[var(--color-danger)] mt-1 font-medium">{errors.pincode}</p>
                          )}
                        </div>

                        <div className="sm:col-span-2">
                          <label htmlFor="checkout-deliveryInstructions" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">
                            Delivery Instructions <span className="normal-case font-medium text-[var(--color-botanical-subtle)]">(optional)</span>
                          </label>
                          <textarea
                            id="checkout-deliveryInstructions"
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
                        <p role="status" className="text-[12px] text-[var(--color-warning-soft-fg)] bg-[var(--color-warning-soft-bg)] border border-[var(--color-warning-soft-border)] rounded-xl px-3 py-2">
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
                              {/* PHASE 7 — the window is the shop's setting, not page
                                  copy: "3 to 5 business days" was hardcoded here and
                                  contradicted the configured window, and a tracking
                                  promise is not something this page can make. */}
                              {standardWindow && (
                                <p className="text-[12px] text-[var(--color-botanical-subtle)]">Delivery in {standardWindow}.</p>
                              )}
                            </div>
                          </div>
                          <span className="text-[13px] font-bold text-[var(--color-botanical-primary)]">
                            {(freeShippingThreshold !== null && checkoutSubtotal >= freeShippingThreshold) ? 'Complimentary' : `₹${shopShipping?.standardRate ?? settings?.standardShippingRate ?? 150}`}
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
                              <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                                Priority creation in atelier{expressWindow ? ` · dispatch in ${expressWindow}` : ''}.
                              </p>
                            </div>
                          </div>
                          <span className="text-[13px] font-bold text-[var(--color-botanical-primary)]">₹{shopShipping?.expressRate ?? settings?.expressShippingRate ?? 250}</span>
                        </label>
                      </div>
                      {/* PHASE 7 — once an order exists (a payment retry), these
                          options no longer move it: the shop holds that order's
                          delivery terms and total, and the retry charges exactly
                          those. Say so instead of letting a toggled radio imply
                          an amount it cannot change. */}
                      {confirmedTotals && pendingPaymentOrder && (
                        <p className="text-[12px] text-[var(--color-botanical-muted)]" role="status">
                          Order {pendingPaymentOrder} is already reserved, so delivery changes will not alter it —
                          its total stays ₹{displayTotal.toLocaleString('en-IN')}.
                        </p>
                      )}
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
                      <div role="alert" className="p-4 sm:p-6 border-b border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft-bg)] space-y-1.5">
                        <p className="flex items-center gap-2 text-[13px] font-bold text-[var(--color-warning-soft-fg)]">
                          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                          Stock information changed
                        </p>
                        {stockIssues.map((iss) => (
                          <p key={iss.name} className="text-[12px] text-[var(--color-warning-soft-fg)]">
                            {iss.currentStock <= 0
                              ? `“${iss.name}” is out of stock.`
                              : `Only ${iss.currentStock} of “${iss.name}” available.`}
                          </p>
                        ))}
                        <Link to="/cart" className="inline-block text-[12px] font-bold text-[var(--color-warning-soft-fg)] underline">
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
                        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">Items ({checkoutItems.length})</h3>
                        <Link to="/cart" className="text-[11px] font-bold text-[var(--color-accent)] hover:underline">
                          Edit Cart
                        </Link>
                      </div>
                      <div className="space-y-4">
                        {checkoutItems.map((item, idx) => {
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
                          <div key={item.id} className="p-3 rounded-xl bg-[var(--color-botanical-terracotta-light)]/40 border border-[var(--color-badge-bg)]/50 space-y-1">
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
                            : `Opens ${razorpayConfigured ? 'Razorpay secure checkout (Test Mode)' : 'the secure checkout'} to pay ₹${displayTotal.toLocaleString('en-IN')}.`}
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
                        {/* PHASE 7 — in the normal flow this is the submit that
                            creates the order. Once an order has been reserved it
                            becomes a plain button that CONTINUES that order, so
                            the review step holds no second submit that could
                            create a duplicate (the label is shared with the
                            summary action, which must never disagree with it). */}
                        <button
                          type={hasExistingOrder ? 'button' : 'submit'}
                          onClick={hasExistingOrder ? continueExistingOrder : undefined}
                          disabled={isSubmitting || cart.length === 0 || stockBlocked}
                          className="w-full sm:w-auto px-10 py-4 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[14px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-md transition-all active:translate-y-0.5 disabled:opacity-50 touch-target"
                        >
                          <Lock className="w-4 h-4" aria-hidden="true" />
                          <span>{primaryActionLabel}</span>
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
                      <span className="text-[13px] text-[var(--color-botanical-subtle)]">{checkoutItems.length} item{checkoutItems.length === 1 ? '' : 's'}</span>
                      <Link to="/cart" className="text-[11px] font-bold text-[var(--color-accent)] hover:underline">Edit Cart</Link>
                    </div>
                  </div>

                  {/* Compact Item List */}
                  <div className="max-h-60 overflow-y-auto space-y-3 pr-2 scrollbar-thin">
                    {checkoutItems.map((item, idx) => (
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
                      <span>Shop</span>
                      <span className="font-semibold text-[var(--color-botanical-primary)]">{selectedGroup?.displayName}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Subtotal</span>
                      <span className="font-semibold text-[var(--color-botanical-primary)]">₹{displayedSubtotal.toLocaleString('en-IN')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Shipping</span>
                      <span className="font-semibold text-[var(--color-botanical-primary)]">
                        {displayedShipping === 0 ? 'Complimentary' : `₹${displayedShipping.toLocaleString('en-IN')}`}
                      </span>
                    </div>
                    {/* PHASE 7 — a tax line exists only when the SHOP's own stored
                        settings legitimately produced one (the server computes it
                        and returns it on the order); this page never estimates a
                        tax it cannot see. The label is the generic word because a
                        shop's own label is not part of its public settings. */}
                    {displayedTax > 0 && (
                      <div className="flex justify-between">
                        <span>Tax</span>
                        <span className="font-semibold text-[var(--color-botanical-primary)]">₹{displayedTax.toLocaleString('en-IN')}</span>
                      </div>
                    )}
                    <div className="flex justify-between border-t border-[var(--color-botanical-border)] pt-3 text-[18px] font-bold text-[var(--color-botanical-primary)]">
                      {/* PHASE 7 — accurate terminology: before the order exists
                          this number is what the shop is expected to charge, not
                          a confirmed order total. */}
                      <span>{confirmedTotals ? 'Confirmed Total' : 'Estimated Total'}</span>
                      <span>₹{displayTotal.toLocaleString('en-IN')}</span>
                    </div>
                    {hasExistingOrder ? (
                      <p className="text-[11px] text-[var(--color-botanical-subtle)] leading-relaxed" role="status">
                        Order {pendingPaymentOrder} already exists, so this continues that order's payment —
                        no second order is created and its confirmed total above is what is charged.
                      </p>
                    ) : (
                      <p className="text-[11px] text-[var(--color-botanical-subtle)] leading-relaxed">
                        {selectedGroup?.displayName} confirms these figures when the order is placed — if they
                        differ you will see the shop's own numbers before anything is charged.
                      </p>
                    )}
                  </div>

                  {/* Step-aware CTA */}
                  {step < LAST_STEP ? (
                    <button
                      type="button"
                      onClick={() => (step === 0 ? goToDelivery() : continueToPayment())}
                      disabled={cart.length === 0 || !!selectionError}
                      className="w-full py-4 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[14px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-md transition-all active:translate-y-0.5 disabled:opacity-50 touch-target"
                    >
                      Continue to {STEPS[step + 1]}
                      <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </button>
                  ) : (
                    // PHASE 7 — when this checkout already owns an order, the
                    // primary action CONTINUES it. It is deliberately not a
                    // submit button any more: re-running order creation would
                    // create a duplicate order and a second stock deduction.
                    <button
                      type={hasExistingOrder ? 'button' : 'submit'}
                      onClick={hasExistingOrder ? continueExistingOrder : undefined}
                      disabled={isSubmitting || checkoutItems.length === 0 || stockBlocked || shopClosed}
                      className="w-full py-4 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[14px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-md transition-all active:translate-y-0.5 disabled:opacity-50 touch-target"
                    >
                      <Lock className="w-4 h-4" aria-hidden="true" />
                      <span>{primaryActionLabel}</span>
                    </button>
                  )}

                  <div className="flex items-center justify-center gap-2 text-[12px] text-[var(--color-botanical-subtle)] text-center">
                    <ShieldCheck className="w-4 h-4 text-[var(--color-botanical-sage)]" />
                    {/* PHASE 7 — "tracked securely" promised a courier capability
                        this page cannot know is configured; no public setting
                        carries it, so the line now promises only what the app
                        actually provides: order updates inside the account. */}
                    <span>Handcrafted with care, with order updates and tracking in your account.</span>
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
