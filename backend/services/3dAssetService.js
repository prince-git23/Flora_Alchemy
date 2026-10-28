/**
 * 3D ASSET SERVICE — 3D Studio (Phase 2) — asset life cycle and private reads.
 *
 * Everything an administrator can do to a generated model lives here:
 * create a candidate from validated provider bytes, approve it, reject it, list
 * a product's assets, and stream the bytes back to its owner.
 *
 * THE RULES THIS MODULE ENFORCES
 *
 *   · Only a CANDIDATE with VALIDATED GLB bytes can be approved or previewed. A
 *     row without validated bytes is not a model, so `hasValidatedModel` gates
 *     both paths.
 *   · Approving a candidate DEPRECATES the product's previous approved asset
 *     rather than deleting it — the live model is never destroyed by a
 *     replacement that might itself be a mistake.
 *   · A rejected or failed replacement changes nothing about the approved asset.
 *   · Every read is scoped to the caller's workspace, and a mismatch is a 404.
 */

import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import Product3DAsset, {
  STATUS_APPROVED,
  STATUS_CANDIDATE,
  STATUS_DEPRECATED,
  STATUS_REJECTED,
  hasValidatedModel,
  normalizeObjectId,
  publicAssetProjection,
  /* PHASE 6 — the fingerprint/is-current pair moved onto the MODEL, because it
     describes the stored row rather than this service, and the staff projection
     needs it to report a stale verdict. Re-exported below so every existing
     caller (the smoke suite included) keeps the same API. */
  qualityFingerprint,
  qualityIsCurrent,
} from '../models/Product3DAsset.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { cacheInvalidate3dDelivery } from '../utils/publicCache.js';
import { getWorkspaceId, scopeFor, workspaceScope } from '../utils/tenancy.js';
import * as storage from './3dAssetStorage.js';
import { validateGlb } from './3dModelValidation.js';
import {
  ASSESSMENT_VERSION,
  DECISION_BLOCKED,
  DECISION_REVIEW,
  assessCandidate,
} from './3dQualityAssessment.js';

/** Load one asset inside the caller's workspace, or throw 404. */
async function loadScoped(req, assetId) {
  const id = normalizeObjectId(assetId);
  if (!id) throw new ApiError(404, '3D asset not found.', 'ASSET_NOT_FOUND');
  const doc = await Product3DAsset.findOne({ _id: id, ...workspaceScope(req.user) });
  if (!doc) throw new ApiError(404, '3D asset not found.', 'ASSET_NOT_FOUND');
  return doc;
}

export async function listAssetsForProduct(req, productSlug) {
  const docs = await Product3DAsset.find({
    ...workspaceScope(req.user),
    productSlug: String(productSlug || ''),
  }).sort({ createdAt: -1 });
  return docs.map(publicAssetProjection);
}

export async function getAsset(req, assetId) {
  const doc = await loadScoped(req, assetId);
  return publicAssetProjection(doc);
}

/** The single approved model for a product, or null. */
export async function findApproved(req, productSlug) {
  const doc = await Product3DAsset.findOne({
    ...workspaceScope(req.user),
    productSlug: String(productSlug || ''),
    status: STATUS_APPROVED,
  });
  return doc || null;
}

/**
 * The single approved model for a product IN A GIVEN WORKSPACE, or null.
 *
 * This is the PHASE 3 storefront read: an anonymous visitor has no workspace of
 * their own, so the owner is taken from the PRODUCT being viewed (the product
 * document's own `workspaceId`) rather than from an identity. Without it, a
 * second workspace's approved row naming the same product slug could be the one
 * a customer is shown — and the delivery controller, which refuses a mismatch,
 * would then 404 every time the button was pressed.
 *
 * An unscoped legacy product (no workspaceId) keeps the historical unscoped
 * lookup: its slug is globally unique, so the only rows naming it are its own.
 */
export async function findApprovedInWorkspace(productSlug, workspaceId = null) {
  const filter = { productSlug: String(productSlug || ''), status: STATUS_APPROVED };
  if (workspaceId) filter.workspaceId = workspaceId;
  const doc = await Product3DAsset.findOne(filter);
  return doc || null;
}

