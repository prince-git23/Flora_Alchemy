/**
 * 3D STUDIO — MULTI-VIEW REFERENCES — composite ("contact sheet") detection and
 * panel extraction.
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 1's background-cutout engine destroyed product detail: petals, stems,
 * ribbon and wrapping were classified as background and removed, so the
 * "prepared" reference was a worse input than the photograph it came from. The
 * studio no longer segments the product at all. Instead an administrator may
 * supply MANY views of the same piece — either as separate photographs, or as
 * ONE composite image carrying a grid of views — and this module finds the grid
 * and cuts the views out of it WITHOUT touching a single product pixel.
 *
 * THE RULE THAT MATTERS
 * ---------------------
 * A panel crop may only ever remove SEPARATOR pixels (gutters, borders, labels
 * and margins that sit between views). It never estimates which pixels are
 * "product" and which are "background": every pixel inside a panel is kept. That
 * is the entire difference between this and the cutout feature it replaces.
 *
 * DETECTION IS A HYPOTHESIS, NOT A FACT
 * ------------------------------------
 * Two signals are combined:
 *
 *   1. SEAMS — thin, near-uniform columns/rows. A gutter is flat (spread ≈ 0) and
 *      has almost no gradient. Each band of consecutive seam cells is ONE
 *      separator; a panel boundary is the OUTER EDGE of that band, so a 16px
 *      gutter neither donates half its width to a neighbour nor leaves a white
 *      stripe on the panel.
 *   2. PERIODICITY — the gaps between consecutive separators (and between the
 *      separators and the sheet edges) must be roughly EQUAL. That is what makes
 *      a grid a grid, and it is computed from the separators themselves rather
 *      than from `width / count`: an outer margin of 24px would otherwise shift
 *      every expected boundary and make a real 4×3 sheet read as 2×1.
 *
 * When the two disagree, or when a panel would be too small to reconstruct from,
 * the result says so (`confidence`, `needsCorrection`) and the studio REFUSES to
 * create views until a human confirms or corrects the grid. Silently producing
 * a crop that severs a bouquet in half is exactly the failure mode this feature
 * must not repeat.
 *
 * Everything here is deterministic and depends on `sharp` only — the same
 * dependency the rest of the reference pipeline already uses. No ML model, no
 * network call, no second inference stack.
 */

import sharp from 'sharp';
import { ApiError } from '../middleware/errorMiddleware.js';

/** Limits that keep one composite from becoming an unbounded amount of work. */
export const GRID_LIMITS = {
  /** A composite must carry at least two views to be worth splitting. */
  minPanels: 2,
  /** 6×4 = 24 views. Beyond this the panels are too small to be useful and the
   *  per-request work (N crops + N storage writes) stops being predictable. */
  maxPanels: 24,
  maxColumns: 8,
  maxRows: 8,
  /** Below this a panel cannot carry product detail; it is a layout warning. */
  minPanelLongEdge: 160,
  /** A separator band wider than this fraction of the axis is a background, not
   *  a gutter — treating it as a separator would cut into the panels. */
  maxSeamWidthRatio: 0.06,
  /** Largest tolerated coefficient of variation between cell spans. */
  maxCellVariation: 0.12,
  /** Confidence at or above which the detected grid may be confirmed as-is. */
  confidenceThreshold: 0.55,
  /** Detection runs on a downscaled copy; the CROP is always taken from the
   *  original bytes at full resolution. */
  analysisSize: 768,
};

const round4 = (n) => Number(n.toFixed(4));

/**
 * Read the pixels once: EXIF-rotated, greyscaled, small. Greyscale is enough for
 * seam detection (a gutter is flat in luminance whatever its colour) and keeps
 * the analysis cheap.
 */
