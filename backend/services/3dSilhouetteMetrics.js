/**
 * 3D STUDIO — Phase 5 — compare a projected model silhouette with a product cutout.
 *
 * The whole point of this module is to answer "does the generated shape look like
 * the thing in the photograph?" in a way that is REPRODUCIBLE and EXPLAINABLE,
 * rather than as one opaque percentage. It reports the individual measures the
 * Phase 5 brief asks for, and it declares its own uncertainty rather than
 * presenting a guess as a measurement.
 *
 * THE ALIGNMENT RULE (why the numbers mean what they say)
 * ------------------------------------------------------
 * Two shapes are compared after removing TRANSLATION and UNIFORM SCALE only.
 * That is a similarity transform: the photographer's framing and the mesh's
 * arbitrary units both stop mattering, while a genuine shape difference — wrong
 * proportions, a missing handle, a squashed box — still shows up as a lower
 * overlap. Non-uniform warping (stretching x and y independently to force a
 * match) is deliberately NOT used: it would make an incorrectly proportioned
 * model score as a correct one, which is the one failure mode this whole phase
 * exists to prevent.
 *
 * WHAT "UNCERTAIN" MEANS HERE
 * ---------------------------
 * A generated asset can arrive in any orientation, and nothing in the stored
 * asset records which way it faces. So several orthographic views are scored and
 * the best one is reported — along with how much better it was than the
 * runner-up. When the winner is barely ahead of another orientation, the result
 * depends on an assumed viewing angle and the report says so
 * (`viewAgreement: 'ambiguous'`). Never treat a single assumed camera as a
 * photograph of the real product.
 */

/** Canonical grid both masks are resampled into before comparison. */
export const CANONICAL_SIZE = 144;
/** Fraction of the canonical grid the object's longer side occupies. */
const FIT_FRACTION = 0.9;

/** A cutout pixel counts as subject at or above this alpha (matches Phase 1). */
export const ALPHA_THRESHOLD = 8;

/**
 * Build a binary mask from raw RGBA pixels — the shape Phase 1's cutout is
 * decoded into. Pure: no image library is involved, so the metric code can be
 * exercised on synthetic masks.
 */
export function maskFromPixels(raw, width, height, channels, { alphaThreshold = ALPHA_THRESHOLD } = {}) {
  if (!raw || !width || !height || !channels) {
    return { mask: null, width: 0, height: 0, error: 'NO_PIXELS' };
  }
  const mask = new Uint8Array(width * height);
  let subject = 0;
  for (let i = 0; i < width * height; i += 1) {
    const alpha = raw[i * channels + (channels - 1)];
    if (alpha > alphaThreshold) {
      mask[i] = 1;
      subject += 1;
    }
  }
  return {
    mask,
    width,
    height,
    subject,
    coverage: subject / (width * height),
    error: subject === 0 ? 'EMPTY_MASK' : '',
  };
}

/**
 * Label the mask's 4-connected components, largest first.
 *
 * This exists because BOTH sides of the comparison arrive dirty in practice: a
 * photograph's cutout carries stray alpha specks (a shadow, a leaf, a JPEG
 * artefact survived the threshold), and a reconstructed mesh carries floating
 * fragments of its own. Left in, those specks are not a small error — they are a
 * catastrophic one, because the bounding box that normalisation uses is defined
 * by the extreme pixels, so ONE speck 200px from the product changes the frame
 * the whole comparison happens in.
 */
export function connectedComponents(mask, width, height) {
  const labels = new Int32Array(width * height).fill(-1);
  const components = [];
  const stack = [];
  for (let start = 0; start < width * height; start += 1) {
    if (!mask[start] || labels[start] !== -1) continue;
    const id = components.length;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const index = stack.pop();
      const x = index % width;
      const y = (index - x) / width;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[index - 1] && labels[index - 1] === -1) {
        labels[index - 1] = id;
        stack.push(index - 1);
      }
      if (x < width - 1 && mask[index + 1] && labels[index + 1] === -1) {
        labels[index + 1] = id;
        stack.push(index + 1);
      }
      if (y > 0 && mask[index - width] && labels[index - width] === -1) {
        labels[index - width] = id;
        stack.push(index - width);
      }
      if (y < height - 1 && mask[index + width] && labels[index + width] === -1) {
        labels[index + width] = id;
        stack.push(index + width);
      }
    }
    components.push({ id, area, box: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } });
  }
  components.sort((a, b) => b.area - a.area);
  return { labels, components };
}