/* ── PHASE 5 — THE QUALITY GATE ────────────────────────────────────────────
 *
 * The gate lives in this service, not in React, for the same reason Phase 2's
 * approval rules do: a client can render a dialog, but it cannot be trusted with
 * a verdict. Three consequences follow, and they are the whole design:
 *
 *   1. the report is ASSOCIATED WITH EXACT BYTES (a fingerprint over the GLB's
 *      sha256, the reference ids and the generation settings), so a report can
 *      never be inherited by a model it did not measure;
 *   2. a missing or stale report is RE-COMPUTED from storage before any approval
 *      is honoured — never assumed, and never taken from the request;
 *   3. any `quality`-shaped field a request tries to submit is IGNORED, because
 *      nothing in the request path reads one.
 */

/* `qualityFingerprint` / `qualityIsCurrent` are imported from the model and
   re-exported at the bottom of this file; their definitions live beside the
   schema that stores the fingerprint. */

/** Who may override a BLOCKED verdict: an administrator, not a handler. */
export function canOverrideQuality(req) {
  const user = req?.user || {};
  return user.role === 'admin' || user.isOwner === true;
}

/** Pull one reason's text out of a report, for an error message a human reads. */
function reasonMessage(report, ...codes) {
  for (const code of codes) {
    const hit = (report?.reasons || []).find((reason) => reason.code === code);
    if (hit?.message) return hit.message;
  }
  return '';
}

/**
 * Measure one candidate and store the verdict ON THE ASSET.
 *
 * Never throws: a model that cannot be measured is a REVIEW-grade fact, and
 * losing the asset over it would be worse than recording that the assessment
 * itself failed. A verdict reached against DIFFERENT bytes clears any previous
 * human acknowledgement — an acknowledgement is about a model, not a slot.
 */