async function greyPlane(buffer, size = GRID_LIMITS.analysisSize) {
  const { data, info } = await sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Column (axis 'x') or row (axis 'y') statistics: mean luminance, spread and
 * inter-line gradient. A seam is BOTH flat and low-gradient, so both are
 * required by `seamBands`.
 */
function axisStats(plane, axis) {
  const { data, width, height, channels } = plane;
  const count = axis === 'x' ? width : height;
  const span = axis === 'x' ? height : width;
  const stats = new Array(count);
  let previous = new Float64Array(span);
  let current = new Float64Array(span);
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    let sumSq = 0;
    for (let j = 0; j < span; j += 1) {
      const x = axis === 'x' ? i : j;
      const y = axis === 'x' ? j : i;
      const value = data[(y * width + x) * channels];
      current[j] = value;
      sum += value;
      sumSq += value * value;
    }
    const mean = sum / span;
    const stdev = Math.sqrt(Math.max(0, sumSq / span - mean * mean));
    let gradient = 0;
    if (i > 0) {
      let acc = 0;
      for (let j = 0; j < span; j += 1) acc += Math.abs(current[j] - previous[j]);
      gradient = acc / span;
    } else {
      // The first column has no left neighbour; borrow the second's gradient so
      // it is never mistaken for a seam by an artificial 255.
      gradient = 255;
    }
    stats[i] = { index: i, mean, stdev, gradient };
    const swap = previous;
    previous = current;
    current = swap;
  }
  if (count > 1) stats[0] = { ...stats[0], gradient: stats[1].gradient };
  return stats;
}

/** Flat + low-gradient runs, as bands with their outer edges. */
function seamBands(stats, { maxWidth }) {
  const flat = (s) => s.stdev <= 4.5 && s.gradient <= 3.5;
  const bands = [];
  let start = -1;
  for (let i = 0; i < stats.length; i += 1) {
    if (flat(stats[i])) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      bands.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) bands.push([start, stats.length - 1]);
  return bands
    .map(([a, b]) => ({ start: a, end: b, width: b - a + 1, center: (a + b + 1) / 2 }))
    .filter((band) => band.width <= maxWidth);
}

const mean = (values) => values.reduce((a, v) => a + v, 0) / Math.max(1, values.length);
const stdev = (values) => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
};

/**
 * Infer the cell count on ONE axis from the separators that were actually seen.
 *
 * `null` means the axis has no internal separator at all (a single row/column of
 * panels). A low score means the separators do not space out like a grid.
 */
function inferAxis(stats, axisLength, { maxRatioWidth }) {
  const bands = seamBands(stats, { maxWidth: Math.max(2, Math.floor(axisLength * maxRatioWidth)) });
  // A band at the very edge is the sheet's MARGIN, not a separator between views.
  const edge = axisLength * 0.02;
  const internal = bands.filter((band) => band.center > edge && band.center < axisLength - edge);
  if (!internal.length) return { bands, best: null, internal };

  // Cell spans: edge→first separator, separator→separator, last separator→edge.
  const centres = internal.map((band) => band.center);
  const spans = [centres[0], ...centres.slice(1).map((c, i) => c - centres[i]), axisLength - centres[centres.length - 1]];
  const avg = mean(spans);
  const variation = stdev(spans) / Math.max(1, avg);
  const widthRatio = mean(internal.map((band) => band.width)) / Math.max(1, avg);
  // Evenly-spaced separators are the grid signal. A stray flat stripe in one
  // photograph makes exactly one span wrong, which shows up here as a high
  // variation and is rejected rather than cropped around.
  const score = Math.max(
    0,
    Math.min(1, 1 - (variation / GRID_LIMITS.maxCellVariation) * 0.7 - Math.min(1, widthRatio * 2) * 0.3)
  );
  return {
    bands,
    internal,
    best: {
      count: internal.length + 1,
      score: round4(score),
      variation: round4(variation),
      means: spans,
    },
  };
}

/**
 * Cell edges from the separators. Each internal separator contributes TWO edges
 * (its own start and its own end), so a panel never contains gutter pixels.
 */
function edgesFor(bands, internal, axisLength, count, declared = false) {
  const edges = [0];
  // The leading margin, when the sheet has one, is not part of the first panel.
  const leading = bands.find((band) => band.start <= 1 && band.end < axisLength - 1);
  if (leading) edges[0] = leading.end + 1;

  if (declared) {
    // A DECLARED layout may not match the separators that exist (a seamless
    // sheet, or a user who knows the grid better than the detector). Snapping to
    // the nearest real separator within a quarter cell keeps a real gutter out of
    // the crop, and falling back to the ideal division means a declared layout
    // always produces the count it promised instead of silently returning fewer
    // panels.
    const cell = axisLength / count;
    for (let i = 1; i < count; i += 1) {
      const expected = i * cell;
      const band = internal.find((b) => Math.abs(b.center - expected) <= cell * 0.25);
      if (band) edges.push(band.start, band.end + 1);
      else edges.push(expected, expected);
    }
  } else {
    for (const band of internal) edges.push(band.start, band.end + 1);
  }

  // The trailing margin, likewise.
  const trailing = bands.find((band) => band.end >= axisLength - 2 && band.start > 1);
  edges.push(trailing ? trailing.start : axisLength);
  return edges;
}

