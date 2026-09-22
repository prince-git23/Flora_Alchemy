import React, { useEffect, useMemo, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, RotateCcw, ShoppingBag, Heart, Sparkles, Check } from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';
import { getProducts } from '../services/productService.js';
import { subscribeStore } from '../services/dataStore.js';
import {
  RECIPIENT_OPTIONS,
  OCCASION_OPTIONS,
  BUDGET_OPTIONS,
  STYLE_OPTIONS,
  PERSONALIZATION_OPTIONS,
  STEP_LABELS,
  optionLabel,
  recommendGifts,
} from '../services/giftFinderService.js';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const STEPS = [
  { key: 'recipient', title: 'Who are you gifting?', hint: 'We shape the shortlist around them.', options: RECIPIENT_OPTIONS },
  { key: 'occasion', title: "What's the occasion?", hint: 'Helps us set the tone of the gift.', options: OCCASION_OPTIONS },
  { key: 'budget', title: "What's your budget?", hint: 'Every recommendation will fit inside it.', options: BUDGET_OPTIONS },
  { key: 'style', title: "What's their style?", hint: 'Palette and mood, not a price bracket.', options: STYLE_OPTIONS },
  { key: 'personalization', title: 'How personal should it be?', hint: 'From ready-to-gift to fully bespoke.', options: PERSONALIZATION_OPTIONS },
];

const EMPTY_ANSWERS = { recipient: '', occasion: '', budget: '', style: '', personalization: '' };

