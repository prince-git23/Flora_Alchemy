import { useEffect, useState } from 'react';

/**
 * WHAT THIS DEVICE CAN HONESTLY AFFORD.
 *
 * The atelier is an optional, expensive layer on a shop that must work
 * everywhere, so the tier is decided ONCE, up front, from capabilities rather
 * than from a user-agent string:
 *
 *   · `webgl`      — no usable WebGL context means no canvas at all. The static
 *                    composition is the design for that device, not a failure.
 *   · `reduced`    — prefers-reduced-motion: the scene still renders (it is the
 *                    composition), but nothing scroll-pins, nothing dollies, and
 *                    the camera rests on one flattering pose.
 *   · `low`        — a small screen, save-data, few cores or little memory:
 *                    fewer petals, no shadows, no post-processing.
 *   · `standard`   — mobile desktop-class: shadows + contact shadows, no DOF.
 *   · `full`       — post-processing (depth of field, bloom, vignette, grain).
 *
 * `resolve` is exported separately so the decision is testable without a DOM.
 */

export function resolveCapability({ webgl, reducedMotion, width, saveData, cores, memory }) {
  if (!webgl) return { render: false, tier: 'static', reason: 'no-webgl' };
  if (reducedMotion) return { render: true, tier: 'reduced', reason: 'reduced-motion' };
  if (saveData) return { render: true, tier: 'low', reason: 'save-data' };
  if (width > 0 && width < 768) return { render: true, tier: 'low', reason: 'small-screen' };
  if ((cores && cores <= 4) || (memory && memory <= 4)) {
    return { render: true, tier: 'standard', reason: 'modest-device' };
  }
  return { render: true, tier: 'full', reason: 'capable' };
}

/** Probe for a real WebGL context without leaving a canvas behind. */
export function detectWebgl() {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch {
    return false;
  }
}

function readEnvironment() {
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  return {
    webgl: detectWebgl(),
    reducedMotion: typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    saveData: Boolean(nav.connection && nav.connection.saveData),
    cores: nav.hardwareConcurrency || 0,
    memory: nav.deviceMemory || 0,
  };
}

export function useAtelierCapability() {
  const [capability, setCapability] = useState(() => resolveCapability(readEnvironment()));

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setCapability(resolveCapability(readEnvironment()));
    motion.addEventListener('change', onChange);
    return () => motion.removeEventListener('change', onChange);
  }, []);

  return capability;
}

export default useAtelierCapability;
