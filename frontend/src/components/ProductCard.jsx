import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Heart, ShoppingBag, Star, Eye, Sparkles, Leaf } from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';
import { deriveGiftAttributes } from '../services/giftFinderService.js';

/**
 * Storefront product card — spatial depth variant.
 *
 * Adds subtle perspective, hover elevation, and controlled image motion
 * while preserving all existing functionality (wishlist, add to bag, links).
 *
 * Depth hierarchy:
 *  LEVEL 0 — card surface
 *  LEVEL 1 — image / content
 *  LEVEL 2 — badges, wishlist button, quick view overlay
 *  LEVEL 3 — hover elevation state
 */
export default function ProductCard({ product }) {
  const { toggleWishlist, isWishlisted, addItemToCart } = useStore();
  const wishlisted = isWishlisted(product.id);

  const madeToOrder = product.stockTracked === false;
  const attributes = deriveGiftAttributes(product);
  const personalizable = attributes.personalization !== 'simple';

  const [imgError, setImgError] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const [wishAnim, setWishAnim] = useState(false);
  const cardRef = useRef(null);
  const imgSrc = product.images ? product.images[0] : (product.image || '');

  const handleAddToCart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    addItemToCart(product);
    setJustAdded(true);
    setTimeout(() => setJustAdded(false), 600);
  }, [product, addItemToCart]);

  const handleToggleWishlist = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleWishlist(product);
    setWishAnim(true);
    setTimeout(() => setWishAnim(false), 400);
  }, [product, toggleWishlist]);

  // Track whether the device supports hover + fine pointer (desktop)
  const [canHover, setCanHover] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    setCanHover(mq.matches);
    const onChange = (e) => setCanHover(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Cache rect to avoid layout thrashing on every mousemove
  const rectRef = useRef(null);
  const handleMouseMove = useCallback((e) => {
    if (!cardRef.current || !canHover) return;
    if (!rectRef.current) rectRef.current = cardRef.current.getBoundingClientRect();
    const { left, top, width, height } = rectRef.current;
    const x = (e.clientX - left) / width - 0.5;
    const y = (e.clientY - top) / height - 0.5;
    cardRef.current.style.transform = `perspective(800px) rotateY(${x * 3}deg) rotateX(${-y * 3}deg) translateY(-4px)`;
  }, [canHover]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    rectRef.current = null;
    if (cardRef.current) {
      cardRef.current.style.transform = '';
    }
  }, []);

  return (
    <article
      ref={cardRef}
      onMouseEnter={() => setIsHovered(true)}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="group relative flex flex-col bg-[var(--color-surface-lowest)] rounded-3xl p-3 sm:p-4 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] hover:shadow-[0_16px_40px_-6px_rgba(46,36,30,0.12)] transition-shadow duration-500 border border-[#f0ede9] hover:border-[var(--color-botanical-border)]"
      style={canHover ? { transformStyle: 'preserve-3d' } : undefined}
    >
      {/* Thumbnail container */}
      <div className="relative aspect-square w-full rounded-2xl overflow-hidden bg-[var(--color-surface-low)] mb-3">
        <Link to={`/product/${product.id}`} className="block w-full h-full" tabIndex={-1}>
          {!imgError && imgSrc ? (
            <img
              src={imgSrc}
              alt={product.name}
              className="w-full h-full object-cover fa-img-reveal"
              loading="lazy"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-[#b0a89f]">
              <span className="text-3xl mb-1" aria-hidden="true">🌸</span>
              <span className="text-[10px] font-medium">Image unavailable</span>
            </div>
          )}
        </Link>

        {/* Badges */}
        {(product.badge || madeToOrder) && (
          <div className="absolute top-3 left-3 flex flex-col gap-1 pointer-events-none">
            {product.badge && (
              <span className="px-2.5 py-0.5 rounded-full bg-[#964735] text-white text-[10px] font-bold uppercase tracking-wider shadow-sm">
                {product.badge}
              </span>
            )}
            {madeToOrder && (
              <span className="px-2.5 py-0.5 rounded-full bg-[#180f0a] text-white text-[10px] font-bold uppercase tracking-wider shadow-sm">
                Made to order
              </span>
            )}
          </div>
        )}

        {/* Wishlist button — elevated to LEVEL 2 */}
        <button
          onClick={handleToggleWishlist}
          className={`absolute top-2.5 right-2.5 w-9 h-9 sm:w-8 sm:h-8 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-sm flex items-center justify-center text-[var(--color-botanical-muted)] hover:text-[#964735] shadow-sm hover:shadow-md transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a] touch-target ${wishAnim ? 'fa-wishlist-pop' : ''}`}
          title={wishlisted ? 'Remove from Saved Gifts' : 'Save to Saved Gifts'}
          aria-label={wishlisted ? 'Remove from Saved Gifts' : 'Save to Saved Gifts'}
          type="button"
        >
          <Heart className={`w-4 h-4 transition-all duration-200 ${wishlisted ? 'fill-[#964735] text-[#964735] scale-110' : ''}`} aria-hidden="true" />
        </button>

        {/* Quick View Link — fades in on hover (desktop) / always visible (mobile) */}
        <div className="absolute inset-x-3 bottom-3 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-all duration-300 transform md:translate-y-2 md:group-hover:translate-y-0">
          <Link
            to={`/product/${product.id}`}
            className="w-full py-2 rounded-xl bg-[var(--color-surface-lowest)]/95 text-[var(--color-botanical-primary)] text-[12px] font-semibold tracking-wide shadow-md hover:bg-[#180f0a] hover:text-white transition-colors flex items-center justify-center gap-1.5"
          >
            <Eye className="w-3.5 h-3.5" aria-hidden="true" />
            <span>View Details</span>
          </Link>
        </div>
      </div>

      {/* Info Content */}          <div className="flex-1 flex flex-col justify-between px-1 min-w-0">
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)] truncate">
              {product.categoryLabel || product.category}
            </span>
            {product.rating > 0 && (
              <div className="flex items-center gap-1 text-[#964735] text-[12px] font-semibold">
                <Star className="w-3 h-3 fill-[#964735] text-[#964735]" aria-hidden="true" />
                <span>{product.rating}</span>
              </div>
            )}
          </div>

          <Link to={`/product/${product.id}`}>
            <h3 className="font-serif text-[16px] sm:text-[18px] text-[var(--color-botanical-primary)] leading-snug font-medium hover:text-[#964735] transition-colors line-clamp-2">
              {product.name}
            </h3>
          </Link>

          {product.palette && (
            <p className="text-[11px] sm:text-[12px] text-[var(--color-botanical-muted)] line-clamp-1 break-words">{product.palette}</p>
          )}

          {/* Real, data-backed indicators only */}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#5b6d54]">
              <Leaf className="w-3 h-3" aria-hidden="true" />
              {madeToOrder ? 'Made to order' : 'Handcrafted'}
            </span>
            {personalizable && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#ffdad3]/60 text-[#783020] text-[10px] font-bold uppercase tracking-wider">
                <Sparkles className="w-2.5 h-2.5" aria-hidden="true" />
                Personalizable
              </span>
            )}
          </div>
        </div>

        {/* Price and Cart Button */}
        <div className="pt-3 sm:pt-4 mt-2 flex items-center justify-between border-t border-[#f0ede9]">
          <div className="flex flex-col">
            <span className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Price</span>
            <span className="text-[15px] sm:text-[17px] font-bold text-[var(--color-botanical-primary)]">
              ₹{product.price.toLocaleString('en-IN')}
            </span>
          </div>

          <button
            onClick={handleAddToCart}
            type="button"
            className={`px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] transition-all duration-200 text-[11px] sm:text-[12px] font-semibold flex items-center gap-1.5 shadow-sm hover:shadow-md active:translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#964735] focus-visible:ring-offset-1 touch-target ${justAdded ? 'fa-atc-success' : ''}`}
            aria-label={`Add ${product.name} to bag`}
          >
            <ShoppingBag className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{justAdded ? 'Added!' : 'Add to Bag'}</span>
          </button>
        </div>
      </div>
    </article>
  );
}