function boxesFor(columns, rows, columnAxis, rowAxis, axisWidth, axisHeight, { padding = 0, declared = false } = {}) {
  const xEdges = edgesFor(columnAxis.bands, columnAxis.internal || [], axisWidth, columns, declared);
  const yEdges = edgesFor(rowAxis.bands, rowAxis.internal || [], axisHeight, rows, declared);
  // `edgesFor` yields [left, sepStart, sepEnd, ..., right]; each panel takes the
  // pair that bounds its cell.
  const pairs = (edges, count) => {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const left = edges[i * 2];
      const right = edges[i * 2 + 1];
      if (Number.isFinite(left) && Number.isFinite(right) && right > left) out.push([left, right]);
    }
    return out;
  };
  const xPairs = pairs(xEdges, columns);
  const yPairs = pairs(yEdges, rows);

  const panels = [];
  for (let row = 0; row < yPairs.length; row += 1) {
    for (let column = 0; column < xPairs.length; column += 1) {
      const [cellLeft, cellRight] = xPairs[column];
      const [cellTop, cellBottom] = yPairs[row];
      const cellWidth = cellRight - cellLeft;
      const cellHeight = cellBottom - cellTop;
      // Padding is INSIDE the cell and symmetric, so a label or a frame is
      // trimmed without ever reaching across a separator into the next view.
      const inset = Math.min(padding, Math.floor(Math.min(cellWidth, cellHeight) / 8));
      const left = cellLeft + inset;
      const top = cellTop + inset;
      const width = Math.max(1, cellWidth - inset * 2);
      const height = Math.max(1, cellHeight - inset * 2);
      panels.push({
        index: panels.length,
        row,
        column,
        // Normalized to the ANALYSED frame; extraction scales these back to the
        // original resolution, so the values stay valid at any size.
        box: {
          x: round4(left / axisWidth),
          y: round4(top / axisHeight),
          width: round4(width / axisWidth),
          height: round4(height / axisHeight),
        },
        pixelBox: { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) },
      });
    }
  }
  return panels;
}

/**
 * Analyse a composite image.
 *
 * `options.columns` / `options.rows` are a HUMAN-CORRECTED layout. When they are
 * supplied the detector's opinion is bypassed: the separators nearest the
 * declared boundaries are used for the cut, and the declared counts decide the
 * cells. That is the correction path, and it must obey the operator rather than
 * argue with them.
 */
