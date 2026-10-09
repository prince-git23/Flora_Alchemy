import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Send, ArrowLeft, ArrowRight, Sparkles, CheckCircle, Clock, ImagePlus, X,
  UploadCloud, Loader2, Eye, Check, FileImage, AlertCircle, Store,
} from 'lucide-react';
import { getActiveCustomerId } from '../services/customerService.js';
import { createCustomRequest, uploadCustomRequestImage } from '../services/customRequestService.js';
import ReferenceImage from '../components/ReferenceImage.jsx';
import { getProducts } from '../services/productService.js';
import { listShops } from '../services/shopService.js';
import { getTenant } from '../services/tenantContext.js';
import { subscribeStore } from '../services/dataStore.js';
import { gsap, prefersReducedMotion } from '../lib/gsapSetup.js';
import { formatBytes } from '../lib/formatBytes.js';

/**
 * PHASE 3 §25–27 — Custom Request.
 *
 * The backend workflow (Product → Custom Request → Proposal → Order → Payment →
 * Fulfillment) is unchanged and the submitted payload is byte-for-byte the same
 * as before. What changed is the shape of the asking: a long single form became
 * three compact steps, so the customer answers three questions instead of
 * facing twelve fields at once.
 *
 *   1. Tell us what you need   — description, occasion, budget
 *   2. Reference & details     — palette, date, one optional reference image
 *   3. Review & send           — the shop that will make it, a real summary, send
 *
 * The reference image has two real paths (validated upload, or the customer's
 * own link) and every state is visible: selected file name and size, live
 * progress, success, failure and removal. There is no invisible upload.
 */

const OCCASIONS = ['Birthday', 'Anniversary', 'Wedding', 'Graduation', 'Thank You', 'Congratulations', 'Festival', 'Just Because', 'Other'];
const BUDGETS = ['Under ₹500', '₹500 – ₹1,000', '₹1,000 – ₹2,000', '₹2,000 – ₹5,000', '₹5,000+'];

const ACCEPTED_IMAGE_TYPES = 'image/jpeg,image/png,image/webp,image/gif,image/avif';
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;

const FLOW_STEPS = [
  { key: 'idea', label: 'Your idea', hint: 'What should we make?' },
  { key: 'reference', label: 'Reference', hint: 'Palette, date, one image' },
  { key: 'review', label: 'Review & send', hint: 'Check it, then send it' },
];