function GiftResultCard({ result, index }) {
  const { addItemToCart, toggleWishlist, isWishlisted } = useStore();
  const { product, reasons, attributes } = result;
  const saved = isWishlisted(product.id);

  return (
    <article
      className="group flex flex-col bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border-light)] shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] hover:shadow-[0_12px_32px_-4px_rgba(46,36,30,0.09)] transition-all duration-400 overflow-hidden"
    >
      <div className="relative aspect-[4/3] bg-[var(--color-surface-low)] overflow-hidden">
        <Link to={`/product/${product.id}`} className="block w-full h-full">
          <img
            src={product.images ? product.images[0] : product.image}
            alt={product.name}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            loading="lazy"
          />
        </Link>
        <span className="absolute top-3 left-3 px-2.5 py-0.5 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-sm text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-primary)]">
          {product.categoryLabel || product.category}
        </span>
        <button
          type="button"
          onClick={() => toggleWishlist(product)}
          title={saved ? 'Remove from Saved Gifts' : 'Save to Saved Gifts'}
          aria-label={saved ? 'Remove from Saved Gifts' : 'Save to Saved Gifts'}
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-sm flex items-center justify-center text-[var(--color-botanical-muted)] hover:text-[var(--color-accent)] shadow-sm transition-all duration-200"
        >
          <Heart className={`w-4 h-4 transition-all duration-200 ${saved ? 'fill-[var(--color-accent)] text-[var(--color-accent)] scale-110' : ''}`} aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 flex flex-col justify-between p-5 space-y-4">
        <div className="space-y-2">
          <Link to={`/product/${product.id}`}>
            <h3 className="font-serif text-[19px] text-[var(--color-botanical-primary)] leading-snug font-medium hover:text-[var(--color-accent)] transition-colors">
              {product.name}
            </h3>
          </Link>
          <p className="text-[17px] font-bold text-[var(--color-botanical-primary)]">₹{Number(product.price).toLocaleString('en-IN')}</p>
          {reasons.length > 0 && (
            <ul className="space-y-1 pt-1">
              {reasons.slice(0, 2).map((reason) => (
                <li key={reason} className="flex items-start gap-1.5 text-[12.5px] text-[var(--color-botanical-muted)] leading-relaxed">
                  <Check className="w-3.5 h-3.5 text-[var(--color-botanical-sage)] mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="pt-3 border-t border-[var(--color-botanical-border-light)] flex items-center justify-between gap-2">
          <Link
            to={`/product/${product.id}`}
            className="text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:text-[var(--color-accent)] transition-colors"
          >
            View Gift →
          </Link>
          <div className="flex items-center gap-2">
            {attributes.personalization !== 'simple' && (
              <Link
                to="/custom-gifts"
                className="px-3 py-1.5 rounded-full bg-[var(--color-surface-low)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] transition-colors"
              >
                Customize
              </Link>
            )}
            <button
              type="button"
              onClick={() => addItemToCart(product)}
              className="px-3.5 py-1.5 rounded-full bg-[var(--color-btn)] text-white hover:bg-[var(--color-btn-hover)] transition-all duration-200 text-[12px] font-semibold flex items-center gap-1.5 shadow-sm active:translate-y-0.5"
            >
              <ShoppingBag className="w-3.5 h-3.5" aria-hidden="true" />
              Add to Bag
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

export default function GiftFinderPage() {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState(EMPTY_ANSWERS);
  const [showResults, setShowResults] = useState(false);
  const [relaxed, setRelaxed] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => subscribeStore(() => setTick((n) => n + 1)), []);

  const catalogue = useMemo(() => getProducts(), [tick]);

  const current = STEPS[step];
  const heroRef = useRef(null);
  const wizardRef = useRef(null);
  const resultsGridRef = useRef(null);

  // GSAP hero entrance
  useEffect(() => {
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED || !heroRef.current) return;

    gsap.fromTo(heroRef.current.children,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power3.out', delay: 0.1 }
    );
  }, []);

  // GSAP wizard step transition
  useEffect(() => {
    if (!wizardRef.current || showResults) return;
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return;

    gsap.fromTo(wizardRef.current,
      { opacity: 0, x: 20 },
      { opacity: 1, x: 0, duration: 0.35, ease: 'power2.out' }
    );
  }, [step, showResults]);

  // GSAP results stagger
  useEffect(() => {
    if (!showResults || !resultsGridRef.current) return;
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return;

    const cards = resultsGridRef.current.querySelectorAll('article');
    if (cards.length === 0) return;

    gsap.fromTo(cards,
      { opacity: 0, y: 25, scale: 0.97 },
      { opacity: 1, y: 0, scale: 1, duration: 0.45, stagger: 0.06, ease: 'power2.out' }
    );
  }, [showResults, answers]);

  const scrollTop = () => {
    if (heroRef.current) heroRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const select = (key, value) => setAnswers((a) => ({ ...a, [key]: value }));

  const goNext = () => {
    if (!answers[current.key]) return;
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
      scrollTop();
    } else {
      setShowResults(true);
      setRelaxed(false);
      scrollTop();
    }
  };

  const goBack = () => {
    if (showResults) {
      setShowResults(false);
      scrollTop();
      return;
    }
    if (step > 0) {
      setStep((s) => s - 1);
      scrollTop();
    }
  };

  const restart = () => {
    setAnswers(EMPTY_ANSWERS);
    setStep(0);
    setShowResults(false);
    setRelaxed(false);
    scrollTop();
  };

  const jumpToStep = (i) => {
    if (i <= step || showResults) {
      setStep(i);
      setShowResults(false);
      scrollTop();
    }
  };

  const { results, relaxed: isRelaxed, hadBudgetMatch } = recommendGifts(answers, catalogue, {
    limit: 6,
    relaxBudget: relaxed,
  });

  const summary = [
    optionLabel('recipient', answers.recipient),
    optionLabel('occasion', answers.occasion),
    optionLabel('budget', answers.budget),
    optionLabel('style', answers.style),
    optionLabel('personalization', answers.personalization),
  ].filter(Boolean);

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      {/* ═══ EDITORIAL HERO ═══ */}
      <div ref={heroRef} className="relative overflow-hidden pt-8 lg:pt-16 pb-6 lg:pb-12" style={{ perspective: '1200px' }}>
        <div className="absolute -top-20 -left-20 w-80 h-80 rounded-full bg-[var(--color-badge-bg)]/20 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 -right-16 w-64 h-64 rounded-full bg-[var(--color-botanical-sage-light)]/15 blur-3xl pointer-events-none" />

        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center max-w-2xl mx-auto space-y-3">
            <div className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-[var(--color-badge-bg)]/50 text-[var(--color-badge-fg)] text-[11px] font-bold uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              <span>The Gift Finder</span>
            </div>
            <h1 className="font-serif text-[30px] sm:text-[38px] md:text-[52px] lg:text-[60px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.1]">
              Let&apos;s find the right gift.
            </h1>
            <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed max-w-xl mx-auto">
              Five quick questions. We&apos;ll shortlist handcrafted pieces from our live atelier catalogue — with a reason for each pick.
            </p>
          </div>
        </div>
      </div>          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-12 lg:pb-16">
        {/* Progress */}
        <div className="mb-8">
          <div className="flex items-center justify-between gap-2 max-w-3xl mx-auto">
            {STEP_LABELS.map((label, i) => {
              const done = showResults || i < step;
              const active = !showResults && i === step;
              const reachable = showResults || i <= step;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => reachable && jumpToStep(i)}
                  aria-current={active ? 'step' : undefined}
                  disabled={!reachable}
                  className={`flex-1 flex flex-col items-center gap-1.5 group ${reachable ? 'cursor-pointer' : 'cursor-default'}`}
                >
                  <span
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold border transition-all duration-200 ${
                      active
                        ? 'bg-[var(--color-btn)] text-white border-[var(--color-btn)] shadow-sm'
                        : done
                        ? 'bg-[var(--color-botanical-sage-light)] text-[#3c4a36] border-[#d8e7cd]'
                        : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-subtle)] border-[var(--color-botanical-border)]'
                    }`}
                  >
                    {done ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : i + 1}
                  </span>
                  <span className={`text-[10px] uppercase tracking-wider font-bold truncate max-w-full hidden xs:inline sm:inline ${active ? 'text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-subtle)]'}`}>
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="max-w-3xl mx-auto mt-4 h-1 rounded-full bg-[#e5e2dd] overflow-hidden">
            <div
              className="h-full bg-[#964735] transition-all duration-500"
              style={{ width: `${((showResults ? 5 : step) / 5) * 100}%` }}
            />
          </div>
        </div>

        {/* Wizard */}
        {!showResults && (
          <div ref={wizardRef} className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] shadow-sm p-6 sm:p-10">
            <div className="flex items-start justify-between gap-4 mb-6">
              <div>
                <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
                  Step {step + 1} of 5
                </p>
                <h2 className="font-serif text-[26px] sm:text-[30px] text-[var(--color-botanical-primary)] font-normal mt-1">{current.title}</h2>
                <p className="text-[13.5px] text-[var(--color-botanical-muted)]">{current.hint}</p>
              </div>
              {summary.length > 0 && (
                <button
                  type="button"
                  onClick={restart}
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-accent)] transition-colors shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Restart
                </button>
              )}
            </div>

            <div
              role="group"
              aria-label={current.title}
              className={`grid gap-3 ${current.options.length > 6 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-3'}`}
            >
              {current.options.map((option) => {
                const selected = answers[current.key] === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => select(current.key, option.id)}
                    className={`flex flex-col items-start gap-1 p-4 rounded-2xl border text-left transition-all duration-200 ${
                      selected
                        ? 'border-[var(--color-btn)] bg-[var(--color-surface-low)] shadow-sm'
                        : 'border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] hover:border-[#964735] hover:shadow-sm'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      {option.icon && <span className="text-[18px]" aria-hidden="true">{option.icon}</span>}
                      <span className={`text-[13.5px] font-semibold ${selected ? 'text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>
                        {option.label}
                      </span>
                      {selected && <Check className="w-3.5 h-3.5 text-[var(--color-accent)] ml-auto" aria-hidden="true" />}
                    </span>
                    {option.description && (
                      <span className="text-[12px] text-[var(--color-botanical-subtle)]">{option.description}</span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-3 pt-8">
              <button
                type="button"
                onClick={goBack}
                disabled={step === 0}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed touch-target"
              >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                Back
              </button>

              <button
                type="button"
                onClick={goNext}
                disabled={!answers[current.key]}
                className="inline-flex items-center gap-2 px-7 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed touch-target"
              >
                {step < STEPS.length - 1 ? 'Continue' : 'See My Gifts'}
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        {/* Results */}
        {showResults && (
          <div className="space-y-8">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div className="space-y-1">
                <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Your shortlist</p>
                <h2 className="font-serif text-[28px] sm:text-[34px] text-[var(--color-botanical-primary)] font-normal">
                  Here are a few gifts we&apos;d choose.
                </h2>
                {summary.length > 0 && (
                  <p className="text-[13px] text-[var(--color-botanical-muted)]">
                    For a <strong className="text-[var(--color-botanical-primary)]">{summary.join(' · ')}</strong>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={goBack}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors bg-[var(--color-surface-lowest)] touch-target"
              >
                  <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                  Refine Answers
                </button>
                <button
                  type="button"
                  onClick={restart}
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-accent)] transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Start Again
                </button>
              </div>
            </div>

            {results.length > 0 ? (
              <>
                {isRelaxed && (
                  <div className="rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] p-4 text-[13px] text-[var(--color-botanical-muted)]">
                    Nothing in the catalogue fits <strong className="text-[var(--color-botanical-primary)]">{optionLabel('budget', answers.budget)}</strong> exactly. These handcrafted pieces sit just outside it — shown so you can decide whether to stretch the budget.
                  </div>
                )}
                {!isRelaxed && answers.occasion && !results.some((r) => r.attributes.occasions.includes(answers.occasion)) && (
                  <div className="rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] p-4 text-[13px] text-[var(--color-botanical-muted)]">
                    Nothing inside <strong className="text-[var(--color-botanical-primary)]">{optionLabel('budget', answers.budget)}</strong> matches{' '}
                    <strong className="text-[var(--color-botanical-primary)]">{optionLabel('occasion', answers.occasion)}</strong> exactly — these are the handcrafted pieces that fit your budget, so you can decide if the occasion or the price is the one to flex.
                  </div>
                )}
                <div ref={resultsGridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {results.map((result, i) => (
                    <GiftResultCard key={result.product.id} result={result} index={i} />
                  ))}
                </div>
              </>
            ) : (
              <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-10 sm:p-14 text-center border border-[var(--color-botanical-border)] max-w-xl mx-auto space-y-4">
                <div className="w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-3xl" aria-hidden="true">
                  🌱
                </div>
                <h3 className="font-serif text-[24px] text-[var(--color-botanical-primary)]">We couldn&apos;t find an exact match yet.</h3>
                <p className="text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">
                  {!hadBudgetMatch
                    ? `No handcrafted piece currently sits inside ${optionLabel('budget', answers.budget)}. You can widen the budget or browse the full catalogue.`
                    : 'Try a different combination of answers, or browse the full catalogue.'}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                  {!hadBudgetMatch && (
                    <button
                      type="button"
                      onClick={() => setRelaxed(true)}
                      className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
                    >
                      Show closest gifts above budget
                    </button>
                  )}
                  <Link
                    to="/shop"
                    className="px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors"
                  >
                    Browse All Gifts
                  </Link>
                  <button
                    type="button"
                    onClick={() => { setShowResults(false); setStep(2); scrollTop(); }}
                    className="px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors"
                  >
                    Adjust Budget
                  </button>
                  <button
                    type="button"
                    onClick={restart}
                    className="px-6 py-2.5 rounded-full text-[13px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-accent)] transition-colors"
                  >
                    Start Over
                  </button>
                </div>
              </div>
            )}

            {/* Custom studio prompt */}
            <div className="rounded-3xl bg-[var(--color-btn)] text-white p-8 sm:p-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
              <div className="space-y-2 max-w-xl">
                <span className="text-[11px] uppercase font-bold tracking-widest text-[#ffdad3]">Nothing quite right?</span>
                <h3 className="font-serif text-[26px] sm:text-[30px] font-normal">Build it from scratch in the Custom Gift Studio.</h3>
                <p className="text-[14px] text-[#d4c3ba] leading-relaxed">
                  Choose the base, palette, ribbon and handwritten note — our artisans handcraft it to order.
                </p>
              </div>
              <Link
                to="/custom-gifts"
                className="px-8 py-3.5 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-lowest)] text-[13px] font-semibold transition-all duration-200 shrink-0 shadow-md hover:shadow-lg"
              >
                Create a Custom Gift
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