export async function analyseComposite(buffer, { columns, rows, padding = 0 } = {}) {
  const plane = await greyPlane(buffer);
  const { width, height } = plane;
  const columnStats = axisStats(plane, 'x');
  const rowStats = axisStats(plane, 'y');
  const columnAxis = inferAxis(columnStats, width, { maxRatioWidth: GRID_LIMITS.maxSeamWidthRatio });
  const rowAxis = inferAxis(rowStats, height, { maxRatioWidth: GRID_LIMITS.maxSeamWidthRatio });

  const declared = Number.isFinite(Number(columns)) && Number.isFinite(Number(rows)) && Number(columns) >= 1 && Number(rows) >= 1;
  const detectedColumns = columnAxis.best?.count || 1;
  const detectedRows = rowAxis.best?.count || 1;

  const useColumns = declared
    ? Math.min(GRID_LIMITS.maxColumns, Math.max(1, Math.round(Number(columns))))
    : detectedColumns;
  const useRows = declared ? Math.min(GRID_LIMITS.maxRows, Math.max(1, Math.round(Number(rows)))) : detectedRows;

  // CONFIDENCE. Both axes evenly separated is a grid. One axis alone is usually
  // a photograph with a flat band, so it is reported as a low-confidence
  // proposal that must be confirmed (never cut automatically).
  const scores = [columnAxis.best?.score, rowAxis.best?.score].filter((s) => typeof s === 'number');
  const confidence = declared
    ? 1
    : scores.length === 2
      ? Math.min(...scores)
      : scores.length === 1
        ? Math.min(0.4, scores[0] * 0.5)
        : 0;

  const totalPanels = useColumns * useRows;
  const isComposite = totalPanels >= GRID_LIMITS.minPanels && totalPanels <= GRID_LIMITS.maxPanels;

  const panels = isComposite
    ? boxesFor(useColumns, useRows, columnAxis, rowAxis, width, height, { padding, declared })
    : [];
  const boxesComplete = panels.length === totalPanels;

  const meta = await sharp(buffer, { failOn: 'error' }).metadata();
  const originalWidth = meta.width || width;
  const originalHeight = meta.height || height;
  const warnings = [];
  const notes = [];

  for (const panel of panels) {
    const panelWidth = Math.round(panel.box.width * originalWidth);
    const panelHeight = Math.round(panel.box.height * originalHeight);
    panel.width = panelWidth;
    panel.height = panelHeight;
    panel.longEdge = Math.max(panelWidth, panelHeight);
    if (panel.longEdge < GRID_LIMITS.minPanelLongEdge) {
      warnings.push(
        `View ${panel.index + 1} would be only ${panelWidth}×${panelHeight}px. That is too small to reconstruct from — use a larger composite or fewer views.`
      );
    }
  }

  const needsCorrection =
    !declared && (!isComposite || !boxesComplete || confidence < GRID_LIMITS.confidenceThreshold);
  if (totalPanels > GRID_LIMITS.maxPanels) {
    warnings.push(
      `A ${useColumns}×${useRows} layout is ${totalPanels} views; the limit is ${GRID_LIMITS.maxPanels}. Confirm a smaller grid.`
    );
  }
  if (!isComposite) {
    notes.push('This looks like a single photograph rather than a grid of views.');
  } else if (needsCorrection) {
    notes.push(
      `Panel separators were ambiguous (confidence ${(confidence * 100).toFixed(0)}%). Confirm the grid before the views are created.`
    );
  } else {
    notes.push(
      `Detected a ${useColumns}×${useRows} grid (${totalPanels} views), confidence ${(confidence * 100).toFixed(0)}%.`
    );
  }

  return {
    isComposite: isComposite && boxesComplete,
    confidence: round4(confidence),
    threshold: GRID_LIMITS.confidenceThreshold,
    needsCorrection,
    source: declared ? 'declared' : 'detected',
    layout: { columns: useColumns, rows: useRows, panelCount: totalPanels, padding },
    detected: {
      columns: detectedColumns,
      rows: detectedRows,
      columnScore: columnAxis.best?.score ?? null,
      rowScore: rowAxis.best?.score ?? null,
      columnVariation: columnAxis.best?.variation ?? null,
      rowVariation: rowAxis.best?.variation ?? null,
    },
    analysis: { width, height, originalWidth, originalHeight },
    panels,
    warnings,
    notes,
  };
}

/**
 * Cut ONE panel out of the ORIGINAL bytes. The crop is expressed as fractions of
 * the original (not the analysis frame), so it is resolution-independent and
 * survives a re-analysis. `.rotate()` before `.extract()` is required: sharp reads
 * EXIF orientation as metadata only, so extracting first would crop the
 * un-rotated frame while the stored dimensions describe the rotated one.
 */
export async function extractPanel(buffer, box) {
  const meta = await sharp(buffer, { failOn: 'error' }).metadata();
  const width = meta.autoOrient?.width || meta.width || 0;
  const height = meta.autoOrient?.height || meta.height || 0;
  const left = Math.max(0, Math.min(width - 1, Math.round(box.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(box.y * height)));
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(box.width * width)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(box.height * height)));

  const output = await sharp(buffer, { failOn: 'error' })
    .rotate()
    .extract({ left, top, width: cropWidth, height: cropHeight })
    // PNG keeps the panel byte-exact apart from re-encoding: no chroma
    // subsampling, no quality slider, and transparency survives if the source
    // had it. Panels are working references, not deliverables.
    .png({ compressionLevel: 9 })
    .toBuffer();

  const outMeta = await sharp(output).metadata();
  return {
    buffer: output,
    width: outMeta.width || cropWidth,
    height: outMeta.height || cropHeight,
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
  };
}

/** Refuse a panel buffer that is not a real image before any storage write. */
export async function describePanelBuffer(buffer) {
  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch {
    throw new ApiError(422, 'That panel could not be decoded.', 'UNREADABLE_IMAGE');
  }
  return { width: meta.width || 0, height: meta.height || 0, format: 'png' };
}

/** Angle labels the studio offers. Not required, never inferred. */
export const VIEW_ANGLES = [
  'front',
  'back',
  'left',
  'right',
  'three-quarter-left',
  'three-quarter-right',
  'top',
  'bottom',
  'detail',
  'texture',
  'wrapping',
  'other',
];

export default {
  GRID_LIMITS,
  VIEW_ANGLES,
  analyseComposite,
  extractPanel,
  describePanelBuffer,
};
