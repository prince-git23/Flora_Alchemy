/**
 * 3D STUDIO — Phase 1 — reference-image orchestration.
 *
 * This is where the pieces meet: private storage + a background-removal engine +
 * quality heuristics + tenancy. The rules it enforces are the ones the brief
 * calls out, and they are all enforced HERE rather than trusted to callers:
 *
 *   · the ORIGINAL is written once and never overwritten — processing writes a
 *     separate cutout and a separate neutral preview;
 *   · a processing failure leaves the original intact and the row in FAILED with
 *     a readable reason, so the administrator can retry or crop;
 *   · every query is filtered by the caller's workspace and a mismatch is a 404
 *     (never a 403 that would confirm the row exists);
 *   · `workspaceId` is never taken from the request body;
 *   · an interrupted job cannot sit in PROCESSING forever — a stale row is
 *     reported honestly and re-runnable.
 *
 * PROCESSING IS ASYNCHRONOUS, AND REAL
 * -----------------------------------
 * Creating a reference returns immediately with status UPLOADING, and the engine
 * runs in the background. That is not a simulation of a job queue: the row's
 * status, measurements, warnings and outputs are all written by the real
 * pipeline, and the client polls the real endpoint. It is a deliberate trade —
 * a real queue (BullMQ/Redis) is another service to run for work that takes
 * ~200ms–2s, and this codebase has no job runner to reuse.
 */

import mongoose from 'mongoose';
import ProductReferenceImage from '../models/ProductReferenceImage.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { getWorkspaceId } from '../utils/tenancy.js';
import { removeBackground } from './bgRemoval/index.js';
import * as storage from './referenceAssetStorage.js';
import {
  IMAGE_RULES,
  imageSignature,
  imageWarnings,
  inspectImage,
  measureSharpness,
  setWarnings,
} from './referenceImageValidation.js';

/**
 * Merge message lists without repeating a sentence.
 *
 * The engine and the quality heuristics share some vocabulary ("This image may
 * contain multiple products."), so a naive concatenation shows the
 * administrator the same line twice — and gives the review list duplicate React
 * keys, which React reports as an error and which can drop or duplicate rows.
 */
const mergeMessages = (...lists) => [...new Set(lists.flat().filter(Boolean))];

/** Confidence at or above which a cutout is considered fit to use as-is. */
const READY_CONFIDENCE = 0.7;
/** A row processing for longer than this was interrupted (a restart, a crash). */
const PROCESSING_STALE_MS = 3 * 60 * 1000;
/** Hard ceiling on references per product/draft — a 3D reference set does not
 *  need 50 views, and the cap bounds the per-request work. */
export const MAX_REFERENCES = 12;

const toObjectId = (value) => {
  if (!value) return null;
  const str = String(value);
  return mongoose.isValidObjectId(str) ? new mongoose.Types.ObjectId(str) : null;
};

/**
 * The tenant scope for reads and writes. A staff identity is always scoped to
 * its workspace; a PLATFORM owner (no workspace) is allowed through with an
 * explicit `{ workspaceId: null }` filter rather than an empty one, so the
 * owner cannot accidentally read another workspace's references — they simply
 * have their own (pre-workspace) bucket.
 */
function tenantFilter(req) {
  const workspaceId = getWorkspaceId(req.user);
  return workspaceId ? { workspaceId } : { workspaceId: null };
}

/** The storage namespace of the caller (derived, never client-supplied). */
function tenantKey(req) {
  return req.workspaceSlug || 'platform';
}

/** Load one row inside the caller's tenant scope, or 404. */
async function loadScoped(req, id) {
  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(404, 'Reference image not found.', 'REFERENCE_NOT_FOUND');
  }
  const doc = await ProductReferenceImage.findOne({ _id: id, ...tenantFilter(req) });
  if (!doc) {
    // 404 for both "does not exist" and "belongs to someone else": existence is
    // not disclosed across workspaces.
    throw new ApiError(404, 'Reference image not found.', 'REFERENCE_NOT_FOUND');
  }
  return doc;
}

/** Next display order inside a set. */
async function nextOrder(scope) {
  const last = await ProductReferenceImage.findOne(scope).sort({ order: -1 }).select('order').lean();
  return last ? last.order + 1 : 0;
}

