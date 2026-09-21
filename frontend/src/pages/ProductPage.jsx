import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, Minus, Plus, Heart, ShoppingBag, Zap,
  Truck, Sparkles, Leaf, Check, Gift,
} from 'lucide-react';
import { getProductById, getProducts as getCatalogProducts } from '../services/productService.js';
import { getSettings } from '../services/settingsService.js';
import { deriveGiftAttributes } from '../services/giftFinderService.js';
import { useStore } from '../context/StoreContext.jsx';
import { useStoreVersion } from '../hooks/useStoreVersion.js';
import ProductCard from '../components/ProductCard.jsx';
import { Skeleton, SkeletonText } from '../components/Skeleton.jsx';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const QUANTITY_MAX = 10;

const CATEGORY_INCLUSION = {
  bouquets: 'Sculpted everlasting blooms',
  cards: 'Handmade botanical cards',
  charms: 'Handcrafted keepsake piece',
  hampers: 'Curated keepsake gift box',
  custom: 'Bespoke made-to-order creation',
  other: 'Handcrafted studio piece',
};

const HOW_IT_ARRIVES = [
  { step: 'Prepared', detail: 'Handcrafted to order in our studio.' },
  { step: 'Wrapped', detail: 'Tied with ribbon and finished with a wax seal.' },
  { step: 'Packed', detail: 'Nested in a rigid presentation box.' },
  { step: 'Delivered', detail: 'Pan-India dispatch to your door.' },
];

