import React, { useCallback, useEffect, useRef } from 'react';
import { gsap, prefersReducedMotion } from '../../lib/gsapSetup.js';

/**
 * REACT BITS, ADAPTED — the storefront's canonical copies.
 *
 * Three techniques from React Bits, rebuilt on the GSAP the storefront already
 * ships (no second animation runtime, no independent rAF loops): a per-
 * character type reveal, a magnetic CTA and a pointer-tracked spotlight. Each
 * is inert under `prefers-reduced-motion`, never moves keyboard focus, and
 * keeps the visible string as one accessible text node (`aria-label` on the
 * wrapper, per-character spans hidden from assistive tech).
 *
 * These live OUTSIDE the atelier folder because they serve the photographic
 * homepage and any route — nothing here imports three.js.
 */

/**
 * MASKED LINE REVEAL — the default for section headings (kinetic-type
 * vocabulary A). Each line is wrapped in a clipping mask and the inner line
 * rides up into place, the way an editorial title is uncovered rather than
 * faded in. Accepts one string or an array of lines (for headings whose line
 * breaks are part of the composition).
 *
 * Content-first: nothing is hidden in markup. The initial offset is applied
 * by GSAP inside a scoped context, so reduced motion — or a failed script —
 * leaves every line exactly where it belongs. One accessible heading: the
 * wrapper carries the full string as `aria-label`; masked lines are hidden
 * from assistive tech, never made separate headings, links or tab stops.
 */
export function MaskedLines({
  lines,
  label,
  className = '',
  as: Tag = 'span',
  delay = 0,
  stagger = 0.11,
  start = 'top 86%',
  duration = 0.75,
}) {
  const ref = useRef(null);
  const list = Array.isArray(lines) ? lines : [lines];
  /* `label` is required when a line carries a node (an emphasis span): the
     accessible string must stay one unfragmented string for screen readers. */
  const full = label || list.filter((line) => typeof line === 'string').join(' ');

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const inners = node.querySelectorAll('[data-line-inner]');
    if (prefersReducedMotion() || inners.length === 0) return undefined;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        inners,
        { yPercent: 108 },
        {
          yPercent: 0,
          duration,
          ease: 'power3.out',
          stagger,
          delay,
          scrollTrigger: { trigger: node, start, once: true },
        }
      );
    }, node);
    return () => ctx.revert();
  }, [full, delay, stagger, start, duration]);

  return (
    <Tag ref={ref} className={className} aria-label={full} data-type-reveal="line">
      {list.map((line, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="block overflow-hidden pb-[0.14em]"
        >
          <span data-line-inner className="block will-change-transform">
            {line}
          </span>
        </span>
      ))}
    </Tag>
  );
}

/**
 * WORD REVEAL — split phrase (kinetic-type vocabulary B), for the short
 * hero and closing phrases only. Words ride up from their own masks with a
 * tight stagger; no bouncing, no elastic scale, no perpetual motion. The
 * wrapper keeps one accessible string; per-word spans are hidden from
 * assistive tech.
 */
export function WordReveal({
  text,
  className = '',
  as: Tag = 'span',
  delay = 0,
  stagger = 0.035,
  start = 'top 88%',
  duration = 0.7,
}) {
  const ref = useRef(null);
  const words = String(text).split(/\s+/).filter(Boolean);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const inners = node.querySelectorAll('[data-word-inner]');
    if (prefersReducedMotion() || inners.length === 0) return undefined;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        inners,
        { yPercent: 110 },
        {
          yPercent: 0,
          duration,
          ease: 'power3.out',
          stagger,
          delay,
          scrollTrigger: { trigger: node, start, once: true },
        }
      );
    }, node);
    return () => ctx.revert();
  }, [text, delay, stagger, start, duration]);

  return (
    <Tag ref={ref} className={className} aria-label={text} data-type-reveal="word">
      {words.map((word, i) => (
        <span key={`${word}-${i}`} aria-hidden="true" className="inline-block overflow-hidden pb-[0.12em] align-bottom">
          <span data-word-inner className="inline-block will-change-transform">
            {word}
            {i < words.length - 1 ? '\u00a0' : ''}
          </span>
        </span>
      ))}
    </Tag>
  );
}

