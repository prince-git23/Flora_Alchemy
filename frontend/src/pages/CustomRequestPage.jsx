import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Send, ArrowLeft, Sparkles, CheckCircle, Clock, ImagePlus } from 'lucide-react';
import { getActiveCustomerId, getActiveCustomer } from '../services/customerService.js';
import { createCustomRequest } from '../services/customRequestService.js';
import { gsap } from 'gsap';

const OCCASIONS = ['Birthday', 'Anniversary', 'Wedding', 'Graduation', 'Thank You', 'Congratulations', 'Festival', 'Just Because', 'Other'];
const BUDGETS = ['Under ₹500', '₹500 – ₹1,000', '₹1,000 – ₹2,000', '₹2,000 – ₹5,000', '₹5,000+'];

export default function CustomRequestPage() {
  const user = getActiveCustomer();
  const navigate = useNavigate();

  const [description, setDescription] = useState('');
  const [occasion, setOccasion] = useState('');
  const [budget, setBudget] = useState('');
  const [colors, setColors] = useState('');
  const [desiredDate, setDesiredDate] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

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
    setSubmitting(true);
    setError('');
    try {
      await createCustomRequest({ description: description.trim(), occasion, budget, colors, desiredDate, imageUrl });
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
          <div className="w-16 h-16 rounded-full bg-[#d8e7cd]/50 flex items-center justify-center mx-auto">
            <CheckCircle className="w-8 h-8 text-[#5b6d54]" />
          </div>
          <h1 className="font-serif text-[28px] text-[var(--color-botanical-primary)]">Request Received</h1>
          <p className="text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">
            Thank you — our team will review your custom creation request and get back to you within 1–2 business days.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <Link to="/shop" className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold hover:bg-[#964735] transition-colors">
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
        <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full bg-[#ffdad3]/20 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 -left-16 w-64 h-64 rounded-full bg-[#d8e7cd]/15 blur-3xl pointer-events-none" />

        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <Link to="/shop" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] mb-6 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Shop
          </Link>

          <div className="text-center max-w-xl mx-auto space-y-3">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#ffdad3]/50 text-[#964735] text-[11px] font-bold uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Custom Request</span>
            </div>
            <h1 className="font-serif text-[38px] sm:text-[52px] lg:text-[60px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.1]">
              Have Something Specific in Mind?
            </h1>
            <p className="text-[15px] sm:text-[16px] text-[var(--color-botanical-muted)] leading-relaxed max-w-lg mx-auto">
              Describe the gift you're envisioning and our team will create a custom quote for you.
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
        <form ref={formRef} onSubmit={handleSubmit} className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6 sm:p-8 shadow-sm space-y-6">
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
              className="w-full p-3 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] resize-none transition-shadow"
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
                      ? 'bg-[#180f0a] text-white border-[#180f0a]'
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
                      ? 'bg-[#180f0a] text-white border-[#180f0a]'
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
              className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow"
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
              className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow"
            />
          </div>

          {/* Image Reference */}
          <div>
            <label htmlFor="cr-image" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
              Inspiration Image URL (optional)
            </label>
            <div className="flex items-center gap-2">
              <ImagePlus className="w-4 h-4 text-[var(--color-botanical-subtle)] shrink-0" />
              <input
                id="cr-image"
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://..."
                className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow"
              />
            </div>
          </div>

          {error && (
            <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-[13px] text-red-700">{error}</div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting || description.trim().length < 10}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full bg-[#964735] text-white text-[13px] font-semibold hover:bg-[#180f0a] transition-colors shadow-md disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <Clock className="w-4 h-4 animate-spin" />
                Submitting…
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Request a Custom Creation
              </>
            )}
          </button>

          <p className="text-center text-[12px] text-[var(--color-botanical-subtle)]">
            We'll review your request and respond within 1–2 business days.
          </p>
        </form>
      </div>
    </div>
  );
}
