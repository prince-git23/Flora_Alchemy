/**
 * 3D STUDIO — Phase 1 — validation and honest quality heuristics.
 *
 * Two layers, deliberately separated:
 *
 *  1. FACTS — is this a real image? what format, how many pixels, is it
 *     readable, is it actually empty? These are decidable and are enforced:
 *     an unreadable or absurd file is rejected, not warned about.
 *
 *  2. HEURISTICS — blur, contrast, "these might be different products". These
 *     are ESTIMATES from cheap measurements, and every message is worded as a
 *     possibility ("may", "appears to"). The brief is explicit that we must not
 *     claim precise camera-angle detection or reliable object matching unless
 *     it is genuinely implemented — it is not, so the wording never does.
 *
 * There are deliberately NO BACKGROUND-SEGMENTATION WARNINGS here any more
 * ("the background could not be separated", "multiple products may be present").
 * Those messages described a cutout that no longer exists; keeping them would
 * tell an administrator their multi-view bouquet is "several products" and
 * invite them to fight a feature that is gone. What remains describes the
 * PHOTOGRAPH — size, sharpness, contrast, duplicates — which is useful whatever
 * the reconstruction model turns out to be.
 *
 * Deliberately dependency-light: `sharp` statistics and a small HSL histogram,
 * no second ML model. A quality gate that costs more than the pipeline it
 * guards would be replaced by nothing.
 */

import sharp from 'sharp';
import crypto from 'node:crypto';
import { ApiError } from '../middleware/errorMiddleware.js';

/** Facts the pipeline needs to store about every accepted upload. */
export const IMAGE_RULES = {
  /** Smallest sensible long edge. Below this a cutout is too coarse for 3D. */
  minLongEdge: 500,
  /** Beyond this the pipeline's own downscale is pointless and memory hurts. */
  maxLongEdge: 12_000,
  /** ~48 MP. A camera JPEG is 24 MP; this is a sanity ceiling, not a policy. */
  maxPixels: 48_000_000,
  /** Formats the browser can display AND sharp can decode. */
  allowedFormats: ['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif'],
};

/**
 * Sharp's reported format is derived from the DECODED container, not the
 * request's MIME claim, which is why the MIME header alone is never trusted.
 */
export async function inspectImage(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new ApiError(422, 'The uploaded file is empty.', 'EMPTY_FILE');
  }
  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch (err) {
    throw new ApiError(
      422,
      'That file is not a readable image — it may be corrupt or not an image at all.',
      'UNREADABLE_IMAGE',
      { cause: err.message }
    );
  }
  const format = String(meta.format || '').toLowerCase();
  if (!format) {
    throw new ApiError(422, 'That file has no recognisable image format.', 'UNREADABLE_IMAGE');
  }
  if (!IMAGE_RULES.allowedFormats.includes(format)) {
    throw new ApiError(
      422,
      `Unsupported image format "${format}". Use ${IMAGE_RULES.allowedFormats.join(', ')}.`,
      'UNSUPPORTED_FORMAT'
    );
  }
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) {
    throw new ApiError(422, 'That image has no readable dimensions.', 'UNREADABLE_IMAGE');
  }
  const pixels = width * height;
  if (pixels > IMAGE_RULES.maxPixels) {
    throw new ApiError(
      422,
      `That image is too large to process (${width}×${height}). The limit is ${IMAGE_RULES.maxPixels.toLocaleString()} pixels.`,
      'IMAGE_TOO_LARGE'
    );
  }
  return {
    width,
    height,
    pixels,
    format,
    bytes: buffer.length,
    hasAlpha: Boolean(meta.hasAlpha),
    orientation: meta.orientation || 1,
    aspect: Number((width / height).toFixed(4)),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

/**
 * Sharpness proxy: how much HIGH-FREQUENCY detail the image contains.
 *
 * A difference-of-blur is used rather than a Laplacian kernel because sharp's
 * `convolve` normalises by the kernel sum — and a Laplacian kernel sums to ZERO,
 * so the convolution silently became a no-op and every image measured the same
 * (an earlier revision of this function did exactly that, which is why this
 * comment exists). Photo minus blurred-photo isolates edges with no such trap.
 *
 * Everything is measured on a 1024px copy, so the score is directly comparable
 * between a 900px phone export and a 24MP studio frame — and cheap.
 *
 * `edgeStdev`        mean edge strength (the blur signal)
 * `contrastStdev`    overall tonal spread (the low-contrast signal)
 */
export async function measureSharpness(buffer) {
  try {
    const prepared = await sharp(buffer, { failOn: 'error' })
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .greyscale()
      .png()
      .toBuffer();
    const blurred = await sharp(prepared).blur(3).png().toBuffer();
    // NOTE: sharp's `stats()` reports statistics for the INPUT image, not the
    // pipeline — so the difference must be MATERIALISED into a buffer first.
    // Calling `.stats()` straight off `composite()` silently returns the input's
    // own numbers, which made every image measure identically.
    const diffBuffer = await sharp(prepared)
      .composite([{ input: blurred, blend: 'difference' }])
      .png()
      .toBuffer();
    const diff = await sharp(diffBuffer).stats();
    const base = await sharp(
      await sharp(prepared).greyscale().png().toBuffer()
    ).stats();
    const edgeStdev = diff.channels[0]?.stdev ?? 0;
    const contrastStdev = base.channels[0]?.stdev ?? 0;
    const edgeMean = diff.channels[0]?.mean ?? 0;
    return {
      edgeStdev: Number(edgeStdev.toFixed(3)),
      edgeMean: Number(edgeMean.toFixed(3)),
      contrastStdev: Number(contrastStdev.toFixed(3)),
      sharpnessScore: Number(edgeStdev.toFixed(3)),
    };
  } catch {
    // Measurement failure must never fail the upload — it is a warning source.
    return { edgeStdev: null, edgeMean: null, contrastStdev: null, sharpnessScore: null };
  }
}

/** HSL-ish signature: an aspect ratio plus a 12-bin hue histogram weighted by
 *  saturation, computed on a 64px thumbnail. Cheap, and enough to say "these
 *  two pictures do not look like the same thing". */
export async function imageSignature(buffer) {
  try {
    const { data, info } = await sharp(buffer, { failOn: 'error' })
      .resize(64, 64, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bins = new Array(12).fill(0);
    let saturationSum = 0;
    let counted = 0;
    for (let i = 0; i < info.width * info.height; i += 1) {
      const r = data[i * info.channels] / 255;
      const g = data[i * info.channels + 1] / 255;
      const b = data[i * info.channels + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1) || 1);
      saturationSum += s;
      counted += 1;
      if (d === 0 || s < 0.12) continue; // near-grey contributes no hue
      let h;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = ((h * 60) + 360) % 360;
      bins[Math.floor(h / 30)] += s;
    }
    const binTotal = bins.reduce((a, v) => a + v, 0) || 1;
    const meta = await sharp(buffer).metadata();
    return {
      hueHistogram: bins.map((v) => Number((v / binTotal).toFixed(4))),
      meanSaturation: Number((saturationSum / Math.max(1, counted)).toFixed(4)),
      aspect: Number(((meta.width || 1) / (meta.height || 1)).toFixed(4)),
    };
  } catch {
    return null;
  }
}

/** Histogram distance, 0 (identical) → 1 (nothing in common). */
function histogramDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / 2;
}

