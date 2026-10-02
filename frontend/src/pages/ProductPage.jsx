import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, Minus, Plus, Heart, ShoppingBag, Zap,
  Truck, Sparkles, Leaf, Check, Gift, X, ZoomIn, MessageSquarePlus,
  Play, Camera, ShieldCheck, Ruler, Package, Info,
} from 'lucide-react';
import { getProductById, getProducts as getCatalogProducts, isOutOfStock, isLowStock, maxOrderable } from '../services/productService.js';
import { getSettings } from '../services/settingsService.js';
import { deriveGiftAttributes, OCCASION_OPTIONS, RECIPIENT_OPTIONS } from '../services/giftFinderService.js';
import { getProductReviews, submitProductReview, markReviewHelpful } from '../services/reviewService.js';
import { getToken, API_BASE_URL } from '../services/apiClient.js';
import { useStore } from '../context/StoreContext.jsx';
import { useStoreVersion } from '../hooks/useStoreVersion.js';
import ProductCard from '../components/ProductCard.jsx';
import { Skeleton, SkeletonText } from '../components/Skeleton.jsx';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const QUANTITY_MAX = 10;
const REVIEW_PHOTO_LIMIT = 4;

const OCCASION_LABELS = new Map(OCCASION_OPTIONS.map((o) => [o.id, o.label]));
const RECIPIENT_LABELS = new Map(RECIPIENT_OPTIONS.map((r) => [r.id, r.label]));

function labelFor(map, id) {
  return map.get(id) || String(id || '').replace(/_/g, ' ');
}

