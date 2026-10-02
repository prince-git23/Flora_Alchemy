import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { submitApplication } from '../services/adminApplicationService.js';

/**
 * Phase 20.6.6 — PUBLIC administrator application (/apply/admin).
 *
 * The storefront's intake door for the owner→admin lifecycle: an applicant
 * files a dossier, the OWNER reviews it, and only an owner approval can
 * mint the one-time invitation. This screen therefore:
 *   · offers NO role selector, no privileged field, no login — the server
 *     never reads a client-supplied role/status/userId anyway
 *   · states honestly that submitting creates NO account and grants NO
 *     access (that happens only through the invitation the owner issues)
 *   · mirrors the server's validation rules so errors are instant, while
 *     still branching on the REAL server verdict (409 duplicate, 429 rate
 *     limit, network failure) instead of pretending
 *   · shows the application id on success — the reference the owner sees
 *     too — and never implies approval is guaranteed
 *
 * Phase 22.4 — BUSINESS IDENTITY: the applicant now supplies the future
 * workspace identity: `businessName` (required — the workspace display
 * name) and `preferredSlug` (optional — the proposed workspace address).
 * Neither is privileged: no Workspace exists at intake time; the server
 * derives `proposedSlug` (business name → fallback), rejects reserved or
 * taken addresses (409 SLUG_TAKEN), and the OWNER can still adjust the
 * approved slug before the invitation goes out. Client validation mirrors
 * the server's `validateWorkspaceSlug` rules so errors are instant, but
 * the final verdict is always the server's (SLUG_TAKEN surfaces here).
 *
 * Client states: idle → submitting → success | validation | server-error |
 * rate-limited. No session is attached to the request (anonymous scope).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Mirrors backend/utils/workspaceSlug.js SLUG_RE (2–63 chars, a-z0-9-, bounded ends). */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

const FIELDS = [
  { key: 'name', label: 'Full name', type: 'text', autoComplete: 'name', placeholder: 'Ananya Iyer' },
  { key: 'email', label: 'Work email', type: 'email', autoComplete: 'email', placeholder: 'you@studio.com' },
  { key: 'phone', label: 'Phone (optional)', type: 'tel', autoComplete: 'tel', placeholder: '+91 …' },
];

function validate(form) {
  const errors = {};
  if (form.name.trim().length < 2) errors.name = 'Please provide your full name.';
  if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Please provide a valid work email address.';
  if (form.phone.trim() && form.phone.trim().replace(/\D/g, '').length > 15) {
    errors.phone = 'Please provide a valid phone number.';
  }
  if (form.businessName.trim().length < 2) {
    errors.businessName = 'Please provide your business name (the shop identity).';
  }
  if (form.businessName.trim().length > 120) {
    errors.businessName = 'Business name must be 120 characters or fewer.';
  }
  if (form.preferredSlug.trim() && !SLUG_RE.test(form.preferredSlug.trim().toLowerCase())) {
    errors.preferredSlug =
      'Use 2–63 lowercase letters, numbers or hyphens (letters/numbers at both ends).';
  }
  if (form.reason.trim().length < 10) {
    errors.reason = 'Please tell us why you want to join (at least 10 characters).';
  }
  if (form.background.trim().length < 10) {
    errors.background = 'Please describe your professional background (at least 10 characters).';
  }
  return errors;
}

const inputClass =
  'w-full px-4 py-3 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)] transition-shadow duration-200 placeholder:text-[var(--color-botanical-subtle)]';

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-[12px] font-medium text-[var(--color-danger)]">
      {message}
    </p>
  );
}

