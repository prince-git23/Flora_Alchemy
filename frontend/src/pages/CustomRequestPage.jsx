import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Send, ArrowLeft, Sparkles, CheckCircle, Clock, ImagePlus, X, UploadCloud, Loader2, Eye } from 'lucide-react';
import { getActiveCustomerId, getActiveCustomer } from '../services/customerService.js';
import { createCustomRequest, uploadCustomRequestImage } from '../services/customRequestService.js';
import ReferenceImage from '../components/ReferenceImage.jsx';
import { getProducts } from '../services/productService.js';
import { subscribeStore } from '../services/dataStore.js';
import { gsap } from 'gsap';

const OCCASIONS = ['Birthday', 'Anniversary', 'Wedding', 'Graduation', 'Thank You', 'Congratulations', 'Festival', 'Just Because', 'Other'];
const BUDGETS = ['Under ₹500', '₹500 – ₹1,000', '₹1,000 – ₹2,000', '₹2,000 – ₹5,000', '₹5,000+'];

export default function CustomRequestPage() {
  const user = getActiveCustomer();
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

  const [description, setDescription] = useState('');
  const [occasion, setOccasion] = useState('');
  const [budget, setBudget] = useState('');
  const [colors, setColors] = useState('');
  const [desiredDate, setDesiredDate] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [imageError, setImageError] = useState('');
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
    setUploading(true);
    setUploadProgress(0);
    try {
      const url = await uploadCustomRequestImage(file, setUploadProgress);
      setImageUrl(url);
    } catch (err) {
      setImageError(err.message || 'The image could not be uploaded. Please try again.');
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const clearImage = () => {
    setImageUrl('');
    setImageError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const isValidImageReference = (value) =>
    !value || /^https?:\/\//i.test(value) || value.startsWith('/uploads/');

  const heroRef = useRef(null);
  const formRef = useRef(null);
  const successRef = useRef(null);

  // GSAP hero entrance
  useEffect(() => {
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED || !heroRef.current) return;

    gsap.fromTo(heroRef.current.children,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power3.out', delay: 0.1 }
    );
  }, []);

  // GSAP form entrance
  useEffect(() => {
    if (!formRef.current || submitted) return;
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return;

    gsap.fromTo(formRef.current,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out', delay: 0.3 }
    );
  }, [submitted]);

  // GSAP success animation
  useEffect(() => {
    if (!submitted || !successRef.current) return;
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return;

    gsap.fromTo(successRef.current,
      { opacity: 0, scale: 0.95 },
      { opacity: 1, scale: 1, duration: 0.5, ease: 'power3.out' }
    );
  }, [submitted]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!getActiveCustomerId()) {
      navigate('/login', { state: { from: '/custom-request' } });
      return;
    }
    if (description.trim().length < 10) {
      setError('Please describe your idea in at least 10 characters.');
      return;
    }
    if (!isValidImageReference(imageUrl.trim())) {
      setError('The reference image link must start with http:// or https:// — or upload a file instead.');
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
      });
      setCreatedRequestId(created?._id || created?.id || null);
      setSubmitted(true);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="w-full bg-[var(--color-surface-bg)] min-h-screen flex items-center justify-center px-4">
        <div ref={successRef} className="max-w-lg w-full text-center space-y-6 bg-[var(--color-surface-lowest)] rounded-3xl p-10 border border-[var(--color-botanical-border)] shadow-lg">
          <div className="w-16 h-16 rounded-full bg-[var(--color-botanical-sage-light)]/50 flex items-center justify-center mx-auto">
            <CheckCircle className="w-8 h-8 text-[var(--color-botanical-sage)]" />
          </div>
          <h1 className="font-serif text-[28px] text-[var(--color-botanical-primary)]">Request Received</h1>
          <p className="text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">
            {contextProduct
              ? `Thank you — our studio will review your custom version of ${contextProduct.name} and get back to you within 1–2 business days.`
              : 'Thank you — our studio will review your custom creation request and get back to you within 1–2 business days.'}
          </p>
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

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      {/* ═══ EDITORIAL HERO ═══ */}
      <div ref={heroRef} className="relative overflow-hidden pt-10 lg:pt-16 pb-8 lg:pb-12" style={{ perspective: '1200px' }}>
        <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full bg-[var(--color-badge-bg)]/20 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 -left-16 w-64 h-64 rounded-full bg-[var(--color-botanical-sage-light)]/15 blur-3xl pointer-events-none" />

        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <Link to="/shop" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] mb-6 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Shop
          </Link>

          <div className="text-center max-w-xl mx-auto space-y-3">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--color-badge-bg)]/50 text-[var(--color-badge-fg)] text-[11px] font-bold uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Custom Request</span>
            </div>
            <h1 className="font-serif text-[38px] sm:text-[52px] lg:text-[60px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.1]">
              Have Something Specific in Mind?
            </h1>
            <p className="text-[15px] sm:text-[16px] text-[var(--color-botanical-muted)] leading-relaxed max-w-lg mx-auto">
              {contextProduct
                ? 'Tell us how you would like this piece made for you, and our studio will prepare a custom quote.'
                : "Describe the gift you're envisioning and our studio will prepare a custom quote for you."}
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
        <form ref={formRef} onSubmit={handleSubmit} className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6 sm:p-8 shadow-sm space-y-6">
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
                  className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                  Remove and describe a general request
                </button>
              </div>
            </div>
          )}

          {/* Description */}
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
              className="w-full p-3 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] resize-none transition-shadow"
              required
            />
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1">{description.length} characters</p>
          </div>

          {/* Occasion */}
          <div>
            <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-2">Occasion</label>
            <div className="flex flex-wrap gap-2">
              {OCCASIONS.map((occ) => (
                <button
                  key={occ}
                  type="button"
                  onClick={() => setOccasion(occ === occasion ? '' : occ)}
                  className={`px-3 py-1.5 rounded-full border text-[12px] font-semibold transition-all duration-200 ${
                    occasion === occ
                      ? 'bg-[var(--color-btn)] text-white border-[var(--color-btn)]'
                      : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] hover:border-[#80756f]'
                  }`}
                >
                  {occ}
                </button>
              ))}
            </div>
          </div>

          {/* Budget */}
          <div>
            <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-2">Budget Range</label>
            <div className="flex flex-wrap gap-2">
              {BUDGETS.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBudget(b === budget ? '' : b)}
                  className={`px-3 py-1.5 rounded-full border text-[12px] font-semibold transition-all duration-200 ${
                    budget === b
                      ? 'bg-[var(--color-btn)] text-white border-[var(--color-btn)]'
                      : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] hover:border-[#80756f]'
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          {/* Colors */}
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
              className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-shadow"
            />
          </div>

          {/* Desired Date */}
          <div>
            <label htmlFor="cr-date" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
              Desired Date
            </label>
            <input
              id="cr-date"
              type="date"
              value={desiredDate}
              onChange={(e) => setDesiredDate(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-shadow"
            />
          </div>

          {/* Reference Image — optional. Upload a file OR paste a link. */}
          <div>
            <label htmlFor="cr-image" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
              Reference Image (optional)
            </label>

            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                  className="hidden"
                  onChange={(e) => handleImageFile(e.target.files && e.target.files[0])}
                />
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-lowest)] transition-colors disabled:opacity-60"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      Uploading… {uploadProgress}%
                    </>
                  ) : (
                    <>
                      <UploadCloud className="w-4 h-4" aria-hidden="true" />
                      Upload an image
                    </>
                  )}
                </button>
                <span className="text-[11px] text-[var(--color-botanical-subtle)]">JPEG, PNG, WebP, GIF or AVIF · up to 5 MB</span>
              </div>
              <div className="flex items-center gap-2">
                <ImagePlus className="w-4 h-4 text-[var(--color-botanical-subtle)] shrink-0" aria-hidden="true" />
                <input
                  id="cr-image"
                  type="text"
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="…or paste an image link (https://…)"
                  className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] transition-shadow"
                />
              </div>

              {/* Preview of whatever reference will actually be submitted. */}
              {imageUrl.trim() ? (
                <div className="space-y-2">
                  <ReferenceImage
                    src={imageUrl.trim()}
                    alt="Your reference image"
                    size="sm"
                    emptyLabel="No reference image provided."
                  />
                  <button
                    type="button"
                    onClick={clearImage}
                    className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                    Remove image
                  </button>
                </div>
              ) : null}
            </div>

            {imageError && (
              <p className="mt-2 text-[12px] text-[#8a2a18]" role="alert">{imageError}</p>
            )}
            <p className="mt-1.5 text-[11px] text-[var(--color-botanical-subtle)]">
              A reference helps our studio match your vision — you can also skip this.
            </p>
          </div>

          {error && (
            <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-[13px] text-red-700">{error}</div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting || description.trim().length < 10}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full bg-[#964735] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover-alt)] transition-colors shadow-md disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <Clock className="w-4 h-4 animate-spin" />
                Submitting…
              </>
            ) : (
              <>
                <Send className="w-4 h-4" aria-hidden="true" />
                Submit Request
              </>
            )}
          </button>

          <p className="text-center text-[12px] text-[var(--color-botanical-subtle)]">
            No payment is taken now — our studio reviews your request and responds with a quote within 1–2 business days.
          </p>
        </form>
      </div>
    </div>
  );
}
