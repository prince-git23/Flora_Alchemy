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

export default { SplitText, Magnetic, SpotlightCard };
