import React, { useEffect, useMemo, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, RotateCcw, Sparkles, Check } from 'lucide-react';
import { getProducts } from '../services/productService.js';
import { subscribeStore } from '../services/dataStore.js';
import ProductCard from '../components/ProductCard.jsx';
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
import { gsap, prefersReducedMotion } from '../lib/gsapSetup.js';

/**
 * PHASE 3 — the Gift Finder is a guided shopping experience, not a quiz.
 *
 * One decision per step, five large choices at most, a small progress rail, and
 * a shortlist built from the LIVE catalogue by the deterministic scorer in
 * `services/giftFinderService.js`. Nothing here invents a product, a price or a
 * reason: every "Matches:" label names a dimension the scorer actually matched.
 *
 * Step order follows how a gift is really thought about — who it is for, what
 * the moment is, how it should feel, what it may cost, how personal it should
 * be — and `STEP_LABELS` in the service is positional against STEPS below.
 *
 * Motion is Level 2–3 (Phase 1 rules): a hero stagger, a slide+fade between
 * steps, and a staggered reveal of the shortlist. Every effect is skipped
 * outright under `prefers-reduced-motion`, and the step transition never blocks
 * interaction.
 */
const STEPS = [
  { key: 'recipient', title: 'Who is this for?', hint: 'We shape the shortlist around them.', options: RECIPIENT_OPTIONS },
  { key: 'occasion', title: "What's the occasion?", hint: 'Helps us set the tone of the gift.', options: OCCASION_OPTIONS },
  { key: 'style', title: 'What feeling should it create?', hint: 'Palette and mood, not a price bracket.', options: STYLE_OPTIONS },
  { key: 'budget', title: "What's your budget?", hint: 'Every recommendation will fit inside it.', options: BUDGET_OPTIONS },
  { key: 'personalization', title: 'How personal should it be?', hint: 'From ready-to-gift to fully bespoke.', options: PERSONALIZATION_OPTIONS },
];

/** The budget step is addressed by name so a reorder can never send recovery
 *  actions to the wrong question. */
const BUDGET_STEP = STEPS.findIndex((s) => s.key === 'budget');

const EMPTY_ANSWERS = { recipient: '', occasion: '', budget: '', style: '', personalization: '' };

