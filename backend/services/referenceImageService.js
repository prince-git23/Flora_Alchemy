/**
 * 3D STUDIO — reference-image orchestration (Phase 1, revised by the multi-view
 * work).
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * Phase 1 ran a background-removal engine on every upload and stored a cutout
 * plus a neutral preview. On real product photography (a bouquet) that engine
 * classified petals, foliage, stems, ribbon and wrapping as background and
 * removed them: the "prepared" reference was a damaged copy of the product. The
 * generation pipeline then reconstructed the damage.
 *
 * This module no longer segments anything. A reference is now:
 *
 *   · an ORIGINAL — written once, never overwritten, never re-cropped in place;
 *   · optionally one PANEL of a composite sheet (the crop removes separators
 *     only — see services/referenceViews.js);
 *   · optionally labelled with a viewpoint the administrator chose.
 *
 * Every view of a product is preserved as evidence. Which views a reconstruction
 * model can actually use is decided by the PROVIDER (`supportsMultiView`), never
 * by this service pretending.
 *
 * RULES ENFORCED HERE
 *   · the original is immutable (`ORIGINAL_IMMUTABLE` from the storage layer);
 *   · a panel row can never itself be split (no repeated cropping);
 *   · confirming a grid is IDEMPOTENT per (parent, panelIndex) — a second
 *     confirmation updates the existing view instead of duplicating it;
 *   · every query is filtered by the caller's workspace and a mismatch is a 404;
 *   · `workspaceId` is never taken from the request body.
 */

import mongoose from 'mongoose';
import ProductReferenceImage from '../models/ProductReferenceImage.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { getWorkspaceId } from '../utils/tenancy.js';
import * as storage from './referenceAssetStorage.js';
import { normalisePose } from './capturePose.js';
import {
  GRID_LIMITS,
  VIEW_ANGLES,
  analyseComposite,
  describePanelBuffer,
  extractPanel,
} from './referenceViews.js';
import {
  IMAGE_RULES,
  imageSignature,
  imageWarnings,
  inspectImage,
  measureSharpness,
  setWarnings,
} from './referenceImageValidation.js';

const mergeMessages = (...lists) => [...new Set(lists.flat().filter(Boolean))];

/** A row processing for longer than this was interrupted (a restart, a crash). */
const PROCESSING_STALE_MS = 3 * 60 * 1000;

/** Hard ceiling on references per product/draft — a multi-view set is bounded
 *  by what a composite may contain (GRID_LIMITS.maxPanels) plus detail shots. */
export const MAX_REFERENCES = 24;

const toObjectId = (value) => {
  if (!value) return null;
  const str = String(value);
  return mongoose.isValidObjectId(str) ? new mongoose.Types.ObjectId(str) : null;
};

function tenantFilter(req) {
  const workspaceId = getWorkspaceId(req.user);
  return workspaceId ? { workspaceId } : { workspaceId: null };
}

function tenantKey(req) {
  return req.workspaceSlug || 'platform';
}

async function loadScoped(req, id) {
  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(404, 'Reference image not found.', 'REFERENCE_NOT_FOUND');
  }
  const doc = await ProductReferenceImage.findOne({ _id: id, ...tenantFilter(req) });
  if (!doc) {
    throw new ApiError(404, 'Reference image not found.', 'REFERENCE_NOT_FOUND');
  }
  return doc;
}

async function nextOrder(scope, floor = 0) {
  const last = await ProductReferenceImage.findOne(scope).sort({ order: -1 }).select('order').lean();
  return Math.max(floor, last ? last.order + 1 : 0);
}

async function markFailed(doc, err) {
  doc.status = 'FAILED';
  doc.processing.error = String(err.message || err).slice(0, 500);
  doc.processing.errorCode = err.code || 'PROCESSING_FAILED';
  doc.processing.finishedAt = new Date();
  doc.processing.durationMs = doc.processing.startedAt
    ? Date.now() - new Date(doc.processing.startedAt).getTime()
    : 0;
  doc.confidence = null;
  await doc.save().catch(() => {});
  if (process.env.BGREMOVE_DEBUG === '1') {
    console.log(`[reference-image] ${doc._id} FAILED (${doc.processing.errorCode}): ${doc.processing.error}`);
  }
  return doc;
}

/**
 * Prepare one row: measure it, decide whether a human should look, and — for a
 * composite — record the grid hypothesis.
 *
 * There is NO derived image output any more. The only bytes this can write are
 * panel rows, and those are written by `confirmReferenceViews` after a human
 * confirms the layout, not here.
 */