/**
 * Drop everything except the subject, and say what was dropped.
 *
 * The rule is a fraction of the LARGEST component (default 2%), which is scale
 * free and needs no per-image tuning: a fragment worth less than a fiftieth of
 * the product is noise, while a genuinely two-part product (a lid beside a box)
 * survives. Nothing is dropped silently — the report carries the counts, so a
 * model that is mostly confetti is visible as exactly that.
 */
export function cleanMask(source, { minAreaFraction = 0.02, minAreaPixels = 12 } = {}) {
  const { mask, width, height } = source;
  if (!mask || !width || !height) return { ...source, cleaning: null };
  const { labels, components } = connectedComponents(mask, width, height);
  if (components.length <= 1) {
    const only = components[0] || null;
    return {
      mask,
      width,
      height,
      subject: only ? only.area : 0,
      coverage: only ? only.area / (width * height) : 0,
      box: only ? only.box : null,
      cleaning: {
        components: components.length,
        kept: components.length,
        dropped: 0,
        droppedPixels: 0,
        droppedFraction: 0,
        largestFraction: 1,
      },
    };
  }
  const largest = components[0].area;
  const threshold = Math.max(minAreaPixels, largest * minAreaFraction);
  const keep = new Set(components.filter((c) => c.area >= threshold).map((c) => c.id));
  const cleaned = new Uint8Array(width * height);
  let subject = 0;
  let droppedPixels = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const label = labels[i];
    if (label === -1) continue;
    if (keep.has(label)) {
      cleaned[i] = 1;
      subject += 1;
    } else {
      droppedPixels += 1;
    }
  }
  const total = components.reduce((acc, c) => acc + c.area, 0);
  return {
    mask: cleaned,
    width,
    height,
    subject,
    coverage: subject / (width * height),
    box: maskBox(cleaned, width, height),
    cleaning: {
      components: components.length,
      kept: keep.size,
      dropped: components.length - keep.size,
      droppedPixels,
      droppedFraction: total ? Number((droppedPixels / total).toFixed(4)) : 0,
      largestFraction: total ? Number((largest / total).toFixed(4)) : 1,
    },
  };
}

/** Bounding box of the set pixels, or null when there are none. */
export function maskBox(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Centroid of the set pixels in frame coordinates, or null. */
export function maskCentroid(mask, width, height) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      sx += x;
      sy += y;
      n += 1;
    }
  }
  if (!n) return null;
  return { x: sx / n, y: sy / n, count: n };
}

/**
 * Resample a mask into the canonical grid with a UNIFORM scale, centred.
 *
 * Destinations are area-averaged (a destination pixel gets the fraction of its
 * source footprint that was set), which is what keeps a 425×277 cutout and a
 * 144² rasterisation comparable without aliasing artefacts deciding the score.
 * Anything above half coverage becomes set in the returned binary mask.
 */
export function normaliseMask(source, { size = CANONICAL_SIZE, fit = FIT_FRACTION, clean = true } = {}) {
  // Cleaning first is not cosmetic: the box below is taken from the extreme
  // pixels, so a single speck decides the whole frame. Both sides get the same
  // treatment, which is why the cleaning lives here rather than at the callers.
  const prepared = clean ? cleanMask(source) : source;
  const box = prepared.box || maskBox(prepared.mask, prepared.width, prepared.height);
  if (!box) return null;
  const origin = { mask: prepared.mask, width: prepared.width, height: prepared.height };

  const longer = Math.max(box.width, box.height);
  const target = fit * size;
  const scale = target / longer;
  const outW = Math.max(1, Math.round(box.width * scale));
  const outH = Math.max(1, Math.round(box.height * scale));
  const offsetX = Math.floor((size - outW) / 2);
  const offsetY = Math.floor((size - outH) / 2);

  const refined = new Float32Array(size * size);
  for (let dy = 0; dy < outH; dy += 1) {
    const sy0 = box.minY + (dy / outH) * box.height;
    const sy1 = box.minY + ((dy + 1) / outH) * box.height;
    for (let dx = 0; dx < outW; dx += 1) {
      const sx0 = box.minX + (dx / outW) * box.width;
      const sx1 = box.minX + ((dx + 1) / outW) * box.width;
      let on = 0;
      let total = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy += 1) {
        if (sy < 0 || sy >= origin.height) continue;
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx += 1) {
          if (sx < 0 || sx >= origin.width) continue;
          total += 1;
          if (origin.mask[sy * origin.width + sx]) on += 1;
        }
      }
      if (total) refined[(offsetY + dy) * size + offsetX + dx] = on / total;
    }
  }

  const mask = new Uint8Array(size * size);
  let set = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (refined[i] >= 0.5) {
      mask[i] = 1;
      set += 1;
    }
  }
  return {
    mask,
    width: size,
    height: size,
    subject: set,
    coverage: set / (size * size),
    box: maskBox(mask, size, size),
    sourceBox: box,
    sourceAspect: Number((box.width / box.height).toFixed(4)),
    scale: Number(scale.toFixed(6)),
    offset: { x: offsetX, y: offsetY },
    cleaning: prepared.cleaning || null,
  };
}

