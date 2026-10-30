/**
 * CaptureSetPanel — 3D Studio, Phase 11.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The one place staff can see whether a product's photographs form a VALID
 * multi-view capture, what each reconstruction engine would say about them, and
 * which exact images would be sent — BEFORE anything is generated or billed.
 *
 * It deliberately sits beside the reference studio rather than replacing it:
 * uploading, labelling and accepting photographs stays there, and this panel reads
 * the same accepted rows. Nothing here edits a photograph.
 *
 * HONESTY RULES BAKED INTO THE COPY
 * ---------------------------------
 *  · A strong front silhouette is not proof of a good reconstruction; the panel
 *    never congratulates anybody for a number.
 *  · "Ready" is per-ENGINE, because Meshy accepts unposed photographs and
 *    ReLi3D refuses them. The panel shows the per-engine verdict verbatim.
 *  · A pose is never inferred. The editor says so, and the import path accepts
 *    only explicit numbers.
 *  · Submitting is a named action with an explicit metered acknowledgement.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  Send,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import * as captureApi from '../../services/captureSetService.js';
import * as references from '../../services/referenceImageService.js';

const STATUS_COPY = {
  draft: 'No accepted photographs yet',
  collecting: 'Collecting views',
  validated: 'Validated for an engine',
  submitted: 'Submitted',
  processing: 'Reconstruction running',
  completed: 'Reconstruction complete',
  failed: 'Failed',
  archived: 'Archived',
};

const STATUS_TONE = {
  draft: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]',
  collecting: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300',
  validated: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  submitted: 'bg-sky-50 text-sky-900 dark:bg-sky-500/15 dark:text-sky-300',
  processing: 'bg-sky-50 text-sky-900 dark:bg-sky-500/15 dark:text-sky-300',
  completed: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  failed: 'bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  archived: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]',
};

const decimal = (value) => (Number.isFinite(Number(value)) ? Number(value) : '');

/** The practical capture guide. Short on purpose — it is read while holding a phone. */
const GUIDE = [
  'Photograph the SAME bouquet, unchanged, in one session. Do not rearrange flowers between shots.',
  'Keep the bouquet in the same place and rotate the camera at the same height and distance around it.',
  'Front, back, left and right are required. Add a TOP view — the crown is the last thing a reconstruction gets right.',
  'Use a plain, uncluttered background and keep lighting consistent. Avoid hands, props and shop clutter behind the flowers.',
  'Take real photographs. A rendered turntable, a collage or a supplier contact sheet is not a capture: its cells disagree about scale and framing, and a multi-view engine will fuse those disagreements.',
  'Framing must match between views: same zoom, product centred, entire bouquet in frame including the wrap and any ribbon tails.',
  'Only record a camera pose if you actually measured it. A guessed pose is worse than a missing one — a pose-aware engine trusts it.',
];

function Badge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_TONE[status] || STATUS_TONE.draft}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {STATUS_COPY[status] || status}
    </span>
  );
}