export async function processReferenceImage({ id, req }) {
  const doc = await loadScoped(req, id);
  const original = await storage.readAsset(doc.original.storageKey).catch(() => null);
  if (!original) {
    return markFailed(
      doc,
      new ApiError(410, 'The original image is missing from storage. Remove this reference and upload it again.', 'ORIGINAL_MISSING')
    );
  }

  doc.status = 'PROCESSING';
  doc.processing.startedAt = new Date();
  doc.processing.attempts += 1;
  doc.processing.error = '';
  doc.processing.errorCode = '';
  await doc.save();

  const started = Date.now();
  try {
    const quality = await measureSharpness(original);
    const { warnings: qualityWarnings, notes: qualityNotes } = imageWarnings({
      inspect: {
        width: doc.original.width,
        height: doc.original.height,
        format: doc.original.format,
        hasAlpha: doc.original.hasAlpha,
      },
      quality,
    });

    doc.validation.sharpnessScore = quality.sharpnessScore;
    doc.validation.contrastStdev = quality.contrastStdev;
    doc.validation.edgeMean = quality.edgeMean;

    let compositeWarnings = [];
    let compositeNotes = [];
    if (isPanel(doc)) {
      // A panel is already a crop. Analysing it as a potential composite is the
      // repeated-cropping trap: it would cut an already-cut bouquet in half.
      doc.composite.detected = false;
      doc.composite.needsCorrection = false;
      compositeNotes = ['This is one view of a larger composite; it is never split again.'];
    } else {
      const analysis = await analyseComposite(original, {
        columns: doc.composite.confirmed ? doc.composite.columns : undefined,
        rows: doc.composite.confirmed ? doc.composite.rows : undefined,
        padding: doc.composite.padding || 0,
      });
      doc.composite.detected = analysis.isComposite;
      doc.composite.columns = analysis.layout.columns;
      doc.composite.rows = analysis.layout.rows;
      doc.composite.panelCount = analysis.layout.panelCount;
      doc.composite.confidence = analysis.confidence;
      doc.composite.layoutSource = analysis.source;
      doc.composite.needsCorrection = analysis.isComposite ? analysis.needsCorrection : false;
      if (!doc.composite.confirmed) {
        // A fresh detection replaces the detector's opinion; a confirmed layout
        // stays confirmed until the administrator changes it.
        doc.composite.confirmed = false;
      }
      doc.composite.warnings = analysis.warnings;
      doc.composite.notes = analysis.notes;
      compositeWarnings = analysis.isComposite ? analysis.warnings : [];
      compositeNotes = analysis.notes;
    }

    const warnings = mergeMessages(qualityWarnings, compositeWarnings);
    const notes = mergeMessages(qualityNotes, compositeNotes);
    doc.warnings = warnings;
    doc.processing.engine = 'measure';
    doc.processing.model = '';
    doc.processing.modelLicence = '';
    doc.processing.metrics = {
      // Provenance of the measurement step only. There is no segmentation pass,
      // so there is no foreground ratio / border contact / component count to
      // report and none is invented.
      measuredAt: new Date().toISOString(),
      processingMs: Date.now() - started,
      notes,
    };
    doc.processing.finishedAt = new Date();
    doc.processing.durationMs = Date.now() - started;
    // Kept for API compatibility: the studio still distinguishes "nothing to look
    // at" from "needs a human". With no engine there is no confidence score, so
    // only genuine warnings can push a row into NEEDS_REVIEW.
    doc.confidence = null;

    doc.status = warnings.length > 0 ? 'NEEDS_REVIEW' : 'READY';
    await doc.save();
    return doc;
  } catch (err) {
    return markFailed(doc, err);
  }
}

function isPanel(doc) {
  return doc?.source?.type === 'panel' || Boolean(doc?.source?.parentId);
}

/**
 * Is this reference a COMPOSITE SOURCE SHEET — the grid an administrator
 * uploaded and confirmed, whose individual views already exist as their own
 * rows?
 *
 * A sheet is a SOURCE DOCUMENT, not a view. It is kept (and attached to the
 * product) so the original composite stays auditable and re-cut-able, but it is
 * never part of the reconstruction's view set: handing the whole grid to an
 * image-to-3D engine would ask it to reconstruct twelve tiny products at once.
 *
 * The test is the sheet's own CONFIRMED layout, which `confirmReferenceViews`
 * writes. A merely-detected (not yet confirmed) grid is not a sheet — nothing
 * has been cut from it, so it is still just an uploaded photograph.
 */
export function isSourceSheet(row) {
  if (!row || isPanel(row)) return false;
  return Boolean(row.composite?.confirmed) && Number(row.composite?.panelCount || 0) > 0;
}

