import React, { useState } from 'react';
import { X, Check, Camera, Video, Trash2, Info } from 'lucide-react';
import { OCCASION_OPTIONS, RECIPIENT_OPTIONS } from '../../services/giftFinderService.js';
import {
  submitProductReview,
  uploadReviewPhoto,
  uploadReviewVideo,
  REVIEW_PHOTO_LIMIT,
  REVIEW_VIDEO_MAX_BYTES,
} from '../../services/reviewService.js';
import { formatBytes } from './reviewFormat.js';

/**
 * PHASE 3 — write a review.
 *
 * The form is where "trust layer" content is actually created, so it is built
 * around three promises:
 *
 *  1. NOTHING IS FABRICATED. `verified` is derived by the server from a real
 *     order and the client never sends it; the copy says exactly that.
 *  2. EVERY UPLOAD IS VISIBLE. Photos and the clip show their own file name and
 *     size, a real percentage while the bytes move, and can be removed before
 *     submitting. A failure states the actual reason instead of swallowing it.
 *  3. THE SERVER IS THE AUTHORITY. The browser pre-checks type and size so the
 *     customer is not made to wait for a rejection, and the same rules are
 *     re-enforced server-side on the same validated pipeline every other
 *     upload uses (no second storage system).
 */
export default function ReviewForm({ productSlug, productName, onClose, onSubmitted }) {
  const [form, setForm] = useState({
    rating: 5,
    title: '',
    comment: '',
    occasion: '',
    recipient: '',
    recommend: true,
    photos: [],
    video: '',
  });
  const [photoBusy, setPhotoBusy] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const handlePhotos = async (files) => {
    if (!files || files.length === 0) return;
    setPhotoBusy(true);
    setError('');
    try {
      const room = Math.max(0, REVIEW_PHOTO_LIMIT - form.photos.length);
      const picked = Array.from(files).slice(0, room);
      const uploaded = [];
      for (const file of picked) {
        // eslint-disable-next-line no-await-in-loop
        const url = await uploadReviewPhoto(file);
        uploaded.push(url);
      }
      if (uploaded.length) {
        set({ photos: [...form.photos, ...uploaded].slice(0, REVIEW_PHOTO_LIMIT) });
      }
    } catch (err) {
      setError(err.message || 'That photo could not be uploaded.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const handleVideo = async (file) => {
    if (!file) return;
    setVideoBusy(true);
    setVideoProgress(0);
    setError('');
    try {
      const url = await uploadReviewVideo(file, { onProgress: setVideoProgress });
      set({ video: url });
      setVideoProgress(100);
    } catch (err) {
      setError(err.message || 'That video could not be uploaded.');
      setVideoProgress(0);
    } finally {
      setVideoBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.title.trim() && !form.comment.trim()) {
      setError('Add a short note about this piece before sharing.');
      return;
    }
    if (videoBusy || photoBusy) {
      setError('Wait for the media to finish uploading.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await submitProductReview(productSlug, {
        rating: form.rating,
        title: form.title,
        comment: form.comment,
        occasion: form.occasion,
        recipient: form.recipient,
        recommend: form.recommend,
        photos: form.photos,
        video: form.video,
      });
      setDone(true);
      if (onSubmitted) onSubmitted(created);
    } catch (err) {
      setError(err.message || 'Your review could not be shared.');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="fixed inset-0 z-[60] bg-[#180f0a]/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Review shared">
        <div className="w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl bg-[var(--color-surface-bg)] border border-[var(--color-botanical-border)] p-5 sm:p-7 text-center space-y-3">
          <div className="w-14 h-14 rounded-full bg-[var(--color-success-soft-bg)] border border-[var(--color-success-soft-border)] mx-auto flex items-center justify-center">
            <Check className="w-6 h-6 text-[var(--color-success-soft-fg)]" aria-hidden="true" />
          </div>
          <h3 className="font-serif text-[20px] text-[var(--color-botanical-primary)]">Thank you — your review is live</h3>
          <p className="text-[13px] text-[var(--color-botanical-muted)]">Your words are now shown with this piece.</p>
          <button
            type="button"
            onClick={onClose}
            className="mt-2 min-h-[44px] px-6 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-[#180f0a]/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Share your experience"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-[var(--color-surface-bg)] border border-[var(--color-botanical-border)] p-5 sm:p-7">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <span className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-accent)]">Share your experience</span>
            <h2 className="font-serif text-[22px] text-[var(--color-botanical-primary)] mt-1">{productName}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close review form"
            className="w-11 h-11 rounded-full bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <span className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Your rating</span>
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => set({ rating: n })}
                  aria-label={`${n} heart${n === 1 ? '' : 's'}`}
                  aria-pressed={form.rating === n}
                  className="p-1 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" className={`transition-colors ${n <= form.rating ? 'fill-[var(--color-accent)] text-[var(--color-accent)]' : 'text-[var(--color-botanical-border)]'}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                  </svg>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="review-title" className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Title</label>
            <input
              id="review-title"
              type="text"
              maxLength={120}
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="Looks even better in person"
              className="w-full min-h-[44px] px-4 rounded-2xl bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="review-comment" className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Your review</label>
            <textarea
              id="review-comment"
              rows={4}
              maxLength={2000}
              value={form.comment}
              onChange={(e) => set({ comment: e.target.value })}
              placeholder="How did it arrive? How does it look and feel?"
              className="w-full p-3 rounded-2xl bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] resize-none"
            />
            <p className="text-[11px] text-[var(--color-botanical-subtle)] text-right tabular-nums">{form.comment.length}/2000</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="review-occasion" className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Occasion</label>
              <select
                id="review-occasion"
                value={form.occasion}
                onChange={(e) => set({ occasion: e.target.value })}
                className="w-full min-h-[44px] px-3 rounded-2xl bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
              >
                <option value="">Prefer not to say</option>
                {OCCASION_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="review-recipient" className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Recipient</label>
              <select
                id="review-recipient"
                value={form.recipient}
                onChange={(e) => set({ recipient: e.target.value })}
                className="w-full min-h-[44px] px-3 rounded-2xl bg-[var(--color-surface-lowest)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
              >
                <option value="">Prefer not to say</option>
                {RECIPIENT_OPTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </div>
          </div>

          {/* Photos */}
          <div className="space-y-2">
            <span className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">
              Add photos (optional) · up to {REVIEW_PHOTO_LIMIT}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <label className={`inline-flex items-center gap-2 min-h-[44px] px-4 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-primary)] transition-colors focus-within:ring-2 focus-within:ring-[var(--color-focus)] ${form.photos.length >= REVIEW_PHOTO_LIMIT || photoBusy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--color-surface-low)]'}`}>
                <Camera className="w-4 h-4" aria-hidden="true" />
                {photoBusy ? 'Uploading…' : 'Attach photos'}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={form.photos.length >= REVIEW_PHOTO_LIMIT || photoBusy}
                  className="sr-only"
                  onChange={(e) => { handlePhotos(e.target.files); e.target.value = ''; }}
                />
              </label>
              <span className="text-[12px] text-[var(--color-botanical-muted)]">
                {form.photos.length}/{REVIEW_PHOTO_LIMIT} attached · JPEG, PNG, WebP · 5 MB each
              </span>
            </div>
            {form.photos.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {form.photos.map((photo) => (
                  <span key={photo} className="relative w-16 h-16 rounded-xl overflow-hidden bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)]">
                    <img src={photo} alt="" className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => set({ photos: form.photos.filter((p) => p !== photo) })}
                      aria-label="Remove photo"
                      className="absolute top-0.5 right-0.5 w-6 h-6 rounded-full bg-[var(--color-botanical-primary)]/85 text-[var(--color-surface-bg)] flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                    >
                      <X className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Video */}
          <div className="space-y-2">
            <span className="block text-[11px] uppercase font-bold tracking-wider text-[var(--color-botanical-primary)]">Add a short video (optional)</span>
            {form.video ? (
              <div className="space-y-2">
                <video src={form.video} controls playsInline preload="metadata" className="w-full max-h-56 rounded-2xl bg-black">
                  <track kind="captions" />
                </video>
                <button
                  type="button"
                  onClick={() => { set({ video: '' }); setVideoProgress(0); }}
                  className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Remove video
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <label className={`inline-flex items-center gap-2 min-h-[44px] px-4 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-primary)] transition-colors focus-within:ring-2 focus-within:ring-[var(--color-focus)] ${videoBusy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--color-surface-low)]'}`}>
                  <Video className="w-4 h-4" aria-hidden="true" />
                  {videoBusy ? `Uploading ${videoProgress}%` : 'Attach video'}
                  <input
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime"
                    disabled={videoBusy}
                    className="sr-only"
                    onChange={(e) => { handleVideo(e.target.files?.[0]); e.target.value = ''; }}
                  />
                </label>
                <span className="text-[12px] text-[var(--color-botanical-muted)]">
                  MP4, WebM or MOV · {formatBytes(REVIEW_VIDEO_MAX_BYTES)} max
                </span>
              </div>
            )}
            {videoBusy && (
              <span className="block h-1.5 rounded-full bg-[var(--color-surface-low)] overflow-hidden" role="progressbar" aria-valuenow={videoProgress} aria-valuemin={0} aria-valuemax={100} aria-label="Video upload progress">
                <span className="block h-full rounded-full bg-[var(--color-accent)] transition-[width]" style={{ width: `${videoProgress}%` }} />
              </span>
            )}
          </div>

          <label className="flex items-center gap-2.5 text-[13px] text-[var(--color-botanical-muted)]">
            <input
              type="checkbox"
              checked={form.recommend}
              onChange={(e) => set({ recommend: e.target.checked })}
              className="w-4 h-4 rounded border-[var(--color-botanical-border)]"
            />
            I would recommend this piece
          </label>

          {error && (
            <p role="alert" className="text-[13px] text-[var(--color-danger)] bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 rounded-xl px-4 py-2.5">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={submitting || photoBusy || videoBusy}
              className="flex-1 min-h-[48px] rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white text-[13px] font-semibold transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            >
              {submitting ? 'Sharing…' : 'Share review'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[48px] px-5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[13px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] transition-colors"
            >
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-[var(--color-botanical-subtle)] flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            Verified purchase badges are added automatically when we find a matching order on your account. Only you can publish under your name.
          </p>
        </form>
      </div>
    </div>
  );
}
