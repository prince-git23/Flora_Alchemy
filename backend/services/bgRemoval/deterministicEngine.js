/**
 * 3D STUDIO — Phase 1 — the DETERMINISTIC background-removal engine.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 3D Studio must work on every deployment, including the ones where a
 * machine-learning runtime is not installed, and it must never lie about what
 * it did. This engine is the always-available path: `sharp` (Apache-2.0) does
 * the decoding and encoding, and the segmentation is plain, inspectable code —
 * no model weights, no downloads, no Python, and no licence question.
 *
 * WHAT IT IS GOOD AT
 * ------------------
 * Real product photography: a product on a plain, light, neutral or slowly
 * graded studio background (including seamless paper and soft shadow). For
 * those — the overwhelming majority of catalogue shots — it produces a clean
 * transparent cutout with soft, anti-aliased edges that keep petals, ribbon
 * ends and thin stems intact.
 *
 * WHAT IT IS NOT
 * --------------
 * It is NOT a matting network, so it cannot separate a product from a busy
 * scene (a florist's workbench, foliage behind a bouquet, a printed flyer with
 * photography, gradients, graphics and text). In those cases it reports low
 * confidence and specific warnings, and the caller routes the image to
 * NEEDS_REVIEW with the crop tool — it does not return a plausible-looking
 * damaged cutout and call it success. That honesty is a requirement, not a
 * nicety: a wrong cutout silently poisons the Phase 2 model.
 *
 * ALGORITHM (border-seeded flood fill with adaptive tolerance)
 * -----------------------------------------------------------
 *  1. auto-orient, crop to any administrator-supplied crop box, downscale so
 *     the long edge is at most `maxDimension` (the working resolution);
 *  2. model the background from the border ring: its mean colour, per-channel
 *     spread, and how uniform the ring is;
 *  3. flood fill inward from EVERY border pixel. A pixel joins the background
 *     when it is within tolerance of the pixel it was reached from (local
 *     continuity, which follows gradients) AND within a looser bound of the
 *     global background mean (which stops a fill from leaking into the
 *     product). The tolerance is derived from the measured ring spread, so a
 *     noisy background is treated as noisier instead of being cut into;
 *  4. foreground = everything the fill did not reach; background components
 *     that never touch the border are HOLES and are put back (a ribbon loop,
 *     a gap inside a bouquet);
 *  5. drop dust specks (connected components below a floor), count the
 *     substantial ones (a second product is a real signal, not a speck);
 *  6. turn the mask into an 8-bit alpha, blur it and remap the ramp so the
 *     core stays opaque while the boundary feathers — this is what preserves
 *     fine detail instead of stamping out jagged boolean edges;
 *  7. trim the excess border without ever cutting the product: the crop box is
 *     the foreground's own bounding box plus padding.
 */

import sharp from 'sharp';
import { ApiError } from '../../middleware/errorMiddleware.js';

/**
 * The one neutral background used for the preview that Phase 2 will consume.
 * A constant, not a per-shop setting: the point of the neutral preview is that
 * every reference image in a set is presented identically, so a pipeline can
 * compare them. Warm off-white reads as "studio" against Flora Alchemy's own
 * palette without being pure white (which clips highlights on pale petals).
 */
export const NEUTRAL_BACKGROUND = { r: 245, g: 242, b: 237 };
export const NEUTRAL_BACKGROUND_HEX = '#F5F2ED';

/** Working resolution ceiling for the analysis + output. 1600px on the long
 *  edge is ample for a reference image and keeps the fill O(n) and fast. */
const DEFAULT_MAX_DIMENSION = 1600;

/** A foreground component smaller than this fraction of the frame is dust. */
const SPECK_AREA_FRACTION = 0.003;
/** A foreground component at least this fraction is a SUBSTANTIAL object. */
const SUBSTANTIAL_AREA_FRACTION = 0.03;
/** Foreground covering more than this much of the frame means the fill failed. */
const FLOODED_AREA_FRACTION = 0.92;
/** Enclosed background regions at or below this fraction of the frame are noise
 *  gaps inside the product and are filled; larger ones are real holes (a
 *  wreath's centre, a handle) and stay transparent. */
const ENCLOSED_GAP_MAX_FRACTION = 0.015;
/** A filled gap at least this large is worth reporting; below it, it is
 *  boundary anti-aliasing and mentioning it would just be noise. */
