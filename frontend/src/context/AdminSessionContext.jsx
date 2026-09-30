import React, { createContext, useContext, useState, useEffect } from 'react';
import { adminLogin, adminLogout, getAdminSession, refreshAdminSession } from '../services/authService.js';
import { signalDataChanged } from '../services/dataStore.js';

const AdminSessionContext = createContext(null);

export function AdminSessionProvider({ children }) {
  const [session, setSession] = useState(() => getAdminSession());

  // Session hardening: a 401 from the backend clears the admin session
  // state immediately (markers are removed by apiClient).
  useEffect(() => {
    const onExpired = (e) => {
      if (e && e.detail && e.detail.scope === 'admin') {
        setSession(null);
        signalDataChanged('auth');
      }
    };
    window.addEventListener('fa:auth-expired', onExpired);
    return () => window.removeEventListener('fa:auth-expired', onExpired);
  }, []);

  /**
   * Phase 21.1 — `portal` identifies which portal is being entered
   * ('owner' | 'admin' | 'staff'). The server validates the identity against it
   * and returns the server-derived portal on the session.
   */
  const login = async (email, password, portal) => {
    const result = await adminLogin(email, password, portal);
    if (result.success) {
      setSession(result.session);
      // Session scope changed → full re-hydration with admin data (Phase 17
      // request audit: plain route navigation no longer re-hydrates, so
      // auth transitions must signal explicitly). 'auth' scope lets the
      // DataProvider re-show the bootstrap loader legitimately.
      signalDataChanged('auth');
    }
    return result;
  };

  const logout = () => {
    adminLogout();
    setSession(null);
    signalDataChanged('auth');
  };

  /**
   * Re-read the server identity (role, status, workspace, effective
   * permissions). The portal calls this when a staff shell mounts so the
   * navigation reflects the CURRENT access — a permission removed five minutes
   * ago disappears from the sidebar without a re-login, and the backend refuses
   * the call anyway if the account was suspended in the meantime.
   */
  const refresh = async () => {
    const next = await refreshAdminSession();
    if (next) setSession(next);
    return next;
  };

  const isAuthenticated = session !== null;

  return (
    <AdminSessionContext.Provider value={{ session, isAuthenticated, login, logout, refresh }}>
      {children}
    </AdminSessionContext.Provider>
  );
}

export function useAdminSession() {
  const context = useContext(AdminSessionContext);
  if (!context) {
    throw new Error('useAdminSession must be used within AdminSessionProvider');
  }
  return context;
}
