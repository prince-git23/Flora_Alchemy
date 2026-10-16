import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Crop as CropIcon,
  Image as ImageIcon,
  Info,
  Loader2,
  RefreshCw,
  Sparkles,
  Star,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import * as studio from '../../services/referenceImageService.js';

/**
 * ReferenceImageStudio — "3D Studio — Prepare Images" (Phase 1).
 *
 * WHAT IT DOES
 * ------------
 * Uploads product photographs (including flyers and busy-background shots),
 * has the SERVER remove the background and produce a transparent cutout plus a
 * neutral-background preview, then puts the results in front of the
 * administrator to inspect, correct, order, accept or remove.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * No 3D anything. There is no "Generate model" button, no placeholder mesh and
 * no simulated result: Phase 1 ends at a prepared, approved image set, and the
 * studio says so in the UI rather than implying more.
 *
 * THE TWO SET IDENTITIES
 * ----------------------
 * A reference set is keyed either by `productSlug` (the product already exists)
 * or by `draftKey` (the administrator is still in the create-product form). This
 * component supports both with one code path. In draft mode the accepted ids
 * travel with the product create; anything the administrator did not accept is
 * cleaned up server-side at that point, which is why the footer says so.
 *
 * WHY THE PREVIEWS ARE BLOB URLS
 * ------------------------------
 * Reference media is private and served behind a bearer token, and an <img src>
 * cannot send one. Each preview therefore fetches its bytes through
 * `referenceImageService` and renders a blob URL, revoked on unmount.
 */