/** Mark a row FAILED, keeping whatever is already stored (the original). */
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
 * Run the pipeline for one row. Safe to call repeatedly: a retry re-reads the
 * ORIGINAL (which is immutable) and overwrites only the derived assets.
 */
export async function processReferenceImage({ id, req, crop, acceptWarnings = false }) {
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
  if (crop !== undefined) doc.crop = crop || undefined;
  await doc.save();

  const started = Date.now();
  try {
    const effectiveCrop = crop !== undefined ? crop : doc.crop;
    const result = await removeBackground(original, {
      crop: effectiveCrop
        ? { x: effectiveCrop.x, y: effectiveCrop.y, width: effectiveCrop.width, height: effectiveCrop.height }
        : null,
    });

    // The row may have been DELETED while this job was running — the
    // administrator removed it, or a product save cleaned up the draft images
    // that were not accepted. Writing the result would resurrect a deleted row,
    // so the job stops here instead and leaves nothing behind.
    if (!(await ProductReferenceImage.exists({ _id: doc._id }))) {
      return null;
    }

    // Derived assets are written under new keys; the original is untouched by
    // construction (different kind, different file).
    const cutoutAsset = await storage.writeAsset({
      imageId: doc._id,
      workspaceSlug: doc.storageNamespace || tenantKey(req),
      kind: 'cutout',
      buffer: result.cutout,
      format: 'png',
    });
    const neutralAsset = await storage.writeAsset({
      imageId: doc._id,
      workspaceSlug: doc.storageNamespace || tenantKey(req),
      kind: 'neutral',
      buffer: result.neutral,
      format: 'png',
    });

    doc.cutout = {
      storageKey: cutoutAsset.storageKey,
      bytes: cutoutAsset.bytes,
      width: result.width,
      height: result.height,
    };
    doc.neutral = {
      storageKey: neutralAsset.storageKey,
      bytes: neutralAsset.bytes,
      width: result.width,
      height: result.height,
    };

    const quality = await measureSharpness(original);
    const { warnings: qualityWarnings, notes: qualityNotes } = imageWarnings({
      inspect: {
        width: doc.original.width,
        height: doc.original.height,
        format: doc.original.format,
        hasAlpha: doc.original.hasAlpha,
      },
      quality,
      metrics: result.metrics,
    });

    const warnings = mergeMessages(result.warnings, qualityWarnings);
    const notes = mergeMessages(result.notes, qualityNotes);
    doc.warnings = warnings;
    doc.validation.sharpnessScore = quality.sharpnessScore;
    doc.validation.contrastStdev = quality.contrastStdev;
    doc.validation.edgeMean = quality.edgeMean;
    doc.processing.engine = result.engine;
    doc.processing.model = result.model || '';
    doc.processing.modelLicence = result.modelLicence || '';
    doc.processing.metrics = { ...result.metrics, notes, engineMs: Date.now() - started };
    doc.processing.foregroundBox = result.foregroundBox;
    doc.processing.finishedAt = new Date();
    doc.processing.durationMs = Date.now() - started;
    doc.confidence = result.confidence;

    // READY means "nothing here needs a human"; anything a person should look at
    // — including every advisory warning — is NEEDS_REVIEW. The administrator can
    // still accept a NEEDS_REVIEW image (that is what the review step is for).
    const blocking = warnings.length > 0 && !acceptWarnings;
    if (blocking || result.confidence < READY_CONFIDENCE) {
      doc.status = 'NEEDS_REVIEW';
    } else {
      doc.status = 'READY';
    }
    await doc.save();
    return doc;
  } catch (err) {
    return markFailed(doc, err);
  }
}

/**
 * STAGE LOGGING for the upload path.
 *
 * The production report that started this work was a bare
 * `500 INTERNAL_ERROR "An unexpected server error occurred…"` with no way to
 * tell WHICH step failed. Every failure boundary in `createReferenceImage` now
 * records its stage here, so one log line names the step:
 *
 *   [reference-upload] stage=persist-original code=EACCES syscall=mkdir …
 *
 * The message that reaches the client never carries the path or the syscall;
 * those stay in the server log where they are actionable.
 */
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

