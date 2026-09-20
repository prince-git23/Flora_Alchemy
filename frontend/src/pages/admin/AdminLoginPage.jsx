import React, { useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import { Lock, Mail, ShieldCheck, ArrowRight, AlertCircle } from 'lucide-react';
import LoginLoading from '../../components/admin/LoginLoading.jsx';

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const { login } = useAdminSession();
  // Demo credentials are NOT pre-filled — the handler must explicitly
  // quick-fill and submit (demo data ≠ authenticated session).
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Duplicate-submission guard: a submit handler re-run while the auth
  // request is in flight (e.g. rapid double Enter) must not fire a second
  // request. The submit button is also disabled, but form submit can still
  // be triggered via keyboard.
  const authInFlightRef = useRef(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (authInFlightRef.current) return;
    authInFlightRef.current = true;
    setError('');
    setLoading(true);

    // try/finally guarantees the form is always restorable on failure,
    // even if an unexpected error escapes the auth service.
    let result;
    try {
      result = await login(email, password);
    } finally {
      setLoading(false);
      authInFlightRef.current = false;
    }

    if (result.success) {
      navigate('/admin/dashboard');
    } else {
      setError(result.error || 'Login failed');
    }
  };

  // Authentication-in-progress: transition the whole portal surface into a
  // clean loading state. Entered credentials stay in component state (never
  // persisted); on failure we simply re-render the form below with the
  // existing error.
  if (loading) {
    return <LoginLoading />;
  }

  return (
    <div className="min-h-screen bg-[var(--color-surface-bg)] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Top brand */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-full bg-[#180f0a] dark:bg-[#964735] text-white flex items-center justify-center font-bold text-[14px] shadow-sm">
            HA
          </div>
          <div>
            <span className="font-serif text-[18px] text-[#180f0a] dark:text-[#f0ede9] font-medium">Flora Alchemy</span>
            <span className="block text-[9px] uppercase tracking-widest text-[#964735] font-bold mt-0.5">Handler Portal</span>
          </div>
        </div>

        <div className="bg-white dark:bg-[#1e1b18] rounded-2xl p-8 border border-[#e5e2dd] dark:border-[#3a3530] shadow-lg space-y-6">
          <div className="text-center space-y-2">
            <h1 className="font-serif text-2xl text-[#180f0a] dark:text-[#f0ede9] font-medium">Handler Sign In</h1>
            <p className="text-[13px] text-[#80756f] dark:text-[#8a8078]">Access the Flora Alchemy operations console</p>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-[#ffdad3]/70 border border-[#ffdad3] text-[#783020] dark:bg-[#964735]/15 dark:border-[#964735]/40 dark:text-[#ffdad3] text-[13px]" role="alert">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[11px] uppercase font-bold text-[#4e4540] dark:text-[#b8b0a8] mb-1.5">Handler Email</label>
              <div className="relative">
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#f6f3ee] dark:bg-[#222019] text-[14px] text-[#1c1c19] dark:text-[#f0ede9] border border-[#e5e2dd] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[#180f0a] dark:focus:ring-[#f0ede9]"
                />
                <Mail className="w-4 h-4 text-[#80756f] dark:text-[#8a8078] absolute left-3.5 top-1/2 -translate-y-1/2" />
              </div>
            </div>

            <div>
              <label className="block text-[11px] uppercase font-bold text-[#4e4540] dark:text-[#b8b0a8] mb-1.5">Portal Password</label>
              <div className="relative">
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#f6f3ee] dark:bg-[#222019] text-[14px] text-[#1c1c19] dark:text-[#f0ede9] border border-[#e5e2dd] dark:border-[#3a3530] focus:outline-none focus:ring-1 focus:ring-[#180f0a] dark:focus:ring-[#f0ede9]"
                />
                <Lock className="w-4 h-4 text-[#80756f] dark:text-[#8a8078] absolute left-3.5 top-1/2 -translate-y-1/2" />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-full bg-[#180f0a] hover:bg-[#964735] dark:bg-[#964735] dark:hover:bg-[#a85a48] disabled:opacity-50 text-white text-[13px] font-semibold tracking-wide flex items-center justify-center gap-2 transition-all"
            >
              Sign In to Portal
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <div className="pt-2 border-t border-[#e5e2dd] dark:border-[#3a3530] text-center space-y-1">
            <button
              type="button"
              onClick={() => { setEmail('handler.admin@flora-alchemy.demo'); setPassword('handler1234'); setError(''); }}
              className="text-[12px] font-semibold text-[#964735] hover:underline"
            >
              ⚡ Quick Fill Demo Credentials (DEV ONLY)
            </button>
            <p className="text-[11px] text-[#80756f] dark:text-[#8a8078]">Developer helper — handler.admin@flora-alchemy.demo / handler1234</p>
          </div>

          <div className="flex items-center justify-center gap-2 text-[11px] text-[#80756f] dark:text-[#8a8078]">
            <ShieldCheck className="w-4 h-4 text-[#5b6d54]" />
            <span>Handler Operations</span>
          </div>
        </div>

        <p className="text-center text-[12px] text-[#80756f] dark:text-[#8a8078] mt-6">
          Still building gifts?{' '}
          <Link to="/" className="text-[#964735] hover:underline font-semibold">Open the storefront</Link>
        </p>
      </div>
    </div>
  );
}