export default function AdminApplyPage() {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    businessName: '',
    preferredSlug: '',
    reason: '',
    background: '',
  });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [errorTone, setErrorTone] = useState('error'); // error | info
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);

  const set = (key) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setFormError('');
    const clientErrors = validate(form);
    if (Object.values(clientErrors).some(Boolean)) {
      setErrors(clientErrors);
      return;
    }
    setSubmitting(true);
    try {
      const res = await submitApplication({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        businessName: form.businessName.trim(),
        preferredSlug: form.preferredSlug.trim().toLowerCase(),
        reason: form.reason.trim(),
        background: form.background.trim(),
      });
      if (res.ok && res.application) {
        setDone(res.application);
        return;
      }
      if (res.code === 'SLUG_TAKEN') {
        // The proposed workspace address is already in use — anchor to the
        // slug field so the applicant can retry with another one.
        setErrorTone('error');
        setErrors({ preferredSlug: res.message || 'That workspace address is already taken.' });
        setFormError(res.message || 'That workspace address is already taken.');
      } else if (res.status === 409) {
        // Duplicate intake is information, not a failure — say it kindly.
        setErrorTone('info');
        setFormError(res.message || 'You already have an application awaiting review.');
      } else if (res.status === 429) {
        setErrorTone('info');
        setFormError('Too many attempts from this device. Please wait a few minutes and try again.');
      } else if (res.status === 422) {
        setErrorTone('error');
        setFormError(res.message || 'Please review the highlighted fields.');
      } else if (res.status === 0) {
        setErrorTone('error');
        setFormError('We could not reach the studio server. Please check your connection and try again.');
      } else {
        setErrorTone('error');
        setFormError(res.message || 'Something went wrong submitting your application. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-[70vh] py-10 sm:py-14 relative overflow-hidden">
      <div className="absolute -top-20 -right-20 w-96 h-96 rounded-full bg-[var(--color-badge-bg)]/10 blur-3xl pointer-events-none" />
      <div className="absolute top-1/3 -left-24 w-80 h-80 rounded-full bg-[var(--color-botanical-sage-light)]/10 blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-2xl mx-auto px-4 sm:px-6">
        {/* ── Header ── */}
        <header className="mb-8 pb-4 border-b border-[var(--color-botanical-border)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#2e241e] text-[#f1dfd5] flex items-center justify-center font-serif text-[22px] italic leading-none">
              fa
            </div>
            <Link
              to="/"
              className="text-[18px] leading-[26px] font-semibold tracking-tight text-[var(--color-botanical-text)]"
            >
              Flora Alchemy
            </Link>
            <span className="text-[var(--color-botanical-subtle)] text-[13px]">/</span>
            <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-muted)]">
              Administrator Application
            </span>
          </div>
          <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-[var(--color-botanical-muted)]">
            <span className="w-2 h-2 rounded-full bg-[var(--color-botanical-sage)] animate-pulse" aria-hidden="true" />
            Owner-reviewed intake
          </span>
        </header>

        {done ? (
          /* ── Success: real application id, honest expectations ── */
          <div
            data-apply-state="success"
            className="bg-[var(--color-surface-lowest)] rounded-3xl p-8 sm:p-10 border border-[var(--color-botanical-border)] shadow-lg text-center space-y-4"
          >
            <span className="inline-flex w-14 h-14 rounded-full bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] items-center justify-center mx-auto">
              <span className="material-symbols-outlined text-[28px]">task_alt</span>
            </span>
            <h1 className="font-serif text-[30px] leading-9 tracking-[-0.01em] text-[var(--color-botanical-primary)]">
              Application received
            </h1>
            <div className="flex items-center justify-center">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--color-surface-high)] text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-botanical-sage)]" aria-hidden="true" />
                Under review
              </span>
            </div>
            <p className="text-[15px] leading-6 font-semibold text-[var(--color-botanical-text)] max-w-md mx-auto">
              Your application has been received and is under review.
            </p>
            <p className="text-[14px] leading-6 text-[var(--color-botanical-muted)] max-w-md mx-auto">
              Thank you, {done.name?.split(' ')[0] || 'friend'}. The owner reviews every submission
              personally and will decide on your dossier — any outcome reaches you at{' '}
              <span className="font-semibold text-[var(--color-botanical-text)]">{done.email}</span>.
            </p>
            <div className="inline-flex flex-col items-center gap-1 px-5 py-3 rounded-2xl bg-[var(--color-surface-container)] border border-[var(--color-botanical-border)]">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                Application ID — keep this for reference
              </span>
              <span className="font-mono text-[15px] font-semibold text-[var(--color-botanical-text)]">
                {done.applicationId}
              </span>
            </div>
            {done.businessName ? (
              <div className="inline-flex flex-col items-center gap-1 px-5 py-3 rounded-2xl bg-[var(--color-surface-container)] border border-[var(--color-botanical-border)]">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                  Proposed workspace
                </span>
                <span className="text-[14px] font-semibold text-[var(--color-botanical-text)]">
                  {done.businessName}
                </span>
                {done.proposedSlug ? (
                  <span className="font-mono text-[12px] text-[var(--color-botanical-muted)]">
                    /shops/{done.proposedSlug}
                  </span>
                ) : null}
                {/* Honest about provenance: a derived address was not chosen by
                    the applicant, and the owner still confirms the final one. */}
                {done.slugAutoGenerated ? (
                  <span className="text-[11px] leading-4 text-[var(--color-botanical-subtle)] max-w-[240px]">
                    Generated from your business name — the owner confirms the final address.
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* Wording is deliberately exact: this page confirms RECEIPT and
                nothing else. It must not imply approval, and the invitation's
                expiry belongs to the approval context — stating it here would
                describe a decision that has not been made. */}
            <div className="w-full max-w-md mx-auto pt-1 border-t border-[var(--color-botanical-border)]" />
            <p className="text-[12px] leading-5 text-[var(--color-botanical-subtle)] max-w-md mx-auto">
              This form created a review record only — no account, no password and no portal access
              exist yet. Neither this confirmation nor the application ID means your application has
              been approved: access is granted only through a one-time invitation the owner issues
              after reviewing this dossier.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <Link
                to="/"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] text-white px-6 py-3 text-[13px] font-semibold shadow-md hover:bg-[var(--color-btn-hover)] transition-all active:translate-y-px"
              >
                <span className="material-symbols-outlined text-[18px]">storefront</span>
                Back to the Storefront
              </Link>
            </div>
          </div>
        ) : (
          <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-6 sm:p-10 border border-[var(--color-botanical-border)] shadow-lg space-y-6">
            <div className="text-center space-y-2">
              <span className="inline-flex items-center gap-2 bg-[var(--color-surface-high)] px-3.5 py-1 rounded-full">
                <span className="material-symbols-outlined text-[15px] text-[var(--color-accent)]" style={{ fontVariationSettings: "'FILL' 1" }}>
                  local_florist
                </span>
                <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--color-accent)]">
                  Staff Provisioning
                </span>
              </span>
              <h1 className="font-serif text-[32px] leading-10 tracking-[-0.01em] text-[var(--color-botanical-primary)]">
                Apply to Join the Console
              </h1>
              <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] max-w-lg mx-auto">
                Tell us who you are and why you belong in the atelier&rsquo;s operations console. Every
                application is read by the owner — there is no automatic approval.
              </p>
            </div>

            {/* Honest security framing — what this form does NOT do. */}
            <div className="flex items-start gap-3 p-4 rounded-xl bg-[var(--color-surface-container)] border border-[var(--color-botanical-border)]">
              <span className="material-symbols-outlined text-[20px] text-[var(--color-accent)] mt-0.5">shield</span>
              <p className="text-[12px] leading-relaxed text-[var(--color-botanical-muted)]">
                Submitting files an application record only — it never creates an account, password or
                login. Access is granted solely through a one-time invitation that the owner issues
                after approving this dossier.
              </p>
            </div>

            {formError && (
              <div
                role="alert"
                data-apply-state={errorTone === 'info' ? 'duplicate' : 'server-error'}
                className={`p-4 rounded-xl text-[13px] leading-relaxed border ${
                  errorTone === 'info'
                    ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] border-[#edd1cc]'
                    : 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] border-[var(--color-danger-soft-border)]'
                }`}
              >
                {formError}
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {FIELDS.map((field, idx) => (
                  <div key={field.key} className={idx === 2 ? 'sm:col-span-2' : ''}>
                    <label
                      htmlFor={`apply-${field.key}`}
                      className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)] mb-1.5"
                    >
                      {field.label}
                    </label>
                    <input
                      id={`apply-${field.key}`}
                      name={field.key}
                      type={field.type}
                      autoComplete={field.autoComplete}
                      maxLength={field.key === 'name' ? 100 : field.key === 'email' ? 200 : 30}
                      value={form[field.key]}
                      onChange={set(field.key)}
                      placeholder={field.placeholder}
                      aria-invalid={errors[field.key] ? 'true' : undefined}
                      aria-describedby={errors[field.key] ? `apply-${field.key}-error` : undefined}
                      className={inputClass}
                    />
                    <FieldError id={`apply-${field.key}-error`} message={errors[field.key]} />
                  </div>
                ))}
              </div>

              {/* ── Business identity (Phase 22.4): the future workspace ── */}
              <div className="pt-4 border-t border-[var(--color-botanical-border)] space-y-4">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-accent)]">storefront</span>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)]">
                    Your business — future workspace
                  </span>
                </div>
                <div>
                  <label
                    htmlFor="apply-businessName"
                    className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)] mb-1.5"
                  >
                    Business name *
                  </label>
                  <input
                    id="apply-businessName"
                    name="businessName"
                    type="text"
                    autoComplete="organization"
                    maxLength={120}
                    value={form.businessName}
                    onChange={set('businessName')}
                    placeholder="Petal & Preserv"
                    aria-invalid={errors.businessName ? 'true' : undefined}
                    aria-describedby={errors.businessName ? 'apply-businessName-error' : undefined}
                    className={inputClass}
                  />
                  <FieldError id="apply-businessName-error" message={errors.businessName} />
                </div>
                <div>
                  <label
                    htmlFor="apply-preferredSlug"
                    className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)] mb-1.5"
                  >
                    Preferred shop address (optional)
                  </label>
                  <div className="flex items-center gap-0">
                    <span className="inline-flex items-center h-[46px] px-3 rounded-l-xl bg-[var(--color-surface-container)] border border-r-0 border-[var(--color-botanical-border)] text-[13px] text-[var(--color-botanical-subtle)] font-mono">
                      /shops/
                    </span>
                    <input
                      id="apply-preferredSlug"
                      name="preferredSlug"
                      type="text"
                      maxLength={63}
                      value={form.preferredSlug}
                      onChange={set('preferredSlug')}
                      placeholder="petal-and-preserv"
                      aria-invalid={errors.preferredSlug ? 'true' : undefined}
                      aria-describedby={
                        errors.preferredSlug
                          ? 'apply-preferredSlug-error'
                          : 'apply-preferredSlug-hint'
                      }
                      className={`${inputClass} rounded-l-none font-mono lowercase`}
                    />
                  </div>
                  <p
                    id="apply-preferredSlug-hint"
                    className="mt-1.5 text-[11px] leading-4 text-[var(--color-botanical-subtle)]"
                  >
                    Lowercase letters, numbers and hyphens. Leave blank and we&rsquo;ll derive one
                    from your business name; the owner confirms the final address before your
                    invitation is issued.
                  </p>
                  <FieldError id="apply-preferredSlug-error" message={errors.preferredSlug} />
                </div>
              </div>

              <div>
                <label
                  htmlFor="apply-reason"
                  className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)] mb-1.5"
                >
                  Why do you want to join?
                </label>
                <textarea
                  id="apply-reason"
                  name="reason"
                  rows={3}
                  maxLength={2000}
                  value={form.reason}
                  onChange={set('reason')}
                  placeholder="What draws you to stewarding the operations of a botanical keepsakes atelier?"
                  aria-invalid={errors.reason ? 'true' : undefined}
                  aria-describedby={errors.reason ? 'apply-reason-error' : undefined}
                  className={`${inputClass} resize-y min-h-[96px]`}
                />
                <div className="flex items-start justify-between gap-3">
                  <FieldError id="apply-reason-error" message={errors.reason} />
                  <span className="text-[11px] text-[var(--color-botanical-subtle)] ml-auto shrink-0 mt-1.5">
                    {form.reason.length}/2000
                  </span>
                </div>
              </div>

              <div>
                <label
                  htmlFor="apply-background"
                  className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)] mb-1.5"
                >
                  Professional background
                </label>
                <textarea
                  id="apply-background"
                  name="background"
                  rows={4}
                  maxLength={2000}
                  value={form.background}
                  onChange={set('background')}
                  placeholder="Operations, retail, fulfilment, studio management — whatever qualifies you to run this console."
                  aria-invalid={errors.background ? 'true' : undefined}
                  aria-describedby={errors.background ? 'apply-background-error' : undefined}
                  className={`${inputClass} resize-y min-h-[112px]`}
                />
                <div className="flex items-start justify-between gap-3">
                  <FieldError id="apply-background-error" message={errors.background} />
                  <span className="text-[11px] text-[var(--color-botanical-subtle)] ml-auto shrink-0 mt-1.5">
                    {form.background.length}/2000
                  </span>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] text-white px-8 py-3.5 text-[14px] font-semibold shadow-md hover:bg-[var(--color-btn-hover)] transition-all active:translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {submitting ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden="true" />
                    Submitting…
                  </>
                ) : (
                  <>
                    Submit Application
                    <span className="material-symbols-outlined text-[19px]">arrow_forward</span>
                  </>
                )}
              </button>

              <p className="text-center text-[12px] text-[var(--color-botanical-subtle)]">
                Already part of the team?{' '}
                <Link
                  to="/admin/login"
                  className="inline-flex items-center min-h-[26px] px-0.5 font-semibold text-[var(--color-accent)] hover:underline"
                >
                  Sign in to the portal
                </Link>
              </p>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