function IssueList({ issues, tone = 'error' }) {
  if (!issues || issues.length === 0) return null;
  const Icon = tone === 'error' ? XCircle : AlertTriangle;
  const colour = tone === 'error' ? 'text-red-700 dark:text-red-300' : 'text-amber-800 dark:text-amber-300';
  return (
    <ul className="space-y-1.5">
      {issues.map((entry, index) => (
        <li key={`${entry.code}-${entry.referenceId || entry.view || index}`} className={`flex gap-1.5 text-[11px] ${colour}`}>
          <Icon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{entry.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** The capture guide, shared by the not-started and the active panel. */
function GuideBlock({ open, onToggle }) {
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-botanical-muted)]"
      >
        {open ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
        How to photograph a capture set
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5 rounded-xl bg-[var(--color-surface-low)] p-3">
          {GUIDE.map((line) => (
            <li key={line} className="flex gap-1.5 text-[11px] leading-relaxed text-[var(--color-botanical-muted)]">
              <Camera className="mt-0.5 h-3 w-3 shrink-0 text-[var(--color-botanical-subtle)]" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One view row: label, pose state, and the pose editor when opened. */
function ViewRow({ image, onPoseSaved, disabled }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pose = image.pose || null;
  const [form, setForm] = useState({
    px: decimal(pose?.position?.x) || 0,
    py: decimal(pose?.position?.y) || 0,
    pz: decimal(pose?.position?.z) ?? 2,
    tx: decimal(pose?.target?.x) || 0,
    ty: decimal(pose?.target?.y) || 0,
    tz: decimal(pose?.target?.z) || 0,
    fov: decimal(pose?.fov) || 40,
  });

  const save = async (clear = false) => {
    setSaving(true);
    setError('');
    try {
      const payload = clear
        ? null
        : {
            position: { x: Number(form.px), y: Number(form.py), z: Number(form.pz) },
            target: { x: Number(form.tx), y: Number(form.ty), z: Number(form.tz) },
            fov: Number(form.fov),
            source: pose?.source || 'manual',
          };
      const updated = await references.updateReference(image.id, { pose: payload });
      onPoseSaved(updated);
      setOpen(false);
    } catch (err) {
      setError(err.message || 'That pose could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const field = (key, label, step = 0.01) => (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-[var(--color-botanical-subtle)]">{label}</span>
      <input
        type="number"
        step={step}
        value={form[key]}
        onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))}
        className="mt-0.5 w-full rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] px-2 py-1 text-[12px]"
      />
    </label>
  );

  return (
    <li className="rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium text-[var(--color-botanical-strong)]">
            {image.label || image.original?.fileName || 'Reference'}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--color-botanical-muted)]">
            {image.viewAngle || 'no view label'}{' '}
            <span className="text-[var(--color-botanical-subtle)]">·</span>{' '}
            {pose ? `pose recorded (${pose.source})` : 'no pose recorded'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 rounded-full border border-[var(--color-botanical-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-botanical-primary)]"
          disabled={disabled}
        >
          {open ? 'Close' : pose ? 'Edit pose' : 'Record pose'}
        </button>
      </div>

      {open && (
        <div className="mt-2.5 space-y-2 border-t border-[var(--color-botanical-border)] pt-2.5">
          <p className="text-[10px] leading-relaxed text-[var(--color-botanical-subtle)]">
            Camera-to-world, metres, degrees. This is only stored if you measured it — a pose-aware engine
            trusts these numbers, so nothing is inferred.
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            {field('px', 'cam x')}
            {field('py', 'cam y')}
            {field('pz', 'cam z')}
            {field('tx', 'target x')}
            {field('ty', 'target y')}
            {field('tz', 'target z')}
            {field('fov', 'fov °', 0.5)}
          </div>
          {error && <p className="text-[11px] text-red-700 dark:text-red-300">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => save(false)}
              disabled={saving || disabled}
              className="rounded-full bg-[var(--color-botanical-primary)] px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save pose'}
            </button>
            {pose && (
              <button
                type="button"
                onClick={() => save(true)}
                disabled={saving || disabled}
                className="rounded-full border border-[var(--color-botanical-border)] px-3 py-1 text-[11px] font-medium text-[var(--color-botanical-muted)] disabled:opacity-60"
              >
                Clear pose
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export default function CaptureSetPanel({ productSlug = '', draftKey = '', disabled = false, onSubmitted }) {
  const scope = useMemo(() => ({ productSlug, draftKey }), [productSlug, draftKey]);

  const [engines, setEngines] = useState([]);
  const [provider, setProvider] = useState({});
  const [meteredAuthorised, setMeteredAuthorised] = useState(false);
  const [set, setSet] = useState(null);
  const [rows, setRows] = useState([]);
  const [plan, setPlan] = useState(null);
  const [engineId, setEngineId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [acknowledgeMetered, setAcknowledgeMetered] = useState(false);

  const loadRows = useCallback(async () => {
    try {
      const payload = await references.listReferences(scope);
      setRows((payload.images || []).filter((image) => image.accepted));
    } catch {
      // The studio's own error surface already reports a reference-list failure;
      // an empty list here simply shows no views rather than a second error.
      setRows([]);
    }
  }, [scope]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const engineInfo = await captureApi.getEngines();
      setEngines(engineInfo.engines);
      setProvider(engineInfo.provider);
      setMeteredAuthorised(engineInfo.meteredAuthorised);

      // Opening the page READS. A set is created only by an explicit action, so a
      // 404 leaves `set` null and the panel offers a Start button instead of
      // writing a record because somebody looked at the screen.
      let current = null;
      try {
        current = await captureApi.getCaptureSet(scope);
      } catch (err) {
        if (err.status !== 404) throw err;
        current = null;
      }
      setSet(current);
      setEngineId(current?.engineId || '');
      await loadRows();
    } catch (err) {
      setError(err.message || 'The capture set could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [scope, loadRows]);

  useEffect(() => {
    load();
  }, [load]);

  const start = async () => {
    setBusy('start');
    setError('');
    try {
      const created = await captureApi.startCaptureSet(scope);
      setSet(created);
      setEngineId(created.engineId || '');
      await loadRows();
    } catch (err) {
      setError(err.message || 'The capture set could not be started.');
    } finally {
      setBusy('');
    }
  };

  const live = set?.live || null;
  const verdict = useMemo(
    () => (live?.engines || []).find((entry) => entry.engineId === engineId) || null,
    [live, engineId]
  );

  const refreshPlan = useCallback(
    async (nextEngineId) => {
      if (!set || !nextEngineId) {
        setPlan(null);
        return;
      }
      try {
        const next = await captureApi.previewPlan(set.id, scope, { engineId: nextEngineId });
        setPlan(next);
      } catch (err) {
        setPlan(null);
        // A refused plan is normal (e.g. views missing); its message is the
        // useful part, so it is shown rather than swallowed.
        setNotice(err.message || '');
      }
    },
    [set, scope]
  );

  useEffect(() => {
    if (set && engineId) refreshPlan(engineId);
  }, [set, engineId, refreshPlan]);

  const chooseEngine = async (nextEngineId) => {
    setEngineId(nextEngineId);
    setBusy('engine');
    setError('');
    setNotice('');
    try {
      const updated = await captureApi.updateCaptureSet(set.id, scope, { engineId: nextEngineId });
      setSet(updated);
    } catch (err) {
      setError(err.message || 'That engine could not be selected.');
    } finally {
      setBusy('');
    }
  };

  const revalidate = async () => {
    setBusy('validate');
    setError('');
    setNotice('');
    try {
      const updated = await captureApi.validateCaptureSet(set.id, scope);
      setSet(updated);
      await loadRows();
    } catch (err) {
      setError(err.message || 'The capture set could not be validated.');
    } finally {
      setBusy('');
    }
  };

  const submit = async () => {
    setBusy('submit');
    setError('');
    setNotice('');
    try {
      const result = await captureApi.submitCaptureSet(set.id, scope, {
        engineId,
        acknowledgeMetered,
        label: `Capture set — ${plan?.viewsSent || 0} view(s)`,
      });
      setSet(result.captureSet);
      setConfirming(false);
      setAcknowledgeMetered(false);
      setNotice('Submitted. The candidate will appear in the 3D Model Studio below once the engine returns it — approval is still yours to give.');
      onSubmitted?.(result);
    } catch (err) {
      setError(err.message || 'The capture set could not be submitted.');
    } finally {
      setBusy('');
    }
  };

  const onPoseSaved = (updated) => {
    setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
    // A pose change alters engine eligibility, so re-measure rather than assume.
    revalidate();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5 text-[12px] text-[var(--color-botanical-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading the capture set…
      </div>
    );
  }

  if (error && !set) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5 dark:border-red-500/30 dark:bg-red-500/10">
        <p className="text-[12px] text-red-700 dark:text-red-300">{error}</p>
        <button
          type="button"
          onClick={load}
          className="mt-2 rounded-full border border-red-300 px-3 py-1 text-[11px] font-medium text-red-800 dark:border-red-500/40 dark:text-red-300"
        >
          Retry
        </button>
      </div>
    );
  }

  // No set yet: this screen READS only. Nothing is created until the operator
  // says so, and the guide and the accepted views are already useful here.
  if (!set) {
    return (
      <section
        className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5"
        aria-labelledby="capture-heading"
        data-capture-status="not-started"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="capture-heading" className="font-serif text-lg text-[var(--color-botanical-primary)]">
              Multi-View Capture
            </h2>
            <p className="mt-0.5 max-w-xl text-[11px] text-[var(--color-botanical-muted)]">
              Check which views this product has and what a reconstruction engine would require, before
              anything is generated.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-container)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-botanical-muted)]">
            Not started
          </span>
        </div>

        {error && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-2.5 text-[11px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </div>
        )}

        <GuideBlock open={guideOpen} onToggle={() => setGuideOpen((value) => !value)} />

        <p className="mt-4 text-[11px] text-[var(--color-botanical-muted)]">
          {rows.length === 0
            ? 'No accepted photographs yet. Upload and accept them in the reference studio above first.'
            : `${rows.length} accepted photograph${rows.length === 1 ? '' : 's'} ready to measure.`}
        </p>

        <button
          type="button"
          onClick={start}
          disabled={disabled || Boolean(busy)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[var(--color-botanical-primary)] px-3.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {busy === 'start' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
          Start capture set
        </button>
      </section>
    );
  }

  const meteredSelected = Boolean(verdict?.requirements && engines.find((e) => e.id === engineId)?.metered);
  const canSubmit =
    !disabled &&
    !busy &&
    Boolean(plan) &&
    Boolean(verdict?.valid) &&
    Boolean(verdict?.enabled) &&
    Boolean(productSlug) &&
    (!meteredSelected || (meteredAuthorised && acknowledgeMetered));

  return (
    <section
      className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5"
      aria-labelledby="capture-heading"
      data-capture-status={set?.status || 'unknown'}
      data-capture-engine={engineId || 'none'}
      data-capture-can-submit={canSubmit ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="capture-heading" className="font-serif text-lg text-[var(--color-botanical-primary)]">
            Multi-View Capture
          </h2>
          <p className="mt-0.5 max-w-xl text-[11px] text-[var(--color-botanical-muted)]">
            Which views this product has, what each engine would accept, and exactly what would be sent.
            Nothing is generated until you submit.
          </p>
        </div>
        <Badge status={set?.status} />
      </div>

      {error && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-2.5 text-[11px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="mt-3 rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-2.5 text-[11px] text-[var(--color-botanical-muted)]">
          {notice}
        </div>
      )}

      <GuideBlock open={guideOpen} onToggle={() => setGuideOpen((value) => !value)} />

      {/* Coverage */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-botanical-muted)]">
            Accepted views ({rows.length})
          </h3>
          {rows.length === 0 ? (
            <p className="mt-2 rounded-xl bg-[var(--color-surface-low)] p-3 text-[11px] text-[var(--color-botanical-subtle)]">
              No accepted photographs yet. Upload and accept them in the reference studio above; they appear
              here automatically.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {rows.map((image) => (
                <ViewRow key={image.id} image={image} onPoseSaved={onPoseSaved} disabled={disabled || Boolean(busy)} />
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-botanical-muted)]">
            Coverage
          </h3>
          <ul className="mt-2 space-y-1">
            {(live?.coverage || []).map((entry) => {
              const present = entry.present;
              const Icon = present ? CheckCircle2 : entry.required ? XCircle : CircleDashed;
              const colour = present
                ? 'text-emerald-700 dark:text-emerald-400'
                : entry.required
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-[var(--color-botanical-subtle)]';
              return (
                <li key={entry.view} className={`flex items-center gap-1.5 text-[11px] ${colour}`}>
                  <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="capitalize">{entry.view.replace(/-/g, ' ')}</span>
                  {entry.required && <span className="text-[10px] uppercase tracking-wide opacity-70">required</span>}
                  {!entry.required && entry.recommended && <span className="text-[10px] uppercase tracking-wide opacity-70">recommended</span>}
                </li>
              );
            })}
          </ul>

          <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <dt className="text-[var(--color-botanical-subtle)]">Poses recorded</dt>
              <dd className="font-medium text-[var(--color-botanical-strong)]">
                {live?.counts?.posesRecorded ?? 0} / {live?.counts?.views ?? rows.length}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-botanical-subtle)]">Sheets (provenance)</dt>
              <dd className="font-medium text-[var(--color-botanical-strong)]">{live?.counts?.sheets ?? 0}</dd>
            </div>
          </dl>

          {(live?.errors || []).length > 0 && (
            <div className="mt-3">
              <IssueList issues={live.errors} tone="error" />
            </div>
          )}
          {(live?.warnings || []).length > 0 && (
            <div className="mt-2">
              <IssueList issues={live.warnings} tone="warning" />
            </div>
          )}
        </div>
      </div>

      {/* Engine eligibility */}
      <div className="mt-5 border-t border-[var(--color-botanical-border)] pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-botanical-muted)]">
          Reconstruction engine
        </h3>
        <p className="mt-1 text-[11px] text-[var(--color-botanical-muted)]">
          Configured provider: <span className="font-medium">{provider?.label || provider?.name || 'none'}</span>
          {provider?.available === false && provider?.reason ? ` — ${provider.reason}` : ''}
        </p>

        <div className="mt-2 space-y-2">
          {engines.map((engine) => {
            const engineVerdict = (live?.engines || []).find((entry) => entry.engineId === engine.id);
            const selected = engine.id === engineId;
            const installed = engine.installed;
            return (
              <label
                key={engine.id}
                className={`flex items-start gap-2.5 rounded-xl border p-2.5 ${
                  selected
                    ? 'border-[var(--color-botanical-primary)] bg-[var(--color-surface-low)]'
                    : 'border-[var(--color-botanical-border)] bg-[var(--color-surface-low)]'
                } ${installed ? '' : 'opacity-70'}`}
              >
                <input
                  type="radio"
                  name={`engine-${set?.id || 'new'}`}
                  value={engine.id}
                  checked={selected}
                  onChange={() => chooseEngine(engine.id)}
                  disabled={disabled || !installed || Boolean(busy)}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] font-medium text-[var(--color-botanical-strong)]">{engine.label}</span>
                    {!installed && (
                      <span className="rounded-full bg-[var(--color-surface-container)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-botanical-subtle)]">
                        not installed
                      </span>
                    )}
                    {engine.metered && (
                      <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">
                        metered
                      </span>
                    )}
                    {engine.requiresPose && (
                      <span className="rounded-full bg-[var(--color-surface-container)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-botanical-muted)]">
                        needs poses
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-relaxed text-[var(--color-botanical-subtle)]">
                    {engine.multiView ? `multi-view, up to ${engine.maxInputs} images` : 'single view'} · evidence:{' '}
                    {engine.evidence}
                    {engineVerdict && (
                      <>
                        {' · '}
                        {engineVerdict.valid ? 'this set is valid for it' : 'this set is not valid for it'}
                      </>
                    )}
                  </span>
                  {engineVerdict && !engineVerdict.valid && (engineVerdict.errors || []).length > 0 && (
                    <span className="mt-1 block">
                      <IssueList issues={engineVerdict.errors} tone="error" />
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* The plan */}
      {plan && (
        <div className="mt-4 rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-botanical-muted)]">
            Submission plan
          </h3>
          <p className="mt-1 text-[11px] text-[var(--color-botanical-muted)]">
            <span className="font-medium text-[var(--color-botanical-strong)]">{plan.viewsSent}</span> image
            {plan.viewsSent === 1 ? '' : 's'} would be sent to {plan.engineLabel}, {plan.inputMode.replace('_', ' ')}.
            {plan.unusedViews > 0 && ` ${plan.unusedViews} accepted view${plan.unusedViews === 1 ? ' is' : 's are'} left out by this engine's input limit.`}
          </p>
          <ol className="mt-2 space-y-1">
            {plan.inputs.map((input, index) => (
              <li key={input.id} className="flex items-center gap-2 text-[11px] text-[var(--color-botanical-muted)]">
                <span className="w-4 text-right text-[var(--color-botanical-subtle)]">{index + 1}.</span>
                <span className="capitalize">{input.viewAngle || 'unlabelled'}</span>
                <span className="text-[var(--color-botanical-subtle)]">·</span>
                <span>{input.hasPose ? 'pose recorded' : 'no pose'}</span>
                <span className="ml-auto truncate font-mono text-[10px] text-[var(--color-botanical-subtle)]">{input.sha256.slice(0, 10)}</span>
              </li>
            ))}
          </ol>
          {plan.warnings?.length > 0 && (
            <div className="mt-2">
              <IssueList issues={plan.warnings} tone="warning" />
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={revalidate}
          disabled={disabled || Boolean(busy)}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-botanical-border)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-botanical-primary)] disabled:opacity-60"
        >
          {busy === 'validate' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
          Re-validate
        </button>

        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-botanical-primary)] px-3.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            <Send className="h-3 w-3" aria-hidden="true" />
            Submit to {verdict?.label || 'engine'}
          </button>
        ) : (
          <div className="w-full rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-3">
            <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-botanical-muted)]">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                This starts a reconstruction of {plan?.viewsSent || 0} image
                {plan?.viewsSent === 1 ? '' : 's'} on {verdict?.label}. The result is a CANDIDATE: it is not
                visible to customers and it is not approved until you review it below.
              </span>
            </p>
            {meteredSelected && (
              <label className="mt-2 flex items-start gap-2 text-[11px] text-[var(--color-botanical-strong)]">
                <input
                  type="checkbox"
                  checked={acknowledgeMetered}
                  onChange={(event) => setAcknowledgeMetered(event.target.checked)}
                  className="mt-0.5"
                  disabled={!meteredAuthorised}
                />
                <span>
                  I understand this provider charges per generation
                  {meteredAuthorised
                    ? ' and authorise this submission.'
                    : ' — but metered submissions are disabled on this deployment, so this cannot be sent.'}
                </span>
              </label>
            )}
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit || (meteredSelected && !acknowledgeMetered)}
                className="rounded-full bg-[var(--color-botanical-primary)] px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
              >
                {busy === 'submit' ? 'Submitting…' : 'Confirm submission'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setAcknowledgeMetered(false);
                }}
                className="rounded-full border border-[var(--color-botanical-border)] px-3 py-1 text-[11px] font-medium text-[var(--color-botanical-muted)]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Submission history */}
      {(set?.submissions || []).length > 0 && (
        <div className="mt-4 border-t border-[var(--color-botanical-border)] pt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-botanical-muted)]">
            Submission history
          </h3>
          <ul className="mt-1.5 space-y-1.5">
            {[...set.submissions].reverse().map((entry) => (
              <li key={entry._id || `${entry.at}-${entry.payloadFingerprint}`} className="text-[11px] text-[var(--color-botanical-muted)]">
                <span className="font-medium text-[var(--color-botanical-strong)]">{entry.engineLabel}</span>{' '}
                · {entry.viewsSent} image{entry.viewsSent === 1 ? '' : 's'} · {entry.outcome}
                {entry.jobId ? ` · job ${entry.jobId}` : ''}
                {entry.at ? ` · ${new Date(entry.at).toLocaleString()}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {set?.failure?.message && set.status === 'failed' && (
        <p className="mt-3 text-[11px] text-red-700 dark:text-red-300">{set.failure.message}</p>
      )}
    </section>
  );
}
