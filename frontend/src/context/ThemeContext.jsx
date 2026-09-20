import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';

const STORAGE_KEY = 'flora_alchemy_theme';
const VALID_MODES = ['light', 'dark', 'system'];

function getInitialMode() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_MODES.includes(stored)) return stored;
  } catch {}
  return 'light';
}

function getSystemPreference() {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveEffective(mode) {
  return mode === 'system' ? getSystemPreference() : mode;
}

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(getInitialMode);
  const [effective, setEffective] = useState(() => resolveEffective(getInitialMode()));

  // Apply theme class to <html>
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(effective);
    root.setAttribute('data-theme', effective);
  }, [effective]);

  // Listen for OS preference changes when in system mode
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => setEffective(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  const setMode = useCallback((newMode) => {
    if (!VALID_MODES.includes(newMode)) return;
    setModeState(newMode);
    try { localStorage.setItem(STORAGE_KEY, newMode); } catch {}
    setEffective(resolveEffective(newMode));
  }, []);

  const isDark = effective === 'dark';

  const value = useMemo(() => ({
    mode,
    effective,
    isDark,
    setMode,
  }), [mode, effective, isDark, setMode]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
