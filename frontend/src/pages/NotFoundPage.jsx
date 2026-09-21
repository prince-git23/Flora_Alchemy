import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ShoppingBag, Gift, Sparkles } from 'lucide-react';
import gsap from 'gsap';

export default function NotFoundPage() {
  const pageRef = useRef(null);
  const contentRef = useRef(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ delay: 0.1 });
      tl
        .fromTo(contentRef.current, { opacity: 0, y: 28, scale: 0.97 }, {
          opacity: 1, y: 0, scale: 1, duration: 0.8, ease: 'power3.out'
        }, 0)
        .fromTo(contentRef.current?.querySelectorAll('[data-404-float]'), { opacity: 0, y: 12, rotation: -5 }, {
          opacity: 1, y: 0, rotation: 0, duration: 0.6, stagger: 0.1, ease: 'power3.out'
        }, 0.3)
        .fromTo(contentRef.current?.querySelectorAll('[data-404-cta]'), { opacity: 0, y: 10 }, {
          opacity: 1, y: 0, duration: 0.5, stagger: 0.06, ease: 'power3.out'
        }, 0.5);
    }, pageRef);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-[70vh] flex items-center justify-center py-12 lg:py-16 px-4 relative overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="absolute top-20 left-1/4 w-48 lg:w-64 h-48 lg:h-64 bg-[#964735]/8 rounded-full blur-[120px]" />
      <div className="absolute bottom-20 right-1/4 w-40 lg:w-48 h-40 lg:h-48 bg-[#c17c74]/8 rounded-full blur-[100px]" />

      {/* Floating botanical decorations */}
      <div className="absolute top-1/4 left-[10%] text-[40px] lg:text-[60px] opacity-10 fa-float-slow pointer-events-none" aria-hidden="true">🌸</div>
      <div className="absolute bottom-1/4 right-[10%] text-[30px] lg:text-[50px] opacity-10 fa-drift pointer-events-none" aria-hidden="true">🌿</div>
      <div className="absolute top-1/3 right-[15%] text-[20px] lg:text-[30px] opacity-8 fa-float-subtle pointer-events-none" aria-hidden="true">✨</div>

      <div ref={contentRef} className="max-w-lg w-full text-center space-y-5 lg:space-y-6 bg-[var(--color-surface-lowest)] rounded-3xl p-6 sm:p-8 lg:p-12 border border-[var(--color-botanical-border)] shadow-sm relative">
        {/* Floating botanical accent inside card */}
        <div data-404-float className="absolute -top-3 -left-3 text-[28px] fa-float-subtle pointer-events-none" aria-hidden="true">🌸</div>
        <div data-404-float className="absolute -bottom-2 -right-3 text-[24px] fa-drift pointer-events-none" aria-hidden="true">🌿</div>

        <div className="w-14 h-14 lg:w-16 lg:h-16 rounded-full bg-[var(--color-surface-low)] text-[#964735] mx-auto flex items-center justify-center">
          <span className="font-serif text-[28px] lg:text-[32px] font-bold">404</span>
        </div>

        <div className="space-y-2">
          <span className="text-[11px] font-bold uppercase tracking-widest text-[#964735]">
            Page Not Found
          </span>
          <h1 className="font-serif text-[28px] sm:text-[32px] lg:text-[40px] text-[var(--color-botanical-primary)] font-normal leading-tight">
            A quiet detour in the garden.
          </h1>
          <p className="text-[13px] sm:text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">
            The page, collection, or keepsake you are looking for may have been moved or is no longer in our active atelier catalog.
          </p>
        </div>

        <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            to="/"
            data-404-cta
            className="w-full sm:w-auto px-6 py-3 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] transition-all duration-300 hover:-translate-y-0.5 text-[13px] font-semibold flex items-center justify-center gap-2 shadow-sm"
          >
            <span>Return to Home</span>
            <ArrowRight className="w-4 h-4" />
          </Link>

          <Link
            to="/shop"
            data-404-cta
            className="w-full sm:w-auto px-6 py-3 rounded-full bg-[var(--color-surface-low)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-highest)] transition-all duration-300 hover:-translate-y-0.5 text-[13px] font-semibold flex items-center justify-center gap-2 border border-[var(--color-botanical-border)]"
          >
            <ShoppingBag className="w-4 h-4" />
            <span>Browse Shop</span>
          </Link>
        </div>

        <div className="pt-4 border-t border-[var(--color-botanical-border)] space-y-3">
          <p className="text-[11px] lg:text-[12px] text-[var(--color-botanical-subtle)] font-semibold uppercase tracking-wider">Or explore</p>
          <div className="flex flex-wrap items-center justify-center gap-2 lg:gap-3">
            <Link
              to="/custom-gifts"
              data-404-cta
              className="inline-flex items-center gap-1.5 px-3.5 lg:px-4 py-2 rounded-full bg-[var(--color-botanical-terracotta-light)]/40 text-[11px] lg:text-[12px] font-semibold text-[#964735] hover:bg-[#ffdad3]/60 transition-colors"
            >
              <Gift className="w-3.5 h-3.5" />
              Custom Gifts
            </Link>
            <Link
              to="/gift-finder"
              data-404-cta
              className="inline-flex items-center gap-1.5 px-3.5 lg:px-4 py-2 rounded-full bg-[#d8e7cd]/40 text-[11px] lg:text-[12px] font-semibold text-[#5b6d54] hover:bg-[#d8e7cd]/60 transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Gift Finder
            </Link>
            <Link
              to="/collections"
              data-404-cta
              className="inline-flex items-center gap-1.5 px-3.5 lg:px-4 py-2 rounded-full bg-[var(--color-surface-low)] text-[11px] lg:text-[12px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[#ebe8e3] transition-colors"
            >
              Collections
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
