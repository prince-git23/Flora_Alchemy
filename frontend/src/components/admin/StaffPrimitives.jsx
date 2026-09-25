import React, { useEffect } from 'react';

/**
 * StaffPrimitives — Phase 20.6.3 / 20.6.4 shared staff-console building blocks.
 *
 * Extracted so the directory, the dossier, the invitation ledger, the add
 * drawer and the handler dashboard all render the SAME status vocabulary,
 * avatars, empty states, skeletons, toasts and modals instead of each page
 * re-implementing (and slowly diverging from) them.
 *
 * Design language is inherited, not restated: the Flora Alchemy surface ramp,
 * Newsreader headings, Plus Jakarta Sans UI text, Material Symbols icons,
 * rounded-full actions and the warm terracotta accent all come from the
 * existing theme tokens in index.css.
 */

// ── Status vocabulary ──────────────────────────────────────────────────────

const STATUS_META = {
  ACTIVE: { label: 'Active', icon: 'check_circle', dot: 'bg-[var(--color-botanical-sage)]' },
  INVITED: { label: 'Invited', icon: 'outgoing_mail', dot: 'bg-[var(--color-accent)]' },
  ACCEPTED: { label: 'Accepted', icon: 'check_circle', dot: 'bg-[var(--color-botanical-sage)]' },
  SUSPENDED: { label: 'Suspended', icon: 'block', dot: 'bg-[var(--color-danger)]' },
  REVOKED: { label: 'Revoked', icon: 'undo', dot: 'bg-[var(--color-botanical-subtle)]' },
  EXPIRED: { label: 'Expired', icon: 'timer_off', dot: 'bg-[var(--color-botanical-subtle)]' },
  // Phase 20.6.6 — administrator application lifecycle (AdminApplication).
  SUBMITTED: { label: 'Submitted', icon: 'draft', dot: 'bg-[var(--color-accent)]' },
  PENDING_REVIEW: { label: 'In Review', icon: 'rate_review', dot: 'bg-[var(--color-accent)]' },
  APPROVED: { label: 'Approved', icon: 'check_circle', dot: 'bg-[var(--color-botanical-sage)]' },
  REJECTED: { label: 'Rejected', icon: 'cancel', dot: 'bg-[var(--color-danger)]' },
  ACTIVATED: { label: 'Activated', icon: 'verified_user', dot: 'bg-[var(--color-botanical-sage)]' },
};

/** Application statuses share the staff pill's tint branches. */
const SUCCESS_TINT = ['ACTIVE', 'ACCEPTED', 'APPROVED', 'ACTIVATED'];
const DANGER_TINT = ['SUSPENDED', 'REJECTED'];
const BADGE_TINT = ['INVITED', 'SUBMITTED', 'PENDING_REVIEW'];

/**
 * StaffStatusPill — icon + label + tint so state is never colour-only
 * (same contract as the existing AdminStatusPill for orders).
 */
export function StaffStatusPill({ status, className = '' }) {
  const meta = STATUS_META[status] || {
    label: status || 'Unknown',
    icon: 'help',
    dot: 'bg-[var(--color-botanical-subtle)]',
  };
  const tint = SUCCESS_TINT.includes(status)
    ? 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)]'
    : DANGER_TINT.includes(status)
      ? 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)]'
      : BADGE_TINT.includes(status)
        ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]'
        : 'bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)]';

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${tint} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

/** Role badge — OWNER / ADMINISTRATOR / HANDLER, never colour-only. */
export function StaffRoleBadge({ roleBadge, className = '' }) {
  const tint =
    roleBadge === 'OWNER'
      ? 'bg-[var(--color-btn)] text-white'
      : roleBadge === 'ADMINISTRATOR'
        ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]'
        : 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)]';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${tint} ${className}`}
    >
      {roleBadge || 'STAFF'}
    </span>
  );
}