export async function assessAssetQuality(req, doc, { glbBuffer = null, thresholds = {} } = {}) {
  const previousFingerprint = doc.quality?.fingerprint || '';
  const fingerprint = qualityFingerprint(doc);
  let report = null;
  let failure = '';

  try {
    const bytes =
      glbBuffer ||
      (doc.storage?.glb?.storageKey ? await storage.readAsset(doc.storage.glb.storageKey) : null);
    if (!bytes?.length) {
      failure = 'The stored model file could not be read back for assessment.';
    } else {
      /* THE WORKER'S DIAGNOSTICS JOIN THE ASSESSMENT — narrowly.
         `inputUsed` names the photograph that actually produced this mesh (so
         THAT reference, not the nominal primary, is the one compared against),
         and `maskPng` is the foreground mask the worker made from it — a real
         product-only silhouette, which lets the gate catch a whole-photo
         "shell" instead of reporting an unavailable reference forever. Both
         live on the job's whitelisted `providerExtra.metrics`; reading them
         must never break an assessment, so every failure degrades to today's
         behaviour (no override, primary reference, reference mask only). */
      let maskOverride = null;
      let maskSource = '';
      let preferredReferenceId = '';
      let workerOrientation = null;
      try {
        if (doc.jobId) {
          const job = await mongoose.model('GenerationJob').findById(doc.jobId).select('providerExtra').lean();
          const metrics = job?.providerExtra?.metrics;
          preferredReferenceId = metrics?.inputUsed?.id ? String(metrics.inputUsed.id) : '';
          // PHASE 9 — the worker's measured frame facts ride the same narrow
          // diagnostics channel; a malformed value degrades to "not recorded".
          workerOrientation =
            metrics?.orientation && typeof metrics.orientation === 'object'
              ? metrics.orientation
              : null;
          if (metrics?.maskPng) {
            const decoded = Buffer.from(String(metrics.maskPng), 'base64');
            // A 128px-class PNG is under 4 KB; anything else is not a mask.
            if (decoded.length >= 64 && decoded.length <= 200_000) {
              maskOverride = decoded;
              maskSource = 'worker-foreground-mask';
            }
          }
        }
      } catch {
        maskOverride = null;
        maskSource = '';
        preferredReferenceId = '';
        workerOrientation = null;
      }

      report = await assessCandidate({
        req,
        glbBuffer: bytes,
        referenceIds: doc.source?.referenceIds || [],
        settings: typeof doc.settings?.toObject === 'function' ? doc.settings.toObject() : doc.settings || {},
        thresholds,
        productSlug: doc.productSlug || '',
        maskOverride,
        maskSource,
        preferredReferenceId,
        workerOrientation,
      });
    }
  } catch (err) {
    failure = `The quality assessment could not be completed (${err?.message || String(err)}).`;
  }

  if (!report) {
    report = {
      version: ASSESSMENT_VERSION,
      assessedAt: new Date().toISOString(),
      decision: DECISION_REVIEW,
      summary: failure || 'The quality assessment could not be completed, so a human must review this model.',
      reasons: [{ code: 'ASSESSMENT_FAILED', message: failure || 'The quality assessment could not be completed.', metric: null }],
      warnings: [],
      geometry: null,
      silhouette: { available: false, reason: failure },
      orientation: null,
      materials: null,
      reference: null,
      calibration: { version: ASSESSMENT_VERSION, genuineSamples: 1, provisional: true },
    };
  }

  const changed = previousFingerprint !== fingerprint;
  /* PHASE 6 — the carried-over fields are copied as PLAIN VALUES, never by
     re-assigning the hydrated subdocument that held them. Re-inserting it made
     Mongoose's nested casting write `undefined` into `quality.review` and
     `quality.override`, so a re-assessment of an UNCHANGED model (exactly what
     `POST /api/3d/assets/:assetId/assess` does) failed validation and 500'd.
     Found by an E2E fixture, not by review: the changed-report path is the one
     every other test happened to take. */
  const previous = typeof doc.quality?.toObject === 'function' ? doc.quality.toObject() : doc.quality || {};
  const keptReview = changed ? null : previous.review || null;
  const keptOverride = changed ? null : previous.override || null;

  doc.quality = {
    version: report.version || ASSESSMENT_VERSION,
    decision: report.decision || DECISION_REVIEW,
    assessedAt: new Date(),
    fingerprint,
    summary: report.summary || '',
    report,
    // A different model, reference set or setting is a different question, so a
    // previous answer to the old question does not carry over.
    review: {
      acknowledgedBy: keptReview?.acknowledgedBy ?? null,
      acknowledgedAt: keptReview?.acknowledgedAt ?? null,
      note: keptReview?.note || '',
    },
    override: {
      by: keptOverride?.by ?? null,
      at: keptOverride?.at ?? null,
      reason: keptOverride?.reason || '',
      previousDecision: keptOverride?.previousDecision || '',
    },
  };
  await doc.save();
  return report;
}

/**
 * Guarantee a CURRENT verdict before a decision is honoured, re-measuring when
 * the stored one is missing or stale. This is the only way the approval path
 * learns a decision, which is what makes "the backend enforces the gate" true.
 */
export async function ensureQualityReport(req, doc, { thresholds = {}, force = false } = {}) {
  if (!force && qualityIsCurrent(doc)) {
    return { reassessed: false, decision: doc.quality.decision, report: doc.quality.report };
  }
  const report = await assessAssetQuality(req, doc, { thresholds });
  return { reassessed: true, decision: report.decision, report };
}

/**
 * Turn downloaded provider bytes into a CANDIDATE asset.
 *
 * The bytes are validated BEFORE anything is written: an invalid download never
 * reaches the private media root, so a bad provider response cannot leave a
 * half-file behind that a later screen might mistake for a model.
 */