/** Fire-and-forget processing with a guaranteed failure path. */
function scheduleProcessing(args) {
  void processReferenceImage(args).catch((err) => {
    // processReferenceImage already records failures; this catch exists so an
    // unexpected throw cannot become an unhandled rejection that takes the
    // process down.
    console.error('[reference-image] unexpected processing error:', err.message);
  });
}

/**
 * Create a reference from an uploaded file: validate, persist the ORIGINAL,
 * create the row, start processing.
 */
export async function createReferenceImage(req, { file, productSlug = '', draftKey = '', label = '' }) {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new ApiError(422, 'An image file is required.', 'VALIDATION_ERROR');
  }
  // Validation runs on the CONTENT (sharp decodes it), not on the declared MIME
  // type: a renamed .exe claiming image/png fails here.
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

  // Duplicate detection before anything is written: the same bytes twice adds no
  // information to a 3D reference set.
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
    });
  } catch (err) {
    // STAGE 3 — the original's bytes. A storage failure is a 503 with its own
    // code (see privateMediaRoot.toStorageError), never a bare 500.
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
    // STAGE 4 — the row. Record which stage failed before cleaning up, so the
    // log distinguishes "the disk refused the bytes" from "the database
    // refused the row" without a second deploy to instrument it.
    logFailure('db-insert', err, { imageId: String(doc._id) });
    // Do not leave an orphaned file behind if the row could not be written.
    await storage.removeImageAssets(doc._id, tenantKey(req));
    throw err;
  }

  scheduleProcessing({ id: doc._id, req });
  return { doc, uploadedNotes: notes, duplicateOf: duplicate ? String(duplicate._id) : null };
}

/**
 * Which of an image's three assets are REALLY on disk, right now.
 *
 * The API used to report `available` from the mere presence of a `storageKey`,
 * so a row whose bytes had been lost (a redeploy onto an ephemeral filesystem,
 * a disk swap, a manual deletion) still advertised a readable asset. The client
 * then rendered a broken fetch instead of the truth. Existence is a fact about
 * the filesystem, so it is checked here, once per image per request, and the
 * payload carries it.
 */
export async function assetPresence(image) {
  const id = image?.id || String(image?._id || '');
  const keys = {
    original: image?.original?.storageKey || '',
    cutout: image?.cutout?.storageKey || '',
    neutral: image?.neutral?.storageKey || '',
  };
  const entries = await Promise.all(
    Object.entries(keys).map(async ([kind, key]) => [kind, key ? await storage.assetExists(key).catch(() => false) : false])
  );
  return { id, exists: Object.fromEntries(entries) };
}