function logFailure(stage, err, extra = {}) {
  const code = err?.code || 'UNKNOWN';
  const syscall = err?.syscall || '';
  const detail = Object.entries(extra)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  if (err instanceof ApiError) {
    console.error(`[reference-upload] stage=${stage} code=${code}${syscall ? ` syscall=${syscall}` : ''}${detail ? ` ${detail}` : ''}`);
  } else {
    console.error(`[reference-upload] stage=${stage} code=${code}`, err);
  }
}

function scheduleProcessing(args) {
  void processReferenceImage(args).catch((err) => {
    console.error('[reference-image] unexpected processing error:', err.message);
  });
}

/**
 * Create a reference from an uploaded file. `mode`:
 *   'auto'      — detect a grid; a detection is only a proposal
 *   'single'    — treat it as one photograph, never as a sheet
 *   'composite' — the administrator says it is a sheet; keep the detected grid
 *                 even when confidence is low (they will correct it)
 */
export async function createReferenceImage(
  req,
  { file, productSlug = '', draftKey = '', label = '', mode = 'auto', viewAngle = '' }
) {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new ApiError(422, 'An image file is required.', 'VALIDATION_ERROR');
  }
  const inspect = await inspectImage(file.buffer);

  const scope = { ...tenantFilter(req) };
  if (productSlug) scope.productSlug = String(productSlug);
  else if (draftKey) scope.draftKey = String(draftKey);
  else throw new ApiError(422, 'A product or draft reference is required.', 'VALIDATION_ERROR');

  const existing = await ProductReferenceImage.countDocuments(scope);
  if (existing >= MAX_REFERENCES) {
    throw new ApiError(
      422,
      `This reference set already has ${existing} images. The limit is ${MAX_REFERENCES}.`,
      'REFERENCE_LIMIT'
    );
  }

  const duplicate = await ProductReferenceImage.findOne({
    ...scope,
    'original.sha256': inspect.sha256,
  })
    .select('_id label')
    .lean();

  const doc = new ProductReferenceImage({
    ...(getWorkspaceId(req.user) ? { workspaceId: getWorkspaceId(req.user) } : {}),
    productSlug: productSlug ? String(productSlug) : '',
    draftKey: draftKey ? String(draftKey) : '',
    order: await nextOrder(scope),
    isPrimary: existing === 0,
    status: 'UPLOADING',
    original: {
      bytes: inspect.bytes,
      width: inspect.width,
      height: inspect.height,
    },
    label: label ? String(label).slice(0, 120) : '',
    viewAngle: VIEW_ANGLES.includes(String(viewAngle)) ? String(viewAngle) : '',
    source: { type: 'upload' },
    createdBy: req.user?._id || null,
    isFixture: false,
  });
  doc.storageNamespace = tenantKey(req);

  let asset;
  try {
    asset = await storage.writeAsset({
      imageId: doc._id,
      workspaceSlug: tenantKey(req),
      kind: 'original',
      buffer: file.buffer,
      format: inspect.format,
      expectSha256: inspect.sha256,
    });
  } catch (err) {
    logFailure('persist-original', err, { imageId: String(doc._id) });
    throw err;
  }
  doc.original.storageKey = asset.storageKey;
  doc.original.sha256 = inspect.sha256;
  doc.original.format = inspect.format;
  doc.original.hasAlpha = inspect.hasAlpha;
  doc.original.fileName = file.originalname ? String(file.originalname).slice(0, 200) : '';

  const quality = await measureSharpness(file.buffer);
  const signature = await imageSignature(file.buffer);
  const { warnings, notes } = imageWarnings({ inspect, quality, duplicateOf: duplicate ? duplicate._id : null });
  doc.validation.sharpnessScore = quality.sharpnessScore;
  doc.validation.contrastStdev = quality.contrastStdev;
  doc.validation.edgeMean = quality.edgeMean;
  doc.validation.signature = signature
    ? {
        hueHistogram: signature.hueHistogram,
        meanSaturation: signature.meanSaturation,
        aspect: signature.aspect,
      }
    : undefined;
  doc.warnings = warnings;

  try {
    await doc.save();
  } catch (err) {
    logFailure('db-insert', err, { imageId: String(doc._id) });
    await storage.removeImageAssets(doc._id, tenantKey(req));
    throw err;
  }

  if (mode === 'single') {
    // Explicit: the administrator says this is one photograph. Mark the row as
    // prepared without a grid pass, but still measure it.
    void runMeasureOnly({ id: doc._id, req }).catch(() => {});
  } else {
    scheduleProcessing({ id: doc._id, req });
  }

  return { doc, uploadedNotes: notes, duplicateOf: duplicate ? String(duplicate._id) : null, mode };
}