export async function createCandidateFromGeneration(
  req,
  { job, glbBuffer, providerTaskId = '', thumbnailBuffer = null }
) {
  const validation = validateGlb(glbBuffer);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.message), {
      code: validation.code,
      validation,
    });
  }

  // TRUSTED CONTEXT — the remote GPU agent's result arrives on a machine
  // request with no user; its scope comes from the AUTHORITATIVE job's own
  // workspace (see services/3dAgentService.trustedContextForJob). Staff calls
  // are unchanged: they carry a workspace-scoped user.
  const scope = scopeFor(req);

  // Version is per product, so the studio can show "v3 replaced v2".
  const count = await Product3DAsset.countDocuments({
    ...scope,
    productSlug: job.productSlug,
  });

  const asset = new Product3DAsset({
    workspaceId: req.workspaceId || getWorkspaceId(req.user) || null,
    productSlug: job.productSlug,
    jobId: normalizeObjectId(job._id || job.id) || null,
    status: STATUS_CANDIDATE,
    version: count + 1,
    provider: job.provider || '',
    providerModel: job.providerModel || '',
    providerModelVersion: job.providerModelVersion || '',
    providerTaskId: String(providerTaskId || ''),
    source: {
      referenceIds: job.source?.referenceIds || [],
      viewCount: job.source?.viewCount || 0,
      label: job.source?.label || '',
    },
    validation: {
      ok: true,
      magic: validation.magic,
      gltfVersion: validation.gltfVersion,
      declaredBytes: validation.declaredBytes,
      meshes: validation.meshes,
      materials: validation.materials,
      textures: validation.textures,
      notes: `Validated: ${validation.meshes} mesh(es), ${validation.materials} material(s), ${validation.textures} texture(s).`,
    },
    settings: { quality: job.settings?.quality || 'standard', notes: job.settings?.notes || '' },
    createdBy: req.user?._id || null,
  });

  // The GLB is written FIRST (it is the evidence of generation); the thumbnail
  // is a derived convenience and is allowed to fail without failing the job.
  // `expectSha256` makes a RETRY after an interrupted run (bytes uploaded, row
  // not yet saved) a safe no-op instead of an immutability refusal — identical
  // bytes only; different bytes are still refused.
  const glb = await storage.writeAsset({
    fileId: asset._id,
    workspaceSlug: req.workspaceSlug || 'platform',
    kind: 'glb',
    buffer: glbBuffer,
    format: 'glb',
    expectSha256: createHash('sha256').update(glbBuffer).digest('hex'),
  });
  asset.storage.glb = { storageKey: glb.storageKey, bytes: glb.bytes, sha256: glb.sha256 };

  if (thumbnailBuffer && thumbnailBuffer.length) {
    const thumb = await storage
      .writeAsset({
        fileId: asset._id,
        workspaceSlug: req.workspaceSlug || 'platform',
        kind: 'thumbnail',
        buffer: thumbnailBuffer,
        format: 'png',
      })
      .catch(() => null);
    if (thumb) asset.storage.thumbnail = { storageKey: thumb.storageKey, bytes: thumb.bytes };
  }

  // PHASE 5 — measure the candidate NOW, before it is visible as ready, so an
  // administrator opens a screen that already carries a verdict rather than a
  // blank "not assessed yet". Never fatal: see `assessAssetQuality`.
  await assessAssetQuality(req, asset, { glbBuffer });

  try {
    await asset.save();
  } catch (err) {
    // Do not leave orphaned bytes behind when the row could not be written.
    await storage.removeAssetFiles(asset._id, req.workspaceSlug || 'platform');
    throw err;
  }
  return asset;
}

/**
 * Discard a candidate that must NOT survive (remote agent result: the job was
 * cancelled or its lease lost while the bytes were being validated). Removes
 * the private files first, then the row — the reverse of creation, so a crash
 * between the two leaves a row with no bytes (visible, deletable) rather than
 * invisible orphaned files.
 */
export async function discardCandidate(ctx, asset) {
  if (!asset?._id) return;
  const slug = ctx?.workspaceSlug || 'platform';
  await storage.removeAssetFiles(asset._id, slug).catch(() => {});
  await Product3DAsset.deleteOne({ _id: asset._id }).catch(() => {});
}

/**
 * Approve a candidate so it becomes the product's live model.
 *
 * The previous approved asset is DEPRECATED, never deleted: a later decision can
 * put it back without a re-generation, and the customer-facing model is never
 * left empty by this operation.
 */
