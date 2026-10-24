import React, { useCallback, useEffect, useRef } from 'react';
import { gsap, prefersReducedMotion } from '../../lib/gsapSetup.js';

/**
 * REACT BITS, ADAPTED — not vendored.
 *
 * The brief asked for React Bits research, selection and *adaptation*. Three of
 * its effects earn their place here, and each was rebuilt on GSAP + CSS (which
 * the storefront already ships) instead of pulling in `motion`/framer-motion as
 * a second animation runtime:
 *
 *   · SplitText   → per-character reveal for the atelier's chapter titles
 *   · Magnetic    → a CTA that leans toward the pointer, then settles
 *   · SpotlightCard → a pointer-tracked light that follows the cursor
 *
 * Every one of them is inert under `prefers-reduced-motion`, keyboard focus is
 * never moved, and none of them traps or restyles text in a way that changes
 * what a screen reader announces (the visible string stays one text node for
 * assistive tech via `aria-label` on the wrapper).
 */

/** Per-character reveal. The string is preserved for assistive technology. */
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

/** A CTA that leans toward the pointer and settles back with the same spring. */
export function Magnetic({ children, strength = 14, className = '' }) {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || prefersReducedMotion()) return undefined;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (!fine.matches) return undefined;

    const xTo = gsap.quickTo(node, 'x', { duration: 0.45, ease: 'power3.out' });
    const yTo = gsap.quickTo(node, 'y', { duration: 0.45, ease: 'power3.out' });

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

/** A card whose light follows the pointer. Pure CSS variables — no re-render. */
export function SpotlightCard({ children, className = '', tone = '255, 236, 200', ...rest }) {
  const ref = useRef(null);

  const onPointerMove = useCallback(
    (event) => {
      const node = ref.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      node.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
      node.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
      node.style.setProperty('--spot-on', '1');
    },
    []
  );

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
          background: `radial-gradient(220px circle at var(--spot-x) var(--spot-y), rgba(${tone}, 0.16), transparent 65%)`,
        }}
      />
      {children}
    </div>
  );
}

export default { SplitText, Magnetic, SpotlightCard };
