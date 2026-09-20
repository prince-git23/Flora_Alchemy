import React, { useState, useEffect } from 'react';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import AdminSettingsTabs from '../../components/admin/AdminSettingsTabs.jsx';
import { getSettings, updateSettings } from '../../services/settingsService.js';

/**
 * General Settings — unified settings authority (Phase 3D.5, E-01).
 * Reads and writes the backend Settings document via settingsService
 * (PATCH /api/settings → MongoDB). Nothing is reported "saved" until the
 * server confirms. Fields the backend does not support yet are shown as
 * display-only, never faked as persisted.
 */
export default function AdminGeneralSettingsPage() {
  const [settings, setSettings] = useState(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState('idle'); // 'idle' | 'saving' | 'saved'
  const [toastMessage, setToastMessage] = useState(null);

  useEffect(() => {
    setSettings(getSettings());
  }, []);

  const triggerToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3200);
  };

  const handleChange = (field, value) => {
    setSettings((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
    setSaveStatus('idle');
  };

  const handleToggle = (field) => {
    handleChange(field, !settings[field]);
  };

  const handleSave = async () => {
    setSaveStatus('saving');
    try {
      const updated = await updateSettings({
        storeName: settings.storeName,
        storeTagline: settings.storeTagline,
        contactEmail: settings.contactEmail,
        contactPhone: settings.contactPhone,
        timezone: settings.timezone,
        storeAvailability: settings.storeStatus ? 'open' : 'closed',
        acceptNewOrders: !!settings.acceptNewOrders,
        customGiftsEnabled: !!settings.customGiftsEnabled,
      });
      setSettings(updated);
      setIsDirty(false);
      setSaveStatus('saved');
      triggerToast('Store settings saved to the backend.');
      setTimeout(() => setSaveStatus('idle'), 2500);
    } catch (err) {
      setSaveStatus('idle');
      triggerToast(err.message || 'Settings could not be saved. Please try again.');
    }
  };

  const handleDiscard = () => {
    // Reload the server-confirmed values — unsaved local edits are dropped.
    setSettings(getSettings());
    setIsDirty(false);
    setSaveStatus('idle');
    triggerToast('Changes discarded — settings reloaded from the backend.');
  };

  if (!settings) {
    return (
      <AdminLayout>
        <div className="max-w-7xl mx-auto space-y-6 pb-12">
          <div className="h-8 w-40 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-xl border border-[var(--color-botanical-border)] dark:border-[#3a3530] p-6 space-y-4 animate-pulse">
                <div className="h-5 w-1/3 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
                <div className="h-4 w-full bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
                <div className="h-4 w-3/4 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
                <div className="h-10 w-full bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-8 pb-16">
        {/* Page Header & Settings Sub-Nav */}
        <header className="flex flex-col gap-4">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-[13px] text-[#80756f]">
                <span>System</span>
                <span className="text-[#d1c4bd]">/</span>
                <span>Settings</span>
                <span className="text-[#d1c4bd]">/</span>
                <span className="text-[#180f0a] font-semibold">General</span>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <h1 className="font-serif text-3xl sm:text-4xl text-[#180f0a] tracking-tight font-normal">
                  General Settings
                </h1>
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#ffdad3] text-[#783020] text-[11px] font-bold shadow-xs">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#964735] animate-pulse"></span>
                  Live data
                </span>
              </div>

              <p className="text-[15px] text-[#4e4540] max-w-2xl">
                Manage basic store information, public identifiers, and operational availability.
              </p>
            </div>

            {/* Live Status Indicator Card */}
            <div className="flex items-center gap-3 self-start md:self-auto bg-[#f6f3ee] px-4 py-2.5 rounded-2xl shadow-xs border border-[#e5e2dd]">
              <span className={`material-symbols-outlined text-[20px] ${isDirty ? 'text-[#964735]' : 'text-[#5b6d54]'}`}>
                {isDirty ? 'pending' : 'cloud_done'}
              </span>
              <div className="flex flex-col text-left leading-tight">
                <span className="text-[10px] uppercase font-bold tracking-wider text-[#80756f]">Current State</span>
                <span className="text-[13px] font-semibold text-[#180f0a]">
                  {isDirty ? 'Unsaved Changes Pending' : 'Up to date (server)'}
                </span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs */}
          <div className="pt-2">
            <AdminSettingsTabs activeTab="general" />
          </div>
        </header>

        {/* Sticky State Control Banner */}
        <aside className="sticky top-16 z-20 p-4 md:px-6 rounded-2xl bg-white/95 backdrop-blur-md shadow-md border border-[#e5e2dd] flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                isDirty ? 'bg-[#ffdad3] text-[#964735]' : 'bg-[#f6f3ee] text-[#180f0a]'
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">
                {isDirty ? 'pending' : 'verified_user'}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[13px] font-semibold text-[#180f0a]">
                {isDirty ? 'Unsaved changes detected' : 'All changes saved to the store database'}
              </span>
              <span className="text-[12px] text-[#4e4540]">
                {isDirty
                  ? 'You have modified store settings that have not been persisted.'
                  : 'Values are confirmed by the backend.'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <button
              type="button"
              onClick={handleDiscard}
              className="px-4 py-1.5 rounded-full bg-[#f6f3ee] hover:bg-[#ebe8e3] text-[#1c1c19] text-[13px] font-semibold transition-all"
            >
              Discard Changes
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saveStatus === 'saving' || !isDirty}
              className="px-5 py-1.5 rounded-full bg-[#180f0a] hover:bg-[#2e241e] text-white text-[13px] font-semibold shadow-xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
            >
              <span className={`material-symbols-outlined text-[17px] ${saveStatus === 'saving' ? 'animate-spin' : ''}`}>
                {saveStatus === 'saving' ? 'sync' : saveStatus === 'saved' ? 'done_all' : 'save'}
              </span>
              <span>
                {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : 'Save Changes'}
              </span>
            </button>
          </div>
        </aside>

        {/* Card 1: Store Information */}
        <section className="bg-white rounded-2xl p-6 sm:p-8 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] space-y-6">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[#180f0a]">
              <span className="material-symbols-outlined text-[#964735] text-[22px]">storefront</span>
              <h2 className="font-serif text-2xl font-medium">Store Information</h2>
            </div>
            <p className="text-[14px] text-[#4e4540]">
              Manage public brand name, contact details, and customer-facing descriptors.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#80756f]">Store Name</label>
              <input
                type="text"
                value={settings.storeName}
                onChange={(e) => handleChange('storeName', e.target.value)}
                className="w-full bg-[#f6f3ee] focus:bg-white px-4 py-2.5 rounded-xl text-[14px] text-[#1c1c19] border border-transparent focus:border-[#180f0a] focus:outline-none transition-all"
              />
              <span className="text-[12px] text-[#80756f] block">Public brand descriptor.</span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#80756f]">Store Headline &amp; Bio</label>
              <input
                type="text"
                value={settings.storeTagline}
                onChange={(e) => handleChange('storeTagline', e.target.value)}
                className="w-full bg-[#f6f3ee] focus:bg-white px-4 py-2.5 rounded-xl text-[14px] text-[#1c1c19] border border-transparent focus:border-[#180f0a] focus:outline-none transition-all"
              />
              <span className="text-[12px] text-[#80756f] block">Short descriptor used in metadata.</span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#80756f]">Contact Email Address</label>
              <input
                type="email"
                value={settings.contactEmail}
                onChange={(e) => handleChange('contactEmail', e.target.value)}
                className="w-full bg-[#f6f3ee] focus:bg-white px-4 py-2.5 rounded-xl text-[14px] text-[#1c1c19] border border-transparent focus:border-[#180f0a] focus:outline-none transition-all"
              />
              <span className="text-[12px] text-[#80756f] block">Stored in the backend settings document.</span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#80756f]">Support &amp; Handler Telephone</label>
              <input
                type="text"
                value={settings.contactPhone}
                onChange={(e) => handleChange('contactPhone', e.target.value)}
                className="w-full bg-[#f6f3ee] focus:bg-white px-4 py-2.5 rounded-xl text-[14px] text-[#1c1c19] border border-transparent focus:border-[#180f0a] focus:outline-none transition-all"
              />
              <span className="text-[12px] text-[#80756f] block">Stored in the backend settings document.</span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#80756f]">Primary Settlement Currency</label>
              <div className="flex items-center justify-between px-4 py-2.5 bg-[#f0ede9] rounded-xl border border-[#e5e2dd]">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-md bg-[#ffdad3] text-[#783020] text-[11px] font-bold">INR</span>
                  <span className="text-[14px] font-medium text-[#180f0a]">Indian Rupee (INR · ₹)</span>
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#80756f]">Fixed Core Base</span>
              </div>
              <span className="text-[12px] text-[#80756f] block">Settlement lock active.</span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#80756f]">Primary Time Zone</label>
              <div className="relative">
                <select
                  value={settings.timezone}
                  onChange={(e) => handleChange('timezone', e.target.value)}
                  className="w-full bg-[#f6f3ee] focus:bg-white px-4 py-2.5 rounded-xl text-[14px] text-[#1c1c19] border border-transparent focus:border-[#180f0a] focus:outline-none appearance-none cursor-pointer transition-all pr-10"
                >
                  <option value="Asia/Kolkata">Asia/Kolkata (IST - UTC+05:30)</option>
                  <option value="Asia/Dubai">Asia/Dubai (GST - UTC+04:00)</option>
                  <option value="Europe/London">Europe/London (GMT/BST - UTC+00:00)</option>
                  <option value="America/New_York">America/New_York (EST - UTC-05:00)</option>
                </select>
                <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#80756f] text-[20px]">expand_more</span>
              </div>
            </div>
          </div>
        </section>

        {/* Card 2: Store Availability & Fulfillment Gateways */}
        <section className="bg-white rounded-2xl p-6 sm:p-8 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] space-y-6">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[#180f0a]">
              <span className="material-symbols-outlined text-[#964735] text-[22px]">toggle_on</span>
              <h2 className="font-serif text-2xl font-medium">Store Availability &amp; Fulfillment Gateways</h2>
            </div>
            <p className="text-[14px] text-[#4e4540]">
              Control public storefront visibility, checkout authorization, and bespoke inquiry intakes.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Toggle 1: Store Status */}
            <div className="p-4 rounded-2xl bg-[#f6f3ee] flex flex-col justify-between gap-4 border border-[#e5e2dd]/60">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-semibold text-[#180f0a]">Store Status</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${settings.storeStatus ? 'bg-[#ffdad3] text-[#783020]' : 'bg-[#ebe8e3] text-[#4e4540]'}`}>
                    {settings.storeStatus ? 'Open / Active' : 'Closed / Inactive'}
                  </span>
                </div>
                <p className="text-[12px] text-[#4e4540]">When active, customers can browse the storefront.</p>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-[#e5e2dd]/40">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#80756f]">Current State</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.storeStatus}
                  onClick={() => handleToggle('storeStatus')}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${settings.storeStatus ? 'bg-[#180f0a]' : 'bg-[#e5e2dd]'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-xs transition duration-200 ease-in-out mt-1 ${settings.storeStatus ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>

            {/* Toggle 2: Accept New Orders */}
            <div className="p-4 rounded-2xl bg-[#f6f3ee] flex flex-col justify-between gap-4 border border-[#e5e2dd]/60">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-semibold text-[#180f0a]">Accept New Orders</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${settings.acceptNewOrders ? 'bg-[#ffdad3] text-[#783020]' : 'bg-[#ebe8e3] text-[#4e4540]'}`}>
                    {settings.acceptNewOrders ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <p className="text-[12px] text-[#4e4540]">Allow customers to place checkout orders.</p>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-[#e5e2dd]/40">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#80756f]">Current State</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.acceptNewOrders}
                  onClick={() => handleToggle('acceptNewOrders')}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${settings.acceptNewOrders ? 'bg-[#180f0a]' : 'bg-[#e5e2dd]'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-xs transition duration-200 ease-in-out mt-1 ${settings.acceptNewOrders ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>

            {/* Toggle 3: Custom Gift Builder */}
            <div className="p-4 rounded-2xl bg-[#f6f3ee] flex flex-col justify-between gap-4 border border-[#e5e2dd]/60">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-semibold text-[#180f0a]">Custom Gift Builder</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${settings.customGiftsEnabled ? 'bg-[#ffdad3] text-[#783020]' : 'bg-[#ebe8e3] text-[#4e4540]'}`}>
                    {settings.customGiftsEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <p className="text-[12px] text-[#4e4540]">Allow customers to build bespoke gifts in the builder.</p>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-[#e5e2dd]/40">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#80756f]">Current State</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.customGiftsEnabled}
                  onClick={() => handleToggle('customGiftsEnabled')}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${settings.customGiftsEnabled ? 'bg-[#180f0a]' : 'bg-[#e5e2dd]'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-xs transition duration-200 ease-in-out mt-1 ${settings.customGiftsEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Card 3: Regional Standards & Formatting — display-only until backend support */}
        <section className="bg-white rounded-2xl p-6 sm:p-8 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[#e5e2dd] space-y-6">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[#180f0a]">
              <span className="material-symbols-outlined text-[#964735] text-[22px]">public</span>
              <h2 className="font-serif text-2xl font-medium">Regional Standards &amp; Formatting</h2>
            </div>
            <p className="text-[14px] text-[#4e4540]">
              Display-only in this prototype — the backend does not yet persist these formatting preferences,
              so they are not shown as saved.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#80756f]">Currency Display</label>
              <div className="px-4 py-2.5 bg-[#f0ede9] rounded-xl border border-[#e5e2dd] text-[14px] text-[#80756f]">
                INR (₹) — lakh/crore grouping
              </div>
              <span className="text-[12px] text-[#80756f] block">Not yet persisted — display only.</span>
            </div>
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#80756f]">Date &amp; Time Format</label>
              <div className="px-4 py-2.5 bg-[#f0ede9] rounded-xl border border-[#e5e2dd] text-[14px] text-[#80756f]">
                DD MMM YYYY · 12-hour · Week starts Monday
              </div>
              <span className="text-[12px] text-[#80756f] block">Not yet persisted — display only.</span>
            </div>
          </div>

          {/* Governance Notice */}
          <div className="p-4 rounded-xl bg-[#f6f3ee] flex items-start gap-3 mt-4 border border-[#e5e2dd]/60">
            <span className="material-symbols-outlined text-[#80756f] text-[20px] mt-0.5">info</span>
            <p className="text-[13px] text-[#4e4540]">
              <strong className="text-[#180f0a] font-semibold">Honest prototype note:</strong> only fields confirmed by the backend
              (store name, tagline, contacts, timezone, availability, order acceptance, custom gifts, shipping, commerce
              and notification configuration) persist to MongoDB. Regional formatting stays display-only for now.
            </p>
          </div>
        </section>

        {/* Toast Notification */}
        {toastMessage && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 bg-[#180f0a] text-white px-5 py-3 rounded-full shadow-2xl border border-white/10 animate-fade-in">
            <span className="w-2 h-2 rounded-full bg-[#ffdad3]"></span>
            <span className="text-[13px] font-medium tracking-wide">{toastMessage}</span>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}