/**
 * EMPHASIS SETTLE — one restrained 0.45 s settle on an italic/terracotta
 * phrase already inside a heading (vocabulary D). Writes only the child's
 * opacity, so the parent's line reveal and this emphasis never compete for
 * the same transform of the same node.
 */
export function EmphasisSettle({ children, className = '', as: Tag = 'span', start = 'top 88%' }) {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (prefersReducedMotion()) return undefined;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        node,
        { opacity: 0.4, y: 6 },
        {
          opacity: 1,
          y: 0,
          duration: 0.45,
          ease: 'power2.out',
          immediateRender: true,
          scrollTrigger: { trigger: node, start, once: true },
        }
      );
    }, node);
    return () => ctx.revert();
  }, [start]);

  return (
    <Tag ref={ref} className={className} data-type-reveal="emphasis">
      {children}
    </Tag>
  );
}

/** Per-character reveal for editorial headings. */
export function SplitText({ text, className = '', as: Tag = 'span', delay = 0, stagger = 0.018 }) {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const chars = node.querySelectorAll('[data-char]');
    if (prefersReducedMotion()) {
      gsap.set(chars, { opacity: 1, y: 0 });
      return undefined;
    }
    const tween = gsap.fromTo(
      chars,
      { opacity: 0, y: '0.5em', rotateX: -35 },
      { opacity: 1, y: 0, rotateX: 0, duration: 0.7, ease: 'power3.out', stagger, delay }
    );
    return () => tween.kill();
  }, [text, delay, stagger]);

  return (
    <Tag ref={ref} className={className} aria-label={text}>
      {String(text)
        .split('')
        .map((char, index) => (
          <span key={`${char}-${index}`} data-char aria-hidden="true" className="inline-block will-change-transform">
            {char === ' ' ? '\u00a0' : char}
          </span>
        ))}
    </Tag>
  );
}

/** A CTA that leans toward a fine pointer and settles back. */
export function Magnetic({ children, strength = 10, className = '' }) {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || prefersReducedMotion()) return undefined;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (!fine.matches) return undefined;

    const xTo = gsap.quickTo(node, 'x', { duration: 0.4, ease: 'power3.out' });
    const yTo = gsap.quickTo(node, 'y', { duration: 0.4, ease: 'power3.out' });

    const onMove = (event) => {
      const rect = node.getBoundingClientRect();
      xTo(((event.clientX - rect.left) / rect.width - 0.5) * strength);
      yTo(((event.clientY - rect.top) / rect.height - 0.5) * strength * 0.7);
    };
    const onLeave = () => {
      xTo(0);
      yTo(0);
    };

    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerleave', onLeave);
    return () => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', onLeave);
      gsap.set(node, { x: 0, y: 0 });
    };
  }, [strength]);

  return (
    <span ref={ref} className={className} style={{ display: 'inline-flex', willChange: 'transform' }}>
      {children}
    </span>
  );
}

/** A card whose light follows the pointer, via CSS variables — no re-render. */
export function SpotlightCard({ children, className = '', tone = '255, 236, 200', ...rest }) {
  const ref = useRef(null);

  const onPointerMove = useCallback((event) => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
    node.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
    node.style.setProperty('--spot-on', '1');
  }, []);

  const onPointerLeave = useCallback(() => {
    ref.current?.style.setProperty('--spot-on', '0');
  }, []);

  return (
    <div
      ref={ref}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className={`relative overflow-hidden ${className}`}
      {...rest}
      style={{ '--spot-x': '50%', '--spot-y': '50%', '--spot-on': '0' }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 transition-opacity duration-500"
        style={{
          opacity: 'var(--spot-on)',
          background: `radial-gradient(260px circle at var(--spot-x) var(--spot-y), rgba(${tone}, 0.14), transparent 65%)`,
        }}
      />
      {children}
    </div>
  );
}

export default { SplitText, MaskedLines, WordReveal, EmphasisSettle, Magnetic, SpotlightCard };