const NOTICEABLE_GAP_FRACTION = 0.001;
/** Border contact above this fraction looks like a product running off-frame. */
const HEAVY_BORDER_CONTACT = 0.25;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Read the raw sRGB pixels of an image, auto-oriented, optionally cropped,
 * bounded in size. Throws the honest 422 the API contract promises when the
 * bytes are not a decodable image.
 */
async function readPixels(inputBuffer, { crop, maxDimension }) {
  let pipeline = sharp(inputBuffer, { failOn: 'error' }).rotate();
  let meta;
  try {
    meta = await pipeline.metadata();
  } catch (err) {
    throw new ApiError(422, 'That file is not a readable image.', 'UNREADABLE_IMAGE', {
      cause: err.message,
    });
  }
  if (!meta.width || !meta.height) {
    throw new ApiError(422, 'That image has no readable dimensions.', 'UNREADABLE_IMAGE');
  }

  // An administrator-supplied crop (normalized 0..1) is applied FIRST, on the
  // original pixels, so a crop never resamples an already-resized image.
  if (crop) {
    const rotated = meta.orientation && meta.orientation >= 5;
    const srcW = rotated ? meta.height : meta.width;
    const srcH = rotated ? meta.width : meta.height;
    const left = clamp(Math.round(crop.x * srcW), 0, srcW - 1);
    const top = clamp(Math.round(crop.y * srcH), 0, srcH - 1);
    const width = clamp(Math.round(crop.width * srcW), 1, srcW - left);
    const height = clamp(Math.round(crop.height * srcH), 1, srcH - top);
    pipeline = pipeline.extract({ left, top, width, height });
  }

  pipeline = pipeline
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .removeAlpha()
    .toColourspace('srgb');

  let data;
  let info;
  try {
    ({ data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true }));
  } catch (err) {
    throw new ApiError(422, 'That image could not be decoded for processing.', 'UNREADABLE_IMAGE', {
      cause: err.message,
    });
  }
  return { data, width: info.width, height: info.height, channels: info.channels, meta };
}

/**
 * Sample the border ring and describe the background:
 *   mean      — average colour of the ring
 *   spread    — the largest per-channel standard deviation in the ring
 *   variety   — distinct-ish colour count, used to spot busy/flyer edges
 */
function analyseBorder(data, width, height, channels) {
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.04));
  let n = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sr2 = 0;
  let sg2 = 0;
  let sb2 = 0;
  // Coarse colour histogram (4 bits/channel) to estimate how many different
  // colours the border contains — cheap proxy for "there is artwork here".
  const buckets = new Set();

  const sample = (x, y) => {
    const i = (y * width + x) * channels;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    n += 1;
    sr += r;
    sg += g;
    sb += b;
    sr2 += r * r;
    sg2 += g * g;
    sb2 += b * b;
    buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  };

  for (let y = 0; y < height; y += 1) {
    const nearTopOrBottom = y < ring || y >= height - ring;
    if (nearTopOrBottom) {
      for (let x = 0; x < width; x += 1) sample(x, y);
      continue;
    }
    for (let x = 0; x < width; x += 1) {
      if (x < ring || x >= width - ring) sample(x, y);
    }
  }

  const mean = { r: sr / n, g: sg / n, b: sb / n };
  const variance = (s2, s) => Math.max(0, s2 / n - (s / n) ** 2);
  const spread = Math.sqrt(
    Math.max(variance(sr2, sr), variance(sg2, sg), variance(sb2, sb))
  );
  return { mean, spread, ring, variety: buckets.size, samples: n };
}

/**
 * Flood fill the background inward from every border pixel.
 *
 * Two bounds, both measured rather than guessed:
 *   · LOCAL  — the colour distance to the neighbour the fill came from, which
 *     follows a gradient across the backdrop;
 *   · GLOBAL — the distance to the border mean, with a wider allowance, which
 *     stops a locally-plausible step from walking into the product.
 */
