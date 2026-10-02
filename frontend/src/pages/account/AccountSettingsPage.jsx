import React, { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { MapPin, Plus, Pencil, Trash2, Star, Mail, Phone, User as UserIcon, ShieldCheck, LogOut, Check } from 'lucide-react';
import EditProfileModal from './EditProfileModal.jsx';
import { addAddress, updateAddress, deleteAddress } from '../../services/customerService.js';
import { useStore } from '../../context/StoreContext.jsx';

const EMPTY_ADDRESS = {
  label: 'Home',
  name: '',
  address: '',
  city: '',
  state: '',
  pincode: '',
  phone: '',
  isDefault: false,
};

/**
 * ACCOUNT SETTINGS — only what a customer actually owns.
 *
 * Three quiet groups: profile details, the shipping address book, and security.
 * The address book is the SAME record the backend owns (embedded on the
 * customer), so a change here is what checkout pre-fills later. There is no
 * workspace, role or platform concept anywhere on this page.
 */
export default function AccountSettingsPage() {
  const { profile, account, reload, signOut } = useOutletContext();
  const { showToast } = useStore();

  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState(null); // null | 'new' | id
  const [form, setForm] = useState(EMPTY_ADDRESS);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const name = (profile && profile.name) || (account && account.name) || '';
  const email = (profile && profile.email) || (account && account.email) || '';
  const phone = (profile && profile.phone) || '';
  const addresses = (profile && profile.addresses) || [];
  const customerId = (profile && (profile.id || profile._id)) || (account && account.customerId) || null;

  const startAdd = () => {
    setForm(EMPTY_ADDRESS);
    setFormError('');
    setEditingId('new');
  };

  const startEdit = (addr) => {
    setForm({
      label: addr.label || 'Home',
      name: addr.name || '',
      address: addr.address || '',
      city: addr.city || '',
      state: addr.state || '',
      pincode: addr.pincode || '',
      phone: addr.phone || '',
      isDefault: !!addr.isDefault,
    });
    setFormError('');
    setEditingId(addr._id || addr.id);
  };

  const cancel = () => {
    setEditingId(null);
    setForm(EMPTY_ADDRESS);
    setFormError('');
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (editingId === 'new') await addAddress(form);
      else await updateAddress(editingId, form);
      await reload();
      showToast(editingId === 'new' ? 'Address saved' : 'Address updated');
      cancel();
    } catch (err) {
      setFormError(err.message || 'Address could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (addr) => {
    const id = addr._id || addr.id;
    setBusyId(id);
    try {
      await updateAddress(id, { isDefault: true });
      await reload();
      showToast('Default address updated');
    } catch (err) {
      showToast(err.message || 'Could not set the default address.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (addr) => {
    const id = addr._id || addr.id;
    setBusyId(id);
    try {
      await deleteAddress(id);
      await reload();
      if (editingId === id) cancel();
      showToast('Address removed');
    } catch (err) {
      showToast(err.message || 'Could not remove the address.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-10">
      <div className="space-y-1">
        <span className="block text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
          Your preferences
        </span>
        <h2 className="font-serif text-[26px] sm:text-[30px] text-[var(--color-botanical-primary)] font-normal tracking-tight">
          Account Settings
        </h2>
      </div>

      {/* ── Profile details ─────────────────────────────────────────── */}
      <section className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h3 className="font-serif text-[19px] text-[var(--color-botanical-primary)]">Profile details</h3>
            <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-0.5">
              These details prefill your checkout.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors shrink-0"
          >
            Edit profile
          </button>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <DetailRow icon={UserIcon} label="Full name" value={name || '—'} />
          <DetailRow icon={Mail} label="Email" value={email || '—'} />
          <DetailRow icon={Phone} label="Phone" value={phone || 'Not added'} />
        </dl>
      </section>

      {/* ── Address book ────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-serif text-[19px] text-[var(--color-botanical-primary)]">Addresses</h3>
            <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-0.5">
              Where your blooms are delivered. The default address pre-fills checkout.
            </p>
          </div>
          {editingId !== 'new' && (
            <button
              type="button"
              onClick={startAdd}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors shrink-0"
            >
              <Plus className="w-4 h-4" /> Add address
            </button>
          )}
        </div>

        {editingId === 'new' && (
          <AddressForm
            form={form}
            setForm={setForm}
            onSave={handleSave}
            onCancel={cancel}
            saving={saving}
            error={formError}
          />
        )}

        {addresses.length === 0 && editingId !== 'new' ? (
          <div className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center">
              <MapPin className="w-5 h-5 text-[var(--color-accent)]" />
            </div>
            <p className="font-serif text-[18px] text-[var(--color-botanical-primary)] mt-3">
              No saved addresses yet
            </p>
            <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-1">
              Add a delivery address so checkout can prefill it for you.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {addresses.map((addr) => {
              const id = addr._id || addr.id;
              const isEditing = editingId === id;
              return (
                <li
                  key={id}
                  className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-5 shadow-xs"
                >
                  {isEditing ? (
                    <AddressForm
                      form={form}
                      setForm={setForm}
                      onSave={handleSave}
                      onCancel={cancel}
                      saving={saving}
                      error={formError}
                      embedded
                    />
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
                          <MapPin className="w-3.5 h-3.5" />
                          {addr.label || 'Address'}
                        </span>
                        {addr.isDefault && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-badge-fg)] text-[10px] font-bold uppercase tracking-wider">
                            <Star className="w-3 h-3" /> Default
                          </span>
                        )}
                      </div>
                      <div className="text-[13px] text-[var(--color-botanical-muted)] leading-relaxed">
                        {addr.name && <p className="text-[var(--color-botanical-primary)] font-semibold">{addr.name}</p>}
                        {addr.address && <p>{addr.address}</p>}
                        <p>{[addr.city, addr.state, addr.pincode].filter(Boolean).join(', ')}</p>
                        {addr.phone && <p className="text-[var(--color-botanical-subtle)]">{addr.phone}</p>}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {!addr.isDefault && (
                          <button
                            type="button"
                            disabled={busyId === id}
                            onClick={() => handleSetDefault(addr)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors disabled:opacity-50"
                          >
                            <Star className="w-3.5 h-3.5" /> Set default
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => startEdit(addr)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </button>
                        <button
                          type="button"
                          disabled={busyId === id}
                          onClick={() => handleDelete(addr)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-subtle)] hover:text-[var(--color-danger)] transition-colors disabled:opacity-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Security ────────────────────────────────────────────────── */}
      <section className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6 sm:p-7">
        <h3 className="font-serif text-[19px] text-[var(--color-botanical-primary)]">Security</h3>
        <div className="mt-4 flex items-start gap-3">
          <span className="w-9 h-9 rounded-full bg-[var(--color-surface-low)] flex items-center justify-center shrink-0">
            <ShieldCheck className="w-4 h-4 text-[var(--color-accent)]" />
          </span>
          <div className="text-[13px] text-[var(--color-botanical-muted)] leading-relaxed">
            <p className="text-[var(--color-botanical-primary)] font-semibold">Signed in as {email}</p>
            <p className="mt-0.5">
              Your email is your sign-in identity. To change it or your password, please contact the
              studio — we keep account security in one place.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={signOut}
          className="mt-5 inline-flex items-center gap-2 px-6 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors"
        >
          <LogOut className="w-4 h-4" /> Sign out
        </button>
      </section>

      <EditProfileModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        profile={profile}
        customerId={customerId}
        onSaved={reload}
      />
    </div>
  );
}

function DetailRow({ icon: Icon, label, value }) {
  return (
    <div className="rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] px-4 py-3">
      <dt className="flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">
        <Icon className="w-3.5 h-3.5" /> {label}
      </dt>
      <dd className="text-[14px] text-[var(--color-botanical-primary)] mt-1 break-words">{value}</dd>
    </div>
  );
}

function AddressForm({ form, setForm, onSave, onCancel, saving, error, embedded = false }) {
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const inputClass =
    'w-full px-3.5 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]';
  const labelClass = 'block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5';

  return (
    <form
      onSubmit={onSave}
      noValidate
      className={
        embedded
          ? 'space-y-4'
          : 'bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6 sm:p-7 space-y-4'
      }
    >
      {!embedded && (
        <h4 className="font-serif text-[18px] text-[var(--color-botanical-primary)]">New address</h4>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass} htmlFor="addr-label">Label</label>
          <input id="addr-label" className={inputClass} value={form.label} onChange={set('label')} placeholder="Home" />
        </div>
        <div>
          <label className={labelClass} htmlFor="addr-name">Recipient name</label>
          <input id="addr-name" className={inputClass} value={form.name} onChange={set('name')} />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="addr-street">Street address</label>
        <input id="addr-street" className={inputClass} value={form.address} onChange={set('address')} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className={labelClass} htmlFor="addr-city">City</label>
          <input id="addr-city" className={inputClass} value={form.city} onChange={set('city')} />
        </div>
        <div>
          <label className={labelClass} htmlFor="addr-state">State</label>
          <input id="addr-state" className={inputClass} value={form.state} onChange={set('state')} />
        </div>
        <div>
          <label className={labelClass} htmlFor="addr-pincode">Postal code</label>
          <input id="addr-pincode" className={inputClass} value={form.pincode} onChange={set('pincode')} inputMode="numeric" />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="addr-phone">Phone</label>
        <input id="addr-phone" className={inputClass} value={form.phone} onChange={set('phone')} />
      </div>
      <label className="flex items-center gap-2 text-[13px] text-[var(--color-botanical-muted)]">
        <input
          type="checkbox"
          checked={!!form.isDefault}
          onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
          className="w-4 h-4 rounded border-[var(--color-botanical-border)]"
        />
        Make this my default address
      </label>

      {error && (
        <p role="alert" className="text-[13px] text-[var(--color-danger-soft-fg)] bg-[var(--color-danger-soft-bg)] rounded-xl px-4 py-2.5">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-50"
        >
          <Check className="w-4 h-4" /> {saving ? 'Saving…' : 'Save address'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-5 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