/**
 * Chamfer distance transform: for every pixel, the approximate distance to the
 * nearest set pixel. Two passes with the classic 3-4 weights — accurate enough
 * for a shape metric and O(n), with no external library.
 */
function distanceTransform(mask, size) {
  const INF = 1e9;
  const dist = new Float32Array(size * size);
  for (let i = 0; i < dist.length; i += 1) dist[i] = mask[i] ? 0 : INF;
  const d = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? INF : dist[y * size + x]);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      let value = dist[i];
      value = Math.min(value, d(x - 1, y) + 3, d(x, y - 1) + 3, d(x - 1, y - 1) + 4, d(x + 1, y - 1) + 4);
      dist[i] = value;
    }
  }
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = size - 1; x >= 0; x -= 1) {
      const i = y * size + x;
      let value = dist[i];
      value = Math.min(value, d(x + 1, y) + 3, d(x, y + 1) + 3, d(x + 1, y + 1) + 4, d(x - 1, y + 1) + 4);
      dist[i] = value;
    }
  }
  return dist;
}

/** Pixels of `mask` that have at least one unset 4-neighbour. */
function boundaryPixels(mask, size) {
  const out = [];
  const at = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : mask[y * size + x]);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!mask[y * size + x]) continue;
      if (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1)) out.push(y * size + x);
    }
  }
  return out;
}

/**
 * Compare two NORMALISED masks.
 *
 * Returns the individual measures the report shows, each with a definition a
 * reader can reproduce:
 *   · `iou`                  intersection over union of the aligned silhouettes;
 *   · `aspectError`          |model aspect − reference aspect| / reference aspect;
 *   · `coverageDelta`        difference in the share of the frame each occupies;
 *   · `contourDistanceMean`  symmetric mean boundary distance, in grid units;
 *   · `frameCentroidOffset`  how far off-centre the model sat in ITS OWN frame,
 *                            before alignment — an off-origin mesh is a real
 *                            asset defect even when its shape is fine.
 */
export function compareNormalised(model, reference, { size = CANONICAL_SIZE } = {}) {
  if (!model || !reference) return null;

  let intersection = 0;
  let union = 0;
  for (let i = 0; i < size * size; i += 1) {
    const a = model.mask[i];
    const b = reference.mask[i];
    if (a && b) intersection += 1;
    if (a || b) union += 1;
  }
  const iou = union ? intersection / union : 0;

  const modelBoundary = boundaryPixels(model.mask, size);
  const refBoundary = boundaryPixels(reference.mask, size);
  const refDist = distanceTransform(reference.mask, size);
  const modelDist = distanceTransform(model.mask, size);
  const mean = (list, dist) => (list.length ? list.reduce((acc, i) => acc + dist[i], 0) / list.length : 0);
  // Chamfer weights are 3 per orthogonal step, so a unit is a third of a pixel.
  const toReference = mean(modelBoundary, refDist) / 3;
  const toModel = mean(refBoundary, modelDist) / 3;
  const contourDistancePixels = (toReference + toModel) / 2;

  const refAspect = reference.sourceAspect || reference.box.width / reference.box.height;
  const modelAspect = model.sourceAspect || model.box.width / model.box.height;

  return {
    iou: Number(iou.toFixed(4)),
    intersection,
    union,
    modelCoverage: Number(model.coverage.toFixed(4)),
    referenceCoverage: Number(reference.coverage.toFixed(4)),
    coverageDelta: Number(Math.abs(model.coverage - reference.coverage).toFixed(4)),
    modelAspect: Number(modelAspect.toFixed(4)),
    referenceAspect: Number(refAspect.toFixed(4)),
    aspectError: Number((Math.abs(modelAspect - refAspect) / (refAspect || 1e-9)).toFixed(4)),
    contourDistancePixels: Number(contourDistancePixels.toFixed(2)),
    contourDistance: Number((contourDistancePixels / size).toFixed(4)),
    modelBoundaryPixels: modelBoundary.length,
    referenceBoundaryPixels: refBoundary.length,
  };
}

