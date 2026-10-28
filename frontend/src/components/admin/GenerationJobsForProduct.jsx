import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  History,
  Layers,
  Loader2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import * as studio from '../../services/threeGlbService.js';
import * as refImages from '../../services/referenceImageService.js';

/**
 * GenerationJobsForProduct — the "3D Model Studio" generation and review panel.
 *
 * WHAT IT DOES
 * ------------
 * Shows whether this server can generate a model at all (and why not, in the
 * server's own words), starts a generation from the product's ACCEPTED reference
 * images, follows the job while it runs, and puts the finished candidate in
 * front of a human to approve or reject.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * It never fakes a result. There is no "simulate", no placeholder mesh and no
 * progress bar invented on the client: a progress figure is rendered only when
 * the provider actually reported one. When no provider is configured the panel
 * explains that and disables the button — it does not pretend generation is
 * merely "coming soon".
 *
 * WHY THE PREVIEW IS THE PARENT'S, NOT OURS
 * -----------------------------------------
 * A live WebGL context is expensive, and the product page already owns one.
 * So this panel reports WHICH asset should be on screen (`onActiveAssetChange`)
 * and the page renders it, which keeps exactly one renderer alive per page and
 * makes the thing under review and the thing previewed impossible to desync.
 *
 * APPROVAL SEMANTICS. Approving is a decision about the CANDIDATE. The product's
 * existing approved model is untouched until this succeeds, so a rejected or
 * failed replacement never takes a live model down.
 */