export default function ProductPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { addItemToCart, toggleWishlist, isWishlisted } = useStore();

  // Phase 18.5.3 — subscribe to store version so the product lookup re-runs
  // after a background refresh. Without this, a stale-while-revalidate cycle
  // could leave the component showing "Not Found" for a product that still
  // exists in the freshly-hydrated catalogue.
  const storeVersion = useStoreVersion();

  const [product, setProduct] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [selectedPalette, setSelectedPalette] = useState(null);
  const [selectedRibbon, setSelectedRibbon] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [giftMessage, setGiftMessage] = useState('');
  const [justAdded, setJustAdded] = useState(false);
  const [activeTab, setActiveTab] = useState('craft');
  const [galleryImgError, setGalleryImgError] = useState(false);
  const [wishAnim, setWishAnim] = useState(false);

  const settings = useMemo(() => getSettings(), []);

  // GSAP refs
  const heroRef = useRef(null);
  const relatedRef = useRef(null);

  // Phase 18.5.3 — re-run the lookup whenever the route param OR the store
  // version changes (background refresh, mutation sync). Only set notFound
  // when the store has actually been hydrated (has at least tried to load
  // products) and the product is genuinely absent.
  useEffect(() => {
    const allProducts = getCatalogProducts();
    const found = getProductById(id);
    if (found) {
      setProduct(found);
      setNotFound(false);
      setGalleryIndex(0);
      setSelectedPalette(found.palettes && found.palettes.length > 0 ? found.palettes[0].name : null);
      setSelectedRibbon(found.ribbons && found.ribbons.length > 0 ? found.ribbons[0].name : null);
      setQuantity(1);
      setGiftMessage('');
      setJustAdded(false);
      setGalleryImgError(false);
    } else if (allProducts.length > 0) {
      // Store has been hydrated with real data and the product is absent —
      // this is a confirmed not-found (e.g. retired product).
      setProduct(null);
      setNotFound(true);
    }
    // else: store hasn't hydrated yet or is empty during a transient refresh
    // cycle — keep the existing state (product or loading skeleton) and let
    // the next storeVersion tick re-check.
    if (found) window.scrollTo(0, 0);
  }, [id, storeVersion]);

  // Hero entrance animation
  useEffect(() => {
    if (!product || !heroRef.current) return;
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return;

    const ctx = gsap.context(() => {
      const gallery = heroRef.current.querySelector('[data-gallery]');
      const info = heroRef.current.querySelector('[data-product-info]');

      if (gallery) {
        gsap.fromTo(gallery,
          { opacity: 0, x: -20 },
          { opacity: 1, x: 0, duration: 0.6, ease: 'power3.out', delay: 0.1 }
        );
      }
      if (info) {
        const children = info.children;
        gsap.fromTo(children,
          { opacity: 0, y: 16 },
          { opacity: 1, y: 0, duration: 0.5, stagger: 0.06, ease: 'power3.out', delay: 0.2 }
        );
      }
    });

    return () => ctx.revert();
  }, [product]);

  // GSAP animations for related products
  useEffect(() => {
    if (!relatedRef.current || !product) return;
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return;

    const cards = relatedRef.current.querySelectorAll('article');
    if (cards.length === 0) return;

    const ctx = gsap.context(() => {
      gsap.fromTo(cards,
        { opacity: 0, y: 25, scale: 0.97 },
        {
          opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.06, ease: 'power2.out',
          scrollTrigger: { trigger: relatedRef.current, start: 'top 85%', once: true },
        }
      );
    });

    return () => ctx.revert();
  }, [product]);

  const relatedProducts = useMemo(() => {
    if (!product) return [];
    const all = getCatalogProducts().filter((p) => p.id !== product.id && p.visibility !== 'Hidden');
    const sameCategory = all.filter((p) => p.category === product.category);
    const band = Math.max(500, Math.round(product.price * 0.35));
    const similarPrice = all.filter(
      (p) => p.category !== product.category && Math.abs(p.price - product.price) <= band
    );
    const chosen = [...sameCategory, ...similarPrice];
    const rest = all.filter((p) => !chosen.includes(p));
    return [...chosen, ...rest].slice(0, 4);
  }, [product]);

  const purchaseOptions = () => ({
    quantity,
    palette: selectedPalette,
    ribbon: selectedRibbon,
    giftMessage: giftMessage.trim() || undefined,
  });

  // Hooks must run on every render — never after the notFound/!product early
  // returns below, or React throws "rendered more hooks than the previous
  // render" (#310) when product data arrives after the loading frame.
  const handleAddToCart = useCallback(() => {
    if (!product) return;
    addItemToCart(product, purchaseOptions());
    setJustAdded(true);
  }, [addItemToCart, product, quantity, selectedPalette, selectedRibbon, giftMessage]);

  const handleBuyNow = useCallback(() => {
    if (!product) return;
    addItemToCart(product, purchaseOptions());
    navigate('/checkout');
  }, [addItemToCart, product, quantity, selectedPalette, selectedRibbon, giftMessage, navigate]);

  const handleWishlist = useCallback(() => {
    if (!product) return;
    toggleWishlist(product);
    setWishAnim(true);
    setTimeout(() => setWishAnim(false), 400);
  }, [product, toggleWishlist]);

  if (notFound) {
    return (
      <div className="w-full min-h-[60vh] flex flex-col items-center justify-center bg-[var(--color-surface-bg)] px-4 text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-3xl" aria-hidden="true">
          🥀
        </div>
        <h1 className="font-serif text-[24px] sm:text-[26px] text-[var(--color-botanical-primary)]">This creation is no longer available</h1>
        <p className="text-[14px] text-[var(--color-botanical-muted)] max-w-md">
          It may have sold out or been retired from the catalogue. Here are some other ways to find
          something special.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Link to="/shop" className="px-6 py-2.5 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold hover:bg-[#964735] transition-colors">
            Browse Gifts
          </Link>
          <Link to="/" className="px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors">
            Back Home
          </Link>
          <Link to="/gift-finder" className="px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors">
            Find a Gift
          </Link>
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="w-full min-h-[60vh] bg-[var(--color-surface-bg)] px-4 sm:px-6 lg:px-10 py-8">
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12">
          {/* Gallery skeleton */}
          <Skeleton className="w-full aspect-square rounded-2xl" />
          {/* Info skeleton */}
          <div className="space-y-5 py-4">
            <Skeleton className="h-3 w-24 rounded-md" />
            <Skeleton className="h-7 w-3/4 rounded-md" />
            <Skeleton className="h-5 w-32 rounded-md" />
            <SkeletonText lines={4} />
            <div className="flex gap-3 pt-2">
              <Skeleton className="h-12 w-40 rounded-full" />
              <Skeleton className="h-12 w-12 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  const wishlisted = isWishlisted(product.id);
  const images = product.images && product.images.length ? product.images : [product.image].filter(Boolean);
  const hasGallery = images.length > 1;
  const madeToOrder = product.stockTracked === false;
  const attributes = deriveGiftAttributes(product);
  const personalizable = attributes.personalization !== 'simple';
  const lineTotal = product.price * quantity;

  const stepGallery = (delta) => {
    if (!hasGallery) return;
    setGalleryImgError(false);
    setGalleryIndex((i) => (i + delta + images.length) % images.length);
  };

  const inclusionItems = [
    { label: CATEGORY_INCLUSION[product.category] || CATEGORY_INCLUSION.other, source: 'category' },
    ...(product.palette ? [{ label: `Botanical colorway: ${product.palette}`, source: 'palette' }] : []),
    ...(selectedRibbon ? [{ label: `Ribbon: ${selectedRibbon}`, source: 'ribbon' }] : []),
    ...(giftMessage.trim() ? [{ label: 'Handwritten gift note enclosed', source: 'note' }] : []),
  ];

  const tabs = [
    { key: 'craft', label: 'Craft & Materials' },
    { key: 'delivery', label: 'Packaging & Delivery' },
  ];

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen py-6 lg:py-12 pb-28 lg:pb-12">
      <div ref={heroRef} className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-[12px] text-[var(--color-botanical-subtle)] mb-6 lg:mb-8 font-medium" aria-label="Breadcrumb">
          <Link to="/" className="hover:text-[var(--color-botanical-primary)] transition-colors">Home</Link>
          <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
          <Link to="/shop" className="hover:text-[var(--color-botanical-primary)] transition-colors">Shop</Link>
          <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="text-[var(--color-botanical-primary)] truncate">{product.name}</span>
        </nav>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 items-start">
          {/* ── Gallery (left) — spatial depth ── */}
          <div data-gallery className="lg:col-span-6 space-y-4" style={{ perspective: '1000px' }}>
            <div
              className="relative aspect-square w-full rounded-3xl overflow-hidden bg-[var(--color-surface-lowest)] shadow-[0_8px_30px_-4px_rgba(46,36,30,0.08)] border border-[var(--color-botanical-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a]"
              tabIndex={hasGallery ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') { e.preventDefault(); stepGallery(-1); }
                if (e.key === 'ArrowRight') { e.preventDefault(); stepGallery(1); }
              }}
              role={hasGallery ? 'group' : undefined}
              aria-label={hasGallery ? `Product image ${galleryIndex + 1} of ${images.length}` : undefined}
            >
              {!galleryImgError ? (
                <img
                  key={galleryIndex}
                  src={images[galleryIndex]}
                  alt={product.name}
                  className="w-full h-full object-cover fa-gallery-crossfade"
                  loading="lazy"
                  onError={() => setGalleryImgError(true)}
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-[#b0a89f] bg-[var(--color-surface-low)]">
                  <span className="text-4xl mb-2" aria-hidden="true">🌸</span>
                  <span className="text-[13px] font-medium">Image unavailable</span>
                </div>
              )}
              {product.badge && (
                <div className="absolute top-4 left-4">
                  <span className="px-3 py-1 rounded-full bg-[#964735] text-white text-[11px] font-bold uppercase tracking-wider shadow-sm">
                    {product.badge}
                  </span>
                </div>
              )}

              {hasGallery && (
                <>
                  <button
                    type="button"
                    onClick={() => stepGallery(-1)}
                    aria-label="Previous image"
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-sm shadow-md flex items-center justify-center text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-lowest)] transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a]"
                  >
                    <ChevronLeft className="w-5 h-5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => stepGallery(1)}
                    aria-label="Next image"
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-sm shadow-md flex items-center justify-center text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-lowest)] transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a]"
                  >
                    <ChevronRight className="w-5 h-5" aria-hidden="true" />
                  </button>
                  <span className="absolute bottom-4 right-4 px-2.5 py-1 rounded-full bg-[#180f0a]/80 text-white text-[11px] font-semibold">
                    {galleryIndex + 1} / {images.length}
                  </span>
                </>
              )}
            </div>

            {/* Thumbnails */}
            {hasGallery && (
              <div className="flex items-center gap-2.5 sm:gap-3 overflow-x-auto pb-2 scrollbar-none">
                {images.map((imgUrl, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => { setGalleryImgError(false); setGalleryIndex(idx); }}
                    aria-label={`Show image ${idx + 1}`}
                    aria-current={galleryIndex === idx}
                    className={`relative w-16 h-16 sm:w-20 sm:h-20 rounded-2xl overflow-hidden bg-[var(--color-surface-lowest)] border-2 transition-all duration-200 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a] ${
                      galleryIndex === idx ? 'border-[#964735] ring-2 ring-[#ffdad3] fa-thumb-active' : 'border-[var(--color-botanical-border)] opacity-75 hover:opacity-100'
                    }`}
                  >
                    <img
                      loading="lazy"
                      decoding="async" src={imgUrl} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}

            {/* Atelier stamp */}
            <div className="p-4 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-[#180f0a] text-white flex items-center justify-center font-serif text-[18px] shrink-0">
                FA
              </div>
              <div className="text-[13px] text-[var(--color-botanical-muted)]">
                <p className="font-semibold text-[var(--color-botanical-primary)]">Handmade in small batches</p>
                <p>{madeToOrder ? 'Crafted after you order' : 'Studio-made in limited runs'}</p>
              </div>
            </div>
          </div>

          {/* ── Purchase panel (right) — spatial depth ── */}
          <div data-product-info className="lg:col-span-6 space-y-5 sm:space-y-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] uppercase font-bold tracking-widest text-[#964735]">
                  {product.categoryLabel || 'Handcrafted Flora'}
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] text-[11px] font-semibold text-[var(--color-botanical-muted)]">
                  <Leaf className="w-3 h-3 text-[#5b6d54]" aria-hidden="true" />
                  {madeToOrder ? 'Made to order' : 'Handcrafted in small batches'}
                </span>
              </div>

              <h1 className="font-serif text-[28px] sm:text-[32px] md:text-[40px] text-[var(--color-botanical-primary)] font-normal leading-tight tracking-tight">
                {product.name}
              </h1>

              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-[24px] sm:text-[28px] font-bold text-[var(--color-botanical-primary)]">
                  ₹{product.price.toLocaleString('en-IN')}
                </span>
                <span className="text-[11px] uppercase font-bold text-[#5b6d54] bg-[#d8e7cd] px-2.5 py-0.5 rounded-full">
                  All taxes included
                </span>
              </div>

              <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed">
                {product.description
                  || `A handcrafted ${(product.categoryLabel || 'studio piece').toLowerCase()}${product.palette ? ` in ${product.palette}` : ''}, made in small batches and finished by hand.`}
              </p>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="inline-flex items-center gap-1.5 text-[11px] sm:text-[12px] font-medium text-[var(--color-botanical-muted)]">
                  <Check className="w-3.5 h-3.5 text-[#5b6d54]" aria-hidden="true" /> Handcrafted
                </span>
                {personalizable && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] sm:text-[12px] font-medium text-[var(--color-botanical-muted)]">
                    <Sparkles className="w-3.5 h-3.5 text-[#964735]" aria-hidden="true" /> Personalizable
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 text-[11px] sm:text-[12px] font-medium text-[var(--color-botanical-muted)]">
                  <Gift className="w-3.5 h-3.5 text-[#964735]" aria-hidden="true" /> Gift-ready packaging
                </span>
                {madeToOrder && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] sm:text-[12px] font-medium text-[var(--color-botanical-muted)]">
                    <Leaf className="w-3.5 h-3.5 text-[#5b6d54]" aria-hidden="true" /> Made to order
                  </span>
                )}
              </div>
            </div>

            {/* Palette */}
            {product.palettes && product.palettes.length > 0 && (
              <div className="space-y-3 pt-2 border-t border-[var(--color-botanical-border)]">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-bold uppercase tracking-wider text-[var(--color-botanical-primary)]">
                    Botanical colorway
                  </span>
                  <span className="text-[12px] text-[#964735] font-semibold">{selectedPalette}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {product.palettes.map((pal) => (
                    <button
                      key={pal.id}
                      type="button"
                      aria-pressed={selectedPalette === pal.name}
                      onClick={() => { setSelectedPalette(pal.name); setJustAdded(false); }}
                      className={`p-3 rounded-2xl flex items-center gap-3 border text-left transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a] ${
                        selectedPalette === pal.name
                          ? 'bg-[var(--color-surface-lowest)] border-[#180f0a] shadow-sm'
                          : 'bg-[var(--color-surface-low)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] hover:border-[#80756f]'
                      }`}
                    >
                      <Leaf className="w-4 h-4 text-[#5b6d54] shrink-0" aria-hidden="true" />
                      <span className="text-[12px] font-medium text-[var(--color-botanical-text)] line-clamp-1">{pal.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Ribbon */}
            {product.ribbons && product.ribbons.length > 0 && (
              <div className="space-y-3 pt-2 border-t border-[var(--color-botanical-border)]">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-bold uppercase tracking-wider text-[var(--color-botanical-primary)]">
                    Ribbon & stem tie
                  </span>
                  <span className="text-[12px] text-[#964735] font-semibold">{selectedRibbon}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {product.ribbons.map((ribbon) => (
                    <button
                      key={ribbon.id}
                      type="button"
                      aria-pressed={selectedRibbon === ribbon.name}
                      onClick={() => { setSelectedRibbon(ribbon.name); setJustAdded(false); }}
                      className={`p-3 rounded-2xl border text-left transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a] ${
                        selectedRibbon === ribbon.name
                          ? 'bg-[var(--color-surface-lowest)] border-[#180f0a] shadow-sm'
                          : 'bg-[var(--color-surface-low)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] hover:border-[#80756f]'
                      }`}
                    >
                      <span className="text-[12px] font-semibold text-[var(--color-botanical-primary)]">{ribbon.name}</span>
                      {ribbon.desc && <span className="text-[10px] text-[var(--color-botanical-subtle)] block">{ribbon.desc}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Gift note */}
            <div className="space-y-2 pt-2 border-t border-[var(--color-botanical-border)]">
              <label htmlFor="gift-note" className="block text-[12px] font-bold uppercase tracking-wider text-[var(--color-botanical-primary)]">
                Handwritten gift note (optional)
              </label>
              <textarea
                id="gift-note"
                rows={2}
                maxLength={240}
                value={giftMessage}
                onChange={(e) => { setGiftMessage(e.target.value); setJustAdded(false); }}
                placeholder="Include a personal message for the recipient…"
                className="w-full p-3 rounded-2xl bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] resize-none transition-shadow"
              />
              <p className="text-[11px] text-[var(--color-botanical-subtle)]">
                Inscribed on deckled cotton paper and enclosed with an organic wax seal.
                {' '}{giftMessage.length}/240
              </p>
            </div>

            {/* Personalization preview */}
            {(giftMessage.trim() || selectedPalette || selectedRibbon) && (
              <div className="rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] p-4 sm:p-5">
                <p className="text-[10px] uppercase font-bold tracking-widest text-[#964735] mb-2">
                  Your bespoke preview
                </p>
                <div className="rounded-xl bg-[#faf7f2] border border-[var(--color-botanical-border)] p-4 space-y-2">
                  {selectedPalette && (
                    <p className="text-[12px] text-[var(--color-botanical-muted)]"><span className="font-semibold text-[var(--color-botanical-primary)]">Colorway:</span> {selectedPalette}</p>
                  )}
                  {selectedRibbon && (
                    <p className="text-[12px] text-[var(--color-botanical-muted)]"><span className="font-semibold text-[var(--color-botanical-primary)]">Ribbon:</span> {selectedRibbon}</p>
                  )}
                  <p className="font-serif text-[15px] text-[var(--color-botanical-text)] italic leading-relaxed border-t border-[var(--color-botanical-border)] pt-2">
                    {giftMessage.trim() ? `\u201c${giftMessage.trim()}\u201d` : 'Your gift note will appear here.'}
                  </p>
                </div>
                <p className="text-[10px] text-[var(--color-botanical-subtle)] mt-2">
                  Preview of your selections only — no photo-real render is generated.
                </p>
              </div>
            )}

            {/* Quantity + primary actions */}
            <div className="pt-4 border-t border-[var(--color-botanical-border)] space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-[12px] font-bold uppercase tracking-wider text-[var(--color-botanical-primary)]">Quantity</span>
                <div className="flex items-center justify-between px-3 py-1.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] w-32">
                  <button
                    type="button"
                    onClick={() => { setQuantity((q) => Math.max(1, q - 1)); setJustAdded(false); }}
                    disabled={quantity <= 1}
                    aria-label="Decrease quantity"
                    className="text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] p-1 disabled:opacity-40 transition-colors touch-target"
                  >
                    <Minus className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <span className="text-[14px] font-bold text-[var(--color-botanical-primary)]" aria-live="polite">{quantity}</span>
                  <button
                    type="button"
                    onClick={() => { setQuantity((q) => Math.min(QUANTITY_MAX, q + 1)); setJustAdded(false); }}
                    disabled={quantity >= QUANTITY_MAX}
                    aria-label="Increase quantity"
                    className="text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] p-1 disabled:opacity-40 transition-colors touch-target"
                  >
                    <Plus className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
                <span className="text-[12px] text-[var(--color-botanical-subtle)]">Max {QUANTITY_MAX} per order</span>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <button
                  type="button"
                  onClick={handleAddToCart}
                  className={`flex-1 py-3.5 rounded-full bg-[#180f0a] hover:bg-[#964735] text-white text-[13px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-md hover:shadow-lg transition-all duration-200 active:translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#964735] focus-visible:ring-offset-2 ${justAdded ? 'fa-atc-success' : ''}`}
                >
                  <ShoppingBag className="w-4 h-4" aria-hidden="true" />
                  <span>Add to Bag · ₹{lineTotal.toLocaleString('en-IN')}</span>
                </button>

                <button
                  type="button"
                  onClick={handleWishlist}
                  aria-pressed={wishlisted}
                  aria-label={wishlisted ? 'Remove from Saved Gifts' : 'Save to Saved Gifts'}
                  title={wishlisted ? 'Remove from Saved Gifts' : 'Save to Saved Gifts'}
                  className={`p-3.5 rounded-full border transition-all duration-200 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#964735] ${
                    wishlisted
                      ? 'bg-[#ffdad3] border-[#964735] text-[#964735]'
                      : 'bg-[var(--color-surface-lowest)] border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)] hover:text-[#964735] hover:border-[#964735]'
                  } ${wishAnim ? 'fa-wishlist-pop' : ''}`}
                >
                  <Heart className={`w-5 h-5 transition-all duration-200 ${wishlisted ? 'fill-[#964735] scale-110' : ''}`} aria-hidden="true" />
                </button>
              </div>

              <button
                type="button"
                onClick={handleBuyNow}
                className="w-full py-3.5 rounded-full bg-[var(--color-surface-lowest)] border-2 border-[#180f0a] hover:bg-[var(--color-surface-low)] text-[var(--color-botanical-primary)] text-[13px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-sm hover:shadow-md transition-all duration-200 active:translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a] focus-visible:ring-offset-2"
              >
                <Zap className="w-4 h-4" aria-hidden="true" />
                <span>Buy Now · ₹{lineTotal.toLocaleString('en-IN')}</span>
              </button>

              {/* Immediate feedback after Add to Bag */}
              {justAdded && (
                <div className="rounded-2xl bg-[#d8e7cd] border border-[#c3d6b6] p-4 flex flex-wrap items-center justify-between gap-3" role="status">
                  <p className="text-[13px] font-semibold text-[#2f3d29] flex items-center gap-2">
                    <Check className="w-4 h-4" aria-hidden="true" />
                    Added to your bag
                  </p>
                  <div className="flex items-center gap-2">
                    <Link
                      to="/cart"
                      className="px-4 py-2 rounded-full bg-[#180f0a] text-white text-[12px] font-semibold hover:bg-[#964735] transition-colors"
                    >
                      View Bag
                    </Link>
                    <button
                      type="button"
                      onClick={() => setJustAdded(false)}
                      className="px-4 py-2 rounded-full bg-[var(--color-surface-lowest)] border border-[#c3d6b6] text-[#2f3d29] text-[12px] font-semibold"
                    >
                      Continue Shopping
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Delivery information */}
            <div className="rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] p-4 space-y-2">
              <p className="text-[12px] font-bold uppercase tracking-wider text-[var(--color-botanical-primary)] flex items-center gap-2">
                <Truck className="w-4 h-4 text-[#964735]" aria-hidden="true" /> Delivery
              </p>
              <ul className="space-y-1.5 text-[13px] text-[var(--color-botanical-muted)]">
                {settings && settings.shippingEnabled && (
                  <li>
                    Pan-India dispatch
                    {settings.freeShippingAbove
                      ? ` · complimentary on orders above ₹${Number(settings.freeShippingAbove).toLocaleString('en-IN')}`
                      : ''}
                  </li>
                )}
                {settings && settings.standardShippingRate !== undefined && (
                  <li>
                    Standard delivery: {settings.standardShippingRate === 0 ? 'Complimentary' : `₹${settings.standardShippingRate}`}
                    {settings.shippingConfiguration && settings.shippingConfiguration.standardDays
                      ? ` · ${settings.shippingConfiguration.standardDays}`
                      : ''}
                  </li>
                )}
                {settings && settings.expressShippingRate ? (
                  <li>
                    Express atelier dispatch: ₹{settings.expressShippingRate}
                    {settings.shippingConfiguration && settings.shippingConfiguration.expressDays
                      ? ` · ${settings.shippingConfiguration.expressDays}`
                      : ''}
                  </li>
                ) : null}
                {madeToOrder && <li>Made to order — allow extra studio time before dispatch.</li>}
              </ul>
            </div>
          </div>
        </div>

        {/* What's Included + How It Arrives */}
        <div className="mt-12 lg:mt-14 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-5 sm:p-6 lg:p-8 border border-[var(--color-botanical-border)]">
            <h2 className="font-serif text-[22px] sm:text-[24px] text-[var(--color-botanical-primary)] mb-1">What&apos;s included</h2>
            <p className="text-[13px] text-[var(--color-botanical-muted)] mb-4">Built from this product&apos;s own details.</p>
            <ul className="space-y-2.5">
              {inclusionItems.map((item) => (
                <li key={item.label} className="flex items-start gap-2.5 text-[13px] sm:text-[14px] text-[var(--color-botanical-text)]">
                  <Check className="w-4 h-4 text-[#5b6d54] mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-[var(--color-surface-low)] rounded-3xl p-5 sm:p-6 lg:p-8 border border-[var(--color-botanical-border)]">
            <h2 className="font-serif text-[22px] sm:text-[24px] text-[var(--color-botanical-primary)] mb-1">How it arrives</h2>
            <p className="text-[13px] text-[var(--color-botanical-muted)] mb-4">Our studio journey, step by step.</p>
            <ol className="space-y-3">
              {HOW_IT_ARRIVES.map((stage, idx) => (
                <li key={stage.step} className="flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-[#180f0a] text-white text-[11px] font-bold flex items-center justify-center shrink-0">
                    {idx + 1}
                  </span>
                  <span>
                    <span className="text-[13px] font-semibold text-[var(--color-botanical-primary)] block">{stage.step}</span>
                    <span className="text-[13px] text-[var(--color-botanical-muted)]">{stage.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-4">
              Studio information only — live courier tracking is not yet integrated.
              {' '}
              <Link to="/order-tracking" className="font-semibold text-[#964735] hover:underline">Track an existing order →</Link>
            </p>
          </div>
        </div>

        {/* Detail tabs */}
        <div className="mt-10 bg-[var(--color-surface-lowest)] rounded-3xl p-5 sm:p-6 lg:p-10 border border-[var(--color-botanical-border)]">
          <div className="flex items-center gap-6 border-b border-[var(--color-botanical-border)] pb-4 mb-6">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                aria-current={activeTab === tab.key}
                className={`text-[14px] font-serif transition-colors pb-1 relative focus:outline-none focus-visible:ring-2 focus-visible:ring-[#180f0a] rounded ${
                  activeTab === tab.key ? 'text-[var(--color-botanical-primary)] font-medium' : 'text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)]'
                }`}
              >
                {tab.label}
                {activeTab === tab.key && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#964735] -mb-4 rounded-full" />
                )}
              </button>
            ))}
          </div>

          {activeTab === 'craft' && (
            <div className="space-y-4 max-w-3xl text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">
              <p>
                Each stem is formed around a pliable wire armature, overlaid with dense cotton chenille
                yarns. Petals are individually twisted and arranged to echo botanical curvature while
                staying soft to the touch.
              </p>
              {product.materials && (
                <div className="p-4 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)]">
                  <h3 className="text-[12px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)] mb-1">
                    Atelier composition
                  </h3>
                  <p>{product.materials}</p>
                </div>
              )}
              <p>
                Care: dust gently with a soft brush or dry cloth. Keep away from water to protect the
                paper wrapping and natural dyes.
              </p>
            </div>
          )}

          {activeTab === 'delivery' && (
            <div className="space-y-4 max-w-3xl text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">
              <p>
                Arrives nested in a rigid presentation gift box, closed with an artisan wax seal.
              </p>
              <p>
                {settings && settings.shippingConfiguration && settings.shippingConfiguration.standardDays
                  ? `Standard Pan-India delivery arrives in ${settings.shippingConfiguration.standardDays}.`
                  : 'Dispatches from our studio within 1–2 business days, with Pan-India delivery.'}
                {madeToOrder ? ' Made-to-order pieces begin crafting after your order is placed.' : ''}
              </p>
            </div>
          )}
        </div>

        {/* Related */}
        {relatedProducts.length > 0 && (
          <div ref={relatedRef} className="mt-14 lg:mt-24 space-y-6">
            <div className="flex items-end justify-between gap-4">
              <div>
                <span className="text-[11px] uppercase font-bold tracking-widest text-[#964735]">
                  Complementary Keepsakes
                </span>
                <h2 className="font-serif text-[24px] sm:text-[28px] lg:text-[36px] text-[var(--color-botanical-primary)]">
                  You may also like
                </h2>
              </div>
              <Link to="/shop" className="text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:text-[#964735] shrink-0">
                Browse all →
              </Link>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
              {relatedProducts.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Mobile sticky purchase bar */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-[var(--color-surface-bg)]/95 backdrop-blur-md border-t border-[var(--color-botanical-border)] px-4 py-3 pb-safe shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
        <div className="flex items-center gap-3 max-w-7xl mx-auto">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-[var(--color-botanical-subtle)] truncate">{product.name}</p>
            <p className="text-[15px] font-bold text-[var(--color-botanical-primary)]">₹{lineTotal.toLocaleString('en-IN')}</p>
          </div>
          <button
            type="button"
            onClick={handleAddToCart}
            className="px-5 py-3 rounded-full bg-[#180f0a] hover:bg-[#964735] text-white text-[13px] font-semibold flex items-center justify-center gap-2 shrink-0 touch-target transition-colors shadow-sm"
          >
            <ShoppingBag className="w-4 h-4" aria-hidden="true" />
            <span>Add to Bag</span>
          </button>
        </div>
      </div>
    </div>
  );
}
