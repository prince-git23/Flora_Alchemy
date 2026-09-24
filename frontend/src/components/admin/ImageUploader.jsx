import React, { useRef, useState, useCallback } from 'react';
import { UploadCloud, X, AlertCircle, Loader2, ImageIcon } from 'lucide-react';
import { ADMIN_TOKEN_KEY } from '../../services/apiClient.js';

// Construct the upload endpoint from the same base URL the apiClient uses,
// so the request always hits the real backend — not the Vercel frontend
// (which would return index.html and cause "unexpected server response").
const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:4000/api').replace(/\/$/, '');

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — matches backend limit
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/**
 * ImageUploader — real file upload for the admin product form.
 *
 * Flow: file picked/dropped → validated client-side → POST multipart to
 * /api/uploads/product-image → server stores it (ImageKit when credentials
 * exist, local disk otherwise) → hosted URL returned → parent form keeps the
 * URL on the product document. Upload failures surface honestly with retry;
 * nothing pretends to be saved when the request failed.
 */
export default function ImageUploader({ images, onChange }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);

  const list = Array.isArray(images) ? images : images ? [images] : [];

  const uploadFile = useCallback(async (file, attempt = 1) => {
    setError('');
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Unsupported format. Use JPEG, PNG, WebP, GIF or AVIF.');
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError('Image is too large. Maximum is 5 MB.');
      return;
    }

    setUploading(true);
    setProgress(0);

    const doUpload = () => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/uploads/product-image`);
      xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem(ADMIN_TOKEN_KEY) || ''}`);
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener('load', () => {
        try {
          const json = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && json.success) {
            resolve(json);
          } else {
            reject(new Error(json.message || `Upload failed (${xhr.status}).`));
          }
        } catch {
          reject(new Error('Upload failed — unexpected server response.'));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during upload.')));
      xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
      const fd = new FormData();
      fd.append('image', file);
      xhr.send(fd);
    });

    try {
      const json = await doUpload();
      onChange([...list, json.url]);
    } catch (err) {
      // One automatic retry on transient network failures; then honest error.
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 800));
        return uploadFile(file, attempt + 1);
      }
      setError(err.message || 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }, [list, onChange]);

  const handleFiles = (fileList) => {
    const file = fileList && fileList[0];
    if (file) uploadFile(file);
  };

  const removeImage = (idx) => {
    onChange(list.filter((_, i) => i !== idx));
  };

  const moveImage = (idx, dir) => {
    const next = [...list];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  };

  const addUrl = () => {
    const url = urlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) {
      setError('URL must start with http(s):// or / for local assets.');
      return;
    }
    onChange([...list, url]);
    setUrlInput('');
    setShowUrlInput(false);
    setError('');
  };

  return (
    <div className="space-y-3">
      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload product image"
        onClick={() => !uploading && inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!uploading) handleFiles(e.dataTransfer.files);
        }}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)] ${
          dragOver ? 'border-[#964735] bg-[var(--color-surface-low)]' : 'border-[var(--color-border-strong)] hover:border-[var(--color-focus)] hover:bg-[var(--color-surface-low)]/60'
        } ${uploading ? 'pointer-events-none opacity-70' : ''}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED_TYPES.join(',')}
          className="hidden"
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
        />
        {uploading ? (
          <div className="space-y-2">
            <Loader2 className="w-6 h-6 text-[var(--color-accent)] animate-spin mx-auto" aria-hidden="true" />
            <p className="text-[12px] font-semibold text-[var(--color-botanical-muted)]">Uploading… {progress}%</p>
            <div className="max-w-xs mx-auto h-1.5 rounded-full bg-[#e5e2dd] overflow-hidden">
              <div className="h-full bg-[#964735] transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <UploadCloud className="w-6 h-6 text-[var(--color-botanical-subtle)] mx-auto" aria-hidden="true" />
            <p className="text-[12px] font-semibold text-[var(--color-botanical-muted)]">
              Click to upload or drag &amp; drop
            </p>
            <p className="text-[11px] text-[var(--color-botanical-subtle)]">JPEG, PNG, WebP, GIF or AVIF · up to 5 MB</p>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-[var(--color-badge-bg)]/60 text-[var(--color-badge-fg-strong)] text-[12px] font-medium">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      {/* Image list with preview / replace / reorder / remove */}
      {list.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
          {list.map((img, idx) => (
            <div key={`${img}-${idx}`} className="relative group">
              <div className="aspect-square rounded-xl overflow-hidden border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)]">
                {img ? (
                  <img
                    loading="lazy"
                    decoding="async"
                    src={img}
                    alt={`Product image ${idx + 1}`}
                    className="w-full h-full object-cover"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : (
                  // Phase 20.4 — an empty slot must not render src="": React
                  // warns and the browser re-requests the whole page.
                  <span className="w-full h-full flex items-center justify-center text-[11px] text-[var(--color-botanical-subtle)]" aria-hidden="true">No image</span>
                )}
              </div>
              {idx === 0 && (
                <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-[var(--color-btn)] text-white text-[9px] font-bold uppercase">
                  Primary
                </span>
              )}
              <button
                type="button"
                onClick={() => removeImage(idx)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-[var(--color-surface-lowest)]/95 shadow flex items-center justify-center text-[var(--color-danger)] hover:bg-[#ffdad6] transition-colors"
                aria-label={`Remove image ${idx + 1}`}
                title="Remove image"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <div className="absolute bottom-1 left-1 right-1 flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={() => moveImage(idx, -1)}
                  disabled={idx === 0}
                  className="px-1.5 py-0.5 rounded bg-[var(--color-surface-lowest)]/95 text-[11px] font-bold disabled:opacity-30"
                  aria-label="Move image left"
                >
                  ←
                </button>
                <button
                  type="button"
                  onClick={() => moveImage(idx, 1)}
                  disabled={idx === list.length - 1}
                  className="px-1.5 py-0.5 rounded bg-[var(--color-surface-lowest)]/95 text-[11px] font-bold disabled:opacity-30"
                  aria-label="Move image right"
                >
                  →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Advanced: direct URL fallback */}
      <div>
        {showUrlInput ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://… or /assets/images/…"
              className="flex-1 text-[12px] bg-[var(--color-surface-low)] border border-[var(--color-border-strong)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:border-[var(--color-focus)] focus:ring-1 focus:ring-[var(--color-focus)]"
            />
            <button type="button" onClick={addUrl} className="px-3 py-2 rounded-lg bg-[var(--color-btn)] text-white text-[11px] font-semibold">
              Add
            </button>
            <button type="button" onClick={() => { setShowUrlInput(false); setUrlInput(''); }} className="px-3 py-2 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-semibold text-[var(--color-botanical-muted)]">
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowUrlInput(true)}
            className="text-[11px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] inline-flex items-center gap-1"
          >
            <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
            Add image by URL instead
          </button>
        )}
      </div>
    </div>
  );
}