/** Measure without a composite pass (mode === 'single'). */
async function runMeasureOnly({ id, req }) {
  const doc = await loadScoped(req, id);
  doc.composite.detected = false;
  doc.composite.needsCorrection = false;
  doc.status = doc.warnings?.length ? 'NEEDS_REVIEW' : 'READY';
  doc.processing.engine = 'measure';
  doc.processing.finishedAt = new Date();
  doc.processing.durationMs = 0;
  await doc.save();
}

/**
 * Which assets REALLY exist right now. `cutout`/`neutral` are still inspected so
 * a legacy row can report its own (read-only) history truthfully.
 */
export async function assetPresence(image) {
  const id = image?.id || String(image?._id || '');
  const keys = {
    original: image?.original?.storageKey || '',
    cutout: image?.cutout?.storageKey || '',
    neutral: image?.neutral?.storageKey || '',
  };
  const entries = await Promise.all(
    Object.entries(keys).map(async ([kind, key]) => [
      kind,
      key ? await storage.assetExists(key).catch(() => false) : false,
    ])
  );
  return { id, exists: Object.fromEntries(entries) };
}

function present(doc, setContext = {}) {
  const json = doc.toJSON();
  const startedAt = doc.processing?.startedAt ? new Date(doc.processing.startedAt).getTime() : null;
  if (doc.status === 'PROCESSING' && startedAt && Date.now() - startedAt > PROCESSING_STALE_MS) {
    json.stale = true;
    json.staleMessage =
      'Processing was interrupted (the server restarted). Use Retry processing — the original is intact.';
  }
  const extra = setContext[String(doc._id)] || {};
  return {
    ...json,
    setWarnings: extra.warnings || [],
    setNotes: extra.notes || [],
  };
}

export async function listReferenceImages(req, { productSlug = '', draftKey = '', ids = null } = {}) {
  const scope = { ...tenantFilter(req) };
  if (productSlug) scope.productSlug = String(productSlug);
  else if (draftKey) scope.draftKey = String(draftKey);
  else if (ids && ids.length) scope._id = { $in: ids.map(toObjectId).filter(Boolean) };
  else throw new ApiError(422, 'A product, a draft or an id list is required.', 'VALIDATION_ERROR');

  const docs = await ProductReferenceImage.find(scope).sort({ order: 1, createdAt: 1 });
  const setLevel = setWarnings(
    docs
      // Panels of one sheet are views of one object by construction: including
      // them pairwise would flag every 12-panel bouquet as "different products".
      .filter((d) => d.source?.type !== 'panel')
      .map((d) => ({
        id: String(d._id),
        signature: d.validation?.signature?.hueHistogram?.length
          ? {
              hueHistogram: d.validation.signature.hueHistogram,
              meanSaturation: d.validation.signature.meanSaturation,
              aspect: d.validation.signature.aspect,
            }
          : null,
      }))
  );
  const context = {};
  for (const [id, warnings] of Object.entries(setLevel.perImage)) {
    context[id] = { warnings };
  }
  return {
    images: docs.map((d) => present(d, context)),
    setWarnings: setLevel.warnings,
    setNotes: setLevel.notes,
  };
}

export async function getReferenceImage(req, id) {
  const doc = await loadScoped(req, id);
  return present(doc);
}

/**
 * PATCH one reference: label, viewpoint, acceptance, primary flag.
 *
 * A crop is NOT accepted any more: cropping a reference in place produced a
 * derived image that could be re-cropped and re-cropped again. The only supported
 * way to narrow a reference is a composite panel (traceable to its parent) or a
 * re-upload.
 */
