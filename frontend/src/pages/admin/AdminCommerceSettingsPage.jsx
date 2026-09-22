import React, { useState, useEffect } from 'react';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import AdminSettingsTabs from '../../components/admin/AdminSettingsTabs.jsx';
import { getSettings, updateSettings } from '../../services/settingsService.js';

/**
 * Order & Commerce Settings — unified settings authority (Phase 3D.5, E-01).
 * Reads/writes the backend Settings document (shippingConfiguration +
 * commerceConfiguration) via settingsService. Saved only after the server
 * confirms (PATCH /api/settings → MongoDB).
 */
export default function AdminCommerceSettingsPage() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);

  useEffect(() => {
    setSettings(getSettings());
  }, []);

  const triggerToast = (msg) => { setToastMessage(msg); setTimeout(() => setToastMessage(null), 3200); };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateSettings({
        shippingEnabled: settings.shippingEnabled,
        freeShippingAbove: settings.freeShippingAbove,
        standardShippingRate: settings.standardShippingRate,
        expressShippingRate: settings.expressShippingRate,
        paymentMethods: settings.paymentMethods,
        autoConfirmOrders: settings.autoConfirmOrders,
        autoAssignShipping: settings.autoAssignShipping,
        trackingEnabled: settings.trackingEnabled,
        taxEnabled: settings.taxEnabled,
        taxRate: settings.taxRate,
        taxLabel: settings.taxLabel,
        minimumOrderValue: settings.minimumOrderValue,
        maximumOrderItems: settings.maximumOrderItems,
        orderCancellationWindow: settings.orderCancellationWindow,
        returnWindow: settings.returnWindow,
        orderPrefix: settings.orderPrefix,
      });
      setSettings(updated);
      triggerToast('Commerce settings saved to the backend.');
    } catch (err) {
      triggerToast(err.message || 'Commerce settings could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    // Reload server-confirmed values — no local authority to reset to.
    setSettings(getSettings());
    triggerToast('Changes discarded — settings reloaded from the backend.');
  };

  if (!settings) {
    return (
      <AdminLayout>
        <div className="max-w-7xl mx-auto space-y-6 pb-12">
          <div className="h-8 w-48 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-xl border border-[var(--color-botanical-border)] dark:border-[#3a3530] p-6 space-y-4 animate-pulse">
                <div className="h-5 w-1/3 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
                <div className="h-4 w-full bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
                <div className="h-4 w-2/3 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
                <div className="h-10 w-full bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      </AdminLayout>
    );
  }

  const set = (field) => (e) => setSettings(p => ({ ...p, [field]: e.target.type === 'number' ? +e.target.value : e.target.value }));
  const toggle = (key) => setSettings(p => ({ ...p, [key]: !p[key] }));
  const togglePaymentMethod = (key) => setSettings(p => ({ ...p, paymentMethods: { ...p.paymentMethods, [key]: !p.paymentMethods[key] } }));

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-8 pb-12">
        {/* Banner */}
        <div className="relative overflow-hidden rounded-2xl bg-[var(--color-surface-low)] p-6 sm:p-8 shadow-xs border border-[var(--color-botanical-border)]">
          <div className="absolute -right-16 -top-16 w-80 h-80 rounded-full bg-gradient-to-br from-[#ffdad3]/40 via-[#f1dfd5]/30 to-transparent blur-3xl pointer-events-none"></div>
          <div className="relative z-10">
            <div className="flex items-center gap-1.5 text-[13px] text-[var(--color-botanical-subtle)] mb-2">
              <span>System</span><span className="text-[#d1c4bd]">/</span><span>Settings</span><span className="text-[#d1c4bd]">/</span><span className="text-[var(--color-botanical-primary)] font-semibold">Order & Commerce</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Order & Commerce Settings</h1>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] text-[11px] font-bold shadow-xs">
                <span className="h-1.5 w-1.5 rounded-full bg-[#964735]"></span>
                Live data
              </span>
            </div>
            <p className="text-[15px] text-[var(--color-botanical-muted)] mt-1">Configure shipping, payments, and order lifecycle rules. Saved to the backend.</p>
          </div>
          <div className="mt-6 pt-2 border-t border-[var(--color-botanical-border)]/60">
            <AdminSettingsTabs activeTab="commerce" />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Shipping Settings */}
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px]">local_shipping</span> Shipping
            </h2>
            <div className="space-y-3">
              <label className="flex items-center justify-between py-2">
                <span className="text-[13px] text-[var(--color-botanical-muted)]">Enable Pan-India Shipping</span>
                <button type="button" onClick={() => toggle('shippingEnabled')}
                  className={`w-10 h-6 rounded-full transition-colors ${settings.shippingEnabled ? 'bg-[#5b6d54]' : 'bg-[#d1c4bd]'}`}>
                  <span className={`block w-4 h-4 bg-[var(--color-surface-lowest)] rounded-full transition-transform shadow-sm ${settings.shippingEnabled ? 'translate-x-5' : 'translate-x-1'}`}></span>
                </button>
              </label>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1">Free Shipping Above (₹)</label>
                <input type="number" value={settings.freeShippingAbove} onChange={set('freeShippingAbove')}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1">Standard Shipping Rate (₹)</label>
                <input type="number" value={settings.standardShippingRate} onChange={set('standardShippingRate')}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1">Express Shipping Rate (₹)</label>
                <input type="number" value={settings.expressShippingRate} onChange={set('expressShippingRate')}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
            </div>
          </div>

          {/* Payment Methods */}
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px]">payments</span> Payment Methods
            </h2>
            <p className="text-[12px] text-[var(--color-botanical-subtle)]">
              Prototype listing — no real gateway is connected. These preferences are stored so checkout can honor them later.
            </p>
            <div className="space-y-3">
              {Object.entries(settings.paymentMethods).map(([key, enabled]) => (
                <label key={key} className="flex items-center justify-between py-2">
                  <span className="text-[13px] text-[var(--color-botanical-muted)] capitalize">{key === 'upi' ? 'UPI' : key === 'cod' ? 'Cash on Delivery' : key.charAt(0).toUpperCase() + key.slice(1)}</span>
                  <button type="button" onClick={() => togglePaymentMethod(key)}
                    className={`w-10 h-6 rounded-full transition-colors ${enabled ? 'bg-[#5b6d54]' : 'bg-[#d1c4bd]'}`}>
                    <span className={`block w-4 h-4 bg-[var(--color-surface-lowest)] rounded-full transition-transform shadow-sm ${enabled ? 'translate-x-5' : 'translate-x-1'}`}></span>
                  </button>
                </label>
              ))}
            </div>
          </div>

          {/* Order Lifecycle */}
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px]">receipt_long</span> Order Lifecycle
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1">Order Prefix</label>
                <input type="text" value={settings.orderPrefix} onChange={set('orderPrefix')}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1">Cancellation Window (hours)</label>
                <input type="number" value={settings.orderCancellationWindow} onChange={set('orderCancellationWindow')}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1">Return Window (days)</label>
                <input type="number" value={settings.returnWindow} onChange={set('returnWindow')}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1">Minimum Order Value (₹)</label>
                <input type="number" value={settings.minimumOrderValue} onChange={set('minimumOrderValue')}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1">Maximum Items per Order</label>
                <input type="number" value={settings.maximumOrderItems} onChange={set('maximumOrderItems')}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
            </div>
          </div>

          {/* Automation */}
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px]">smart_toy</span> Automation
            </h2>
            <div className="space-y-3">
              <label className="flex items-center justify-between py-2">
                <span className="text-[13px] text-[var(--color-botanical-muted)]">Auto-Confirm Orders</span>
                <button type="button" onClick={() => toggle('autoConfirmOrders')}
                  className={`w-10 h-6 rounded-full transition-colors ${settings.autoConfirmOrders ? 'bg-[#5b6d54]' : 'bg-[#d1c4bd]'}`}>
                  <span className={`block w-4 h-4 bg-[var(--color-surface-lowest)] rounded-full transition-transform shadow-sm ${settings.autoConfirmOrders ? 'translate-x-5' : 'translate-x-1'}`}></span>
                </button>
              </label>
              <label className="flex items-center justify-between py-2">
                <span className="text-[13px] text-[var(--color-botanical-muted)]">Auto-Assign Shipping</span>
                <button type="button" onClick={() => toggle('autoAssignShipping')}
                  className={`w-10 h-6 rounded-full transition-colors ${settings.autoAssignShipping ? 'bg-[#5b6d54]' : 'bg-[#d1c4bd]'}`}>
                  <span className={`block w-4 h-4 bg-[var(--color-surface-lowest)] rounded-full transition-transform shadow-sm ${settings.autoAssignShipping ? 'translate-x-5' : 'translate-x-1'}`}></span>
                </button>
              </label>
              <label className="flex items-center justify-between py-2">
                <span className="text-[13px] text-[var(--color-botanical-muted)]">Order Tracking Enabled</span>
                <button type="button" onClick={() => toggle('trackingEnabled')}
                  className={`w-10 h-6 rounded-full transition-colors ${settings.trackingEnabled ? 'bg-[#5b6d54]' : 'bg-[#d1c4bd]'}`}>
                  <span className={`block w-4 h-4 bg-[var(--color-surface-lowest)] rounded-full transition-transform shadow-sm ${settings.trackingEnabled ? 'translate-x-5' : 'translate-x-1'}`}></span>
                </button>
              </label>
              <div className="pt-1">
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1">Tax Label</label>
                <input type="text" value={settings.taxLabel} onChange={set('taxLabel')}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-between pt-4">
          <button type="button" onClick={handleReset} className="px-5 py-2 text-[13px] font-semibold text-[var(--color-botanical-muted)] bg-[var(--color-surface-lowest)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] rounded-full transition">
            Discard Changes
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="px-6 py-2.5 text-[13px] font-semibold text-white bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] rounded-full transition shadow-sm disabled:opacity-60">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>

        {toastMessage && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 bg-[var(--color-btn)] text-white px-5 py-3 rounded-full shadow-2xl">
            <span className="w-2 h-2 rounded-full bg-[#964735]"></span>
            <span className="text-[13px] font-medium">{toastMessage}</span>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}