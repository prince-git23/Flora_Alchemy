import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Heart, Sparkles, Leaf, Shield } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export default function OurStoryPage() {
  const pageRef = useRef(null);
  const heroRef = useRef(null);
  const sectionsRef = useRef([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const IS_DESKTOP = window.matchMedia('(min-width: 1024px)').matches;

    const ctx = gsap.context(() => {
      // Hero entrance — multi-layer
      const heroTl = gsap.timeline({ delay: 0.1 });
      heroTl
        .fromTo(heroRef.current?.querySelector('[data-hero-badge]'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, 0)
        .fromTo(heroRef.current?.querySelector('[data-hero-title]'), { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' }, 0.15)
        .fromTo(heroRef.current?.querySelector('[data-hero-sub]'), { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' }, 0.35);

      // Section reveals — varied animation types
      const revealTypes = [
        { type: 'split', trigger: 0 },
        { type: 'grid-reveal', trigger: 0 },
        { type: 'center', trigger: 0 },
        { type: 'dark-split', trigger: 0 },
      ];

      sectionsRef.current.forEach((section, i) => {
        if (!section) return;
        const config = revealTypes[i % revealTypes.length];

        if (config.type === 'split') {
          // Alternating image/text: image wipes in from left, text fades up
          const img = section.querySelector('[data-story-img]');
          const text = section.querySelector('[data-story-text]');
          if (img) {
            gsap.fromTo(img, { clipPath: 'polygon(0 0, 0 0, 0 100%, 0 100%)' }, {
              clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%)', duration: 1, ease: 'power3.inOut',
              scrollTrigger: { trigger: section, start: 'top 80%', once: true },
            });
          }
          if (text) {
            gsap.fromTo(text.children, { opacity: 0, y: 24 }, {
              opacity: 1, y: 0, duration: 0.7, stagger: 0.08, ease: 'power3.out',
              scrollTrigger: { trigger: section, start: 'top 80%', once: true },
            });
          }
        } else if (config.type === 'grid-reveal') {
          const cards = section.querySelectorAll('[data-story-card]');
          if (cards.length) {
            gsap.fromTo(cards, { opacity: 0, y: 24, scale: 0.96 }, {
              opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.07, ease: 'power2.out',
              scrollTrigger: { trigger: section, start: 'top 85%', once: true },
            });
          }
        } else if (config.type === 'dark-split') {
          gsap.fromTo(section.querySelector('[data-dark-text]'), { opacity: 0, y: 30 }, {
            opacity: 1, y: 0, duration: 0.8, ease: 'power3.out',
            scrollTrigger: { trigger: section, start: 'top 80%', once: true },
          });
        } else {
          gsap.fromTo(section, { opacity: 0, y: 40 }, {
            opacity: 1, y: 0, duration: 0.8, ease: 'power3.out',
            scrollTrigger: { trigger: section, start: 'top 85%', once: true },
          });
        }
      });

      // Subtle parallax on images — desktop only
      if (IS_DESKTOP) {
        document.querySelectorAll('[data-page-parallax]').forEach((el) => {
          const speed = parseFloat(el.dataset.pageParallax) || 0.06;
          gsap.to(el, {
            y: speed * 60, ease: 'none',
            scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: 1.5 },
          });
        });
      }
    }, pageRef);

    return () => ctx.revert();
  }, []);

  const addSectionRef = (el) => {
    if (el && !sectionsRef.current.includes(el)) {
      sectionsRef.current.push(el);
    }
  };

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      {/* ═══ HERO ═══ */}
      <section ref={heroRef} className="relative py-16 lg:py-28 overflow-hidden">
        {/* Ambient glow orbs */}
        <div className="absolute top-10 left-1/4 w-64 lg:w-72 h-64 lg:h-72 bg-[#964735]/8 rounded-full blur-[120px]" />
        <div className="absolute bottom-10 right-1/4 w-48 lg:w-56 h-48 lg:h-56 bg-[#c17c74]/8 rounded-full blur-[100px]" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-5 lg:space-y-6">
          <div data-hero-badge className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--color-badge-bg)]/50 text-[var(--color-badge-fg)] text-[11px] font-bold uppercase tracking-wider">
            <Heart className="w-3.5 h-3.5" />
            <span>Our Story</span>
          </div>
          <h1 data-hero-title className="font-serif text-[36px] sm:text-[48px] lg:text-[64px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.08]">
            Gifts Made by Hand,<br className="hidden sm:block" /> Meant to Endure
          </h1>
          <p data-hero-sub className="text-[15px] sm:text-[17px] lg:text-[18px] text-[var(--color-botanical-muted)] leading-relaxed max-w-2xl mx-auto">
            Flora Alchemy began with a simple conviction: the most meaningful gifts are the ones someone actually made — petal by petal, fold by fold, with care you can feel.
          </p>
        </div>
      </section>

      {/* ═══ WHY FLORA ALCHEMY — Image/text split ═══ */}
      <section ref={addSectionRef} className="py-14 lg:py-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-20 items-center">
            <div data-story-text className="space-y-5 lg:space-y-6">
              <h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[38px] text-[var(--color-botanical-primary)] leading-tight">
                Why Flora Alchemy Exists
              </h2>
              <div className="space-y-4 text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed">
                <p>
                  We noticed something strange about gifting: the more connected we became, the more generic our gifts felt. Pre-bundled bouquets. Mass-printed cards. Same-day delivery of the same things everyone else orders.
                </p>
                <p>
                  Flora Alchemy exists to offer an alternative — gifts that feel like they were made for one specific person, because they were. Every posy, every card, every keepsake is assembled by hand in our studio, using materials we&apos;d be proud to gift ourselves.
                </p>
                <p className="font-medium text-[var(--color-botanical-primary)]">
                  We don&apos;t do volume. We do intention.
                </p>
              </div>
            </div>
            <div className="relative group">
              <div data-story-img data-page-parallax="0.05" className="aspect-[4/5] rounded-3xl overflow-hidden bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] transition-shadow duration-500 group-hover:shadow-xl">
                <img
                  loading="lazy"
                  decoding="async" src="/assets/images/flora-asset-03.jpg" alt="Handcrafted botanical arrangement" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
              </div>
              <div className="absolute -bottom-3 lg:-bottom-4 -left-2 lg:-left-4 bg-[var(--color-surface-lowest)] rounded-2xl p-3 lg:p-4 shadow-lg border border-[var(--color-botanical-border)]">
                <p className="text-[11px] lg:text-[12px] font-bold text-[var(--color-accent)] uppercase tracking-wider">Since 2024</p>
                <p className="text-[12px] lg:text-[13px] text-[var(--color-botanical-muted)]">Handmade in India</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══ WHAT MAKES US DIFFERENT — Grid reveal ═══ */}
      <section ref={addSectionRef} className="py-14 lg:py-24 bg-[var(--color-surface-lowest)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-12 lg:mb-14 space-y-3">
            <h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[38px] text-[var(--color-botanical-primary)]">What Makes Our Gifts Different</h2>
            <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)]">Every choice we make serves one goal: a gift that feels genuinely personal.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 lg:gap-6">
            {[
              { icon: Leaf, title: 'Real Materials', desc: 'Pipe-cleaner petals, deckled mulberry bark, hand-thrown stoneware — nothing plastic, nothing mass-produced.' },
              { icon: Heart, title: 'Made by Hand', desc: 'Every arrangement is assembled by a single craftsperson. No assembly lines. No shortcuts.' },
              { icon: Sparkles, title: 'Genuinely Personal', desc: 'Palette, ribbon, card message, wax seal — your gift reflects the person receiving it.' },
              { icon: Shield, title: 'Built to Endure', desc: "Our botanicals don't wilt. Our keepsakes don't discard. A Flora gift stays long after the occasion." },
            ].map((item, i) => (
              <div key={item.title} data-story-card className="p-5 lg:p-6 rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] space-y-3 transition-all duration-300 hover:shadow-lg hover:-translate-y-1">
                <div className="w-10 h-10 rounded-full bg-[var(--color-btn)] flex items-center justify-center">
                  <item.icon className="w-5 h-5 text-white" />
                </div>
                <h3 className="font-serif text-[17px] lg:text-[18px] text-[var(--color-botanical-primary)]">{item.title}</h3>
                <p className="text-[13px] text-[var(--color-botanical-muted)] leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ THE PEOPLE — Center reveal ═══ */}
      <section ref={addSectionRef} className="py-14 lg:py-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-5 lg:space-y-6">
          <h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[38px] text-[var(--color-botanical-primary)]">The People Behind the Petals</h2>
          <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] leading-relaxed max-w-2xl mx-auto">
            Flora Alchemy is a small studio of makers who believe that the act of creating something by hand is itself a form of care. We work slowly, deliberately, and with materials we trust. Every gift that leaves our studio carries that intention with it.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-4">
            <Link
              to="/how-its-made"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors shadow-md w-full sm:w-auto justify-center"
            >
              See How It&apos;s Made
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              to="/shop"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors w-full sm:w-auto justify-center"
            >
              Explore the Creations
            </Link>
          </div>
        </div>
      </section>

      {/* ═══ WHY PERSONALIZED GIFTS MATTER — Dark section ═══ */}
      <section ref={addSectionRef} className="py-14 lg:py-24 bg-[var(--color-btn)] relative overflow-hidden">
        {/* Ambient glow */}
        <div className="absolute top-0 left-1/4 w-48 lg:w-64 h-48 lg:h-64 bg-[#964735]/20 rounded-full blur-[100px]" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-5 lg:space-y-6" data-dark-text>
          <h2 className="font-serif text-[28px] sm:text-[32px] lg:text-[38px] text-white leading-tight">Why Personalized Gifts Matter</h2>
          <p className="text-[14px] sm:text-[15px] text-white/70 leading-relaxed max-w-xl mx-auto">
            A personalized gift says: I thought about you. I chose this for you. I made this for you. In a world of one-click purchases, that kind of attention is rare — and unmistakable.
          </p>
          <div className="flex items-center justify-center gap-3 pt-4">
            <Link
              to="/custom-gifts"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[#964735] text-white text-[13px] font-semibold hover:bg-[#c17c74] transition-colors shadow-md"
            >
              <Sparkles className="w-4 h-4" />
              Build a Custom Gift
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