export async function updateReferenceImage(req, id, patch = {}) {
  const doc = await loadScoped(req, id);

  if (patch.label !== undefined) doc.label = String(patch.label).slice(0, 120);
  if (patch.viewAngle !== undefined) {
    const angle = String(patch.viewAngle || '');
    if (angle && !VIEW_ANGLES.includes(angle)) {
      throw new ApiError(422, `"${angle}" is not a known viewpoint label.`, 'VALIDATION_ERROR');
    }
    doc.viewAngle = angle;
  }
  // PHASE 11 — a pose is RECORDED, never inferred. `null` clears it (an explicit
  // act by the administrator); anything partial, non-finite or out of range is
  // refused by capturePose.normalisePose, so a half-written pose can never
  // overwrite a valid one.
  if (patch.pose !== undefined) {
    const pose = normalisePose(patch.pose);
    doc.pose =
      pose === null
        ? null
        : { ...pose, recordedAt: new Date(), recordedBy: req?.user?._id ?? null };
  }
  if (patch.accepted !== undefined) {
    doc.accepted = Boolean(patch.accepted);
    if (doc.accepted && doc.status === 'FAILED') {
      throw new ApiError(422, 'A failed reference cannot be accepted — fix it first.', 'REFERENCE_NOT_READY');
    }
  }
  if (patch.isPrimary !== undefined && patch.isPrimary) {
    await ProductReferenceImage.updateMany(
      {
        ...tenantFilter(req),
        _id: { $ne: doc._id },
        ...(doc.productSlug ? { productSlug: doc.productSlug } : { draftKey: doc.draftKey }),
      },
      { $set: { isPrimary: false } }
    );
    doc.isPrimary = true;
  }
  if (patch.composite === false) {
    // "This is one photograph, not a sheet." Clearing the proposal is a
    // decision, so it is recorded — but it does NOT delete existing panels: a
    // view cut from the sheet is independent working material from that point on.
    doc.composite.detected = false;
    doc.composite.needsCorrection = false;
    doc.composite.columns = 0;
    doc.composite.rows = 0;
    doc.composite.panelCount = 0;
    doc.composite.confidence = null;
    doc.composite.layoutSource = 'dismissed';
    doc.composite.notes = ['Marked as a single photograph; no views are cut from it.'];
  }
  if (patch.crop !== undefined) {
    throw new ApiError(
      422,
      'Cropping a reference in place is not supported. Upload the photograph again, or split a composite sheet into views.',
      'CROP_NOT_SUPPORTED'
    );
  }
  await doc.save();
  return present(doc);
}

export async function reorderReferenceImages(req, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ApiError(422, 'An ordered list of reference ids is required.', 'VALIDATION_ERROR');
  }
  const docs = await ProductReferenceImage.find({
    ...tenantFilter(req),
    _id: { $in: ids.map(toObjectId).filter(Boolean) },
  });
  if (docs.length !== ids.length) {
    throw new ApiError(422, 'One or more reference images could not be found.', 'REFERENCE_NOT_FOUND');
  }
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  await Promise.all(
    ids.map((id, index) => {
      const doc = byId.get(String(id));
      doc.order = index;
      return doc.save();
    })
  );
  const first = byId.get(String(ids[0]));
  if (first) {
    await ProductReferenceImage.updateMany(
      {
        ...tenantFilter(req),
        _id: { $ne: first._id },
        ...(first.productSlug ? { productSlug: first.productSlug } : { draftKey: first.draftKey }),
      },
      { $set: { isPrimary: false } }
    );
    first.isPrimary = true;
    await first.save();
  }
  return listReferenceImages(req, first?.productSlug ? { productSlug: first.productSlug } : { draftKey: first?.draftKey });
}

export async function removeReferenceImage(req, id) {
  const doc = await loadScoped(req, id);
  const wasPrimary = doc.isPrimary;
  const setFilter = doc.productSlug ? { productSlug: doc.productSlug } : { draftKey: doc.draftKey };
  const panelFilter = { ...tenantFilter(req), 'source.parentId': doc._id };
  const panels = await ProductReferenceImage.find(panelFilter);

  await doc.deleteOne();
  await storage.removeImageAssets(doc._id, doc.storageNamespace || tenantKey(req));
  // Removing a sheet removes the views cut from it: a panel whose parent is gone
  // is untraceable working material and would otherwise sit in the set forever.
  for (const panel of panels) {
    await storage.removeImageAssets(panel._id, panel.storageNamespace || tenantKey(req));
    await panel.deleteOne();
  }
  if (wasPrimary) {
    const next = await ProductReferenceImage.findOne({ ...tenantFilter(req), ...setFilter }).sort({ order: 1 });
    if (next) {
      next.isPrimary = true;
      await next.save();
    }
  }
  return { removed: String(doc._id), wasPrimary, removedPanels: panels.length };
}

export async function reprocessReferenceImage(req, id) {
  const doc = await loadScoped(req, id);
  if (doc.status === 'UPLOADING') {
    throw new ApiError(409, 'This reference is still being stored — try again in a moment.', 'REFERENCE_BUSY');
  }
  const result = await processReferenceImage({ id: doc._id, req });
  if (!result) throw new ApiError(404, 'Reference image not found.', 'REFERENCE_NOT_FOUND');
  return result;
}

/* ── composite views ─────────────────────────────────────────────────────── */

/**
 * Inspect a composite and describe the views it would produce — WITHOUT writing
 * anything. This is the preview the correction UI shows, and it is the only way
 * to see what a grid change would do before committing it.
 */
