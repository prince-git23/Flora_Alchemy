import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowLeft } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const STEPS = [
  {
    number: '01',
    title: 'Materials',
    desc: 'We source pipe-cleaner stems, deckled mulberry bark, raw silk, and hand-thrown stoneware from trusted artisan suppliers.',
    image: '/assets/images/flora-asset-09.jpg',
    alt: 'Raw artisan materials — pipe-cleaner stems, mulberry bark, and stoneware',
  },
  {
    number: '02',
    title: 'Petal & Component',
    desc: "Each petal is individually shaped, twisted, and colored by hand. No two are identical — and that's the point.",
    image: '/assets/images/flora-asset-16.jpg',
    alt: 'Hand-shaped chenille wire petals being crafted',
  },
  {
    number: '03',
    title: 'Assembly',
    desc: 'A single craftsperson builds each arrangement from start to finish, ensuring coherence and care in every detail.',
    image: '/assets/images/flora-asset-26.jpg',
    alt: 'Artisan assembling a floral arrangement by hand',
  },
  {
    number: '04',
    title: 'Arrangement',
    desc: 'Stems are composed into a balanced posy, bouquet, or vessel arrangement — adjusted until it feels right.',
    image: '/assets/images/flora-asset-03.jpg',
    alt: 'Balanced floral arrangement in progress',
  },
  {
    number: '05',
    title: 'Finishing',
    desc: 'Wax seals, ribbon ties, and botanical card messages are added by hand — the final personal touch.',
    image: '/assets/images/flora-asset-06.jpg',
    alt: 'Wax seal being applied to a botanical card',
  },
  {
    number: '06',
    title: 'Wrapping',
    desc: 'Wrapped in deckled bark, tissue, or keepsake packaging — presented as a gift from the moment it arrives.',
    image: '/assets/images/flora-asset-11.jpg',
    alt: 'Hand-wrapped keepsake gift packaging',
  },
  {
    number: '07',
    title: 'Your Gift',
    desc: 'Packed securely and dispatched with tracking. Your handcrafted creation arrives ready to give.',
    image: '/assets/images/flora-asset-21.jpg',
    alt: 'Final handcrafted gift ready for dispatch',
  },
];