// ── Status vocabulary (icon + label + tint; never colour alone) ──────────
const STATUS_META = {
  UPLOADING: {
    label: 'Uploading',
    icon: Loader2,
    tint: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]',
    spin: true,
  },
  PROCESSING: {
    label: 'Processing',
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

/**
 * One preview tile. `checker` renders the transparency grid, so a cutout that
 * is genuinely transparent is visually distinguishable from one that is merely
 * white.
 */
function AssetPreview({ imageId, kind, asset, alt, revision, checker = false, className = '' }) {
  const { url, state } = useAssetBlob(imageId, kind, Boolean(asset?.available), revision);
  return (
    <div
      className={`relative rounded-xl overflow-hidden border border-[var(--color-botanical-border)] ${
        checker ? 'bg-[conic-gradient(#e6e3de_90deg,transparent_90deg_180deg,#e6e3de_180deg_270deg,transparent_270deg)] bg-[length:16px_16px]' : 'bg-[var(--color-surface-low)]'
      } ${className}`}
      style={checker ? { backgroundSize: '16px 16px' } : undefined}
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
          ) : (
            <>
              <ImageIcon className="w-4 h-4" aria-hidden="true" />
              <span>Not generated</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * Messages are rendered with `key={message}`, so the same sentence twice would
 * be duplicate React keys — which React treats as an error and which can drop
 * or duplicate a row. The server dedupes engine vs. quality messages; this
 * keeps the render side safe too (older rows, and any future message source).
 */
const uniqueMessages = (list) => Array.from(new Set((list || []).filter(Boolean)));

/**
 * Crop correction. The rectangle is drawn with pointer events (mouse, pen and
 * touch all work) over the ORIGINAL, because the crop is defined as normalized
 * 0..1 of the original frame — exactly what the server re-applies to the
 * untouched original.
 *
 * Dragging is not the only way in: the three adjustment buttons are keyboard
 * reachable, so a crop can be corrected without a precise pointer gesture.
 */
function CropEditor({ image, onApply, onCancel, busy }) {
  const [rect, setRect] = useState(image.crop || null);
  const startRef = useRef(null);
  const boxRef = useRef(null);
  const { url, state } = useAssetBlob(image.id, 'original', Boolean(image.original?.available), 1);

  const pointFrom = (e) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
    };
  };

  const normRect = (a, b) => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  });

  const handleDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    startRef.current = pointFrom(e);
    setRect({ ...startRef.current, width: 0, height: 0 });
  };

  const handleMove = (e) => {
    if (!startRef.current) return;
    setRect(normRect(startRef.current, pointFrom(e)));
  };

  const handleUp = () => {
    startRef.current = null;
    setRect((current) => {
      if (!current) return current;
      // A tap or an accidental hairline drag is not a crop: below 5% of either
      // axis the selection is discarded rather than applied as a sliver.
      if (current.width < 0.05 || current.height < 0.05) return image.crop || null;
      return current;
    });
  };

  const adjust = (factor) => {
    setRect((current) => {
      const base = current || { x: 0, y: 0, width: 1, height: 1 };
      const width = clamp01(base.width * factor);
      const height = clamp01(base.height * factor);
      const cx = base.x + base.width / 2;
      const cy = base.y + base.height / 2;
      const x = clamp01(cx - width / 2);
      const y = clamp01(cy - height / 2);
      return {
        x,
        y,
        width: Math.min(width, 1 - x),
        height: Math.min(height, 1 - y),
      };
    });
  };

  return (
    <div className="space-y-3" data-testid="crop-editor">
      <p className="text-[11px] text-[var(--color-botanical-subtle)]">
        Drag on the photo to choose the product region, or use the buttons. Processing re-runs from the
        untouched original, so the uploaded file is never modified.
      </p>
      <div
        ref={boxRef}
        className="relative w-full max-w-md aspect-square mx-auto rounded-xl overflow-hidden border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] touch-none select-none cursor-crosshair"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      >
        {state === 'ready' && url ? (
          <img src={url} alt="Original upload" className="absolute inset-0 w-full h-full object-contain pointer-events-none" draggable={false} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[var(--color-botanical-subtle)]">
            {state === 'loading' ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : 'Original unavailable'}
          </div>
        )}
        {rect && rect.width > 0 && rect.height > 0 && (
          <div
            className="absolute border-2 border-[#964735] bg-[#964735]/15 pointer-events-none"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            }}
          />
        )}
      </div>
      <p className="text-[11px] text-center text-[var(--color-botanical-muted)]">
        {rect
          ? `Crop: x ${rect.x.toFixed(2)} · y ${rect.y.toFixed(2)} · w ${rect.width.toFixed(2)} · h ${rect.height.toFixed(2)}`
          : 'No crop — the whole frame is used.'}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={() => adjust(0.85)} className="px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)]">
          Tighten
        </button>
        <button type="button" onClick={() => adjust(1.15)} className="px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)]">
          Widen
        </button>
        <button type="button" onClick={() => setRect(null)} className="px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)]">
          Full frame
        </button>
      </div>
      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onApply(rect && rect.width >= 0.05 ? rect : null)}
          className="px-4 py-2 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] disabled:opacity-50 text-white text-[12px] font-semibold inline-flex items-center gap-1.5"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
          Apply crop &amp; reprocess
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-full border border-[var(--color-border-strong)] text-[12px] font-semibold text-[var(--color-botanical-muted)]">
          Cancel
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
  /**
   * A FAILED LIST LOAD IS NOT AN EMPTY LIST.
   *
   * `listLoaded` records that a list request actually SUCCEEDED and `listError`
   * that the most recent one FAILED, because the empty state used to be gated
   * on nothing but `images.length === 0 && !loading`. A refused list request —
   * the deployed API answering `404 Route not found: GET /api/references?
   * draftKey=…` — left `images` empty and `loading` false, so the studio told
   * the administrator "No prepared images yet." *while the error was on
   * screen*. That is a false statement about their data and it invites
   * re-uploading photographs that already exist. The empty state now requires a
   * successful response that CONFIRMED the set is empty, and a failed load
   * offers a Retry instead.
   */
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [queue, setQueue] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [cropId, setCropId] = useState(null);
  const [engine, setEngine] = useState(null);
  const [actionId, setActionId] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragFrom, setDragFrom] = useState(null);
  const inputRef = useRef(null);
  // A separate hidden input (and its own target id) so the browser's file
  // dialog belongs to ONE thumbnail rather than to the drop zone.
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
      // A successful response is the ONLY thing that can truthfully confirm the
      // set is empty, so this is the only place `listLoaded` becomes true.
      setListLoaded(true);
      return payload.images;
    } catch (err) {
      // The request failed: say so. An empty array here is the ABSENCE of an
      // answer, never a confirmed empty set.
      setListError(err.message || 'The prepared images could not be loaded.');
      setListLoaded(false);
      return [];
    } finally {
      setLoading(false);
    }
  }, [scope]);

  /**
   * Retry a refused list request. The error is cleared FIRST so the
   * administrator sees the request being made again, rather than a stale banner
   * sitting on top of the loading state.
   */
  const retryLoad = useCallback(() => {
    setListError('');
    setLoading(true);
    void reload();
  }, [reload]);

  // Initial load.
  useEffect(() => {
    setSelectedId(null);
    setCropId(null);
    reload();
  }, [reload]);

  // Engine description — informational, and never allowed to break the studio.
  useEffect(() => {
    let cancelled = false;
    studio
      .getEngineInfo()
      .then((info) => {
        if (!cancelled) setEngine(info);
      })
      .catch(() => {
        if (!cancelled) setEngine(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll while anything is genuinely in flight. Bounded: a set that somehow
  // never settles stops being polled and is reported (the server also flags a
  // stale PROCESSING row as interrupted, which is what the administrator sees).
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

  // Report acceptance upward (the create-product page sends these ids on save).
  const acceptedIds = useMemo(
    () => images.filter((img) => img.accepted).map((img) => img.id),
    [images]
  );
  const acceptedKey = acceptedIds.join(',');
  useEffect(() => {
    if (onAcceptedChange) onAcceptedChange(acceptedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptedKey]);

  // A FAILED queue entry is history, not work in progress. Counting it as busy
  // would leave the studio permanently "preparing" — and the product form
  // disables Save while the studio is busy — so one rejected file (a corrupt
  // PNG, an unsupported type) would make the product unsavable. The error stays
  // on screen until the next upload; it just stops being in-flight.
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
        if (result.setWarnings?.length) setError('');
        setQueue((q) => q.filter((item) => item.key !== key));
        return true;
      } catch (err) {
        setQueue((q) => q.map((item) => (item.key === key ? { ...item, error: err.message || 'Upload failed.' } : item)));
        return false;
      }
    },
    [scope]
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
        ...entries.map(({ file, key }) => ({ key, name: file.name, progress: 0, error: '' })),
      ]);
      // Sequential on purpose: a phone uploading eight 4 MB photos in parallel
      // would fight for the same uplink and make every progress bar stall.
      for (const { file, key } of entries) {
        // eslint-disable-next-line no-await-in-loop
        await uploadOne(file, key);
      }
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
      setCropId(null);
    }
  };

  const toggleAccept = (image) =>
    withAction(image.id, () => studio.updateReference(image.id, { accepted: !image.accepted }));

  const acceptAllUsable = async () => {
    setActionId('bulk');
    setError('');
    try {
      const usable = images.filter((img) => !img.accepted && img.cutout?.available && img.status !== 'FAILED');
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
   * Replace keeps the SLOT, not just the file: the new upload takes the old
   * image's position, its primary flag and its label, and the old row (and its
   * files) is deleted afterwards. The sequence is deliberate — upload first,
   * delete second — so a failed or rejected upload leaves the existing
   * reference exactly as it was instead of destroying it. The replacement is
   * NOT auto-accepted: it is a different photograph, so it goes through
   * processing and review like any other upload.
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
      // Promote AFTER the delete: removing the old primary already promotes
      // another image, so this is the re-assert of the slot's primary flag.
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

  const applyCrop = (rect) =>
    withAction(cropId, () => studio.reprocessReference(cropId, rect || null));

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
  const cropTarget = images.find((img) => img.id === cropId) || null;
  const revision = selected ? `${selected.status}:${selected.processing?.attempts || 0}:${selected.processing?.finishedAt || ''}` : '';

  if (!scope) {
    return (
      <div className={`text-[12px] text-[var(--color-botanical-subtle)] ${className}`}>
        Preparing the studio… (a product or draft reference is required)
      </div>
    );
  }

  return (
    <div className={`space-y-4 ${className}`} data-testid="reference-studio">
      {/* Engine + intent */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-botanical-subtle)]">
        <span className="inline-flex items-center gap-1">
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          Backgrounds are removed on the server; the original upload is always kept.
        </span>
        {engine && (
          <span data-testid="reference-engine" className="inline-flex items-center gap-1">
            <Info className="w-3.5 h-3.5" aria-hidden="true" />
            {engine.selected === 'rembg'
              ? `Engine: rembg (${engine.model || 'default model'})`
              : 'Engine: built-in segmenter (no ML model installed on this server)'}
          </span>
        )}
      </div>

      {/* Replace picker. Deliberately a SIBLING of the drop zone and not a
          child of it: the drop zone opens the upload dialog on click, so a
          nested file input would open two dialogs at once. */}
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

      {/* Drop zone + file picker */}
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
          dragOver ? 'border-[#964735] bg-[var(--color-surface-low)]' : 'border-[var(--color-border-strong)] hover:border-[var(--color-focus)] hover:bg-[var(--color-surface-low)]/60'
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
          Drop photographs or flyers here, or click to choose several
        </p>
        <p className="text-[11px] text-[var(--color-botanical-subtle)]">
          JPEG, PNG, WebP, GIF or AVIF · up to 5 MB each · {images.length}/{studio.REFERENCE_SET_LIMIT} in this set
        </p>
      </div>

      {/* Upload queue with real progress */}
      {queue.length > 0 && (
        <ul className="space-y-2" aria-live="polite">
          {queue.map((item) => (
            <li key={item.key} className="rounded-lg border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-[var(--color-botanical-muted)]">
                <span className="truncate">{item.name}</span>
                <span>{item.error ? 'Failed' : `${item.progress}%`}</span>
              </div>
              {item.error ? (
                <p className="text-[11px] text-[var(--color-badge-fg-strong)] mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
                  {item.error}
                </p>
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
          Loading prepared images…
        </p>
      )}

      {/* Set-level advice (different products in the set, missing angles…) */}
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

      {/* Thumbnails: original + processed, reorder, primary, accept, remove */}
      {images.length > 0 && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="reference-grid">
          {images.map((image, index) => (
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
                <div className="flex items-center gap-1.5 min-w-0">
                  {image.isPrimary && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-btn)] text-white text-[10px] font-bold uppercase px-1.5 py-0.5">
                      <Star className="w-3 h-3" aria-hidden="true" />
                      Primary
                    </span>
                  )}
                  <StatusBadge status={image.status} stale={image.stale} />
                </div>
                <span className="text-[10px] text-[var(--color-botanical-subtle)] shrink-0">
                  {image.original?.width}×{image.original?.height}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-botanical-subtle)]">Original</p>
                  <AssetPreview imageId={image.id} kind="original" asset={image.original} alt={`Original upload ${index + 1}`} revision={1} className="aspect-square" />
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-botanical-subtle)]">Cutout</p>
                  <AssetPreview
                    imageId={image.id}
                    kind="cutout"
                    asset={image.cutout}
                    alt={`Background removed ${index + 1}`}
                    revision={`${image.status}:${image.processing?.attempts || 0}`}
                    checker
                    className="aspect-square"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedId(selectedId === image.id ? null : image.id)}
                  className="px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)]"
                >
                  {selectedId === image.id ? 'Hide details' : 'Review'}
                </button>
                <button
                  type="button"
                  onClick={() => move(image.id, -1)}
                  disabled={index === 0 || actionId === image.id}
                  aria-label={`Move image ${index + 1} earlier`}
                  className="px-2 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-botanical-muted)] disabled:opacity-30"
                >
                  <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => move(image.id, 1)}
                  disabled={index === images.length - 1 || actionId === image.id}
                  aria-label={`Move image ${index + 1} later`}
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
                <button
                  type="button"
                  onClick={() => toggleAccept(image)}
                  disabled={actionId === image.id || image.status === 'FAILED'}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold disabled:opacity-40 ${
                    image.accepted
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-[var(--color-btn)] text-white hover:bg-[var(--color-btn-hover-alt)]'
                  }`}
                >
                  {image.accepted ? 'Accepted ✓' : 'Accept'}
                </button>
                <button
                  type="button"
                  onClick={() => remove(image)}
                  disabled={actionId === image.id}
                  aria-label={`Remove image ${index + 1}`}
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

              {/* Review panel */}
              {selectedId === image.id && (
                <div className="rounded-lg border border-[var(--color-botanical-border)] p-3 space-y-3" data-testid="reference-detail">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-botanical-subtle)]">Original</p>
                      <AssetPreview imageId={image.id} kind="original" asset={image.original} alt="Original" revision={1} className="aspect-square" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-botanical-subtle)]">Transparent</p>
                      <AssetPreview imageId={image.id} kind="cutout" asset={image.cutout} alt="Transparent cutout" revision={revision} checker className="aspect-square" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-botanical-subtle)]">Neutral</p>
                      <AssetPreview imageId={image.id} kind="neutral" asset={image.neutral} alt="Neutral background preview" revision={revision} className="aspect-square" />
                    </div>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-[var(--color-botanical-muted)]">
                    <dt>Format</dt>
                    <dd className="text-right">{image.original?.format || '—'}</dd>
                    <dt>Dimensions</dt>
                    <dd className="text-right">{image.original?.width}×{image.original?.height}</dd>
                    <dt>Engine</dt>
                    <dd className="text-right">{image.processing?.engine || '—'}</dd>
                    <dt>Confidence</dt>
                    <dd className="text-right">
                      {typeof image.confidence === 'number' ? `${Math.round(image.confidence * 100)}%` : '—'}
                    </dd>
                    <dt>Processing attempts</dt>
                    <dd className="text-right">{image.processing?.attempts || 0}</dd>
                    <dt>Duration</dt>
                    <dd className="text-right">{image.processing?.durationMs ? `${image.processing.durationMs} ms` : '—'}</dd>
                  </dl>

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

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCropId(cropId === image.id ? null : image.id)}
                      className="px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] inline-flex items-center gap-1.5"
                    >
                      <CropIcon className="w-3.5 h-3.5" aria-hidden="true" />
                      {cropId === image.id ? 'Close crop tool' : 'Fix crop'}
                    </button>
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
                      Retry processing
                    </button>
                  </div>

                  {cropId === image.id && (
                    <CropEditor
                      image={image}
                      busy={actionId === image.id}
                      onApply={applyCrop}
                      onCancel={() => setCropId(null)}
                    />
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {images.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-[11px] text-[var(--color-botanical-subtle)] max-w-prose">
            {acceptedIds.length > 0
              ? `${acceptedIds.length} of ${images.length} accepted for 3D preparation.`
              : 'Nothing accepted yet — accept the images you want to keep for 3D preparation.'}
            {draftKey && !productSlug
              ? ' Images you do not accept are discarded when you save the product.'
              : ''}
          </p>
          <button
            type="button"
            onClick={acceptAllUsable}
            disabled={actionId === 'bulk' || images.every((img) => img.accepted)}
            className="px-3.5 py-2 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] disabled:opacity-40 text-white text-[11px] font-semibold inline-flex items-center gap-1.5"
          >
            {actionId === 'bulk' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
            )}
            Accept all processed
          </button>
        </div>
      )}

      {/* The empty state is a CLAIM about the administrator's data, so it is
          shown only after a successful response confirmed the set is empty —
          never while a load is in flight, and never after one just failed. */}
      {images.length === 0 && !loading && listLoaded && !listError && (
        <p className="text-[11px] text-[var(--color-botanical-subtle)] inline-flex items-start gap-1.5">
          <X className="w-3.5 h-3.5 mt-0.5" aria-hidden="true" />
          No prepared images yet. Upload one or more photographs to begin — flyers and photos with busy backgrounds
          are fine.
        </p>
      )}
    </div>
  );
}