export default function GiftFinderPage() {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState(EMPTY_ANSWERS);
  const [showResults, setShowResults] = useState(false);
  const [relaxed, setRelaxed] = useState(false);
  const [tick, setTick] = useState(0);
  // Direction drives the step transition (+1 forward, -1 back).
  const [direction, setDirection] = useState(1);

  useEffect(() => subscribeStore(() => setTick((n) => n + 1)), []);

  const catalogue = useMemo(() => getProducts(), [tick]);

  const current = STEPS[step];
  const heroRef = useRef(null);
  const wizardRef = useRef(null);
  const resultsGridRef = useRef(null);

  // Hero entrance — staggered, and skipped entirely under reduced motion.
  useEffect(() => {
    if (prefersReducedMotion() || !heroRef.current) return;
    gsap.fromTo(
      heroRef.current.querySelectorAll('[data-hero-item]'),
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power3.out', delay: 0.05 }
    );
  }, []);

  // Step transition — slide in from the direction of travel, plus a fade.
  useEffect(() => {
    if (!wizardRef.current || showResults || prefersReducedMotion()) return;
    gsap.fromTo(
      wizardRef.current,
      { opacity: 0, x: 20 * direction },
      { opacity: 1, x: 0, duration: 0.35, ease: 'power2.out' }
    );
  }, [step, direction, showResults]);

  // Shortlist reveal — staggered, so the eye lands on the first match.
  useEffect(() => {
    if (!showResults || !resultsGridRef.current || prefersReducedMotion()) return;
    const cards = resultsGridRef.current.querySelectorAll('[data-gift-result]');
    if (cards.length === 0) return;
    gsap.fromTo(
      cards,
      { opacity: 0, y: 22 },
      { opacity: 1, y: 0, duration: 0.45, stagger: 0.06, ease: 'power2.out' }
    );
  }, [showResults, answers, relaxed]);

  /** The wizard lives below the hero; keep the question in view on every move. */
  const scrollTop = () => {
    if (heroRef.current) heroRef.current.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  };

  const select = (key, value) => setAnswers((a) => ({ ...a, [key]: value }));

  const goNext = () => {
    if (!answers[current.key]) return;
    if (step < STEPS.length - 1) {
      setDirection(1);
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
      setDirection(-1);
      setStep((s) => s - 1);
      scrollTop();
    }
  };

  const restart = () => {
    setAnswers(EMPTY_ANSWERS);
    setStep(0);
    setDirection(1);
    setShowResults(false);
    setRelaxed(false);
    scrollTop();
  };

  const jumpToStep = (i) => {
    if (i <= step || showResults) {
      setDirection(i < step ? -1 : 1);
      setStep(i);
      setShowResults(false);
      scrollTop();
    }
  };

  const { results, relaxed: isRelaxed, hadBudgetMatch } = recommendGifts(answers, catalogue, {
    limit: 6,
    relaxBudget: relaxed,
  });

  // Read in the order the questions were asked, so the summary mirrors the
  // customer's own decisions.
  const summary = [
    optionLabel('recipient', answers.recipient),
    optionLabel('occasion', answers.occasion),
    optionLabel('style', answers.style),
    optionLabel('budget', answers.budget),
    optionLabel('personalization', answers.personalization),
  ].filter(Boolean);

  const progress = ((showResults ? STEPS.length : step) / STEPS.length) * 100;

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      {/* ═══ EDITORIAL HERO ═══ */}
      <div ref={heroRef} className="relative overflow-hidden pt-8 lg:pt-16 pb-6 lg:pb-12">
        <div className="absolute -top-20 -left-20 w-80 h-80 rounded-full bg-[var(--color-badge-bg)]/20 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 -right-16 w-64 h-64 rounded-full bg-[var(--color-botanical-sage-light)]/15 blur-3xl pointer-events-none" />

        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center max-w-2xl mx-auto space-y-3">
            <div data-hero-item className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-[var(--color-badge-bg)]/50 text-[var(--color-badge-fg)] text-[11px] font-bold uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              <span>The Gift Finder</span>
            </div>
            <h1 data-hero-item className="font-serif text-[30px] sm:text-[38px] md:text-[52px] lg:text-[60px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.1]">
              Let&apos;s find the right gift.
            </h1>
            <p data-hero-item className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed max-w-xl mx-auto">
              Five quick questions. We&apos;ll shortlist handcrafted pieces from our live atelier catalogue — with a reason for each pick.
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-12 lg:pb-16">
        {/* ── Progress ─────────────────────────────────────────────────
            A completed step is re-openable; a future step is not, so the
            customer can always correct an earlier answer without losing the
            rest of the shortlist. */}
        <div className="mb-8">
          <ol className="flex items-center justify-between gap-1 sm:gap-2 max-w-3xl mx-auto list-none p-0">
            {STEP_LABELS.map((label, i) => {
              const done = showResults || i < step;
              const active = !showResults && i === step;
              const reachable = showResults || i <= step;
              return (
                <li key={label} className="flex-1">
                  <button
                    type="button"
                    onClick={() => reachable && jumpToStep(i)}
                    aria-current={active ? 'step' : undefined}
                    aria-label={`Step ${i + 1}: ${label}${done ? ' (answered)' : ''}`}
                    disabled={!reachable}
                    className={`w-full flex flex-col items-center gap-1.5 group rounded-xl py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${reachable ? 'cursor-pointer' : 'cursor-default'}`}
                  >
                    <span
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold border transition-colors duration-200 ${
                        active
                          ? 'bg-[var(--color-btn)] text-white border-[var(--color-btn)] shadow-sm'
                          : done
                          ? 'bg-[var(--color-botanical-sage-light)] text-[var(--color-botanical-primary)] border-[var(--color-botanical-border)]'
                          : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-subtle)] border-[var(--color-botanical-border)]'
                      }`}
                    >
                      {done ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : i + 1}
                    </span>
                    <span className={`text-[10px] uppercase tracking-wider font-bold truncate max-w-full hidden sm:inline ${active ? 'text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-subtle)]'}`}>
                      {label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="max-w-3xl mx-auto mt-4 h-1 rounded-full bg-[var(--color-surface-high)] overflow-hidden">
            <div
              className="h-full bg-[var(--color-accent)] transition-[width] duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {showResults ? 'Showing your shortlist.' : `Step ${step + 1} of ${STEPS.length}: ${current.title}`}
          </p>
        </div>

        {/* ═══ WIZARD ═══ */}
        {!showResults && (
          <div ref={wizardRef} className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] shadow-sm p-6 sm:p-10">
            <div className="flex items-start justify-between gap-4 mb-6">
              <div>
                <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">
                  Step {step + 1} of {STEPS.length}
                </p>
                <h2 className="font-serif text-[26px] sm:text-[30px] text-[var(--color-botanical-primary)] font-normal mt-1">{current.title}</h2>
                <p className="text-[13.5px] text-[var(--color-botanical-muted)]">{current.hint}</p>
              </div>
              {summary.length > 0 && (
                <button
                  type="button"
                  onClick={restart}
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-accent)] transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded-full px-2 py-1"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Restart
                </button>
              )}
            </div>

            {/* One decision per step. Native radios give arrow-key navigation
                and a single tab stop for free; the card is the label, so the
                whole tile is the target (well over 44px on every viewport). */}
            <div role="radiogroup" aria-label={current.title} className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {current.options.map((option) => {
                const selected = answers[current.key] === option.id;
                return (
                  <label
                    key={option.id}
                    className={`flex flex-col items-start gap-1 p-4 rounded-2xl border text-left cursor-pointer transition-[border-color,background-color,box-shadow,transform] duration-200 focus-within:ring-2 focus-within:ring-[var(--color-focus)] focus-within:ring-offset-1 active:scale-[0.985] ${
                      selected
                        ? 'border-[var(--color-btn)] bg-[var(--color-surface-low)] shadow-sm'
                        : 'border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] hover:border-[var(--color-accent)] hover:shadow-sm'
                    }`}
                  >
                    <input
                      type="radio"
                      name={`gift-finder-${current.key}`}
                      value={option.id}
                      checked={selected}
                      onChange={() => select(current.key, option.id)}
                      className="sr-only"
                    />
                    <span className="flex items-center gap-2 w-full">
                      {option.icon && <span className="text-[18px]" aria-hidden="true">{option.icon}</span>}
                      <span className={`text-[13.5px] font-semibold ${selected ? 'text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>
                        {option.label}
                      </span>
                      {selected && <Check className="w-3.5 h-3.5 text-[var(--color-accent)] ml-auto" aria-hidden="true" />}
                    </span>
                    {option.description && (
                      <span className="text-[12px] text-[var(--color-botanical-subtle)]">{option.description}</span>
                    )}
                  </label>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-3 pt-8">
              <button
                type="button"
                onClick={goBack}
                disabled={step === 0}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed touch-target focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                Back
              </button>

              <button
                type="button"
                onClick={goNext}
                disabled={!answers[current.key]}
                className="inline-flex items-center gap-2 px-7 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed touch-target focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2"
              >
                {step < STEPS.length - 1 ? 'Continue' : 'See My Gifts'}
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        {/* ═══ SHORTLIST ═══ */}
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
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors bg-[var(--color-surface-lowest)] touch-target focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                >
                  <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                  Refine Answers
                </button>
                <button
                  type="button"
                  onClick={restart}
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-accent)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] rounded-full px-2 py-1"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Start Again
                </button>
              </div>
            </div>

            {results.length > 0 ? (
              <>
                {/* Both notices state a REAL outcome of the scorer: either
                    nothing sat inside the budget, or nothing matched the
                    occasion, and the page says which. */}
                {isRelaxed && (
                  <div className="rounded-2xl bg-[var(--color-warning-soft-bg)] border border-[var(--color-warning-soft-border)] p-4 text-[13px] text-[var(--color-warning-soft-fg)]">
                    Nothing in the catalogue fits <strong>{optionLabel('budget', answers.budget)}</strong> exactly. These handcrafted pieces sit just outside it — shown so you can decide whether to stretch the budget.
                  </div>
                )}
                {!isRelaxed && answers.occasion && !results.some((r) => r.attributes.occasions.includes(answers.occasion)) && (
                  <div className="rounded-2xl bg-[var(--color-warning-soft-bg)] border border-[var(--color-warning-soft-border)] p-4 text-[13px] text-[var(--color-warning-soft-fg)]">
                    Nothing inside <strong>{optionLabel('budget', answers.budget)}</strong> matches{' '}
                    <strong>{optionLabel('occasion', answers.occasion)}</strong> exactly — these are the handcrafted pieces that fit your budget, so you can decide if the occasion or the price is the one to flex.
                  </div>
                )}

                <div ref={resultsGridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {results.map((result) => (
                    <div key={result.product.id} data-gift-result className="flex flex-col gap-2.5">
                      {/* The canonical storefront card — the same component the
                          shop grid and search use. No second card exists. */}
                      <ProductCard product={result.product} />
                      {result.matches.length > 0 && (
                        <div className="px-1">
                          <p className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">
                            Matches
                          </p>
                          <ul className="mt-1.5 flex flex-wrap gap-1.5 list-none p-0">
                            {result.matches.slice(0, 4).map((match) => (
                              <li
                                key={match}
                                className="px-2.5 py-1 rounded-full bg-[var(--color-surface-low)] border border-[var(--color-botanical-border-light)] text-[11px] font-medium text-[var(--color-botanical-muted)]"
                              >
                                {match}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
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
                      className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2"
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
                    onClick={() => { setShowResults(false); setDirection(-1); setStep(BUDGET_STEP); scrollTop(); }}
                    className="px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                  >
                    Adjust Budget
                  </button>
                  <button
                    type="button"
                    onClick={restart}
                    className="px-6 py-2.5 rounded-full text-[13px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-accent)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                  >
                    Start Over
                  </button>
                </div>
              </div>
            )}

            {/* Custom studio prompt — the honest next step when nothing fits.
                The panel is DELIBERATELY dark in both themes, so it uses the
                same always-dark brand surface and ink as the order
                conversation card. `--color-btn` inverts between themes (near
                black in light, terracotta in dark), which would leave light
                ink unreadable here in dark mode. */}
            <div className="rounded-3xl bg-[#2c2622] text-white p-8 sm:p-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
              <div className="space-y-2 max-w-xl">
                <span className="text-[11px] uppercase font-bold tracking-widest text-[#e8b3a6]">Nothing quite right?</span>
                <h3 className="font-serif text-[26px] sm:text-[30px] font-normal">Build it from scratch in the Custom Gift Studio.</h3>
                <p className="text-[14px] text-[#d4c3ba] leading-relaxed">
                  Choose the base, palette, ribbon and handwritten note — our artisans handcraft it to order.
                </p>
              </div>
              <Link
                to="/custom-gifts"
                className="px-8 py-3.5 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] text-[13px] font-semibold transition-colors duration-200 shrink-0 shadow-md hover:shadow-lg"
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