export default function HowItsMadePage() {
  const pageRef = useRef(null);
  const heroRef = useRef(null);
  const stepsRef = useRef([]);
  const ctaRef = useRef(null);
  const progressRef = useRef(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const IS_DESKTOP = window.matchMedia('(min-width: 1024px)').matches;

    const ctx = gsap.context(() => {
      // Hero entrance — staggered
      const heroTl = gsap.timeline({ delay: 0.1 });
      heroTl
        .fromTo(heroRef.current?.querySelector('[data-ht-badge]'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, 0)
        .fromTo(heroRef.current?.querySelector('[data-ht-title]'), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' }, 0.15)
        .fromTo(heroRef.current?.querySelector('[data-ht-sub]'), { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' }, 0.3);

      // Steps — alternating left/right reveals with image clip-path wipe
      stepsRef.current.forEach((step, i) => {
        if (!step) return;
        const isEven = i % 2 === 1;
        const img = step.querySelector('[data-step-img]');
        const text = step.querySelector('[data-step-text]');

        // Image: clip-path wipe reveal
        if (img) {
          gsap.fromTo(img, {
            clipPath: isEven
              ? 'polygon(100% 0, 100% 0, 100% 100%, 100% 100%)'
              : 'polygon(0 0, 0 0, 0 100%, 0 100%)',
          }, {
            clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%)',
            duration: 0.9,
            ease: 'power3.inOut',
            scrollTrigger: { trigger: step, start: 'top 80%', once: true },
          });
        }

        // Text: slide from side + fade
        if (text) {
          gsap.fromTo(text, {
            opacity: 0,
            x: isEven ? -30 : 30,
          }, {
            opacity: 1,
            x: 0,
            duration: 0.7,
            ease: 'power3.out',
            scrollTrigger: { trigger: step, start: 'top 80%', once: true },
          });
        }
      });

      // Progress line (desktop only) — grows as user scrolls through steps
      if (IS_DESKTOP && progressRef.current && stepsRef.current.length) {
        const firstStep = stepsRef.current[0];
        const lastStep = stepsRef.current[stepsRef.current.length - 1];
        if (firstStep && lastStep) {
          gsap.fromTo(progressRef.current, { scaleY: 0 }, {
            scaleY: 1, ease: 'none',
            scrollTrigger: {
              trigger: firstStep,
              endTrigger: lastStep,
              start: 'top center',
              end: 'bottom center',
              scrub: 0.5,
            },
          });
        }
      }

      // CTA reveal
      if (ctaRef.current) {
        gsap.fromTo(ctaRef.current, { opacity: 0, y: 30, scale: 0.97 }, {
          opacity: 1, y: 0, scale: 1, duration: 0.8, ease: 'power3.out',
          scrollTrigger: { trigger: ctaRef.current, start: 'top 85%', once: true }
        });
      }
    }, pageRef);

    return () => ctx.revert();
  }, []);

  const addStepRef = (el) => {
    if (el && !stepsRef.current.includes(el)) {
      stepsRef.current.push(el);
    }
  };

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      {/* ═══ HERO ═══ */}
      <section ref={heroRef} className="relative py-16 lg:py-28 overflow-hidden">
        {/* Ambient glow orbs */}
        <div className="absolute top-10 left-1/3 w-48 lg:w-64 h-48 lg:h-64 bg-[#964735]/8 rounded-full blur-[120px]" />
        <div className="absolute bottom-10 right-1/3 w-40 lg:w-48 h-40 lg:h-48 bg-[#c17c74]/8 rounded-full blur-[100px]" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-4 lg:space-y-5">
          <div data-ht-badge className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)] text-[11px] font-bold uppercase tracking-wider">
            <span>Process</span>
          </div>
          <h1 data-ht-title className="font-serif text-[36px] sm:text-[48px] lg:text-[56px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.08]">
            How It&apos;s Made
          </h1>
          <p data-ht-sub className="text-[15px] sm:text-[16px] lg:text-[17px] text-[var(--color-botanical-muted)] leading-relaxed max-w-xl mx-auto">
            From raw material to finished gift — every Flora Alchemy creation passes through seven deliberate stages of handcraft.
          </p>
        </div>
      </section>

      {/* ═══ PROCESS STEPS ═══ */}
      <section className="py-10 lg:py-20 relative">
        {/* Desktop progress line */}
        <div className="hidden lg:block absolute left-1/2 top-[15%] bottom-[15%] w-px bg-[#e5e2dd] -translate-x-1/2" aria-hidden="true">
          <div ref={progressRef} className="w-full h-full bg-[#964735] origin-top" style={{ transformOrigin: 'top', transform: 'scaleY(0)' }} />
        </div>

        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="space-y-14 lg:space-y-24">
            {STEPS.map((step, idx) => (
              <div
                key={step.number}
                ref={addStepRef}
                className={`grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-16 items-center relative`}
              >
                {/* Image */}
                <div className={`${idx % 2 === 1 ? 'lg:order-2' : ''}`}>
                  <div data-step-img className="aspect-[4/3] rounded-3xl overflow-hidden bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] group relative">
                    <img
                      loading="lazy"
                      decoding="async" src={step.image} alt={step.alt} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
                    {/* Step number overlay on image */}
                    <div className="absolute bottom-3 left-3 lg:bottom-4 lg:left-4 px-3 py-1.5 rounded-xl bg-[#180f0a]/80 backdrop-blur-md text-white text-[11px] font-bold tracking-wider uppercase">
                      Step {step.number}
                    </div>
                  </div>
                </div>

                {/* Text */}
                <div data-step-text className={`space-y-3 lg:space-y-4 ${idx % 2 === 1 ? 'lg:order-1' : ''}`}>
                  <div className="flex items-center gap-3">
                    <span className="font-serif text-[40px] lg:text-[48px] font-bold text-[#e5e2dd] leading-none">{step.number}</span>
                    <div className="h-px flex-1 bg-[#e5e2dd]" />
                  </div>
                  <h2 className="font-serif text-[24px] sm:text-[28px] lg:text-[32px] text-[var(--color-botanical-primary)]">{step.title}</h2>
                  <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ CTA ═══ */}
      <section ref={ctaRef} className="py-14 lg:py-24 bg-[var(--color-surface-lowest)] relative overflow-hidden">
        {/* Ambient glow */}
        <div className="absolute top-0 right-1/4 w-40 lg:w-56 h-40 lg:h-56 bg-[#964735]/8 rounded-full blur-[100px]" />

        <div className="relative max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-5 lg:space-y-6">
          <h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[38px] text-[var(--color-botanical-primary)]">Ready to Create Something?</h2>
          <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)]">
            Now that you understand the craft, explore our collection or build a custom gift yourself.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <Link
              to="/custom-gifts"
              className="inline-flex items-center gap-2 px-7 lg:px-8 py-3.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors shadow-md w-full sm:w-auto justify-center"
            >
              Build a Custom Gift
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              to="/shop"
              className="inline-flex items-center gap-2 px-7 lg:px-8 py-3.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors w-full sm:w-auto justify-center"
            >
              <ArrowLeft className="w-4 h-4" />
              Browse All Gifts
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