/** Avatar — initials only; the backend supplies them, nothing is invented. */
export function StaffAvatar({ initials, size = 40, tone = 'primary', radius = 'full', className = '' }) {
  const tones = {
    primary: 'bg-[var(--color-btn)] text-white',
    accent: 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]',
    muted: 'bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)]',
    danger: 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)]',
    sage: 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)]',
  };
  return (
    <span
      className={`inline-flex items-center justify-center font-semibold shrink-0 ${tones[tone] || tones.primary} ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, Math.round(size * 0.34)),
        // Explicit radius rather than two competing Tailwind classes, whose
        // precedence depends on generated stylesheet order.
        borderRadius: radius === 'full' ? '9999px' : radius === 'lg' ? '16px' : '12px',
      }}
      aria-hidden="true"
    >
      {initials || 'FA'}
    </span>
  );
}

// ── States ─────────────────────────────────────────────────────────────────

export function StaffEmptyState({ icon = 'inbox', title, description, action = null }) {
  return (
    <div className="flex flex-col items-center text-center py-14 px-6">
      <span className="w-14 h-14 rounded-2xl bg-[var(--color-surface-container)] flex items-center justify-center mb-4">
        <span className="material-symbols-outlined text-[26px] text-[var(--color-botanical-subtle)]">{icon}</span>
      </span>
      <h3 className="font-serif text-[20px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">{title}</h3>
      {description && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-botanical-muted)] max-w-md">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Table skeleton — matches the real table's geometry so nothing jumps. */
export function StaffTableSkeleton({ rows = 5 }) {
  return (
    <div className="p-4 space-y-3" role="status" aria-live="polite" aria-label="Loading staff">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-full bg-[var(--color-surface-high)] animate-pulse shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-40 rounded bg-[var(--color-surface-high)] animate-pulse" />
            <div className="h-3 w-24 rounded bg-[var(--color-surface-container)] animate-pulse" />
          </div>
          <div className="hidden sm:block h-6 w-20 rounded-full bg-[var(--color-surface-container)] animate-pulse" />
          <div className="hidden md:block h-6 w-16 rounded-full bg-[var(--color-surface-container)] animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/** Card skeleton for the dossier panel. */
export function StaffCardSkeleton({ lines = 4 }) {
  return (
    <div className="p-6 space-y-4" role="status" aria-live="polite" aria-label="Loading details">
      <div className="flex items-center gap-3">
        <div className="w-14 h-14 rounded-2xl bg-[var(--color-surface-high)] animate-pulse" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-36 rounded bg-[var(--color-surface-high)] animate-pulse" />
          <div className="h-3 w-24 rounded bg-[var(--color-surface-container)] animate-pulse" />
        </div>
      </div>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-3.5 rounded bg-[var(--color-surface-container)] animate-pulse" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

// ── Feedback ───────────────────────────────────────────────────────────────

/**
 * AdminToast — bottom-right inline feedback (the established pattern on the
 * existing access page). Announced politely for assistive tech and dismissible
 * because success messages must never block the next action.
 */
export function AdminToast({ toast, onDismiss, className = '' }) {
  useEffect(() => {
    if (!toast) return undefined;
    if (toast.persist) return undefined;
    const t = setTimeout(() => onDismiss?.(), toast.duration || 5000);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  if (!toast) return null;
  const isError = toast.tone === 'error';
  const isInfo = toast.tone === 'info';

  return (
    <div
      className={`fixed bottom-5 right-5 z-[60] max-w-sm w-[calc(100vw-2.5rem)] sm:w-auto ${className}`}
      role="status"
      aria-live="polite"
    >
      <div
        className={`flex items-start gap-2.5 px-4 py-3 rounded-2xl shadow-[0_12px_32px_-6px_rgba(46,36,30,0.28)] border ${
          isError
            ? 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] border-[var(--color-danger-soft-border)]'
            : isInfo
              ? 'bg-[var(--color-surface-container)] text-[var(--color-botanical-text)] border-[var(--color-botanical-border)] dark:bg-[#2e2a25] dark:text-[#f0ede9] dark:border-[#3a3530]'
              : 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] border-[var(--color-success-soft-border)]'
        }`}
      >
        <span className="material-symbols-outlined text-[19px] shrink-0 mt-0.5">
          {isError ? 'error' : isInfo ? 'info' : 'check_circle'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug">{toast.title}</p>
          {toast.message && <p className="text-[12px] leading-snug mt-0.5 opacity-90 break-words">{toast.message}</p>}
          {toast.action}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 -my-2 -mr-1 min-h-[44px] min-w-[44px] flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity"
          aria-label="Dismiss notification"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────

/**
 * AdminModal — centred dialog with a real backdrop, Escape handling and a
 * body scroll lock (same behaviour as the mobile sidebar drawer). Renders
 * nothing when closed so it cannot trap focus invisibly.
 */
export function AdminModal({ open, onClose, children, labelledBy, className = '' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 bg-[#180f0a]/45 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-[var(--color-surface-lowest)] shadow-[0_20px_50px_-8px_rgba(46,36,30,0.35)] pb-[env(safe-area-inset-bottom)] sm:pb-0 dark:bg-[#1f1c19] ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/** Small labelled field row used by the dossier metadata grid. */
export function MetaField({ label, value, icon, mono = false, className = '' }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] mb-0.5">
        {label}
      </span>
      <span
        className={`flex items-center gap-1.5 text-[13px] text-[var(--color-botanical-text)] dark:text-[#f0ede9] ${
          mono ? 'font-mono' : ''
        }`}
      >
        {icon && <span className="material-symbols-outlined text-[15px] text-[var(--color-botanical-subtle)] shrink-0">{icon}</span>}
        <span className="min-w-0 truncate">{value || '—'}</span>
      </span>
    </div>
  );
}

/** Primary/secondary action button in the established Flora Alchemy shape. */
export function StaffButton({
  children,
  icon,
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  ...rest
}) {
  const variants = {
    primary:
      'bg-[var(--color-btn)] text-white hover:bg-[var(--color-btn-hover-alt)] shadow-sm disabled:opacity-60',
    secondary:
      'bg-[var(--color-surface-container)] text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-high)] dark:bg-[#2e2a25] dark:text-[#f0ede9] dark:hover:bg-[#37332c]',
    danger:
      'bg-[var(--color-danger)] text-white hover:opacity-90 shadow-sm disabled:opacity-60',
    dangerSoft:
      'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] hover:bg-[#ffcdc7] dark:bg-[#ba1a1a]/15 dark:text-[#f0b9a8]',
    ghost:
      'bg-transparent text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-container)] hover:text-[var(--color-botanical-text)]',
  };
  const sizes = {
    sm: 'px-3 py-1.5 text-[12px] min-h-[44px] md:min-h-0',
    md: 'px-4 py-2.5 text-[13px]',
    lg: 'px-6 py-3 text-[13px]',
  };
  return (
    <button
      type="button"
      disabled={loading || rest.disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-all active:translate-y-[1px] disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {loading ? (
        <span className="material-symbols-outlined text-[17px] animate-spin">progress_activity</span>
      ) : (
        icon && <span className="material-symbols-outlined text-[17px]">{icon}</span>
      )}
      {children}
    </button>
  );
}
