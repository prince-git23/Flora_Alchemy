import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Plus, Leaf, Check } from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';
import { isOutOfStock } from '../services/productService.js';
import ShopAttribution from './ShopAttribution.jsx';
import { setupCardDepth } from '../lib/gsapSetup.js';

/**
 * Storefront product card — one identity, responsive.
 *
 * The SAME component renders on the shop grid, search, the home page and a
 * product's related rail; it only adapts its spacing at breakpoints. The
 * hierarchy is fixed and deliberate:
 *
 *   1. Product photography   (the hero — largest element)
 *   2. Product name
 *   3. Rating                (only when real data exists — never invented)
 *   4. Handcrafted / availability signal
 *   5. Price
 *   6. Add to Bag
 *
 * Removed deliberately: palette line, duplicate availability badges, a
 * "Price" caption, a divider, the personalization pill and the hover
 * "View details" overlay. The image and the name already link to the product,
 * so the overlay only added noise. Depth stays as progressive enhancement on
 * fine-pointer devices only.
 *
 * PHASE 2 — three variants, one component:
 *
 *   · `standard`      — the editorial card (Home, related rails)
 *   · `compact`       — the dense CATALOGUE card (/shop, /search). Identical
 *                       structure and data; it only drops chrome the catalogue
 *                       UI already supplies (the category eyebrow is the
 *                       active filter, the in-stock "Handcrafted" line carries
 *                       no state), so a phone shows more products per screen
 *                       without shrinking the photograph. Made-to-order stays
 *                       visible because it is a real expectation to set; an
 *                       out-of-stock item is already stated by the image
 *                       overlay, so it is not repeated as text.
 *   · `shop-context`  — a shop's own catalogue: no wishlist / bag action
 *
 * There is no ProductCardV2 and no per-surface card. A new variant is a small
 * flag added HERE.
 */
