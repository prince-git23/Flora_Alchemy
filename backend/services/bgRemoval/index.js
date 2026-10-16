/**
 * 3D STUDIO — Phase 1 — provider registry.
 *
 * ONE entry point for background removal. Callers never import an engine
 * directly, so swapping or adding an engine later (Phase 2 may add a hosted or
 * local 3D-conditioning model) cannot leak into the upload workflow.
 *
 * Selection (`BGREMOVE_PROVIDER`):
 *   · `deterministic` (default when the variable is unset AND no rembg install
 *     is found) — the built-in engine; always available;
 *   · `auto` — use rembg when a working install is reachable, otherwise the
 *     deterministic engine. Auto is what makes an operator's `pip install`
 *     take effect without a config change;
 *   · `rembg` — require rembg (fails the job honestly when it is unavailable).
 *
 * FALLBACK POLICY
 * ---------------
 * When rembg is explicitly chosen but the INSTALL is broken (not a segmentation
 * failure — that is reported as-is), the deterministic engine is tried so the
 * administrator is not blocked by an infrastructure problem, and the result
 * carries a warning naming the engine that actually ran. What never happens is
 * a silent substitution with no record: `engine`, `model` and any fallback
 * warning are stored on the image and returned by the API.
 */

import { ApiError } from '../../middleware/errorMiddleware.js';
import { composeNeutral, removeBackground as deterministic } from './deterministicEngine.js';
import * as rembg from './rembgProvider.js';

export { MODEL_LICENCES, probeRembg, resetProbeCache, resolveModel } from './rembgProvider.js';
export { NEUTRAL_BACKGROUND } from './deterministicEngine.js';

/** Which engines are compiled into this build (no probing — that costs time). */
export const PROVIDERS = ['deterministic', 'rembg'];

function requestedProvider() {
  const raw = String(process.env.BGREMOVE_PROVIDER || 'auto').trim().toLowerCase();
  if (raw === 'auto') return 'auto';
  if (PROVIDERS.includes(raw)) return raw;
  throw new ApiError(
    500,
    `BGREMOVE_PROVIDER "${raw}" is not a known engine. Use auto, deterministic or rembg.`,
    'BGREMOVE_PROVIDER_UNKNOWN'
  );
}

/**
 * Resolve which engine will run, and why. Exposed so the API can describe the
 * server's capability to the admin UI (and so the smoke suite can assert it).
 */
export async function describeEngine() {
  const requested = requestedProvider();
  const probe = await rembg.probeRembg();
  let selected = 'deterministic';
  if (requested === 'rembg') selected = 'rembg';
  else if (requested === 'auto' && probe.available) selected = 'rembg';
  return {
    requested,
    selected,
    rembg: {
      available: probe.available,
      python: probe.python || null,
      reason: probe.reason || null,
    },
    model: selected === 'rembg' ? String(process.env.BGREMOVE_MODEL || 'u2net') : null,
    fallbackEnabled: process.env.BGREMOVE_FALLBACK !== '0',
  };
}

/**
 * Remove the background and return a NORMALIZED result:
 *   { engine, model, modelLicence, cutout, neutral, width, height,
 *     foregroundBox, metrics, warnings, confidence }
 */
export async function removeBackground(inputBuffer, options = {}) {
  const requested = requestedProvider();
  let plan = 'deterministic';

  if (requested === 'rembg') {
    plan = 'rembg';
  } else if (requested === 'auto') {
    const probe = await rembg.probeRembg();
    plan = probe.available ? 'rembg' : 'deterministic';
  }

  let result;
  let fallbackNote = null;

  if (plan === 'rembg') {
    try {
      result = await rembg.removeBackground(inputBuffer, options);
    } catch (err) {
      // Only an INFRASTRUCTURE failure falls back: an image the engine could
      // not segment is a real answer about that image and must reach the
      // administrator unchanged.
      const infra =
        err instanceof ApiError &&
        ['BGREMOVE_UNAVAILABLE', 'BGREMOVE_FAILED'].includes(err.code);
      if (!infra || process.env.BGREMOVE_FALLBACK === '0') throw err;
      result = await deterministic(inputBuffer, options);
      fallbackNote = `The ML engine (rembg) could not run — the built-in engine was used instead (${err.message})`;
    }
  } else {
    result = await deterministic(inputBuffer, options);
  }

  const neutral = result.neutral || (await composeNeutral(result.cutout));
  const warnings = [...(result.warnings || [])];
  const notes = [...(result.notes || [])];
  // A provider substitution is a WARNING, not a note: it changes what produced
  // the cutout, and the administrator is entitled to know the result came from
  // the fallback engine rather than the one they configured.
  if (fallbackNote) warnings.push(fallbackNote);

  return {
    engine: result.provider,
    model: result.model || null,
    modelLicence: result.modelLicence || null,
    cutout: result.cutout,
    neutral,
    width: result.width,
    height: result.height,
    foregroundBox: result.foregroundBox,
    metrics: result.metrics,
    warnings,
    notes,
    confidence: result.confidence,
  };
}