/** How far the object's centroid sits from the CENTRE OF ITS OWN FRAME. */
export function frameCentroidOffset(mask, width, height) {
  const centroid = maskCentroid(mask, width, height);
  if (!centroid) return null;
  return {
    x: Number(((centroid.x - (width - 1) / 2) / width).toFixed(4)),
    y: Number(((centroid.y - (height - 1) / 2) / height).toFixed(4)),
    magnitude: Number(
      (Math.hypot(centroid.x - (width - 1) / 2, centroid.y - (height - 1) / 2) / width).toFixed(4)
    ),
  };
}

/**
 * Score every candidate projection against the reference and choose a winner.
 *
 * A rotated asset is a measurement problem, not a quality failure: picking the
 * best view is how the gate avoids condemning a model for arriving on a
 * different axis. `agreement` reports whether that choice was clear-cut.
 */
/** A stable fingerprint of a silhouette, used to spot views that agree exactly. */
function maskSignature(mask) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < mask.length; i += 1) {
    hash ^= mask[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Score every candidate projection against the reference and choose a winner.
 *
 * A rotated asset is a measurement problem, not a quality failure: picking the
 * best view is how the gate avoids condemning a model for arriving on a
 * different axis. What `agreement` reports is whether that choice was BETWEEN
 * MEANINGFULLY DIFFERENT SILHOUETTES.
 *
 * That distinction matters, and getting it wrong made the first version of this
 * function useless for exactly the products it is meant to pass: a box's front
 * and back views are the SAME rectangle, so they tie by definition. Judging the
 * winner by "how far ahead of the runner-up" therefore called every symmetric
 * shape ambiguous — a bar no box, tray or hamper could ever clear. So the margin
 * is measured against the best DIFFERENT silhouette instead, and a mirrored tie
 * is reported separately as the harmless thing it is.
 */
export function selectBestView(referenceNormalised, viewMasks, {
  size = CANONICAL_SIZE,
  minMargin = 0.05,
} = {}) {
  const candidates = [];
  for (const entry of viewMasks) {
    const normalised = normaliseMask({ mask: entry.mask, width: entry.size, height: entry.size }, { size });
    if (!normalised) continue;
    const compared = compareNormalised(normalised, referenceNormalised, { size });
    candidates.push({
      view: entry.view,
      viewLabel: entry.viewLabel,
      coverage: Number(normalised.coverage.toFixed(4)),
      aspect: normalised.sourceAspect,
      signature: maskSignature(normalised.mask),
      ...compared,
    });
  }
  candidates.sort((a, b) => b.iou - a.iou);
  const best = candidates[0] || null;

  // Views are grouped by the silhouette they actually produce. A group is a set
  // of camera positions that show the SAME outline (a box from the front and the
  // back; a sphere from anywhere), and only a different GROUP is real evidence
  // that the orientation choice could have gone the other way.
  const groups = new Map();
  for (const candidate of candidates) {
    if (!groups.has(candidate.signature)) groups.set(candidate.signature, []);
    groups.get(candidate.signature).push(candidate);
  }
  const rankedGroups = [...groups.values()].sort((a, b) => b[0].iou - a[0].iou);
  const bestGroup = rankedGroups[0] || [];
  const rivalGroup = rankedGroups[1] || null;
  const runnerUp = rivalGroup ? rivalGroup[0] : null;
  const margin = best && runnerUp ? Number((best.iou - runnerUp.iou).toFixed(4)) : null;

  return {
    selectedView: best?.view || '',
    selectedViewLabel: best?.viewLabel || '',
    best,
    runnerUp,
    margin,
    /** Views that show an identical outline to the winner (a mirror, usually). */
    tiedViews: bestGroup.filter((c) => c.view !== best?.view).map((c) => c.view),
    distinctSilhouettes: rankedGroups.length,
    agreement:
      margin == null
        ? 'single-silhouette'
        : margin >= minMargin
          ? 'clear'
          : 'ambiguous',
    candidates,
  };
}

export default {
  maskFromPixels,
  maskBox,
  maskCentroid,
  normaliseMask,
  compareNormalised,
  frameCentroidOffset,
  selectBestView,
  CANONICAL_SIZE,
  ALPHA_THRESHOLD,
};