function floodBackground(data, width, height, channels, { mean, spread }) {
  const total = width * height;
  const isBg = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const localTol = clamp(22 + spread * 1.6, 22, 95);
  const globalTol = clamp(56 + spread * 2.2, 56, 150);
  const localTol2 = localTol * localTol;
  const globalTol2 = globalTol * globalTol;

  const push = (idx) => {
    if (isBg[idx]) return;
    isBg[idx] = 1;
    queue[tail] = idx;
    tail += 1;
  };

  // Seed: every border pixel must be reachable, otherwise a uniform backdrop
  // that touches one edge only would be half-filled.
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  const accepts = (idx, fromIdx) => {
    const i = idx * channels;
    const f = fromIdx * channels;
    const dr = data[i] - data[f];
    const dg = data[i + 1] - data[f + 1];
    const db = data[i + 2] - data[f + 2];
    if (dr * dr + dg * dg + db * db > localTol2) return false;
    const gr = data[i] - mean.r;
    const gg = data[i + 1] - mean.g;
    const gb = data[i + 2] - mean.b;
    return gr * gr + gg * gg + gb * gb <= globalTol2;
  };

  while (head < tail) {
    const idx = queue[head];
    head += 1;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) {
      const nIdx = idx - 1;
      if (!isBg[nIdx] && accepts(nIdx, idx)) push(nIdx);
    }
    if (x < width - 1) {
      const nIdx = idx + 1;
      if (!isBg[nIdx] && accepts(nIdx, idx)) push(nIdx);
    }
    if (y > 0) {
      const nIdx = idx - width;
      if (!isBg[nIdx] && accepts(nIdx, idx)) push(nIdx);
    }
    if (y < height - 1) {
      const nIdx = idx + width;
      if (!isBg[nIdx] && accepts(nIdx, idx)) push(nIdx);
    }
  }

  return isBg;
}

/**
 * Label the foreground into 4-connected components and return them largest
 * first. Two jobs: remove dust, and notice a second object (which is a real
 * signal an administrator should see rather than something to erase).
 */
function labelForeground(isBg, width, height) {
  const total = width * height;
  const seen = new Uint8Array(total);
  const components = [];
  const stack = new Int32Array(total);

  for (let start = 0; start < total; start += 1) {
    if (isBg[start] || seen[start]) continue;
    let top = 0;
    stack[top] = start;
    top += 1;
    seen[start] = 1;
    const pixels = [];
    while (top > 0) {
      top -= 1;
      const idx = stack[top];
      pixels.push(idx);
      const x = idx % width;
      const y = (idx - x) / width;
      if (x > 0) {
        const n = idx - 1;
        if (!isBg[n] && !seen[n]) {
          seen[n] = 1;
          stack[top] = n;
          top += 1;
        }
      }
      if (x < width - 1) {
        const n = idx + 1;
        if (!isBg[n] && !seen[n]) {
          seen[n] = 1;
          stack[top] = n;
          top += 1;
        }
      }
      if (y > 0) {
        const n = idx - width;
        if (!isBg[n] && !seen[n]) {
          seen[n] = 1;
          stack[top] = n;
          top += 1;
        }
      }
      if (y < height - 1) {
        const n = idx + width;
        if (!isBg[n] && !seen[n]) {
          seen[n] = 1;
          stack[top] = n;
          top += 1;
        }
      }
    }
    components.push(pixels);
  }

  components.sort((a, b) => b.length - a.length);
  return components;
}

/**
 * Resolve ENCLOSED regions — the part a connectivity-only fill gets wrong.
 *
 * The fill can only mark background it can REACH from the border, so a wreath's
 * centre, the inside of a handle, or the gap between stems is unreachable and
 * therefore indistinguishable from the product by connectivity alone. Treating
 * it as product (the first version of this file did exactly that) turns a
 * wreath into a solid disc, which is a wrong 3D reference.
 *
 * So enclosed regions get an INDEPENDENT test: does the pixel actually look like
 * the backdrop colour the border measured?
 *
 *   · background-coloured and enclosed and LARGE → a real hole; make it
 *     transparent (a wreath must stay a wreath);
 *   · background-coloured and enclosed and tiny → noise; keep it as product so
 *     the cutout has no pinholes.
 *
 * The residual risk is stated rather than hidden: a region of the PRODUCT whose
 * colour genuinely matches the backdrop (a cream ribbon on cream paper) can be
 * punched out if it is large. That is the trade-off a colour-only engine must
 * make, it is why the result is scored for confidence, and it is exactly the
 * case the rembg provider exists to handle better.
 */
