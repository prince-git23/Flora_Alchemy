import api from './apiClient.js';

/**
 * Payment architecture (Phase 3D → 3E).
 *
 * This module is the single frontend seam for payment. When the server is
 * configured with Razorpay TEST MODE keys, the customer checkout runs through
 * Razorpay Checkout and the server verifies the signature before any order is
 * ever shown as paid. When the server is NOT configured (or a 503
 * PAYMENT_NOT_CONFIGURED is returned), the frozen prototype behavior remains:
 * paymentStatus 'Sample', no real charge.
 *
 * The browser never sees or handles the Razorpay secret — only the public key
 * id returned by our own backend.
 */

export const PAYMENT_METHODS = [
  { id: 'upi', label: 'Instant UPI', description: 'UPI via Razorpay Checkout', icon: 'qr' },
  { id: 'card', label: 'Cards & Netbanking', description: 'Cards / netbanking via Razorpay Checkout', icon: 'card' },
  { id: 'cod', label: 'Pay on Delivery', description: 'Cash or UPI at delivery', icon: 'cod' },
];

export function getPaymentMethods() {
  return PAYMENT_METHODS;
}

/**
 * Return only payment methods that are enabled in the admin Commerce
 * Settings (settings.paymentMethods). If settings is null, return all
 * methods (fallback safe).
 *
 * The mapping from admin toggles to checkout method ids:
 *   upi      → upi
 *   cards    → card
 *   netbanking → card (netbanking is part of the same Razorpay checkout flow)
 *   cod      → cod
 *   wallets  → (no matching checkout method yet — ignored)
 */
export function getEnabledPaymentMethods(settings) {
  if (!settings?.paymentMethods) return PAYMENT_METHODS;
  const pm = settings.paymentMethods;
  return PAYMENT_METHODS.filter((m) => {
    if (m.id === 'upi') return pm.upi !== false;
    if (m.id === 'card') return pm.cards !== false || pm.netbanking !== false;
    if (m.id === 'cod') return pm.cod === true;
    return true;
  });
}

export function getPaymentMethodById(id) {
  return PAYMENT_METHODS.find((m) => m.id === id) || PAYMENT_METHODS[0];
}

/** Frontend hint — the SERVER is authoritative (checked on each create-order). */
export function isRazorpayConfigured() {
  return Boolean(import.meta.env.VITE_RAZORPAY_KEY_ID);
}

export function isCod(methodId) {
  return methodId === 'cod';
}

/**
 * Prototype payment preparation — honest Sample status. Only used when the
 * server reports that online payment is not configured.
 */
export function preparePayment(methodId, amount) {
  const method = getPaymentMethodById(methodId);
  return {
    method: method.label,
    status: 'Sample',
    reference: null,
    amount: Number(amount) || 0,
    note: 'Prototype checkout — no real payment is processed and no charge is made.',
  };
}

// ─── Backend payment API (Phase 3E) ──────────────────────────────────────

/**
 * POST /api/payments/create-order — server creates (or reuses) a Razorpay
 * order for the Flora order and returns only public data. Throws with
 * code 'PAYMENT_NOT_CONFIGURED' when the server has no test keys.
 */
export async function createPaymentOrder(orderId) {
  const res = await api.post('/payments/create-order', { orderId }, { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'Payment could not be prepared.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  return res.data.payment;
}

/**
 * POST /api/payments/verify — send the Razorpay checkout result to the server.
 * The server verifies the signature; the frontend NEVER marks an order paid.
 * Pass { outcome: 'failed', failureReason } to record a failed attempt.
 */
export async function verifyPayment(orderId, payload) {
  const res = await api.post('/payments/verify', { orderId, ...payload }, { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'Payment could not be verified.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  return res.data.order;
}

/** GET /api/payments/:orderId/status — current payment state. */
export async function getPaymentStatus(orderId) {
  const res = await api.get(`/payments/${encodeURIComponent(orderId)}/status`, { scope: 'customer' });
  if (!res.ok) {
    const err = new Error(res.message || 'Payment status could not be loaded.');
    err.code = res.code;
    err.status = res.status;
    throw err;
  }
  return res.data.payment;
}

// ─── Razorpay Checkout (client) ──────────────────────────────────────────

let checkoutScriptPromise = null;

function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve();
  if (checkoutScriptPromise) return checkoutScriptPromise;
  checkoutScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      checkoutScriptPromise = null;
      reject(new Error('Razorpay Checkout could not be loaded. Please check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return checkoutScriptPromise;
}

/**
 * Open Razorpay Checkout with a SERVER-provided key id + order id.
 *
 * Resolves with:
 *   { success: true, razorpay_payment_id, razorpay_order_id, razorpay_signature }
 *   { success: false, cancelled: boolean, reason: string }
 *
 * The frontend treats success as "the checkout returned a result" — the order
 * is only paid after the server verifies the signature.
 */
export async function openRazorpayCheckout({ keyId, orderId, amount, currency = 'INR', name, email, phone, description }) {
  await loadRazorpayScript();

  return new Promise((resolve) => {
    const options = {
      key: keyId,
      amount, // integer paise (server-computed)
      currency,
      order_id: orderId,
      name: 'Flora Alchemy',
      description: description || 'Handcrafted botanical commission',
      // Razorpay accepts a relative or absolute URL for the checkout brand
      // image and recommends a square source of at least 128x128, which the
      // canonical 1080x1080 /branding/flora-alchemy-logo.jpg satisfies.
      image: '/branding/flora-alchemy-logo.jpg',
      prefill: {
        name: name || '',
        email: email || '',
        contact: phone || '',
      },
      theme: { color: '#180f0a' },
      handler(response) {
        resolve({
          success: true,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_order_id: response.razorpay_order_id,
          razorpay_signature: response.razorpay_signature,
        });
      },
      modal: {
        ondismiss() {
          resolve({ success: false, cancelled: true, reason: 'Payment was cancelled.' });
        },
      },
    };

    const rzp = new window.Razorpay(options);
    rzp.on('payment.failed', (response) => {
      const desc =
        (response && response.error && response.error.description) ||
        'Payment failed at the payment provider.';
      resolve({ success: false, cancelled: false, reason: desc });
    });
    rzp.open();
  });
}