export async function approveAsset(
  req,
  assetId,
  { reviewNote = '', override = false, overrideReason = '', thresholds = {} } = {}
) {
  const doc = await loadScoped(req, assetId);

  if (doc.status !== STATUS_CANDIDATE) {
    throw new ApiError(
      422,
      `Only a candidate model can be approved. This one is ${doc.status.toLowerCase()}.`,
      'ASSET_NOT_CANDIDATE'
    );
  }
  if (!hasValidatedModel(doc)) {
    throw new ApiError(
      422,
      'This candidate has no validated model file, so it cannot be approved.',
      'ASSET_HAS_NO_MODEL'
    );
  }

  /* PHASE 5 GATE. The verdict comes from a report about THESE bytes against THIS
     reference set — recomputed here if it is missing or stale. A `quality` field
     in the request body is never read: the only inputs are the measured bytes,
     the accepted reference and the thresholds. */
  const gate = await ensureQualityReport(req, doc, { thresholds });
  const decision = gate.decision;
  const report = gate.report || doc.quality?.report || null;
  const silhouette = report?.silhouette;
  const measured = silhouette?.available
    ? ` Measured: IoU ${silhouette.iou}, aspect error ${(silhouette.aspectError * 100).toFixed(0)}%, best view "${silhouette.selectedView}".`
    : ' No silhouette measurement was possible.';

  if (decision === DECISION_BLOCKED) {
    if (!override) {
      throw new ApiError(
        422,
        `The quality gate blocked this model, so it cannot be approved normally.${measured} ` +
          `${reasonMessage(report, 'SILHOUETTE_SEVERE_MISMATCH', 'STRUCTURAL_INVALID', 'GEOMETRY_EMPTY')} ` +
          'Regenerate it from a cleaner reference image, or have an administrator override with a stated reason.',
        'QUALITY_BLOCKED'
      );
    }
    if (!canOverrideQuality(req)) {
      throw new ApiError(
        403,
        'Only an administrator can override a blocked quality verdict.',
        'QUALITY_OVERRIDE_FORBIDDEN'
      );
    }
    const reason = String(overrideReason || '').trim();
    if (!reason) {
      throw new ApiError(
        422,
        'An override needs a reason. Say why this blocked model is being published anyway.',
        'QUALITY_OVERRIDE_REASON_REQUIRED'
      );
    }
    // The override records what it overrode: the audit trail must show the gate
    // said BLOCKED, not only that somebody pushed past it.
    doc.quality.override = {
      by: req.user?._id || null,
      at: new Date(),
      reason: reason.slice(0, 500),
      previousDecision: decision,
    };
  } else if (decision === DECISION_REVIEW) {
    const note = String(reviewNote || '').trim();
    if (note.length < 5) {
      throw new ApiError(
        422,
        `This model is valid but the quality gate asked for a review before it is published.${measured} ` +
          `${reasonMessage(report, 'SILHOUETTE_WEAK_MATCH', 'SILHOUETTE_VIEW_AMBIGUOUS', 'SILHOUETTE_UNAVAILABLE', 'ASSESSMENT_FAILED')} ` +
          'Compare it with the reference photograph, then confirm with a short note explaining what you saw.',
        'QUALITY_REVIEW_REQUIRED'
      );
    }
    doc.quality.review = {
      acknowledgedBy: req.user?._id || null,
      acknowledgedAt: new Date(),
      note: note.slice(0, 500),
    };
  }

  const now = new Date();
  const previous = await Product3DAsset.findOne({
    ...workspaceScope(req.user),
    productSlug: doc.productSlug,
    status: STATUS_APPROVED,
    _id: { $ne: doc._id },
  });

  if (previous) {
    previous.status = STATUS_DEPRECATED;
    previous.approval.replacedBy = doc._id;
    previous.approval.replacedAt = now;
    await previous.save();
  }

  doc.status = STATUS_APPROVED;
  doc.approval.approvedBy = req.user?._id || null;
  doc.approval.approvedAt = now;
  doc.approval.rejectedBy = null;
  doc.approval.rejectedAt = null;
  doc.approval.rejectionReason = '';
  await doc.save();

  // PHASE 3 — the public projection now points at THIS asset, so the cached one
  // is dropped in the same breath as the write: the storefront sees the new
  // approved version on the next request rather than after a 30s TTL.
  cacheInvalidate3dDelivery(doc.productSlug);

  return {
    asset: publicAssetProjection(doc),
    replacedAssetId: previous ? String(previous._id) : null,
    quality: { decision, reassessed: gate.reassessed },
  };
}

/**
 * Re-measure one asset on demand — the studio's "re-check" action.
 *
 * Force by default: the caller is asking BECAUSE they doubt the stored verdict
 * (a new reference was accepted, the first cutout was poor), and answering that
 * with the cached report would be answering a different question.
 */