const JOB_STATUS_META = {
  QUEUED: { label: 'Queued', icon: Clock, tint: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]' },
  GENERATING: { label: 'Generating', icon: Loader2, tint: 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]', spin: true },
  POST_PROCESSING: { label: 'Post-processing', icon: Loader2, tint: 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]', spin: true },
  READY_FOR_REVIEW: { label: 'Ready for review', icon: AlertTriangle, tint: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300' },
  APPROVED: { label: 'Approved', icon: CheckCircle2, tint: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' },
  REJECTED: { label: 'Rejected', icon: XCircle, tint: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]' },
  FAILED: { label: 'Failed', icon: AlertCircle, tint: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300' },
  CANCELLED: { label: 'Cancelled', icon: Ban, tint: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]' },
};

const ASSET_STATUS_TINT = {
  APPROVED: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  CANDIDATE: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300',
  REJECTED: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]',
  DEPRECATED: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]',
};

function JobStatusBadge({ status }) {
  const meta = JOB_STATUS_META[status] || JOB_STATUS_META.QUEUED;
  const Icon = meta.icon;
  return (
    <span
      data-testid="job-status"
      data-job-status={status}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${meta.tint}`}
    >
      <Icon className={`w-3 h-3 ${meta.spin ? 'animate-spin' : ''}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

const QUALITY_DECISION_META = {
  PASS: { label: 'Passed the quality gate', tint: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' },
  REVIEW: { label: 'Needs your review', tint: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300' },
  BLOCKED: { label: 'Blocked by the quality gate', tint: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300' },
};

/** One metric, labelled, with the unit a reader needs to interpret it. */
function Metric({ label, value, hint }) {
  return (
    <div className="min-w-[7rem]">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-botanical-muted)]">{label}</dt>
      <dd className="text-[12px] font-semibold text-[var(--color-botanical-strong)]">{value}</dd>
      {hint ? <p className="mt-0.5 text-[10px] text-[var(--color-botanical-muted)]">{hint}</p> : null}
    </div>
  );
}

/**
 * The Phase 5 gate, as the reviewer sees it.
 *
 * Deliberately NOT a single percentage: every number appears with its own
 * definition, because "92% quality" cannot be checked by the person deciding
 * whether a product may go live. When the server could not measure something,
 * the panel says so instead of showing a zero.
 */
function QualityGatePanel({ quality, reviewNote, onReviewNoteChange, overrideReason, onOverrideReasonChange }) {
  const decision = quality?.decision || '';
  const meta = QUALITY_DECISION_META[decision] || null;
  const silhouette = quality?.silhouette || null;
  const geometry = quality?.geometry || null;
  // Colour facts, kept separate from geometry so a dark-but-well-shaped model
  // reads as a colour problem and a colourful-but-broken mesh as a shape one.
  const colour = quality?.colour || null;
  const reference = quality?.reference || null;
  // PHASE 9 — the gate's orientation section (worker frame + view match +
  // coverage), reported beside shape/colour so a sideways model explains itself.
  const orientation = quality?.orientation || null;
  const reasons = quality?.reasons || [];
  const warnings = quality?.warnings || [];

  if (!decision) {
    return (
      <p className="mt-3 rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-3 text-[11px] text-[var(--color-botanical-muted)]" data-testid="quality-gate">
        This model has not been measured against its reference yet, so it cannot be approved. The
        assessment runs on the server as soon as a candidate is created.
      </p>
    );
  }

  return (
    <div
      className="mt-3 rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-3"
      data-testid="quality-gate"
      data-quality-decision={decision}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${meta.tint}`}>
          {meta.label}
        </span>
        <span className="text-[11px] text-[var(--color-botanical-muted)]">
          assessed {relativeTime(quality.assessedAt)} · {quality.version}
        </span>
      </div>
      {quality.summary ? (
        <p className="mt-2 text-[11px] text-[var(--color-botanical-strong)]">{quality.summary}</p>
      ) : null}

      {/* PHASE 6 — a verdict about DIFFERENT bytes, references or settings. The
          server decides this (`quality.stale`); the panel only reports it, so a
          reviewer never reads an out-of-date PASS as a current one. */}
      {quality.stale ? (
        <p
          className="mt-2 rounded-lg border border-amber-300 bg-amber-50/60 p-2 text-[11px] text-[var(--color-botanical-strong)] dark:border-amber-500/30 dark:bg-amber-500/10"
          data-testid="quality-stale"
        >
          This verdict is <strong>out of date</strong>: the model, its reference set or the generation
          settings changed after it was measured. The decision above was true of an earlier version —
          approving re-measures the stored model first.
        </p>
      ) : null}

      {/* Which photograph the model was measured against, and how much Phase 1
          trusted it — the context a reviewer needs to judge the numbers. */}
      {reference ? (
        <p className="mt-2 text-[11px] text-[var(--color-botanical-muted)]" data-testid="quality-reference">
          Compared against the accepted reference
          {reference.engine ? ` from the ${reference.engine} engine` : ''}
          {reference.model ? ` (${reference.model})` : ''}
          {reference.confidence != null ? `, confidence ${reference.confidence}` : ''}
          {reference.sourceWidth && reference.sourceHeight
            ? `, ${reference.sourceWidth}×${reference.sourceHeight}px`
            : ''}
          {reference.cutoutAspect != null ? `, silhouette aspect ${reference.cutoutAspect}` : ''}
          {reference.maskSource === 'worker-foreground-mask'
            ? ' — silhouette from the worker’s own foreground mask of the photograph this model was built from'
            : reference.maskSource === 'reference-alpha'
              ? ' — silhouette from the photograph’s own transparency'
              : ''}
          .
        </p>
      ) : null}

      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {geometry ? (
          <>
            <Metric label="Triangles" value={(geometry.triangles || 0).toLocaleString()} />
            <Metric label="Vertices" value={(geometry.vertices || 0).toLocaleString()} />
            <Metric label="File" value={`${((geometry.fileBytes || 0) / 1024).toFixed(1)} KB`} />
            <Metric label="Surface" value={geometry.watertight ? 'closed' : 'open'} hint={geometry.watertight ? 'no boundary edges' : `${geometry.boundaryEdges} boundary edge(s)`} />
            {/* PHASE H3 — depth and fragmentation are first-class review facts:
                a relief-thin model and a pile of floating islands look fine in a
                frontal thumbnail but must be visible here. */}
            <Metric
              label="Depth"
              value={`${((geometry.flatness ?? 0) * 100).toFixed(1)}%`}
              hint={
                quality?.depthBand
                  ? `thinnest/longest axis · band ${(quality.depthBand.minDepthRatio * 100).toFixed(1)}% for ${quality.depthBand.category || quality.depthBand.label}`
                  : 'thinnest axis as a share of the longest'
              }
            />
            <Metric
              label="Pieces"
              value={geometry.componentCount != null ? String(geometry.componentCount) : 'not measured'}
              hint={
                geometry.largestComponentShare != null
                  ? `largest piece holds ${Math.round(geometry.largestComponentShare * 100)}% of the surface`
                  : 'disconnected components'
              }
            />
          </>
        ) : null}
        {silhouette?.available ? (
          <>
            <Metric label="Silhouette overlap" value={silhouette.iou} hint="IoU with the reference's own silhouette" />
            <Metric label="Aspect error" value={`${(silhouette.aspectError * 100).toFixed(1)}%`} hint="vs the reference's own frame" />
            <Metric label="Boundary distance" value={`${silhouette.contourDistancePixels}px`} hint="mean, both directions" />
            <Metric
              label="Matched view"
              value={silhouette.selectedView}
              hint={silhouette.viewAgreement === 'clear' ? 'clearly the best match' : 'close to another view'}
            />
          </>
        ) : (
          <Metric label="Shape" value="not measured" hint={silhouette?.reason || 'the reference has no silhouette mask'} />
        )}
      </dl>

      {/* PHASE 9 — ORIENTATION. Two independent facts side by side: how the
          worker established the model's frame (measured, with extents before
          and after) and which stored view matched the reference outline, plus
          the coverage numbers. Warnings only — no threshold is relaxed here. */}
      {orientation ? (
        <div className="mt-3 rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface)] p-2.5" data-testid="quality-orientation">
          <p className="text-[11px] font-semibold text-[var(--color-botanical-strong)]">Orientation & coverage</p>
          <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-2">
            {orientation.workerFrame ? (
              <Metric
                label="Frame"
                value={
                  orientation.workerFrame.check === 'aspect-matched'
                    ? 'upright, verified'
                    : orientation.workerFrame.check === 'uncertain'
                      ? 'upright, unverified'
                      : 'upright, no reference aspect'
                }
                hint={`${orientation.workerFrame.convention || 'native → glTF (+Y up)'}${
                  orientation.workerFrame.extentsBefore && orientation.workerFrame.extentsAfter
                    ? ` · extents ${orientation.workerFrame.extentsBefore.join('×')} → ${orientation.workerFrame.extentsAfter.join('×')}`
                    : ''
                }`}
              />
            ) : (
              <Metric label="Frame" value="not recorded" hint="this job predates the worker's frame measurement" />
            )}
            {orientation.viewMatch ? (
              <Metric
                label="Matched view"
                value={orientation.viewMatch.selectedView}
                hint={
                  orientation.viewMatch.agreement === 'clear'
                    ? 'clearly the best match for the reference outline'
                    : orientation.viewMatch.agreement === 'ambiguous'
                      ? 'no view clearly matches — orientation is an assumption'
                      : 'close to another view'
                }
              />
            ) : null}
            {orientation.coverage ? (
              <Metric
                label="Coverage"
                value={`${(orientation.coverage.modelCoverage * 100).toFixed(0)}% / ${(orientation.coverage.referenceCoverage * 100).toFixed(0)}%`}
                hint={`model vs reference share of frame · Δ ${(orientation.coverage.delta * 100).toFixed(1)}%`}
              />
            ) : null}
          </dl>
        </div>
      ) : null}

      {quality.materials && quality.materials.state !== 'textured' ? (
        <p className="mt-3 text-[11px] text-[var(--color-botanical-muted)]" data-testid="quality-material-state">
          Material: {quality.materials.state === 'vertex-colour'
            ? 'colour is stored per vertex and no texture map is present — this model is colour-per-vertex, not texture-mapped.'
            : quality.materials.state === 'material-only'
              ? 'a PBR material is present, but there is no texture map and no vertex colour — the surface shows only the material’s own base colour.'
              : 'no material, texture or vertex colour is stored — it renders untextured.'}
        </p>
      ) : null}

      {/* COLOUR is reported apart from shape on purpose: a model can be
          geometrically excellent and still render dark, and the reviewer needs
          to see which one failed before deciding. All numbers come from the
          stored bytes — this panel never shows a screenshot as evidence. */}
      {colour ? (
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2" data-testid="quality-colour">
          <Metric
            label="Colour source"
            value={
              colour.source === 'base-colour-texture'
                ? 'base-colour texture'
                : colour.source === 'vertex-colour'
                  ? 'vertex colour'
                  : 'none'
            }
            hint={
              colour.source === 'none'
                ? 'the file carries no colour data at all'
                : 'read from the stored GLB'
            }
          />
          {typeof colour.effectiveMetallic === 'number' ? (
            <Metric
              label="Metallic"
              value={colour.effectiveMetallic.toFixed(2)}
              hint={
                colour.effectiveMetallic >= 0.9
                  ? 'fully metallic — colour is suppressed unless an environment is supplied'
                  : 'dielectric — stored colour renders as albedo'
              }
            />
          ) : null}
          {colour.metrics ? (
            <>
              <Metric
                label="Mean luminance"
                value={colour.metrics.meanLuminance.toFixed(3)}
                hint="linear light, from the colour data"
              />
              <Metric
                label="Mean saturation"
                value={colour.metrics.meanSaturation.toFixed(3)}
                hint="0 = grey, 1 = fully saturated"
              />
              <Metric
                label="Near-black"
                value={`${(colour.metrics.nearBlackFraction * 100).toFixed(1)}%`}
                hint="vertices at effectively true black"
              />
            </>
          ) : null}
        </dl>
      ) : null}

      {reasons.length > 0 ? (
        <ul className="mt-3 space-y-1" data-testid="quality-reasons">
          {reasons.map((reason) => (
            <li key={reason.code} className="text-[11px] text-[var(--color-botanical-strong)]">
              <span className="font-semibold">{reason.code}</span> — {reason.message}
            </li>
          ))}
        </ul>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="mt-2 space-y-1" data-testid="quality-warnings">
          {warnings.map((warning) => (
            <li key={warning.code} className="text-[11px] text-[var(--color-botanical-muted)]">
              <span className="font-semibold">{warning.code}</span> — {warning.message}
            </li>
          ))}
        </ul>
      ) : null}

      {quality.reference?.flagged ? (
        <p className="mt-3 rounded-lg bg-[var(--color-surface-container)] p-2 text-[11px] text-[var(--color-botanical-muted)]" data-testid="quality-reference-flags">
          The accepted reference itself was flagged: {(quality.reference.flags || []).map((flag) => flag.code).join(', ')}.
          A poor match against a doubtful reference is a reason to look, not a verdict about the model.
        </p>
      ) : null}

      {decision === 'REVIEW' ? (
        <label className="mt-3 block">
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-botanical-muted)]">
            What did you see when you compared them?
          </span>
          <textarea
            value={reviewNote}
            onChange={(event) => onReviewNoteChange(event.target.value.slice(0, 500))}
            rows={2}
            placeholder="e.g. Proportions and the lid read correctly; the base is inferred."
            className="mt-1 w-full resize-y rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface)] p-2 text-[12px]"
            data-testid="quality-review-note"
          />
          <span className="text-[10px] text-[var(--color-botanical-muted)]">
            At least a few words — the note is stored with your name against this model.
          </span>
        </label>
      ) : null}

      {decision === 'BLOCKED' ? (
        <div className="mt-3 space-y-1">
          <p className="text-[11px] text-[var(--color-botanical-strong)]">
            Normal approval is refused. Regenerate from a cleaner reference image, or — if you are an
            administrator — override it with a reason.
          </p>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-botanical-muted)]">
              Override reason (administrators only)
            </span>
            <textarea
              value={overrideReason}
              onChange={(event) => onOverrideReasonChange(event.target.value.slice(0, 500))}
              rows={2}
              placeholder="Why is this blocked model being published anyway?"
              className="mt-1 w-full resize-y rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface)] p-2 text-[12px]"
              data-testid="quality-override-reason"
            />
          </label>
          <p className="text-[10px] text-[var(--color-botanical-muted)]">
            The override is recorded with your identity, the reason and the verdict it overrode.
          </p>
        </div>
      ) : null}

      {quality.calibration?.provisional ? (
        <p className="mt-3 text-[10px] text-[var(--color-botanical-muted)]">
          Bands are provisional (calibrated on {quality.calibration.genuineSamples} genuine sample) — the pass
          band is deliberately hard to reach, and borderline results are meant to be your call.
        </p>
      ) : null}
    </div>
  );
}

function relativeTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function GenerationJobsForProduct({
  productSlug = '',
  fallbackUrl = '',
  onActiveAssetChange,
  onChanged,
  disabled = false,
}) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(Boolean(productSlug));
  const [loadError, setLoadError] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [quality, setQuality] = useState('standard');
  const [notes, setNotes] = useState('');
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [flash, setFlash] = useState('');
  const [busyJobId, setBusyJobId] = useState('');
  const [rejectingId, setRejectingId] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  // PHASE 5 — the two things the quality gate can require from a human.
  const [reviewNote, setReviewNote] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  // PHASE 9 — the orientation correction is a WRITE like any other, so it gets
  // its own busy flag instead of borrowing the approve/reject one.
  const [orientationBusy, setOrientationBusy] = useState(false);

  const activeRef = useRef(onActiveAssetChange);
  useEffect(() => {
    activeRef.current = onActiveAssetChange;
  }, [onActiveAssetChange]);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!productSlug) return;
      if (!quiet) setLoading(true);
      try {
        const next = await studio.getStudioState(productSlug);
        setState(next);
        setLoadError('');
        setSelectedIds((current) => {
          // Keep the reviewer's selection across a poll, but never keep an id the
          // server no longer reports as accepted.
          const accepted = new Set(next.plan?.references?.map((r) => r.id) || []);
          const kept = current.filter((id) => accepted.has(id));
          return kept.length ? kept : (next.plan?.references || []).map((r) => r.id);
        });
      } catch (err) {
        if (!quiet) setLoadError(err?.message || 'The 3D studio could not be loaded.');
      } finally {
        setLoading(false);
      }
    },
    [productSlug]
  );

  useEffect(() => {
    setState(null);
    setSelectedIds([]);
    setActionError('');
    setFlash('');
    load();
  }, [load]);

  const jobs = state?.jobs || [];
  const assets = state?.assets || [];
  const approved = state?.approved || null;
  const hasActiveJob = jobs.some((job) => studio.JOB_ACTIVE_STATUSES.includes(job.status));

  // Poll ONLY while something is actually running — an idle studio makes no
  // requests at all.
  useEffect(() => {
    if (!hasActiveJob) return undefined;
    const timer = setInterval(() => {
      load({ quiet: true });
    }, studio.JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [hasActiveJob, load]);

  /** The candidate the reviewer is being asked to decide about, if any. */
  const reviewTarget = useMemo(() => {
    const job = jobs.find((j) => j.status === 'READY_FOR_REVIEW');
    if (!job) return null;
    const byId = job.providerExtra?.assetId
      ? assets.find((a) => a.id === job.providerExtra.assetId)
      : null;
    if (byId) return byId;
    const candidates = assets.filter((a) => a.status === 'CANDIDATE');
    return candidates.length === 1 ? candidates[0] : null;
  }, [jobs, assets]);

  // Tell the page what to preview: a candidate beats the approved model, because
  // reviewing is the reason someone opened this panel.
  useEffect(() => {
    if (activeRef.current) activeRef.current(reviewTarget);
  }, [reviewTarget]);

  const acceptedRefs = state?.plan?.references || [];
  const provider = state?.provider || null;

  // PHASE 9 — the asset the product page is PREVIEWING: the candidate under
  // review when there is one, otherwise the live model. The orientation
  // controls act on exactly that asset, so the thing being turned and the thing
  // on screen cannot desync.
  const orientationTarget = reviewTarget || approved;
  const orientationYaw = orientationTarget?.orientation?.yawQuarterTurns ?? 0;

  const refresh = useCallback(async () => {
    await load({ quiet: true });
    if (onChanged) onChanged();
  }, [load, onChanged]);

  const handleOrientation = useCallback(
    async (nextYaw) => {
      if (!orientationTarget) return;
      setOrientationBusy(true);
      setActionError('');
      setFlash('');
      try {
        // The server validates a whole quarter-turn in 0..3 and refuses the
        // rest (422), so the WRAP happens here: turning past 0/3 continues
        // around the circle instead of erroring in the reviewer's face.
        const wrapped = ((Math.trunc(Number(nextYaw)) % 4) + 4) % 4;
        await studio.setOrientation(orientationTarget.id, wrapped);
        setFlash('Orientation recorded. It applies to this model everywhere it is shown.');
        await refresh();
      } catch (err) {
        setActionError(err?.message || 'The orientation could not be recorded.');
      } finally {
        setOrientationBusy(false);
      }
    },
    [orientationTarget, refresh]
  );

  // ── PHASE 9 — REFERENCE vs RENDER ────────────────────────────────────────
  // The job this candidate came from: its `source.referenceIds` is what was
  // SENT to the worker, and its metrics are what the worker actually CONSUMED
  // (or refused). Both are the server's own record — the strip below only
  // displays them, never infers a role the worker did not report.
  const reviewJob = useMemo(
    () => jobs.find((j) => j.status === 'READY_FOR_REVIEW') || null,
    [jobs]
  );
  const selectedIdsForJob = useMemo(
    () => new Set((reviewJob?.source?.referenceIds || []).map(String)),
    [reviewJob]
  );
  const consumedRefId = reviewJob?.providerExtra?.metrics?.inputUsed?.id || '';
  const refusedRefIds = useMemo(
    () =>
      new Set(
        (reviewJob?.providerExtra?.metrics?.candidateRejections || []).map((r) => r.id)
      ),
    [reviewJob]
  );

  // The photographs themselves are PRIVATE (originals are served only through
  // the authenticated route), so they are fetched with the admin token and
  // held as object URLs that are revoked the moment the candidate changes or
  // the panel unmounts. A photograph that cannot load is shown as an honest
  // placeholder — never as an invented image.
  const [refThumbs, setRefThumbs] = useState({});
  const acceptedKey = acceptedRefs.map((r) => r.id).join(',');
  useEffect(() => {
    if (!reviewTarget?.id || !acceptedKey) {
      setRefThumbs({});
      return undefined;
    }
    let cancelled = false;
    const urls = [];
    (async () => {
      const next = {};
      for (const ref of acceptedRefs) {
        try {
          const blob = await refImages.fetchReferenceAsset(ref.id, 'original');
          if (cancelled || !blob) continue;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          next[ref.id] = url;
        } catch {
          // left out of `next` — the placeholder below says so plainly
        }
      }
      if (!cancelled) setRefThumbs(next);
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* already revoked */
        }
      });
      setRefThumbs({});
    };
    // `acceptedRefs` is rebuilt each poll; `acceptedKey` is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewTarget?.id, acceptedKey]);

  const handleGenerate = useCallback(async () => {
    if (selectedIds.length === 0) {
      setActionError('Select at least one accepted reference image first.');
      return;
    }
    setStarting(true);
    setActionError('');
    setFlash('');
    try {
      await studio.startGeneration(productSlug, { referenceIds: selectedIds, quality, notes });
      setFlash(
        provider?.name === 'local_gpu_agent'
          ? 'Queued for the GPU agent. It starts when the PC claims it — you can leave this page.'
          : 'Generation started. This can take several minutes.'
      );
      await refresh();
    } catch (err) {
      setActionError(err?.message || 'The generation could not be started.');
    } finally {
      setStarting(false);
    }
  }, [productSlug, selectedIds, quality, notes, refresh, provider?.name]);

  const handleApprove = useCallback(
    async (jobId) => {
      setBusyJobId(jobId);
      setActionError('');
      setFlash('');
      try {
        const result = await studio.approveJob(jobId, {
          assetId: reviewTarget?.id || '',
          reviewNote,
          // An override is only ever sent when a reason was actually written:
          // the server refuses an unexplained one, so sending a bare flag would
          // just turn a clear UI state into a server error.
          override: overrideReason.trim().length > 0,
          overrideReason,
        });
        setFlash(
          result.replacedAssetId
            ? 'Model approved. The previous model was archived, not deleted.'
            : 'Model approved. It is now this product’s live 3D model.'
        );
        setReviewNote('');
        setOverrideReason('');
        await refresh();
      } catch (err) {
        setActionError(err?.message || 'That model could not be approved.');
      } finally {
        setBusyJobId('');
      }
    },
    [reviewTarget, refresh, reviewNote, overrideReason]
  );

  const handleReject = useCallback(
    async (jobId) => {
      setBusyJobId(jobId);
      setActionError('');
      setFlash('');
      try {
        const result = await studio.rejectJob(jobId, { assetId: reviewTarget?.id || '', reason: rejectReason });
        setFlash(
          result.productStillHasApprovedModel
            ? 'Candidate rejected. The product keeps its existing 3D model.'
            : 'Candidate rejected.'
        );
        setRejectingId('');
        setRejectReason('');
        await refresh();
      } catch (err) {
        setActionError(err?.message || 'That model could not be rejected.');
      } finally {
        setBusyJobId('');
      }
    },
    [reviewTarget, rejectReason, refresh]
  );

  const handleCancel = useCallback(
    async (jobId) => {
      setBusyJobId(jobId);
      setActionError('');
      try {
        await studio.cancelJob(jobId);
        await refresh();
      } catch (err) {
        setActionError(err?.message || 'That job could not be cancelled.');
      } finally {
        setBusyJobId('');
      }
    },
    [refresh]
  );

  const handleRetry = useCallback(
    async (jobId) => {
      setBusyJobId(jobId);
      setActionError('');
      try {
        await studio.retryJob(jobId);
        await refresh();
      } catch (err) {
        setActionError(err?.message || 'That job could not be retried.');
      } finally {
        setBusyJobId('');
      }
    },
    [refresh]
  );

  if (!productSlug) {
    return (
      <div className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5">
        <p className="text-sm text-[var(--color-botanical-muted)]">
          Save the product before generating a 3D model.
        </p>
      </div>
    );
  }

  return (
    <section
      className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5 space-y-5"
      aria-labelledby="generate-heading"
      data-testid="3d-generation-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="generate-heading" className="font-serif text-lg text-[var(--color-botanical-primary)]">
            Generate a 3D model
          </h2>
          <p className="text-[11px] text-[var(--color-botanical-muted)] mt-0.5">
            Built from this product’s accepted reference images. Nothing is published until you approve it.
          </p>
        </div>
        {provider && (
          <span
            data-testid="provider-status"
            data-provider={provider.name}
            data-available={provider.available ? 'true' : 'false'}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              provider.available
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${provider.available ? 'bg-emerald-500' : 'bg-[var(--color-botanical-subtle)]'}`}
              aria-hidden="true"
            />
            {provider.available ? provider.label : 'Generation unavailable'}
          </span>
        )}
        {/* REMOTE GPU AGENT — a SECOND, SEPARATE fact from "configured": the
            chip reports the server-observed HEARTBEAT, never the config. An
            offline PC is a waiting state, not a failure, so it is amber rather
            than red — and the server's stale window decides, not the browser's
            guess (agent.ageMs is measured server-side). */}
        {provider?.name === 'local_gpu_agent' && provider?.agent && (
          <span
            data-testid="agent-status"
            data-online={provider.agent.online ? 'true' : 'false'}
            data-model-loaded={provider.agent.modelLoaded ? 'true' : 'false'}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              provider.agent.online
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300'
            }`}
            title={
              provider.agent.gpuName
                ? `${provider.agent.gpuName}${provider.agent.device ? ` · ${provider.agent.device}` : ''}`
                : undefined
            }
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${provider.agent.online ? 'bg-emerald-500' : 'bg-amber-500'}`}
              aria-hidden="true"
            />
            {provider.agent.online
              ? `GPU agent online${provider.agent.modelLoaded ? '' : ' · loading model'}`
              : 'GPU agent offline'}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[12px] text-[var(--color-botanical-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading the studio…
        </div>
      )}

      {loadError && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[12px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <p>{loadError}</p>
            <button type="button" onClick={() => load()} className="mt-1 underline underline-offset-2">
              Try again
            </button>
          </div>
        </div>
      )}

      {/* The provider's own explanation, shown verbatim. Silence here would read
          as a broken button; this reads as a configuration fact. */}
      {provider && !provider.available && (
        <div
          className="flex items-start gap-2 rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-3 text-[12px] text-[var(--color-botanical-strong)]"
          data-testid="provider-unavailable"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <p>{provider.reason || 'No 3D model provider is configured on this server.'}</p>
        </div>
      )}

      {/* WHAT THE ENGINE WILL ACTUALLY SEE. The plan is the server's own count
          (accepted views vs. views the provider consumes), stated verbatim so the
          studio can never imply that twelve stored photographs are being
          reconstructed jointly by a single-image engine. */}
      {state?.plan && state.plan.acceptedCount > 0 && (
        <div
          className="flex items-start gap-2 rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-3 text-[12px] text-[var(--color-botanical-strong)]"
          data-testid="plan-view-policy"
          data-views-accepted={state.plan.viewsAccepted}
          data-views-selected={state.plan.viewCount}
          data-supports-multiview={state.plan.supportsMultiView ? 'true' : 'false'}
          data-input-mode={state.plan.inputMode || 'single_view'}
        >
          <Layers className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-botanical-muted)]" aria-hidden="true" />
          <div>
            <p className="font-semibold">Views this generation uses</p>
            <p className="mt-0.5 text-[var(--color-botanical-muted)]">{state.plan.notes}</p>
          </div>
        </div>
      )}

      {/* The agent is offline: an HONEST waiting state, deliberately distinct
          from an error. Generation stays enabled — a job queued now starts the
          moment the PC reconnects, which is the whole point of the queue. */}
      {provider?.available && provider?.name === 'local_gpu_agent' && provider?.agent && !provider.agent.online && (
        <div
          className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
          data-testid="agent-offline"
        >
          <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            {provider.agent.lastSeenAt
              ? `The GPU agent last checked in ${Math.max(1, Math.round((provider.agent.ageMs || 0) / 1000))}s ago.`
              : 'No GPU agent has ever checked in from the PC.'}{' '}
            New generations stay queued and start when it reconnects — nothing is lost while it is offline.
          </p>
        </div>
      )}

      {actionError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-[12px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300" data-testid="studio-error">
          {actionError}
        </div>
      )}
      {flash && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[12px] text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {flash}
        </div>
      )}

      {/* ── Inputs ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-botanical-muted)]">
            Reference views ({acceptedRefs.length} accepted)
          </p>
          {acceptedRefs.length === 0 ? (
            <p className="text-[12px] text-[var(--color-botanical-muted)]">
              No accepted reference images yet. Prepare and accept images above first — generation
              starts from accepted material only.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {acceptedRefs.map((ref) => {
                const on = selectedIds.includes(ref.id);
                return (
                  <li key={ref.id}>
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] ${
                        on
                          ? 'border-[var(--color-botanical)] bg-[var(--color-surface-container)] text-[var(--color-botanical-strong)]'
                          : 'border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="h-3 w-3"
                        checked={on}
                        disabled={!provider?.available || starting}
                        onChange={(event) =>
                          setSelectedIds((current) =>
                            event.target.checked
                              ? [...new Set([...current, ref.id])]
                              : current.filter((id) => id !== ref.id)
                          )
                        }
                      />
                      <span>
                        {ref.isPrimary ? 'Primary' : 'View'}
                        {ref.viewAngle ? ` · ${ref.viewAngle.replace(/-/g, ' ')}` : ''}
                        {ref.fromComposite ? ' · from a composite' : ''} · {ref.hasOriginal ? 'original' : 'no file'}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2 sm:items-end">
          <label className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-botanical-muted)]">
            Quality
            <select
              value={quality}
              onChange={(event) => setQuality(event.target.value)}
              disabled={!provider?.available || starting}
              className="ml-2 rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] px-2 py-1 text-[12px] font-normal normal-case tracking-normal text-[var(--color-botanical-strong)]"
            >
              {studio.QUALITIES.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!provider?.available || starting || disabled || acceptedRefs.length === 0}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--color-btn)] px-4 py-2 text-[12px] font-semibold text-white shadow-xs transition-colors hover:bg-[var(--color-btn-hover-alt)] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="generate-model"
          >
            {starting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {starting ? 'Starting…' : 'Generate model'}
          </button>
          {provider?.metered && provider?.available && (
            <p className="max-w-[220px] text-right text-[10px] text-[var(--color-botanical-subtle)]">
              This provider is metered — each generation bills your account.
            </p>
          )}
        </div>
      </div>

      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-botanical-muted)]">
          Notes (optional)
        </span>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value.slice(0, 1000))}
          rows={2}
          placeholder="Anything a reviewer should know about this attempt."
          className="mt-1 w-full resize-y rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-2.5 text-[12px]"
        />
      </label>

      {/* ── The candidate awaiting a decision ─────────────────────────── */}
      {reviewTarget && (
        <div
          className="rounded-xl border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-500/30 dark:bg-amber-500/10"
          data-testid="candidate-review"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[12px] font-semibold text-[var(--color-botanical-strong)]">
                A generated model is waiting for review
              </p>
              <p className="mt-0.5 text-[11px] text-[var(--color-botanical-muted)]">
                v{reviewTarget.version} · {reviewTarget.model || 'provider'} ·{' '}
                {(reviewTarget.validation.meshes || 0)} mesh(es) · {(reviewTarget.bytes / 1024).toFixed(1)} KB
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleApprove(jobs.find((j) => j.status === 'READY_FOR_REVIEW')?.id)}
                disabled={
                  Boolean(busyJobId) ||
                  // The gate's two human requirements, enforced in the UI as a
                  // courtesy and on the server as the actual rule.
                  (reviewTarget?.quality?.decision === 'REVIEW' && reviewNote.trim().length < 5) ||
                  (reviewTarget?.quality?.decision === 'BLOCKED' && overrideReason.trim().length === 0)
                }
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-btn)] px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-[var(--color-btn-hover-alt)] disabled:opacity-50"
                data-testid="approve-model"
              >
                {busyJobId ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
                Approve
              </button>
              <button
                type="button"
                onClick={() => setRejectingId(rejectingId === reviewTarget.id ? '' : reviewTarget.id)}
                disabled={Boolean(busyJobId)}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface)] px-3.5 py-1.5 text-[12px] font-semibold text-[var(--color-botanical-strong)] hover:bg-[var(--color-surface-container)] disabled:opacity-50"
                data-testid="reject-model"
              >
                <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                Reject
              </button>
            </div>
          </div>

          {/* ── PHASE 5 — the quality gate's verdict and the numbers behind it ──
              The decision is the SERVER's; this panel reports it, shows each
              metric with its own definition, and collects the two things a human
              can add. It never sends a verdict of its own. */}
          <QualityGatePanel
            quality={reviewTarget.quality}
            reviewNote={reviewNote}
            onReviewNoteChange={setReviewNote}
            overrideReason={overrideReason}
            onOverrideReasonChange={setOverrideReason}
          />

          {/* ── PHASE 9 — REFERENCE vs RENDER, side by side ────────────────
              The actual stored photographs next to the geometry in the
              viewport above. Every badge is a server-reported fact: "sent"
              comes from the job's own reference list, "consumed" and
              "refused" come from the worker's recorded metrics, and a
              single-view engine names exactly ONE consumed image. */}
          {acceptedRefs.length > 0 && (
            <div className="mt-4" data-testid="reference-compare">
              <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-botanical-muted)]">
                Reference photographs — compare against the model above
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {acceptedRefs.map((ref) => {
                  const consumed = consumedRefId && String(consumedRefId) === String(ref.id);
                  const refused = refusedRefIds.has(ref.id);
                  const sent = selectedIdsForJob.has(String(ref.id));
                  const role = consumed
                    ? { label: 'consumed by the engine', tint: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' }
                    : refused
                      ? { label: 'refused at selection', tint: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300' }
                      : sent
                        ? { label: 'sent, not used', tint: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300' }
                        : { label: 'not sent', tint: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]' };
                  return (
                    <li
                      key={ref.id}
                      className="w-36 overflow-hidden rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)]"
                      data-testid="compare-reference"
                      data-role={consumed ? 'consumed' : refused ? 'refused' : sent ? 'sent' : 'stored'}
                    >
                      {refThumbs[ref.id] ? (
                        <img
                          src={refThumbs[ref.id]}
                          alt={`Reference photograph: ${ref.label || ref.viewAngle || 'product view'}`}
                          className="h-24 w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-24 w-full items-center justify-center text-[10px] text-[var(--color-botanical-subtle)]">
                          Image unavailable
                        </div>
                      )}
                      <div className="px-2 py-1.5">
                        <p className="truncate text-[11px] font-medium text-[var(--color-botanical-strong)]">
                          {ref.isPrimary ? 'Primary' : 'View'}
                          {ref.viewAngle ? ` · ${ref.viewAngle.replace(/-/g, ' ')}` : ''}
                        </p>
                        <span
                          className={`mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${role.tint}`}
                          data-testid="compare-role"
                        >
                          {role.label}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-[11px] text-[var(--color-botanical-muted)]" data-testid="compare-policy">
                {state.plan?.supportsMultiView
                  ? 'This engine consumes multiple views jointly.'
                  : `This engine reconstructs from ONE photograph — only the image marked "${
                      acceptedRefs.find((r) => String(r.id) === String(consumedRefId))?.label ||
                      acceptedRefs.find((r) => String(r.id) === String(consumedRefId))?.viewAngle ||
                      'consumed'
                    }" contributed geometry. The others are stored, selectable reference material, not reconstruction input.`}
              </p>
            </div>
          )}

          {rejectingId === reviewTarget.id && (
            <div className="mt-3 space-y-2">
              <textarea
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value.slice(0, 500))}
                rows={2}
                placeholder="Why is this one not good enough?"
                className="w-full resize-y rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface)] p-2 text-[12px]"
              />
              <button
                type="button"
                onClick={() => handleReject(jobs.find((j) => j.status === 'READY_FOR_REVIEW')?.id)}
                disabled={Boolean(busyJobId)}
                className="rounded-full bg-red-600 px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                Confirm rejection
              </button>
              <p className="text-[11px] text-[var(--color-botanical-muted)]">
                Rejecting only discards this candidate. Any currently approved model stays live.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── PHASE 9 — orientation: the stored frame is glTF +Y up, but an
          engine's frame guess can still be wrong for one product. These turns
          are presentation only — recorded beside the asset, applied once per
          load by every viewer, and never written into the immutable bytes. */}
      {orientationTarget && (
        <div
          className="rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-3"
          data-testid="orientation-controls"
          data-yaw={orientationYaw}
          data-asset-id={orientationTarget.id}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[12px] font-semibold text-[var(--color-botanical-strong)]">
                Model orientation{' '}
                <span className="font-normal text-[var(--color-botanical-muted)]" data-testid="orientation-readout">
                  · {orientationYaw === 0 ? 'upright (as generated)' : `turned ${orientationYaw * 90}° right`}
                </span>
              </p>
              <p className="mt-0.5 max-w-[46ch] text-[11px] text-[var(--color-botanical-muted)]">
                A quarter-turn correction for models the engine framed sideways. It changes how
                every viewer displays this model — never the stored file.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleOrientation(orientationYaw - 1)}
                disabled={orientationBusy}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-botanical-strong)] hover:bg-[var(--color-surface-container)] disabled:opacity-50"
                data-testid="orientation-turn-left"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Turn left
              </button>
              <button
                type="button"
                onClick={() => handleOrientation(orientationYaw + 1)}
                disabled={orientationBusy}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-botanical-strong)] hover:bg-[var(--color-surface-container)] disabled:opacity-50"
                data-testid="orientation-turn-right"
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                Turn right
              </button>
              <button
                type="button"
                onClick={() => handleOrientation(0)}
                disabled={orientationBusy || orientationYaw === 0}
                className="rounded-full border border-[var(--color-botanical-border)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-botanical-strong)] hover:bg-[var(--color-surface-container)] disabled:opacity-50"
                data-testid="orientation-upright"
              >
                Upright
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Job history ───────────────────────────────────────────────── */}
      {jobs.length > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-botanical-muted)]">
            <History className="h-3.5 w-3.5" aria-hidden="true" />
            Generation history
          </p>
          <ul className="space-y-2" data-testid="job-list">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <JobStatusBadge status={job.status} />
                    <span className="text-[11px] text-[var(--color-botanical-muted)]">
                      {job.settings?.quality || 'standard'} · {job.source?.viewCount || 0} view(s) · {relativeTime(job.createdAt)}
                    </span>
                    {/* WHICH PHOTOGRAPH PRODUCED THIS MESH — from the worker's
                        own recorded result, never inferred by the UI. */}
                    {job.providerExtra?.metrics?.inputUsed && (
                      <span className="text-[11px] text-[var(--color-botanical-subtle)]" data-testid="job-input-used">
                        from {job.providerExtra.metrics.inputUsed.viewAngle || job.providerExtra.metrics.inputUsed.label || 'primary view'}
                        {typeof job.providerExtra.metrics.mask?.fgFraction === 'number'
                          ? ` · mask ${(job.providerExtra.metrics.mask.fgFraction * 100).toFixed(0)}%`
                          : ''}
                        {job.providerExtra.metrics.candidateRejections?.length
                          ? ` · ${job.providerExtra.metrics.candidateRejections.length} view(s) refused`
                          : ''}
                      </span>
                    )}
                    {typeof job.providerExtra?.progress === 'number' && (
                      <span className="text-[11px] text-[var(--color-botanical-muted)]">
                        {Math.round(job.providerExtra.progress)}%
                      </span>
                    )}
                    {job.retryCount > 0 && (
                      <span className="text-[11px] text-[var(--color-botanical-subtle)]">attempt {job.retryCount + 1}</span>
                    )}
                    {/* Which machine holds the claim — observed server-side from
                        the job's lease, never assumed. */}
                    {provider?.name === 'local_gpu_agent' && job.lease?.held && job.lease.workerId && (
                      <span className="text-[11px] text-[var(--color-botanical-subtle)]">
                        on {job.lease.workerId}
                      </span>
                    )}
                  </div>
                  {job.error?.message && (
                    <p className="mt-1 text-[11px] text-red-700 dark:text-red-300">{job.error.message}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {studio.JOB_ACTIVE_STATUSES.includes(job.status) && (
                    <button
                      type="button"
                      onClick={() => handleCancel(job.id)}
                      disabled={busyJobId === job.id}
                      className="rounded-full border border-[var(--color-botanical-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-botanical-strong)] hover:bg-[var(--color-surface-container)] disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  )}
                  {studio.JOB_FINAL_STATUSES.includes(job.status) &&
                    job.status !== 'APPROVED' &&
                    provider?.available && (
                      <button
                        type="button"
                        onClick={() => handleRetry(job.id)}
                        disabled={busyJobId === job.id}
                        className="inline-flex items-center gap-1 rounded-full border border-[var(--color-botanical-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-botanical-strong)] hover:bg-[var(--color-surface-container)] disabled:opacity-50"
                      >
                        <RefreshCw className="h-3 w-3" aria-hidden="true" />
                        Retry
                      </button>
                    )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Model archive ─────────────────────────────────────────────── */}
      {assets.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-botanical-muted)]">
            Model versions
          </p>
          <ul className="space-y-1.5">
            {assets.map((asset) => (
              <li
                key={asset.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-botanical-border)] px-3 py-1.5 text-[11px]"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium text-[var(--color-botanical-strong)]">v{asset.version}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${ASSET_STATUS_TINT[asset.status] || ''}`}>
                    {asset.status}
                  </span>
                  <span className="text-[var(--color-botanical-muted)]">
                    {asset.model || 'unattributed'} · {asset.validation?.meshes || 0} mesh(es)
                  </span>
                </span>
                <span className="text-[var(--color-botanical-subtle)]">
                  {asset.approval?.approvedAt
                    ? `approved ${relativeTime(asset.approval.approvedAt)}`
                    : asset.approval?.rejectedAt
                      ? `rejected ${relativeTime(asset.approval.rejectedAt)}`
                      : relativeTime(asset.createdAt)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-[var(--color-botanical-muted)]">
            {approved
              ? `v${approved.version} is live. Approving a newer candidate archives it rather than deleting it.`
              : 'No approved model yet — approve a candidate to make one live.'}
          </p>
        </div>
      )}
    </section>
  );
}