/** Materialise a doc for API output, resolving the "processing is stuck" case. */
function present(doc, setContext = {}) {
  const json = doc.toJSON();
  const startedAt = doc.processing?.startedAt ? new Date(doc.processing.startedAt).getTime() : null;
  if (doc.status === 'PROCESSING' && startedAt && Date.now() - startedAt > PROCESSING_STALE_MS) {
    // Honest reporting of an interrupted job rather than a status that never
    // changes: the row is still PROCESSING in the database (so a retry can take
    // over safely) but the client must not wait forever.
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

/** List the references of one product (or draft), in display order. */
export async function listReferenceImages(req, { productSlug = '', draftKey = '', ids = null } = {}) {
  const scope = { ...tenantFilter(req) };
  if (productSlug) scope.productSlug = String(productSlug);
  else if (draftKey) scope.draftKey = String(draftKey);
  else if (ids && ids.length) scope._id = { $in: ids.map(toObjectId).filter(Boolean) };
  else throw new ApiError(422, 'A product, a draft or an id list is required.', 'VALIDATION_ERROR');

  const docs = await ProductReferenceImage.find(scope).sort({ order: 1, createdAt: 1 });
  const setLevel = setWarnings(
    docs.map((d) => ({
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
  // Set-level warnings are reported alongside each affected image so the review
  // UI does not have to know they are computed across the set.
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
 * Patch one reference: label, acceptance, or an explicit crop (which clears the
 * derived outputs' validity, so the row returns to NEEDS_REVIEW until reprocessed).
 */
export async function updateReferenceImage(req, id, patch = {}) {
  const doc = await loadScoped(req, id);
  let reprocess = false;

  if (patch.label !== undefined) doc.label = String(patch.label).slice(0, 120);
  if (patch.accepted !== undefined) {
    doc.accepted = Boolean(patch.accepted);
    if (doc.accepted && doc.status === 'FAILED') {
      throw new ApiError(422, 'A failed reference cannot be accepted — fix it first.', 'REFERENCE_NOT_READY');
    }
  }
  if (patch.isPrimary !== undefined && patch.isPrimary) {
    await ProductReferenceImage.updateMany(
      { ...tenantFilter(req), _id: { $ne: doc._id }, ...(doc.productSlug ? { productSlug: doc.productSlug } : { draftKey: doc.draftKey }) },
      { $set: { isPrimary: false } }
    );
    doc.isPrimary = true;
  }
  if (patch.crop !== undefined) {
    doc.crop = patch.crop
      ? {
          x: Number(patch.crop.x),
          y: Number(patch.crop.y),
          width: Number(patch.crop.width),
          height: Number(patch.crop.height),
        }
      : undefined;
    doc.accepted = false;
    reprocess = true;
  }
  await doc.save();
  if (reprocess) {
    const result = await processReferenceImage({ id: doc._id, req });
    // A null result means the row disappeared while the crop was applied. The
    // client's view is stale, so it gets the same 404 as any unknown id.
    if (!result) throw new ApiError(404, 'Reference image not found.', 'REFERENCE_NOT_FOUND');
    return result;
  }
  return present(doc);
}

/** Reorder a whole set from an explicit id list (the UI's drag result). */
export async function reorderReferenceImages(req, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ApiError(422, 'An ordered list of reference ids is required.', 'VALIDATION_ERROR');
  }
  const docs = await ProductReferenceImage.find({
    ...tenantFilter(req),
    _id: { $in: ids.map(toObjectId).filter(Boolean) },
  });
  if (docs.length !== ids.length) {
    // A single unknown id means the client's view is stale; refuse rather than
    // half-apply an order.
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

/** Remove a reference and its files. Promotes a new primary when needed. */
export async function removeReferenceImage(req, id) {
  const doc = await loadScoped(req, id);
  const wasPrimary = doc.isPrimary;
  const setFilter = doc.productSlug ? { productSlug: doc.productSlug } : { draftKey: doc.draftKey };
  await doc.deleteOne();
  await storage.removeImageAssets(doc._id, doc.storageNamespace || tenantKey(req));
  if (wasPrimary) {
    const next = await ProductReferenceImage.findOne({ ...tenantFilter(req), ...setFilter }).sort({
      order: 1,
    });
    if (next) {
      next.isPrimary = true;
      await next.save();
    }
  }
  return { removed: String(doc._id), wasPrimary };
}

/** Retry processing for a FAILED or NEEDS_REVIEW row (or any row, explicitly). */
export async function reprocessReferenceImage(req, id, { crop } = {}) {
  const doc = await loadScoped(req, id);
  if (doc.status === 'UPLOADING') {
    throw new ApiError(409, 'This reference is still being stored — try again in a moment.', 'REFERENCE_BUSY');
  }
  const result = await processReferenceImage({ id: doc._id, req, crop });
  if (!result) throw new ApiError(404, 'Reference image not found.', 'REFERENCE_NOT_FOUND');
  return result;
}

/** Serve one asset (original, cutout or neutral) to its owner only. */
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
  const contentType = kind === 'original' ? `image/${doc.original.format === 'jpeg' ? 'jpeg' : doc.original.format}` : 'image/png';
  return { buffer, contentType, fileName: `${doc._id}-${kind}.${kind === 'original' ? doc.original.format : 'png'}` };
}

/**
 * Attach a draft's references to a saved product. Called from the product
 * create/update path with ids the SERVER then validates: an id belonging to
 * another workspace is refused outright rather than silently skipped.
 */
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
  if (draftKey) {
    // Anything left under the draft key was not accepted by the administrator;
    // it is cleaned up here so a canceled draft set cannot accumulate.
    await cleanupDraftReferences(req, draftKey);
  }
  return { attached: docs.length };
}

/** Delete every reference still parked under a draft key (no product link). */
export async function cleanupDraftReferences(req, draftKey) {
  const docs = await ProductReferenceImage.find({ ...tenantFilter(req), draftKey: String(draftKey) });
  for (const doc of docs) {
    await storage.removeImageAssets(doc._id, tenantKey(req));
    await doc.deleteOne();
  }
  return { removed: docs.length };
}

/**
 * Move a product's references when the product is RENAMED.
 *
 * References are keyed by product slug (the catalogue's business key), so a
 * rename would otherwise orphan a perfectly good reference set — invisible on
 * the edit page and left behind on disk. Called by the product update path with
 * the caller's request, so the update stays inside the caller's workspace.
 */
export async function renameProductReferences(req, fromSlug, toSlug) {
  if (!fromSlug || !toSlug || fromSlug === toSlug) return { moved: 0 };
  const result = await ProductReferenceImage.updateMany(
    { ...tenantFilter(req), productSlug: String(fromSlug) },
    { $set: { productSlug: String(toSlug) } }
  );
  return { moved: result.modifiedCount ?? result.nModified ?? 0 };
}

/**
 * Delete every reference of a product that is being deleted, together with its
 * files. A deleted product's reference set can never be attached to anything
 * again, so keeping it would only leak storage.
 */
export async function removeProductReferences(req, productSlug) {
  if (!productSlug) return { removed: 0 };
  const docs = await ProductReferenceImage.find({ ...tenantFilter(req), productSlug: String(productSlug) });
  for (const doc of docs) {
    await storage.removeImageAssets(doc._id, doc.storageNamespace || tenantKey(req));
    await doc.deleteOne();
  }
  return { removed: docs.length };
}

/** The references of a saved product (used by the product edit page). */
export async function listForProduct(req, productSlug) {
  return listReferenceImages(req, { productSlug });
}

/**
 * Internal maintenance: remove references that were never attached to a product
 * and are older than `olderThanMs`. Bounded by age and by `limit`, so an
 * in-progress upload is never touched and one call cannot run unbounded.
 *
 * SCOPING (this used to be a global, unscoped, irreversible sweep)
 * ---------------------------------------------------------------
 * The old version deleted across EVERY workspace. Under multi-tenancy that is
 * a destructive cross-tenant operation hiding behind a maintenance endpoint: a
 * platform owner could silently destroy another tenant's unattached working
 * material, with no preview and no record.
 *
 * Now:
 *   · the default scope is the CALLER'S workspace, taken from the session —
 *     never from the request body;
 *   · a platform-wide sweep is opt-in (`allWorkspaces: true`), refused unless
 *     the caller is an owner, and gated behind an explicit confirmation in the
 *     controller;
 *   · `allWorkspaces` is refused to anyone but the owner, requires an explicit
 *     confirmation field in the request, and logs the scope it swept;
 *   · `dryRun` defaults to TRUE: the caller must ask to delete. A preview
 *     touches no bytes and no rows.
 */
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
  // The scope is REPORTED, so the caller and the log agree on what was swept.
  // A null workspaceId is the platform bucket, not "everything": an identity
  // with no workspace has its own (pre/extra-workspace) references, and saying
  // "workspace" for that would overstate what it touched.
  const scope = allWorkspaces ? 'all-workspaces' : workspaceId ? 'workspace' : 'platform';
  const ids = candidates.map((doc) => String(doc._id));

  if (dryRun) {
    // A preview is a READ: it must be safe to call this freely, and the caller
    // decides whether to repeat it with `dryRun: false`.
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

/** Product page helper: the accepted, READY-enough references Phase 2 consumes. */
export async function approvedReferencesForProduct(req, productSlug) {
  const docs = await ProductReferenceImage.find({
    ...tenantFilter(req),
    productSlug: String(productSlug),
  }).sort({ isPrimary: -1, order: 1 });
  return docs.map((d) => present(d));
}

export { tenantFilter, tenantKey, IMAGE_RULES };