export async function previewReferenceViews(req, id, { columns, rows, padding = 0 } = {}) {
  const doc = await loadScoped(req, id);
  if (isPanel(doc)) {
    throw new ApiError(422, 'This reference is already a single view of a composite.', 'PANEL_NOT_COMPOSITE');
  }
  const original = await storage.readAsset(doc.original.storageKey).catch(() => null);
  if (!original) {
    throw new ApiError(410, 'The original image is missing from storage.', 'ORIGINAL_MISSING');
  }
  const analysis = await analyseComposite(original, { columns, rows, padding });
  if (analysis.layout.panelCount > GRID_LIMITS.maxPanels) {
    throw new ApiError(
      422,
      `A ${analysis.layout.columns}×${analysis.layout.rows} layout is ${analysis.layout.panelCount} views; the limit is ${GRID_LIMITS.maxPanels}.`,
      'GRID_TOO_LARGE'
    );
  }
  const existing = await ProductReferenceImage.find({
    ...tenantFilter(req),
    'source.parentId': doc._id,
  })
    .select('_id source.panelIndex accepted')
    .lean();
  return {
    ...analysis,
    parentId: String(doc._id),
    existingPanels: existing.map((p) => ({
      id: String(p._id),
      panelIndex: p.source?.panelIndex ?? null,
      accepted: Boolean(p.accepted),
    })),
  };
}

/**
 * Create (or update) the views of a composite from a CONFIRMED layout.
 *
 * `angles` is an optional array parallel to the panel order; a panel without a
 * label is perfectly valid. Idempotent by (parentId, panelIndex): re-confirming
 * the same layout rewrites the same rows, and shrinking the grid removes views
 * that no longer exist rather than leaving orphans behind.
 */
export async function confirmReferenceViews(req, id, { columns, rows, padding = 0, angles = [], replace = true } = {}) {
  const doc = await loadScoped(req, id);
  if (isPanel(doc)) {
    throw new ApiError(422, 'This reference is already a single view of a composite.', 'PANEL_NOT_COMPOSITE');
  }
  const original = await storage.readAsset(doc.original.storageKey).catch(() => null);
  if (!original) {
    throw new ApiError(410, 'The original image is missing from storage.', 'ORIGINAL_MISSING');
  }

  const analysis = await analyseComposite(original, { columns, rows, padding });
  if (!analysis.isComposite) {
    throw new ApiError(
      422,
      'That layout produces a single view. Confirm at least two columns or rows.',
      'GRID_INVALID'
    );
  }
  if (analysis.layout.panelCount > GRID_LIMITS.maxPanels) {
    throw new ApiError(
      422,
      `A ${analysis.layout.columns}×${analysis.layout.rows} layout is ${analysis.layout.panelCount} views; the limit is ${GRID_LIMITS.maxPanels}.`,
      'GRID_TOO_LARGE'
    );
  }

  const setScope = doc.productSlug ? { productSlug: doc.productSlug } : { draftKey: doc.draftKey };
  const baseOrder = await nextOrder({ ...tenantFilter(req), ...setScope });
  const existing = await ProductReferenceImage.find({ ...tenantFilter(req), 'source.parentId': doc._id });
  const byIndex = new Map(existing.map((row) => [row.source?.panelIndex, row]));

  const created = [];
  const updated = [];
  const removed = [];

  for (const panel of analysis.panels) {
    const cut = await extractPanel(original, panel.box);
    const info = await describePanelBuffer(cut.buffer);
    const angle = VIEW_ANGLES.includes(String(angles[panel.index] || '')) ? String(angles[panel.index]) : '';
    const label = angle ? `${angle.replace(/-/g, ' ')} view` : `View ${panel.index + 1}`;

    let row = byIndex.get(panel.index);
    if (row) {
      // Rewrite the ORIGINAL of the panel row: the panel is derived, so unlike a
      // user upload it MAY be re-cut when the grid is corrected. Its storage key
      // is a fresh write (the old bytes are replaced, never appended).
      await storage.removeImageAssets(row._id, row.storageNamespace || tenantKey(req));
      const asset = await storage.writeAsset({
        imageId: row._id,
        workspaceSlug: doc.storageNamespace || tenantKey(req),
        kind: 'original',
        buffer: cut.buffer,
        format: 'png',
      });
      row.original = {
        storageKey: asset.storageKey,
        bytes: asset.bytes,
        width: info.width,
        height: info.height,
        format: 'png',
        hasAlpha: false,
        fileName: `panel-${panel.index + 1}.png`,
        sha256: asset.sha256,
      };
      row.source = {
        type: 'panel',
        parentId: doc._id,
        panelIndex: panel.index,
        grid: { columns: analysis.layout.columns, rows: analysis.layout.rows, padding },
        box: panel.box,
      };
      row.viewAngle = angle || row.viewAngle || '';
      row.label = label;
      row.status = 'READY';
      row.processing.engine = 'panel-extract';
      row.processing.error = '';
      row.processing.errorCode = '';
      row.warnings = [];
      row.confidence = null;
      await row.save();
      updated.push(row);
    } else {
      const panelDoc = new ProductReferenceImage({
        ...(getWorkspaceId(req.user) ? { workspaceId: getWorkspaceId(req.user) } : {}),
        productSlug: doc.productSlug || '',
        draftKey: doc.draftKey || '',
        storageNamespace: doc.storageNamespace || tenantKey(req),
        order: baseOrder + created.length,
        isPrimary: false,
        accepted: false,
        status: 'UPLOADING',
        label,
        viewAngle: angle,
        source: {
          type: 'panel',
          parentId: doc._id,
          panelIndex: panel.index,
          grid: { columns: analysis.layout.columns, rows: analysis.layout.rows, padding },
          box: panel.box,
        },
        createdBy: req.user?._id || null,
        isFixture: false,
      });
      const asset = await storage.writeAsset({
        imageId: panelDoc._id,
        workspaceSlug: doc.storageNamespace || tenantKey(req),
        kind: 'original',
        buffer: cut.buffer,
        format: 'png',
      });
      panelDoc.original = {
        storageKey: asset.storageKey,
        bytes: asset.bytes,
        width: info.width,
        height: info.height,
        format: 'png',
        hasAlpha: false,
        fileName: `panel-${panel.index + 1}.png`,
        sha256: asset.sha256,
      };
      panelDoc.status = 'READY';
      panelDoc.processing.engine = 'panel-extract';
      panelDoc.processing.finishedAt = new Date();
      await panelDoc.save();
      created.push(panelDoc);
    }
  }

  if (replace) {
    const keep = new Set(analysis.panels.map((p) => p.index));
    for (const row of existing) {
      if (keep.has(row.source?.panelIndex)) continue;
      await storage.removeImageAssets(row._id, row.storageNamespace || tenantKey(req));
      await row.deleteOne();
      removed.push(String(row._id));
    }
  }

  doc.composite.detected = true;
  doc.composite.columns = analysis.layout.columns;
  doc.composite.rows = analysis.layout.rows;
  doc.composite.padding = padding;
  doc.composite.panelCount = analysis.layout.panelCount;
  doc.composite.confidence = analysis.confidence;
  doc.composite.layoutSource = analysis.source;
  doc.composite.needsCorrection = false;
  doc.composite.confirmed = true;
  doc.composite.confirmedAt = new Date();
  doc.composite.warnings = analysis.warnings;
  doc.composite.notes = analysis.notes;
  doc.status = doc.warnings?.length ? 'NEEDS_REVIEW' : 'READY';
  await doc.save();

  return {
    parent: present(doc),
    layout: analysis.layout,
    created: created.map((row) => String(row._id)),
    updated: updated.map((row) => String(row._id)),
    removed,
    panels: [
      ...created.map((row) => ({ id: String(row._id), panelIndex: row.source.panelIndex, width: row.original.width, height: row.original.height })),
      ...updated.map((row) => ({ id: String(row._id), panelIndex: row.source.panelIndex, width: row.original.width, height: row.original.height })),
    ].sort((a, b) => a.panelIndex - b.panelIndex),
    warnings: analysis.warnings,
    notes: analysis.notes,
  };
}

