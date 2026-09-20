import React, { createContext, useContext, useState, useEffect } from 'react';
import { adminLogin, adminLogout, getAdminSession } from '../services/authService.js';
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

  const login = async (email, password) => {
    const result = await adminLogin(email, password);
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

  const isAuthenticated = session !== null;

  return (
    <AdminSessionContext.Provider value={{ session, isAuthenticated, login, logout }}>
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