function resolveEnclosedRegions(data, isBg, width, height, channels, { mean, globalTol }) {
  const total = width * height;
  const globalTol2 = globalTol * globalTol;

  // Background-LIKE by colour alone, independent of connectivity.
  const bgLike = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const o = i * channels;
    const dr = data[o] - mean.r;
    const dg = data[o + 1] - mean.g;
    const db = data[o + 2] - mean.b;
    bgLike[i] = dr * dr + dg * dg + db * db <= globalTol2 ? 1 : 0;
  }

  // Candidates: background-coloured pixels the fill never reached.
  const candidate = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) candidate[i] = !isBg[i] && bgLike[i] ? 1 : 0;

  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const ceiling = total * ENCLOSED_GAP_MAX_FRACTION;
  let gapsFilled = 0;
  let gapsNoticed = 0;
  let holesKept = 0;

  for (let start = 0; start < total; start += 1) {
    if (!candidate[start] || seen[start]) continue;
    let t = 0;
    stack[t] = start;
    t += 1;
    seen[start] = 1;
    const region = [];
    let touchesBorder = false;
    while (t > 0) {
      t -= 1;
      const idx = stack[t];
      region.push(idx);
      const x = idx % width;
      const y = (idx - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      const push = (n) => {
        if (candidate[n] && !seen[n]) {
          seen[n] = 1;
          stack[t] = n;
          t += 1;
        }
      };
      if (x > 0) push(idx - 1);
      if (x < width - 1) push(idx + 1);
      if (y > 0) push(idx - width);
      if (y < height - 1) push(idx + width);
    }

    if (touchesBorder) {
      // Reachable in principle, so it is outer background the local fill
      // refused (a slightly-off shade). Treat as product — the fill's local
      // continuity check is the stronger evidence — and say nothing.
      continue;
    }
    if (region.length <= ceiling) {
      gapsFilled += 1; // noise gap: stays part of the product
      // Only a SUBSTANTIAL gap is worth telling the administrator about;
      // single-pixel anti-aliasing gaps along an edge are normal at every
      // boundary and mentioning them would be noise.
      if (region.length >= total * NOTICEABLE_GAP_FRACTION) gapsNoticed += 1;
    } else {
      for (const idx of region) isBg[idx] = 1; // a real hole: transparent
      holesKept += 1;
    }
    if (process.env.BGREMOVE_DEBUG === '1') {
      console.log(
        `[bgremove] enclosed region ${region.length}px (${((region.length / total) * 100).toFixed(2)}% of frame) → ${region.length <= ceiling ? 'small: kept as product' : 'large: kept as a hole'}`
      );
    }
  }
  return { gapsFilled, gapsNoticed, holesKept };
}

/** Separable box blur, run twice to approximate a Gaussian. O(n) per pass. */
function boxBlur(src, width, height, radius) {
  if (radius < 1) return src;
  const size = width * height;
  let a = src;
  let b = new Float32Array(size);
  const pass = (input, output, horizontal) => {
    const outer = horizontal ? height : width;
    const inner = horizontal ? width : height;
    const step = horizontal ? 1 : width;
    for (let o = 0; o < outer; o += 1) {
      const base = horizontal ? o * width : o;
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const i = clamp(k, 0, inner - 1);
        sum += input[base + i * step];
      }
      const window = 2 * radius + 1;
      for (let i = 0; i < inner; i += 1) {
        output[base + i * step] = sum / window;
        const outIdx = clamp(i - radius, 0, inner - 1);
        const inIdx = clamp(i + radius + 1, 0, inner - 1);
        sum += input[base + inIdx * step] - input[base + outIdx * step];
      }
    }
  };
  pass(a, b, true);
  a = b;
  b = new Float32Array(size);
  pass(a, b, false);
  a = b;
  return a;
}

/**
 * The engine entry point.
 *
 * @returns {Promise<{
 *   provider: string, model: string,
 *   cutout: Buffer, neutral: Buffer,
 *   width: number, height: number,
 *   metrics: object, warnings: string[], confidence: number,
 *   foregroundBox: { left: number, top: number, width: number, height: number }
 * }>}
 */