const BLURRY_SHARPNESS_BELOW = 0.9;
const LOW_CONTRAST_BELOW = 16;
const DIFFERENT_PRODUCT_DISTANCE = 0.62;
const SAME_VIEW_DISTANCE = 0.06;

/**
 * Per-image quality warnings. `inspect` comes from `inspectImage`, `quality`
 * from `measureSharpness`, and `metrics` from the processor (optional: the
 * validation runs at upload time, before processing).
 */
export function imageWarnings({ inspect, quality, duplicateOf = null }) {
  const warnings = [];
  const notes = [];
  const longEdge = Math.max(inspect.width, inspect.height);
  if (longEdge < IMAGE_RULES.minLongEdge) {
    warnings.push(
      `This image is only ${inspect.width}×${inspect.height}. A long edge of at least ${IMAGE_RULES.minLongEdge}px gives a usable 3D reference.`
    );
  }
  if (quality?.sharpnessScore !== null && quality?.sharpnessScore < BLURRY_SHARPNESS_BELOW) {
    warnings.push('This image appears too blurry for reliable 3D reconstruction.');
  }
  if (quality?.contrastStdev !== null && quality.contrastStdev < LOW_CONTRAST_BELOW) {
    warnings.push('This image has very low contrast, so shape and material detail may be hard to read.');
  }
  if (!inspect.hasAlpha && inspect.format === 'png') {
    // Informational only: an opaque PNG is perfectly fine, it just gains nothing
    // from being a PNG.
    notes.push('This PNG has no transparency — it will be treated like a photograph.');
  }
  if (duplicateOf) {
    warnings.push(`This looks like the same file as reference ${duplicateOf} — it will not add a new angle.`);
  }
  return { warnings, notes };
}

/**
 * Set-level warnings across all references of one product.
 *
 * Returns `{ warnings, perImage }` where `perImage` maps an image id to the
 * warnings that only make sense in set context (currently: "these may be
 * different products", "add another view").
 */
export function setWarnings(images) {
  const signatures = images
    .filter((img) => img.signature)
    .map((img) => ({ id: img.id, ...img.signature }));
  const perImage = {};
  const warnings = [];
  const notes = [];

  if (signatures.length >= 2) {
    // Pairwise: the MOST different pair decides whether the set looks mixed.
    let worst = { distance: 0, a: null, b: null };
    let closest = { distance: 1, a: null, b: null };
    for (let i = 0; i < signatures.length; i += 1) {
      for (let j = i + 1; j < signatures.length; j += 1) {
        const d = histogramDistance(signatures[i].hueHistogram, signatures[j].hueHistogram);
        if (d > worst.distance) worst = { distance: d, a: signatures[i].id, b: signatures[j].id };
        if (d < closest.distance) closest = { distance: d, a: signatures[i].id, b: signatures[j].id };
      }
    }
    if (worst.distance >= DIFFERENT_PRODUCT_DISTANCE) {
      const message =
        'These views look quite different in colour — check that every reference is the same piece. A multi-view set of one product is expected to vary in angle, not in colour.';
      warnings.push(message);
      perImage[worst.a] = [...(perImage[worst.a] || []), message];
      perImage[worst.b] = [...(perImage[worst.b] || []), message];
    }
    if (closest.distance <= SAME_VIEW_DISTANCE) {
      const message = 'These images look like the same view — add a side or back view for better 3D reconstruction.';
      perImage[closest.a] = [...(perImage[closest.a] || []), message];
      perImage[closest.b] = [...(perImage[closest.b] || []), message];
    }
  }
  if (signatures.length === 1) {
    notes.push('A single reference works, but a second view (side or back) materially improves 3D reconstruction.');
  }
  return { warnings, notes, perImage };
}

export const VALIDATION_TUNING = {
  BLURRY_SHARPNESS_BELOW,
  LOW_CONTRAST_BELOW,
  DIFFERENT_PRODUCT_DISTANCE,
  SAME_VIEW_DISTANCE,
};