export async function reassessAsset(req, assetId, { thresholds = {}, force = true } = {}) {
  const doc = await loadScoped(req, assetId);
  if (!hasValidatedModel(doc)) {
    throw new ApiError(422, 'This model has no stored file to assess.', 'ASSET_HAS_NO_MODEL');
  }
  const report = await assessAssetQuality(req, doc, { thresholds });
  const gate = force ? { reassessed: true } : await ensureQualityReport(req, doc, { thresholds });
  return { asset: publicAssetProjection(doc), report, reassessed: Boolean(gate.reassessed) || force };
}

/**
 * Reject a candidate. A rejection is a decision about the CANDIDATE only: the
 * product's existing approved model is untouched, which is why a bad
 * regeneration cannot take a live product down.
 */
export async function rejectAsset(req, assetId, reason = '') {
  const doc = await loadScoped(req, assetId);

  if (doc.status !== STATUS_CANDIDATE) {
    throw new ApiError(
      422,
      `Only a candidate model can be rejected. This one is ${doc.status.toLowerCase()}.`,
      'ASSET_NOT_CANDIDATE'
    );
  }

  doc.status = STATUS_REJECTED;
  doc.approval.rejectedBy = req.user?._id || null;
  doc.approval.rejectedAt = new Date();
  doc.approval.rejectionReason = String(reason || '').slice(0, 500);
  await doc.save();
  // A rejection cannot change the live model, but it can coincide with one —
  // drop the cached public projection so the next storefront read is live.
  cacheInvalidate3dDelivery(doc.productSlug);

  const approved = await findApproved(req, doc.productSlug);
  return {
    asset: publicAssetProjection(doc),
    productStillHasApprovedModel: Boolean(approved),
  };
}

/**
 * Read one of an asset's private files. `kind` is a storage kind ('glb' or
 * 'thumbnail'), NOT a URL segment, so the caller cannot name an arbitrary path.
 */
/**
 * PHASE 9 — persist a staff ORIENTATION CORRECTION on a candidate or the live
 * model.
 *
 * Presentation, not geometry: the worker already exports the glTF frame (+Y up,
 * see worker.canonical_orientation) and this records a whole number of
 * 90-degree Y turns applied ONCE per viewer load on top of it, for the case
 * where the engine's frame guess is still wrong for a particular product.
 * Consequences of that separation, all deliberate:
 *
 *   · the GLB bytes are never rewritten — the generated original stays exactly
 *     as audited (storage is immutable, and a correction must not forge one);
 *   · the quality fingerprint is untouched — it describes the bytes, the
 *     references and the settings, none of which a yaw changes;
 *   · only a CANDIDATE or the APPROVED asset may be corrected: a rejected or
 *     deprecated row is history and does not get re-presented.
 *
 * The stored yaw is a validated integer 0..3 (0 = the upright reset), so it
 * cannot drift, cannot accumulate, and every viewer derives the same pose.
 */
export async function setAssetOrientation(req, assetId, { yawQuarterTurns = 0, reason = '' } = {}) {
  const yaw = Number(yawQuarterTurns);
  if (!Number.isInteger(yaw) || yaw < 0 || yaw > 3) {
    throw new ApiError(
      422,
      'Orientation correction must be a whole quarter-turn from 0 to 3.',
      'ORIENTATION_INVALID'
    );
  }
  const doc = await loadScoped(req, assetId);
  if (doc.status === STATUS_REJECTED || doc.status === STATUS_DEPRECATED) {
    throw new ApiError(
      409,
      'Orientation can only be corrected on a candidate or the approved model.',
      'ORIENTATION_STATUS'
    );
  }

  doc.orientation = {
    yawQuarterTurns: yaw,
    correctedBy: req.user?._id || null,
    correctedAt: new Date(),
    reason: String(reason || '').slice(0, 240),
  };
  await doc.save();

  // If customers are already seeing this model, the cached public projection
  // carries the yaw and must not serve the old pose for up to 30 seconds.
  if (doc.status === STATUS_APPROVED) cacheInvalidate3dDelivery(doc.productSlug);

  return publicAssetProjection(doc);
}

