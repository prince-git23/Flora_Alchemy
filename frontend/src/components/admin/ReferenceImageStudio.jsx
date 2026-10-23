import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Grid3x3,
  Image as ImageIcon,
  Info,
  Layers,
  Loader2,
  RefreshCw,
  Star,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import * as studio from '../../services/referenceImageService.js';

/**
 * ReferenceImageStudio — multi-view reference workspace.
 *
 * WHAT IT DOES
 * ------------
 * Collects MANY views of one product, in either shape the studio supports:
 *
 *   · separate photographs — one row per view, reorderable, labelable;
 *   · ONE composite sheet — grid detected server-side, corrected here by a
 *     human, then cut into individual views that stay traceable to the sheet.
 *
 * WHAT IT NO LONGER DOES
 * ----------------------
 * It does not remove backgrounds. Phase 1 ran a segmentation engine on every
 * upload and showed an ORIGINAL/CUTOUT pair; on a bouquet the cutout removed
 * petals, stems, ribbon and wrapping. Those previews, the `Fix crop` control and
 * the cutout-derived warnings are gone, and so is the engine behind them. A
 * composite panel only ever trims SEPARATOR pixels — the product is never
 * segmented.
 *
 * THE CORRECTION STEP IS NOT OPTIONAL WHEN THE DETECTOR IS UNSURE
 * --------------------------------------------------------------
 * The server returns its grid hypothesis with a confidence. When it is below the
 * threshold nothing is cut: this UI shows the proposal on top of the original and
 * waits for an explicit "Create views". That decision is the whole reason the
 * panel cropper is safe.
 *
 * WHY THE PREVIEWS ARE BLOB URLS
 * ------------------------------
 * Reference media is private and served behind a bearer token, and an <img src>
 * cannot send one. Each preview fetches its bytes through the service and renders
 * a blob URL, revoked on unmount.
 */

const STATUS_META = {
  UPLOADING: {
    label: 'Uploading',
    icon: Loader2,
    tint: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]',
    spin: true,
  },
  PROCESSING: {
    label: 'Analysing',
    icon: Loader2,
    tint: 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]',
    spin: true,
  },
  READY: {
    label: 'Ready',
    icon: CheckCircle2,
    tint: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  NEEDS_REVIEW: {
    label: 'Needs review',
    icon: AlertTriangle,
    tint: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300',
  },
  FAILED: {
    label: 'Failed',
    icon: AlertCircle,
    tint: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  },
};