/** Serve one asset to its owner only. Legacy cutout/neutral stay readable. */
export async function readReferenceAsset(req, id, kind) {
  if (!storage.ASSET_KINDS.includes(kind)) {
    throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
  }
  const doc = await loadScoped(req, id);
  const asset = kind === 'original' ? doc.original : kind === 'cutout' ? doc.cutout : doc.neutral;
  if (!asset?.storageKey) {
    throw new ApiError(404, 'That version of this reference does not exist yet.', 'ASSET_NOT_FOUND');
  }
  const buffer = await storage.readAsset(asset.storageKey);
  const contentType =
    kind === 'original' ? `image/${doc.original.format === 'jpeg' ? 'jpeg' : doc.original.format}` : 'image/png';
  return {
    buffer,
    contentType,
    fileName: `${doc._id}-${kind}.${kind === 'original' ? doc.original.format : 'png'}`,
  };
}

export async function attachReferencesToProduct(req, { productSlug, productId, ids, draftKey = '' }) {
  if (!Array.isArray(ids) || ids.length === 0) return { attached: 0 };
  const objectIds = ids.map(toObjectId).filter(Boolean);
  if (objectIds.length !== ids.length) {
    throw new ApiError(422, 'One or more reference images could not be found.', 'REFERENCE_NOT_FOUND');
  }
  const docs = await ProductReferenceImage.find({ ...tenantFilter(req), _id: { $in: objectIds } });
  if (docs.length !== objectIds.length) {
    throw new ApiError(422, 'One or more reference images could not be found.', 'REFERENCE_NOT_FOUND');
  }
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  // A view cut from a composite travels WITH its sheet, so the original
  // composite survives the draft cleanup below and stays traceable to the views
  // it produced. The sheet is attached UN-ACCEPTED: it is a source document, so
  // it is never counted in the accepted view set and never reaches the
  // reconstruction provider.
  const parentIds = [
    ...new Set(docs.map((d) => (isPanel(d) ? String(d.source?.parentId || '') : '')).filter(Boolean)),
  ];
  const sheets = parentIds.length
    ? await ProductReferenceImage.find({
        ...tenantFilter(req),
        _id: { $in: parentIds.map(toObjectId).filter(Boolean) },
      })
    : [];

  await Promise.all(
    ids.map((id, index) => {
      const doc = byId.get(String(id));
      doc.productSlug = productSlug;
      doc.productId = productId || null;
      doc.draftKey = '';
      doc.order = index;
      doc.isPrimary = index === 0;
      return doc.save();
    })
  );

  // Appended AFTER the views and never primary: the sheet is provenance, not a
  // viewpoint.
  await Promise.all(
    sheets.map((sheet, index) => {
      sheet.productSlug = productSlug;
      sheet.productId = productId || null;
      sheet.draftKey = '';
      sheet.order = ids.length + index;
      sheet.isPrimary = false;
      return sheet.save();
    })
  );

  if (draftKey) {
    await cleanupDraftReferences(req, draftKey);
  }
  // `attached` stays the number of ACCEPTED VIEWS; the sheets ride along as
  // provenance and are reported separately so the handoff message keeps its
  // "6 of 6 prepared views were attached" meaning.
  return { attached: docs.length, sourceSheets: sheets.length };
}

