import { useEffect, useState } from 'react';

/**
 * STAGE CAPABILITY — decides, on the client's first render, whether the
 * homepage mounts the real 3D stage (mode 'stage') or the static photographic
 * band (mode 'still').
 *
 * This is deliberately a small, self-contained copy of the atelier's
 * capability probe: `frontend/src/atelier/` is an isolated experiment that no
 * route may import, so the storefront keeps its own probe beside the component
 * that uses it. The decision inputs are only ones we can evaluate synchronously
 * before paint (WebGL availability, `prefers-reduced-motion`, Save-Data), so
 * there is no layout swap after hydration: the first render is the final mode.
 */

export function detectWebgl() {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) ||
      canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false });
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function readReducedMotion() {
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readSaveData() {
  return Boolean(typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData);
}

/**
 * Mode resolution — a single pure function so the rule is testable without a
 * browser. 'still' renders the photograph band with normal flow (no pin, no
 * runway, no canvas); 'stage' renders the pinned, scroll-driven camera.
 */
export function resolveStageMode({ webgl, reduced, saveData }) {
  if (reduced) return { mode: 'still', reason: 'reduced-motion' };
  if (!webgl) return { mode: 'still', reason: 'no-webgl' };
  if (saveData) return { mode: 'still', reason: 'save-data' };
  return { mode: 'stage', reason: 'webgl' };
}

export function useStageCapability() {
  const [decision, setDecision] = useState(() =>
    resolveStageMode({
      webgl: detectWebgl(),
      reduced: readReducedMotion(),
      saveData: readSaveData(),
    })
  );

  // Live-update only for the reduced-motion toggle (OS setting changed while
  // the page is open). The other inputs are stable for a page's lifetime.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () =>
      setDecision(
        resolveStageMode({
          webgl: detectWebgl(),
          reduced: mq.matches,
          saveData: readSaveData(),
        })
      );
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return decision;
}