function StatusBadge({ status, stale }) {
  const meta = STATUS_META[status] || STATUS_META.UPLOADING;
  const Icon = meta.icon;
  return (
    <span
      data-testid="reference-status"
      data-status={status}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${meta.tint}`}
    >
      <Icon className={`w-3 h-3 ${meta.spin ? 'animate-spin' : ''}`} aria-hidden="true" />
      {stale ? 'Interrupted' : meta.label}
    </span>
  );
}

/** Fetch one asset as a blob URL, and revoke it when the asset changes. */
function useAssetBlob(imageId, kind, available, revision) {
  const [url, setUrl] = useState(null);
  const [state, setState] = useState('idle');

  useEffect(() => {
    if (!imageId || !available) {
      setUrl(null);
      setState('idle');
      return undefined;
    }
    let cancelled = false;
    let objectUrl = null;
    setState('loading');
    studio
      .fetchReferenceAsset(imageId, kind)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setUrl(null);
        setState('error');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId, kind, available, revision]);

  return { url, state };
}

function AssetPreview({ imageId, kind = 'original', asset, alt, revision, className = '' }) {
  const { url, state } = useAssetBlob(imageId, kind, Boolean(asset?.available), revision);
  return (
    <div
      className={`relative rounded-xl overflow-hidden border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] ${className}`}
    >
      {state === 'ready' && url ? (
        <img src={url} alt={alt} className="w-full h-full object-contain" />
      ) : (
        <div className="w-full h-full min-h-[96px] flex flex-col items-center justify-center gap-1 text-[10px] text-[var(--color-botanical-subtle)]">
          {state === 'loading' ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : state === 'error' ? (
            <>
              <AlertCircle className="w-4 h-4" aria-hidden="true" />
              <span>Could not load</span>
            </>
          ) : asset?.missing ? (
            <>
              <AlertCircle className="w-4 h-4" aria-hidden="true" />
              <span>File missing</span>
            </>
          ) : (
            <>
              <ImageIcon className="w-4 h-4" aria-hidden="true" />
              <span>Not available</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const uniqueMessages = (list) => Array.from(new Set((list || []).filter(Boolean)));

const ANGLE_LABELS = {
  front: 'Front',
  back: 'Back',
  left: 'Left side',
  right: 'Right side',
  'three-quarter-left': 'Three-quarter left',
  'three-quarter-right': 'Three-quarter right',
  top: 'Top',
  bottom: 'Bottom',
  detail: 'Close-up detail',
  texture: 'Material / texture',
  wrapping: 'Wrapping / construction',
  other: 'Other',
};

function AnglePicker({ value, onChange, disabled }) {
  return (
    <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-botanical-subtle)]">
      <span className="sr-only">Viewpoint label</span>
      <select
        data-testid="reference-angle"
        value={value || ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-lowest)] px-1.5 py-1 text-[10px] text-[var(--color-botanical-muted)]"
      >
        <option value="">Viewpoint: unlabelled</option>
        {studio.VIEW_ANGLES.map((angle) => (
          <option key={angle} value={angle}>
            {ANGLE_LABELS[angle] || angle}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The detected/proposed grid drawn over the ORIGINAL. Nothing here writes: the
 * boxes are the server's proposal for the CURRENT columns/rows/padding.
 */
function GridOverlay({ imageId, asset, analysis, revision }) {
  const { url, state } = useAssetBlob(imageId, 'original', Boolean(asset?.available), revision);
  return (
    <div className="relative rounded-xl overflow-hidden border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)]">
      {state === 'ready' && url ? (
        <img src={url} alt="Composite reference with the proposed panel grid" className="w-full h-auto block" />
      ) : (
        <div className="aspect-[4/3] flex items-center justify-center text-[11px] text-[var(--color-botanical-subtle)]">
          {state === 'loading' ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : 'Original unavailable'}
        </div>
      )}
      {(analysis?.panels || []).map((panel) => (
        <div
          key={panel.index}
          data-testid={`panel-box-${panel.index}`}
          className="absolute border-2 border-[#964735] bg-[#964735]/10"
          style={{
            left: `${panel.box.x * 100}%`,
            top: `${panel.box.y * 100}%`,
            width: `${panel.box.width * 100}%`,
            height: `${panel.box.height * 100}%`,
          }}
        >
          <span className="absolute -top-0.5 left-0 bg-[#964735] text-white text-[9px] font-bold px-1 rounded-br">
            {panel.index + 1}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Composite review: adjust the grid, look at what it would produce, then create
 * the views. `analysis` is always the SERVER's answer for the current numbers —
 * this component never guesses a crop itself.
 */
function GridWorkspace({
  image,
  analysis,
  busy,
  onChangeLayout,
  onPreview,
  onConfirm,
  onDismiss,
  angles,
  onAngleChange,
}) {
  const layout = analysis?.layout || {
    columns: image.composite?.columns || 4,
    rows: image.composite?.rows || 3,
    padding: image.composite?.padding || 0,
  };
  const panelCount = analysis?.layout?.panelCount ?? 0;
  const lowConfidence = analysis ? analysis.confidence < analysis.threshold : Boolean(image.composite?.needsCorrection);

  const step = (key, delta) =>
    onChangeLayout({
      columns: layout.columns,
      rows: layout.rows,
      padding: layout.padding || 0,
      [key]: Math.max(1, Math.min(key === 'padding' ? 100 : 8, Number(layout[key] || 0) + delta)),
    });

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-botanical-border)] p-3" data-testid="grid-workspace">
      <div className="flex items-start gap-2">
        <Grid3x3 className="w-4 h-4 mt-0.5 text-[var(--color-botanical-muted)]" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-[12px] font-semibold text-[var(--color-botanical-muted)]">
            {analysis?.isComposite
              ? `${panelCount} views detected`
              : 'This image is one photograph'}
            {analysis && analysis.isComposite ? (
              <span className="font-normal text-[var(--color-botanical-subtle)]">
                {' '}
                · {layout.columns} columns × {layout.rows} rows
              </span>
            ) : null}
          </p>
          {analysis?.isComposite && (
            <p className="text-[11px] text-[var(--color-botanical-subtle)]">
              {analysis.source === 'declared'
                ? 'Using the layout you chose.'
                : `Detector confidence ${Math.round((analysis.confidence || 0) * 100)}%.`}{' '}
              Each panel is cut along the separators only — the product inside it is never segmented or trimmed.
            </p>
          )}
          {!analysis?.isComposite && (
            <p className="text-[11px] text-[var(--color-botanical-subtle)]">
              No grid was found. If this image really is a sheet of views, set the columns and rows below.
            </p>
          )}
        </div>
      </div>

      {analysis?.isComposite && (
        <GridOverlay
          imageId={image.id}
          asset={image.original}
          analysis={analysis}
          revision={`${layout.columns}x${layout.rows}:${layout.padding}:${analysis.confidence}`}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-botanical-subtle)]">Columns</span>
          <button type="button" aria-label="Fewer columns" disabled={busy} onClick={() => step('columns', -1)} className="px-2 py-0.5 rounded border border-[var(--color-border-strong)] text-[11px] font-bold disabled:opacity-40">
            −
          </button>
          <span data-testid="grid-columns" className="w-5 text-center text-[11px] font-semibold">{layout.columns}</span>
          <button type="button" aria-label="More columns" disabled={busy} onClick={() => step('columns', 1)} className="px-2 py-0.5 rounded border border-[var(--color-border-strong)] text-[11px] font-bold disabled:opacity-40">
            +
          </button>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-botanical-subtle)]">Rows</span>
          <button type="button" aria-label="Fewer rows" disabled={busy} onClick={() => step('rows', -1)} className="px-2 py-0.5 rounded border border-[var(--color-border-strong)] text-[11px] font-bold disabled:opacity-40">
            −
          </button>
          <span data-testid="grid-rows" className="w-5 text-center text-[11px] font-semibold">{layout.rows}</span>
          <button type="button" aria-label="More rows" disabled={busy} onClick={() => step('rows', 1)} className="px-2 py-0.5 rounded border border-[var(--color-border-strong)] text-[11px] font-bold disabled:opacity-40">
            +
          </button>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-botanical-subtle)]">Trim borders</span>
          <button type="button" aria-label="Less border trim" disabled={busy} onClick={() => step('padding', -2)} className="px-2 py-0.5 rounded border border-[var(--color-border-strong)] text-[11px] font-bold disabled:opacity-40">
            −
          </button>
          <span data-testid="grid-padding" className="w-8 text-center text-[11px] font-semibold">{layout.padding || 0}px</span>
          <button type="button" aria-label="More border trim" disabled={busy} onClick={() => step('padding', 2)} className="px-2 py-0.5 rounded border border-[var(--color-border-strong)] text-[11px] font-bold disabled:opacity-40">
            +
          </button>
        </div>
        <button
          type="button"
          onClick={() => onPreview({ columns: layout.columns, rows: layout.rows, padding: layout.padding || 0 })}
          disabled={busy}
          className="px-3 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] disabled:opacity-40 inline-flex items-center gap-1.5"
        >
          <RefreshCw className="w-3 h-3" aria-hidden="true" />
          Preview layout
        </button>
      </div>

      {lowConfidence && analysis?.isComposite && (
        <p className="text-[11px] text-amber-900 flex items-start gap-1.5" data-testid="grid-uncertain">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          The separators are ambiguous, so nothing has been cut. Check the boxes above, then create the views.
        </p>
      )}

      {analysis?.isComposite && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-[var(--color-botanical-muted)]">Label each view (optional)</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {(analysis.panels || []).map((panel) => (
              <label key={panel.index} className="flex items-center gap-1.5 text-[10px] text-[var(--color-botanical-subtle)]">
                <span className="w-4 text-right font-bold">{panel.index + 1}</span>
                <select
                  value={angles?.[panel.index] || ''}
                  onChange={(e) => onAngleChange(panel.index, e.target.value)}
                  className="flex-1 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-lowest)] px-1 py-0.5 text-[10px]"
                >
                  <option value="">Unlabelled</option>
                  {studio.VIEW_ANGLES.map((angle) => (
                    <option key={angle} value={angle}>
                      {ANGLE_LABELS[angle] || angle}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}

      {analysis?.warnings?.length > 0 && (
        <ul className="space-y-0.5">
          {uniqueMessages(analysis.warnings).map((message) => (
            <li key={message} className="text-[10px] text-amber-900 flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
              {message}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {analysis?.isComposite && (
          <button
            type="button"
            data-testid="confirm-views"
            disabled={busy}
            onClick={() =>
              onConfirm({ columns: layout.columns, rows: layout.rows, padding: layout.padding || 0, angles })
            }
            className="px-4 py-2 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] disabled:opacity-50 text-white text-[12px] font-semibold inline-flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Layers className="w-3.5 h-3.5" aria-hidden="true" />}
            Create {panelCount} views
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="px-4 py-2 rounded-full border border-[var(--color-border-strong)] text-[12px] font-semibold text-[var(--color-botanical-muted)] disabled:opacity-50"
        >
          {analysis?.isComposite ? 'Not a grid' : 'Close'}
        </button>
      </div>
    </div>
  );
}

export default function ReferenceImageStudio({
  productSlug = '',
  draftKey = '',
  onAcceptedChange,
  onBusyChange,
  disabled = false,
  className = '',
}) {
  const [images, setImages] = useState([]);
  const [setWarnings, setSetWarnings] = useState([]);
  const [setNotes, setSetNotes] = useState([]);
  const [loading, setLoading] = useState(Boolean(productSlug || draftKey));
  const [error, setError] = useState('');
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [queue, setQueue] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [gridId, setGridId] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [gridAngles, setGridAngles] = useState([]);
  const [actionId, setActionId] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragFrom, setDragFrom] = useState(null);
  const inputRef = useRef(null);
  const replaceRef = useRef(null);
  const [replaceId, setReplaceId] = useState(null);
  const pollRef = useRef(null);
  const pollsRef = useRef(0);

  const scope = useMemo(
    () => (productSlug ? { productSlug } : draftKey ? { draftKey } : null),
    [productSlug, draftKey]
  );

  const reload = useCallback(async () => {
    if (!scope) return [];
    try {
      const payload = await studio.listReferences(scope);
      setImages(payload.images);
      setSetWarnings(payload.setWarnings);
      setSetNotes(payload.setNotes);
      setError('');
      setListError('');
      setListLoaded(true);
      return payload.images;
    } catch (err) {
      setListError(err.message || 'The reference images could not be loaded.');
      setListLoaded(false);
      return [];
    } finally {
      setLoading(false);
    }
  }, [scope]);

  const retryLoad = useCallback(() => {
    setListError('');
    setLoading(true);
    void reload();
  }, [reload]);

  useEffect(() => {
    setSelectedId(null);
    setGridId(null);
    setAnalysis(null);
    reload();
  }, [reload]);

  // Poll while anything is genuinely in flight.
  const inFlight = images.some(
    (img) => (img.status === 'UPLOADING' || img.status === 'PROCESSING') && !img.stale
  );

  useEffect(() => {
    if (!inFlight || !scope) return undefined;
    if (pollsRef.current > 80) return undefined;
    pollRef.current = setTimeout(async () => {
      pollsRef.current += 1;
      const next = await reload();
      if (!next.some((img) => (img.status === 'UPLOADING' || img.status === 'PROCESSING') && !img.stale)) {
        pollsRef.current = 0;
      }
    }, 1200);
    return () => clearTimeout(pollRef.current);
  }, [inFlight, reload, scope, images]);

  /**
   * A composite SOURCE SHEET: the grid the administrator confirmed, whose views
   * already exist as their own cards. It is provenance, not a viewpoint — so it
   * is never counted as a view, never accepted, and never sent to the
   * reconstruction engine (which would otherwise be handed twelve tiny products
   * at once and asked for one).
   */
  const panelCountFor = (image) =>
    images.filter((other) => String(other.source?.parentId || '') === String(image.id)).length;

  const isSheet = (image) =>
    image.source?.type !== 'panel' &&
    Boolean(image.composite?.confirmed) &&
    panelCountFor(image) > 0;

  const viewImages = useMemo(() => images.filter((img) => !isSheet(img)), [images]);
  const acceptedIds = useMemo(() => images.filter((img) => img.accepted).map((img) => img.id), [images]);
  const acceptedKey = acceptedIds.join(',');
  useEffect(() => {
    if (onAcceptedChange) onAcceptedChange(acceptedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptedKey]);

  const busy = inFlight || queue.some((item) => !item.error);
  const busyKey = `${busy}`;
  useEffect(() => {
    if (onBusyChange) onBusyChange(busy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyKey]);

  // ── Upload ─────────────────────────────────────────────────────────────
  const uploadOne = useCallback(
    async (file, key) => {
      const setProgress = (progress) =>
        setQueue((q) => q.map((item) => (item.key === key ? { ...item, progress } : item)));
      try {
        const result = await studio.uploadReference(file, { ...(scope || {}), onProgress: setProgress });
        if (result.duplicateOf) {
          setNotice('One of those images is byte-identical to one already in this set — it was added, but you can remove it.');
        }
        setQueue((q) => q.filter((item) => item.key !== key));
        return result;
      } catch (err) {
        setQueue((q) =>
          q.map((item) =>
            item.key === key
              ? {
                  ...item,
                  error: err.message || 'Upload failed.',
                  errorCode: err.code || 'API_ERROR',
                  errorId: err.errorId || null,
                  errorStatus: err.status || 0,
                }
              : item
          )
        );
        return null;
      }
    },
    [scope]
  );

  const retryUpload = useCallback(
    async (item) => {
      if (!item?.file) return;
      setQueue((q) =>
        q.map((entry) =>
          entry.key === item.key ? { ...entry, error: '', errorCode: '', errorId: null, errorStatus: 0, progress: 0 } : entry
        )
      );
      pollsRef.current = 0;
      await uploadOne(item.file, item.key);
      await reload();
    },
    [reload, uploadOne]
  );

  const addFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      setNotice('');
      setError('');
      const accepted = [];
      for (const file of files) {
        if (!studio.REFERENCE_IMAGE_TYPES.includes(file.type)) {
          setError(`"${file.name}" is not a supported image. Use JPEG, PNG, WebP, GIF or AVIF.`);
          continue;
        }
        if (file.size > studio.REFERENCE_MAX_BYTES) {
          setError(`"${file.name}" is larger than 5 MB.`);
          continue;
        }
        if (images.length + accepted.length + queue.length >= studio.REFERENCE_SET_LIMIT) {
          setError(`This set is limited to ${studio.REFERENCE_SET_LIMIT} images.`);
          break;
        }
        accepted.push(file);
      }
      if (!accepted.length) return;
      const stamp = Date.now();
      const entries = accepted.map((file, i) => ({ file, key: `${stamp}-${i}-${file.name}` }));
      pollsRef.current = 0;
      setQueue((q) => [
        ...q,
        ...entries.map(({ file, key }) => ({ key, name: file.name, progress: 0, error: '', file })),
      ]);
      // Sequential on purpose: a phone uploading eight 4 MB photos in parallel
      // would fight for the same uplink and make every progress bar stall.
      for (const { file, key } of entries) {
        // eslint-disable-next-line no-await-in-loop
        await uploadOne(file, key);
      }
      // Detection settles server-side after the upload returns; the effect above
      // opens the grid workspace as soon as the row says it found one.
      await reload();
    },
    [images.length, queue.length, reload, uploadOne]
  );

  // ── Item actions ───────────────────────────────────────────────────────
  const withAction = async (id, fn) => {
    setActionId(id);
    setError('');
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err.message || 'That action could not be completed.');
    } finally {
      setActionId(null);
    }
  };

  const toggleAccept = (image) =>
    withAction(image.id, () => studio.updateReference(image.id, { accepted: !image.accepted }));

  const setAngle = (image, angle) =>
    withAction(image.id, () => studio.updateReference(image.id, { viewAngle: angle }));

  const acceptAllUsable = async () => {
    setActionId('bulk');
    setError('');
    try {
      // A composite SOURCE SHEET is provenance, not a view: accepting it would
      // put the whole grid into the reconstruction's view set alongside the
      // panels already cut from it.
      const usable = images.filter((img) => !img.accepted && img.status !== 'FAILED' && !isSheet(img));
      for (const img of usable) {
        // eslint-disable-next-line no-await-in-loop
        await studio.updateReference(img.id, { accepted: true });
      }
      await reload();
    } catch (err) {
      setError(err.message || 'Those images could not be accepted.');
    } finally {
      setActionId(null);
    }
  };

  const makePrimary = (image) =>
    withAction(image.id, () => {
      const ordered = [image.id, ...images.filter((img) => img.id !== image.id).map((img) => img.id)];
      return studio.reorderReferences(ordered);
    });

  const remove = (image) => withAction(image.id, () => studio.removeReference(image.id));

  /**
   * Replace keeps the SLOT: the new upload takes the old image's position,
   * primary flag and label, and the old row (and its files) is deleted
   * afterwards — upload first, delete second, so a refused upload loses nothing.
   */
  const replaceFile = async (file) => {
    const target = images.find((img) => img.id === replaceId);
    setReplaceId(null);
    if (!target || !file) return;
    if (!studio.REFERENCE_IMAGE_TYPES.includes(file.type)) {
      setError(`"${file.name}" is not a supported image. Use JPEG, PNG, WebP, GIF or AVIF.`);
      return;
    }
    if (file.size > studio.REFERENCE_MAX_BYTES) {
      setError(`"${file.name}" is larger than 5 MB.`);
      return;
    }
    const index = images.findIndex((img) => img.id === target.id);
    const wasPrimary = Boolean(target.isPrimary);
    setActionId(target.id);
    setError('');
    try {
      const result = await studio.uploadReference(file, {
        ...(scope || {}),
        ...(target.label ? { label: target.label } : {}),
      });
      const newId = result.image?.id;
      if (!newId) throw new Error('The replacement upload did not return an image.');
      const ordered = images.map((img) => img.id);
      ordered.splice(index < 0 ? ordered.length : index, 1, newId);
      await studio.reorderReferences(ordered);
      await studio.removeReference(target.id);
      if (wasPrimary) await studio.updateReference(newId, { isPrimary: true });
      pollsRef.current = 0;
      await reload();
    } catch (err) {
      setError(err.message || 'That image could not be replaced.');
      await reload();
    } finally {
      setActionId(null);
    }
  };

  const retry = (image) => withAction(image.id, () => studio.reprocessReference(image.id));

  // ── Composite workspace ────────────────────────────────────────────────
  const openGrid = useCallback(
    async (image, layout = {}) => {
      autoOpened.current.add(image.id);
      setGridId(image.id);
      setSelectedId(null);
      setError('');
      setGridAngles([]);
      setActionId(image.id);
      try {
        const result = await studio.previewViews(image.id, layout);
        setAnalysis(result);
      } catch (err) {
        setError(err.message || 'The panel layout could not be analysed.');
        setAnalysis(null);
      } finally {
        setActionId(null);
      }
    },
    []
  );

  const changeLayout = useCallback(
    async (layout) => {
      const image = images.find((img) => img.id === gridId);
      if (!image) return;
      await openGrid(image, layout);
    },
    [gridId, images, openGrid]
  );

  const confirmViews = useCallback(
    async (layout) => {
      const image = images.find((img) => img.id === gridId);
      if (!image) return;
      setActionId(image.id);
      setError('');
      try {
        const result = await studio.confirmViews(image.id, { ...layout, angles: gridAngles });
        setNotice(
          `Created ${result.panels.length} view${result.panels.length === 1 ? '' : 's'} from that composite. The original sheet is kept.`
        );
        setGridId(null);
        setAnalysis(null);
        await reload();
      } catch (err) {
        setError(err.message || 'The views could not be created.');
      } finally {
        setActionId(null);
      }
    },
    [gridAngles, gridId, images, reload]
  );

  const dismissGrid = useCallback(async () => {
    const image = images.find((img) => img.id === gridId);
    setGridId(null);
    setAnalysis(null);
    if (image?.composite?.detected && !image.composite?.confirmed) {
      // Remember the decision so the effect above cannot re-open what the
      // administrator just dismissed.
      autoOpened.current.add(image.id);
      // "Not a grid" is a decision: clear the proposal so the card stops
      // offering to split a single photograph.
      await withAction(image.id, () => studio.updateReference(image.id, { composite: false }));
    }
  }, [gridId, images]);

  const move = async (id, dir) => {
    const index = images.findIndex((img) => img.id === id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= images.length) return;
    const ordered = images.map((img) => img.id);
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    setActionId(id);
    try {
      const payload = await studio.reorderReferences(ordered);
      setImages(payload.images);
    } catch (err) {
      setError(err.message || 'The new order could not be saved.');
    } finally {
      setActionId(null);
    }
  };

  const handleDropOn = async (targetId) => {
    if (!dragFrom || dragFrom === targetId) {
      setDragFrom(null);
      return;
    }
    const ordered = images.map((img) => img.id).filter((id) => id !== dragFrom);
    const at = ordered.indexOf(targetId);
    ordered.splice(at < 0 ? ordered.length : at, 0, dragFrom);
    setDragFrom(null);
    setActionId(targetId);
    try {
      const payload = await studio.reorderReferences(ordered);
      setImages(payload.images);
    } catch (err) {
      setError(err.message || 'The new order could not be saved.');
    } finally {
      setActionId(null);
    }
  };

  const selected = images.find((img) => img.id === selectedId) || null;
  const gridTarget = images.find((img) => img.id === gridId) || null;
  const revision = selected
    ? `${selected.status}:${selected.processing?.attempts || 0}:${selected.processing?.finishedAt || ''}`
    : '';

  /**
   * OPEN THE GRID WORKSPACE WHEN THE DETECTOR FINDS ONE.
   *
   * Detection runs in the BACKGROUND, so the upload response cannot carry the
   * verdict: the row arrives as PROCESSING and only later says "this is a 3×2
   * sheet". The upload handler therefore cannot decide. This effect watches the
   * settled list and opens the proposal ONCE per image — never twice, never after
   * the administrator dismissed it — so a detected grid is always reviewed
   * rather than silently left as one unsplit photograph.
   */
  const autoOpened = useRef(new Set());
  useEffect(() => {
    if (!listLoaded) return;
    const candidate = images.find(
      (image) =>
        image.composite?.detected &&
        !image.composite?.confirmed &&
        image.source?.type !== 'panel' &&
        !autoOpened.current.has(image.id)
    );
    if (!candidate) return;
    autoOpened.current.add(candidate.id);
    void openGrid(candidate, {});
  }, [images, listLoaded, openGrid]);

  if (!scope) {
    return (
      <div className={`text-[12px] text-[var(--color-botanical-subtle)] ${className}`}>
        Preparing the studio… (a product or draft reference is required)
      </div>
    );
  }

  return (
    <div className={`space-y-4 ${className}`} data-testid="reference-studio">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-botanical-subtle)]">
        <span className="inline-flex items-center gap-1">
          <SparklesIcon />
          Originals are stored untouched. Upload several photos, or one composite sheet of views.
        </span>
      </div>

      <input
        ref={replaceRef}
        data-testid="reference-replace-input"
        type="file"
        accept={studio.REFERENCE_IMAGE_TYPES.join(',')}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0] || null;
          e.target.value = '';
          replaceFile(file);
        }}
      />

      <div
        role="button"
        tabIndex={0}
        aria-label="Upload product photographs for preparation"
        data-testid="reference-dropzone"
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!disabled) addFiles(e.dataTransfer.files);
        }}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)] ${
          dragOver
            ? 'border-[#964735] bg-[var(--color-surface-low)]'
            : 'border-[var(--color-border-strong)] hover:border-[var(--color-focus)] hover:bg-[var(--color-surface-low)]/60'
        } ${disabled ? 'pointer-events-none opacity-60' : ''}`}
      >
        <input
          ref={inputRef}
          data-testid="reference-input"
          type="file"
          accept={studio.REFERENCE_IMAGE_TYPES.join(',')}
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <UploadCloud className="w-6 h-6 text-[var(--color-botanical-subtle)] mx-auto" aria-hidden="true" />
        <p className="mt-1.5 text-[12px] font-semibold text-[var(--color-botanical-muted)]">
          Drop photographs or a composite sheet here, or click to choose several
        </p>
        <p className="text-[11px] text-[var(--color-botanical-subtle)]">
          JPEG, PNG, WebP, GIF or AVIF · up to 5 MB each · {images.length}/{studio.REFERENCE_SET_LIMIT} in this set
        </p>
      </div>

      {queue.length > 0 && (
        <ul className="space-y-2" aria-live="polite">
          {queue.map((item) => (
            <li key={item.key} className="rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-[var(--color-botanical-muted)]">
                <span className="truncate">{item.name}</span>
                <span>{item.error ? 'Failed' : `${item.progress}%`}</span>
              </div>
              {item.error ? (
                <div className="mt-1 space-y-1.5">
                  <p className="text-[11px] text-[var(--color-badge-fg-strong)] flex items-start gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{item.error}</span>
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    <span data-testid="reference-upload-error" className="text-[10px] font-mono text-[var(--color-botanical-subtle)] truncate">
                      {item.errorCode || 'API_ERROR'}
                      {item.errorStatus ? ` · HTTP ${item.errorStatus}` : ''}
                      {item.errorId ? ` · ref ${item.errorId}` : ''}
                    </span>
                    {item.file && (
                      <button
                        type="button"
                        data-testid="reference-upload-retry"
                        onClick={() => retryUpload(item)}
                        className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[var(--color-border-strong)] text-[10px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)]"
                      >
                        <RefreshCw className="w-3 h-3" aria-hidden="true" />
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-1.5 h-1.5 rounded-full bg-[#e5e2dd] overflow-hidden">
                  <div className="h-full bg-[#964735] transition-all" style={{ width: `${item.progress}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {listError && (
        <div
          data-testid="reference-list-error"
          className="flex items-start gap-2 p-2.5 rounded-lg bg-[var(--color-badge-bg)]/60 text-[var(--color-badge-fg-strong)] text-[12px] font-medium"
          role="alert"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">{listError}</span>
          <button
            type="button"
            data-testid="reference-retry"
            onClick={retryLoad}
            className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)]"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Retry
          </button>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-[var(--color-badge-bg)]/60 text-[var(--color-badge-fg-strong)] text-[12px] font-medium" role="alert">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 text-amber-900 text-[12px]" role="status">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      {loading && images.length === 0 && !listError && (
        <p className="text-[12px] text-[var(--color-botanical-subtle)] flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          Loading references…
        </p>
      )}

      {(setWarnings.length > 0 || setNotes.length > 0) && (
        <div className="rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-3 space-y-1" data-testid="reference-set-notes">
          {uniqueMessages(setWarnings).map((message) => (
            <p key={message} className="text-[11px] text-amber-900 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
              {message}
            </p>
          ))}
          {uniqueMessages(setNotes).map((message) => (
            <p key={message} className="text-[11px] text-[var(--color-botanical-subtle)] flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
              {message}
            </p>
          ))}
        </div>
      )}

      {/* Composite workspace — shown for the row currently being reviewed. */}
      {gridTarget && (
        <div className="rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-3" data-testid="composite-panel">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-botanical-subtle)]">
              Composite sheet · {gridTarget.original?.width}×{gridTarget.original?.height}
            </p>
            <button
              type="button"
              onClick={() => {
                setGridId(null);
                setAnalysis(null);
              }}
              aria-label="Close the composite workspace"
              className="p-1 rounded-lg text-[var(--color-botanical-subtle)] hover:bg-[var(--color-surface-low)]"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
          {analysis ? (
            <GridWorkspace
              image={gridTarget}
              analysis={analysis}
              busy={actionId === gridTarget.id}
              angles={gridAngles}
              onAngleChange={(index, value) =>
                setGridAngles((current) => {
                  const next = [...current];
                  next[index] = value;
                  return next;
                })
              }
              onChangeLayout={changeLayout}
              onPreview={(layout) => openGrid(gridTarget, layout)}
              onConfirm={confirmViews}
              onDismiss={dismissGrid}
            />
          ) : (
            <p className="text-[12px] text-[var(--color-botanical-subtle)] flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              Analysing the grid…
            </p>
          )}
        </div>
      )}

      {images.length > 0 && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="reference-grid">
          {images.map((image, index) => {
            const isPanel = image.source?.type === 'panel';
            const derived = panelCountFor(image);
            const isSheetCard = !isPanel && isSheet(image);
            return (
              <li
                key={image.id}
                data-testid={`reference-card-${index}`}
                draggable
                onDragStart={() => setDragFrom(image.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDropOn(image.id)}
                className={`rounded-xl border bg-[var(--color-surface-lowest)] p-3 space-y-2 ${
                  image.accepted ? 'border-emerald-300' : 'border-[var(--color-botanical-border)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                    {image.isPrimary && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-btn)] text-white text-[10px] font-bold uppercase px-1.5 py-0.5">
                        <Star className="w-3 h-3" aria-hidden="true" />
                        Primary
                      </span>
                    )}
                    <StatusBadge status={image.status} stale={image.stale} />
                    {isPanel && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] text-[10px] font-bold uppercase px-1.5 py-0.5">
                        <Layers className="w-3 h-3" aria-hidden="true" />
                        View {(image.source?.panelIndex ?? 0) + 1}
                      </span>
                    )}
                    {derived > 0 && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] text-[10px] font-bold uppercase px-1.5 py-0.5"
                        data-testid={isSheetCard ? 'source-sheet-badge' : undefined}
                      >
                        <Grid3x3 className="w-3 h-3" aria-hidden="true" />
                        {isSheetCard ? `Source sheet · ${derived} views` : `${derived} views`}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-[var(--color-botanical-subtle)] shrink-0">
                    {image.original?.width}×{image.original?.height}
                  </span>
                </div>

                <AssetPreview
                  imageId={image.id}
                  asset={image.original}
                  alt={`Reference ${index + 1}${image.viewAngle ? ` — ${ANGLE_LABELS[image.viewAngle] || image.viewAngle}` : ''}`}
                  revision={1}
                  className="aspect-square"
                />

                <AnglePicker
                  value={image.viewAngle}
                  disabled={actionId === image.id}
                  onChange={(angle) => setAngle(image, angle)}
                />

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedId(selectedId === image.id ? null : image.id)}
                    className="px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)]"
                  >
                    {selectedId === image.id ? 'Hide details' : 'Details'}
                  </button>
                  {!isPanel && (
                    <button
                      type="button"
                      data-testid={`split-${index}`}
                      onClick={() => openGrid(image, {})}
                      disabled={actionId === image.id}
                      title="Treat this image as a grid of views and cut it into separate panels"
                      className="px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <Grid3x3 className="w-3 h-3" aria-hidden="true" />
                      {derived > 0 ? 'Edit views' : 'Split into views'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => move(image.id, -1)}
                    disabled={index === 0 || actionId === image.id}
                    aria-label={`Move reference ${index + 1} earlier`}
                    className="px-2 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-botanical-muted)] disabled:opacity-30"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(image.id, 1)}
                    disabled={index === images.length - 1 || actionId === image.id}
                    aria-label={`Move reference ${index + 1} later`}
                    className="px-2 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-botanical-muted)] disabled:opacity-30"
                  >
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  {!image.isPrimary && (
                    <button
                      type="button"
                      onClick={() => makePrimary(image)}
                      disabled={actionId === image.id}
                      className="px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] disabled:opacity-50"
                    >
                      Make primary
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setReplaceId(image.id);
                      replaceRef.current?.click();
                    }}
                    disabled={actionId === image.id}
                    title="Upload a different photograph in this image's place (position, label and primary flag are kept)"
                    className="px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] disabled:opacity-50"
                  >
                    Replace
                  </button>
                  {isSheetCard ? (
                    <span
                      className="px-2.5 py-1 rounded-lg border border-dashed border-[var(--color-botanical-border)] text-[10px] font-semibold text-[var(--color-botanical-subtle)]"
                      title="The composite sheet the views were cut from. It is kept so the crop can be audited or corrected, but it is not a viewpoint, so the reconstruction never receives it."
                    >
                      Kept for audit — not a view
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleAccept(image)}
                      disabled={actionId === image.id || image.status === 'FAILED'}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold disabled:opacity-40 ${
                        image.accepted ? 'bg-emerald-100 text-emerald-800' : 'bg-[var(--color-btn)] text-white hover:bg-[var(--color-btn-hover-alt)]'
                      }`}
                    >
                      {image.accepted ? 'Accepted ✓' : 'Accept'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(image)}
                    disabled={actionId === image.id}
                    aria-label={`Remove reference ${index + 1}`}
                    className="px-2 py-1 rounded-lg text-[11px] font-semibold text-[var(--color-danger)] hover:bg-[#ffdad6] disabled:opacity-40"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>

                {image.warnings?.length > 0 && (
                  <ul className="space-y-0.5">
                    {uniqueMessages(image.warnings).map((message) => (
                      <li key={message} className="text-[10px] text-amber-900 flex items-start gap-1">
                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                        {message}
                      </li>
                    ))}
                  </ul>
                )}
                {image.processing?.error && (
                  <p className="text-[10px] text-[var(--color-badge-fg-strong)] flex items-start gap-1">
                    <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                    {image.processing.error}
                  </p>
                )}

                {selectedId === image.id && (
                  <div className="rounded-lg border border-[var(--color-botanical-border)] p-3 space-y-3" data-testid="reference-detail">
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-[var(--color-botanical-muted)]">
                      <dt>Format</dt>
                      <dd className="text-right">{image.original?.format || '—'}</dd>
                      <dt>Dimensions</dt>
                      <dd className="text-right">{image.original?.width}×{image.original?.height}</dd>
                      <dt>Source</dt>
                      <dd className="text-right">
                        {isPanel
                          ? `Panel ${(image.source?.panelIndex ?? 0) + 1} of ${image.source?.grid?.columns || '?'}×${image.source?.grid?.rows || '?'}`
                          : derived > 0
                            ? `Composite (${derived} views)`
                            : 'Uploaded photograph'}
                      </dd>
                      <dt>Panel box</dt>
                      <dd className="text-right">
                        {isPanel && image.source?.box
                          ? `${image.source.box.width.toFixed(2)}×${image.source.box.height.toFixed(2)} at ${image.source.box.x.toFixed(2)}, ${image.source.box.y.toFixed(2)}`
                          : '—'}
                      </dd>
                      <dt>Measurements</dt>
                      <dd className="text-right">
                        sharpness {image.validation?.sharpnessScore ?? '—'} · contrast {image.validation?.contrastStdev ?? '—'}
                      </dd>
                    </dl>

                    {isPanel && (
                      <p className="text-[10px] text-[var(--color-botanical-subtle)] flex items-start gap-1">
                        <Info className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                        Cut from the composite sheet. Editing the sheet&apos;s grid re-cuts this view; deleting the sheet deletes it.
                      </p>
                    )}

                    {image.processing?.metrics?.notes?.length > 0 && (
                      <ul className="space-y-0.5">
                        {uniqueMessages(image.processing.metrics.notes).map((message) => (
                          <li key={message} className="text-[10px] text-[var(--color-botanical-subtle)] flex items-start gap-1">
                            <Info className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                            {message}
                          </li>
                        ))}
                      </ul>
                    )}

                    <button
                      type="button"
                      onClick={() => retry(image)}
                      disabled={actionId === image.id}
                      className="px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {actionId === image.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      Re-measure
                    </button>
                  </div>
                )}

                {image.composite?.detected && !image.composite?.confirmed && derived === 0 && (
                  <button
                    type="button"
                    onClick={() => openGrid(image, {})}
                    className="text-[10px] font-semibold text-[#964735] underline underline-offset-2"
                  >
                    {image.composite.panelCount || 'Several'} views detected — review the grid
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {images.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-[11px] text-[var(--color-botanical-subtle)] max-w-prose">
            {acceptedIds.length > 0
              ? `${acceptedIds.length} of ${viewImages.length} views accepted${
                  images.length > viewImages.length
                    ? ` · ${images.length - viewImages.length} source sheet kept for audit`
                    : ''
                }.`
              : 'Nothing accepted yet — accept the views you want the reconstruction to use.'}
            {draftKey && !productSlug ? ' Views you do not accept are discarded when you save the product.' : ''}
          </p>
          <button
            type="button"
            onClick={acceptAllUsable}
            disabled={actionId === 'bulk' || viewImages.every((img) => img.accepted)}
            className="px-3.5 py-2 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] disabled:opacity-40 text-white text-[11px] font-semibold inline-flex items-center gap-1.5"
          >
            {actionId === 'bulk' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
            )}
            Accept all
          </button>
        </div>
      )}

      {images.length === 0 && !loading && listLoaded && !listError && (
        <p className="text-[11px] text-[var(--color-botanical-subtle)] inline-flex items-start gap-1.5">
          <X className="w-3.5 h-3.5 mt-0.5" aria-hidden="true" />
          No references yet. Upload separate photographs, or one composite sheet containing a grid of views.
        </p>
      )}
    </div>
  );
}

/** Local icon so the intro line does not need another lucide import. */
function SparklesIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" />
    </svg>
  );
}
