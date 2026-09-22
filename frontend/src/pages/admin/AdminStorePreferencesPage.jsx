import React, { useState, useEffect } from 'react';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import AdminSettingsTabs from '../../components/admin/AdminSettingsTabs.jsx';
import { useTheme } from '../../context/ThemeContext.jsx';
import {
  getStorePreferences,
  saveStorePreferences,
  resetStorePreferences
} from '../../services/adminSettings.js';

export default function AdminStorePreferencesPage() {
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const [preferences, setPreferences] = useState(getStorePreferences());
  const [syncStatus, setSyncStatus] = useState('Saved on this device');
  const [saveStatus, setSaveStatus] = useState('idle'); // 'idle' | 'saving' | 'saved'
  const [toastMessage, setToastMessage] = useState(null);

  useEffect(() => {
    setPreferences(getStorePreferences());
  }, []);

  const handleToggle = (key) => {
    setPreferences((prev) => ({
      ...prev,
      [key]: !prev[key]
    }));
    setSyncStatus('Unsaved preferences pending synchronization');
  };

  const handleChange = (key, val) => {
    setPreferences((prev) => ({
      ...prev,
      [key]: val
    }));
    setSyncStatus('Unsaved preferences pending synchronization');
  };

  const handleSave = () => {
    setSaveStatus('saving');
    setSyncStatus('Saving preferences to this browser...');

    setTimeout(() => {
      saveStorePreferences(preferences);
      setSaveStatus('saved');
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setSyncStatus(`Preferences saved to this browser at ${now}`);
      setToastMessage('Preferences saved to this browser (device-local)');

      setTimeout(() => {
        setSaveStatus('idle');
      }, 2000);
    }, 650);
  };

  const handleReset = () => {
    const defaults = resetStorePreferences();
    setPreferences(defaults);
    setSaveStatus('idle');
    setSyncStatus('Reverted to system benchmark defaults');
    setToastMessage('Preferences reverted to system benchmark defaults');

    setTimeout(() => {
      setSyncStatus('Preferences saved to this browser');
    }, 2500);
  };

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-8 pb-20">
        {/* Page Header & Breadcrumb Context */}
        <header className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-[13px] text-[var(--color-botanical-subtle)] dark:text-[#8a8078]">
                <span>System</span>
                <span className="text-[#d1c4bd]">/</span>
                <span>Settings</span>
                <span className="text-[#d1c4bd]">/</span>
                <span className="text-[var(--color-botanical-primary)] font-semibold">Store Preferences</span>
              </div>

              <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-text)] tracking-tight font-normal dark:text-[#f0ede9]">
                Store Preferences
              </h1>
              <p className="text-[15px] text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]">
                Customize operational defaults for the Handler Portal.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)] text-[11px] font-bold shadow-xs">
                <span className="h-1.5 w-1.5 rounded-full bg-[#964735] animate-pulse"></span>
                Live data
              </span>
            </div>
          </div>

          {/* Settings Sub-Navigation Tabs */}
          <div className="pt-2">
            <AdminSettingsTabs activeTab="preferences" />
          </div>
        </header>

        {/* Top Sync Status & Action Strip */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-[var(--color-surface-low)] rounded-xl shadow-[0_2px_12px_rgba(46,36,30,0.03)] border border-[var(--color-botanical-border)] dark:bg-[#222019] dark:border-[#3a3530]">
          <div className="flex items-center gap-2 text-[var(--color-botanical-muted)]">
            <span className={`material-symbols-outlined text-[var(--color-accent)] text-[20px] ${saveStatus === 'saving' ? 'animate-spin' : ''}`}>
              sync
            </span>
            <span className="text-[13px]">{syncStatus}</span>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-auto">
            <button
              type="button"
              onClick={handleReset}
              className="px-4 py-1.5 rounded-full text-[13px] font-semibold text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-high)] transition-all"
            >
              Reset to Defaults
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saveStatus === 'saving'}
              className="inline-flex items-center gap-1.5 px-5 py-1.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-xs hover:bg-[var(--color-btn-hover-alt)] transition-all disabled:opacity-60 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">
                {saveStatus === 'saved' ? 'done_all' : 'check'}
              </span>
              <span>{saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : 'Save Changes'}</span>
            </button>
          </div>
        </div>

        {/* Preferences Settings Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Column (Wide, 7 cols) */}
          <div className="lg:col-span-7 space-y-8">
            {/* 1. Interface & Table Behavior */}
            <div className="bg-[var(--color-surface-lowest)] rounded-2xl p-6 sm:p-8 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[var(--color-botanical-border)] space-y-6 dark:bg-[#1e1b18] dark:border-[#3a3530]">
              <div className="flex items-center justify-between pb-3 border-b border-[var(--color-botanical-border-light)] dark:border-[#2a2520]">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[var(--color-accent)] text-[20px]">table_rows</span>
                  <h2 className="font-serif text-2xl text-[var(--color-botanical-text)] font-medium dark:text-[#f0ede9]">
                    Interface &amp; Table Behavior
                  </h2>
                </div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] dark:text-[#8a8078]">
                  Display Engine
                </span>
              </div>

              <div className="space-y-4 divide-y divide-[var(--color-divider)]">
                {/* Compact Table View */}
                <div className="flex items-center justify-between pt-3">
                  <div className="pr-4">
                    <label
                      htmlFor="toggle-compact"
                      className="text-[14px] font-semibold text-[var(--color-botanical-text)] block cursor-pointer dark:text-[#f0ede9]"
                    >
                      Compact Table View
                    </label>
                    <p className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]">
                      Display tighter row spacing and conceal botanical preview thumbnails.
                    </p>
                  </div>
                  <button
                    id="toggle-compact"
                    type="button"
                    role="switch"
                    aria-checked={preferences.compactTable}
                    onClick={() => handleToggle('compactTable')}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
                      preferences.compactTable ? 'bg-[var(--color-btn)] dark:bg-[#964735]' : 'bg-[#e5e2dd] dark:bg-[#3a3530]'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--color-surface-lowest)] shadow-xs transition duration-200 ease-in-out mt-1 ${
                        preferences.compactTable ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {/* Remember Table Filters & Search */}
                <div className="flex items-center justify-between pt-4">
                  <div className="pr-4">
                    <label
                      htmlFor="toggle-filters"
                      className="text-[14px] font-semibold text-[var(--color-botanical-text)] block cursor-pointer dark:text-[#f0ede9]"
                    >
                      Remember Table Filters &amp; Search
                    </label>
                    <p className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]">
                      Persist active filters, batch statuses, and search parameters across navigation.
                    </p>
                  </div>
                  <button
                    id="toggle-filters"
                    type="button"
                    role="switch"
                    aria-checked={preferences.rememberFilters}
                    onClick={() => handleToggle('rememberFilters')}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
                      preferences.rememberFilters ? 'bg-[var(--color-btn)] dark:bg-[#964735]' : 'bg-[#e5e2dd] dark:bg-[#3a3530]'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--color-surface-lowest)] shadow-xs transition duration-200 ease-in-out mt-1 ${
                        preferences.rememberFilters ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {/* Show Loading Indicators & Skeletons */}
                <div className="flex items-center justify-between pt-4">
                  <div className="pr-4">
                    <label
                      htmlFor="toggle-skeletons"
                      className="text-[14px] font-semibold text-[var(--color-botanical-text)] block cursor-pointer dark:text-[#f0ede9]"
                    >
                      Show Loading Indicators &amp; Skeletons
                    </label>
                    <p className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]">
                      Display smooth skeleton placeholders on background catalogue and inventory fetches.
                    </p>
                  </div>
                  <button
                    id="toggle-skeletons"
                    type="button"
                    role="switch"
                    aria-checked={preferences.showSkeletons}
                    onClick={() => handleToggle('showSkeletons')}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
                      preferences.showSkeletons ? 'bg-[var(--color-btn)] dark:bg-[#964735]' : 'bg-[#e5e2dd] dark:bg-[#3a3530]'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--color-surface-lowest)] shadow-xs transition duration-200 ease-in-out mt-1 ${
                        preferences.showSkeletons ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {/* Confirm Destructive Actions */}
                <div className="flex items-center justify-between pt-4">
                  <div className="pr-4">
                    <label
                      htmlFor="toggle-destructive"
                      className="text-[14px] font-semibold text-[var(--color-botanical-text)] block cursor-pointer dark:text-[#f0ede9]"
                    >
                      Confirm Destructive Actions
                    </label>
                    <p className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]">
                      Require modal dialog verification before batch deletion, archival, or stock removals.
                    </p>
                  </div>
                  <button
                    id="toggle-destructive"
                    type="button"
                    role="switch"
                    aria-checked={preferences.confirmDestructive}
                    onClick={() => handleToggle('confirmDestructive')}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
                      preferences.confirmDestructive ? 'bg-[var(--color-btn)] dark:bg-[#964735]' : 'bg-[#e5e2dd] dark:bg-[#3a3530]'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--color-surface-lowest)] shadow-xs transition duration-200 ease-in-out mt-1 ${
                        preferences.confirmDestructive ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>

            {/* 2. Visual Presentation & Accessibility */}
            <div className="bg-[var(--color-surface-lowest)] rounded-2xl p-6 sm:p-8 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[var(--color-botanical-border)] space-y-6 dark:bg-[#1e1b18] dark:border-[#3a3530]">
              <div className="flex items-center justify-between pb-3 border-b border-[var(--color-botanical-border-light)] dark:border-[#2a2520]">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[var(--color-accent)] text-[20px]">palette</span>
                  <h2 className="font-serif text-2xl text-[var(--color-botanical-text)] font-medium dark:text-[#f0ede9]">
                    Visual Presentation &amp; Accessibility
                  </h2>
                </div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] dark:text-[#8a8078]">
                  Renderer
                </span>
              </div>

              <div className="space-y-6">
                {/* Theme Appearance */}
                <div className="space-y-2">
                  <label className="text-[14px] font-semibold text-[var(--color-botanical-primary)] block">
                    Theme Appearance
                  </label>
                  <div className="grid grid-cols-3 gap-2 bg-[var(--color-surface-low)] p-1.5 rounded-xl border border-[var(--color-botanical-border)]/60 dark:bg-[#222019] dark:border-[#3a3530]/60">
                    <button
                      type="button"
                      onClick={() => { handleChange('themeAppearance', 'light'); setThemeMode('light'); }}
                      className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-[13px] font-semibold transition-all cursor-pointer ${
                        preferences.themeAppearance === 'light'
                          ? 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] shadow-xs dark:bg-[#33302a] dark:text-[#f0ede9]'
                          : 'text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] dark:text-[#b8b0a8] dark:hover:text-[#f0ede9]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">light_mode</span>
                      <span>Light Mode</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => { handleChange('themeAppearance', 'dark'); setThemeMode('dark'); }}
                      className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-[13px] font-semibold transition-all cursor-pointer ${
                        preferences.themeAppearance === 'dark'
                          ? 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] shadow-xs dark:bg-[#33302a] dark:text-[#f0ede9]'
                          : 'text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] dark:text-[#b8b0a8] dark:hover:text-[#f0ede9]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">dark_mode</span>
                      <span>Dark Mode</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => { handleChange('themeAppearance', 'system'); setThemeMode('system'); }}
                      className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-[13px] font-semibold transition-all cursor-pointer ${
                        preferences.themeAppearance === 'system'
                          ? 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] shadow-xs dark:bg-[#33302a] dark:text-[#f0ede9]'
                          : 'text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] dark:text-[#b8b0a8] dark:hover:text-[#f0ede9]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">settings_brightness</span>
                      <span>System</span>
                    </button>
                  </div>
                </div>

                {/* Motion & Transitions */}
                <div className="flex items-center justify-between pt-4 border-t border-[var(--color-botanical-border-light)]">
                  <div className="pr-4">
                    <label
                      htmlFor="toggle-motion"
                      className="text-[14px] font-semibold text-[var(--color-botanical-text)] block cursor-pointer dark:text-[#f0ede9]"
                    >
                      Motion &amp; Transitions
                    </label>
                    <p className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]">
                      Enable smooth drawer easing while respecting hardware reduced-motion flags.
                    </p>
                  </div>
                  <button
                    id="toggle-motion"
                    type="button"
                    role="switch"
                    aria-checked={preferences.motionTransitions}
                    onClick={() => handleToggle('motionTransitions')}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
                      preferences.motionTransitions ? 'bg-[var(--color-btn)] dark:bg-[#964735]' : 'bg-[#e5e2dd] dark:bg-[#3a3530]'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--color-surface-lowest)] shadow-xs transition duration-200 ease-in-out mt-1 ${
                        preferences.motionTransitions ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {/* Information Density */}
                <div className="space-y-2 pt-4 border-t border-[var(--color-botanical-border-light)]">
                  <div className="flex items-center justify-between">
                    <label className="text-[14px] font-semibold text-[var(--color-botanical-primary)] block">
                      Information Density
                    </label>
                    <span className="text-[11px] font-bold text-[var(--color-botanical-subtle)]">Viewport Baseline</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 bg-[var(--color-surface-low)] p-1.5 rounded-xl border border-[var(--color-botanical-border)]/60">
                    <button
                      type="button"
                      onClick={() => handleChange('informationDensity', 'comfortable')}
                      className={`flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px] font-semibold transition-all cursor-pointer ${
                        preferences.informationDensity === 'comfortable'
                          ? 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] shadow-xs'
                          : 'text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">view_agenda</span>
                      <span>Comfortable (Recommended)</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleChange('informationDensity', 'compact')}
                      className={`flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px] font-semibold transition-all cursor-pointer ${
                        preferences.informationDensity === 'compact'
                          ? 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] shadow-xs'
                          : 'text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">density_small</span>
                      <span>Compact</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column (Complementary, 5 cols) */}
          <div className="lg:col-span-5 space-y-8">
            {/* 3. Default Operational Viewports */}
            <div className="bg-[var(--color-surface-lowest)] rounded-2xl p-6 sm:p-8 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[var(--color-botanical-border)] space-y-6 dark:bg-[#1e1b18] dark:border-[#3a3530]">
              <div className="flex items-center justify-between pb-3 border-b border-[var(--color-botanical-border-light)] dark:border-[#2a2520]">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[var(--color-accent)] text-[20px]">view_quilt</span>
                  <h2 className="font-serif text-2xl text-[var(--color-botanical-text)] font-medium dark:text-[#f0ede9]">
                    Default Operational Viewports
                  </h2>
                </div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] dark:text-[#8a8078]">
                  Routing
                </span>
              </div>

              <div className="space-y-4">
                {/* Default Dashboard Date Range */}
                <div className="space-y-1">
                  <label
                    htmlFor="select-date-range"
                    className="text-[13px] font-semibold text-[var(--color-botanical-primary)] block"
                  >
                    Default Dashboard Date Range
                  </label>
                  <div className="relative">
                    <select
                      id="select-date-range"
                      value={preferences.defaultDateRange}
                      onChange={(e) => handleChange('defaultDateRange', e.target.value)}
                      className="w-full appearance-none bg-[var(--color-surface-low)] py-2.5 pl-3 pr-10 rounded-xl text-[13px] text-[var(--color-botanical-text)] focus:outline-none focus:bg-[var(--color-surface-lowest)] border border-transparent focus:border-[var(--color-botanical-text)] cursor-pointer transition-all dark:bg-[#222019] dark:text-[#f0ede9] dark:focus:bg-[#2a2520]"
                    >
                      <option value="7d">Last 7 Days</option>
                      <option value="30d">Last 30 Days</option>
                      <option value="90d">Last 90 Days</option>
                      <option value="1y">This Year</option>
                    </select>
                    <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-botanical-subtle)] pointer-events-none text-[18px]">
                      expand_more
                    </span>
                  </div>
                </div>

                {/* Default Orders Tab */}
                <div className="space-y-1">
                  <label
                    htmlFor="select-orders-tab"
                    className="text-[13px] font-semibold text-[var(--color-botanical-primary)] block"
                  >
                    Default Orders Tab
                  </label>
                  <div className="relative">
                    <select
                      id="select-orders-tab"
                      value={preferences.defaultOrdersTab}
                      onChange={(e) => handleChange('defaultOrdersTab', e.target.value)}
                      className="w-full appearance-none bg-[var(--color-surface-low)] py-2.5 pl-3 pr-10 rounded-xl text-[13px] text-[var(--color-botanical-text)] focus:outline-none focus:bg-[var(--color-surface-lowest)] border border-transparent focus:border-[var(--color-botanical-text)] cursor-pointer transition-all dark:bg-[#222019] dark:text-[#f0ede9] dark:focus:bg-[#2a2520]"
                    >
                      <option value="all">All Orders</option>
                      <option value="confirmed">Confirmed</option>
                      <option value="production">In Production</option>
                      <option value="dispatch">Ready to Dispatch</option>
                    </select>
                    <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-botanical-subtle)] pointer-events-none text-[18px]">
                      expand_more
                    </span>
                  </div>
                </div>

                {/* Default Inventory Filter */}
                <div className="space-y-1">
                  <label
                    htmlFor="select-inventory-filter"
                    className="text-[13px] font-semibold text-[var(--color-botanical-primary)] block"
                  >
                    Default Inventory Filter
                  </label>
                  <div className="relative">
                    <select
                      id="select-inventory-filter"
                      value={preferences.defaultInventoryFilter}
                      onChange={(e) => handleChange('defaultInventoryFilter', e.target.value)}
                      className="w-full appearance-none bg-[var(--color-surface-low)] py-2.5 pl-3 pr-10 rounded-xl text-[13px] text-[var(--color-botanical-text)] focus:outline-none focus:bg-[var(--color-surface-lowest)] border border-transparent focus:border-[var(--color-botanical-text)] cursor-pointer transition-all dark:bg-[#222019] dark:text-[#f0ede9] dark:focus:bg-[#2a2520]"
                    >
                      <option value="all">All Items</option>
                      <option value="in_stock">In Stock</option>
                      <option value="low_stock">Low Stock</option>
                    </select>
                    <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-botanical-subtle)] pointer-events-none text-[18px]">
                      expand_more
                    </span>
                  </div>
                </div>

                {/* Default Analytics Granularity */}
                <div className="space-y-1">
                  <label
                    htmlFor="select-analytics-granularity"
                    className="text-[13px] font-semibold text-[var(--color-botanical-primary)] block"
                  >
                    Default Analytics Granularity
                  </label>
                  <div className="relative">
                    <select
                      id="select-analytics-granularity"
                      value={preferences.defaultAnalyticsGranularity}
                      onChange={(e) => handleChange('defaultAnalyticsGranularity', e.target.value)}
                      className="w-full appearance-none bg-[var(--color-surface-low)] py-2.5 pl-3 pr-10 rounded-xl text-[13px] text-[var(--color-botanical-text)] focus:outline-none focus:bg-[var(--color-surface-lowest)] border border-transparent focus:border-[var(--color-botanical-text)] cursor-pointer transition-all dark:bg-[#222019] dark:text-[#f0ede9] dark:focus:bg-[#2a2520]"
                    >
                      <option value="daily">Daily Breakdown</option>
                      <option value="weekly">Weekly Aggregation</option>
                      <option value="monthly">Monthly Overview</option>
                    </select>
                    <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-botanical-subtle)] pointer-events-none text-[18px]">
                      expand_more
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* 4. Sample Data & Governance */}
            <div className="bg-[var(--color-surface-lowest)] rounded-2xl p-6 sm:p-8 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[var(--color-botanical-border)] space-y-6">
              <div className="flex items-center justify-between pb-3 border-b border-[var(--color-botanical-border-light)]">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[var(--color-accent)] text-[20px]">shield</span>
                  <h2 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium">
                    Sample Data &amp; Governance
                  </h2>
                </div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                  Audit
                </span>
              </div>

              <div className="space-y-4 divide-y divide-[var(--color-divider)]">
                {/* Environment Badges (Mandatory) */}
                <div className="flex items-center justify-between pt-2">
                  <div className="pr-4">
                    <span className="text-[14px] font-semibold text-[var(--color-botanical-primary)] block">
                      Environment Badges
                    </span>
                    <span className="text-[13px] text-[var(--color-botanical-subtle)]">
                      Mandatory across all portal screens
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled
                    className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-not-allowed rounded-full bg-[var(--color-btn)] opacity-60"
                  >
                    <span className="translate-x-6 inline-block h-4 w-4 transform rounded-full bg-[var(--color-surface-lowest)] shadow-xs mt-1" />
                  </button>
                </div>

                {/* Confirm Data Changes */}
                <div className="flex items-center justify-between pt-4">
                  <div className="pr-4">
                    <label
                      htmlFor="toggle-confirm-changes"
                      className="text-[14px] font-semibold text-[var(--color-botanical-text)] block cursor-pointer dark:text-[#f0ede9]"
                    >
                      Confirm Data Changes
                    </label>
                    <span className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]">
                      Prompt before updating demonstration records
                    </span>
                  </div>
                  <button
                    id="toggle-confirm-changes"
                    type="button"
                    role="switch"
                    aria-checked={preferences.confirmDataChanges}
                    onClick={() => handleToggle('confirmDataChanges')}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
                      preferences.confirmDataChanges ? 'bg-[var(--color-btn)] dark:bg-[#964735]' : 'bg-[#e5e2dd] dark:bg-[#3a3530]'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--color-surface-lowest)] shadow-xs transition duration-200 ease-in-out mt-1 ${
                        preferences.confirmDataChanges ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {/* Activity Log Feedback */}
                <div className="flex items-center justify-between pt-4">
                  <div className="pr-4">
                    <label
                      htmlFor="toggle-ledger-toast"
                      className="text-[14px] font-semibold text-[var(--color-botanical-text)] block cursor-pointer dark:text-[#f0ede9]"
                    >
                      Activity Log Feedback
                    </label>
                    <span className="text-[13px] text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]">
                      Display instant toast notice on ledger edits
                    </span>
                  </div>
                  <button
                    id="toggle-ledger-toast"
                    type="button"
                    role="switch"
                    aria-checked={preferences.activityLogFeedback}
                    onClick={() => handleToggle('activityLogFeedback')}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
                      preferences.activityLogFeedback ? 'bg-[var(--color-btn)] dark:bg-[#964735]' : 'bg-[#e5e2dd] dark:bg-[#3a3530]'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--color-surface-lowest)] shadow-xs transition duration-200 ease-in-out mt-1 ${
                        preferences.activityLogFeedback ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>

            {/* Informational Card */}
            <div className="p-4 rounded-2xl bg-[var(--color-surface-low)] flex items-start gap-3 shadow-xs border border-[var(--color-botanical-border)]">
              <span className="material-symbols-outlined text-[var(--color-accent)] text-[20px] shrink-0 mt-0.5">
                info
              </span>
              <div className="space-y-1">
                <h3 className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">Client-Side Persistence</h3>
                <p className="text-[13px] text-[var(--color-botanical-muted)]">
                  Preferences configured here apply to the sample environment demonstration. Resetting defaults will revert views to standard defaults.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Sticky Bottom Save Action Bar */}
        <div className="sticky bottom-4 z-20 w-full p-3.5 bg-[var(--color-surface-lowest)]/95 backdrop-blur-md rounded-2xl shadow-[0_12px_32px_-4px_rgba(46,36,30,0.1)] border border-[var(--color-botanical-border)] flex flex-wrap items-center justify-between gap-3 dark:bg-[#1e1b18]/95 dark:border-[#3a3530]">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[#1d2918]"></span>
            <span className="text-[13px] text-[var(--color-botanical-muted)]">
              Sample configuration • Prototype demonstration
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReset}
              className="px-4 py-2 rounded-full text-[13px] font-semibold text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-all"
            >
              Reset to System Defaults
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saveStatus === 'saving'}
              className="inline-flex items-center gap-2 px-6 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-xs hover:bg-[var(--color-btn-hover-alt)] transition-all disabled:opacity-60 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[18px]">
                {saveStatus === 'saved' ? 'done_all' : 'save'}
              </span>
              <span>{saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : 'Save Preferences'}</span>
            </button>
          </div>
        </div>

        {/* Toast Notification */}
        {toastMessage && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 bg-[var(--color-btn)] text-white px-5 py-3 rounded-full shadow-2xl border border-white/10 animate-fade-in">
            <span className="w-2 h-2 rounded-full bg-[var(--color-badge-bg)]"></span>
            <span className="text-[13px] font-medium tracking-wide">{toastMessage}</span>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