function formatDate(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

/** Five-heart rating. SVG hearts only — never emoji. */
function HeartRow({ value, size = 16, className = '' }) {
  const rounded = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`} aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <Heart
          key={i}
          style={{ width: size, height: size }}
          className={i <= rounded ? 'fill-current' : 'opacity-30'}
        />
      ))}
    </span>
  );
}

function Accordion({ icon: Icon, title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded-2xl"
      >
        <span className="flex items-center gap-2.5 text-[13px] sm:text-[14px] font-semibold text-[var(--color-botanical-primary)]">
          {Icon ? <Icon className="w-4 h-4 text-[var(--color-accent)]" aria-hidden="true" /> : null}
          {title}
        </span>
        <ChevronRight
          className={`w-4 h-4 text-[var(--color-botanical-subtle)] transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="px-5 pb-5 -mt-1 text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)] leading-relaxed space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}

export default function ProductPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { addItemToCart, toggleWishlist, isWishlisted } = useStore();

  // Phase 18.5.3 — subscribe to store version so the product lookup re-runs
  // after a background refresh (a stale-while-revalidate cycle must not leave
  // this page showing "Not Found" for a product that still exists).
  const storeVersion = useStoreVersion();

  const [product, setProduct] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [galleryImgError, setGalleryImgError] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [selectedPalette, setSelectedPalette] = useState(null);
  const [selectedRibbon, setSelectedRibbon] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [giftMessage, setGiftMessage] = useState('');
  const [justAdded, setJustAdded] = useState(false);
  const [wishAnim, setWishAnim] = useState(false);
  const [pincode, setPincode] = useState('');
  const [deliveryCheck, setDeliveryCheck] = useState(null);
  const [bundleSelected, setBundleSelected] = useState([]);

  // Reviews — real data only. An empty collection renders an honest empty
  // state instead of invented stars.
  const [reviewData, setReviewData] = useState({ reviews: [], summary: null, media: [] });
  const [reviewsLoading, setReviewsLoading] = useState(true);
  const [reviewsError, setReviewsError] = useState('');
  const [photoFilter, setPhotoFilter] = useState(false);
  const [helpfulIds, setHelpfulIds] = useState([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewForm, setReviewForm] = useState({ rating: 5, title: '', comment: '', occasion: '', recipient: '', recommend: true, photos: [] });
  const [reviewPhotoBusy, setReviewPhotoBusy] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [reviewDone, setReviewDone] = useState(false);

  const lastLookupIdRef = useRef(null);
  const touchStartXRef = useRef(null);
  const reviewsRef = useRef(null);
  const lightboxCloseRef = useRef(null);

  const settings = useMemo(() => getSettings(), []);

  // GSAP refs
  const heroRef = useRef(null);
  const relatedRef = useRef(null);

  // Phase 18.5.3 / 20.2 — re-run the lookup on route param OR store version
  // change. Per-route state (gallery, selections, note, quantity) resets only
  // when the PRODUCT changes so a silent refresh never wipes context.
  useEffect(() => {
    const allProducts = getCatalogProducts();
    const found = getProductById(id);
    const productChanged = lastLookupIdRef.current !== id;
    lastLookupIdRef.current = id;
    if (found) {
      setProduct(found);
      setNotFound(false);
      if (productChanged) {
        setGalleryIndex(0);
        setSelectedPalette(found.palettes && found.palettes.length > 0 ? found.palettes[0].name : null);
        setSelectedRibbon(found.ribbons && found.ribbons.length > 0 ? found.ribbons[0].name : null);
        setQuantity(1);
        setGiftMessage('');
        setJustAdded(false);
        setGalleryImgError(false);
        setLightboxOpen(false);
        setDeliveryCheck(null);
        setBundleSelected([]);
        window.scrollTo(0, 0);
      } else if (found.stockTracked !== false && typeof found.stock === 'number') {
        const cap = Math.max(1, Math.min(QUANTITY_MAX, found.stock));
        setQuantity((q) => Math.min(q, cap));
      }
    } else if (allProducts.length > 0) {
      setProduct(null);
      setNotFound(true);
    }
  }, [id, storeVersion]);

  // Reviews are fetched per product (public endpoint).
  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    setReviewsLoading(true);
    setReviewsError('');
    setPhotoFilter(false);
    setHelpfulIds([]);
    getProductReviews(id)
      .then((data) => { if (alive) setReviewData(data); })
      .catch((err) => { if (alive) setReviewsError(err.message || 'Reviews could not be loaded.'); })
      .finally(() => { if (alive) setReviewsLoading(false); });
    return () => { alive = false; };
  }, [id]);

  // Hero entrance animation
  useEffect(() => {
    if (!product || !heroRef.current) return undefined;
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return undefined;

    const ctx = gsap.context(() => {
      const gallery = heroRef.current.querySelector('[data-gallery]');
      const info = heroRef.current.querySelector('[data-product-info]');
      if (gallery) {
        gsap.fromTo(gallery, { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.6, ease: 'power3.out', delay: 0.1 });
      }
      if (info) {
        gsap.fromTo(info.children, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.06, ease: 'power3.out', delay: 0.2 });
      }
    });
    return () => ctx.revert();
  }, [product]);

  // Related products reveal
  useEffect(() => {
    if (!relatedRef.current || !product) return undefined;
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return undefined;
    const cards = relatedRef.current.querySelectorAll('article');
    if (cards.length === 0) return undefined;

    const ctx = gsap.context(() => {
      gsap.fromTo(cards,
        { opacity: 0, y: 25, scale: 0.97 },
        { opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.06, ease: 'power2.out', scrollTrigger: { trigger: relatedRef.current, start: 'top 85%', once: true } }
      );
    });
    return () => ctx.revert();
  }, [product]);

  const relatedProducts = useMemo(() => {
    if (!product) return [];
    const all = getCatalogProducts().filter((p) => p.id !== product.id && p.visibility !== 'Hidden');
    const sameCategory = all.filter((p) => p.category === product.category);
    const band = Math.max(500, Math.round(product.price * 0.35));
    const similarPrice = all.filter((p) => p.category !== product.category && Math.abs(p.price - product.price) <= band);
    const chosen = [...sameCategory, ...similarPrice];
    const rest = all.filter((p) => !chosen.includes(p));
    return [...chosen, ...rest].slice(0, 4);
  }, [product]);

  // Complementary pieces come from the REAL catalogue (stationery / keepsakes
  // first, then any other visible product). Nothing is invented to fill space.
  const complementary = useMemo(() => {
    if (!product) return [];
    const all = getCatalogProducts().filter(
      (p) => p.id !== product.id && p.visibility !== 'Hidden' && !isOutOfStock(p)
    );
    const keepsakes = all.filter((p) => p.category === 'cards' || p.category === 'charms' || p.category === 'hampers');
    const others = all.filter((p) => !keepsakes.includes(p));
    return [...keepsakes, ...others].slice(0, 3);
  }, [product]);

  const images = product && product.images && product.images.length
    ? product.images
    : product ? [product.image].filter(Boolean) : [];
  const hasGallery = images.length > 1;

  const purchaseOptions = () => ({
    quantity,
    palette: selectedPalette,
    ribbon: selectedRibbon,
    giftMessage: giftMessage.trim() || undefined,
  });

  const handleAddToCart = useCallback(() => {
    if (!product) return;
    if (isOutOfStock(product)) return;
    addItemToCart(product, purchaseOptions());
    setJustAdded(true);
  }, [addItemToCart, product, quantity, selectedPalette, selectedRibbon, giftMessage]);

  const handleBuyNow = useCallback(() => {
    if (!product) return;
    if (isOutOfStock(product)) return;
    addItemToCart(product, purchaseOptions());
    navigate('/checkout');
  }, [addItemToCart, product, quantity, selectedPalette, selectedRibbon, giftMessage, navigate]);

  const handleWishlist = useCallback(() => {
    if (!product) return;
    toggleWishlist(product);
    setWishAnim(true);
    setTimeout(() => setWishAnim(false), 400);
  }, [product, toggleWishlist]);

  useEffect(() => {
    if (!lightboxOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setLightboxOpen(false); };
    window.addEventListener('keydown', onKey);
    if (lightboxCloseRef.current) lightboxCloseRef.current.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxOpen]);

  const reviews = reviewData.reviews || [];
  const summary = reviewData.summary || { average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, recommendPercent: 0, photoCount: 0, videoCount: 0 };
  const media = reviewData.media || [];
  const visibleReviews = photoFilter ? reviews.filter((r) => (r.photos || []).length > 0) : reviews;

  const handleHelpful = async (reviewId) => {
    if (helpfulIds.includes(reviewId)) return;
    setHelpfulIds((prev) => [...prev, reviewId]);
    try {
      await markReviewHelpful(reviewId);
      setReviewData((prev) => ({
        ...prev,
        reviews: (prev.reviews || []).map((r) => (r.id === reviewId ? { ...r, helpfulCount: (r.helpfulCount || 0) + 1 } : r)),
      }));
    } catch {
      setHelpfulIds((prev) => prev.filter((rid) => rid !== reviewId));
    }
  };

  const openReviewForm = () => {
    if (!getToken('customer')) {
      navigate('/login', { state: { from: `/product/${id}` } });
      return;
    }
    setReviewError('');
    setReviewDone(false);
    setReviewOpen(true);
  };

  const handleReviewPhoto = async (files) => {
    if (!files || files.length === 0) return;
    setReviewPhotoBusy(true);
    setReviewError('');
    try {
      const uploaded = [];
      for (const file of Array.from(files).slice(0, REVIEW_PHOTO_LIMIT)) {
        if (!file.type.startsWith('image/')) continue;
        if (file.size > 5 * 1024 * 1024) throw new Error('Each photo must be 5 MB or smaller.');
        const body = new FormData();
        body.append('image', file);
        const res = await fetch(`${API_BASE_URL}/uploads/review-image`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken('customer')}` },
          body,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.url) throw new Error(json.message || 'That photo could not be uploaded.');
        uploaded.push(json.url);
      }
      if (uploaded.length) {
        setReviewForm((f) => ({ ...f, photos: [...f.photos, ...uploaded].slice(0, REVIEW_PHOTO_LIMIT) }));
      }
    } catch (err) {
      setReviewError(err.message || 'That photo could not be uploaded.');
    } finally {
      setReviewPhotoBusy(false);
    }
  };

  const handleReviewSubmit = async (e) => {
    e.preventDefault();
    setReviewError('');
    if (!reviewForm.title.trim() && !reviewForm.comment.trim()) {
      setReviewError('Add a short note about this piece before sharing.');
      return;
    }
    setReviewSubmitting(true);
    try {
      const created = await submitProductReview(id, {
        rating: reviewForm.rating,
        title: reviewForm.title,
        comment: reviewForm.comment,
        occasion: reviewForm.occasion,
        recipient: reviewForm.recipient,
        recommend: reviewForm.recommend,
        photos: reviewForm.photos,
      });
      // Instant feedback: prepend the real published review right away.
      setReviewData((prev) => ({
        ...prev,
        reviews: [created, ...(prev.reviews || [])],
      }));
      // Then reconcile the aggregate with the server's own summary so derived
      // figures (recommendPercent, average, distribution, media) are truthful
      // rather than guessed locally. Falls back to the prepend if the refetch
      // fails, so a transient network blip never loses the customer's review.
      try {
        const fresh = await getProductReviews(id);
        setReviewData(fresh);
      } catch {
        // Keep the optimistic prepend already applied above.
      }
      setReviewDone(true);
      setReviewForm({ rating: 5, title: '', comment: '', occasion: '', recipient: '', recommend: true, photos: [] });
    } catch (err) {
      setReviewError(err.message || 'Your review could not be shared.');
    } finally {
      setReviewSubmitting(false);
    }
  };

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
          <Link to="/shop" className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors">
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
          <Skeleton className="w-full aspect-square rounded-2xl" />
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
  const madeToOrder = product.stockTracked === false;
  const outOfStock = !madeToOrder && isOutOfStock(product);
  const lowStock = !madeToOrder && isLowStock(product);
  const stockCap = madeToOrder ? QUANTITY_MAX : maxOrderable(product);
  const attributes = deriveGiftAttributes(product);
  const personalizable = attributes.personalization !== 'simple';
  const lineTotal = product.price * quantity;
  const activeImage = images[galleryIndex] || images[0] || '';

  const stepGallery = (delta) => {
    if (!hasGallery) return;
    setGalleryImgError(false);
    setGalleryIndex((i) => (i + delta + images.length) % images.length);
  };

  const onTouchStart = (e) => { touchStartXRef.current = e.touches[0].clientX; };
  const onTouchEnd = (e) => {
    if (touchStartXRef.current === null || !hasGallery) return;
    const delta = e.changedTouches[0].clientX - touchStartXRef.current;
    touchStartXRef.current = null;
    if (Math.abs(delta) > 45) stepGallery(delta < 0 ? 1 : -1);
  };

  const runDeliveryCheck = () => {
    const value = pincode.trim();
    if (!/^\d{6}$/.test(value)) {
      setDeliveryCheck({ ok: false, message: 'Enter a valid 6-digit pincode to check delivery.' });
      return;
    }
    const standardDays = settings?.shippingConfiguration?.standardDays || '';
    const expressDays = settings?.shippingConfiguration?.expressDays || '';
    const standardRate = settings?.standardShippingRate;
    const expressRate = settings?.expressShippingRate;
    setDeliveryCheck({
      ok: true,
      pincode: value,
      standardDays,
      expressDays,
      standardRate,
      expressRate,
      freeAbove: settings?.freeShippingAbove,
    });
  };

  const toggleBundle = (pid) => {
    setBundleSelected((prev) => (prev.includes(pid) ? prev.filter((p) => p !== pid) : [...prev, pid]));
  };

  const addBundleToBag = () => {
    const chosen = complementary.filter((p) => bundleSelected.includes(p.id));
    chosen.forEach((p) => addItemToCart(p, { quantity: 1 }));
    setJustAdded(true);
    setBundleSelected([]);
  };

  const details = [
    {
      key: 'craft',
      icon: Sparkles,
      title: 'Craft & Materials',
      body: (
        <>
          <p>
            Every stem is formed around a pliable wire armature and overlaid with dense cotton chenille,
            then twisted petal by petal so the bloom keeps its botanical curve while staying soft to
            the touch.
          </p>
          {product.materials ? (
            <p className="text-[var(--color-botanical-text)]"><strong className="text-[var(--color-botanical-primary)]">This piece:</strong> {product.materials}</p>
          ) : null}
          <p>Handmade in small batches — natural variation between pieces is expected and intended.</p>
        </>
      ),
    },
    {
      key: 'care',
      icon: Leaf,
      title: 'Care',
      body: (
        <>
          <p>Keep away from water, damp surfaces and prolonged direct sun to protect the natural dyes and paper wrap.</p>
          <p>Dust gently with a soft dry brush every few months. No watering, no trimming, no wilting.</p>
        </>
      ),
    },
    {
      key: 'dimensions',
      icon: Ruler,
      title: 'Dimensions',
      body: (
        <>
          {product.dimensions ? (
            <p className="text-[var(--color-botanical-text)]">{product.dimensions}</p>
          ) : (
            <p>
              Dimensions are set per piece by the studio and vary slightly with the arrangement. If you
              need an exact measurement for a vessel or display space, message the studio before ordering
              and we will confirm it.
            </p>
          )}
          {madeToOrder ? <p>Made to order — the studio confirms final dimensions when crafting begins.</p> : null}
        </>
      ),
    },
    {
      key: 'packaging',
      icon: Package,
      title: 'Packaging & Delivery',
      body: (
        <>
          <p>Arrives nested in a rigid presentation box with a wax seal and a hand-written keepsake card.</p>
          {settings?.shippingEnabled ? (
            <p>
              Pan-India dispatch
              {settings.freeShippingAbove ? ` · complimentary above ₹${Number(settings.freeShippingAbove).toLocaleString('en-IN')}` : ''}
              {settings.shippingConfiguration?.standardDays ? ` · standard ${settings.shippingConfiguration.standardDays}` : ''}
              {settings.expressShippingRate ? ` · express ₹${settings.expressShippingRate}` : ''}.
            </p>
          ) : null}
          {madeToOrder ? <p>Made to order — allow extra studio time before dispatch.</p> : null}
          <p className="text-[12px] text-[var(--color-botanical-subtle)]">
            Studio information only — live courier tracking is not yet integrated.{' '}
            <Link to="/order-tracking" className="font-semibold text-[var(--color-accent)] hover:underline">Track an existing order →</Link>
          </p>
        </>
      ),
    },
  ];

  const distribution = summary.distribution || {};
  const distTotal = Object.values(distribution).reduce((s, n) => s + n, 0);

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen py-6 lg:py-12 pb-28 lg:pb-16">
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
          {/* ── Gallery ── */}
          <div data-gallery className="lg:col-span-7">
            <div className="flex flex-col-reverse lg:flex-row gap-3 lg:gap-5">
              {/* Vertical thumb rail (desktop) / horizontal rail (mobile) */}
              {hasGallery && (
                <div
                  className="flex lg:flex-col gap-2.5 lg:gap-3 overflow-x-auto lg:overflow-visible pb-1 lg:pb-0 shrink-0 scrollbar-none"
                  role="tablist"
                  aria-label="Product media"
                >
                  {images.map((imgUrl, idx) => (
                    <button
                      key={`${imgUrl}-${idx}`}
                      type="button"
                      role="tab"
                      aria-selected={galleryIndex === idx}
                      aria-label={`Show image ${idx + 1} of ${images.length}`}
                      onClick={() => { setGalleryImgError(false); setGalleryIndex(idx); }}
                      className={`relative w-16 h-20 sm:w-[74px] sm:h-[92px] rounded-xl overflow-hidden bg-[var(--color-surface-lowest)] border-2 transition-all duration-200 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${
                        galleryIndex === idx
                          ? 'border-[#964735] shadow-sm'
                          : 'border-[var(--color-botanical-border)] opacity-70 hover:opacity-100'
                      }`}
                    >
                      <img src={imgUrl} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}

              {/* Primary photograph */}
              <div
                className="relative w-full aspect-square sm:aspect-[4/5] rounded-3xl overflow-hidden bg-[var(--color-surface-lowest)] shadow-[0_8px_30px_-4px_rgba(46,36,30,0.08)] border border-[var(--color-botanical-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                tabIndex={hasGallery ? 0 : -1}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') { e.preventDefault(); stepGallery(-1); }
                  if (e.key === 'ArrowRight') { e.preventDefault(); stepGallery(1); }
                }}
                onTouchStart={onTouchStart}
                onTouchEnd={onTouchEnd}
                role={hasGallery ? 'group' : undefined}
                aria-label={hasGallery ? `Product image ${galleryIndex + 1} of ${images.length}` : undefined}
              >
                {!galleryImgError && activeImage ? (
                  <img
                    key={galleryIndex}
                    src={activeImage}
                    alt={product.name}
                    className="w-full h-full object-cover fa-gallery-crossfade"
                    onError={() => setGalleryImgError(true)}
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-[#b0a89f] bg-[var(--color-surface-low)]">
                    <span className="text-4xl mb-2" aria-hidden="true">🌸</span>
                    <span className="text-[13px] font-medium">Image unavailable</span>
                  </div>
                )}

                {activeImage && !galleryImgError && (
                  <button
                    type="button"
                    onClick={() => setLightboxOpen(true)}
                    className="absolute bottom-4 right-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-sm text-[11px] font-semibold uppercase tracking-wider text-[var(--color-botanical-primary)] shadow-sm hover:bg-[var(--color-surface-lowest)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                  >
                    <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" /> Inspect
                  </button>
                )}

                {hasGallery && (
                  <>
                    <button
                      type="button"
                      onClick={() => stepGallery(-1)}
                      aria-label="Previous image"
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-sm shadow-md flex items-center justify-center text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-lowest)] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                    >
                      <ChevronLeft className="w-5 h-5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => stepGallery(1)}
                      aria-label="Next image"
                      className="absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-sm shadow-md flex items-center justify-center text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-lowest)] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                    >
                      <ChevronRight className="w-5 h-5" aria-hidden="true" />
                    </button>
                    <span className="absolute bottom-4 left-4 px-2.5 py-1 rounded-full bg-[#180f0a]/80 text-white text-[11px] font-semibold">
                      {galleryIndex + 1} / {images.length}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* ── Purchase panel ── */}
          <div data-product-info className="lg:col-span-5 space-y-5 sm:space-y-6">
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
                  {product.categoryLabel || 'Handcrafted Flora'}
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] text-[11px] font-semibold text-[var(--color-botanical-muted)]">
                  <Leaf className="w-3 h-3 text-[var(--color-botanical-sage)]" aria-hidden="true" />
                  {madeToOrder ? 'Made to order' : 'Handcrafted in small batches'}
                </span>
              </div>

              <h1 className="font-serif text-[28px] sm:text-[32px] md:text-[38px] text-[var(--color-botanical-primary)] font-normal leading-tight tracking-tight">
                {product.name}
              </h1>

              {/* Heart rating — scrolls to the real reviews */}
              <button
                type="button"
                onClick={() => reviewsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className="inline-flex items-center gap-2.5 rounded-full px-3 py-1.5 bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              >
                <HeartRow value={summary.count > 0 ? summary.average : 0} size={15} className="text-[var(--color-accent)]" />
                {summary.count > 0 ? (
                  <span className="text-[12px] text-[var(--color-botanical-muted)]">
                    <strong className="text-[var(--color-botanical-primary)]">{summary.average.toFixed(1)}</strong> · {summary.count} review{summary.count === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className="text-[12px] text-[var(--color-botanical-muted)]">Be the first to review</span>
                )}
              </button>

              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-[24px] sm:text-[28px] font-bold text-[var(--color-botanical-primary)]">
                  ₹{product.price.toLocaleString('en-IN')}
                </span>
                <span className="text-[11px] uppercase font-bold text-[var(--color-botanical-sage)] bg-[var(--color-botanical-sage-light)] px-2.5 py-0.5 rounded-full">
                  All taxes included
                </span>
              </div>

              {!madeToOrder && typeof product.stock === 'number' && (
                outOfStock ? (
                  <span role="status" className="inline-flex items-center gap-1.5 self-start px-3 py-1 rounded-full text-[12px] font-bold bg-[var(--color-danger)]/10 text-[var(--color-danger)] border border-[var(--color-danger)]/40">
                    Out of Stock — this creation is sold out right now
                  </span>
                ) : lowStock ? (
                  <span role="status" className="inline-flex items-center gap-1.5 self-start px-3 py-1 rounded-full text-[12px] font-bold bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40">
                    Only {product.stock} left — ready to ship while stock lasts
                  </span>
                ) : (
                  <span role="status" className="inline-flex items-center gap-1.5 self-start px-3 py-1 rounded-full text-[12px] font-semibold bg-[var(--color-botanical-sage-light)] text-[var(--color-botanical-sage)] border border-[var(--color-botanical-sage)]/30">
                    In stock · {product.stock} available
                  </span>
                )
              )}

              <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed">
                {product.description
                  || `A handcrafted ${(product.categoryLabel || 'studio piece').toLowerCase()}${product.palette ? ` in ${product.palette}` : ''}, made in small batches and finished by hand.`}
              </p>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="inline-flex items-center gap-1.5 text-[11px] sm:text-[12px] font-medium text-[var(--color-botanical-muted)]">
                  <Check className="w-3.5 h-3.5 text-[var(--color-botanical-sage)]" aria-hidden="true" /> Handcrafted
                </span>
                {personalizable && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] sm:text-[12px] font-medium text-[var(--color-botanical-muted)]">
                    <Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)]" aria-hidden="true" /> Personalizable
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 text-[11px] sm:text-[12px] font-medium text-[var(--color-botanical-muted)]">
                  <Gift className="w-3.5 h-3.5 text-[var(--color-accent)]" aria-hidden="true" /> Gift-ready packaging
                </span>
              </div>
            </div>

            {/* Perfect for / Ideal for — from the product's own taxonomy */}
            {(attributes.occasions.length > 0 || attributes.recipients.length > 0) && (
              <div className="space-y-2.5 pt-3 border-t border-[var(--color-botanical-border)]">
                {attributes.occasions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] shrink-0">Perfect for</span>
                    {attributes.occasions.slice(0, 5).map((occ) => (
                      <span key={occ} className="px-2.5 py-0.5 rounded-full bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] text-[12px] text-[var(--color-botanical-text)]">
                        {labelFor(OCCASION_LABELS, occ)}
                      </span>
                    ))}
                  </div>
                )}
                {attributes.recipients.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] shrink-0">Ideal for</span>
                    {attributes.recipients.slice(0, 4).map((rec) => (
                      <span key={rec} className="px-2.5 py-0.5 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-accent)] text-[12px] font-medium">
                        {labelFor(RECIPIENT_LABELS, rec)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Personalization */}
            {((product.palettes && product.palettes.length > 0) || (product.ribbons && product.ribbons.length > 0) || personalizable) && (
              <div className="rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-serif text-[18px] text-[var(--color-botanical-primary)]">Make it yours</h2>
                  <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Complimentary</span>
                </div>

                {product.palettes && product.palettes.length > 0 && (
                  <div className="space-y-2">
                    <span className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Botanical colorway</span>
                    <div className="flex flex-wrap gap-2">
                      {product.palettes.map((pal) => (
                        <button
                          key={pal.id}
                          type="button"
                          aria-pressed={selectedPalette === pal.name}
                          onClick={() => { setSelectedPalette(pal.name); setJustAdded(false); }}
                          className={`px-3 py-1.5 rounded-full border text-[12px] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${
                            selectedPalette === pal.name
                              ? 'bg-[var(--color-botanical-sage-light)] border-[var(--color-botanical-sage)] text-[var(--color-botanical-primary)] font-semibold'
                              : 'bg-[var(--color-surface-low)] border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)] hover:border-[#80756f]'
                          }`}
                        >
                          {pal.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {product.ribbons && product.ribbons.length > 0 && (
                  <div className="space-y-2">
                    <span className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Ribbon &amp; stem tie</span>
                    <div className="flex flex-wrap gap-2">
                      {product.ribbons.map((ribbon) => (
                        <button
                          key={ribbon.id}
                          type="button"
                          aria-pressed={selectedRibbon === ribbon.name}
                          onClick={() => { setSelectedRibbon(ribbon.name); setJustAdded(false); }}
                          className={`px-3 py-1.5 rounded-full border text-[12px] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${
                            selectedRibbon === ribbon.name
                              ? 'bg-[var(--color-surface-lowest)] border-[var(--color-btn)] text-[var(--color-botanical-primary)] font-semibold shadow-sm'
                              : 'bg-[var(--color-surface-low)] border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)] hover:border-[#80756f]'
                          }`}
                        >
                          {ribbon.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <label htmlFor="gift-note" className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">
                    Handwritten gift note (optional)
                  </label>
                  <textarea
                    id="gift-note"
                    rows={2}
                    maxLength={240}
                    value={giftMessage}
                    onChange={(e) => { setGiftMessage(e.target.value); setJustAdded(false); }}
                    placeholder="Include a personal message for the recipient…"
                    className="w-full p-3 rounded-2xl bg-[var(--color-surface-low)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] resize-none transition-shadow"
                  />
                  <p className="text-[11px] text-[var(--color-botanical-subtle)]">
                    Inscribed on deckled cotton paper and enclosed with an organic wax seal. {giftMessage.length}/240
                  </p>
                </div>

                {(giftMessage.trim() || selectedPalette || selectedRibbon) && (
                  <div className="rounded-xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] p-3.5 space-y-1.5">
                    <p className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Your version</p>
                    {selectedPalette && <p className="text-[12px] text-[var(--color-botanical-muted)]"><span className="font-semibold text-[var(--color-botanical-primary)]">Colorway:</span> {selectedPalette}</p>}
                    {selectedRibbon && <p className="text-[12px] text-[var(--color-botanical-muted)]"><span className="font-semibold text-[var(--color-botanical-primary)]">Ribbon:</span> {selectedRibbon}</p>}
                    <p className="font-serif text-[14px] text-[var(--color-botanical-text)] italic leading-relaxed border-t border-[var(--color-botanical-border)] pt-2">
                      {giftMessage.trim() ? `\u201c${giftMessage.trim()}\u201d` : 'Your gift note will be inscribed here.'}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Quantity + primary actions */}
            <div className="pt-4 border-t border-[var(--color-botanical-border)] space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[12px] font-bold uppercase tracking-wider text-[var(--color-botanical-primary)]">Quantity</span>
                <div className="flex items-center justify-between px-2 py-1 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] w-32">
                  <button
                    type="button"
                    onClick={() => { setQuantity((q) => Math.max(1, q - 1)); setJustAdded(false); }}
                    disabled={quantity <= 1}
                    aria-label="Decrease quantity"
                    className="w-11 h-11 rounded-full flex items-center justify-center text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] disabled:opacity-40 transition-colors"
                  >
                    <Minus className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <span className="text-[14px] font-bold text-[var(--color-botanical-primary)]" aria-live="polite">{quantity}</span>
                  <button
                    type="button"
                    onClick={() => { setQuantity((q) => Math.min(stockCap, q + 1)); setJustAdded(false); }}
                    disabled={quantity >= stockCap}
                    aria-label="Increase quantity"
                    className="w-11 h-11 rounded-full flex items-center justify-center text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] disabled:opacity-40 transition-colors"
                  >
                    <Plus className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
                <span className="text-[12px] text-[var(--color-botanical-subtle)]">
                  {outOfStock
                    ? 'Unavailable while sold out'
                    : stockCap < QUANTITY_MAX
                      ? `Only ${stockCap} in stock`
                      : `Max ${QUANTITY_MAX} per order`}
                </span>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <button
                  type="button"
                  onClick={handleAddToCart}
                  disabled={outOfStock}
                  className={`flex-1 min-h-[48px] py-3.5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-md hover:shadow-lg transition-all duration-200 active:translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#964735] focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${justAdded ? 'fa-atc-success' : ''}`}
                >
                  <ShoppingBag className="w-4 h-4" aria-hidden="true" />
                  <span>{outOfStock ? 'Out of Stock' : `Add to Bag · ₹${lineTotal.toLocaleString('en-IN')}`}</span>
                </button>

                <button
                  type="button"
                  onClick={handleWishlist}
                  aria-pressed={wishlisted}
                  aria-label={wishlisted ? 'Remove from Saved Gifts' : 'Save to Saved Gifts'}
                  title={wishlisted ? 'Remove from Saved Gifts' : 'Save to Saved Gifts'}
                  className={`min-h-[48px] min-w-[48px] p-3.5 rounded-full border transition-all duration-200 shrink-0 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#964735] ${
                    wishlisted
                      ? 'bg-[var(--color-badge-bg)] border-[#964735] text-[var(--color-accent)]'
                      : 'bg-[var(--color-surface-lowest)] border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)] hover:text-[var(--color-accent)] hover:border-[#964735]'
                  } ${wishAnim ? 'fa-wishlist-pop' : ''}`}
                >
                  <Heart className={`w-5 h-5 transition-all duration-200 ${wishlisted ? 'fill-[var(--color-accent)] scale-110' : ''}`} aria-hidden="true" />
                </button>
              </div>

              <button
                type="button"
                onClick={handleBuyNow}
                disabled={outOfStock}
                className="w-full min-h-[48px] py-3.5 rounded-full bg-[var(--color-surface-lowest)] border-2 border-[var(--color-btn)] hover:bg-[var(--color-surface-low)] text-[var(--color-botanical-primary)] text-[13px] font-semibold tracking-wide flex items-center justify-center gap-2 shadow-sm hover:shadow-md transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Zap className="w-4 h-4" aria-hidden="true" />
                <span>{outOfStock ? 'Out of Stock' : `Buy Now · ₹${lineTotal.toLocaleString('en-IN')}`}</span>
              </button>

              {justAdded && (
                <div className="rounded-2xl bg-[var(--color-success-soft-bg)] border border-[var(--color-success-soft-border)] p-4 flex flex-wrap items-center justify-between gap-3" role="status" aria-live="polite">
                  <p className="text-[13px] font-semibold text-[var(--color-success-soft-fg)] flex items-center gap-2">
                    <Check className="w-4 h-4" aria-hidden="true" /> Added to your bag
                  </p>
                  <div className="flex items-center gap-2">
                    <Link to="/cart" className="px-4 py-2 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors">View Bag</Link>
                    <button type="button" onClick={() => setJustAdded(false)} className="px-4 py-2 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-success-soft-border)] text-[var(--color-success-soft-fg)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors">Continue Shopping</button>
                  </div>
                </div>
              )}
            </div>

            {/* Delivery pincode check */}
            <div className="rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] p-4 space-y-3">
              <p className="text-[12px] font-bold uppercase tracking-wider text-[var(--color-botanical-primary)] flex items-center gap-2">
                <Truck className="w-4 h-4 text-[var(--color-accent)]" aria-hidden="true" /> Deliver to
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={pincode}
                  onChange={(e) => { setPincode(e.target.value.replace(/\D/g, '')); setDeliveryCheck(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runDeliveryCheck(); } }}
                  placeholder="6-digit pincode"
                  aria-label="Pincode"
                  className="flex-1 min-h-[44px] px-4 rounded-full bg-[var(--color-surface-low)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
                />
                <button
                  type="button"
                  onClick={runDeliveryCheck}
                  className="min-h-[44px] px-4 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[12px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#964735]"
                >
                  Check
                </button>
              </div>
              {deliveryCheck && (
                deliveryCheck.ok ? (
                  <div className="text-[12px] text-[var(--color-botanical-muted)] space-y-1" role="status">
                    <p className="text-[var(--color-botanical-primary)] font-semibold flex items-center gap-1.5">
                      <Check className="w-3.5 h-3.5 text-[var(--color-botanical-sage)]" aria-hidden="true" />
                      Delivery available to {deliveryCheck.pincode}
                    </p>
                    <p>
                      Standard{deliveryCheck.standardDays ? ` (${deliveryCheck.standardDays})` : ''}
                      {deliveryCheck.standardRate === 0 ? ' · complimentary' : deliveryCheck.standardRate ? ` · ₹${deliveryCheck.standardRate}` : ''}
                      {deliveryCheck.freeAbove ? ` · free above ₹${Number(deliveryCheck.freeAbove).toLocaleString('en-IN')}` : ''}
                    </p>
                    {deliveryCheck.expressRate ? (
                      <p>Express atelier{deliveryCheck.expressDays ? ` (${deliveryCheck.expressDays})` : ''} · ₹{deliveryCheck.expressRate}</p>
                    ) : null}
                    {madeToOrder ? <p>Made to order — studio time is added before dispatch.</p> : null}
                  </div>
                ) : (
                  <p role="alert" className="text-[12px] font-semibold text-[var(--color-danger)]">{deliveryCheck.message}</p>
                )
              )}
            </div>
          </div>
        </div>

        {/* ── Product information ── */}
        <div className="mt-12 lg:mt-16 grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-10">
          <div className="lg:col-span-4">
            <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Good to know</span>
            <h2 className="font-serif text-[24px] sm:text-[28px] text-[var(--color-botanical-primary)] mt-1">
              The details behind the piece
            </h2>
            <p className="text-[13px] text-[var(--color-botanical-muted)] mt-3 leading-relaxed">
              Every note below is specific to this creation — how it is made, how to keep it, and how it arrives.
            </p>
          </div>
          <div className="lg:col-span-8 space-y-3">
            {details.map((section) => (
              <Accordion
                key={section.key}
                icon={section.icon}
                title={section.title}
                defaultOpen={section.key === 'craft'}
              >
                {section.body}
              </Accordion>
            ))}
          </div>
        </div>

        {/* ── Complete the Gift ── */}
        {complementary.length > 0 && (
          <section className="mt-12 lg:mt-16 rounded-3xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] p-5 sm:p-7">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-5">
              <div>
                <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Complete the gift</span>
                <h2 className="font-serif text-[22px] sm:text-[26px] text-[var(--color-botanical-primary)] mt-1">
                  Pair it with something small
                </h2>
              </div>
              <p className="text-[12px] text-[var(--color-botanical-muted)]">Real catalogue pieces, added at their own price.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              {complementary.map((item) => {
                const checked = bundleSelected.includes(item.id);
                const img = (item.images && item.images[0]) || '';
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => toggleBundle(item.id)}
                    className={`text-left rounded-2xl border p-3 flex gap-3 items-start transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${
                      checked
                        ? 'bg-[var(--color-surface-lowest)] border-[var(--color-btn)] shadow-sm'
                        : 'bg-[var(--color-surface-lowest)] border-[var(--color-botanical-border)] hover:border-[#80756f]'
                    }`}
                  >
                    <span className={`mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${checked ? 'bg-[var(--color-btn)] border-[var(--color-btn)] text-white' : 'border-[var(--color-botanical-border)] bg-[var(--color-surface-low)]'}`}>
                      {checked ? <Check className="w-3 h-3" aria-hidden="true" /> : null}
                    </span>
                    <span className="w-14 h-14 rounded-xl overflow-hidden bg-[var(--color-surface-low)] shrink-0">
                      {img ? <img src={img} alt="" loading="lazy" className="w-full h-full object-cover" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-[var(--color-botanical-primary)] line-clamp-2">{item.name}</span>
                      <span className="block text-[12px] font-semibold text-[var(--color-accent)] mt-0.5">+₹{Number(item.price).toLocaleString('en-IN')}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-5 pt-4 border-t border-[var(--color-botanical-border)]">
              <p className="text-[12px] text-[var(--color-botanical-muted)]">
                {bundleSelected.length > 0
                  ? `${bundleSelected.length} add-on${bundleSelected.length > 1 ? 's' : ''} selected · ₹${complementary.filter((p) => bundleSelected.includes(p.id)).reduce((s, p) => s + Number(p.price), 0).toLocaleString('en-IN')}`
                  : 'Nothing selected yet.'}
              </p>
              <button
                type="button"
                onClick={addBundleToBag}
                disabled={bundleSelected.length === 0}
                className="min-h-[44px] px-6 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ShoppingBag className="w-4 h-4" aria-hidden="true" /> Add selected to Bag
              </button>
            </div>
          </section>
        )}

        {/* ── Reviews ── */}
        <section ref={reviewsRef} id="reviews" className="mt-12 lg:mt-20 scroll-mt-24">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
            <div>
              <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Customer reviews</span>
              <h2 className="font-serif text-[24px] sm:text-[28px] lg:text-[34px] text-[var(--color-botanical-primary)] mt-1">
                What customers say
              </h2>
            </div>
            <button
              type="button"
              onClick={openReviewForm}
              className="self-start sm:self-auto min-h-[44px] px-5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold flex items-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#964735]"
            >
              <MessageSquarePlus className="w-4 h-4" aria-hidden="true" /> Share your experience
            </button>
          </div>

          {reviewsError && (
            <p role="alert" className="mb-5 text-[13px] text-[var(--color-danger)] bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 rounded-2xl px-4 py-3">
              {reviewsError}
            </p>
          )}

          {reviewsLoading ? (
            <div className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-6 space-y-3">
              <Skeleton className="h-6 w-40 rounded-md" />
              <SkeletonText lines={3} />
            </div>
          ) : summary.count === 0 ? (
            <div className="rounded-3xl border border-dashed border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] px-6 py-12 text-center">
              <HeartRow value={0} size={18} className="text-[var(--color-accent)] justify-center" />
              <h3 className="font-serif text-[20px] text-[var(--color-botanical-primary)] mt-3">No reviews yet</h3>
              <p className="text-[13px] text-[var(--color-botanical-muted)] mt-2 max-w-md mx-auto">
                This piece has not been reviewed yet. If it has arrived with you, your honest words help the
                next person decide.
              </p>
              <button
                type="button"
                onClick={openReviewForm}
                className="mt-5 min-h-[44px] px-5 rounded-full bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-lowest)] transition-colors"
              >
                Be the first to review
              </button>
            </div>
          ) : (
            <>
              {/* Summary + distribution */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 rounded-3xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5 sm:p-7">
                <div className="lg:col-span-4 flex flex-col items-center lg:items-start justify-center lg:border-r border-[var(--color-botanical-border)] lg:pr-7">
                  <span className="font-serif text-[52px] leading-none text-[var(--color-botanical-primary)]">{summary.average.toFixed(1)}</span>
                  <HeartRow value={summary.average} size={18} className="text-[var(--color-accent)] my-2" />
                  <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">
                    {summary.count} review{summary.count === 1 ? '' : 's'}
                  </p>
                  <p className="text-[12px] text-[var(--color-botanical-muted)] mt-0.5">
                    {summary.recommendPercent}% would recommend
                  </p>
                </div>
                <div className="lg:col-span-8 flex flex-col justify-center gap-2">
                  {[5, 4, 3, 2, 1].map((heart) => {
                    const n = distribution[heart] || 0;
                    const pct = distTotal > 0 ? Math.round((n / distTotal) * 100) : 0;
                    return (
                      <div key={heart} className="flex items-center gap-3">
                        <span className="w-16 text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] shrink-0">
                          {heart} heart{heart === 1 ? '' : 's'}
                        </span>
                        <span className="flex-1 h-1.5 rounded-full bg-[var(--color-surface-low)] overflow-hidden">
                          <span className="block h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
                        </span>
                        <span className="w-10 text-right text-[12px] text-[var(--color-botanical-muted)]">{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Photo filter — only when real photo reviews exist */}
              {summary.photoCount > 0 && (
                <div className="flex items-center gap-2 mt-5">
                  <button
                    type="button"
                    onClick={() => setPhotoFilter(false)}
                    aria-pressed={!photoFilter}
                    className={`px-3.5 py-1.5 rounded-full text-[12px] font-semibold transition-colors ${!photoFilter ? 'bg-[var(--color-btn)] text-white' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-lowest)]'}`}
                  >
                    All reviews
                  </button>
                  <button
                    type="button"
                    onClick={() => setPhotoFilter(true)}
                    aria-pressed={photoFilter}
                    className={`px-3.5 py-1.5 rounded-full text-[12px] font-semibold transition-colors ${photoFilter ? 'bg-[var(--color-btn)] text-white' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-lowest)]'}`}
                  >
                    With photos ({summary.photoCount})
                  </button>
                </div>
              )}

              {/* Review cards */}
              <div className="mt-5 space-y-4">
                {visibleReviews.length === 0 ? (
                  <p className="text-[13px] text-[var(--color-botanical-muted)] rounded-2xl border border-dashed border-[var(--color-botanical-border)] px-4 py-6 text-center">
                    No photo reviews yet — switch back to all reviews.
                  </p>
                ) : visibleReviews.map((review) => (
                  <article key={review.id} className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-9 h-9 rounded-full bg-[var(--color-surface-low)] text-[var(--color-botanical-primary)] font-serif text-[16px] flex items-center justify-center shrink-0">
                          {(review.customerName || 'F').trim().charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)] truncate">{review.customerName}</p>
                          <p className="text-[11px] text-[var(--color-botanical-subtle)] flex items-center gap-2 flex-wrap">
                            {review.verified && (
                              <span className="inline-flex items-center gap-1 text-[var(--color-botanical-sage)] font-semibold">
                                <ShieldCheck className="w-3 h-3" aria-hidden="true" /> Verified purchase
                              </span>
                            )}
                            <span>{formatDate(review.createdAt)}</span>
                          </p>
                        </div>
                      </div>
                      <HeartRow value={review.rating} size={14} className="text-[var(--color-accent)]" />
                    </div>

                    {review.title && (
                      <h3 className="font-serif text-[17px] text-[var(--color-botanical-primary)] leading-snug">{review.title}</h3>
                    )}
                    {review.comment && (
                      <p className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">{review.comment}</p>
                    )}

                    {(review.occasion || review.recipient) && (
                      <p className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-botanical-subtle)]">
                        {review.occasion ? labelFor(OCCASION_LABELS, review.occasion) : ''}
                        {review.occasion && review.recipient ? ' · ' : ''}
                        {review.recipient ? labelFor(RECIPIENT_LABELS, review.recipient) : ''}
                      </p>
                    )}

                    {(review.photos || []).length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {review.photos.map((photo) => (
                          <span key={photo} className="w-20 h-20 rounded-xl overflow-hidden bg-[var(--color-surface-low)]">
                            <img src={photo} alt="" loading="lazy" className="w-full h-full object-cover" />
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-2 border-t border-[var(--color-botanical-border)]">
                      <button
                        type="button"
                        onClick={() => handleHelpful(review.id)}
                        disabled={helpfulIds.includes(review.id)}
                        className="inline-flex items-center gap-1.5 min-h-[44px] text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] disabled:opacity-60 transition-colors"
                      >
                        <Heart className={`w-3.5 h-3.5 ${helpfulIds.includes(review.id) ? 'fill-[var(--color-accent)] text-[var(--color-accent)]' : ''}`} aria-hidden="true" />
                        Helpful · {review.helpfulCount || 0}
                      </button>
                      {review.recommend ? (
                        <span className="text-[11px] text-[var(--color-botanical-sage)] font-semibold">Would recommend</span>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>

        {/* ── Loved by our customers — only real customer media ── */}
        {media.length > 0 && (
          <section className="mt-12 lg:mt-20">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-5">
              <div>
                <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Customer media</span>
                <h2 className="font-serif text-[24px] sm:text-[28px] lg:text-[34px] text-[var(--color-botanical-primary)] mt-1">
                  Loved by our customers
                </h2>
              </div>
              <p className="text-[12px] text-[var(--color-botanical-muted)] flex items-center gap-1.5">
                <Camera className="w-3.5 h-3.5" aria-hidden="true" /> Photos shared by verified buyers
              </p>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
              {media.slice(0, 8).map((item, idx) => (
                <figure
                  key={`${item.reviewId}-${idx}`}
                  className={`relative rounded-2xl overflow-hidden bg-[var(--color-surface-low)] ${idx % 4 === 0 ? 'lg:row-span-2 aspect-[3/4]' : 'aspect-square'}`}
                >
                  <img src={item.url} alt="" loading="lazy" className="w-full h-full object-cover" />
                  {item.type === 'video' && (
                    <span className="absolute top-3 right-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#180f0a]/75 text-white text-[11px]">
                      <Play className="w-3 h-3" aria-hidden="true" /> Video
                    </span>
                  )}
                  <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#180f0a]/85 to-transparent p-3 text-white">
                    <HeartRow value={item.rating} size={12} className="text-[var(--color-accent)]" />
                    <span className="block text-[11px] text-white/90 mt-1 truncate">{item.author}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        {/* ── Related ── */}
        {relatedProducts.length > 0 && (
          <div ref={relatedRef} className="mt-14 lg:mt-24 space-y-6">
            <div className="flex items-end justify-between gap-4">
              <div>
                <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
                  Complementary keepsakes
                </span>
                <h2 className="font-serif text-[24px] sm:text-[28px] lg:text-[34px] text-[var(--color-botanical-primary)] mt-1">
                  You may also like
                </h2>
              </div>
              <Link to="/shop" className="text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:text-[var(--color-accent)] shrink-0">
                Browse all →
              </Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
              {relatedProducts.map((p) => <ProductCard key={p.id} product={p} />)}
            </div>
          </div>
        )}
      </div>

      {/* ── Lightbox ── */}
      {lightboxOpen && activeImage && (
        <div
          className="fixed inset-0 z-[60] bg-[#180f0a]/95 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`${product.name} — enlarged image`}
          onClick={() => setLightboxOpen(false)}
        >
          <img src={activeImage} alt={product.name} className="max-h-full max-w-full object-contain rounded-xl" />
          <button
            ref={lightboxCloseRef}
            type="button"
            onClick={() => setLightboxOpen(false)}
            aria-label="Close enlarged image"
            className="absolute top-5 right-5 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* ── Write a review ── */}
      {reviewOpen && (
        <div className="fixed inset-0 z-[60] bg-[#180f0a]/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Share your experience">
          <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-[var(--color-surface-bg)] border border-[var(--color-botanical-border)] p-5 sm:p-7">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Share your experience</span>
                <h2 className="font-serif text-[22px] text-[var(--color-botanical-primary)] mt-1">{product.name}</h2>
              </div>
              <button
                type="button"
                onClick={() => setReviewOpen(false)}
                aria-label="Close review form"
                className="w-10 h-10 rounded-full bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            {reviewDone ? (
              <div className="text-center py-8 space-y-3">
                <div className="w-14 h-14 rounded-full bg-[var(--color-success-soft-bg)] border border-[var(--color-success-soft-border)] mx-auto flex items-center justify-center">
                  <Check className="w-6 h-6 text-[var(--color-success-soft-fg)]" aria-hidden="true" />
                </div>
                <h3 className="font-serif text-[20px] text-[var(--color-botanical-primary)]">Thank you — your review is live</h3>
                <p className="text-[13px] text-[var(--color-botanical-muted)]">Your words are now shown with this piece.</p>
                <button type="button" onClick={() => setReviewOpen(false)} className="mt-2 min-h-[44px] px-6 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors">
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleReviewSubmit} className="space-y-4">
                <div className="space-y-2">
                  <span className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Your rating</span>
                  <div className="flex items-center gap-1.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setReviewForm((f) => ({ ...f, rating: n }))}
                        aria-label={`${n} heart${n === 1 ? '' : 's'}`}
                        aria-pressed={reviewForm.rating === n}
                        className="p-1 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                      >
                        <Heart className={`w-7 h-7 transition-colors ${n <= reviewForm.rating ? 'fill-[var(--color-accent)] text-[var(--color-accent)]' : 'text-[var(--color-botanical-border)]'}`} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="review-title" className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Title</label>
                  <input
                    id="review-title"
                    type="text"
                    maxLength={120}
                    value={reviewForm.title}
                    onChange={(e) => setReviewForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder="Looks even better in person"
                    className="w-full min-h-[44px] px-4 rounded-2xl bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="review-comment" className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Your review</label>
                  <textarea
                    id="review-comment"
                    rows={4}
                    maxLength={2000}
                    value={reviewForm.comment}
                    onChange={(e) => setReviewForm((f) => ({ ...f, comment: e.target.value }))}
                    placeholder="How did it arrive? How does it look and feel?"
                    className="w-full p-3 rounded-2xl bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] resize-none"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label htmlFor="review-occasion" className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Occasion</label>
                    <select
                      id="review-occasion"
                      value={reviewForm.occasion}
                      onChange={(e) => setReviewForm((f) => ({ ...f, occasion: e.target.value }))}
                      className="w-full min-h-[44px] px-3 rounded-2xl bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
                    >
                      <option value="">Prefer not to say</option>
                      {OCCASION_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="review-recipient" className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Recipient</label>
                    <select
                      id="review-recipient"
                      value={reviewForm.recipient}
                      onChange={(e) => setReviewForm((f) => ({ ...f, recipient: e.target.value }))}
                      className="w-full min-h-[44px] px-3 rounded-2xl bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
                    >
                      <option value="">Prefer not to say</option>
                      {RECIPIENT_OPTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Add photos (optional)</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-2 min-h-[44px] px-4 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-primary)] cursor-pointer hover:bg-[var(--color-surface-low)] transition-colors">
                      <Camera className="w-4 h-4" aria-hidden="true" />
                      {reviewPhotoBusy ? 'Uploading…' : 'Attach photos'}
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="sr-only"
                        onChange={(e) => { handleReviewPhoto(e.target.files); e.target.value = ''; }}
                      />
                    </label>
                    {reviewForm.photos.length > 0 && (
                      <span className="text-[12px] text-[var(--color-botanical-muted)]">{reviewForm.photos.length} attached</span>
                    )}
                  </div>
                  {reviewForm.photos.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {reviewForm.photos.map((photo) => (
                        <span key={photo} className="relative w-16 h-16 rounded-xl overflow-hidden bg-[var(--color-surface-low)]">
                          <img src={photo} alt="" className="w-full h-full object-cover" />
                          <button
                            type="button"
                            onClick={() => setReviewForm((f) => ({ ...f, photos: f.photos.filter((p) => p !== photo) }))}
                            aria-label="Remove photo"
                            className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-[#180f0a]/80 text-white flex items-center justify-center"
                          >
                            <X className="w-3 h-3" aria-hidden="true" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <label className="flex items-center gap-2.5 text-[13px] text-[var(--color-botanical-muted)]">
                  <input
                    type="checkbox"
                    checked={reviewForm.recommend}
                    onChange={(e) => setReviewForm((f) => ({ ...f, recommend: e.target.checked }))}
                    className="w-4 h-4 rounded border-[var(--color-botanical-border)]"
                  />
                  I would recommend this piece
                </label>

                {reviewError && (
                  <p role="alert" className="text-[13px] text-[var(--color-danger)] bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 rounded-xl px-4 py-2.5">
                    {reviewError}
                  </p>
                )}

                <div className="flex items-center gap-3 pt-1">
                  <button
                    type="submit"
                    disabled={reviewSubmitting}
                    className="flex-1 min-h-[48px] rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold transition-colors disabled:opacity-50"
                  >
                    {reviewSubmitting ? 'Sharing…' : 'Share review'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setReviewOpen(false)}
                    className="min-h-[48px] px-5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
                <p className="text-[11px] text-[var(--color-botanical-subtle)] flex items-start gap-1.5">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                  Verified purchase badges are added automatically when we find a matching order on your account.
                </p>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ── Mobile sticky purchase bar ── */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-[var(--color-surface-bg)]/95 backdrop-blur-md border-t border-[var(--color-botanical-border)] px-4 py-3 pb-safe shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
        <div className="flex items-center gap-3 max-w-7xl mx-auto">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-[var(--color-botanical-subtle)] truncate">{product.name}</p>
            <p className="text-[15px] font-bold text-[var(--color-botanical-primary)]">₹{lineTotal.toLocaleString('en-IN')}</p>
          </div>
          <button
            type="button"
            onClick={handleAddToCart}
            disabled={outOfStock}
            className="min-h-[48px] px-5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold flex items-center justify-center gap-2 shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ShoppingBag className="w-4 h-4" aria-hidden="true" />
            <span>{outOfStock ? 'Out of Stock' : 'Add to Bag'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