export async function readAssetBytes(req, assetId, kind) {
  if (!storage.ASSET_KINDS.includes(kind)) {
    throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
  }
  const doc = await loadScoped(req, assetId);
  const entry = kind === 'glb' ? doc.storage?.glb : doc.storage?.thumbnail;
  if (!entry?.storageKey) {
    throw new ApiError(404, 'That file does not exist for this model yet.', 'ASSET_FILE_NOT_FOUND');
  }
  const buffer = await storage.readAsset(entry.storageKey);
  if (!buffer) {
    throw new ApiError(404, 'That file is missing from storage.', 'ASSET_FILE_NOT_FOUND');
  }
  return {
    buffer,
    contentType: kind === 'glb' ? 'model/gltf-binary' : 'image/png',
    fileName: kind === 'glb' ? 'model.glb' : 'thumbnail.png',
  };
}

/**
 * Resolve an asset by the PUBLIC media URL shape `(productSlug, assetId, kind)`.
 * Used by the media route so a URL can be built from the asset projection alone.
 */
export async function readPublishedAssetBytes(req, productSlug, assetId, kind) {
  const id = normalizeObjectId(assetId);
  if (!id) throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
  const doc = await Product3DAsset.findOne({
    _id: id,
    ...workspaceScope(req.user),
    productSlug: String(productSlug || ''),
  });
  if (!doc) throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');

  // Only an approved (or its candidate preview) model is servable; a rejected or
  // deprecated asset is history and must not be reachable from a product page.
  if (doc.status !== STATUS_APPROVED && doc.status !== STATUS_CANDIDATE) {
    throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
  }
  return readAssetBytes(req, doc._id, kind);
}

/** Delete one candidate (and its files). An approved asset cannot be deleted here. */
export async function deleteAsset(req, assetId) {
  const doc = await loadScoped(req, assetId);
  if (doc.status === STATUS_APPROVED) {
    throw new ApiError(
      422,
      'An approved model cannot be deleted directly — approve a replacement first.',
      'ASSET_IS_APPROVED'
    );
  }
  const workspaceSlug = req.workspaceSlug || 'platform';
  const id = doc._id;
  const productSlug = doc.productSlug;
  await doc.deleteOne();
  await storage.removeAssetFiles(id, workspaceSlug);
  cacheInvalidate3dDelivery(productSlug);
  return { removed: String(id) };
}

/** Remove every asset and file for a product (product deletion / rename). */
export async function purgeProductAssets(req, productSlug) {
  const docs = await Product3DAsset.find({
    ...workspaceScope(req.user),
    productSlug: String(productSlug || ''),
  });
  const workspaceSlug = req.workspaceSlug || 'platform';
  for (const doc of docs) {
    await doc.deleteOne();
    await storage.removeAssetFiles(doc._id, workspaceSlug);
  }
  cacheInvalidate3dDelivery(productSlug);
  return { removed: docs.length };
}

/** Follow a product rename so an approved model is not orphaned. */
export async function renameProductAssets(req, fromSlug, toSlug) {
  if (!fromSlug || !toSlug || fromSlug === toSlug) return { moved: 0 };
  const result = await Product3DAsset.updateMany(
    { ...workspaceScope(req.user), productSlug: String(fromSlug) },
    { $set: { productSlug: String(toSlug) } }
  );
  return { moved: result.modifiedCount ?? 0 };
}

export { publicAssetProjection, STATUS_APPROVED, STATUS_CANDIDATE, STATUS_REJECTED, STATUS_DEPRECATED };
/* Re-exported so the module's NAMESPACE keeps the API it always had (the smoke
   suite and the E2E stack both read these off the namespace, not the default). */
export { qualityFingerprint, qualityIsCurrent };
export default {
  listAssetsForProduct,
  getAsset,
  findApproved,
  findApprovedInWorkspace,
  createCandidateFromGeneration,
  approveAsset,
  rejectAsset,
  readAssetBytes,
  readPublishedAssetBytes,
  deleteAsset,
  purgeProductAssets,
  renameProductAssets,
  assessAssetQuality,
  ensureQualityReport,
  reassessAsset,
  qualityFingerprint,
  qualityIsCurrent,
  canOverrideQuality,
};
