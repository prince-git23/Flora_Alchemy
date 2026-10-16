/**
 * 3D STUDIO — Phase 1 — one way to describe a cutout.
 *
 * Whatever produced the alpha (the deterministic fill, or a model), the
 * administrator sees the same measures and the same vocabulary, and the
 * pipeline stores the same fields. Without this, the two engines would drift
 * into reporting different things about the same picture, and Phase 2 would
 * have to trust two shapes.
 *
 * It also does the TRIMMING: a provider may return a full-frame cutout, so the
 * excess border is removed here (alpha bounding box + padding, never cutting
 * the subject) and the returned buffer is the trimmed one.
 */

import sharp from 'sharp';
import { ApiError } from '../../middleware/errorMiddleware.js';

/** Alpha at or above this counts as subject for the bounding box. */
const ALPHA_THRESHOLD = 8;
/** Border contact above this fraction is heavy — the subject runs off-frame. */
const HEAVY_BORDER_CONTACT = 0.25;
/** A subject covering almost everything means the alpha is effectively solid. */
const SOLID_FRACTION = 0.92;

/**
 * Measure and trim a cutout.
 *
 * @param {Buffer} pngBuffer RGBA PNG with an alpha channel
 * @param {{padFraction?: number}} [options]
 * @returns {Promise<{
 *   cutout: Buffer, width: number, height: number,
 *   foregroundBox: {left:number, top:number, width:number, height:number},
 *   metrics: object, warnings: string[], confidence: number
 * }>}
 */
export async function analyseCutout(pngBuffer, { padFraction = 0.04 } = {}) {
  let raw;
  let info;
  try {
    ({ data: raw, info } = await sharp(pngBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch (err) {
    throw new ApiError(422, 'The processed image could not be read back.', 'PROCESSING_FAILED', {
      cause: err.message,
    });
  }
  const { width, height, channels } = info;
  if (!width || !height) {
    throw new ApiError(422, 'The processed image has no readable dimensions.', 'PROCESSING_FAILED');
  }
  const total = width * height;
  const alpha = new Uint8Array(total);
  let transparent = 0;
  let opaque = 0;
  let sum = 0;
  for (let i = 0; i < total; i += 1) {
    const a = raw[i * channels + (channels - 1)];
    alpha[i] = a;
    sum += a;
    if (a <= ALPHA_THRESHOLD) transparent += 1;
    else if (a >= 247) opaque += 1;
  }
  const meanAlpha = sum / total;
  const subjectPixels = total - transparent;
  const fgRatio = subjectPixels / total;

  if (subjectPixels === 0) {
    throw new ApiError(
      422,
      'The processed image came back fully transparent — nothing was left of the product.',
      'NO_SUBJECT_DETECTED'
    );
  }
  const fullyTransparent = transparent === total;
  if (fullyTransparent) {
    throw new ApiError(422, 'Nothing was left of the product.', 'NO_SUBJECT_DETECTED');
  }

  // Bounding box of the subject.
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < total; i += 1) {
    if (alpha[i] <= ALPHA_THRESHOLD) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = Math.round(Math.max(width, height) * padFraction);
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width, maxX + 1 + pad);
  const bottom = Math.min(height, maxY + 1 + pad);
  const box = { left, top, width: right - left, height: bottom - top };

  const cutout = await sharp(pngBuffer)
    .ensureAlpha()
    .extract(box)
    .png({ compressionLevel: 9 })
    .toBuffer();

  // Border contact, measured on the UNTRIMMED frame: it is a property of how
  // the subject sat in the original photograph.
  let borderSubject = 0;
  let borderTotal = 0;
  const at = (x, y) => alpha[y * width + x] > ALPHA_THRESHOLD;
  for (let x = 0; x < width; x += 1) {
    for (const y of [0, height - 1]) {
      borderTotal += 1;
      if (at(x, y)) borderSubject += 1;
    }
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (const x of [0, width - 1]) {
      borderTotal += 1;
      if (at(x, y)) borderSubject += 1;
    }
  }
  const borderContact = borderTotal ? borderSubject / borderTotal : 0;

  const warnings = [];
  if (fgRatio > SOLID_FRACTION) {
    warnings.push('Almost the whole frame is opaque — the background may not have been removed.');
  }
  if (borderContact > HEAVY_BORDER_CONTACT) {
    warnings.push('The product touches the edge of the frame — it may be cropped too tightly.');
  }
  if (fgRatio < 0.02) {
    warnings.push('Very little of the frame looks like product — check that the crop covers the product.');
  }

  // Confidence is about the ALPHA's own quality: a healthy cutout has a mostly
  // opaque core, a meaningful amount of transparency around it, and soft edges
  // (values strictly between the two). An alpha that is essentially binary or
  // essentially solid is the signature of a failed separation.
  const softFraction = (total - transparent - opaque) / total;
  const transparencyScore = Math.min(1, (1 - fgRatio) / 0.6);
  const edgeScore = Math.min(1, softFraction / 0.04);
  const coreScore = Math.min(1, opaque / total / 0.25);
  const confidence = Number(
    (transparencyScore * 0.45 + edgeScore * 0.25 + coreScore * 0.3).toFixed(3)
  );

  return {
    cutout,
    width: box.width,
    height: box.height,
    foregroundBox: box,
    metrics: {
      sourceWidth: width,
      sourceHeight: height,
      foregroundRatio: Number(fgRatio.toFixed(4)),
      borderContact: Number(borderContact.toFixed(4)),
      meanAlpha: Number(meanAlpha.toFixed(2)),
      softEdgeFraction: Number(softFraction.toFixed(4)),
      confidence,
    },
    warnings,
    confidence,
  };
}