export async function removeBackground(inputBuffer, options = {}) {
  const maxDimension = options.maxDimension || DEFAULT_MAX_DIMENSION;
  const { data, width, height, channels } = await readPixels(inputBuffer, {
    crop: options.crop || null,
    maxDimension,
  });

  const border = analyseBorder(data, width, height, channels);
  const isBg = floodBackground(data, width, height, channels, border);
  const { gapsFilled, gapsNoticed, holesKept } = resolveEnclosedRegions(data, isBg, width, height, channels, {
    mean: border.mean,
    globalTol: clamp(56 + border.spread * 2.2, 56, 150),
  });

  const total = width * height;
  const components = labelForeground(isBg, width, height);
  const speckFloor = Math.max(24, Math.round(total * SPECK_AREA_FRACTION));

  // Drop dust: a pixel-level speck is processing noise, never a product.
  const kept = components.filter((c) => c.length >= speckFloor);
  if (kept.length === 0) {
    // Two different failures get two different answers, because they need two
    // different actions from the administrator:
    //   · a genuinely blank frame (uniform colour, no detail) is a bad UPLOAD;
    //   · a busy frame the fill walked into is a bad SEPARATION — the product is
    //     there, this engine simply cannot find it, and the honest move is to
    //     say so and hand over the crop tool instead of shipping a wrong cutout.
    const looksEmpty = border.variety <= 3 && border.spread < 8;
    throw new ApiError(
      422,
      looksEmpty
        ? 'That frame looks empty — no product could be found in it.'
        : 'The product could not be separated from its background automatically. Crop tightly to the product and try again, or use a photo against a plain background.',
      looksEmpty ? 'NO_SUBJECT_DETECTED' : 'SEPARATION_FAILED'
    );
  }

  const keepMask = new Uint8Array(total);
  for (const component of kept) {
    for (const idx of component) keepMask[idx] = 1;
  }

  if (process.env.BGREMOVE_DEBUG === '1') {
    const cols = 45;
    const rows = Math.max(1, Math.round((cols * height) / width / 2));
    let art = '';
    for (let r = 0; r < rows; r += 1) {
      let line = '';
      for (let c = 0; c < cols; c += 1) {
        const x = Math.min(width - 1, Math.floor((c * width) / cols));
        const y = Math.min(height - 1, Math.floor((r * height) / rows));
        line += keepMask[y * width + x] ? '#' : isBg[y * width + x] ? '.' : 'o';
      }
      art += `${line}\n`;
    }
    console.log(
      `[bgremove] mask (# product, . reached background, o unreached) components=${components.length} ` +
        `sizes=[${components.slice(0, 6).map((c) => c.length).join(', ')}]\n${art}`
    );
  }
  const keptArea = kept.reduce((sum, c) => sum + c.length, 0);
  const removedSpecks = components.length - kept.length;

  // Substantial separate objects: reported, never silently erased.
  const substantial = kept.filter((c) => c.length >= total * SUBSTANTIAL_AREA_FRACTION);
  const secondObjectRatio = substantial.length > 1 ? substantial[1].length / substantial[0].length : 0;

  // COHERENCE — how much of the kept foreground is one object.
  //
  // This is the signal that separates a real product from a failed separation:
  // a product is one blob (largest ≈ everything kept), while a busy backdrop the
  // fill walked into comes back as a scatter of similarly-sized fragments. It is
  // reported as low confidence rather than thrown away, because a human can see
  // what happened and fix it with the crop tool.
  const largestShare = keptArea > 0 ? kept[0].length / keptArea : 0;

  // ── Alpha: feather the mask so edges keep their anti-aliasing ──────────
  const rawAlpha = new Float32Array(total);
  for (let i = 0; i < total; i += 1) rawAlpha[i] = keepMask[i];
  const featherRadius = clamp(Math.round(Math.min(width, height) / 500), 1, 4);
  let alpha = boxBlur(rawAlpha, width, height, featherRadius);
  alpha = boxBlur(alpha, width, height, featherRadius);
  const alphaBytes = Buffer.allocUnsafe(total);
  for (let i = 0; i < total; i += 1) {
    // Remap the blurred ramp: below the low cut is background, above the high
    // cut is product, and the band between is the soft edge.
    const v = clamp((alpha[i] - 0.18) / 0.64, 0, 1);
    alphaBytes[i] = Math.round(v * 255);
  }

  // ── Foreground bounding box, then trim without ever cutting the product ─
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < total; i += 1) {
    if (!keepMask[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = Math.round(Math.max(width, height) * 0.04);
  const box = {
    left: clamp(minX - pad, 0, width - 1),
    top: clamp(minY - pad, 0, height - 1),
    width: 0,
    height: 0,
  };
  box.width = clamp(maxX + 1 + pad, box.left + 1, width) - box.left;
  box.height = clamp(maxY + 1 + pad, box.top + 1, height) - box.top;

  // ── Compose the two outputs ────────────────────────────────────────────
  const rgbRaw = Buffer.from(data);
  const cutout = await sharp(rgbRaw, { raw: { width, height, channels: 3 } })
    .joinChannel(alphaBytes, { raw: { width, height, channels: 1 } })
    .extract(box)
    .png({ compressionLevel: 9 })
    .toBuffer();

  const neutral = await sharp(cutout)
    .flatten({ background: NEUTRAL_BACKGROUND })
    .png({ compressionLevel: 9 })
    .toBuffer();

  // ── Metrics, warnings and confidence ───────────────────────────────────
  const fgRatio = keptArea / total;
  let borderForeground = 0;
  let borderTotal = 0;
  for (let x = 0; x < width; x += 1) {
    for (const y of [0, height - 1]) {
      borderTotal += 1;
      if (keepMask[y * width + x]) borderForeground += 1;
    }
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (const x of [0, width - 1]) {
      borderTotal += 1;
      if (keepMask[y * width + x]) borderForeground += 1;
    }
  }
  const borderContact = borderTotal ? borderForeground / borderTotal : 0;

  // Two channels, on purpose:
  //   warnings — a human must look before this reference is used;
  //   notes    — the engine did something worth recording, but nothing is
  //              wrong (specks ignored, gaps filled, a hole kept open).
  // Collapsing them would make every clean cutout land in NEEDS_REVIEW.
  const warnings = [];
  const notes = [];
  if (borderContact > HEAVY_BORDER_CONTACT && fgRatio > 0.5) {
    warnings.push('Product edges could not be isolated accurately.');
    warnings.push('The product may be cropped too tightly.');
  }
  if (fgRatio > FLOODED_AREA_FRACTION) {
    warnings.push('The background could not be separated from the product — the whole frame was treated as the product.');
  }
  if (secondObjectRatio > 0.25) {
    warnings.push('This image may contain multiple products.');
  }
  if (largestShare < 0.55) {
    warnings.push('Product edges could not be isolated accurately.');
  }
  if (border.spread > 35) {
    warnings.push('The background is not uniform — the cutout edges may include detail that is not the product.');
  }
  if (border.variety >= 40) {
    warnings.push('This frame contains a lot of graphic or promotional artwork — check that the crop covers only the product.');
  }
  if (removedSpecks > 0) {
    notes.push(`Ignored ${removedSpecks} isolated speck${removedSpecks === 1 ? '' : 's'} in the background.`);
  }
  if (gapsNoticed > 0) {
    notes.push(`Filled ${gapsNoticed} gap${gapsNoticed === 1 ? '' : 's'} inside the product so the cutout has no pinholes.`);
  }
  if (holesKept > 0) {
    notes.push(`Kept ${holesKept} open region${holesKept === 1 ? '' : 's'} (a loop or handle) transparent.`);
  }

  // Confidence is a blend of four measured facts, none of them a guess:
  //   · the backdrop was uniform (a busy backdrop is the main cause of error);
  //   · the product occupies a plausible share of the frame;
  //   · it does not run off the edge; and
  //   · what was kept hangs together as ONE object.
  // The last is weighted heaviest after uniformity because it is the most
  // direct evidence that the separation did what it claims.
  const spreadScore = clamp(1 - border.spread / 90, 0, 1);
  const coverageScore = fgRatio > FLOODED_AREA_FRACTION ? 0.15 : clamp(1 - Math.abs(fgRatio - 0.38) / 0.6, 0, 1);
  const contactScore = clamp(1 - borderContact / 0.35, 0, 1);
  const coherenceScore = clamp(largestShare, 0, 1);
  const confidence = Number(
    (
      spreadScore * 0.4 +
      coverageScore * 0.2 +
      contactScore * 0.15 +
      coherenceScore * 0.25
    ).toFixed(3)
  );

  return {
    provider: 'deterministic',
    model: 'border-flood-fill-v1',
    cutout,
    neutral,
    width: box.width,
    height: box.height,
    foregroundBox: box,
    metrics: {
      sourceWidth: width,
      sourceHeight: height,
      analysisWidth: width,
      analysisHeight: height,
      foregroundRatio: Number(fgRatio.toFixed(4)),
      borderContact: Number(borderContact.toFixed(4)),
      backgroundSpread: Number(border.spread.toFixed(2)),
      backgroundVariety: border.variety,
      components: kept.length,
      componentCount: components.length,
      largestShare: Number(largestShare.toFixed(4)),
      removedSpecks,
      gapsFilled,
      holesKept,
      featherRadius,
      confidence,
    },
    warnings,
    notes,
    confidence,
  };
}

/**
 * The cutout → neutral compositing used by EVERY provider, so the neutral
 * preview is byte-identical in intent no matter how the alpha was produced.
 */
export async function composeNeutral(cutoutBuffer) {
  return sharp(cutoutBuffer)
    .flatten({ background: NEUTRAL_BACKGROUND })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