export default function CustomRequestPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Product context (optional) ────────────────────────────────────────
  // A customer arriving from a product page carries that product's slug in
  // the URL (?product=<slug>). It is a DISPLAY hint only — the server derives
  // the owning workspace from the product itself, so nothing here can move a
  // request into another workspace. Without it this is a general request.
  const productSlug = searchParams.get('product') || '';
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeStore(() => setTick((n) => n + 1)), []);
  const contextProduct = useMemo(() => {
    if (!productSlug) return null;
    const catalogue = getProducts();
    return catalogue.find((p) => p.slug === productSlug || p.id === productSlug) || null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productSlug, tick]);

  const clearProductContext = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('product');
    setSearchParams(next, { replace: true });
  };

  // ── PHASE 2 — the SHOP that will own this request ──────────────────────
  // A request must have exactly ONE authoritative shop. The customer names it
  // here; the SERVER resolves the slug to an ACTIVE shop and stores the
  // workspace itself, so nothing chosen in the browser can move a request
  // between shops (a product commission is locked to the product's shop and a
  // mismatched slug is rejected with 409).
  const [shops, setShops] = useState([]);
  const [shopSlug, setShopSlug] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await listShops().catch(() => null);
      if (cancelled || !res || !res.ok) return;
      const directory = res.shops || [];
      setShops(directory);
      const contextSlug = getTenant();
      const fromContext = directory.find((s) => s.slug === contextSlug);
      if (fromContext) setShopSlug(fromContext.slug);
      else if (directory.length === 1) setShopSlug(directory[0].slug);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A product commission is fulfilled by the PRODUCT's shop, full stop. The
  // slug is still sent (so a mismatch is refused loudly rather than silently
  // redirected); a legacy product with no shop falls back to the selection.
  const productShopSlug = contextProduct?.shop?.slug || '';
  const effectiveShopSlug = productShopSlug || shopSlug;
  const effectiveShopName =
    contextProduct?.shop?.displayName ||
    (shops.find((s) => s.slug === effectiveShopSlug) || {}).displayName ||
    '';

  const [step, setStep] = useState(0);
  const [description, setDescription] = useState('');
  const [occasion, setOccasion] = useState('');
  const [budget, setBudget] = useState('');
  const [colors, setColors] = useState('');
  const [desiredDate, setDesiredDate] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [imageError, setImageError] = useState('');
  // The chosen file's own metadata, so the customer can see exactly what will
  // be sent (and what is being uploaded) rather than a silent spinner.
  const [fileMeta, setFileMeta] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [createdRequestId, setCreatedRequestId] = useState(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);

  // Reference image (OPTIONAL). Two real paths, one stored value:
  //  · upload  → POST /api/uploads/custom-request-image (validated pipeline,
  //              ImageKit in production) → hosted URL kept in `imageUrl`;
  //  · link    → the customer's own URL, validated again server-side.
  // Removing clears the value entirely, so a removed image is never sent.
  const handleImageFile = async (file) => {
    if (!file) return;
    setImageError('');
    setFileMeta({ name: file.name, size: file.size });

    // Client-side pre-check for a fast, specific message; the server remains
    // the authority and re-validates type and size on arrival.
    if (file.size > MAX_REFERENCE_BYTES) {
      setImageError(`That image is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_REFERENCE_BYTES)}.`);
      setFileMeta(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (file.type && !file.type.startsWith('image/')) {
      setImageError('Please choose an image file (JPEG, PNG, WebP, GIF or AVIF).');
      setFileMeta(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    try {
      const url = await uploadCustomRequestImage(file, setUploadProgress);
      setImageUrl(url);
    } catch (err) {
      setImageError(err.message || 'The image could not be uploaded. Please try again.');
      setFileMeta(null);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const clearImage = () => {
    setImageUrl('');
    setImageError('');
    setFileMeta(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const isValidImageReference = (value) =>
    !value || /^https?:\/\//i.test(value) || value.startsWith('/uploads/');

  const heroRef = useRef(null);
  const stepRef = useRef(null);
  const successRef = useRef(null);

  // Hero entrance — skipped entirely under reduced motion.
  useEffect(() => {
    if (prefersReducedMotion() || !heroRef.current) return;
    gsap.fromTo(
      heroRef.current.querySelectorAll('[data-hero-item]'),
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power3.out', delay: 0.05 }
    );
  }, []);

  // Step transition — restrained (Level 2): a short rise and fade.
  useEffect(() => {
    if (submitted || !stepRef.current || prefersReducedMotion()) return;
    gsap.fromTo(
      stepRef.current,
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.32, ease: 'power2.out' }
    );
  }, [step, submitted]);

  // Success moment.
  useEffect(() => {
    if (!submitted || !successRef.current || prefersReducedMotion()) return;
    gsap.fromTo(
      successRef.current,
      { opacity: 0, scale: 0.96 },
      { opacity: 1, scale: 1, duration: 0.45, ease: 'power3.out' }
    );
  }, [submitted]);

  const stepTop = () => {
    if (heroRef.current) heroRef.current.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  };

  const goNext = () => {
    if (step < FLOW_STEPS.length - 1) {
      setStep((s) => s + 1);
      stepTop();
    }
  };

  const goBack = () => {
    if (step > 0) {
      setStep((s) => s - 1);
      stepTop();
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // IMPLICIT-SUBMIT GUARD (Phase 4). The step navigation renders the primary
    // action in the same tree position, so React REUSES that DOM node while the
    // click's default action is still pending: the button the customer clicked
    // as `type="button"` becomes `type="submit"` mid-click and the browser then
    // submits the form. Pressing "Continue" on the reference step therefore ran
    // the submit handler — an anonymous visitor was thrown to /login and lost
    // the brief they had just written, and a signed-in customer saw a "choose
    // the shop" error before the shop step had even rendered. A submit is only
    // ever valid on the review step (the buttons below also carry distinct
    // keys, so the node is replaced rather than mutated).
    if (step < FLOW_STEPS.length - 1) return;

    if (!getActiveCustomerId()) {
      navigate('/login', { state: { from: '/custom-request' } });
      return;
    }
    if (description.trim().length < 10) {
      setError('Please describe your idea in at least 10 characters.');
      setStep(0);
      return;
    }
    if (!isValidImageReference(imageUrl.trim())) {
      setError('The reference image link must start with http:// or https:// — or upload a file instead.');
      setStep(1);
      return;
    }
    if (!effectiveShopSlug && shops.length > 0) {
      setError('Please choose the shop that should make your gift.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const created = await createCustomRequest({
        description: description.trim(),
        occasion,
        budget,
        colors,
        desiredDate,
        imageUrl: imageUrl.trim(),
        // The product the customer is customising, if any. The server loads
        // this product and takes the workspace from it — never from the client.
        ...(contextProduct ? { productId: contextProduct.slug || contextProduct.id } : {}),
        // The chosen shop (a lookup key the server resolves and validates).
        ...(effectiveShopSlug ? { shopSlug: effectiveShopSlug } : {}),
      });
      setCreatedRequestId(created?._id || created?.id || null);
      setSubmitted(true);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // The review step states exactly what will be sent, and lists only the
  // answers the customer actually gave.
  const reviewRows = [
    { label: 'The piece', value: description.trim() },
    { label: 'Occasion', value: occasion },
    { label: 'Budget', value: budget },
    { label: 'Palette', value: colors.trim() },
    { label: 'Needed by', value: desiredDate },
  ].filter((row) => row.value);

  const shopLabel = effectiveShopName || effectiveShopSlug;

  if (submitted) {
    return (
      <div className="w-full bg-[var(--color-surface-bg)] min-h-screen flex items-center justify-center px-4">
        <div ref={successRef} className="max-w-lg w-full text-center space-y-6 bg-[var(--color-surface-lowest)] rounded-3xl p-10 border border-[var(--color-botanical-border)] shadow-lg">
          <div className="w-16 h-16 rounded-full bg-[var(--color-botanical-sage-light)]/50 flex items-center justify-center mx-auto">
            <CheckCircle className="w-8 h-8 text-[var(--color-botanical-sage)]" aria-hidden="true" />
          </div>
          <h1 className="font-serif text-[28px] text-[var(--color-botanical-primary)]">Request Received</h1>
          <p className="text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">
            {contextProduct
              ? `Thank you — our studio will review your custom version of ${contextProduct.name} and get back to you within 1–2 business days.`
              : 'Thank you — our studio will review your custom creation request and get back to you within 1–2 business days.'}
          </p>
          {effectiveShopName && (
            <p className="text-[13px] text-[var(--color-botanical-subtle)]">
              Requested from <span className="font-semibold text-[var(--color-botanical-primary)]">{effectiveShopName}</span>
            </p>
          )}
          <p className="text-[13px] text-[var(--color-botanical-subtle)]">
            Track its progress any time from My Account.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            {createdRequestId && (
              <Link
                to={`/account/requests/${createdRequestId}`}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
              >
                <Eye className="w-4 h-4" aria-hidden="true" /> View Your Request
              </Link>
            )}
            <Link to="/shop" className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors">
              Browse Gifts
            </Link>
            <Link to="/account" className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors">
              My Account
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const currentStep = FLOW_STEPS[step];
  const chipIdle = 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] hover:border-[var(--color-border-strong)]';

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      {/* ═══ EDITORIAL HERO ═══ */}
      <div ref={heroRef} className="relative overflow-hidden pt-10 lg:pt-16 pb-8 lg:pb-12">
        <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full bg-[var(--color-badge-bg)]/20 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 -left-16 w-64 h-64 rounded-full bg-[var(--color-botanical-sage-light)]/15 blur-3xl pointer-events-none" />

        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <Link data-hero-item to="/shop" className="inline-flex items-center gap-1.5 py-1.5 text-[12px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] mb-6 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> Back to Shop
          </Link>

          <div className="text-center max-w-xl mx-auto space-y-3">
            <div data-hero-item className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--color-badge-bg)]/50 text-[var(--color-badge-fg)] text-[11px] font-bold uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Custom Request</span>
            </div>
            <h1 data-hero-item className="font-serif text-[34px] sm:text-[46px] lg:text-[54px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.1]">
              Have Something Specific in Mind?
            </h1>
            <p data-hero-item className="text-[15px] sm:text-[16px] text-[var(--color-botanical-muted)] leading-relaxed max-w-lg mx-auto">
              {contextProduct
                ? 'Tell us how you would like this piece made for you, and our studio will prepare a custom quote.'
                : "Describe the gift you're envisioning and our studio will prepare a custom quote for you."}
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
        {/* ── Compact progress rail ─────────────────────────────────────
            Three questions, not a twelve-field form. A completed step is
            re-openable so an earlier answer can always be corrected. */}
        <div className="mb-6">
          <ol className="flex items-center gap-1 sm:gap-2 list-none p-0">
            {FLOW_STEPS.map((s, i) => {
              const active = i === step;
              const done = i < step;
              const reachable = i <= step;
              return (
                <li key={s.key} className="flex-1">
                  <button
                    type="button"
                    onClick={() => reachable && setStep(i)}
                    aria-current={active ? 'step' : undefined}
                    aria-label={`Step ${i + 1}: ${s.label}${done ? ' (done)' : ''}`}
                    disabled={!reachable}
                    className={`w-full flex items-center gap-2 rounded-2xl px-3 py-2 border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${
                      active
                        ? 'border-[var(--color-btn)] bg-[var(--color-surface-lowest)]'
                        : reachable
                        ? 'border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)]/60 hover:bg-[var(--color-surface-lowest)]'
                        : 'border-[var(--color-botanical-border)] bg-[var(--color-surface-low)]/40 cursor-default'
                    }`}
                  >
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 border ${
                        active
                          ? 'bg-[var(--color-btn)] text-white border-[var(--color-btn)]'
                          : done
                          ? 'bg-[var(--color-botanical-sage-light)] text-[var(--color-botanical-primary)] border-[var(--color-botanical-border)]'
                          : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-subtle)] border-[var(--color-botanical-border)]'
                      }`}
                    >
                      {done ? <Check className="w-3 h-3" aria-hidden="true" /> : i + 1}
                    </span>
                    <span className={`text-[12px] font-semibold truncate hidden sm:inline ${active ? 'text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-subtle)]'}`}>
                      {s.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="sr-only" role="status" aria-live="polite">
            Step {step + 1} of {FLOW_STEPS.length}: {currentStep.label}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6 sm:p-8 shadow-sm space-y-6">
          {/* Product context — only when the customer started from a product */}
          {contextProduct && (
            <div className="flex items-start gap-4 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] p-4">
              <img
                src={(contextProduct.images && contextProduct.images[0]) || contextProduct.image}
                alt={contextProduct.name}
                className="w-16 h-16 rounded-xl object-cover shrink-0 bg-[var(--color-surface-lowest)]"
                loading="lazy"
                decoding="async"
              />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Customising</p>
                <p className="font-serif text-[17px] text-[var(--color-botanical-primary)] leading-snug">{contextProduct.name}</p>
                <p className="text-[12px] text-[var(--color-botanical-muted)] mt-0.5">
                  We&apos;ll keep this piece in mind. Want something else entirely?
                </p>
                <button
                  type="button"
                  onClick={clearProductContext}
                  className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-accent)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                  Remove and describe a general request
                </button>
              </div>
            </div>
          )}

          <div ref={stepRef} className="space-y-6">
            {/* ═══ STEP 1 — the idea ═══ */}
            {step === 0 && (
              <>
                <header>
                  <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
                    Step 1 of {FLOW_STEPS.length}
                  </p>
                  <h2 className="font-serif text-[22px] sm:text-[26px] text-[var(--color-botanical-primary)] font-normal mt-1">
                    Tell us what you need
                  </h2>
                </header>

                <div>
                  <label htmlFor="cr-desc" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                    Describe Your Idea *
                  </label>
                  <textarea
                    id="cr-desc"
                    rows={5}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Tell us about the gift you'd like — what it should feel like, who it's for, any references or ideas…"
                    className="w-full p-3 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] resize-none transition-shadow"
                    aria-describedby="cr-desc-help"
                  />
                  <p id="cr-desc-help" className={`text-[11px] mt-1 ${description.length > 0 && description.trim().length < 10 ? 'text-[var(--color-danger)]' : 'text-[var(--color-botanical-subtle)]'}`}>
                    {description.length} characters{description.length > 0 && description.trim().length < 10 ? ' — at least 10 needed' : ''}
                  </p>
                </div>

                <div>
                  <span className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-2">Occasion</span>
                  <div className="flex flex-wrap gap-2">
                    {OCCASIONS.map((occ) => (
                      <button
                        key={occ}
                        type="button"
                        aria-pressed={occasion === occ}
                        onClick={() => setOccasion(occ === occasion ? '' : occ)}
                        className={`px-3 py-1.5 rounded-full border text-[12px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${
                          occasion === occ ? 'bg-[var(--color-btn)] text-white border-[var(--color-btn)]' : chipIdle
                        }`}
                      >
                        {occ}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-2">Budget Range</span>
                  <div className="flex flex-wrap gap-2">
                    {BUDGETS.map((b) => (
                      <button
                        key={b}
                        type="button"
                        aria-pressed={budget === b}
                        onClick={() => setBudget(b === budget ? '' : b)}
                        className={`px-3 py-1.5 rounded-full border text-[12px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${
                          budget === b ? 'bg-[var(--color-btn)] text-white border-[var(--color-btn)]' : chipIdle
                        }`}
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ═══ STEP 2 — reference & details ═══ */}
            {step === 1 && (
              <>
                <header>
                  <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
                    Step 2 of {FLOW_STEPS.length}
                  </p>
                  <h2 className="font-serif text-[22px] sm:text-[26px] text-[var(--color-botanical-primary)] font-normal mt-1">
                    Add a reference <span className="text-[var(--color-botanical-subtle)] text-[16px]">(optional)</span>
                  </h2>
                  <p className="text-[13px] text-[var(--color-botanical-muted)] mt-1">
                    Anything you can share helps our studio match your vision. Skip it freely.
                  </p>
                </header>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="cr-colors" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                      Preferred Colors
                    </label>
                    <input
                      id="cr-colors"
                      type="text"
                      value={colors}
                      onChange={(e) => setColors(e.target.value)}
                      placeholder="e.g. Dusty rose, sage, cream"
                      className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] transition-shadow"
                    />
                  </div>
                  <div>
                    <label htmlFor="cr-date" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                      Desired Date
                    </label>
                    <input
                      id="cr-date"
                      type="date"
                      value={desiredDate}
                      onChange={(e) => setDesiredDate(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] transition-shadow"
                    />
                  </div>
                </div>

                {/* Reference image — one drop zone, two honest paths. */}
                <div>
                  <span className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                    Reference Image (optional)
                  </span>

                  <div
                    onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragActive(true); }}
                    onDragLeave={() => setDragActive(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragActive(false);
                      if (uploading) return;
                      handleImageFile(e.dataTransfer?.files && e.dataTransfer.files[0]);
                    }}
                    className={`rounded-2xl border-2 border-dashed p-5 text-center transition-colors focus-within:ring-2 focus-within:ring-[var(--color-focus)] focus-within:ring-offset-2 ${
                      dragActive
                        ? 'border-[var(--color-accent)] bg-[var(--color-surface-low)]'
                        : 'border-[var(--color-botanical-border)] bg-[var(--color-surface-low)]/50'
                    }`}
                  >
                    {/* The control lives INSIDE the zone so its focus ring is
                        drawn on the whole drop target — a keyboard user
                        tabbing to "browse your files" sees where they are. */}
                    <input
                      ref={fileInputRef}
                      id="cr-file"
                      type="file"
                      accept={ACCEPTED_IMAGE_TYPES}
                      className="sr-only"
                      onChange={(e) => handleImageFile(e.target.files && e.target.files[0])}
                    />
                    {uploading ? (
                      <div className="space-y-2.5" role="status" aria-live="polite">
                        <p className="flex items-center justify-center gap-2 text-[13px] font-semibold text-[var(--color-botanical-primary)]">
                          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                          Uploading {fileMeta?.name ? fileMeta.name : 'your image'}… {uploadProgress}%
                        </p>
                        <div className="max-w-xs mx-auto h-1.5 rounded-full bg-[var(--color-surface-high)] overflow-hidden">
                          <div
                            className="h-full bg-[var(--color-accent)] transition-[width] duration-200"
                            style={{ width: `${uploadProgress}%` }}
                          />
                        </div>
                        {fileMeta?.size ? (
                          <p className="text-[11px] text-[var(--color-botanical-subtle)]">{formatBytes(fileMeta.size)}</p>
                        ) : null}
                      </div>
                    ) : imageUrl ? (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-center gap-2 text-[13px] font-semibold text-[var(--color-botanical-sage)]">
                          <CheckCircle className="w-4 h-4" aria-hidden="true" />
                          Reference added
                        </div>
                        <ReferenceImage
                          src={imageUrl.trim()}
                          alt="Your reference image"
                          size="sm"
                          emptyLabel="No reference image provided."
                        />
                        {fileMeta && (
                          <p className="flex items-center justify-center gap-1.5 text-[11px] text-[var(--color-botanical-subtle)]">
                            <FileImage className="w-3.5 h-3.5" aria-hidden="true" />
                            <span className="truncate max-w-[16rem]">{fileMeta.name}</span>
                            <span>· {formatBytes(fileMeta.size)}</span>
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={clearImage}
                          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-accent)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded px-1"
                        >
                          <X className="w-3.5 h-3.5" aria-hidden="true" />
                          Remove image
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <UploadCloud className="w-6 h-6 mx-auto text-[var(--color-botanical-subtle)]" aria-hidden="true" />
                        <p className="text-[13px] text-[var(--color-botanical-muted)]">
                          Drop an image here, or{' '}
                          <label htmlFor="cr-file" className="font-semibold text-[var(--color-accent)] underline cursor-pointer">
                            browse your files
                          </label>
                        </p>
                        <p className="text-[11px] text-[var(--color-botanical-subtle)]">
                          JPEG, PNG, WebP, GIF or AVIF · up to {formatBytes(MAX_REFERENCE_BYTES)}
                        </p>
                      </div>
                    )}
                  </div>

                  {imageError && (
                    <p role="alert" className="mt-2 flex items-start gap-1.5 text-[12px] text-[var(--color-danger)]">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                      <span>{imageError}</span>
                    </p>
                  )}

                  <div className="flex items-center gap-2 mt-3">
                    <ImagePlus className="w-4 h-4 text-[var(--color-botanical-subtle)] shrink-0" aria-hidden="true" />
                    <input
                      type="text"
                      value={imageUrl}
                      onChange={(e) => { setImageUrl(e.target.value); setFileMeta(null); setImageError(''); }}
                      placeholder="…or paste an image link (https://…)"
                      aria-label="Or paste a reference image link"
                      className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] transition-shadow"
                    />
                  </div>
                </div>
              </>
            )}

            {/* ═══ STEP 3 — review & send ═══ */}
            {step === 2 && (
              <>
                <header>
                  <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
                    Step 3 of {FLOW_STEPS.length}
                  </p>
                  <h2 className="font-serif text-[22px] sm:text-[26px] text-[var(--color-botanical-primary)] font-normal mt-1">
                    Review your request
                  </h2>
                </header>

                {/* Who will make it. A product commission is locked to the
                    product's shop; a standalone request names one. */}
                {productShopSlug ? (
                  <div className="flex items-start gap-3 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] p-4">
                    <Store className="w-5 h-5 text-[var(--color-accent)] shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Fulfilled by</p>
                      <p className="text-[14px] font-semibold text-[var(--color-botanical-primary)]">{shopLabel}</p>
                      <p className="text-[12px] text-[var(--color-botanical-muted)] mt-0.5">
                        This commission follows the shop that makes the piece.
                      </p>
                    </div>
                  </div>
                ) : shops.length > 0 ? (
                  <div className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-4">
                    <label htmlFor="cr-shop" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                      Choose the Shop *
                    </label>
                    <select
                      id="cr-shop"
                      value={shopSlug}
                      onChange={(e) => setShopSlug(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-lowest)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                    >
                      <option value="">Choose the shop that should make your gift…</option>
                      {shops.map((shop) => (
                        <option key={shop.slug} value={shop.slug}>
                          {shop.displayName}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1.5">
                      {effectiveShopName
                        ? `Your request goes to ${effectiveShopName}, who will quote and craft it.`
                        : 'Every custom request is handled by one shop.'}
                    </p>
                  </div>
                ) : null}

                <dl className="rounded-2xl border border-[var(--color-botanical-border)] divide-y divide-[var(--color-divider)] overflow-hidden m-0">
                  {reviewRows.map((row) => (
                    <div key={row.label} className="grid grid-cols-1 sm:grid-cols-[9rem_1fr] gap-1 sm:gap-3 px-4 py-3 bg-[var(--color-surface-low)]/40">
                      <dt className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">{row.label}</dt>
                      <dd className="text-[13px] text-[var(--color-botanical-text)] m-0 whitespace-pre-line break-words">{row.value}</dd>
                    </div>
                  ))}
                  <div className="grid grid-cols-1 sm:grid-cols-[9rem_1fr] gap-1 sm:gap-3 px-4 py-3 bg-[var(--color-surface-low)]/40">
                    <dt className="text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Reference</dt>
                    <dd className="text-[13px] m-0">
                      {imageUrl.trim() ? (
                        <ReferenceImage src={imageUrl.trim()} alt="Your reference image" size="sm" emptyLabel="—" />
                      ) : (
                        <span className="text-[var(--color-botanical-muted)]">None — that&apos;s fine</span>
                      )}
                    </dd>
                  </div>
                </dl>

                <p className="text-[12px] text-[var(--color-botanical-muted)] leading-relaxed">
                  No payment is taken now. Our studio reads your request and replies with a quote within 1–2 business days.
                </p>
              </>
            )}
          </div>

          {error && (
            <div role="alert" className="px-4 py-3 rounded-xl bg-[var(--color-danger-soft-bg)] border border-[var(--color-danger-soft-border)] text-[13px] text-[var(--color-danger-soft-fg)]">
              {error}
            </div>
          )}

          {/* ── Step navigation ── */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={goBack}
              disabled={step === 0}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed touch-target focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              Back
            </button>

            {step < FLOW_STEPS.length - 1 ? (
              <button
                key="cr-continue"
                type="button"
                onClick={goNext}
                disabled={step === 0 && description.trim().length < 10}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors shadow-md disabled:opacity-40 disabled:cursor-not-allowed touch-target focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2"
              >
                Continue
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </button>
            ) : (
              <button
                key="cr-submit"
                type="submit"
                disabled={submitting || description.trim().length < 10}
                className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors shadow-md disabled:opacity-40 disabled:cursor-not-allowed touch-target focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2"
              >
                {submitting ? (
                  <>
                    <Clock className="w-4 h-4 animate-spin" aria-hidden="true" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" aria-hidden="true" />
                    Submit Request
                  </>
                )}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
