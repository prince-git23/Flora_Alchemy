import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Heart, ArrowRight } from 'lucide-react';
import { getCart, updateCart, addToCart as apiAddToCart, removeFromCart as apiRemoveFromCart } from '../services/api.js';
import { getProducts } from '../services/productService.js';
import { getActiveCustomerId } from '../services/customerService.js';
import { getWishlist as apiGetWishlist, addToWishlist as apiAddWishlist, removeFromWishlist as apiRemoveWishlist } from '../services/wishlistService.js';
import { subscribeStore } from '../services/dataStore.js';

const StoreContext = createContext(null);

export function StoreProvider({ children }) {
  const [cart, setCart] = useState([]);
  const [wishlist, setWishlist] = useState([]);
  const [wishlistUnavailable, setWishlistUnavailable] = useState([]);
  const [wishlistGateOpen, setWishlistGateOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const authIdRef = useRef(null);

  // Resolve wishlist ids against the API catalogue; ids whose product no
  // longer exists (deleted/hidden) are surfaced separately so the customer
  // can remove them instead of silently losing them.
  function resolveWishlist(ids) {
    const catalog = getProducts();
    const rows = [];
    const unavailable = [];
    (ids || []).forEach((id) => {
      const p = catalog.find((prod) => prod.id === id);
      if (p) rows.push(p);
      else unavailable.push(id);
    });
    return { rows, unavailable };
  }

  async function loadWishlist() {
    const customerId = getActiveCustomerId();
    if (!customerId) {
      setWishlist([]);
      setWishlistUnavailable([]);
      return;
    }
    try {
      const data = await apiGetWishlist();
      const { rows, unavailable } = resolveWishlist(data.productIds);
      setWishlist(rows);
      setWishlistUnavailable([...new Set([...unavailable, ...data.unavailableIds])]);
    } catch {
      // Session expiry is handled centrally (401 → login). Keep current UI.
    }
  }

  useEffect(() => {
    let mounted = true;

    async function loadData() {
      const c = await getCart();
      if (mounted) setCart(c);
    }

    loadData();
    authIdRef.current = getActiveCustomerId();
    loadWishlist();

    // Reload the wishlist whenever the authenticated customer changes
    // (login, register, logout — dataStore commits on those signals), and
    // re-price catalogue bag lines whenever the catalogue changes so the
    // UI never disagrees with the server-priced order total.
    const unsub = subscribeStore(() => {
      const id = getActiveCustomerId();
      if (id !== authIdRef.current) {
        authIdRef.current = id;
        loadWishlist();
      }
      reconcileCartPrices();
    });

    return () => {
      mounted = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 3200);
  };

  // Phase 20.2 — live stock for a catalogue item. Stock is embedded on the
  // catalogue products (API attachAvailability), so the storefront can refuse
  // or clamp quantities for immediate feedback. null = no client-side signal
  // (made-to-order, add-ons, custom gifts) → the server validates at order time.
  function stockOf(productId) {
    if (!productId) return null;
    const p = getProducts().find((x) => x.id === productId || x.slug === productId);
    if (!p || p.stockTracked === false) return null;
    return typeof p.stock === 'number' ? p.stock : null;
  }

  const addItemToCart = async (product, options = {}) => {
    let opts = options;
    let adjustedTo = null;
    if (!options.isAddOn) {
      const stock = stockOf(product.id || product.slug);
      if (stock !== null) {
        const label = product.name || product.shortName;
        if (stock <= 0) {
          showToast(`"${label}" is out of stock`, 'error');
          return;
        }
        const requested = opts.quantity || 1;
        const existing = cart.find(
          (it) =>
            !it.isAddOn &&
            it.id === product.id &&
            it.palette === opts.palette &&
            it.ribbon === opts.ribbon
        );
        const already = existing ? existing.quantity || 1 : 0;
        const allowed = stock - already;
        if (allowed <= 0) {
          showToast(`Only ${stock} left of "${label}" — the maximum is already in your bag`, 'error');
          return;
        }
        if (requested > allowed) {
          opts = { ...opts, quantity: allowed };
          adjustedTo = allowed;
        }
      }
    }
    const updated = await apiAddToCart(product, opts);
    setCart(updated);
    showToast(
      adjustedTo
        ? `Added — only ${adjustedTo} more available, quantity adjusted`
        : `Added "${product.name || product.shortName}" to your bag`
    );
  };

  const removeItemFromCart = async (index) => {
    const updated = await apiRemoveFromCart(index);
    setCart(updated);
    showToast('Item removed from your bag');
  };

  const updateItemQuantity = async (index, newQuantity) => {
    if (newQuantity < 1) {
      return removeItemFromCart(index);
    }
    const item = cart[index];
    // Phase 20.2 — clamp against live stock so an impossible quantity can
    // never be persisted (e.g. admin reduced stock while this bag was open).
    if (item && !item.isAddOn && !item.customGiftConfig) {
      const stock = stockOf(item.productSlug || item.id);
      if (stock !== null) {
        if (stock <= 0) {
          showToast(`"${item.name}" is out of stock — remove it to continue`, 'error');
          return;
        }
        if (newQuantity > stock) {
          showToast(`Only ${stock} of "${item.name}" available — quantity adjusted`, 'error');
          newQuantity = stock;
        }
      }
    }
    const updated = [...cart];
    updated[index].quantity = newQuantity;
    await updateCart(updated);
    setCart(updated);
  };

  // Phase 20.3 — the bag stores a price snapshot at add-time, but the server
  // re-prices catalogue lines from live product data when the order is
  // created. If an admin changes a price while items sit in the bag, the
  // checkout UI would show one total while the server charges another.
  // Reconcile catalogue lines (never add-ons or bespoke custom gifts, which
  // legitimately carry their own price) against the current catalogue.
  const repriceRef = useRef(false);
  // The dataStore subscription is registered once, so its closure would see a
  // stale cart — read through a ref to always reconcile the latest bag.
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const reconcileCartPrices = async () => {
    if (repriceRef.current) return; // avoid overlapping runs
    const catalog = getProducts();
    const currentCart = cartRef.current;
    if (!catalog.length || currentCart.length === 0) return;
    repriceRef.current = true;
    try {
      let changed = false;
      const next = currentCart.map((item) => {
        if (item.isAddOn || item.customGiftConfig || !item.productSlug) return item;
        const p = catalog.find((x) => x.slug === item.productSlug || x.id === item.id);
        if (!p || typeof p.price !== 'number' || p.price === item.price) return item;
        changed = true;
        return { ...item, price: p.price };
      });
      if (changed) {
        const updated = await updateCart(next);
        setCart(updated);
      }
    } finally {
      repriceRef.current = false;
    }
  };

  // Also reconcile once on mount after the cart and catalogue have loaded.
  useEffect(() => {
    if (cart.length === 0) return;
    reconcileCartPrices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.length]);

  // Persisted empty cart (used after a successful order) so a later reload
  // never resurrects the purchased items.
  const clearCart = async () => {
    await updateCart([]);
    setCart([]);
  };

  const toggleWishlist = async (product) => {
    // Guests have no persistent wishlist — offer sign-in instead of a fake
    // local account.
    if (!getActiveCustomerId()) {
      setWishlistGateOpen(true);
      return;
    }

    const isSaved = wishlist.some((item) => item.id === product.id);
    try {
      const data = isSaved
        ? await apiRemoveWishlist(product.id)
        : await apiAddWishlist(product.id);
      const { rows, unavailable } = resolveWishlist(data.productIds);
      setWishlist(rows);
      setWishlistUnavailable(unavailable);
      showToast(
        isSaved
          ? `Removed "${product.name}" from your wishlist`
          : `Saved "${product.name}" to your wishlist`
      );
    } catch (err) {
      showToast(err.message || 'Wishlist update failed. Please try again.', 'error');
    }
  };

  const removeUnavailableFromWishlist = async (productId) => {
    if (!getActiveCustomerId()) return;
    try {
      const data = await apiRemoveWishlist(productId);
      const { rows, unavailable } = resolveWishlist(data.productIds);
      setWishlist(rows);
      setWishlistUnavailable(unavailable);
    } catch {
      /* keep current UI */
    }
  };

  const isWishlisted = (productId) => {
    return wishlist.some((item) => item.id === productId);
  };

  const cartCount = cart.reduce((sum, item) => sum + (item.quantity || 1), 0);
  const cartSubtotal = cart.reduce((sum, item) => sum + (item.price * (item.quantity || 1)), 0);

  return (
    <StoreContext.Provider value={{
      cart,
      wishlist,
      wishlistUnavailable,
      cartCount,
      cartSubtotal,
      addItemToCart,
      removeItemFromCart,
      updateItemQuantity,
      clearCart,
      toggleWishlist,
      isWishlisted,
      removeUnavailableFromWishlist,
      showToast,
      setCart
    }}>
      {children}

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 inset-x-4 sm:inset-x-auto sm:right-6 sm:max-w-md mx-auto z-50 flex items-center gap-2.5 bg-[var(--color-btn)] text-white px-5 py-3 rounded-full shadow-2xl border border-white/10 animate-fade-in duration-300 pointer-events-none">
          <span className="w-2 h-2 rounded-full bg-[#964735] shrink-0"></span>
          <span className="text-[13px] font-medium tracking-wide truncate">{toast.message}</span>
        </div>
      )}

      {/* Guest wishlist gate — no fake local account */}
      {wishlistGateOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Sign in to save your wishlist"
          onClick={() => setWishlistGateOpen(false)}
        >
          <div
            className="bg-[var(--color-surface-lowest)] rounded-3xl p-6 sm:p-10 max-w-md w-full text-center space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] flex items-center justify-center mx-auto">
              <Heart className="w-6 h-6 text-[var(--color-accent)]" />
            </div>
            <h2 className="font-serif text-[24px] sm:text-[26px] text-[var(--color-botanical-primary)] leading-snug">
              Sign in to save your favorite creations.
            </h2>
            <p className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)]">
              Your wishlist lives with your account, so your saved blooms follow you
              across devices. Browsing and adding to your bag never require an account.
            </p>
            <div className="pt-3 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link
                to="/login?redirect=/wishlist"
                onClick={() => setWishlistGateOpen(false)}
                className="w-full sm:w-auto px-7 py-3 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold flex items-center justify-center gap-2 transition-colors touch-target"
              >
                Sign In
                <ArrowRight className="w-4 h-4" />
              </Link>
              <button
                type="button"
                onClick={() => setWishlistGateOpen(false)}
                className="w-full sm:w-auto px-7 py-3 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] text-[13px] font-semibold transition-colors touch-target"
              >
                Continue Shopping
              </button>
            </div>
          </div>
        </div>
      )}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const context = useContext(StoreContext);
  if (!context) {
    throw new Error('useStore must be used within a StoreProvider');
  }
  return context;
}