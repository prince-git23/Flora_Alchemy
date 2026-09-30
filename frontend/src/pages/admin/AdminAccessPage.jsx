import React, { useState, useEffect, useMemo } from 'react';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import AdminSettingsTabs from '../../components/admin/AdminSettingsTabs.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import {
  getOperators,
  updateOperatorStatus,
  deleteOperator,
} from '../../services/adminUserService.js';
import { createHandlerInvitation } from '../../services/staffService.js';
import { inspectActivationLink } from '../../services/activationLink.js';
import { getAccessCatalogue } from '../../services/staffAccessService.js';
import StaffAccessEditor from '../../components/admin/StaffAccessEditor.jsx';

/**
 * Admin & Handler Access (/admin/access).
 *
 * STAFF ONBOARDING IS INVITATION-BASED. An administrator never types another
 * person's password: they issue a single-use invitation bound (server-side) to
 * their own workspace, choosing a ROLE TEMPLATE, and the invited person sets
 * their own name and password on /admin/activate/<token>. The old "Add Operator"
 * form (full name · email · role · initial password) is gone, and
 * POST /api/admin/users now answers 410 INVITATION_REQUIRED.
 */

export default function AdminAccessPage() {
  const { session } = useAdminSession();
  const currentUserId = session?.id || null;
  const [users, setUsers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [showAddModal, setShowAddModal] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  // Invite form state — deliberately NO password field and no role enum: the
  // administrator picks an ACCESS TEMPLATE and the server mints the invitation.
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteDepartment, setInviteDepartment] = useState('');
  const [inviteRole, setInviteRole] = useState('fulfillment');
  const [inviteFullAccess, setInviteFullAccess] = useState(false);
  const [catalogue, setCatalogue] = useState(null);
  // The invitation SUCCESS state: the one and only time the activation link is
  // ever shown (the raw token is never stored or re-readable).
  const [issued, setIssued] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // The server's link, checked for display. Never rewritten — see
  // services/activationLink.js for why the browser origin is not an authority.
  const issuedLink = useMemo(() => inspectActivationLink(issued?.link), [issued]);
  // Access & Role editor target.
  const [accessTarget, setAccessTarget] = useState(null);

  useEffect(() => {
    let live = true;
    getAccessCatalogue().then((res) => {
      if (live && res.ok) setCatalogue(res.catalogue);
    });
    return () => {
      live = false;
    };
  }, []);

  const loadUsers = async () => {
    try {
      setLoadError(null);
      const list = await getOperators({ role: roleFilter !== 'ALL' ? roleFilter : undefined, q: searchQuery || undefined });
      setUsers(list);
      setLoaded(true);
    } catch (err) {
      setLoadError(err.message || 'Failed to load operators.');
      setLoaded(true);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  // Re-fetch when filters change (debounced)
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => loadUsers(), 300);
    return () => clearTimeout(t);
  }, [roleFilter, searchQuery]);

  const triggerToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  /**
   * Invite Staff — mints a single-use invitation. The server binds it to THIS
   * administrator's workspace, keeps the role at `handler`, and validates the
   * access template against its own permission catalogue. No password is ever
   * collected, generated, stored or displayed here.
   */
  const handleInviteStaff = async (e) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setSaving(true);
    try {
      const res = await createHandlerInvitation({
        name: inviteName.trim(),
        email: inviteEmail.trim(),
        department: inviteDepartment.trim(),
        ...(inviteFullAccess ? { fullAccess: true } : { staffRole: inviteRole }),
      });
      if (!res.ok) {
        triggerToast(res.message || 'Could not issue the invitation.');
        return;
      }
      setIssued({
        invitation: res.invitation,
        // Displayed EXACTLY as the server minted it. The public frontend origin
        // is configured once, on the backend (STAFF_PORTAL_URL) — repinning it
        // here would let the domain this operator is browsing from decide what
        // the invited colleague receives.
        link: res.link || '',
        role: inviteFullAccess
          ? 'Full Workspace Access'
          : catalogue?.templates?.find((t) => t.key === inviteRole)?.label || 'Custom Role',
      });
      setInviteName('');
      setInviteEmail('');
      setInviteDepartment('');
      setLinkCopied(false);
      setShowAddModal(false);
    } finally {
      setSaving(false);
    }
  };

  const copyActivationLink = async (link) => {
    try {
      await navigator.clipboard.writeText(link);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions) — the link is
      // rendered in full so it can always be selected manually.
      triggerToast('Copy failed — select the link and copy it manually.');
    }
  };

  const handleStatusChange = async (userId, newStatus, userName) => {
    try {
      await updateOperatorStatus(userId, newStatus);
      await loadUsers();
      triggerToast(newStatus === 'SUSPENDED' ? `Suspended ${userName}.` : `Reactivated ${userName}.`);
    } catch (err) {
      triggerToast(err.message || 'Could not update status.');
    }
  };

  const handleDelete = async (userId, userName) => {
    if (!window.confirm(`Remove "${userName}" from the operator roster? This cannot be undone.`)) return;
    try {
      await deleteOperator(userId);
      await loadUsers();
      triggerToast(`Removed ${userName}.`);
    } catch (err) {
      triggerToast(err.message || 'Could not delete operator.');
    }
  };

  const handleExportCSV = () => {
    const csvRows = [
      ['Name', 'Role', 'Email', 'Created'],
      ...users.map((u) => [u.name, u.role, u.email, u.createdAt || ''])
    ];
    const csvContent = 'data:text/csv;charset=utf-8,' + csvRows.map((e) => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'flora_alchemy_operators.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    triggerToast('Operator list exported.');
  };

  // Client-side filter for instant feedback
  const filteredUsers = users.filter((user) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      user.name.toLowerCase().includes(q) ||
      user.email.toLowerCase().includes(q)
    );
  });

  const adminCount = users.filter((u) => u.role === 'ADMINISTRATOR').length;
  const handlerCount = users.filter((u) => u.role === 'HANDLER').length;

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-8 pb-12">
        {/* Header */}
        <div className="relative overflow-hidden rounded-2xl bg-[var(--color-surface-low)] p-6 sm:p-8 shadow-xs border border-[var(--color-botanical-border)]">
          <div className="absolute -right-16 -top-16 w-80 h-80 rounded-full bg-gradient-to-br from-[#ffdad3]/40 via-[#f1dfd5]/30 to-transparent blur-3xl pointer-events-none"></div>
          <div className="relative z-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
            <div className="space-y-2 max-w-2xl">
              <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--color-botanical-subtle)]">
                <span>System</span>
                <span className="text-[#d1c4bd]">/</span>
                <span>Settings</span>
                <span className="text-[#d1c4bd]">/</span>
                <span className="text-[var(--color-botanical-primary)] font-semibold">Admin & Handler Access</span>
              </div>
              <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">
                Admin & Handler Access
              </h1>
              <p className="text-[15px] text-[var(--color-botanical-muted)]">
                Manage portal operators, roles, and account permissions — persisted in the database.
              </p>
            </div>
          </div>
          <div className="mt-6 pt-2 border-t border-[var(--color-botanical-border)]/60">
            <AdminSettingsTabs activeTab="access" />
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-[var(--color-surface-lowest)] rounded-2xl p-5 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[var(--color-botanical-border)]">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)]">
              <span className="text-[11px] font-bold uppercase tracking-wider">Total Operators</span>
              <span className="material-symbols-outlined text-[var(--color-botanical-primary)] text-[20px]">shield_person</span>
            </div>
            <div className="mt-2">
              <span className="font-serif text-3xl font-medium text-[var(--color-botanical-primary)]">{users.length}</span>
            </div>
            <p className="mt-1 text-[13px] text-[var(--color-botanical-muted)]">{adminCount} admins · {handlerCount} handlers</p>
          </div>
          <div className="bg-[var(--color-surface-lowest)] rounded-2xl p-5 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[var(--color-botanical-border)]">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)]">
              <span className="text-[11px] font-bold uppercase tracking-wider">Administrators</span>
              <span className="material-symbols-outlined text-[var(--color-botanical-primary)] text-[20px]">admin_panel_settings</span>
            </div>
            <div className="mt-2">
              <span className="font-serif text-3xl font-medium text-[var(--color-botanical-primary)]">{adminCount}</span>
            </div>
            <p className="mt-1 text-[13px] text-[var(--color-botanical-muted)]">Full system access</p>
          </div>
          <div className="bg-[var(--color-surface-lowest)] rounded-2xl p-5 shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[var(--color-botanical-border)]">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)]">
              <span className="text-[11px] font-bold uppercase tracking-wider">Handlers</span>
              <span className="material-symbols-outlined text-[var(--color-botanical-primary)] text-[20px]">palette</span>
            </div>
            <div className="mt-2">
              <span className="font-serif text-3xl font-medium text-[var(--color-botanical-primary)]">{handlerCount}</span>
            </div>
            <p className="mt-1 text-[13px] text-[var(--color-botanical-muted)]">Order & catalog management</p>
          </div>
        </div>

        {/* Operator Table */}
        <div className="bg-[var(--color-surface-lowest)] rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[var(--color-botanical-border)] p-6 sm:p-8">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-6">
            <div>
              <h2 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium">Staff Directory</h2>
              <p className="text-[13px] text-[var(--color-botanical-muted)] mt-0.5">
                Every staff account in this workspace. New staff join by invitation — they create
                their own password.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleExportCSV}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[var(--color-surface-low)] text-[var(--color-botanical-text)] text-[13px] font-semibold hover:bg-[var(--color-surface-high)] transition-all"
              >
                <span className="material-symbols-outlined text-[18px]">file_download</span>
                Export CSV
              </button>
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-xs hover:bg-[var(--color-btn-hover-alt)] transition-all"
              >
                <span className="material-symbols-outlined text-[18px]">person_add</span>
                + Invite Staff
              </button>
            </div>
          </div>

          {/* Filter Bar */}
          <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between py-3 px-4 bg-[var(--color-surface-low)] rounded-xl mb-6">
            <div className="relative flex-1 max-w-md">
              <span className="material-symbols-outlined absolute left-3 top-2.5 text-[18px] text-[var(--color-botanical-subtle)]">search</span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name or email..."
                className="w-full pl-9 pr-3 py-1.5 min-h-[44px] md:min-h-0 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-text)] text-[13px] placeholder:text-[var(--color-botanical-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] shadow-xs"
              />
            </div>
            <div className="flex items-center gap-1.5 bg-[var(--color-surface-lowest)] px-3 py-0 md:py-1.5 rounded-full shadow-xs text-[13px]">
              <span className="text-[var(--color-botanical-subtle)] text-[11px] font-bold uppercase">Role:</span>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="bg-transparent font-semibold text-[var(--color-botanical-text)] focus:outline-none cursor-pointer text-[13px] min-h-[44px] md:min-h-0"
              >
                <option value="ALL">All Roles</option>
                <option value="ADMINISTRATOR">Administrator</option>
                <option value="HANDLER">Handler</option>
              </select>
            </div>
          </div>

          {/* Table */}
          {!loaded && (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#964735] border-t-transparent" />
            </div>
          )}

          {loadError && (
            <div className="bg-[#ffdad6] rounded-xl p-4 text-center">
              <p className="text-[14px] text-[var(--color-badge-fg-strong)] font-medium">{loadError}</p>
              <button type="button" onClick={loadUsers} className="mt-2 text-[12px] font-semibold text-[var(--color-accent)] hover:underline">Retry</button>
            </div>
          )}

          {loaded && !loadError && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[13px]">
                <thead>
                  <tr className="text-[var(--color-botanical-subtle)] text-[11px] font-bold uppercase tracking-wider bg-[var(--color-surface-low)]/60">
                    <th className="py-3 px-4 rounded-l-lg">Operator</th>
                    <th className="py-3 px-4">Role</th>
                    <th className="py-3 px-4">Email</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Last Active</th>
                    <th className="py-3 px-4 text-right rounded-r-lg">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-divider)]">
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="py-8 text-center text-[var(--color-botanical-subtle)]">
                        {users.length === 0 ? 'No operators found. Add one to get started.' : 'No operators match your search.'}
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-[var(--color-surface-low)]/50 transition-colors">
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-3">
                            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold shadow-xs ${u.role === 'ADMINISTRATOR' ? 'bg-[var(--color-btn)] text-white' : 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)]'}`}>
                              {u.initials}
                            </div>
                            <div>
                              <p className="font-semibold text-[var(--color-botanical-primary)] leading-tight">{u.name}</p>
                              {u.isFixture && <span className="text-[10px] text-[var(--color-botanical-subtle)]">Seed account</span>}
                            </div>
                          </div>
                        </td>
                        <td className="py-3.5 px-4">
                          {u.role === 'ADMINISTRATOR' ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#f1dfd5] text-[#231a14] text-[11px] font-bold">
                              <span className="material-symbols-outlined text-[14px]">shield</span>
                              Administrator
                            </span>
                          ) : u.access ? (
                            <span className="inline-flex flex-col gap-0.5">
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] text-[11px] font-semibold">
                                <span className="material-symbols-outlined text-[14px]">stylus_note</span>
                                {u.access.roleLabel}
                              </span>
                              <span className="text-[10px] text-[var(--color-botanical-subtle)]">
                                {u.access.isFullAccess
                                  ? 'All workspace operations'
                                  : `${u.access.effective.length} permission${u.access.effective.length === 1 ? '' : 's'}`}
                              </span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] text-[11px] font-medium">
                              <span className="material-symbols-outlined text-[14px]">stylus_note</span>
                              Handler
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-[var(--color-botanical-muted)] font-mono text-[12px]">{u.email}</td>
                        <td className="py-3.5 px-4">
                          {u.status === 'SUSPENDED' ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#ffdad6] text-[#7a1a12] text-[11px] font-bold">
                              <span className="h-1.5 w-1.5 rounded-full bg-[#ba1a1a]"></span>
                              Suspended
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-botanical-sage-light)] text-[#131f0e] text-[11px] font-bold">
                              <span className="h-1.5 w-1.5 rounded-full bg-[#081405]"></span>
                              Active
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-[var(--color-botanical-muted)]">{u.lastActivity}</td>
                        <td className="py-1 px-4 text-right">
                          <div className="inline-flex items-center gap-1">
                            {/* Administrators are owner-managed: a workspace
                                admin shapes OPERATIONAL access, never peer or
                                owner authority. Handler access opens the
                                permission editor. */}
                            {u.role === 'HANDLER' && (
                              <button
                                type="button"
                                onClick={() => setAccessTarget(u)}
                                className="min-h-[44px] min-w-[44px] flex items-center justify-center p-1 rounded hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] transition-colors"
                                title="Access & role"
                              >
                                <span className="material-symbols-outlined text-[18px]">key</span>
                              </button>
                            )}
                            {u.id !== currentUserId && (
                              <button
                                type="button"
                                onClick={() => handleStatusChange(u.id, u.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED', u.name)}
                                className="min-h-[44px] min-w-[44px] flex items-center justify-center p-1 rounded hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] transition-colors"
                                title={u.status === 'SUSPENDED' ? 'Reactivate Operator' : 'Suspend Operator'}
                              >
                                <span className="material-symbols-outlined text-[18px]">{u.status === 'SUSPENDED' ? 'play_circle' : 'pause_circle'}</span>
                              </button>
                            )}
                            {!u.isFixture && (
                              <button
                                type="button"
                                onClick={() => handleDelete(u.id, u.name)}
                                className="min-h-[44px] min-w-[44px] flex items-center justify-center p-1 rounded hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-danger)] transition-colors"
                                title="Delete Operator"
                              >
                                <span className="material-symbols-outlined text-[18px]">delete_outline</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <div className="pt-4 mt-2 border-t border-[var(--color-botanical-border-light)] text-[13px] text-[var(--color-botanical-subtle)]">
                Showing {filteredUsers.length} of {users.length} staff
              </div>
            </div>
          )}
        </div>

        {/* Role templates — the real bundles the server assigns (permission
            catalogue served by /api/admin/access/catalogue). */}
        <div className="bg-[var(--color-surface-lowest)] rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[var(--color-botanical-border)] p-6 sm:p-8">
          <h2 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium mb-1">
            Role Templates
          </h2>
          <p className="text-[13px] text-[var(--color-botanical-muted)] mb-4">
            A role is a permission bundle. Open a staff member’s <strong>Access &amp; role</strong> to
            change it, or tick individual permissions for a Custom Role.
          </p>
          {!catalogue && (
            <p className="text-[13px] text-[var(--color-botanical-subtle)]">Loading templates…</p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {(catalogue?.templates || []).map((t) => (
              <div
                key={t.key}
                className="rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-4 space-y-2 dark:bg-[#26221e] dark:border-[#3a3530]"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-[13px] text-[var(--color-botanical-primary)] dark:text-[#f0ede9]">
                    {t.label}
                  </p>
                  <span className="shrink-0 rounded-full bg-[var(--color-surface-high)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-botanical-text)]">
                    {t.key === 'full_workspace' ? 'All workspace ops' : `${t.permissions.length} perms`}
                  </span>
                </div>
                <p className="text-[12px] text-[var(--color-botanical-muted)]">{t.description}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[12px] text-[var(--color-botanical-subtle)]">
            Administrator, owner and platform authority are never part of a staff bundle.
          </p>
        </div>

        {/* Invite Staff Modal — bottom sheet on phones, centred dialog from sm up.
            NO password field: the invitee sets their own credential at activation. */}
        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/40 backdrop-blur-xs">
            <div className="bg-[var(--color-surface-lowest)] rounded-t-3xl sm:rounded-2xl max-w-md w-full max-h-[92vh] overflow-y-auto p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-6 shadow-2xl border border-[var(--color-botanical-border)] animate-fade-in space-y-4 dark:bg-[#1f1c19] dark:border-[#3a3530]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[var(--color-botanical-primary)]">
                  <span className="material-symbols-outlined text-[22px] text-[var(--color-accent)]">person_add</span>
                  <h3 className="font-serif text-xl font-medium">Invite Staff</h3>
                </div>
                <button type="button" onClick={() => setShowAddModal(false)} className="min-h-[44px] min-w-[44px] flex items-center justify-center p-1 rounded-lg text-[var(--color-botanical-subtle)] hover:bg-[var(--color-surface-container)]">
                  <span className="material-symbols-outlined text-[20px]">close</span>
                </button>
              </div>
              <form onSubmit={handleInviteStaff} className="space-y-4 text-[13px]">
                <div>
                  <label htmlFor="invite-name" className="block text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)] mb-1">
                    Full Name <span className="font-normal normal-case">(optional)</span>
                  </label>
                  <input
                    id="invite-name"
                    type="text"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="e.g. Meera Nambiar"
                    className="w-full px-3 py-2 min-h-[44px] bg-[var(--color-surface-low)] rounded-xl border border-transparent focus:border-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] focus:outline-none"
                  />
                  <p className="mt-1 text-[12px] text-[var(--color-botanical-subtle)]">
                    Leave blank and the staff member fills it in while activating.
                  </p>
                </div>
                <div>
                  <label htmlFor="invite-email" className="block text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)] mb-1">Work Email</label>
                  <input
                    id="invite-email"
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="e.g. meera@flora-alchemy.com"
                    className="w-full px-3 py-2 min-h-[44px] bg-[var(--color-surface-low)] rounded-xl border border-transparent focus:border-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="invite-role" className="block text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)] mb-1">
                    Role / Access Template
                  </label>
                  <select
                    id="invite-role"
                    value={inviteFullAccess ? 'full_workspace' : inviteRole}
                    disabled={inviteFullAccess}
                    onChange={(e) => setInviteRole(e.target.value)}
                    className="w-full px-3 py-2 min-h-[44px] bg-[var(--color-surface-low)] rounded-xl border border-transparent focus:border-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] focus:outline-none cursor-pointer disabled:opacity-60"
                  >
                    {(catalogue?.templates || []).map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[12px] text-[var(--color-botanical-subtle)]">
                    {catalogue?.templates?.find((t) => t.key === inviteRole)?.description ||
                      'Permissions are chosen from the server catalogue.'}
                  </p>
                  <label htmlFor="invite-full" className="mt-2 flex items-start gap-2 min-h-[44px] cursor-pointer">
                    <input
                      id="invite-full"
                      type="checkbox"
                      checked={inviteFullAccess}
                      onChange={(e) => setInviteFullAccess(e.target.checked)}
                      className="mt-0.5 h-5 w-5 accent-[#964735]"
                    />
                    <span className="text-[12px] text-[var(--color-botanical-muted)]">
                      Full Workspace Access — every allowed workspace operation (never owner,
                      administrator or platform authority).
                    </span>
                  </label>
                </div>
                <div>
                  <label htmlFor="invite-dept" className="block text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)] mb-1">
                    Internal note / Department <span className="font-normal normal-case">(optional)</span>
                  </label>
                  <input
                    id="invite-dept"
                    type="text"
                    value={inviteDepartment}
                    onChange={(e) => setInviteDepartment(e.target.value)}
                    placeholder="e.g. Atelier Floor"
                    className="w-full px-3 py-2 min-h-[44px] bg-[var(--color-surface-low)] rounded-xl border border-transparent focus:border-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] focus:outline-none"
                  />
                </div>
                <p className="text-[12px] text-[var(--color-botanical-subtle)] rounded-xl bg-[var(--color-surface-low)] p-3">
                  The staff member creates their own password using the secure one-time invitation.
                  An invitation expires after 72 hours, works once, and can be revoked at any time;
                  you never see or set their password.
                </p>
                <div className="pt-3 flex flex-wrap items-center justify-end gap-2">
                  <button type="button" onClick={() => setShowAddModal(false)} className="min-h-[44px] px-4 py-2 rounded-full text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] font-semibold">Cancel</button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="min-h-[44px] px-5 py-2 rounded-full bg-[var(--color-btn)] text-white hover:bg-[var(--color-btn-hover-alt)] font-semibold shadow-xs disabled:opacity-50"
                  >
                    {saving ? 'Issuing…' : 'Invite Staff'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Invitation issued — the ONE place the activation link is ever shown. */}
        {issued && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/40 backdrop-blur-xs">
            <div className="bg-[var(--color-surface-lowest)] rounded-t-3xl sm:rounded-2xl max-w-lg w-full max-h-[92vh] overflow-y-auto p-6 shadow-2xl border border-[var(--color-botanical-border)] space-y-4 dark:bg-[#1f1c19] dark:border-[#3a3530]">
              <div className="flex items-center gap-2 text-[var(--color-botanical-primary)]">
                <span className="material-symbols-outlined text-[22px] text-[var(--color-botanical-sage)]">mark_email_read</span>
                <h3 className="font-serif text-xl font-medium">Invitation issued</h3>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px]">
                <div>
                  <dt className="text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)]">Recipient</dt>
                  <dd className="text-[var(--color-botanical-text)] dark:text-[#f0ede9] break-words">
                    {issued.invitation?.recipientName || '— (they will set their name)'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)]">Email</dt>
                  <dd className="font-mono text-[12px] break-all">{issued.invitation?.recipientEmail}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)]">Assigned role</dt>
                  <dd>{issued.role}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)]">Workspace</dt>
                  <dd>{session?.workspace?.name || session?.workspace?.slug || 'This workspace'}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)]">Status</dt>
                  <dd>{issued.invitation?.status || 'INVITED'}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)]">Expires</dt>
                  <dd>{issued.invitation?.expiresIn || 'in 72 hours'}</dd>
                </div>
              </dl>
              <div>
                <p className="text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)] mb-1">
                  One-time activation link
                </p>
                <p className="rounded-xl bg-[var(--color-surface-low)] p-3 font-mono text-[11px] break-all dark:bg-[#26221e]">
                  {issuedLink.ok ? issuedLink.url : issuedLink.problem}
                </p>
                {issuedLink.ok && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => copyActivationLink(issuedLink.url)}
                      className="min-h-[44px] px-4 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold"
                    >
                      {linkCopied ? 'Copied' : 'Copy link'}
                    </button>
                    <a
                      href={issuedLink.url}
                      className="min-h-[44px] inline-flex items-center px-4 rounded-full bg-[var(--color-surface-container)] text-[13px] font-semibold text-[var(--color-botanical-text)] dark:bg-[#2e2a25] dark:text-[#f0ede9]"
                    >
                      Open the link
                    </a>
                  </div>
                )}
                <p className="mt-2 text-[12px] text-[var(--color-botanical-subtle)]">
                  This link is shown once. It is never stored or re-readable — use Resend on the
                  staff ledger if it is lost (the old link stops working).
                </p>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setIssued(null)}
                  className="min-h-[44px] px-5 rounded-full bg-[var(--color-surface-container)] text-[13px] font-semibold"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Access & Role editor (role template + granular permissions). */}
        <StaffAccessEditor
          open={!!accessTarget}
          staff={accessTarget}
          onClose={() => setAccessTarget(null)}
          onSaved={() => loadUsers()}
        />

        {/* Toast */}
        {toastMessage && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 bg-[var(--color-btn)] text-white px-5 py-3 rounded-full shadow-2xl border border-white/10 max-w-[calc(100vw-3rem)] animate-fade-in">
            <span className="w-2 h-2 rounded-full bg-[var(--color-badge-bg)] shrink-0"></span>
            <span className="text-[13px] font-medium tracking-wide min-w-0 break-words">{toastMessage}</span>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