export default function ProductCard({ product, variant = 'standard' }) {
  // Shop-context cards are a shop's OWN catalogue: identity, price and real
  // availability, with no wishlist or bag action. Same card, fewer controls.
  // The bag action is deliberately withheld here: adding to cart from this
  // surface would not carry fulfillmentShopSlug, which the multi-shop
  // fulfillment flow depends on.
  const isShopContext = variant === 'shop-context';
  const isCompact = variant === 'compact';
  const { toggleWishlist, isWishlisted, addItemToCart } = useStore();
  const wishlisted = isWishlisted(product.id);

  const madeToOrder = product.stockTracked === false;
  // Availability comes from authoritative backend data only. The main catalogue
  // publishes `stock`; the shop-scoped projection publishes `inStock`.
  const outOfStock = !madeToOrder && (product.inStock === false || isOutOfStock(product));

  const [imgError, setImgError] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const [wishAnim, setWishAnim] = useState(false);
  const cardRef = useRef(null);
  const imgSrc = (product.images && product.images[0]) || product.image || '';
  const productId = product.id || product.slug;

  const handleAddToCart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (outOfStock) return;
    addItemToCart(product);
    setJustAdded(true);
    setTimeout(() => setJustAdded(false), 700);
  }, [product, addItemToCart, outOfStock]);

  const handleToggleWishlist = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleWishlist(product);
    setWishAnim(true);
    setTimeout(() => setWishAnim(false), 400);
  }, [product, toggleWishlist]);

  // Depth is progressive enhancement, owned by the shared motion module:
  // fine pointers only, at most 1.5deg of tilt, disabled under
  // prefers-reduced-motion, and torn down on unmount.
  useEffect(() => setupCardDepth(cardRef.current), []);
  const canHover =
    typeof window !== 'undefined' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  const availabilityLabel = madeToOrder ? 'Made to order' : 'Handcrafted';
  // Compact shows the availability line only when it carries real state
  // (made to order). Out-of-stock is already stated by the image overlay.
  const showAvailability = !isCompact || madeToOrder;

  return (
    <article
      ref={cardRef}
      className={`group relative flex flex-col bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border-light)] hover:border-[var(--color-botanical-border)] shadow-[0_2px_12px_-4px_rgba(46,36,30,0.06)] hover:shadow-[0_16px_36px_-10px_rgba(46,36,30,0.16)] transition-[box-shadow,border-color,transform] duration-400 ${isCompact ? 'p-2 sm:p-2.5' : 'p-2.5 sm:p-3'}`}
      style={canHover ? { transformStyle: 'preserve-3d' } : undefined}
    >
      {/* 1 — product photography */}
      <div className="relative aspect-square w-full rounded-xl overflow-hidden bg-[var(--color-surface-low)]">
        <Link to={`/product/${productId}`} className="block w-full h-full" tabIndex={-1} aria-hidden="true">
          {!imgError && imgSrc ? (
            <img
              src={imgSrc}
              alt={product.name}
              className="w-full h-full object-cover fa-img-reveal"
              loading="lazy"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-[var(--color-botanical-subtle)]">
              <span className="text-2xl mb-1" aria-hidden="true">🌸</span>
              <span className="text-[10px] font-medium">Image unavailable</span>
            </div>
          )}
        </Link>

        {outOfStock && (
          <div className="absolute inset-0 bg-[var(--color-surface-bg)]/55 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
            <span className="px-3 py-1 rounded-full bg-[var(--color-botanical-primary)] text-[var(--color-surface-bg)] text-[10px] font-bold uppercase tracking-wider">
              Sold out
            </span>
          </div>
        )}
        {!isShopContext && (
          <button
          onClick={handleToggleWishlist}
          type="button"
          className={`absolute top-2 right-2 w-11 h-11 sm:w-9 sm:h-9 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-sm flex items-center justify-center text-[var(--color-botanical-muted)] hover:text-[var(--color-accent)] shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${wishAnim ? 'fa-wishlist-pop' : ''}`}
          title={wishlisted ? 'Remove from Saved Gifts' : 'Save to Saved Gifts'}
          aria-label={wishlisted ? `Remove ${product.name} from Saved Gifts` : `Save ${product.name} to Saved Gifts`}
        >
          <Heart className={`w-4 h-4 transition-colors ${wishlisted ? 'fill-[var(--color-accent)] text-[var(--color-accent)]' : ''}`} aria-hidden="true" />
        </button>
        )}
      </div>

      {/* 2–5 — name, availability, price */}
      <div className={`flex flex-1 flex-col px-0.5 ${isCompact ? 'pt-2' : 'pt-2.5'}`}>
        {!isCompact && (
          <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)] truncate">
            {product.categoryLabel || product.category}
          </span>
        )}

        <Link to={`/product/${productId}`} className={`${isCompact ? 'mt-0.5' : 'mt-1'} flex min-h-[44px] items-start`}>
          <h3 className="font-serif text-[15px] sm:text-[17px] text-[var(--color-botanical-primary)] leading-snug font-medium line-clamp-2 hover:text-[var(--color-accent)] transition-colors">
            {product.name}
          </h3>
        </Link>

        {showAvailability && (
          <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--color-botanical-sage)]">
            <Leaf className="w-3 h-3" aria-hidden="true" />
            {outOfStock ? 'Currently unavailable' : availabilityLabel}
          </span>
        )}

        {/* PHASE 1 — real shop attribution; renders nothing when the backend
            could not resolve an ACTIVE shop (never an invented maker name). */}
        {product.shop && (
          <ShopAttribution shop={product.shop} className="mt-1.5 max-w-full" />
        )}

        {/* `mt-auto` bottom-aligns the price row, so every card in a grid row
            shares one price baseline regardless of attribution length. */}
        <div className="mt-auto pt-2 flex items-center justify-between gap-2">
          <span className="text-[15px] sm:text-[16px] font-bold text-[var(--color-botanical-primary)]">
            ₹{Number(product.price || 0).toLocaleString('en-IN')}
          </span>
          {!isShopContext && (
            <button
            onClick={handleAddToCart}
            type="button"
            disabled={outOfStock}
            className={`inline-flex items-center justify-center gap-1 min-h-[44px] px-3 rounded-full bg-[var(--color-btn)] text-white hover:bg-[var(--color-btn-hover)] transition-colors text-[11px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--color-btn)] ${justAdded ? 'fa-atc-success' : ''}`}
            aria-label={outOfStock ? `${product.name} is out of stock` : `Add ${product.name} to bag`}
          >
            {justAdded ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Plus className="w-3.5 h-3.5" aria-hidden="true" />}
            <span>{justAdded ? 'Added' : 'Add'}</span>
          </button>
          )}
        </div>
      </div>
    </article>
  );
}
