import React, { useEffect, useRef, useState } from 'react';
import { X, Check, Mail, Phone, User as UserIcon } from 'lucide-react';
import { updateCustomer } from '../../services/customerService.js';
import { useStore } from '../../context/StoreContext.jsx';

/**
 * EDIT PROFILE — a focused sheet, not a settings screen.
 *
 * Only the fields the backend actually accepts are editable. Email is the
 * sign-in identity and the server deliberately refuses to change it here, so it
 * is shown read-only rather than faked locally. Nothing is persisted until the
 * server confirms — no optimistic write, no fake success.
 */
export default function EditProfileModal({ open, onClose, profile, customerId, onSaved }) {
  const { showToast } = useStore();
  const [form, setForm] = useState({ name: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setForm({
      name: (profile && profile.name) || '',
      phone: (profile && profile.phone) || '',
    });
    setError('');
  }, [open, profile]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || form.name.trim().length < 2) {
      setError('Please provide your full name.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updated = await updateCustomer(customerId, {
        name: form.name.trim(),
        phone: form.phone.trim(),
      });
      showToast('Profile updated');
      onSaved(updated);
      onClose();
    } catch (err) {
      // Honest failure — the field keeps the customer's input so nothing is lost.
      setError(err.message || 'Profile could not be updated. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const email = (profile && profile.email) || '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 sm:px-6 py-8 bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-profile-title"
        tabIndex={-1}
        className="w-full max-w-lg bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] shadow-xl overflow-hidden outline-none"
      >
        <div className="flex items-start justify-between gap-4 px-6 sm:px-8 pt-6 sm:pt-8">
          <div>
            <span className="block text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
              Your details
            </span>
            <h2
              id="edit-profile-title"
              className="font-serif text-[24px] text-[var(--color-botanical-primary)] leading-tight"
            >
              Edit profile
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-full flex items-center justify-center text-[var(--color-botanical-subtle)] hover:bg-[var(--color-surface-low)] hover:text-[var(--color-botanical-primary)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 sm:px-8 py-6 space-y-5" noValidate>
          <div>
            <label
              htmlFor="account-name"
              className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5"
            >
              Full Name
            </label>
            <div className="relative">
              <input
                id="account-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
              />
              <UserIcon className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
            </div>
          </div>

          <div>
            <label
              htmlFor="account-email"
              className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5"
            >
              Email Address
            </label>
            <div className="relative">
              <input
                id="account-email"
                type="email"
                value={email}
                readOnly
                aria-readonly="true"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[var(--color-surface-container)] text-[14px] text-[var(--color-botanical-subtle)] border border-[var(--color-botanical-border)] cursor-not-allowed"
              />
              <Mail className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
            </div>
            <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1.5">
              Your email is your sign-in identity and can’t be changed here.
            </p>
          </div>

          <div>
            <label
              htmlFor="account-phone"
              className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5"
            >
              Phone Number
            </label>
            <div className="relative">
              <input
                id="account-phone"
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="Optional"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
              />
              <Phone className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
            </div>
          </div>

          {error && (
            <p role="alert" className="text-[13px] text-[var(--color-danger-soft-fg)] bg-[var(--color-danger-soft-bg)] rounded-xl px-4 py-2.5">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-50"
            >
              <Check className="w-4 h-4" />
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