export async function cleanupDraftReferences(req, draftKey) {
  const docs = await ProductReferenceImage.find({ ...tenantFilter(req), draftKey: String(draftKey) });
  for (const doc of docs) {
    await storage.removeImageAssets(doc._id, tenantKey(req));
    await doc.deleteOne();
  }
  return { removed: docs.length };
}

export async function renameProductReferences(req, fromSlug, toSlug) {
  if (!fromSlug || !toSlug || fromSlug === toSlug) return { moved: 0 };
  const result = await ProductReferenceImage.updateMany(
    { ...tenantFilter(req), productSlug: String(fromSlug) },
    { $set: { productSlug: String(toSlug) } }
  );
  return { moved: result.modifiedCount ?? result.nModified ?? 0 };
}

export async function removeProductReferences(req, productSlug) {
  if (!productSlug) return { removed: 0 };
  const docs = await ProductReferenceImage.find({ ...tenantFilter(req), productSlug: String(productSlug) });
  for (const doc of docs) {
    await storage.removeImageAssets(doc._id, doc.storageNamespace || tenantKey(req));
    await doc.deleteOne();
  }
  return { removed: docs.length };
}

export async function listForProduct(req, productSlug) {
  return listReferenceImages(req, { productSlug });
}

export async function cleanupAbandoned({
  olderThanMs = 24 * 60 * 60 * 1000,
  workspaceId = null,
  allWorkspaces = false,
  dryRun = true,
  limit = 200,
} = {}) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const filter = {
    createdAt: { $lt: cutoff },
    $or: [{ status: 'UPLOADING' }, { status: 'FAILED' }, { draftKey: { $ne: '' }, productId: null }],
  };
  if (!allWorkspaces) filter.workspaceId = workspaceId || null;

  const candidates = await ProductReferenceImage.find(filter).select('_id storageNamespace').limit(limit);
  const scope = allWorkspaces ? 'all-workspaces' : workspaceId ? 'workspace' : 'platform';
  const ids = candidates.map((doc) => String(doc._id));

  if (dryRun) {
    return { dryRun: true, removed: 0, wouldRemove: candidates.length, ids, scope, cutoff };
  }

  let removed = 0;
  for (const doc of candidates) {
    await storage.removeImageAssets(doc._id, doc.storageNamespace || 'platform');
    await doc.deleteOne();
    removed += 1;
  }
  console.error(`[reference-cleanup] scope=${scope} removed=${removed} cutoff=${cutoff.toISOString()}`);
  return { dryRun: false, removed, wouldRemove: candidates.length, ids: [], scope, cutoff };
}

/** Product page helper: the references a generation may draw on. */
export async function approvedReferencesForProduct(req, productSlug) {
  const docs = await ProductReferenceImage.find({
    ...tenantFilter(req),
    productSlug: String(productSlug),
  }).sort({ isPrimary: -1, order: 1 });
  return docs.map((d) => present(d));
}

export { tenantFilter, tenantKey, IMAGE_RULES, isPanel };
